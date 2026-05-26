import { describe, it, expect } from "vitest";
import {
  createZoleOnline3pState,
  zolePlayCard,
  zolePublicSnapshot,
} from "../lib/zole.js";

describe("finishHand — eyePoints sync", () => {
  it("includes buried card eyes for big contract (UI + lastResult)", () => {
    const s = createZoleOnline3pState("A", "B", "C", "buried-sync");
    s.phase = "play";
    s.contract = "big";
    s.contractorIdx = 0;
    s.trickLeader = 0;
    s.turn = 2;
    s.tricksPlayed = 7;
    s.tricksWon = [6, 1, 1];
    s.eyePoints = [40, 30, 25];
    s.buried = [
      { s: 0, r: 14 },
      { s: 0, r: 10 },
    ];
    s.kitty = [];
    s.trick = [
      { playerIdx: 0, card: { s: 2, r: 9 } },
      { playerIdx: 1, card: { s: 2, r: 9 } },
    ];
    s.hands[0] = [];
    s.hands[1] = [];
    s.hands[2] = [{ s: 2, r: 9 }];

    expect(zolePlayCard(s, 2, { s: 2, r: 9 }).ok).toBe(true);
    expect(s.phase).toBe("end");
    expect(s.eyePoints[0]).toBe(61);
    expect(s.lastResult?.eyes?.[0]).toBe(61);
    const snap = zolePublicSnapshot(s, 0);
    expect(snap.eyePoints[0]).toBe(61);
    expect(s.lastResult?.contrEyes).toBe(61);
  });

  it("includes kitty eyes split between opponents for zole", () => {
    const s = createZoleOnline3pState("A", "B", "C", "kitty-sync");
    s.phase = "play";
    s.contract = "zole";
    s.contractorIdx = 0;
    s.trickLeader = 0;
    s.turn = 2;
    s.tricksPlayed = 7;
    s.tricksWon = [6, 1, 1];
    s.eyePoints = [50, 20, 18];
    s.kittyEyesToOpponents = 17;
    s.kitty = [];
    s.buried = [];
    s.trick = [
      { playerIdx: 0, card: { s: 2, r: 9 } },
      { playerIdx: 1, card: { s: 2, r: 9 } },
    ];
    s.hands[0] = [];
    s.hands[1] = [];
    s.hands[2] = [{ s: 2, r: 9 }];

    expect(zolePlayCard(s, 2, { s: 2, r: 9 }).ok).toBe(true);
    expect(s.phase).toBe("end");
    expect(s.eyePoints[1]).toBe(28);
    expect(s.eyePoints[2]).toBe(27);
    expect(s.lastResult?.eyes).toEqual([50, 28, 27]);
  });
});
