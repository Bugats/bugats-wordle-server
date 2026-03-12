import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../server.js";

describe("GET /health", () => {
  it("returns ok true payload", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe("CSP headers", () => {
  it("allows required external connect and media sources", async () => {
    const res = await request(app).get("/game.html");
    expect(res.status).toBe(200);
    const csp = String(res.headers["content-security-policy"] || "");
    expect(csp).toContain(
      "connect-src 'self' https://bugats-wordle-server.onrender.com wss://bugats-wordle-server.onrender.com"
    );
    expect(csp).toContain("media-src 'self' https://stream.nightride.fm");
  });
});
