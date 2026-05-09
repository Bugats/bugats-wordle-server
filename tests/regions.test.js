import request from "supertest";
import { describe, expect, it } from "vitest";
import { __testHooks, app } from "../server.js";

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

function todayKeyRiga() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Riga",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

describe("Regions API", () => {
  it("returns bonus metadata/rules and enforces daily attack cap", async () => {
    const username = `reg${Date.now().toString().slice(-8)}`;
    const token = await ensureUserToken({
      username,
      password: "Test12345",
      email: `${username}@example.com`,
      region: "Zemgale",
    });

    const statsRes = await request(app)
      .get("/regions/stats")
      .set("Authorization", `Bearer ${token}`);
    expect(statsRes.status).toBe(200);
    expect(statsRes.body?.bonus).toBeTruthy();
    expect(typeof statsRes.body?.bonus?.enabled).toBe("boolean");
    expect(statsRes.body?.attackLimit).toBeTruthy();
    expect(typeof statsRes.body?.attackLimit?.enabled).toBe("boolean");
    expect(Array.isArray(statsRes.body?.rules)).toBe(true);
    expect(statsRes.body.rules.length).toBeGreaterThan(0);

    const cap = Math.max(
      0,
      Math.floor(Number(statsRes.body?.attackLimit?.cap) || 0)
    );
    const capEnabled = !!statsRes.body?.attackLimit?.enabled && cap > 0;
    expect(capEnabled).toBe(true);

    const seeded = __testHooks.setRegionStateForTestOnly(username, {
      region: "Zemgale",
      regionPoints: cap + 2,
      regionAttackUsedToday: cap - 1,
      regionAttackDate: todayKeyRiga(),
    });
    expect(seeded).toBe(true);

    const firstAttackRes = await request(app)
      .post("/region/attack")
      .set("Authorization", `Bearer ${token}`)
      .send({ region: "Latgale", amount: 1 });
    expect(firstAttackRes.status).toBe(200);

    const blockedRes = await request(app)
      .post("/region/attack")
      .set("Authorization", `Bearer ${token}`)
      .send({ region: "Latgale", amount: 1 });
    expect(blockedRes.status).toBe(429);
    expect(Number(blockedRes.body?.attackLimit?.remaining || 0)).toBe(0);
    expect(String(blockedRes.body?.message || "").toLowerCase()).toContain(
      "limits"
    );
  });

  it("competitive win grant increases regionBoost for tabula", async () => {
    const username = `regb${Date.now().toString().slice(-8)}`;
    const token = await ensureUserToken({
      username,
      password: "Test12345",
      email: `${username}@example.com`,
      region: "Kurzeme",
    });

    const before = await request(app)
      .get("/me")
      .set("Authorization", `Bearer ${token}`);
    expect(before.status).toBe(200);
    const boost0 = Math.max(0, Math.floor(before.body?.regionBoost || 0));

    const ok = __testHooks.grantRegionRewardForCompetitiveWinForTestOnly(
      username,
      2
    );
    expect(ok).toBe(true);

    const after = await request(app)
      .get("/me")
      .set("Authorization", `Bearer ${token}`);
    expect(after.status).toBe(200);
    const boost1 = Math.max(0, Math.floor(after.body?.regionBoost || 0));
    expect(boost1).toBeGreaterThanOrEqual(boost0 + 2);
  });
});
