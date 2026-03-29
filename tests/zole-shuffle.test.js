import { describe, it, expect } from "vitest";
import { createZoleOnline3pState } from "../lib/zole.js";

function layoutKey(s) {
  return s.hands
    .map((h) =>
      [...h]
        .sort((x, y) => x.s - y.s || x.r - y.r)
        .map((c) => `${c.s}:${c.r}`)
        .join(",")
    )
    .join("|");
}

describe("zole deck shuffle", () => {
  it("each new deal has a distinct full layout (crypto riffle + cuts)", () => {
    const sigs = new Set();
    const n = 50;
    for (let i = 0; i < n; i++) {
      const s = createZoleOnline3pState("pA", "pB", "pC");
      const key = s.hands
        .map((h) =>
          [...h]
            .sort((x, y) => x.s - y.s || x.r - y.r)
            .map((c) => `${c.s}:${c.r}`)
            .join(",")
        )
        .join("|");
      sigs.add(key);
    }
    expect(sigs.size).toBe(n);
  });

  it("different room gameIds yield different deals (no cross-room pattern lockstep)", () => {
    const a = createZoleOnline3pState("pA", "pB", "pC", "game_hex_a1b2c3");
    const b = createZoleOnline3pState("pA", "pB", "pC", "game_hex_x9y8z7");
    expect(layoutKey(a)).not.toBe(layoutKey(b));
  });
});
