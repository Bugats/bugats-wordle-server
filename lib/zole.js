/**
 * Latvijas zole (3 spēlētāji, 26 kārtis) — pēc zolei.lv / Vikipēdijas kartējuma.
 * Masti (indeksi): 0 ♣ kreicis, 1 ♦ kāravs, 2 ♥ ercens, 3 ♠ pīķis.
 * Garš trumpju masts (kāravi): ♦ — 8 kārtis (7–A); pārējie 3 masti pa 6 (9–A, + D/J).
 * Trumpji: visas dāmas un kalpi; tad pārējās ♦ kāravas kārtis.
 * Lielais: ņem 2 vidus kārtis, norok 2, tās pieskaita viņa acīm; zole: vidus kārtis mazo pusē.
 */
export const ZOLE_BOT_1 = "ZoleBot1";
export const ZOLE_BOT_2 = "ZoleBot2";

/** Garā „kārava” (♦): pārējās netrumpja kārtis šajā mastā ir trumpji */
export const ZOLE_SUIT_KARAVS = 1;

export function isZoleBotUsername(name) {
  const n = String(name || "");
  return n === ZOLE_BOT_1 || n === ZOLE_BOT_2;
}

const RANK_A = 14;
const RANK_10 = 10;
const RANK_K = 13;
const RANK_Q = 12;
const RANK_J = 11;
const RANK_9 = 9;
const RANK_8 = 8;
const RANK_7 = 7;

/** Dāmu/kalpu stipruma secība: kreicis ♣, pīķis ♠, ercens ♥, kāravs ♦ */
const TRUMP_FACE_ORDER = [0, 3, 2, 1];

function trumpFaceStrength(suit) {
  const idx = TRUMP_FACE_ORDER.indexOf(suit);
  return idx >= 0 ? idx : 9;
}

/** Acis (zolei.lv) */
export function zoleCardEyes(card) {
  if (!card || typeof card.r !== "number") return 0;
  switch (card.r) {
    case RANK_A:
      return 11;
    case RANK_10:
      return 10;
    case RANK_K:
      return 4;
    case RANK_Q:
      return 3;
    case RANK_J:
      return 2;
    default:
      return 0;
  }
}

/** Vai kārta ir trumpis (dāma, kalps, vai ♦ kāravas „parastās” kārtis) */
export function zoleIsTrump(card) {
  if (!card) return false;
  if (card.r === RANK_Q || card.r === RANK_J) return true;
  if (card.s === ZOLE_SUIT_KARAVS) return true;
  return false;
}

/** Spēles stiprums stiķa salīdzināšanai (lielāks = stiprāks) */
export function zoleCardTrickStrength(card) {
  if (!card) return -1;
  if (card.r === RANK_Q) {
    return 4000 - trumpFaceStrength(card.s);
  }
  if (card.r === RANK_J) {
    return 3000 - trumpFaceStrength(card.s);
  }
  if (card.s === ZOLE_SUIT_KARAVS) {
    const karRank = [RANK_7, RANK_8, RANK_9, RANK_K, RANK_10, RANK_A].indexOf(
      card.r
    );
    return 2000 + (karRank >= 0 ? karRank : 0);
  }
  const plain = [RANK_9, RANK_K, RANK_10, RANK_A].indexOf(card.r);
  return plain >= 0 ? plain : 0;
}

/**
 * Rokas kārtošana: vispirms parastās kārtis pēc mastiem (♣, ♠, ♥), katrā mastā 9→K→10→A;
 * tad trumpji augošā spēka secībā (vājākās pa kreisi).
 */
export function sortZoleHand(hand) {
  if (!hand || !hand.length) return [];
  const PLAIN_SUIT_ORDER = [0, 3, 2];
  function plainSuitKey(s) {
    const i = PLAIN_SUIT_ORDER.indexOf(s);
    return i >= 0 ? i : 99;
  }
  function plainRankKey(r) {
    const order = [RANK_9, RANK_K, RANK_10, RANK_A];
    const i = order.indexOf(r);
    return i >= 0 ? i : 99;
  }
  return hand.slice().sort((a, b) => {
    const ta = zoleIsTrump(a);
    const tb = zoleIsTrump(b);
    if (ta !== tb) return ta ? 1 : -1;
    if (!ta) {
      const ds = plainSuitKey(a.s) - plainSuitKey(b.s);
      if (ds !== 0) return ds;
      return plainRankKey(a.r) - plainRankKey(b.r);
    }
    return zoleCardTrickStrength(a) - zoleCardTrickStrength(b);
  });
}

