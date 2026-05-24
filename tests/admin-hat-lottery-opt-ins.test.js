import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../server.js";

async function ensureUserToken({ username, password, email, region = "Zemgale" }) {
  const did = `dev-${username}-${Date.now()}`;
  const signupRes = await request(app)
    .post("/signup")
    .set("x-vz-device-id", did)
    .send({ username, password, email, region });
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

describe("GET /admin/giveaway/hat-lottery-opt-ins", () => {
  it("returns 403 for non-admin", async () => {
    const suffix = Date.now().toString().slice(-6);
    const u = `na${suffix}`;
    const token = await ensureUserToken({
      username: u,
      password: "Test12345",
      email: `${u}@example.com`,
    });
    const res = await request(app)
      .get("/admin/giveaway/hat-lottery-opt-ins")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("returns opted-in users with email and NHL fields for admin", async () => {
    const adminToken = await ensureUserToken({
      username: "BugatsLV",
      password: "Test12345",
      email: "bugatslv_hat_admin@example.com",
    });
    const suffix = Date.now().toString().slice(-8);
    const u = `hat_opt_${suffix}`;
    const token = await ensureUserToken({
      username: u,
      password: "Test12345",
      email: `${u}@example.com`,
    });
    await request(app)
      .post("/giveaway/nhl-team")
      .set("Authorization", `Bearer ${token}`)
      .send({ abbr: "TOR" });
    const opt = await request(app)
      .post("/beta/opt-in")
      .set("Authorization", `Bearer ${token}`)
      .send({ agree: true });
    expect(opt.status).toBe(200);

    const res = await request(app)
      .get("/admin/giveaway/hat-lottery-opt-ins")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.entries)).toBe(true);
    const row = res.body.entries.find((e) => e.username === u);
    expect(row).toBeTruthy();
    expect(row.email).toContain("@");
    expect(row.giveawayNhlAbbr).toBe("TOR");
    expect(String(row.giveawayNhlTeam || "").length).toBeGreaterThan(0);
    expect(row.betaOptInRequestedAt).toBeGreaterThan(0);
  });
});
