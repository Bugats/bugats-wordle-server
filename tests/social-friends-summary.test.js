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

describe("GET /friends friendSummaries", () => {
  it("includes clanTag and online for friends", async () => {
    const suffix = Date.now().toString().slice(-7);
    const a = `soc_a_${suffix}`;
    const b = `soc_b_${suffix}`;

    const tokenA = await ensureUserToken({
      username: a,
      password: "Test12345",
      email: `${a}@example.com`,
    });
    const tokenB = await ensureUserToken({
      username: b,
      password: "Test12345",
      email: `${b}@example.com`,
    });

    const req = await request(app)
      .post("/friends/request")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ to: b });
    expect(req.status).toBe(200);
    const acc = await request(app)
      .post("/friends/accept")
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ from: a });
    expect(acc.status).toBe(200);

    const clanTag = `X${suffix.slice(-4)}`.toUpperCase().slice(0, 6);
    const clanRes = await request(app)
      .post("/clan/create")
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ name: `Clan ${suffix}`, tag: clanTag });
    expect(clanRes.status).toBe(200);

    const list = await request(app)
      .get("/friends")
      .set("Authorization", `Bearer ${tokenA}`);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body?.friendSummaries)).toBe(true);
    const row = list.body.friendSummaries.find(
      (x) => String(x?.name || "").toLowerCase() === b.toLowerCase()
    );
    expect(row).toBeTruthy();
    expect(String(row.clanTag || "").length).toBeGreaterThan(0);
    expect(typeof row.online).toBe("boolean");
  });
});
