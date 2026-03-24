import { describe, it, expect } from "vitest";
import { createZoleOnline3pState, zoleProcessBid } from "../lib/zole.js";

describe("zoleProcessBid — divreiz visi pasējuši → Galdiņš", () => {
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