export function createZoleDeck() {
  const deck = [];
  const plainRanks = [RANK_A, RANK_10, RANK_K, RANK_Q, RANK_J, RANK_9];
  const karavsRanks = [RANK_A, RANK_10, RANK_K, RANK_Q, RANK_J, RANK_9, RANK_8, RANK_7];
  for (let s = 0; s < 4; s++) {
    const ranks = s === ZOLE_SUIT_KARAVS ? karavsRanks : plainRanks;
    for (const r of ranks) {
      deck.push({ s, r });
    }
  }
  return deck;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cardKey(c) {
  return `${c.s}:${c.r}`;
}

function findCardInHand(hand, card) {
  const want = cardKey(card);
  return hand.findIndex((c) => cardKey(c) === want);
}

/**
 * Lācis no pirkuma: pirmā „parastā” (ne D/J) kārava vai pirmais ne-D/J masts.
 */
function trumpSuitFromKitty(kitty) {
  for (const c of kitty) {
    if (c.s === ZOLE_SUIT_KARAVS && c.r !== RANK_Q && c.r !== RANK_J) return c.s;
  }
  for (const c of kitty) {
    if (c.r !== RANK_Q && c.r !== RANK_J) return c.s;
  }
  return ZOLE_SUIT_KARAVS;
}

/**
 * Sekšana: ja vada parastā kārta — jāspēlē tas pats masts (D/J ir tā masta kārtis).
 * Ja vada trumpis — jāspēlē jebkurš trumpis, ja ir; ja nav — tikai parastās kārtas (atmesties).
 */
export function zoleLegalPlays(hand, trick) {
  if (!hand.length) return [];
  if (!trick.length) return hand.slice();
  const lead = trick[0].card;
  if (zoleIsTrump(lead)) {
    const trumps = hand.filter((c) => zoleIsTrump(c));
    if (trumps.length) return trumps;
    return hand.filter((c) => !zoleIsTrump(c));
  }
  const leadSuit = lead.s;
  const suitCards = hand.filter((c) => c.s === leadSuit);
  if (suitCards.length) return suitCards;
  return hand.slice();
}

export function zoleTrickWinner(trick) {
  if (trick.length !== 3) return null;
  const leadSuit = trick[0].card.s;
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < 3; i++) {
    const { playerIdx, card } = trick[i];
    const trump = zoleIsTrump(card);
    const followsLead = card.s === leadSuit;
    let tier;
    let sub;
    if (trump) {
      tier = 2;
      sub = zoleCardTrickStrength(card);
    } else if (followsLead) {
      tier = 1;
      sub = zoleCardTrickStrength(card);
    } else {
      tier = 0;
      sub = 0;
    }
    const score = tier * 5000 + sub;
    if (score > bestScore) {
      bestScore = score;
      best = playerIdx;
    }
  }
  return best;
}

function emptyStateBase(players) {
  return {
    players: players.slice(),
    hands: [[], [], []],
    kitty: [],
    /** pēc norakšanas — lielā noraktās (acis pieskaita lielajam) */
    buried: [],
    trumpSuit: ZOLE_SUIT_KARAVS,
    trick: [],
    trickLeader: 0,
    turn: 0,
    phase: "bid",
    bidTurn: 0,
    contractorIdx: null,
    contract: null,
    eyePoints: [0, 0, 0],
    tricksWon: [0, 0, 0],
    tricksPlayed: 0,
    tableDelta: [0, 0, 0],
    lastResult: null,
    winnerUsername: null,
    winnerIdx: null,
    kittyEyesToOpponents: 0,
    /** 1 = pirmā likšanas kārta (var pieteikt galdiņu); 2 = otrā; pēc divām pilnām pasēšanām → galds */
    bidRound: 1,
  };
}

function dealHands(state) {
  const deck = shuffle(createZoleDeck());
  state.hands = [deck.slice(0, 8), deck.slice(8, 16), deck.slice(16, 24)];
  state.kitty = deck.slice(24, 26);
  state.trumpSuit = trumpSuitFromKitty(state.kitty);
}

