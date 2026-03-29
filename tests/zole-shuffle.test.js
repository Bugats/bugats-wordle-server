import { describe, it, expect } from "vitest";
import { createZoleOnline3pState } from "../lib/zole.js";

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
});
