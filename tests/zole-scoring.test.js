import { describe, it, expect } from "vitest";
import {
  zoleAugmentLastResultEyeMeta,
  zoleCardEyes,
  zoleComputeTableDeltas,
  zoleGaldsLoserIdx,
  zoleTeamEyesFromLastResult,
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

describe("zoleAugmentLastResultEyeMeta", () => {
  it("adds buried eyes for big contract", () => {
    const summary = { kind: "big", win: true, tier: 1 };
    zoleAugmentLastResultEyeMeta(summary, "big", [
      { s: 0, r: 14 },
      { s: 0, r: 10 },
    ]);
    expect(summary.buriedEyesTotal).toBe(21);
  });

  it("adds kitty eyes for zole contract", () => {
    const summary = { kind: "zole", win: false, tier: 6 };
    zoleAugmentLastResultEyeMeta(summary, "zole", [], 17);
    expect(summary.kittyEyesToOpponents).toBe(17);
  });

  it("does not set kitty meta for galdins", () => {
    const summary = { kind: "galdins", loserIdx: 0 };
    zoleAugmentLastResultEyeMeta(summary, "galdins", [], 10);
    expect(summary.kittyEyesToOpponents).toBeUndefined();
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
    expect(summary.loserNoTricks).toBe(false);
    expect(delta[2]).toBe(-4);
    expect(delta[0]).toBe(2);
    expect(delta[1]).toBe(2);
  });

  it("galdins: bezstiķis zaudētājam → 3 p. katram", () => {
    const eyes = [50, 48, 20];
    const tricks = [0, 4, 4];
    const { summary } = zoleComputeTableDeltas("galdins", 0, eyes, tricks);
    expect(summary.loserIdx).toBe(0);
    expect(summary.payEach).toBe(3);
    expect(summary.loserNoTricks).toBe(true);
  });

  it("big: contractor wins when mazajiem kopā <30 acis → 2 p. no katra", () => {
    const eyes = [65, 15, 10];
    const tricks = [6, 1, 1];
    const { delta, summary } = zoleComputeTableDeltas("big", 0, eyes, tricks);
    expect(summary.kind).toBe("big");
    expect(summary.win).toBe(true);
    expect(summary.tier).toBe(2);
    expect(summary.opponentsNoTricks).toBe(false);
    expect(delta[0]).toBe(4);
    expect(delta[1]).toBe(-2);
    expect(delta[2]).toBe(-2);
  });

  it("big: uzvara ar mazajiem bezstiķa → 3 p. no katra", () => {
    const eyes = [62, 0, 0];
    const tricks = [8, 0, 0];
    const { summary } = zoleComputeTableDeltas("big", 0, eyes, tricks);
    expect(summary.win).toBe(true);
    expect(summary.tier).toBe(3);
    expect(summary.opponentsNoTricks).toBe(true);
  });

  it("zole: contractor loses max tier (no tricks)", () => {
    const eyes = [20, 40, 30];
    const tricks = [0, 5, 3];
    const { delta, summary } = zoleComputeTableDeltas("zole", 0, eyes, tricks);
    expect(summary.kind).toBe("zole");
    expect(summary.win).toBe(false);
    expect(summary.tier).toBe(8);
    expect(summary.contractorNoTricks).toBe(true);
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
    expect(summary.allTricks).toBe(false);
    expect(delta[0]).toBe(12);
    expect(delta[1]).toBe(-6);
    expect(delta[2]).toBe(-6);
  });

  it("zole: visi stiķi → 7 p. no katra", () => {
    const eyes = [80, 10, 10];
    const tricks = [8, 0, 0];
    const { summary } = zoleComputeTableDeltas("zole", 0, eyes, tricks);
    expect(summary.win).toBe(true);
    expect(summary.tier).toBe(7);
    expect(summary.allTricks).toBe(true);
  });

  it("galds: zaudē ar vairāk stiķiem vai, ja vienādi, ar vairāk acīm", () => {
    expect(zoleGaldsLoserIdx([10, 20, 30], [2, 4, 3])).toBe(1);
    const { summary } = zoleComputeTableDeltas("galds", 0, [10, 20, 30], [2, 4, 3]);
    expect(summary.kind).toBe("galds");
    expect(summary.loserIdx).toBe(1);
    expect(zoleGaldsLoserIdx([10, 20, 30], [2, 3, 3])).toBe(2);
  });

  it("galds: vienādi stiķi starp līderiem — zaudē ar vairāk acīm", () => {
    expect(zoleGaldsLoserIdx([40, 50, 10], [2, 2, 4])).toBe(2);
    expect(zoleGaldsLoserIdx([10, 50, 30], [2, 2, 2])).toBe(1);
  });

  it("maza_zole: uzvara +12 lielajam, −6 katram mazajam", () => {
    const { delta, summary } = zoleComputeTableDeltas(
      "maza_zole",
      0,
      [65, 10, 15],
      [5, 2, 1]
    );
    expect(summary.win).toBe(true);
    expect(delta[0]).toBe(12);
    expect(delta[1]).toBe(-6);
    expect(delta[2]).toBe(-6);
  });

  it("maza_zole: zaudējums −14 lielajam, +7 katram mazajam", () => {
    const { delta, summary } = zoleComputeTableDeltas(
      "maza_zole",
      0,
      [40, 30, 30],
      [2, 3, 3]
    );
    expect(summary.win).toBe(false);
    expect(delta[0]).toBe(-14);
    expect(delta[1]).toBe(7);
    expect(delta[2]).toBe(7);
  });
});

describe("zoleTeamEyesFromLastResult", () => {
  it("big/zole/maza_zole: lielais vs mazie kopā", () => {
    const s = {
      kind: "big",
      contractorIdx: 1,
      eyes: [20, 55, 15],
      win: true,
    };
    const t = zoleTeamEyesFromLastResult(s);
    expect(t).toEqual({
      kind: "big",
      contractorIdx: 1,
      bigEyes: 55,
      smallEyes: 35,
      margin: 20,
    });
  });

  it("galdins: zaudētājs vs uzvarētāji kopā", () => {
    const s = {
      kind: "galdins",
      loserIdx: 2,
      eyes: [22, 24, 18],
    };
    const t = zoleTeamEyesFromLastResult(s);
    expect(t).toEqual({
      kind: "galdins",
      loserIdx: 2,
      loserEyes: 18,
      winnersEyes: 46,
      margin: 28,
    });
  });

  it("galdins tie: nav komandas skatījuma", () => {
    expect(zoleTeamEyesFromLastResult({ kind: "galdins", tie: true, eyes: [1, 1, 1] })).toBeNull();
  });
});