export function createZoleVsBotState(humanUsername) {
  const players = [humanUsername, ZOLE_BOT_1, ZOLE_BOT_2];
  const state = emptyStateBase(players);
  dealHands(state);
  state.bidTurn = 0;
  state.turn = 0;
  return state;
}

export function createZoleOnline2pState(usernameA, usernameB) {
  const players = [usernameA, usernameB, ZOLE_BOT_2];
  const state = emptyStateBase(players);
  dealHands(state);
  state.bidTurn = 0;
  state.turn = 0;
  return state;
}

export function createZoleOnline3pState(usernameA, usernameB, usernameC) {
  const players = [usernameA, usernameB, usernameC];
  const state = emptyStateBase(players);
  dealHands(state);
  state.bidTurn = 0;
  state.turn = 0;
  return state;
}

export function zoleProcessBid(state, playerIdx, bid) {
  if (state.phase !== "bid") return { ok: false, error: "Nav likšanas fāzes." };
  if (playerIdx !== state.bidTurn)
    return { ok: false, error: "Nav tavas likšanas kārtas." };

  const b = String(bid || "pass").toLowerCase();
  const bidRound = state.bidRound ?? 1;
  if (b === "pass") {
    state.bidTurn = (state.bidTurn + 1) % 3;
    if (state.bidTurn === 0 && state.contractorIdx == null) {
      if (bidRound === 1) {
        state.bidRound = 2;
      } else {
        state.phase = "play";
        state.contract = "galds";
        state.contractorIdx = null;
        state.turn = 0;
        state.trickLeader = 0;
        state.kittyEyesToOpponents = 0;
      }
    }
    return { ok: true, state };
  }

  if (b === "galdins") {
    if (bidRound !== 1) {
      return {
        ok: false,
        error: "Galdiņu var pieteikt tikai pirmajā likšanas kārtā.",
      };
    }
    state.contract = "galdins";
    state.contractorIdx = null;
    state.phase = "play";
    state.turn = playerIdx;
    state.trickLeader = playerIdx;
    state.trick = [];
    state.kittyEyesToOpponents = 0;
    return { ok: true, state };
  }

  if (b !== "big" && b !== "zole" && b !== "maza_zole") {
    return { ok: false, error: "Nederīga likšana." };
  }

  state.contractorIdx = playerIdx;
  if (b === "big") state.contract = "big";
  else if (b === "zole") state.contract = "zole";
  else state.contract = "maza_zole";

  if (b === "big") {
    const hand = state.hands[playerIdx];
    state.hands[playerIdx] = hand.concat(state.kitty);
    state.kitty = [];
    state.phase = "discard";
    state.turn = playerIdx;
    state.trick = [];
    return { ok: true, state };
  }

  let kEyes = 0;
  for (const c of state.kitty) kEyes += zoleCardEyes(c);
  state.kittyEyesToOpponents = kEyes;
  state.kitty = [];

  state.phase = "play";
  state.turn = playerIdx;
  state.trickLeader = playerIdx;
  state.trick = [];
  return { ok: true, state };
}

/** Lielais norok 2 kārtis; tās pieskaita viņa acīm pie izspēles beigām */
export function zoleApplyDiscard(state, contractorIdx, cardA, cardB) {
  if (state.phase !== "discard")
    return { ok: false, error: "Nav norakšanas fāzes." };
  if (contractorIdx !== state.contractorIdx)
    return { ok: false, error: "Tikai lielais var norakt." };
  const hand = state.hands[contractorIdx];
  const i1 = findCardInHand(hand, cardA);
  const i2 = findCardInHand(hand, cardB);
  if (i1 < 0 || i2 < 0 || i1 === i2)
    return { ok: false, error: "Izvēlies divas dažādas kārtas rokā." };
  const c1 = hand.splice(i1, 1)[0];
  const i2b = findCardInHand(hand, cardB);
  if (i2b < 0) return { ok: false, error: "Kārta nav rokā." };
  const c2 = hand.splice(i2b, 1)[0];
  state.buried = [c1, c2];
  state.phase = "play";
  state.turn = contractorIdx;
  state.trickLeader = contractorIdx;
  state.trick = [];
  return { ok: true, state };
}

