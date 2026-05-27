import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../server.js";

async function ensureUserToken({ username, password, email, region = "Zemgale" }) {
  const did = `dev-${username}-${Date.now()}`;
  const signupRes = await request(app)
    .post("/signup")
    .set("x-vz-device-id", did)
    .send({ username, password, email, region, ageConfirmed: true });
  if (signupRes.status === 200 && signupRes.body?.token) return signupRes.body.token;
  const loginRes = await request(app)
    .post("/login")
    .set("x-vz-device-id", did)
    .send({ username, password });
  if (loginRes.status !== 200 || !loginRes.body?.token) {
    throw new Error(`auth ${username}: signup=${signupRes.status} login=${loginRes.status}`);
  }
  return loginRes.body.token;
}

describe("POST /giveaway/nhl-team", () => {
  it("rejects empty team", async () => {
    const suffix = Date.now().toString().slice(-8);
    const u = `nhl_empty_${suffix}`;
    const token = await ensureUserToken({
      username: u,
      password: "Test12345",
      email: `${u}@example.com`,
    });
    const res = await request(app)
      .post("/giveaway/nhl-team")
      .set("Authorization", `Bearer ${token}`)
      .send({ team: "   " });
    expect(res.status).toBe(400);
  });

  it("saves team and returns missions", async () => {
    const suffix = Date.now().toString().slice(-8);
    const u = `nhl_ok_${suffix}`;
    const token = await ensureUserToken({
      username: u,
      password: "Test12345",
      email: `${u}@example.com`,
    });
    const res = await request(app)
      .post("/giveaway/nhl-team")
      .set("Authorization", `Bearer ${token}`)
      .send({ team: "Rangers" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.giveawayNhlTeam).toBe("Rangers");
    expect(Array.isArray(res.body.missions)).toBe(true);
    const nhl = res.body.missions.find((m) => m.type === "nhl_giveaway_submit");
    expect(nhl).toBeTruthy();
    expect(nhl.progress).toBe(0);
    expect(nhl.isCompleted).toBe(false);
  });

  it("marks NHL hat mission complete after Play path + email + opt-in", async () => {
    const suffix = Date.now().toString().slice(-8);
    const u = `nhl_done_${suffix}`;
    const token = await ensureUserToken({
      username: u,
      password: "Test12345",
      email: `${u}@example.com`,
    });
    await request(app)
      .post("/giveaway/nhl-team")
      .set("Authorization", `Bearer ${token}`)
      .send({ abbr: "BOS" });
    const opt = await request(app)
      .post("/beta/opt-in")
      .set("Authorization", `Bearer ${token}`)
      .send({ agree: true });
    expect(opt.status).toBe(200);
    const ms = await request(app).get("/missions").set("Authorization", `Bearer ${token}`);
    expect(ms.status).toBe(200);
    const nhl = ms.body.missions.find((m) => m.type === "nhl_giveaway_submit");
    expect(nhl).toBeTruthy();
    expect(nhl.progress).toBe(1);
    expect(nhl.isCompleted).toBe(true);
  });

  it("saves abbreviation from hat picker and sets canonical team name", async () => {
    const suffix = Date.now().toString().slice(-8);
    const u = `nhl_abbr_${suffix}`;
    const token = await ensureUserToken({
      username: u,
      password: "Test12345",
      email: `${u}@example.com`,
    });
    const res = await request(app)
      .post("/giveaway/nhl-team")
      .set("Authorization", `Bearer ${token}`)
      .send({ abbr: "nyr" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.giveawayNhlAbbr).toBe("NYR");
    expect(res.body.giveawayNhlTeam).toBe("New York Rangers");
  });
});
