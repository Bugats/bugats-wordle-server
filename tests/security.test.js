import jwt from "jsonwebtoken";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../server.js";

describe("Security hardening", () => {
  it("rejects signup with case-insensitive duplicate username", async () => {
    const base = `case${Date.now().toString().slice(-8)}`;
    const firstName = `${base}A`;
    const secondName = firstName.toLowerCase();

    const firstRes = await request(app)
      .post("/signup")
      .set("x-vz-device-id", `test-signup-${firstName}-${Date.now()}`)
      .send({
        username: firstName,
        password: "Test12345",
        email: `${firstName}@example.com`,
        region: "Zemgale",
      });
    expect(firstRes.status).toBe(200);

    const secondRes = await request(app)
      .post("/signup")
      .set("x-vz-device-id", `test-signup-${secondName}-${Date.now()}`)
      .send({
        username: secondName,
        password: "Test12345",
        email: `${secondName}@example.com`,
        region: "Zemgale",
      });

    expect(secondRes.status).toBe(400);
    expect(String(secondRes.body?.message || "")).toContain("eksistē");
  });

  it("does not sign tokens with legacy fallback JWT secret", async () => {
    const username = `jwt${Date.now().toString().slice(-8)}`;
    const signupRes = await request(app)
      .post("/signup")
      .set("x-vz-device-id", `test-signup-${username}-${Date.now()}`)
      .send({
        username,
        password: "Test12345",
        email: `${username}@example.com`,
        region: "Zemgale",
      });
    expect(signupRes.status).toBe(200);
    const token = signupRes.body?.token;
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(20);

    expect(() =>
      jwt.verify(token, "BUGATS_VARDU_ZONA_SUPER_SLEPENS_JWT")
    ).toThrow();
  });
});
