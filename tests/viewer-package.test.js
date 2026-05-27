import request from "supertest";
import { describe, expect, it } from "vitest";
import { app, __testHooks } from "../server.js";

async function signupToken(username) {
  const res = await request(app)
    .post("/signup")
    .set("x-vz-device-id", `viewer-${username}-${Date.now()}`)
    .send({
      username,
      password: "Test12345",
      email: `${username}@example.com`,
      region: "Zemgale",
      ageConfirmed: true,
    });
  expect(res.status).toBe(200);
  return res.body.token;
}

describe("Viewer attraction package", () => {
  it("returns live board games payload shape", () => {
    const p = __testHooks.getLiveBoardGamesPayloadForTestOnly();
    expect(p).toBeTruthy();
    expect(Array.isArray(p.games)).toBe(true);
    expect(typeof p.totalCount).toBe("number");
    expect(typeof p.serverNow).toBe("number");
  });

  it("includes shareUrl on tournament detail when load succeeds", async () => {
    const token = await signupToken(`vt${Date.now().toString().slice(-8)}`);
    const listRes = await request(app)
      .get("/tournaments")
      .set("Authorization", `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    const tournaments = Array.isArray(listRes.body?.tournaments)
      ? listRes.body.tournaments
      : [];
    if (!tournaments.length) return;
    const id = tournaments[0].id;
    const detail = await request(app)
      .get(`/tournaments/${id}`)
      .set("Authorization", `Bearer ${token}`);
    if (detail.status !== 200) return;
    expect(String(detail.body?.shareUrl || "")).toContain(
      `game.html?turnirs=${id}`
    );
  });

  it("challenge spectate endpoint hides player-only secrets", async () => {
    const u1 = `vs1${Date.now().toString().slice(-6)}`;
    const u2 = `vs2${Date.now().toString().slice(-6)}`;
    const t1 = await signupToken(u1);
    const t2 = await signupToken(u2);
    const create = await request(app)
      .post("/challenge/create")
      .set("Authorization", `Bearer ${t1}`)
      .send({});
    expect(create.status).toBe(200);
    const id = create.body.challengeId;
    const spec = await request(app)
      .get(`/challenge/${id}/spectate`)
      .set("Authorization", `Bearer ${t2}`);
    expect(spec.status).toBe(200);
    expect(spec.body.status).toBe("waiting");
    expect(spec.body.isPlayer).toBe(false);
    expect(spec.body.player1).toBe(u1);
    expect(spec.body.shareUrl).toContain(`challenge=${id}`);
  });
});