function otherIndices(idx) {
  return [0, 1, 2].filter((i) => i !== idx);
}

/** Galds: zaudē tas, kam visvairāk stiķu; ja vienādi — tam, kam vairāk acu stiķos */
export function zoleGaldsLoserIdx(eyes, tricks) {
  const maxT = Math.max(tricks[0], tricks[1], tricks[2]);
  const hi = [];
  for (let i = 0; i < 3; i++) {
    if (tricks[i] === maxT) hi.push(i);
  }
  if (hi.length === 1) return hi[0];
  let loser = hi[0];
  let maxE = eyes[loser];
  for (let k = 1; k < hi.length; k++) {
    const i = hi[k];
    if (eyes[i] > maxE) {
      maxE = eyes[i];
      loser = i;
    }
  }
  return loser;
}

export function zoleComputeTableDeltas(contract, contractorIdx, eyes, tricks) {
  const delta = [0, 0, 0];
  const opp = otherIndices(contractorIdx);
  const [a, b] = opp;
  const contrEyes = eyes[contractorIdx];
  const oppEyes = eyes[a] + eyes[b];
  const contrTricks = tricks[contractorIdx];
  const oppTricks = tricks[a] + tricks[b];

  const contrWins = contrEyes >= 61;

  if (contract === "galdins") {
    let maxE = -1;
    let losers = [];
    for (let i = 0; i < 3; i++) {
      if (eyes[i] > maxE) {
        maxE = eyes[i];
        losers = [i];
      } else if (eyes[i] === maxE) losers.push(i);
    }
    if (losers.length === 3)
      return { delta, summary: { kind: "galdins", tie: true } };
    const loserIdx = losers[0];
    const winners = [0, 1, 2].filter((i) => i !== loserIdx);
    const loserTricks = tricks[loserIdx];
    const loserEyes = eyes[loserIdx];
    let pay = 1;
    if (loserTricks === 0) pay = 3;
    else if (loserEyes <= 30) pay = 2;
    delta[loserIdx] -= pay * winners.length;
    for (const w of winners) delta[w] += pay;
    return {
      delta,
      summary: {
        kind: "galdins",
        loserIdx,
        payEach: pay,
        /** Galdiņš: zaudētājam bez stiķa → 3 p. katram uzvarētājam */
        loserNoTricks: loserTricks === 0,
        eyes,
        tricks,
      },
    };
  }

  if (contract === "galds") {
    const loserIdx = zoleGaldsLoserIdx(eyes, tricks);
    const winners = [0, 1, 2].filter((i) => i !== loserIdx);
    const loserTricks = tricks[loserIdx];
    const loserEyes = eyes[loserIdx];
    let pay = 1;
    if (loserTricks === 0) pay = 3;
    else if (loserEyes <= 30) pay = 2;
    delta[loserIdx] -= pay * winners.length;
    for (const w of winners) delta[w] += pay;
    return {
      delta,
      summary: {
        kind: "galds",
        loserIdx,
        payEach: pay,
        loserNoTricks: loserTricks === 0,
        eyes,
        tricks,
      },
    };
  }

  if (contract === "maza_zole") {
    if (contrWins) {
      delta[contractorIdx] += 12;
      delta[a] -= 6;
      delta[b] -= 6;
      return {
        delta,
        summary: {
          kind: "maza_zole",
          win: true,
          contractorIdx,
          eyes,
          tricks,
        },
      };
    }
    delta[contractorIdx] -= 12;
    delta[a] += 6;
    delta[b] += 6;
    return {
      delta,
      summary: {
        kind: "maza_zole",
        win: false,
        contractorIdx,
        eyes,
        tricks,
      },
    };
  }

  if (contract === "zole") {
    if (contrWins) {
      let fromEach = 5;
      if (contrTricks === 8) fromEach = 7;
      else if (contrEyes >= 91) fromEach = 6;
      delta[contractorIdx] += fromEach * 2;
      delta[a] -= fromEach;
      delta[b] -= fromEach;
      return {
        delta,
        summary: {
          kind: "zole",
          win: true,
          tier: fromEach,
          contractorIdx,
          allTricks: contrTricks === 8,
          eyes,
          tricks,
        },
      };
    }
    let toEach = 6;
    if (contrTricks === 0) toEach = 8;
    else if (contrEyes < 31) toEach = 7;
    delta[contractorIdx] -= toEach * 2;
    delta[a] += toEach;
    delta[b] += toEach;
    return {
      delta,
      summary: {
        kind: "zole",
        win: false,
        tier: toEach,
        contractorIdx,
        contractorNoTricks: contrTricks === 0,
        eyes,
        tricks,
      },
    };
  }

  if (contract === "big") {
    if (contrWins) {
      let fromEach = 1;
      if (oppTricks === 0) fromEach = 3;
      else if (oppEyes < 30) fromEach = 2;
      delta[contractorIdx] += fromEach * 2;
      delta[a] -= fromEach;
      delta[b] -= fromEach;
      return {
        delta,
        summary: {
          kind: "big",
          win: true,
          tier: fromEach,
          contractorIdx,
          contrEyes,
          oppEyes,
          /** Mazajiem kopā bez stiķa → 3 p. no katra */
          opponentsNoTricks: oppTricks === 0,
          tricks,
        },
      };
    }
    let toEach = 2;
    if (contrTricks === 0) toEach = 4;
    else if (contrEyes < 31) toEach = 3;
    delta[contractorIdx] -= toEach * 2;
    delta[a] += toEach;
    delta[b] += toEach;
    return {
      delta,
      summary: {
        kind: "big",
        win: false,
        tier: toEach,
        contractorIdx,
        contrEyes,
        oppEyes,
        contractorNoTricks: contrTricks === 0,
        tricks,
      },
    };
  }

  return { delta, summary: { kind: "unknown" } };
}

