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

describe("POST /beta/opt-in", () => {
  it("requires agree flag", async () => {
    const suffix = Date.now().toString().slice(-8);
    const u = `beta_no_${suffix}`;
    const token = await ensureUserToken({
      username: u,
      password: "Test12345",
      email: `${u}@example.com`,
    });
    const res = await request(app)
      .post("/beta/opt-in")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("requires saved email", async () => {
    const suffix = Date.now().toString().slice(-8);
    const u = `beta_ne_${suffix}`;
    const token = await ensureUserToken({
      username: u,
      password: "Test12345",
      email: `${u}@example.com`,
    });
    await request(app)
      .post("/email")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "" });
    const res = await request(app)
      .post("/beta/opt-in")
      .set("Authorization", `Bearer ${token}`)
      .send({ agree: true });
    expect(res.status).toBe(400);
  });

  it("records opt-in when email present", async () => {
    const suffix = Date.now().toString().slice(-8);
    const u = `beta_ok_${suffix}`;
    const token = await ensureUserToken({
      username: u,
      password: "Test12345",
      email: `${u}@example.com`,
    });
    const res = await request(app)
      .post("/beta/opt-in")
      .set("Authorization", `Bearer ${token}`)
      .send({ agree: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Number(res.body.betaOptInRequestedAt || 0)).toBeGreaterThan(0);

    const me = await request(app)
      .get("/me")
      .set("Authorization", `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(Number(me.body.betaOptInRequestedAt || 0)).toBeGreaterThan(0);
  });
});
