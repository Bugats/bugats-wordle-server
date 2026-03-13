import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../server.js";

async function ensureUserToken({
  username,
  password,
  email,
  region = "Zemgale",
}) {
  const signupRes = await request(app)
    .post("/signup")
    .set("x-vz-device-id", `test-signup-${username}-${Date.now()}`)
    .send({ username, password, email, region });

  if (signupRes.status === 200 && signupRes.body?.token) {
    return signupRes.body.token;
  }

  const loginRes = await request(app)
    .post("/login")
    .set("x-vz-device-id", `test-login-${username}-${Date.now()}`)
    .send({ username, password });

  if (loginRes.status !== 200 || !loginRes.body?.token) {
    throw new Error(
      `Could not auth ${username}. signup=${signupRes.status}, login=${loginRes.status}`
    );
  }

  return loginRes.body.token;
}

describe("Tournament brackets API", () => {
  it("rejects tournament creation for non-admin users", async () => {
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
    expect(String(res.body?.message || "")).toContain("Tikai admins");
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
});