function finishHand(state) {
  const contract = state.contract || "galdins";
  const contractorIdx = state.contractorIdx ?? 0;
  const eyes = state.eyePoints.slice();
  const tricks = state.tricksWon.slice();

  const contractorForDelta =
    contract === "galdins" || contract === "galds" ? 0 : contractorIdx;

  if (contract === "big" && state.contractorIdx != null) {
    let be = 0;
    for (const c of state.buried) be += zoleCardEyes(c);
    eyes[state.contractorIdx] += be;
  }

  if (
    (contract === "zole" || contract === "maza_zole") &&
    state.contractorIdx != null &&
    state.kittyEyesToOpponents > 0
  ) {
    const opp = otherIndices(state.contractorIdx);
    const half = state.kittyEyesToOpponents / 2;
    const e0 = Math.floor(half);
    const e1 = state.kittyEyesToOpponents - e0;
    eyes[opp[0]] += e0;
    eyes[opp[1]] += e1;
  }

  const { delta, summary } = zoleComputeTableDeltas(
    contract,
    contractorForDelta,
    eyes,
    tricks
  );
  state.tableDelta = delta;
  state.lastResult = summary;
  state.phase = "end";

  let best = 0;
  for (let i = 1; i < 3; i++) {
    if (state.tableDelta[i] > state.tableDelta[best]) best = i;
  }
  state.winnerIdx = best;
  state.winnerUsername = state.players[best];
}

export function zolePlayCard(state, playerIdx, card) {
  if (state.phase === "bid") {
    return { ok: false, error: "Vispirms jāpasē vai jāpieteic spēle." };
  }
  if (state.phase === "discard") {
    return { ok: false, error: "Lielajam vispirms jānorok 2 kārtis." };
  }
  if (state.phase !== "play") return { ok: false, error: "Spēle beigusies." };
  if (playerIdx !== state.turn) return { ok: false, error: "Nav tavas kārtas." };
  const hand = state.hands[playerIdx];
  const idx = findCardInHand(hand, card);
  if (idx < 0) return { ok: false, error: "Kārta nav rokā." };

  const legal = zoleLegalPlays(hand, state.trick);
  if (!legal.some((c) => cardKey(c) === cardKey(card))) {
    return { ok: false, error: "Jāievēro likšanu (masts vai trumpis)." };
  }

  const played = hand.splice(idx, 1)[0];
  state.trick.push({ playerIdx, card: played });

  if (state.trick.length < 3) {
    state.turn = (state.turn + 1) % 3;
    return { ok: true, state };
  }

  const winner = zoleTrickWinner(state.trick);
  let trickEyes = 0;
  for (const t of state.trick) trickEyes += zoleCardEyes(t.card);
  state.eyePoints[winner] += trickEyes;
  state.tricksWon[winner]++;
  state.tricksPlayed++;
  state.trick = [];
  state.turn = winner;
  state.trickLeader = winner;

  if (state.tricksPlayed >= 8) {
    finishHand(state);
  }

  return { ok: true, state };
}

