import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app, __testHooks } from "../server.js";
import { __resetStripeVipOfferCacheForTest } from "../lib/stripe-vip.js";

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
  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_vip");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_vip");
    vi.stubEnv("STRIPE_VIP_PRICE_ID", "price_vip_test");
    vi.stubEnv("STRIPE_VIP_DAYS", "30");
    vi.stubEnv("STRIPE_VIP_TIER", "vip_basic");
    vi.stubEnv("STRIPE_VIP_LABEL", "VIP 30 dienas");
    vi.stubEnv("BASE_URL", "https://example.test");
    __resetStripeVipOfferCacheForTest();
    __testHooks.setStripeClientForTestOnly(null);
  });

  afterEach(() => {
    __testHooks.setStripeClientForTestOnly(null);
    vi.unstubAllEnvs();
    __resetStripeVipOfferCacheForTest();
  });

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

    /* Otrs VIP — lai nav cooldown pēc pirmā turnīra */
    const username2 = `vip2${Date.now().toString().slice(-8)}`;
    const vipToken2 = await ensureUserToken({
      username: username2,
      password: "Test12345",
      email: `${username2}@example.com`,
    });
    const grant2 = await request(app)
      .post("/admin/vip/grant")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ username: username2, days: 30 });
    expect(grant2.status).toBe(200);

    const quickName = `Quick VIP ${Date.now().toString().slice(-6)}`;
    const quickRes = await request(app)
      .post("/tournaments")
      .set("Authorization", `Bearer ${vipToken2}`)
      .send({
        name: quickName,
        type: "single_elimination",
        playMode: "classic",
        seeding: [username2, "One", "Two", "Three"],
        autoReportOnly: true,
      });
    expect(quickRes.status).toBe(200);
    expect(quickRes.body?.ok).toBe(true);
    expect(Number(quickRes.body?.tournament?.id)).toBeGreaterThan(0);

    const seasonStartRes = await request(app)
      .post("/season/start")
      .set("Authorization", `Bearer ${vipToken}`)
      .send({});
    expect(seasonStartRes.status).toBe(403);
  });

  it("creates Stripe checkout for VIP and activates VIP via webhook", async () => {
    const username = `vipbuy${Date.now().toString().slice(-8)}`;
    const token = await ensureUserToken({
      username,
      password: "Test12345",
      email: `${username}@example.com`,
    });

    const checkoutCreate = vi.fn(async (payload) => ({
      id: "cs_test_vip_1",
      url: "https://checkout.stripe.test/vip-session",
      ...payload,
    }));
    const constructEvent = vi.fn(() => ({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_vip_1",
          payment_status: "paid",
          metadata: {
            kind: "vip",
            username,
            vipOfferId: "vip_basic_30d",
            vipPriceId: "price_vip_test",
            vipTier: "vip_basic",
            vipDays: "30",
          },
        },
      },
    }));
    __testHooks.setStripeClientForTestOnly({
      checkout: { sessions: { create: checkoutCreate } },
      webhooks: { constructEvent },
    });

    const statusBefore = await request(app)
      .get("/vip/status")
      .set("Authorization", `Bearer ${token}`);
    expect(statusBefore.status).toBe(200);
    expect(statusBefore.body?.active).toBe(false);
    expect(statusBefore.body?.purchaseEnabled).toBe(true);
    expect(statusBefore.body?.offer?.days).toBe(30);

    const res = await request(app)
      .post("/vip/buy")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body?.url).toBe("https://checkout.stripe.test/vip-session");
    expect(res.body?.offer?.label).toBe("VIP 30 dienas");
    expect(checkoutCreate).toHaveBeenCalledTimes(1);
    expect(checkoutCreate.mock.calls[0]?.[0]?.line_items).toEqual([
      { price: "price_vip_test", quantity: 1 },
    ]);
    expect(checkoutCreate.mock.calls[0]?.[0]?.metadata).toMatchObject({
      kind: "vip",
      username,
      vipPriceId: "price_vip_test",
      vipTier: "vip_basic",
      vipDays: "30",
    });

    const webhookRes = await request(app)
      .post("/api/stripe/webhook")
      .set("stripe-signature", "sig_test")
      .set("Content-Type", "application/json")
      .send(Buffer.from(JSON.stringify({ id: "evt_test_vip" })));
    expect(webhookRes.status).toBe(200);
    expect(constructEvent).toHaveBeenCalledTimes(1);

    const user = __testHooks.getUserByNameForTestOnly(username);
    expect(user).toBeTruthy();
    expect(Number(user?.vipUntil || 0)).toBeGreaterThan(Date.now());
    expect(user?.vipTier).toBe("vip_basic");

    const statusAfter = await request(app)
      .get("/vip/status")
      .set("Authorization", `Bearer ${token}`);
    expect(statusAfter.status).toBe(200);
    expect(statusAfter.body?.active).toBe(true);
    expect(statusAfter.body?.canCreateTournament).toBe(true);

    const webhookAgain = await request(app)
      .post("/api/stripe/webhook")
      .set("stripe-signature", "sig_test")
      .set("Content-Type", "application/json")
      .send(Buffer.from(JSON.stringify({ id: "evt_test_vip" })));
    expect(webhookAgain.status).toBe(200);

    const userAfterRepeat = __testHooks.getUserByNameForTestOnly(username);
    expect(Number(userAfterRepeat?.vipUntil || 0)).toBe(Number(user?.vipUntil || 0));
  });
});
