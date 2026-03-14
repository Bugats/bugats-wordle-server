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

describe("Runtime config", () => {
  it("serves runtime-config.js payload", async () => {
    const res = await request(app).get("/runtime-config.js");
    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"] || "")).toContain(
      "application/javascript"
    );
    expect(String(res.text || "")).toContain("window.VZ_RUNTIME_CONFIG");
    expect(String(res.headers["cache-control"] || "")).toContain("no-store");
  });
});

describe("Legal pages", () => {
  it("serves terms, copyright, and DMCA pages", async () => {
    const routes = [
      ["/terms.html", "Lietošanas noteikumi"],
      ["/copyright-trademark.html", "Autortiesību un preču zīmes politika"],
      ["/dmca.html", "DMCA process"],
    ];

    for (const [route, marker] of routes) {
      const res = await request(app).get(route);
      expect(res.status).toBe(200);
      expect(String(res.text || "")).toContain(marker);
    }
  });
});

describe("Push worker integration", () => {
  it("serves service worker with OneSignal bridge", async () => {
    const res = await request(app).get("/sw.js");
    expect(res.status).toBe(200);
    expect(String(res.text || "")).toContain("OneSignalSDK.sw.js");
  });
});