export function zolePickBotBid(state, botIdx) {
  if (state.phase !== "bid" || state.bidTurn !== botIdx) return "pass";
  const hand = state.hands[botIdx];
  let eyes = 0;
  for (const c of hand) eyes += zoleCardEyes(c);
  if (eyes >= 50) return "zole";
  if (eyes >= 38) return "big";
  return "pass";
}

export function zolePickBotDiscard(state, botIdx) {
  const hand = state.hands[botIdx];
  if (hand.length < 10) return null;
  const sorted = hand
    .slice()
    .sort((a, b) => {
      const ta = zoleIsTrump(a);
      const tb = zoleIsTrump(b);
      if (ta !== tb) return ta ? 1 : -1;
      return zoleCardEyes(a) - zoleCardEyes(b);
    });
  return [sorted[0], sorted[1]];
}

export function zolePickBotCard(state, botIdx) {
  const hand = state.hands[botIdx];
  const legal = zoleLegalPlays(hand, state.trick);
  if (!legal.length) return null;
  return legal[Math.floor(Math.random() * legal.length)];
}

/** Secība = suit index 0..3 */
const SUIT_LABELS = ["♣", "♦", "♥", "♠"];

export function zolePublicSnapshot(state, forPlayerIdx) {
  const myHand =
    forPlayerIdx >= 0 && forPlayerIdx < 3
      ? state.hands[forPlayerIdx].slice()
      : [];
  let legalCardKeys = null;
  let legalDiscardKeys = null;

  if (state.phase === "discard" && forPlayerIdx === state.contractorIdx) {
    if (myHand.length >= 2) {
      const keys = [];
      for (let i = 0; i < myHand.length; i++) {
        for (let j = i + 1; j < myHand.length; j++) {
          keys.push(`${cardKey(myHand[i])}|${cardKey(myHand[j])}`);
        }
      }
      legalDiscardKeys = keys;
    }
  }

  if (
    state.phase === "play" &&
    forPlayerIdx === state.turn &&
    myHand.length
  ) {
    const legal = zoleLegalPlays(myHand, state.trick);
    legalCardKeys = legal.map((c) => cardKey(c));
  }

  return {
    trumpSuit: state.trumpSuit,
    trumpLabel: SUIT_LABELS[state.trumpSuit] || "?",
    trumpNote:
      "Trumpji: visas D un J, un ♦ 7–A. Parastās: tikai ♣ ♥ ♠ — A, 10, K, 9.\n\n" +
      "Ja uz galda pirmā kārta ir PARASTĀ — jāatbild ar TO PAŠU MASTU (arī ♥D/♥J, ja vada ♥). " +
      "Ja tā masta nav — vari atmesties: jebkura cita kārta.\n\n" +
      "Ja pirmā kārta ir TRUMPIS — jāliek TRUMPIS, ja rokā ir vismaz viens; ja nav neviena trumpja — tikai parastā kārta (atmesties).",
    turn: state.turn,
    bidTurn: state.bidTurn,
    bidRound: state.bidRound ?? 1,
    phase: state.phase,
    contract: state.contract,
    contractorIdx: state.contractorIdx,
    trickLeader: state.trickLeader,
    trick: state.trick.map((t) => ({
      playerIdx: t.playerIdx,
      card: t.card,
    })),
    eyePoints: state.eyePoints.slice(),
    tricksWon: state.tricksWon.slice(),
    tricksPlayed: state.tricksPlayed,
    handCount: state.hands.map((h) => h.length),
    kittyCount: state.kitty?.length || 0,
    myHand,
    legalCardKeys,
    legalDiscardKeys,
    players: state.players.slice(),
    tableDelta: state.phase === "end" ? state.tableDelta.slice() : null,
    lastResult: state.lastResult || null,
    winnerIdx: state.winnerIdx ?? null,
    winnerUsername: state.winnerUsername ?? null,
  };
}
