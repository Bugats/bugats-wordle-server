import { describe, it, expect } from "vitest";
import { createZoleOnline3pState, zolePlayCard } from "../lib/zole.js";

describe("maza_zole — pretinieka stiķis", () => {
  it("beidz partiju uzreiz, kad mazais uzņem stiķi", () => {
    const s = createZoleOnline3pState("A", "B", "C", "test-maza-trick");
    s.phase = "play";
    s.contract = "maza_zole";
    s.contractorIdx = 0;
    s.trickLeader = 0;
    s.turn = 0;
    s.trick = [];
    s.tricksPlayed = 0;
    s.tricksWon = [0, 0, 0];
    s.eyePoints = [0, 0, 0];
    s.kittyEyesToOpponents = 0;
    s.kitty = [];
    s.trumpSuit = 1;
    /* Līderis (lielais 0) spēlē vājāko; mazais 1 uzņem ar stiprāku tajā pašā mastā. */
    s.hands[0] = [{ s: 0, r: 9 }];
    s.hands[1] = [{ s: 0, r: 13 }];
    s.hands[2] = [{ s: 0, r: 10 }];

    expect(zolePlayCard(s, 0, { s: 0, r: 9 }).ok).toBe(true);
    expect(zolePlayCard(s, 1, { s: 0, r: 13 }).ok).toBe(true);
    const fin = zolePlayCard(s, 2, { s: 0, r: 10 });
    expect(fin.ok).toBe(true);
    expect(s.phase).toBe("end");
    expect(s.tricksPlayed).toBe(1);
    expect(s.lastResult?.kind).toBe("maza_zole");
    expect(s.lastResult?.win).toBe(false);
    expect(s.tableDelta[0]).toBe(-14);
    expect(s.tableDelta[1]).toBe(7);
    expect(s.tableDelta[2]).toBe(7);
  });
});
