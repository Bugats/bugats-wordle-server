import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  grantCoinsForCheckoutSession,
  findPackById,
  __resetCoinPacksCacheForTest,
} from "../lib/stripe-coins.js";

describe("grantCoinsForCheckoutSession", () => {
  beforeEach(() => {
    vi.stubEnv(
      "STRIPE_COIN_PACKS_JSON",
      JSON.stringify([
        { id: "p1", priceId: "price_test", coins: 100, label: "100" },
      ])
    );
    __resetCoinPacksCacheForTest();
  });

  it("adds coins once for paid session", () => {
    const user = { username: "alice", coins: 10, stripeSessionsProcessed: [] };
    expect(findPackById("p1")).toBeTruthy();
    const session = {
      id: "cs_test_1",
      payment_status: "paid",
      metadata: { username: "alice", packId: "p1", coins: "100" },
    };
    const r1 = grantCoinsForCheckoutSession(user, session);
    expect(r1.ok).toBe(true);
    expect(r1.coinsAdded).toBe(100);
    expect(user.coins).toBe(110);
    const r2 = grantCoinsForCheckoutSession(user, session);
    expect(r2.already).toBe(true);
    expect(user.coins).toBe(110);
  });
});
