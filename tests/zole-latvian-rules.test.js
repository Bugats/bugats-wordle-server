import { describe, it, expect } from "vitest";
import {
  zoleIsTrump,
  zoleLegalPlays,
  zoleTrickWinner,
  zoleCardTrickStrength,
  sortZoleHand,
  ZOLE_SUIT_KARAVS,
} from "../lib/zole.js";

describe("Latvian trump / follow suit (♣ kreicis, ♦ kāravs, ♥ ercens, ♠ pīķis)", () => {
  it("all queens and jacks are trump", () => {
    expect(zoleIsTrump({ s: 2, r: 12 })).toBe(true);
    expect(zoleIsTrump({ s: 3, r: 11 })).toBe(true);
    expect(zoleIsTrump({ s: 0, r: 14 })).toBe(false);
  });

  it("non-face ♦ (kāravas) cards are trump", () => {
    expect(zoleIsTrump({ s: ZOLE_SUIT_KARAVS, r: 7 })).toBe(true);
    expect(zoleIsTrump({ s: ZOLE_SUIT_KARAVS, r: 10 })).toBe(true);
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
      { playerIdx: 0, card: { s: 0, r: 9 } },
      { playerIdx: 1, card: { s: 0, r: 14 } },
      { playerIdx: 2, card: { s: 2, r: 12 } },
    ];
    expect(zoleTrickWinner(trick)).toBe(2);
  });
});

describe("sortZoleHand", () => {
  it("groups plain suits ♣ ♠ ♥ then trumps ascending strength", () => {
    const hand = [
      { s: 2, r: 14 },
      { s: 0, r: 9 },
      { s: 0, r: 14 },
      { s: 1, r: 7 },
      { s: 3, r: 12 },
      { s: 1, r: 12 },
      { s: 2, r: 12 },
    ];
    const sorted = sortZoleHand(hand);
    const keys = sorted.map((c) => `${c.s}:${c.r}`);
    expect(keys).toEqual([
      "0:9",
      "0:14",
      "2:14",
      "1:7",
      "1:12",
      "2:12",
      "3:12",
    ]);
    const trumpPart = sorted.filter(zoleIsTrump);
    for (let i = 1; i < trumpPart.length; i++) {
      expect(zoleCardTrickStrength(trumpPart[i - 1])).toBeLessThanOrEqual(
        zoleCardTrickStrength(trumpPart[i])
      );
    }
  });
});
