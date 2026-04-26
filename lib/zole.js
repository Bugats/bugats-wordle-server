import { createHash, randomInt } from "node:crypto";

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
 * Rokas kārtošana: vispirms trumpji dilstošā spēka secībā (stiprākās pa kreisi);
 * tad parastās pēc mastiem (♣, ♠, ♥), katrā mastā stiprākās pa kreisi (A→10→K→9).
 */
export function sortZoleHand(hand) {
  if (!hand || !hand.length) return [];
  const PLAIN_SUIT_ORDER = [0, 3, 2];
  function plainSuitKey(s) {
    const i = PLAIN_SUIT_ORDER.indexOf(s);
    return i >= 0 ? i : 99;
  }
  /** Mazāks = stiprāka parastā kārta (kreisā puse) */
  function plainRankKeyStrongLeft(r) {
    const order = [RANK_A, RANK_10, RANK_K, RANK_9];
    const i = order.indexOf(r);
    return i >= 0 ? i : 99;
  }
  return hand.slice().sort((a, b) => {
    const ta = zoleIsTrump(a);
    const tb = zoleIsTrump(b);
    if (ta !== tb) return ta ? -1 : 1;
    if (ta) {
      return zoleCardTrickStrength(b) - zoleCardTrickStrength(a);
    }
    const ds = plainSuitKey(a.s) - plainSuitKey(b.s);
    if (ds !== 0) return ds;
    return plainRankKeyStrongLeft(a.r) - plainRankKeyStrongLeft(b.r);
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

/**
 * Viens „riffle” (kā uz galda): nejauša pārgriešana, tad sajaukšana pēc
 * Gilbert–Shannon–Reeds modeļa — tas pats statistiskais process, ko lieto
 * īstu kāršu analīzei; katrs solis ar crypto.randomInt.
 */
function riffleInterleaveOnce(deck) {
  const n = deck.length;
  if (n < 2) return deck.slice();
  const split = randomInt(1, n);
  const left = deck.slice(0, split);
  const right = deck.slice(split);
  const out = [];
  while (left.length && right.length) {
    const total = left.length + right.length;
    const pick = randomInt(0, total);
    if (pick < left.length) out.push(left.shift());
    else out.push(right.shift());
  }
  out.push(...left, ...right);
  return out;
}

/** Nejauši griezieni tasī (rotācija), kā pirms dalīšanas uz galda. */
function randomDeckCuts(deck, minCuts, maxCuts) {
  let d = deck.slice();
  const nCuts = randomInt(minCuts, maxCuts + 1);
  for (let i = 0; i < nCuts; i++) {
    if (d.length < 2) break;
    const k = randomInt(0, d.length);
    d = d.slice(k).concat(d.slice(0, k));
  }
  return d;
}

/**
 * Pirms nejaušās maisīšanas — katram mačam / partijai unikāls sākuma sajaukums,
 * lai vienlaicīgi atvērtās istabas (pat ar vienādu PRNG plūsmu) neiegūtu
 * identisku kavu izkārtojumu.
 */
function entangleDeckWithRoomSeed(deck, gameId, handNumber) {
  if (!gameId) return deck.slice();
  const h = createHash("sha256");
  h.update("zole-deal-v1\0");
  h.update(String(gameId), "utf8");
  h.update("\0");
  h.update(String(handNumber), "utf8");
  const buf = h.digest();
  const a = deck.slice();
  const n = a.length;
  for (let i = 0; i < n; i++) {
    const j =
      (buf[i % 32] +
        buf[(i + 13) % 32] * 256 +
        buf[(i + 29) % 32]) %
      n;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * „Dabiskas” kāršu maisīšanas sajūta: vairāki riffle + griezieni.
 * Pēc ~7–9 riffle izkārtojums ir tuvu pilnīgi nejaušam (neuzminams), bet
 * process atgādina īstu maisīšanu, ne programmatisku „teleportāciju”.
 */
function shuffleDeckNatural(deck, gameId, handNumber) {
  let d = entangleDeckWithRoomSeed(deck, gameId, handNumber);
  d = randomDeckCuts(d, 1, 3);
  const passes = randomInt(7, 10);
  for (let i = 0; i < passes; i++) {
    d = riffleInterleaveOnce(d);
  }
  d = randomDeckCuts(d, 0, 2);
  return d;
}

export function cardKey(c) {
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
 * Sekšana: ja vada parastā kārta — vispirms jāspēlē parastā tā paša masta kārta (9,K,10,A),
 * ja tāda ir. Ja parastā šī masta nav — drīkst atmesties (jebkuru citu mastu) vai pēc izvēles
 * pārsist ar trumpi (t.sk. vadības masta D/J). Ja vada trumpis — jāspēlē trumpis, ja ir; ja nav — parastā.
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
  const plainOfSuit = hand.filter(
    (c) => c.s === leadSuit && !zoleIsTrump(c)
  );
  if (plainOfSuit.length) return plainOfSuit;
  return hand.slice();
}

export function zoleTrickWinner(trick) {
  if (trick.length !== 3) return null;
  const leadCard = trick[0].card;
  const leadSuit = leadCard.s;
  const leadIsTrump = zoleIsTrump(leadCard);
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < 3; i++) {
    const { playerIdx, card } = trick[i];
    const trump = zoleIsTrump(card);
    /**
     * Pēc dāmas/kalpa vai kā cita trumpa vadības parastā kārte tajā pašā fiziskajā mastā
     * (piem. 9♣ pēc D♣) ir atmestā, ne “sekošana” — citādi tā pārāk stipri uzvar pār citu mastu
     * atmestajām. Seko parastajam vadam tikai: vadītājs ir parasts, spēlētājs ir parasts, tas pats masts.
     */
    const followsPlainLead =
      !leadIsTrump && !trump && card.s === leadSuit;
    let tier;
    let sub;
    if (trump) {
      tier = 2;
      sub = zoleCardTrickStrength(card);
    } else if (followsPlainLead) {
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
    /** 1 = pirmā likšanas kārta; 2 = otrā; pēc divām pilnām «garām» kārtām → Galdiņš (automātiski) */
    bidRound: 1,
    /** Pēc pabeigta stiķa — 3 kārtas + uzvarētājs + stiķa acis (UI) */
    lastCompletedTrick: null,
    /** Acis uz pašreizējā nepilnā stiķa */
    currentTrickEyes: 0,
    /** Vs bot / sērija: uzkrātā tabula pa partijām */
    cumulativeTableDelta: [0, 0, 0],
    /** Likšana sākas no šī indeksa (0..2), pēc katra apļa +1 mod 3 */
    firstBidderOffset: 0,
    /** Pabeigtās partijas skaits šajā mačā (pēc pirmās = 1) */
    matchHandsPlayed: 0,
    /** Pēdējo līdz 3 pabeigto partiju tabulas punkti [[p0,p1,p2], ...] — vecākā pirmā */
    completedTableDeltas: [],
    /** Vs bot: pēc «Pēdējā partija» — nākamā izspēle ir pēdējā, tad mačs beidzas */
    zoleLastMatchHand: false,
    /** Online mača id — maisīšanai, lai paralēlās istabas neiegūtu vienādu kavu secību */
    zoleShuffleGameId: null,
  };
}

function dealHands(state) {
  const gameId = state.zoleShuffleGameId;
  const handNo = (state.matchHandsPlayed || 0) + 1;
  const deck = shuffleDeckNatural(createZoleDeck(), gameId, handNo);
  state.hands = [deck.slice(0, 8), deck.slice(8, 16), deck.slice(16, 24)];
  state.kitty = deck.slice(24, 26);
  state.trumpSuit = trumpSuitFromKitty(state.kitty);
  state.lastCompletedTrick = null;
  state.currentTrickEyes = 0;
}

export function createZoleVsBotState(humanUsername, gameId = null) {
  const players = [humanUsername, ZOLE_BOT_1, ZOLE_BOT_2];
  const state = emptyStateBase(players);
  state.zoleShuffleGameId = gameId;
  dealHands(state);
  state.firstBidderOffset = 0;
  state.bidTurn = state.firstBidderOffset;
  state.turn = state.bidTurn;
  return state;
}

export function createZoleOnline2pState(usernameA, usernameB, gameId = null) {
  const players = [usernameA, usernameB, ZOLE_BOT_2];
  const state = emptyStateBase(players);
  state.zoleShuffleGameId = gameId;
  dealHands(state);
  state.firstBidderOffset = 0;
  state.bidTurn = state.firstBidderOffset;
  state.turn = state.bidTurn;
  return state;
}

export function createZoleOnline3pState(
  usernameA,
  usernameB,
  usernameC,
  gameId = null
) {
  const players = [usernameA, usernameB, usernameC];
  const state = emptyStateBase(players);
  state.zoleShuffleGameId = gameId;
  dealHands(state);
  state.firstBidderOffset = 0;
  state.bidTurn = state.firstBidderOffset;
  state.turn = state.bidTurn;
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
        /* Otrā kārta visi iet garām → Galdiņš (nav «Galds») */
        state.phase = "play";
        state.contract = "galdins";
        state.contractorIdx = null;
        state.turn = 0;
        state.trickLeader = 0;
        state.trick = [];
        state.kittyEyesToOpponents = 0;
      }
    }
    return { ok: true, state };
  }

  if (b === "galdins") {
    return {
      ok: false,
      error:
        "Galdiņu nepieteic atsevišķi — ja 1. un 2. kārtā visi iet garām, tas sākas pats.",
    };
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
    /* Zaudējums: -14 lielajam, +7 katram mazajam (tabula «Zoles punkti») */
    delta[contractorIdx] -= 14;
    delta[a] += 7;
    delta[b] += 7;
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

/**
 * Partijas kopsavilkumam: acis no noraktajām (lielais) un no vidus kārtīm (zole / mazā zole).
 * Modificē `summary` uz vietas.
 */
/**
 * Partijas beigu UI: lielā vs mazo kāršu acis (pēc `finishHand` — ar noraktu un vidu).
 * Galdiņam/galdam: zaudētājs pret pārējo divu summu.
 */
export function zoleTeamEyesFromLastResult(summary) {
  if (!summary || typeof summary !== "object") return null;
  if (!Array.isArray(summary.eyes) || summary.eyes.length !== 3) return null;
  const eyes = summary.eyes.map((n) =>
    Number.isFinite(Number(n)) ? Number(n) : 0
  );
  const k = summary.kind;
  if (k === "big" || k === "zole" || k === "maza_zole") {
    const cidx = summary.contractorIdx;
    if (typeof cidx !== "number" || cidx < 0 || cidx > 2) return null;
    const opp = [0, 1, 2].filter((i) => i !== cidx);
    const bigEyes = eyes[cidx];
    const smallEyes = eyes[opp[0]] + eyes[opp[1]];
    return {
      kind: k,
      contractorIdx: cidx,
      bigEyes,
      smallEyes,
      margin: bigEyes - smallEyes,
    };
  }
  if (k === "galdins" && summary.tie) return null;
  if (k === "galdins" || k === "galds") {
    const li = summary.loserIdx;
    if (typeof li !== "number" || li < 0 || li > 2) return null;
    const winners = [0, 1, 2].filter((i) => i !== li);
    const loserEyes = eyes[li];
    const winnersEyes = eyes[winners[0]] + eyes[winners[1]];
    return {
      kind: k,
      loserIdx: li,
      loserEyes,
      winnersEyes,
      margin: winnersEyes - loserEyes,
    };
  }
  return null;
}

export function zoleAugmentLastResultEyeMeta(
  summary,
  contract,
  buriedCards,
  kittyEyesToOpponents
) {
  if (!summary || typeof summary !== "object") return summary;
  const c = String(contract || "").toLowerCase();
  if (
    c === "big" &&
    Array.isArray(buriedCards) &&
    buriedCards.length === 2
  ) {
    let be = 0;
    for (const card of buriedCards) be += zoleCardEyes(card);
    summary.buriedEyesTotal = be;
  }
  const kE = Number(kittyEyesToOpponents) || 0;
  if ((c === "zole" || c === "maza_zole") && kE > 0) {
    summary.kittyEyesToOpponents = kE;
  }
  return summary;
}

export function zoleStartNextHand(state) {
  if (!state || state.phase !== "end")
    return { ok: false, error: "Nav partijas beigu fāzes." };
  if ((state.matchHandsPlayed || 0) > 0) {
    const prev = (state.tableDelta || [0, 0, 0]).map((n) =>
      Number.isFinite(Number(n)) ? Number(n) : 0
    );
    if (!Array.isArray(state.completedTableDeltas)) state.completedTableDeltas = [];
    state.completedTableDeltas.push([prev[0], prev[1], prev[2]]);
    while (state.completedTableDeltas.length > 3) state.completedTableDeltas.shift();
  }
  state.firstBidderOffset = ((state.firstBidderOffset ?? 0) + 1) % 3;
  dealHands(state);
  state.phase = "bid";
  state.bidRound = 1;
  state.bidTurn = state.firstBidderOffset;
  state.turn = state.bidTurn;
  state.contractorIdx = null;
  state.contract = null;
  state.trick = [];
  state.trickLeader = state.bidTurn;
  state.buried = [];
  state.eyePoints = [0, 0, 0];
  state.tricksWon = [0, 0, 0];
  state.tricksPlayed = 0;
  state.tableDelta = [0, 0, 0];
  state.lastResult = null;
  state.winnerIdx = null;
  state.winnerUsername = null;
  state.kittyEyesToOpponents = 0;
  state.lastCompletedTrick = null;
  state.currentTrickEyes = 0;
  return { ok: true, state };
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
  if (
    contract === "maza_zole" &&
    summary &&
    summary.kind === "maza_zole" &&
    !summary.win &&
    state.tricksPlayed < 8
  ) {
    summary.earlyOpponentTrick = true;
  }
  state.tableDelta = delta;
  for (let i = 0; i < 3; i++) {
    state.cumulativeTableDelta[i] =
      (state.cumulativeTableDelta[i] || 0) + (delta[i] || 0);
  }
  state.lastResult = summary;
  zoleAugmentLastResultEyeMeta(
    summary,
    contract,
    state.buried,
    state.kittyEyesToOpponents
  );
  state.phase = "end";

  let best = 0;
  for (let i = 1; i < 3; i++) {
    if (state.tableDelta[i] > state.tableDelta[best]) best = i;
  }
  state.winnerIdx = best;
  state.winnerUsername = state.players[best];
  state.matchHandsPlayed = (state.matchHandsPlayed || 0) + 1;
}

export function zolePlayCard(state, playerIdx, card) {
  if (state.phase === "bid") {
    return { ok: false, error: "Vispirms jāiet garām vai jāpieteic spēle." };
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
  state.currentTrickEyes = 0;
  for (const t of state.trick) state.currentTrickEyes += zoleCardEyes(t.card);
  if (state.trick.length === 1) state.lastCompletedTrick = null;

  if (state.trick.length < 3) {
    state.turn = (state.turn + 1) % 3;
    return { ok: true, state };
  }

  const winner = zoleTrickWinner(state.trick);
  let trickEyes = 0;
  for (const t of state.trick) trickEyes += zoleCardEyes(t.card);
  const completedLeader = state.trickLeader;
  state.lastCompletedTrick = {
    leaderIdx: completedLeader,
    cards: state.trick.map((t) => ({
      playerIdx: t.playerIdx,
      card: t.card,
    })),
    winnerIdx: winner,
    trickEyes,
  };
  state.eyePoints[winner] += trickEyes;
  state.tricksWon[winner]++;
  state.tricksPlayed++;
  state.trick = [];
  state.currentTrickEyes = 0;
  state.turn = winner;
  state.trickLeader = winner;

  const c = state.contract;
  if (
    c === "maza_zole" &&
    state.contractorIdx != null &&
    winner !== state.contractorIdx
  ) {
    /* Mazā zole: viens pretinieka stiķis «salauž» līgumu — partija beidzas uzreiz. */
    finishHand(state);
    return { ok: true, state };
  }

  if (state.tricksPlayed >= 8) {
    finishHand(state);
  }

  return { ok: true, state };
}

function zoleBotTrumpCount(hand) {
  let n = 0;
  for (const c of hand || []) if (zoleIsTrump(c)) n++;
  return n;
}

/** Aptuvena rokas stiprība likšanai (acis + trumpu svars). */
function zoleBotHandStrength(hand) {
  let eyes = 0;
  for (const c of hand || []) eyes += zoleCardEyes(c);
  const tr = zoleBotTrumpCount(hand);
  return eyes + tr * 5;
}

/**
 * Likšana: eiriskas sliekšņi pēc grūtības; ņem vērā trumpju skaitu un kārtu.
 * @param {"easy"|"medium"|"hard"} difficulty
 */
export function zolePickBotBid(state, botIdx, difficulty = "medium") {
  if (state.phase !== "bid" || state.bidTurn !== botIdx) return "pass";
  const hand = state.hands[botIdx];
  const str = zoleBotHandStrength(hand);
  const tr = zoleBotTrumpCount(hand);
  const eyesPlain = hand.reduce((s, c) => s + zoleCardEyes(c), 0);

  const tier =
    difficulty === "hard" ? 1 : difficulty === "easy" ? -1 : 0;
  const zoleNeed = 50 - tier * 4;
  const bigNeed = 38 - tier * 3;
  const mazaNeed = 46 - tier * 2;

  if (str >= zoleNeed && tr >= 4) return "zole";
  if (str >= bigNeed && tr >= 2) return "big";
  if (str >= mazaNeed && tr >= 5 && eyesPlain >= 28) return "maza_zole";
  if (difficulty === "hard" && str >= bigNeed - 2 && tr >= 3) return "big";
  if (difficulty === "easy" && str >= zoleNeed + 6) return "zole";
  return "pass";
}

/**
 * Norakšana: vājākās parastās kārtis, īsākie masti; trūkstot — vājākie trumpji.
 * @param {"easy"|"medium"|"hard"} difficulty
 */
export function zolePickBotDiscard(state, botIdx, difficulty = "medium") {
  const hand = state.hands[botIdx];
  if (hand.length < 10) return null;

  const plain = hand.filter((c) => !zoleIsTrump(c));
  const trumps = hand.filter((c) => zoleIsTrump(c));

  function plainSuitCount(s) {
    return plain.filter((c) => c.s === s).length;
  }

  /** Augstāks = labāk norakt (mazāk sāpīgi zaudēt struktūru). */
  function plainBuryPriority(card) {
    const cnt = plainSuitCount(card.s);
    let p = zoleCardEyes(card) * 8;
    if (cnt <= 1) p -= 35;
    if (cnt >= 5) p += 25;
    if (difficulty === "hard" && zoleCardEyes(card) >= 10) p -= 15;
    if (difficulty === "easy" && cnt >= 4) p -= 10;
    return p;
  }

  const plainSorted = plain.slice().sort((a, b) => plainBuryPriority(a) - plainBuryPriority(b));

  if (plainSorted.length >= 2) {
    return [plainSorted[0], plainSorted[1]];
  }
  if (plainSorted.length === 1) {
    const ts = trumps
      .slice()
      .sort((a, b) => zoleCardTrickStrength(a) - zoleCardTrickStrength(b));
    if (ts.length) return [plainSorted[0], ts[0]];
  }
  const ts = trumps
    .slice()
    .sort((a, b) => zoleCardTrickStrength(a) - zoleCardTrickStrength(b));
  if (ts.length >= 2) return [ts[0], ts[1]];
  return null;
}

/** Uzvarētājs pēc 3 kārtām, ja pirmās divas jau uz galda un `third` spēlē `card`. */
function zoleBotWinnerIfThirdPlays(trickTwo, thirdPlayerIdx, card) {
  if (trickTwo.length !== 2) return null;
  const full = [
    { playerIdx: trickTwo[0].playerIdx, card: trickTwo[0].card },
    { playerIdx: trickTwo[1].playerIdx, card: trickTwo[1].card },
    { playerIdx: thirdPlayerIdx, card },
  ];
  return zoleTrickWinner(full);
}

/** Uzvarētājs pēc 2 kārtām (vadītājs + šī gājiena kārta), trešais vēl nav licis. */
function zoleBotWinnerIfSecondPlays(trickOne, secondPlayerIdx, card) {
  if (trickOne.length !== 1) return null;
  const full = [
    { playerIdx: trickOne[0].playerIdx, card: trickOne[0].card },
    { playerIdx: secondPlayerIdx, card },
  ];
  let best = 0;
  let bestScore = -1;
  const leadCard = full[0].card;
  const leadSuit = leadCard.s;
  const leadIsTrump = zoleIsTrump(leadCard);
  for (let i = 0; i < 2; i++) {
    const { playerIdx, card: ca } = full[i];
    const trump = zoleIsTrump(ca);
    const followsPlainLead =
      !leadIsTrump && !trump && ca.s === leadSuit;
    let tier;
    let sub;
    if (trump) {
      tier = 2;
      sub = zoleCardTrickStrength(ca);
    } else if (followsPlainLead) {
      tier = 1;
      sub = zoleCardTrickStrength(ca);
    } else {
      tier = 0;
      sub = 0;
    }
    const sc = tier * 5000 + sub;
    if (sc > bestScore) {
      bestScore = sc;
      best = playerIdx;
    }
  }
  return best;
}

/**
 * Viena stiķa «vērtība» bota heiristikai (mazāk = labāk).
 * Lielais: grib uzvarēt stiķi; mazie — komanda: labi, ja stiķi neņem līgumdevējs.
 */
function zoleBotScoreTrickOutcome(
  isGaldins,
  contractorIdx,
  botIdx,
  winnerIdx,
  trickEyes,
  cardStr,
  difficulty
) {
  let score;
  if (isGaldins || contractorIdx == null) {
    const win = winnerIdx === botIdx;
    /* Galdiņš: gribēt acis sev — lielāks stiķa acu guvums = labāks. */
    score = win ? -trickEyes * 14 - cardStr * 0.02 : trickEyes * 4 + cardStr * 0.08;
  } else {
    const isContractor = contractorIdx === botIdx;
    const contractorWins = winnerIdx === contractorIdx;
    if (isContractor) {
      if (contractorWins) score = -520 - trickEyes * 1.1 - cardStr * 0.04;
      else score = 220 + trickEyes * 0.9 + cardStr * 0.12;
    } else {
      /** Abi mazie — komanda: uzvara = jebkurš mazais paņem stiķi. */
      if (!contractorWins) {
        score = -480 - trickEyes * 0.85 - cardStr * 0.05;
        /** Nedaudz labāk atdot partnerim (abi mazie kopā), ja vari. */
        if (winnerIdx !== botIdx) score -= 12;
      } else {
        score = 260 + trickEyes * 0.45 + cardStr * 0.1;
      }
    }
  }
  if (difficulty === "easy" && Math.random() < 0.1) {
    score += Math.random() * 70;
  }
  return score;
}

function zoleBotPickWeakest(cards) {
  if (!cards.length) return null;
  return cards.reduce((a, b) =>
    zoleCardTrickStrength(a) < zoleCardTrickStrength(b) ? a : b
  );
}

/** Vadīšana: garākais parastais masts → vājākā derīgā; citādi vājākais trumpis. */
function zoleBotPickLead(state, botIdx, legal, difficulty) {
  const plains = legal.filter((c) => !zoleIsTrump(c));
  if (plains.length) {
    const suitLen = [0, 0, 0, 0];
    for (const c of state.hands[botIdx] || []) {
      if (!zoleIsTrump(c)) suitLen[c.s]++;
    }
    let bestS = -1;
    let bestL = -1;
    for (let s = 0; s < 4; s++) {
      if (suitLen[s] > bestL) {
        bestL = suitLen[s];
        bestS = s;
      }
    }
    const fromLong = plains.filter((c) => c.s === bestS);
    const pool =
      fromLong.length > 0
        ? fromLong
        : difficulty === "hard"
          ? plains
          : plains;
    const sorted = pool.slice().sort((a, b) => {
      const da = zoleCardEyes(a) - zoleCardEyes(b);
      if (da !== 0) return da;
      return zoleCardTrickStrength(a) - zoleCardTrickStrength(b);
    });
    const pick =
      difficulty === "easy"
        ? sorted[Math.floor(Math.random() * Math.min(3, sorted.length))]
        : sorted[0];
    return pick;
  }
  return zoleBotPickWeakest(legal);
}

/** Trešais stiķī — pilna simulācija. */
function zoleBotPickThird(
  state,
  botIdx,
  legal,
  difficulty,
  contract,
  contractorIdx
) {
  const trick = state.trick;
  let best = null;
  let bestScore = Infinity;
  const isGaldins = contract === "galdins" || contractorIdx == null;

  for (const c of legal) {
    const w = zoleBotWinnerIfThirdPlays(trick, botIdx, c);
    if (w == null) continue;
    let te = 0;
    for (const t of trick) te += zoleCardEyes(t.card);
    te += zoleCardEyes(c);
    const str = zoleCardTrickStrength(c);
    const score = zoleBotScoreTrickOutcome(
      isGaldins,
      contractorIdx,
      botIdx,
      w,
      te,
      str,
      difficulty
    );
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best || legal[0];
}

/** Otrais stiķī — zināms uzvarētājs starp vadītāju un šo gājienu (trešais vēl nāk). */
function zoleBotPickSecond(
  state,
  botIdx,
  legal,
  difficulty,
  contract,
  contractorIdx
) {
  const trick = state.trick;
  const leadCard = trick[0].card;
  const isGaldins = contract === "galdins" || contractorIdx == null;

  let best = null;
  let bestScore = Infinity;
  for (const c of legal) {
    const w = zoleBotWinnerIfSecondPlays(trick, botIdx, c);
    if (w == null) continue;
    const te = zoleCardEyes(leadCard) + zoleCardEyes(c);
    const str = zoleCardTrickStrength(c);
    const score = zoleBotScoreTrickOutcome(
      isGaldins,
      contractorIdx,
      botIdx,
      w,
      te,
      str,
      difficulty
    );
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best || legal[Math.floor(Math.random() * legal.length)];
}

/**
 * Kārtas izvēle: vadīšana, 2. un 3. vieta ar atšķirīgu loģiku.
 * @param {"easy"|"medium"|"hard"} difficulty
 */
export function zolePickBotCard(state, botIdx, difficulty = "medium") {
  const hand = state.hands[botIdx];
  const legal = zoleLegalPlays(hand, state.trick);
  if (!legal.length) return null;

  const trick = state.trick || [];
  const contract = state.contract || "";
  const contractorIdx = state.contractorIdx;

  if (trick.length === 0) {
    return zoleBotPickLead(state, botIdx, legal, difficulty);
  }
  if (trick.length === 2) {
    return zoleBotPickThird(
      state,
      botIdx,
      legal,
      difficulty,
      contract,
      contractorIdx
    );
  }
  return zoleBotPickSecond(
    state,
    botIdx,
    legal,
    difficulty,
    contract,
    contractorIdx
  );
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

  const trumpNoteDetail =
    "Trumpji: visas D un J + ♦ 7–A. Parastās: ♣♥♠ A,10,K,9. " +
    "Vada parasto mastu → vispirms parastā tā mastā (9,K,10,A), ja ir. " +
    "Ja parastā nav — jebkura cita kārta (atmesties) vai trumpis pēc izvēles. " +
    "Vada trumpi → trumpis, ja ir; ja nav — parastā. " +
    "Pret lielo/zoli/mazo zoli abi mazie spēlē komandā — viņu stiķu acis skaitās kopā pret līgumdevēju.";
  const trumpNoteShort =
    "Trumpji: D, J un ♦ 7–A. Parastās ♣ ♥ ♠: 9, K, 10, A. " +
    "Seko vadītāja mastam vai atmies; pret lielo abi mazie kopā.";

  return {
    trumpSuit: state.trumpSuit,
    trumpLabel: SUIT_LABELS[state.trumpSuit] || "?",
    trumpNote: trumpNoteDetail,
    trumpNoteShort,
    trumpNoteDetail,
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
    currentTrickEyes: state.currentTrickEyes || 0,
    lastCompletedTrick: state.lastCompletedTrick
      ? {
          leaderIdx: state.lastCompletedTrick.leaderIdx,
          winnerIdx: state.lastCompletedTrick.winnerIdx,
          trickEyes: state.lastCompletedTrick.trickEyes,
          cards: state.lastCompletedTrick.cards.map((t) => ({
            playerIdx: t.playerIdx,
            card: t.card,
          })),
        }
      : null,
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
    cumulativeTableDelta: (state.cumulativeTableDelta || [0, 0, 0]).slice(),
    completedTableDeltas: Array.isArray(state.completedTableDeltas)
      ? state.completedTableDeltas.map((row) =>
          Array.isArray(row)
            ? row.map((n) => (Number.isFinite(Number(n)) ? Number(n) : 0))
            : [0, 0, 0]
        )
      : [],
    matchHandsPlayed: state.matchHandsPlayed ?? 0,
    firstBidderOffset: state.firstBidderOffset ?? 0,
    zoleLastMatchHand: !!state.zoleLastMatchHand,
  };
}
