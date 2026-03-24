import { describe, it, expect } from "vitest";
import { createZoleOnline3pState, zoleProcessBid } from "../lib/zole.js";

describe("zoleProcessBid — divreiz visi pasējuši → Galdiņš", () => {
  it("galdins is not a valid manual bid (only double pass)", () => {
    const s = createZoleOnline3pState("A", "B", "C");
    const res = zoleProcessBid(s, s.bidTurn, "galdins");
    expect(res.ok).toBe(false);
    expect(s.phase).toBe("bid");
  });

  it("after two full pass rounds contract is galdins not galds", () => {
    const s = createZoleOnline3pState("A", "B", "C");
    expect(s.phase).toBe("bid");
    for (let r = 0; r < 2; r++) {
      for (let p = 0; p < 3; p++) {
        const idx = s.bidTurn;
        const res = zoleProcessBid(s, idx, "pass");
        expect(res.ok).toBe(true);
      }
    }
    expect(s.phase).toBe("play");
    expect(s.contract).toBe("galdins");
    expect(s.contractorIdx).toBeNull();
  });
});
