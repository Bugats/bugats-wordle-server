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

describe("GET /metrics", () => {
  it("returns board counters in test (no METRICS_TOKEN)", async () => {
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(typeof res.body?.activeBoardGames).toBe("number");
    expect(typeof res.body?.onlineUsers).toBe("number");
  });
});

describe("GET /meta/storage", () => {
  it("returns avatar and users storage type", async () => {
    const res = await request(app).get("/meta/storage");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("avatarStorage");
    expect(res.body).toHaveProperty("usersStore");
    expect(["supabase", "inline"]).toContain(res.body.avatarStorage);
    expect(["supabase", "file"]).toContain(res.body.usersStore);
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
    expect(csp).toContain("media-src 'self'");
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
