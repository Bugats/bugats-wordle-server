import { describe, it, expect } from "vitest";
import {
  zoleIsTrump,
  zoleLegalPlays,
  zoleTrickWinner,
  ZOLE_SUIT_CLUBS,
} from "../lib/zole.js";

describe("Latvian trump / follow suit", () => {
  it("all queens and jacks are trump", () => {
    expect(zoleIsTrump({ s: 0, r: 12 })).toBe(true);
    expect(zoleIsTrump({ s: 3, r: 11 })).toBe(true);
    expect(zoleIsTrump({ s: 1, r: 14 })).toBe(false);
  });

  it("non-face clubs are trump", () => {
    expect(zoleIsTrump({ s: ZOLE_SUIT_CLUBS, r: 7 })).toBe(true);
    expect(zoleIsTrump({ s: ZOLE_SUIT_CLUBS, r: 10 })).toBe(true);
  });

  it("must follow lead suit including Q/J as that suit", () => {
    const hand = [
      { s: 0, r: 9 },
      { s: 0, r: 12 },
      { s: 1, r: 14 },
    ];
    const trick = [{ playerIdx: 0, card: { s: 0, r: 14 } }];
    const legal = zoleLegalPlays(hand, trick);
    expect(legal.length).toBe(2);
  });

  it("trick: trump beats non-trump on lead", () => {
    const trick = [
      { playerIdx: 0, card: { s: 1, r: 9 } },
      { playerIdx: 1, card: { s: 1, r: 14 } },
      { playerIdx: 2, card: { s: 0, r: 12 } },
    ];
    expect(zoleTrickWinner(trick)).toBe(2);
  });
});
