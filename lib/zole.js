/**
 * Zole (MVP) — 3 spēlētāji, 24 kārtis (3 krāsas × 8 rangi).
 * Vienkāršota: noteikts kārts, obligāta krāsas ievērošana, uzvar augstākais led krāsā vai trumps.
 * Punkti: +1 par katru ņemto stiķi; uzvar lielākais punktu skaits.
 */
export const ZOLE_BOT_1 = "ZoleBot1";
export const ZOLE_BOT_2 = "ZoleBot2";

export function isZoleBotUsername(name) {
  const n = String(name || "");
  return n === ZOLE_BOT_1 || n === ZOLE_BOT_2;
}

const SUITS = 3; // 0,1,2

/** stiprākais = lielāks skaitlis; A augšā */
const RANK_ORDER = [7, 8, 9, 10, 11, 12, 13, 14]; // 11=J,12=Q,13=K,14=A kā salīdzināšanai

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

export function createZoleVsBotState(humanUsername) {
  const deck = shuffle(createZoleDeck());
  const hands = [deck.slice(0, 8), deck.slice(8, 16), deck.slice(16, 24)];
  const trumpSuit = Math.floor(Math.random() * SUITS);
  return {
    players: [humanUsername, ZOLE_BOT_1, ZOLE_BOT_2],
    hands,
    trumpSuit,
    trick: [],
    trickLeader: 0,
    turn: 0,
    scores: [0, 0, 0],
    tricksPlayed: 0,
    phase: "play",
  };
}

/** Divi cilvēki + viens bots (trešais spēlētājs). */
export function createZoleOnline2pState(usernameA, usernameB) {
  const deck = shuffle(createZoleDeck());
  const hands = [deck.slice(0, 8), deck.slice(8, 16), deck.slice(16, 24)];
  const trumpSuit = Math.floor(Math.random() * SUITS);
  return {
    players: [usernameA, usernameB, ZOLE_BOT_2],
    hands,
    trumpSuit,
    trick: [],
    trickLeader: 0,
    turn: 0,
    scores: [0, 0, 0],
    tricksPlayed: 0,
    phase: "play",
  };
}

/** Izpilda gājienu; atgriež { ok, error? } vai { ok, state } */
export function zolePlayCard(state, playerIdx, card) {
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
  state.scores[winner]++;
  state.tricksPlayed++;
  state.trick = [];
  state.turn = winner;

  if (state.tricksPlayed >= 8) {
    state.phase = "end";
    let winIdx = 0;
    for (let i = 1; i < 3; i++) {
      if (state.scores[i] > state.scores[winIdx]) winIdx = i;
    }
    state.winnerIdx = winIdx;
    state.winnerUsername = state.players[winIdx];
  }

  return { ok: true, state };
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
    trick: state.trick.map((t) => ({
      playerIdx: t.playerIdx,
      card: t.card,
    })),
    scores: state.scores.slice(),
    tricksPlayed: state.tricksPlayed,
    phase: state.phase,
    handCount: state.hands.map((h) => h.length),
    myHand,
    legalCardKeys,
    players: state.players.slice(),
    winnerIdx: state.winnerIdx ?? null,
    winnerUsername: state.winnerUsername ?? null,
  };
}
