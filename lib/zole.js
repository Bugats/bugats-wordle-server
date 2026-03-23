/**
 * Zole (3 spēlētāji, 24 kārtis = 3 masti × 8 kārtis).
 * Acis un tabulas punkti pēc klasiskās loģikas (skat. zolei.lv), pielāgots 24 kārtīm
 * (bez pirkuma kārtīm → 61 uzvara, 91+ aizstāts ar ļoti augstu acu slieksni).
 */
export const ZOLE_BOT_1 = "ZoleBot1";
export const ZOLE_BOT_2 = "ZoleBot2";

export function isZoleBotUsername(name) {
  const n = String(name || "");
  return n === ZOLE_BOT_1 || n === ZOLE_BOT_2;
}

const SUITS = 3;

/** Acu vērtības (zolei.lv): dūzis 11, desmitnieks 10, kungs 4, dāma 3, kalps 2, pārējās 0 */
export function zoleCardEyes(card) {
  if (!card || typeof card.r !== "number") return 0;
  switch (card.r) {
    case 14:
      return 11; // dūzis (A)
    case 10:
      return 10;
    case 13:
      return 4; // kungs
    case 12:
      return 3; // dāma
    case 11:
      return 2; // kalps
    default:
      return 0;
  }
}

/** stiprākais = lielāks skaitlis; A augšā */
const RANK_ORDER = [7, 8, 9, 10, 11, 12, 13, 14];

function rankStrength(rank) {
  const idx = RANK_ORDER.indexOf(rank);
  return idx >= 0 ? idx : 0;
}

export function createZoleDeck() {
  const deck = [];
  for (let s = 0; s < SUITS; s++) {
    for (const r of RANK_ORDER) {
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

/** Vai `play` ir derīgs, ja `trick` jau ir kārtis un pirmā nosaka lead krāsu */
export function zoleLegalPlays(hand, trick, _trumpSuit) {
  if (!hand.length) return [];
  if (!trick.length) return hand.slice();

  const leadCard = trick[0].card;
  const leadSuit = leadCard.s;
  const hasLead = hand.some((c) => c.s === leadSuit);
  if (!hasLead) return hand.slice();
  return hand.filter((c) => c.s === leadSuit);
}

/**
 * Kurš uzvar stiķi. trick: [{ playerIdx, card }, ...] pēc kārtas.
 */
export function zoleTrickWinner(trick, trumpSuit) {
  if (trick.length !== 3) return null;
  const leadSuit = trick[0].card.s;
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < 3; i++) {
    const { playerIdx, card } = trick[i];
    const isTrump = card.s === trumpSuit;
    const followsLead = card.s === leadSuit;
    let tier = 0;
    if (isTrump) tier = 2;
    else if (followsLead) tier = 1;
    else tier = 0;
    const rs = rankStrength(card.r);
    const score = tier * 100 + rs;
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
    trumpSuit: Math.floor(Math.random() * SUITS),
    trick: [],
    trickLeader: 0,
    turn: 0,
    phase: "bid",
    /** Kurš likšanas kārtā (0→1→2) */
    bidTurn: 0,
    /** Kurš pieteicās kā lielais / zole / maza zole; null līdz kāds pieteicas */
    contractorIdx: null,
    /** "big" | "zole" | "maza_zole" | "galdins" */
    contract: null,
    /** Acis no uzvarētajiem stiķiem */
    eyePoints: [0, 0, 0],
    tricksWon: [0, 0, 0],
    tricksPlayed: 0,
    /** Beigu tabulas punktu izmaiņas (+ uzvar, − zaudē) */
    tableDelta: [0, 0, 0],
    lastResult: null,
    winnerUsername: null,
    winnerIdx: null,
  };
}

function dealHands(state) {
  const deck = shuffle(createZoleDeck());
  state.hands = [deck.slice(0, 8), deck.slice(8, 16), deck.slice(16, 24)];
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

/** Trīs cilvēki, bez botiem. Kārtība = likšanas secība (0 → 1 → 2). */
export function createZoleOnline3pState(usernameA, usernameB, usernameC) {
  const players = [usernameA, usernameB, usernameC];
  const state = emptyStateBase(players);
  dealHands(state);
  state.bidTurn = 0;
  state.turn = 0;
  return state;
}

/**
 * Likšana: pass | big | zole | maza_zole
 * Pirmais, kas nepasē, kļūst par līguma ņēmēju (contractorIdx).
 * Ja visi trīs pasē → galdiņš.
 */
export function zoleProcessBid(state, playerIdx, bid) {
  if (state.phase !== "bid") return { ok: false, error: "Nav likšanas fāzes." };
  if (playerIdx !== state.bidTurn)
    return { ok: false, error: "Nav tavas likšanas kārtas." };

  const b = String(bid || "pass").toLowerCase();
  if (b === "pass") {
    state.bidTurn = (state.bidTurn + 1) % 3;
    if (state.bidTurn === 0 && state.contractorIdx == null) {
      state.phase = "play";
      state.contract = "galdins";
      state.contractorIdx = null;
      state.turn = 0;
      state.trickLeader = 0;
    }
    return { ok: true, state };
  }

  if (b !== "big" && b !== "zole" && b !== "maza_zole") {
    return { ok: false, error: "Nederīga likšana." };
  }

  state.contractorIdx = playerIdx;
  if (b === "big") state.contract = "big";
  else if (b === "zole") state.contract = "zole";
  else state.contract = "maza_zole";

  state.phase = "play";
  state.turn = playerIdx;
  state.trickLeader = playerIdx;
  state.trick = [];
  return { ok: true, state };
}

function otherIndices(idx) {
  return [0, 1, 2].filter((i) => i !== idx);
}

/**
 * Nosaka tabulas punktu izmaiņas. contractor — tas, kam jādabū ≥61 acis.
 * opponents — pārējie divi; acis un stiķi skaitās kopā pret līgumu ņēmēju.
 */
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
    if (losers.length === 3) return { delta, summary: { kind: "galdins", tie: true } };
    const loserIdx = losers[0];
    const winners = [0, 1, 2].filter((i) => i !== loserIdx);
    const loserTricks = tricks[loserIdx];
    const loserEyes = eyes[loserIdx];
    /** Rondo/galdiņš: bez stiķa → 3; jaņi (≤30 acis) → 2; citādi → 1 katram uzvarētājam */
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
      else if (contrEyes >= 85) fromEach = 6;
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
        tricks,
      },
    };
  }

  return { delta, summary: { kind: "unknown" } };
}

