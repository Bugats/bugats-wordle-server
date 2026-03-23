import { describe, it, expect } from "vitest";
import {
  zoleCardEyes,
  zoleComputeTableDeltas,
} from "../lib/zole.js";

describe("zoleCardEyes", () => {
  it("matches Latvian eye table", () => {
    expect(zoleCardEyes({ s: 0, r: 14 })).toBe(11);
    expect(zoleCardEyes({ s: 0, r: 10 })).toBe(10);
    expect(zoleCardEyes({ s: 0, r: 13 })).toBe(4);
    expect(zoleCardEyes({ s: 0, r: 12 })).toBe(3);
    expect(zoleCardEyes({ s: 0, r: 11 })).toBe(2);
    expect(zoleCardEyes({ s: 0, r: 9 })).toBe(0);
  });
});

describe("zoleComputeTableDeltas", () => {
  it("galdins: loser pays winners (jaņi — zaudētājam ≤30 acis)", () => {
    const eyes = [22, 24, 26];
    const tricks = [3, 3, 2];
    const { delta, summary } = zoleComputeTableDeltas("galdins", 0, eyes, tricks);
    expect(summary.kind).toBe("galdins");
    expect(summary.loserIdx).toBe(2);
    expect(summary.payEach).toBe(2);
    expect(delta[2]).toBe(-4);
    expect(delta[0]).toBe(2);
    expect(delta[1]).toBe(2);
  });

  it("big: contractor wins when mazajiem kopā <30 acis → 2 p. no katra", () => {
    const eyes = [65, 15, 10];
    const tricks = [6, 1, 1];
    const { delta, summary } = zoleComputeTableDeltas("big", 0, eyes, tricks);
    expect(summary.kind).toBe("big");
    expect(summary.win).toBe(true);
    expect(summary.tier).toBe(2);
    expect(delta[0]).toBe(4);
    expect(delta[1]).toBe(-2);
    expect(delta[2]).toBe(-2);
  });

  it("zole: contractor loses max tier (no tricks)", () => {
    const eyes = [20, 40, 30];
    const tricks = [0, 5, 3];
    const { delta, summary } = zoleComputeTableDeltas("zole", 0, eyes, tricks);
    expect(summary.kind).toBe("zole");
    expect(summary.win).toBe(false);
    expect(summary.tier).toBe(8);
    expect(delta[0]).toBe(-16);
    expect(delta[1]).toBe(8);
    expect(delta[2]).toBe(8);
  });

  it("zole: contractor wins with 91+ acis → 6 p. no katra", () => {
    const eyes = [95, 5, 5];
    const tricks = [7, 1, 0];
    const { delta, summary } = zoleComputeTableDeltas("zole", 0, eyes, tricks);
    expect(summary.win).toBe(true);
    expect(summary.tier).toBe(6);
    expect(delta[0]).toBe(12);
    expect(delta[1]).toBe(-6);
    expect(delta[2]).toBe(-6);
  });
});
