import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../server.js";

async function ensureUserToken({
  username,
  password,
  email,
  region = "Zemgale",
  deviceId = "",
  loginDeviceId = "",
  forceLogin = false,
}) {
  const signupDid =
    String(deviceId || "").trim() || `test-signup-${username}-${Date.now()}`;
  const loginDid =
    String(loginDeviceId || "").trim() ||
    signupDid ||
    `test-login-${username}-${Date.now()}`;
  const signupRes = await request(app)
    .post("/signup")
    .set("x-vz-device-id", signupDid)
    .send({ username, password, email, region });

  if (signupRes.status === 200 && signupRes.body?.token && !forceLogin) {
    return signupRes.body.token;
  }

  const loginRes = await request(app)
    .post("/login")
    .set("x-vz-device-id", loginDid)
    .send({ username, password });

  if (loginRes.status !== 200 || !loginRes.body?.token) {
    throw new Error(
      `Could not auth ${username}. signup=${signupRes.status}, login=${loginRes.status}`
    );
  }

  return loginRes.body.token;
}

describe("Tournament brackets API", () => {
  it("rejects tournament creation for non-VIP users", async () => {
    const username = `user${Date.now().toString().slice(-8)}`;
    const token = await ensureUserToken({
      username,
      password: "Test12345",
      email: `${username}@example.com`,
    });

    const res = await request(app)
      .post("/tournaments")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Not Allowed Cup",
        type: "single_elimination",
        seeding: ["A", "B", "C", "D"],
      });

    expect(res.status).toBe(403);
    expect(String(res.body?.message || "")).toContain("VIP");
  });

  it("creates a bracket tournament and reports match result", async () => {
    const adminToken = await ensureUserToken({
      username: "BugatsLV",
      password: "Test12345",
      email: "bugatslv_test@example.com",
    });

    const createRes = await request(app)
      .post("/tournaments")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: `Server Cup ${Date.now().toString().slice(-6)}`,
        type: "single_elimination",
        seeding: ["Alpha", "Bravo", "Charlie", "Delta"],
      });

    expect(createRes.status).toBe(200);
    expect(createRes.body?.ok).toBe(true);
    expect(createRes.body?.tournament?.id).toBeTruthy();

    const tournamentId = createRes.body.tournament.id;

    const listRes = await request(app)
      .get("/tournaments")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body?.tournaments)).toBe(true);
    expect(listRes.body?.schedule?.enabled).toBe(true);
    expect(typeof listRes.body?.schedule?.mode).toBe("string");
    expect([
      "single_elimination",
      "double_elimination",
      "round_robin",
    ]).toContain(listRes.body?.schedule?.mode);
    expect(Array.isArray(listRes.body?.schedule?.rules)).toBe(true);
    expect(listRes.body.schedule.rules.length).toBeGreaterThan(0);
    expect(listRes.body.tournaments.some((t) => t.id === tournamentId)).toBe(
      true
    );

    const detailRes = await request(app)
      .get(`/tournaments/${tournamentId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(detailRes.status).toBe(200);
    expect(Array.isArray(detailRes.body?.data?.match)).toBe(true);
    expect(detailRes.body.data.match.length).toBeGreaterThan(0);

    const match =
      detailRes.body.data.match.find(
        (m) => m && (m.status === 2 || m.status === 3)
      ) || detailRes.body.data.match[0];
    expect(match?.id).toBeDefined();

    const reportRes = await request(app)
      .post(`/tournaments/${tournamentId}/matches/${match.id}/report`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ score1: 3, score2: 1 });

    expect(reportRes.status).toBe(200);
    expect(reportRes.body?.ok).toBe(true);
    expect(reportRes.body?.match?.id).toBe(match.id);
    expect(Number(reportRes.body?.match?.opponent1?.score)).toBe(3);
    expect(Number(reportRes.body?.match?.opponent2?.score)).toBe(1);
  });

  it("supports automatic match reporting for auto tournaments", async () => {
    const adminToken = await ensureUserToken({
      username: "BugatsLV",
      password: "Test12345",
      email: "bugatslv_test@example.com",
    });

    const createRes = await request(app)
      .post("/tournaments")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: `Auto Cup ${Date.now().toString().slice(-6)}`,
        type: "single_elimination",
        playMode: "speed",
        autoReportOnly: true,
        seeding: ["AutoA", "AutoB", "AutoC", "AutoD"],
      });

    expect(createRes.status).toBe(200);
    const tournamentId = createRes.body?.tournament?.id;
    expect(Number.isFinite(Number(tournamentId))).toBe(true);

    const detailRes = await request(app)
      .get(`/tournaments/${tournamentId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(detailRes.status).toBe(200);

    const match = Array.isArray(detailRes.body?.data?.match)
      ? detailRes.body.data.match.find((m) => m && Number(m.status) >= 1)
      : null;
    expect(Number.isFinite(Number(match?.id))).toBe(true);

    const autoRes = await request(app)
      .post(`/tournaments/${tournamentId}/matches/${match.id}/report/auto`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(autoRes.status).toBe(200);
    expect(autoRes.body?.ok).toBe(true);
    expect(autoRes.body?.auto?.mode).toBe("speed");
    expect(
      Number(autoRes.body?.match?.opponent1?.score) +
        Number(autoRes.body?.match?.opponent2?.score)
    ).toBe(1);
  });

  it("lets VIP room owner invite friends into empty slots", async () => {
    const suffix = Date.now().toString().slice(-7);
    const owner = `viproom_${suffix}`;
    const friendA = `vipa_${suffix}`;
    const friendB = `vipb_${suffix}`;

    const adminToken = await ensureUserToken({
      username: "BugatsLV",
      password: "Test12345",
      email: "bugatslv_test@example.com",
    });
    const ownerToken = await ensureUserToken({
      username: owner,
      password: "Test12345",
      email: `${owner}@example.com`,
    });
    const friendAToken = await ensureUserToken({
      username: friendA,
      password: "Test12345",
      email: `${friendA}@example.com`,
    });
    const friendBToken = await ensureUserToken({
      username: friendB,
      password: "Test12345",
      email: `${friendB}@example.com`,
    });

    const grantRes = await request(app)
      .post("/admin/vip/grant")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ username: owner, days: 30 });
    expect(grantRes.status).toBe(200);
    expect(grantRes.body?.ok).toBe(true);

    const reqA = await request(app)
      .post("/friends/request")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ to: friendA });
    expect(reqA.status).toBe(200);
    const accA = await request(app)
      .post("/friends/accept")
      .set("Authorization", `Bearer ${friendAToken}`)
      .send({ from: owner });
    expect(accA.status).toBe(200);

    const reqB = await request(app)
      .post("/friends/request")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ to: friendB });
    expect(reqB.status).toBe(200);
    const accB = await request(app)
      .post("/friends/accept")
      .set("Authorization", `Bearer ${friendBToken}`)
      .send({ from: owner });
    expect(accB.status).toBe(200);

    const createRoom = await request(app)
      .post("/tournaments/vip-rooms")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        name: `VIP Room ${suffix}`,
        type: "round_robin",
        playMode: "survival",
        slots: 3,
        invitedFriends: [friendA],
      });
    expect(createRoom.status).toBe(200);
    expect(createRoom.body?.ok).toBe(true);
    expect(Number(createRoom.body?.room?.emptySlots)).toBe(1);
    const roomId = String(createRoom.body?.room?.id || "");
    expect(roomId.length).toBeGreaterThan(0);

    const inviteB = await request(app)
      .post(`/tournaments/vip-rooms/${roomId}/invite`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ friend: friendB });
    expect(inviteB.status).toBe(200);
    expect(Array.isArray(inviteB.body?.room?.invited)).toBe(true);
    expect(
      inviteB.body.room.invited.some(
        (n) => String(n || "").toLowerCase() === friendB.toLowerCase()
      )
    ).toBe(true);

    const joinA = await request(app)
      .post(`/tournaments/vip-rooms/${roomId}/join`)
      .set("Authorization", `Bearer ${friendAToken}`)
      .send({});
    expect(joinA.status).toBe(200);
    expect(joinA.body?.started).toBe(false);

    const joinB = await request(app)
      .post(`/tournaments/vip-rooms/${roomId}/join`)
      .set("Authorization", `Bearer ${friendBToken}`)
      .send({});
    expect(joinB.status).toBe(200);
    expect(joinB.body?.started).toBe(true);
    expect(Number.isFinite(Number(joinB.body?.tournament?.id))).toBe(true);
    expect(joinB.body?.tournament?.playMode).toBe("survival");
    expect(joinB.body?.tournament?.roomId).toBe(roomId);
  });

  it("allows weekly queue join but blocks same-device fake profile", async () => {
    const sharedDeviceId = `shared-device-${Date.now().toString().slice(-8)}`;
    const u1 = `wq${Date.now().toString().slice(-6)}a`;
    const u2 = `wq${Date.now().toString().slice(-6)}b`;

    const t1 = await ensureUserToken({
      username: u1,
      password: "Test12345",
      email: `${u1}@example.com`,
      deviceId: sharedDeviceId,
    });
    const t2 = await ensureUserToken({
      username: u2,
      password: "Test12345",
      email: `${u2}@example.com`,
      deviceId: `${sharedDeviceId}-signup`,
      loginDeviceId: sharedDeviceId,
      forceLogin: true,
    });

    const join1 = await request(app)
      .post("/tournaments/weekly/join")
      .set("Authorization", `Bearer ${t1}`)
      .send({});
    expect(join1.status).toBe(200);
    expect(join1.body?.ok).toBe(true);
    expect(join1.body?.joined).toBe(true);
    expect(join1.body?.schedule?.isJoined).toBe(true);
    expect(typeof join1.body?.schedule?.modeLabel).toBe("string");
    expect(Array.isArray(join1.body?.schedule?.rules)).toBe(true);
    expect(join1.body.schedule.rules.length).toBeGreaterThan(0);

    const join2 = await request(app)
      .post("/tournaments/weekly/join")
      .set("Authorization", `Bearer ${t2}`)
      .send({});
    expect(join2.status).toBe(403);
    expect(String(join2.body?.message || "").toLowerCase()).toContain("ierīce");
  });
});