function finishHand(state) {
  const contract = state.contract || "galdins";
  const contractorIdx = state.contractorIdx ?? 0;
  const { delta, summary } = zoleComputeTableDeltas(
    contract,
    contract === "galdins" ? 0 : contractorIdx,
    state.eyePoints,
    state.tricksWon
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

/** Izpilda gājienu likšanā vai spēlē */
export function zolePlayCard(state, playerIdx, card) {
  if (state.phase === "bid") {
    return { ok: false, error: "Vispirms jāpasē vai jāpieteic spēle." };
  }
  if (state.phase !== "play") return { ok: false, error: "Spēle beigusies." };
  if (playerIdx !== state.turn) return { ok: false, error: "Nav tavas kārtas." };
  const hand = state.hands[playerIdx];
  const idx = findCardInHand(hand, card);
  if (idx < 0) return { ok: false, error: "Kārta nav rokā." };

  const legal = zoleLegalPlays(hand, state.trick, state.trumpSuit);
  if (!legal.some((c) => cardKey(c) === cardKey(card))) {
    return { ok: false, error: "Jāievēro krāsa." };
  }

  const played = hand.splice(idx, 1)[0];
  state.trick.push({ playerIdx, card: played });

  if (state.trick.length < 3) {
    state.turn = (state.turn + 1) % 3;
    return { ok: true, state };
  }

  const winner = zoleTrickWinner(state.trick, state.trumpSuit);
  let trickEyes = 0;
  for (const t of state.trick) trickEyes += zoleCardEyes(t.card);
  state.eyePoints[winner] += trickEyes;
  state.tricksWon[winner]++;
  state.tricksPlayed++;
  state.trick = [];
  state.turn = winner;

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
  if (eyes >= 55) return "zole";
  if (eyes >= 45) return "big";
  return "pass";
}

export function zolePickBotCard(state, botIdx) {
  const hand = state.hands[botIdx];
  const legal = zoleLegalPlays(hand, state.trick, state.trumpSuit);
  if (!legal.length) return null;
  return legal[Math.floor(Math.random() * legal.length)];
}

export function zolePublicSnapshot(state, forPlayerIdx) {
  const suits = ["♥", "♦", "♣"];
  const myHand =
    forPlayerIdx >= 0 && forPlayerIdx < 3
      ? state.hands[forPlayerIdx].slice()
      : [];
  let legalCardKeys = null;
  if (
    state.phase === "play" &&
    forPlayerIdx === state.turn &&
    myHand.length
  ) {
    const legal = zoleLegalPlays(myHand, state.trick, state.trumpSuit);
    legalCardKeys = legal.map((c) => cardKey(c));
  }
  return {
    trumpSuit: state.trumpSuit,
    trumpLabel: suits[state.trumpSuit] || "?",
    turn: state.turn,
    bidTurn: state.bidTurn,
    phase: state.phase,
    contract: state.contract,
    contractorIdx: state.contractorIdx,
    trick: state.trick.map((t) => ({
      playerIdx: t.playerIdx,
      card: t.card,
    })),
    eyePoints: state.eyePoints.slice(),
    tricksWon: state.tricksWon.slice(),
    tricksPlayed: state.tricksPlayed,
    handCount: state.hands.map((h) => h.length),
    myHand,
    legalCardKeys,
    players: state.players.slice(),
    tableDelta:
      state.phase === "end" ? state.tableDelta.slice() : null,
    lastResult: state.lastResult || null,
    winnerIdx: state.winnerIdx ?? null,
    winnerUsername: state.winnerUsername ?? null,
  };
}
