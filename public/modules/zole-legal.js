/**
 * Klienta zoles likšanas loģika — jāsakrīt ar lib/zole.js (zoleLegalPlays).
 * Izmanto, lai UI vienmēr atļautu pareizās kārtas pat tad, ja servera snapshot
 * neder legalCardKeys.
 */
(function (global) {
  "use strict";

  const ZOLE_SUIT_KARAVS = 1;
  const RANK_Q = 12;
  const RANK_J = 11;

  function zoleIsTrump(card) {
    if (!card) return false;
    if (card.r === RANK_Q || card.r === RANK_J) return true;
    if (card.s === ZOLE_SUIT_KARAVS) return true;
    return false;
  }

  function zoleLegalPlays(hand, trick) {
    if (!hand.length) return [];
    if (!trick.length) return hand.slice();
    const lead = trick[0].card;
    if (zoleIsTrump(lead)) {
      const trumps = hand.filter((c) => zoleIsTrump(c));
      if (trumps.length) return trumps;
      return hand.filter((c) => !zoleIsTrump(c));
    }
    const leadSuit = lead.s;
    const plainOfSuit = hand.filter(
      (c) => c.s === leadSuit && !zoleIsTrump(c)
    );
    if (plainOfSuit.length) return plainOfSuit;
    const suitFace = hand.filter((c) => c.s === leadSuit);
    if (suitFace.length) return suitFace;
    return hand.slice();
  }

  function zoleCardKey(c) {
    return `${c.s}:${c.r}`;
  }

  global.VZZoleLegal = Object.freeze({
    zoleIsTrump,
    zoleLegalPlays,
    zoleCardKey,
    ZOLE_SUIT_KARAVS,
  });
})(window);
