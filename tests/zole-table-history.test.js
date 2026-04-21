import { describe, it, expect } from "vitest";
import {
  createZoleOnline3pState,
  zolePublicSnapshot,
  zoleStartNextHand,
} from "../lib/zole.js";

describe("zole completedTableDeltas", () => {
  it("pushes previous hand delta when starting next hand (max 3)", () => {
    const s = createZoleOnline3pState("A", "B", "C", "hist-test");
    s.phase = "end";
    s.matchHandsPlayed = 1;
    s.tableDelta = [4, -2, -2];
    expect(zoleStartNextHand(s).ok).toBe(true);
    expect(s.completedTableDeltas).toEqual([[4, -2, -2]]);

    s.phase = "end";
    s.matchHandsPlayed = 2;
    s.tableDelta = [1, 1, -2];
    expect(zoleStartNextHand(s).ok).toBe(true);
    expect(s.completedTableDeltas).toEqual([
      [4, -2, -2],
      [1, 1, -2],
    ]);

    s.phase = "end";
    s.matchHandsPlayed = 3;
    s.tableDelta = [0, 0, 0];
    expect(zoleStartNextHand(s).ok).toBe(true);
    expect(s.completedTableDeltas).toEqual([
      [4, -2, -2],
      [1, 1, -2],
      [0, 0, 0],
    ]);

    s.phase = "end";
    s.matchHandsPlayed = 4;
    s.tableDelta = [10, -5, -5];
    expect(zoleStartNextHand(s).ok).toBe(true);
    expect(s.completedTableDeltas).toEqual([
      [1, 1, -2],
      [0, 0, 0],
      [10, -5, -5],
    ]);
  });

  it("does not archive when no hand was completed yet (matchHandsPlayed 0)", () => {
    const s = createZoleOnline3pState("A", "B", "C", "hist-zero");
    s.phase = "end";
    s.matchHandsPlayed = 0;
    s.tableDelta = [9, -4, -5];
    expect(zoleStartNextHand(s).ok).toBe(true);
    expect(s.completedTableDeltas).toEqual([]);
  });

  it("zolePublicSnapshot exposes completedTableDeltas", () => {
    const s = createZoleOnline3pState("X", "Y", "Z", "hist-snap");
    s.phase = "end";
    s.matchHandsPlayed = 1;
    s.tableDelta = [2, -1, -1];
    expect(zoleStartNextHand(s).ok).toBe(true);
    const snap = zolePublicSnapshot(s, 0);
    expect(snap.completedTableDeltas).toEqual([[2, -1, -1]]);
  });
});
