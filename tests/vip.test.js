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

describe("VIP tournament access", () => {
  it("allows VIP to create tournament without admin rights", async () => {
    const adminToken = await ensureUserToken({
      username: "BugatsLV",
      password: "Test12345",
      email: "bugatslv_test@example.com",
    });
    const username = `vip${Date.now().toString().slice(-8)}`;
    const vipToken = await ensureUserToken({
      username,
      password: "Test12345",
      email: `${username}@example.com`,
    });

    const grantRes = await request(app)
      .post("/admin/vip/grant")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ username, days: 30 });
    expect(grantRes.status).toBe(200);
    expect(grantRes.body?.vip?.active).toBe(true);

    const vipStatusRes = await request(app)
      .get("/vip/status")
      .set("Authorization", `Bearer ${vipToken}`);
    expect(vipStatusRes.status).toBe(200);
    expect(vipStatusRes.body?.active).toBe(true);
    expect(vipStatusRes.body?.canCreateTournament).toBe(true);

    const createRes = await request(app)
      .post("/tournaments")
      .set("Authorization", `Bearer ${vipToken}`)
      .send({
        name: `VIP Cup ${Date.now().toString().slice(-6)}`,
        type: "single_elimination",
        seeding: [username, "Alpha", "Bravo", "Charlie"],
      });
    expect(createRes.status).toBe(200);
    expect(createRes.body?.ok).toBe(true);

    const seasonStartRes = await request(app)
      .post("/season/start")
      .set("Authorization", `Bearer ${vipToken}`)
      .send({});
    expect(seasonStartRes.status).toBe(403);
  });
});
