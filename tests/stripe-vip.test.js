import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetStripeVipOfferCacheForTest,
  getStripeVipOfferPublic,
  grantVipForCheckoutSession,
} from "../lib/stripe-vip.js";

describe("grantVipForCheckoutSession", () => {
  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test_123");
    vi.stubEnv("STRIPE_VIP_PRICE_ID", "price_vip_test");
    vi.stubEnv("STRIPE_VIP_DAYS", "30");
    vi.stubEnv("STRIPE_VIP_TIER", "vip_basic");
    vi.stubEnv("STRIPE_VIP_LABEL", "VIP 30 dienas");
    __resetStripeVipOfferCacheForTest();
  });

  it("extends VIP from now when user has no active VIP", () => {
    const now = Date.UTC(2026, 3, 16, 12, 0, 0);
    const user = {
      username: "alice",
      vipUntil: 0,
      vipTier: "none",
      stripeSessionsProcessed: [],
    };
    const session = {
      id: "cs_vip_1",
      payment_status: "paid",
      metadata: {
        username: "alice",
        vipPriceId: "price_vip_test",
        vipTier: "vip_basic",
        vipDays: "30",
      },
    };

    const result = grantVipForCheckoutSession(user, session, now);

    expect(result.ok).toBe(true);
    expect(result.daysAdded).toBe(30);
    expect(result.tier).toBe("vip_basic");
    expect(user.vipTier).toBe("vip_basic");
    expect(user.vipUntil).toBe(now + 30 * 24 * 60 * 60 * 1000);
    expect(user.vipLastPurchaseAt).toBe(now);
  });

  it("extends VIP from existing vipUntil when membership is still active", () => {
    const now = Date.UTC(2026, 3, 16, 12, 0, 0);
    const futureVipUntil = now + 7 * 24 * 60 * 60 * 1000;
    const user = {
      username: "alice",
      vipUntil: futureVipUntil,
      vipTier: "vip_basic",
      stripeSessionsProcessed: [],
    };
    const session = {
      id: "cs_vip_2",
      payment_status: "paid",
      metadata: {
        username: "alice",
        vipPriceId: "price_vip_test",
        vipTier: "vip_basic",
        vipDays: "30",
      },
    };

    const result = grantVipForCheckoutSession(user, session, now);

    expect(result.ok).toBe(true);
    expect(user.vipUntil).toBe(futureVipUntil + 30 * 24 * 60 * 60 * 1000);
  });

  it("is idempotent for the same Stripe session", () => {
    const now = Date.UTC(2026, 3, 16, 12, 0, 0);
    const user = {
      username: "alice",
      vipUntil: 0,
      vipTier: "none",
      stripeSessionsProcessed: [],
    };
    const session = {
      id: "cs_vip_3",
      payment_status: "paid",
      metadata: {
        username: "alice",
        vipPriceId: "price_vip_test",
        vipTier: "vip_basic",
        vipDays: "30",
      },
    };

    const first = grantVipForCheckoutSession(user, session, now);
    const second = grantVipForCheckoutSession(user, session, now);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.already).toBe(true);
    expect(second.daysAdded).toBe(0);
    expect(user.vipUntil).toBe(now + 30 * 24 * 60 * 60 * 1000);
  });

  it("rejects mismatched offer metadata", () => {
    const user = {
      username: "alice",
      vipUntil: 0,
      vipTier: "none",
      stripeSessionsProcessed: [],
    };
    const session = {
      id: "cs_vip_bad",
      payment_status: "paid",
      metadata: {
        username: "alice",
        vipPriceId: "price_other",
        vipTier: "vip_basic",
        vipDays: "30",
      },
    };

    const result = grantVipForCheckoutSession(user, session, Date.UTC(2026, 3, 16));

    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_offer");
    expect(user.vipUntil).toBe(0);
  });

  it("returns public VIP offer info from env", () => {
    expect(getStripeVipOfferPublic()).toEqual({
      id: "vip_basic_30d",
      days: 30,
      tier: "vip_basic",
      label: "VIP 30 dienas",
    });
  });
});
