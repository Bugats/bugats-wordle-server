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

  it("plain lead: must play plain of suit first; D/J only if no plain in suit", () => {
    const hand = [
      { s: 0, r: 9 },
      { s: 0, r: 12 },
      { s: 1, r: 14 },
    ];
    const trick = [{ playerIdx: 0, card: { s: 0, r: 14 } }];
    const legal = zoleLegalPlays(hand, trick);
    expect(legal.map((c) => `${c.s}:${c.r}`)).toEqual(["0:9"]);
  });

  it("plain ♥ lead: cannot play ♥D if plain ♥ remains", () => {
    const hand = [
      { s: 2, r: 14 },
      { s: 2, r: 12 },
    ];
    const trick = [{ playerIdx: 0, card: { s: 2, r: 10 } }];
    const legal = zoleLegalPlays(hand, trick);
    expect(legal).toEqual([{ s: 2, r: 14 }]);
  });

  it("plain ♥ lead: no plain ♥ — may discard any or play trump (full hand legal)", () => {
    const hand = [
      { s: 2, r: 12 },
      { s: 2, r: 11 },
      { s: 0, r: 9 },
    ];
    const trick = [{ playerIdx: 0, card: { s: 2, r: 10 } }];
    const legal = zoleLegalPlays(hand, trick);
    expect(legal.length).toBe(3);
  });

  it("plain ♣ lead: no plain ♣ — K♠ and ♣J both legal (discard or trump)", () => {
    const hand = [
      { s: 3, r: 13 },
      { s: 0, r: 11 },
    ];
    const trick = [{ playerIdx: 0, card: { s: 0, r: 10 } }];
    const legal = zoleLegalPlays(hand, trick);
    expect(legal.map((c) => `${c.s}:${c.r}`).sort()).toEqual(["0:11", "3:13"]);
  });

  it("trick: trump beats non-trump on lead", () => {
    const trick = [
      { playerIdx: 0, card: { s: 0, r: 9 } },
      { playerIdx: 1, card: { s: 0, r: 14 } },
      { playerIdx: 2, card: { s: 2, r: 12 } },
    ];
    expect(zoleTrickWinner(trick)).toBe(2);
  });

  it("lead is trump: must play trump if any; else only plain", () => {
    const trick = [{ playerIdx: 0, card: { s: 2, r: 12 } }];
    const withTrump = [
      { s: 0, r: 9 },
      { s: 1, r: 7 },
    ];
    const legalT = zoleLegalPlays(withTrump, trick);
    expect(legalT.length).toBe(1);
    expect(legalT[0].s).toBe(1);
    const plainOnly = [
      { s: 0, r: 9 },
      { s: 0, r: 14 },
    ];
    const legalP = zoleLegalPlays(plainOnly, trick);
    expect(legalP.length).toBe(2);
    expect(legalP.every((c) => !zoleIsTrump(c))).toBe(true);
  });
});

describe("sortZoleHand", () => {
  it("groups plain suits ♣ ♠ ♥ (strong left A→10→K→9) then trumps descending strength", () => {
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
      "0:14",
      "0:9",
      "2:14",
      "3:12",
      "2:12",
      "1:12",
      "1:7",
    ]);
    const trumpPart = sorted.filter(zoleIsTrump);
    for (let i = 1; i < trumpPart.length; i++) {
      expect(zoleCardTrickStrength(trumpPart[i - 1])).toBeGreaterThanOrEqual(
        zoleCardTrickStrength(trumpPart[i])
      );
    }
  });
});
