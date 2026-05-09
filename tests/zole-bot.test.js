import { describe, it, expect } from "vitest";
import {
  createZoleVsBotState,
  zolePickBotBid,
  zoleProcessBid,
} from "../lib/zole.js";

describe("Zole bot bidding", () => {
  it("zolePickBotBid returns pass, big, zole, or maza_zole", () => {
    const s = createZoleVsBotState("Human");
    for (let step = 0; step < 12 && s.phase === "bid"; step++) {
      const i = s.bidTurn;
      const b = zolePickBotBid(s, i, "medium");
      expect(["pass", "big", "zole", "maza_zole"]).toContain(b);
      const res = zoleProcessBid(s, i, b);
      expect(res.ok).toBe(true);
    }
  });
});
