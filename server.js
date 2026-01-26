// ======== VĀRDU ZONA — Bugats edition ========
// Serveris ar login/signup, JWT, XP, RANKIEM (40 līmeņi),
// streak, coins, žetoniem, pasīvajiem coiniem ar Anti-AFK,
// TOP10, online sarakstu un čatu + ADMIN komandām + MISIJĀM + MEDAĻĀM + 1v1 DUEĻIEM.
// + SEZONAS + HOF
// + LAIMES RATS (/wheel namespace) ar persistent wheel.json
// + Ability: atvērt 1 burtu par coins (1x katrā raundā)

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ======== Konstantes ========
const PORT = process.env.PORT || 10080;
const JWT_SECRET =
  process.env.JWT_SECRET || "BUGATS_VARDU_ZONA_SUPER_SLEPENS_JWT";

const USERS_FILE = process.env.USERS_FILE || path.join(__dirname, "users.json");
const WORDS_FILE = path.join(__dirname, "words.txt");

// Seasons storage
const SEASONS_FILE =
  process.env.SEASONS_FILE || path.join(__dirname, "seasons.json");

// Static frontend (Render)
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, "public");
const STATIC_INDEX = path.join(STATIC_DIR, "index.html");

// ====== Word config ======
const MIN_WORD_LEN = 5;
const MAX_WORD_LEN = 7;
const MAX_ATTEMPTS = 6;

// ====== Ability costs ======
const REVEAL_LETTER_COST_COINS = Number(
  process.env.REVEAL_LETTER_COST_COINS || 25
);

const BASE_TOKEN_PRICE = 150;

// ======== Season rollover: coins/tokens reset (ENV slēdzis) ========
const RESET_COINS_TOKENS_ON_ROLLOVER =
  String(process.env.RESET_COINS_TOKENS_ON_ROLLOVER ?? "1") === "1";

// ======== Lielie request body limiti (FIX 413 Payload Too Large) ========
const BODY_JSON_LIMIT = process.env.BODY_JSON_LIMIT || "25mb";
const BODY_URLENC_LIMIT = process.env.BODY_URLENC_LIMIT || BODY_JSON_LIMIT;

// ======== CORS ========
const CORS_ORIGINS_RAW = (process.env.CORS_ORIGINS || "*").trim();
const CORS_ORIGINS =
  CORS_ORIGINS_RAW === "*"
    ? "*"
    : CORS_ORIGINS_RAW
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

const corsOptions =
  CORS_ORIGINS === "*"
    ? undefined
    : {
        origin: (origin, cb) => {
          if (!origin) return cb(null, true);
          return cb(null, CORS_ORIGINS.includes(origin));
        },
        credentials: true,
      };

// Avatāra max garums (base64 string)
const AVATAR_MAX_CHARS = (() => {
  const v = parseInt(process.env.AVATAR_MAX_CHARS || "", 10);
  if (Number.isFinite(v) && v > 200000) return v;
  return 6 * 1024 * 1024; // ~6.29M chars
})();

// Admin lietotāji
const ADMIN_USERNAMES = (() => {
  const raw = String(process.env.ADMIN_USERNAMES || "").trim();
  const defaults = ["BugatsLV"];
  if (!raw) return defaults;
  const extra = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return Array.from(new Set([...defaults, ...extra]));
})();
const ADMIN_USERNAMES_LC = new Set(
  ADMIN_USERNAMES.map((x) => String(x || "").toLowerCase())
);
function isAdminName(name) {
  return ADMIN_USERNAMES_LC.has(String(name || "").toLowerCase());
}
function isAdminUser(u) {
  return !!u && isAdminName(u.username);
}

// ======== Laika zona ========
const TZ = "Europe/Riga";

// ======== SEZONA 1 / 2 endAt ========
const SEASON1_END_AT = new Date("2025-12-26T23:59:59+02:00").getTime();
const SEASON2_END_AT_DEFAULT = new Date("2026-02-15T23:59:59+02:00").getTime();

const SEASON_DAYS = (() => {
  const v = parseInt(process.env.SEASON_DAYS || "30", 10);
  return Number.isFinite(v) && v >= 1 && v <= 365 ? v : 30;
})();

// ========== XP / COINS EKONOMIKA ==========
const XP_PER_WIN_BASE = 8;
const SCORE_PER_WIN = 1;
const XP_PER_LETTER_BONUS = 1;
const XP_PER_STREAK_STEP = 1;
const XP_STREAK_MAX_STEPS = 3;

const COINS_PER_WIN_BASE = 3;
const COINS_PER_LETTER_BONUS = 0;
const COINS_STREAK_MAX_BONUS = 2;

// ========== Pasīvie coini + Anti-AFK ==========
const PASSIVE_COINS_PER_TICK = 2;
const PASSIVE_INTERVAL_MS = 20 * 60 * 1000; // 20 min
const AFK_BREAK_MS = 3 * 60 * 1000;

// ========== MISIJAS ==========
const DAILY_MISSIONS_COUNT = (() => {
  const v = parseInt(process.env.DAILY_MISSIONS_COUNT || "6", 10);
  return Number.isFinite(v) && v >= 3 && v <= 8 ? v : 6;
})();

// Missionu tipiem jābūt atbalstam updateMissionsOn* funkcijās zemāk.
// baseTarget/baseRewards tiks skalēti pēc spēlētāja rank tier (lai augstākiem rankiem grūtāk).
const DAILY_MISSION_POOL = [
  // pamata
  {
    id: "wins",
    title: "Atmini {target} vārdus šodien",
    type: "wins",
    baseTarget: 3,
    baseRewards: { xp: 30, coins: 25, tokens: 0 },
    weight: 6,
  },
  {
    id: "xp",
    title: "Nopelni {target} XP šodien",
    type: "xp",
    baseTarget: 60,
    baseRewards: { xp: 0, coins: 40, tokens: 0 },
    weight: 6,
  },
  {
    id: "guesses",
    title: "Izdari {target} minējumus",
    type: "guesses",
    baseTarget: 25,
    baseRewards: { xp: 25, coins: 20, tokens: 1 },
    weight: 6,
  },

  // grūtākas / dažādākas
  {
    id: "streak",
    title: "Sasniedz streak {target} (nepārtraukta uzvaru sērija)",
    type: "streak",
    baseTarget: 3,
    baseRewards: { xp: 45, coins: 35, tokens: 1 },
    weight: 5,
  },
  {
    id: "fastwins",
    title: "Atmini {target} vārdus ātri (≤ {sec}s)",
    type: "fast_wins",
    baseTarget: 2,
    baseRewards: { xp: 50, coins: 30, tokens: 1 },
    // metadata
    sec: 75,
    weight: 4,
  },
  {
    id: "perfect",
    title: "Atmini {target} vārdus 3 mēģinājumos vai mazāk",
    type: "perfect_wins",
    baseTarget: 2,
    baseRewards: { xp: 55, coins: 30, tokens: 1 },
    maxAttempts: 3,
    weight: 4,
  },
  {
    id: "longwins",
    title: "Atmini {target} garos vārdus (7 burti)",
    type: "long_wins_7",
    baseTarget: 2,
    baseRewards: { xp: 55, coins: 35, tokens: 1 },
    weight: 4,
  },
  {
    id: "reveal",
    title: "Izmanto “Atvērt 1 burtu” {target} reizes",
    type: "reveal_used",
    baseTarget: 1,
    baseRewards: { xp: 20, coins: 25, tokens: 0 },
    weight: 3,
  },
  {
    id: "tokenbuy",
    title: "Nopērc {target} žetonus",
    type: "token_buys",
    baseTarget: 1,
    baseRewards: { xp: 20, coins: 10, tokens: 0 },
    weight: 2,
  },
  {
    id: "chest",
    title: "Atver Daily Chest",
    type: "chest_open",
    baseTarget: 1,
    baseRewards: { xp: 15, coins: 20, tokens: 0 },
    weight: 5,
  },
  {
    id: "duelwins",
    title: "Uzvari {target} dueli",
    type: "duel_wins",
    baseTarget: 1,
    baseRewards: { xp: 35, coins: 25, tokens: 1 },
    weight: 3,
  },
];

// ======== DUEĻI (1v1) ==========
const DUEL_MAX_ATTEMPTS = 6;
const DUEL_REWARD_XP = 3;
const DUEL_REWARD_COINS = 3;
const DUEL_MAX_DURATION_MS = 2 * 60 * 1000; // 2 min
// Duel start countdown (frontā rāda 5..1 AIZIET, bet spēles laiks paliek pilnas 2 min)
const DUEL_COUNTDOWN_MS = 5 * 1000;
const DUEL_INVITE_TIMEOUT_MS = 30 * 1000; // 30s, lai "pending" dueli neiestrēgst

const duels = new Map(); // duelId -> duel objekts
const userToDuel = new Map(); // username -> duelId

function getDuelOpponent(duel, username) {
  if (!duel || !Array.isArray(duel.players)) return null;
  const [p1, p2] = duel.players;
  if (username === p1) return p2 || null;
  if (username === p2) return p1 || null;
  return null;
}

// ======== ČATS (mini anti-spam) ========
const CHAT_MAX_LEN = 200;
const CHAT_RATE_MS = 900;
const CHAT_DUP_WINDOW_MS = 4000;

// ======== PRIVĀTAIS ČATS (DM) ========
const DM_MAX_LEN = 400;
const DM_RATE_MS = 650;
const DM_DUP_WINDOW_MS = 5000;
const DM_THREAD_MAX = 200; // max ziņas vienā sarunā (katram userim)

// ======== GUESS rate-limit (server-side) ========
const GUESS_RATE_MS = 950; // ~1/sec
const BAD_LEN_WINDOW_MS = 10 * 1000;
const BAD_LEN_MAX = 5;
const BAD_LEN_BLOCK_MS = 10 * 1000;

// (NEW) Guess allowed chars (A-Z + LV diakritikas)
const GUESS_ALLOWED_RE = /^[A-ZĀČĒĢĪĶĻŅŠŪŽ]+$/;

// ======== Failu helperi ========
function loadJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.error("Kļūda lasot JSON:", file, err);
    return fallback;
  }
}

// atomic save
function saveJsonAtomic(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  try {
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    if (!raw.trim()) return {};
    const arr = JSON.parse(raw);

    const list = Array.isArray(arr) ? arr : Object.values(arr || {});
    const out = {};

    for (const u of list) {
      if (!u || !u.username) continue;

      if (typeof u.isBanned !== "boolean") u.isBanned = false;
      if (typeof u.mutedUntil !== "number") u.mutedUntil = 0;
      if (!u.lastActionAt) u.lastActionAt = Date.now();
      if (!u.lastPassiveTickAt) u.lastPassiveTickAt = u.lastActionAt;
      if (typeof u.bestStreak !== "number") u.bestStreak = 0;

      if (typeof u.missionsDate !== "string") u.missionsDate = "";
      if (!Array.isArray(u.missions)) u.missions = [];

      // Statistika medaļām
      if (typeof u.totalGuesses !== "number") u.totalGuesses = 0;
      if (typeof u.bestWinTimeMs !== "number") u.bestWinTimeMs = 0;
      if (typeof u.winsToday !== "number") u.winsToday = 0;
      if (typeof u.winsTodayDate !== "string") u.winsTodayDate = "";
      if (typeof u.dailyLoginDate !== "string") u.dailyLoginDate = "";

      // Duēļu statistika
      if (typeof u.duelsWon !== "number") u.duelsWon = 0;
      if (typeof u.duelsLost !== "number") u.duelsLost = 0;
      if (typeof u.duelWinsToday !== "number") u.duelWinsToday = 0;
      if (typeof u.duelWinsTodayDate !== "string") u.duelWinsTodayDate = "";

      // Ekonomikas / ability dienas skaitītāji (misijām)
      if (typeof u.tokensBoughtToday !== "number") u.tokensBoughtToday = 0;
      if (typeof u.tokensBoughtTodayDate !== "string") u.tokensBoughtTodayDate = "";
      if (typeof u.revealUsedToday !== "number") u.revealUsedToday = 0;
      if (typeof u.revealUsedTodayDate !== "string") u.revealUsedTodayDate = "";

      // Aktīvais raunds
      if (!u.currentRound) u.currentRound = null;

      // Avatārs
      if (typeof u.avatarUrl !== "string") u.avatarUrl = null;

      // Supporter flag
      if (typeof u.supporter !== "boolean") u.supporter = false;

      // Daily Chest
      if (!u.dailyChest || typeof u.dailyChest !== "object") u.dailyChest = {};
      if (typeof u.dailyChest.lastDate !== "string") u.dailyChest.lastDate = "";
      if (typeof u.dailyChest.streak !== "number") u.dailyChest.streak = 0;
      if (typeof u.dailyChest.totalOpens !== "number")
        u.dailyChest.totalOpens = 0;

      // Pastāvīgās medaļas
      if (!Array.isArray(u.specialMedals)) u.specialMedals = [];

      // Čats (anti-spam state)
      if (typeof u.lastChatAt !== "number") u.lastChatAt = 0;
      if (typeof u.lastChatText !== "string") u.lastChatText = "";
      if (typeof u.lastChatTextAt !== "number") u.lastChatTextAt = 0;

      // Privātais čats (DM) — inbox users.json
      if (!u.dm || typeof u.dm !== "object") u.dm = {};
      if (!u.dm.threads || typeof u.dm.threads !== "object") u.dm.threads = {};
      if (!u.dm.unread || typeof u.dm.unread !== "object") u.dm.unread = {};
      if (!u.dm.lastRead || typeof u.dm.lastRead !== "object") u.dm.lastRead = {};
      // DM anti-spam state
      if (typeof u.lastDmAt !== "number") u.lastDmAt = 0;
      if (typeof u.lastDmText !== "string") u.lastDmText = "";
      if (typeof u.lastDmTextAt !== "number") u.lastDmTextAt = 0;

      // Guess anti-spam
      if (typeof u.lastGuessAt !== "number") u.lastGuessAt = 0;
      if (typeof u.badLenCount !== "number") u.badLenCount = 0;
      if (typeof u.badLenWindowStart !== "number") u.badLenWindowStart = 0;
      if (typeof u.guessBlockedUntil !== "number") u.guessBlockedUntil = 0;

      // MIGRĀCIJA: ja vecā raunda struktūra nesatur reveal laukus
      if (u.currentRound && typeof u.currentRound === "object") {
        if (typeof u.currentRound.revealUsed !== "boolean")
          u.currentRound.revealUsed = false;
        if (!u.currentRound.reveal || typeof u.currentRound.reveal !== "object")
          u.currentRound.reveal = null;
        // MIGRĀCIJA: pareizi atminēto pozīciju masks (lai reveal neatver jau zināmo)
        if (!Array.isArray(u.currentRound.knownCorrect)) {
          const len = Math.max(0, Math.floor(u.currentRound.len || 0));
          u.currentRound.knownCorrect =
            len > 0 ? new Array(len).fill(false) : [];
        }
      }

      out[u.username] = u;
    }
    return out;
  } catch (err) {
    console.error("Kļūda lasot users.json:", err);
    return {};
  }
}

function saveUsers(users) {
  const arr = Object.values(users);
  saveJsonAtomic(USERS_FILE, arr);
}

let USERS = loadUsers();

// ======== SEASON STORE (persistents) ========
function buildInitialSeasonStore() {
  return {
    current: {
      id: 1,
      name: "SEZONA 1",
      active: false,
      startedAt: 0,
      endAt: SEASON1_END_AT,
    },
    hallOfFame: [],
  };
}

let seasonStore = loadJsonSafe(SEASONS_FILE, null);
if (!seasonStore || typeof seasonStore !== "object") {
  seasonStore = buildInitialSeasonStore();
  saveJsonAtomic(SEASONS_FILE, seasonStore);
} else {
  if (!seasonStore.current)
    seasonStore.current = buildInitialSeasonStore().current;
  if (!Array.isArray(seasonStore.hallOfFame)) seasonStore.hallOfFame = [];
}

let seasonState = seasonStore.current;

// Ja serveris restartējas pēc sezonas beigām — korekti atslēdzam active
(() => {
  const now = Date.now();
  if (seasonState?.endAt && now >= seasonState.endAt && seasonState.active) {
    seasonState.active = false;
    seasonStore.current = seasonState;
    saveJsonAtomic(SEASONS_FILE, seasonStore);
  }
})();

// Boot fix: ja Sezona 2 jau ir startēta, bet endAt nav “februāra vidus”
(() => {
  const envEnd = process.env.SEASON_END_AT;
  if (envEnd) return;
  if (!seasonState || Number(seasonState.id) !== 2) return;
  if (!seasonState.endAt || !Number.isFinite(seasonState.endAt)) return;

  if (seasonState.endAt < SEASON2_END_AT_DEFAULT) {
    seasonState.endAt = SEASON2_END_AT_DEFAULT;
    seasonStore.current = seasonState;
    saveJsonAtomic(SEASONS_FILE, seasonStore);
    console.log("Season 2 endAt adjusted to mid-Feb (default).");
  }
})();

// ======== WHEEL (Laimes rats) — persistents store ========
const WHEEL_FILE = process.env.WHEEL_FILE || path.join(__dirname, "wheel.json");
const WHEEL_MAX_SLOTS = (() => {
  const v = parseInt(process.env.WHEEL_MAX_SLOTS || "5000", 10);
  return Number.isFinite(v) && v >= 50 && v <= 50000 ? v : 5000;
})();
const WHEEL_DEFAULT_SPIN_MS = (() => {
  const v = parseInt(process.env.WHEEL_DEFAULT_SPIN_MS || "9000", 10);
  return Number.isFinite(v) && v >= 3000 && v <= 60000 ? v : 9000;
})();
const WHEEL_ANNOUNCE_TO_CHAT =
  String(process.env.WHEEL_ANNOUNCE_TO_CHAT ?? "0") === "1";

function buildInitialWheelStore() {
  return {
    manualSlots: [],
    settings: { spinMs: WHEEL_DEFAULT_SPIN_MS, removeOnWin: true },
    lastSpin: null,
    spinning: false,
    spinEndsAt: 0,
    spinId: null,
  };
}

function normalizeWheelStore(x) {
  const base = buildInitialWheelStore();
  const out = x && typeof x === "object" ? x : base;

  if (!Array.isArray(out.manualSlots) && Array.isArray(out.slots)) {
    out.manualSlots = out.slots;
  }

  if (!Array.isArray(out.manualSlots)) out.manualSlots = [];
  out.manualSlots = out.manualSlots
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .slice(0, WHEEL_MAX_SLOTS);

  if (!out.settings || typeof out.settings !== "object") out.settings = {};
  const spinMs = parseInt(out.settings.spinMs ?? base.settings.spinMs, 10);
  out.settings.spinMs =
    Number.isFinite(spinMs) && spinMs >= 3000 && spinMs <= 60000
      ? spinMs
      : base.settings.spinMs;
  out.settings.removeOnWin =
    typeof out.settings.removeOnWin === "boolean"
      ? out.settings.removeOnWin
      : base.settings.removeOnWin;

  if (!out.lastSpin || typeof out.lastSpin !== "object") out.lastSpin = null;

  out.spinning = !!out.spinning;
  out.spinEndsAt = Number.isFinite(out.spinEndsAt) ? out.spinEndsAt : 0;
  out.spinId = typeof out.spinId === "string" ? out.spinId : null;

  const now = Date.now();
  if (out.spinning && out.spinEndsAt && now >= out.spinEndsAt) {
    out.spinning = false;
    out.spinEndsAt = 0;
    out.spinId = null;
  }

  return out;
}

let wheelStore = normalizeWheelStore(loadJsonSafe(WHEEL_FILE, null));
saveJsonAtomic(WHEEL_FILE, wheelStore);

function saveWheelStore() {
  saveJsonAtomic(WHEEL_FILE, wheelStore);
}

// ======== TOKEN -> WHEEL slots (AUTO) ========
let wheelTokenSlots = [];
let wheelTokenSig = "";
let wheelTokenMeta = {
  tokenUsers: 0,
  tokenTicketsTotal: 0,
  tokenTicketsUsed: 0,
  tokenTicketsTruncated: false,
};

function wheelComputeTokenSlots(maxSlotsForTokens) {
  const cap = Math.max(0, parseInt(maxSlotsForTokens || 0, 10) || 0);

  const entries = Object.values(USERS || {})
    .filter((u) => u && u.username && !u.isBanned)
    .map((u) => ({
      username: String(u.username),
      tokens: Math.max(0, Math.floor(u.tokens || 0)),
    }))
    .filter((e) => e.tokens > 0);

  entries.sort((a, b) => {
    const dt = b.tokens - a.tokens;
    if (dt !== 0) return dt;
    return a.username.localeCompare(b.username);
  });

  const sigCounts = entries.map((e) => `${e.username}:${e.tokens}`).join("|");
  const fullSig = `cap=${cap}|${sigCounts}`;

  let total = 0;
  for (const e of entries) total += e.tokens;

  const slots = [];
  let remaining = cap;

  for (const e of entries) {
    if (remaining <= 0) break;
    const take = Math.min(e.tokens, remaining);
    remaining -= take;
    for (let i = 0; i < take; i++) slots.push(e.username);
  }

  const meta = {
    tokenUsers: entries.length,
    tokenTicketsTotal: total,
    tokenTicketsUsed: slots.length,
    tokenTicketsTruncated: slots.length < total,
  };

  return { fullSig, slots, meta };
}

function wheelSyncTokenSlots(force = false) {
  const manualLen = Array.isArray(wheelStore.manualSlots)
    ? wheelStore.manualSlots.length
    : 0;

  const maxForTokens = Math.max(0, WHEEL_MAX_SLOTS - manualLen);

  const { fullSig, slots, meta } = wheelComputeTokenSlots(maxForTokens);

  if (!force && fullSig === wheelTokenSig) return false;

  for (let i = slots.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }

  wheelTokenSig = fullSig;
  wheelTokenSlots = slots;
  wheelTokenMeta = meta;

  return true;
}

function wheelGetCombinedSlots() {
  wheelSyncTokenSlots(false);

  const manual = Array.isArray(wheelStore.manualSlots)
    ? wheelStore.manualSlots
    : [];
  const token = Array.isArray(wheelTokenSlots) ? wheelTokenSlots : [];

  const slots = manual.concat(token).slice(0, WHEEL_MAX_SLOTS);

  return {
    slots,
    manualCount: manual.length,
    tokenCount: token.length,
  };
}

function publicWheelState() {
  const combined = wheelGetCombinedSlots();
  return {
    slots: combined.slots,
    settings: wheelStore.settings || {
      spinMs: WHEEL_DEFAULT_SPIN_MS,
      removeOnWin: true,
    },
    lastSpin: wheelStore.lastSpin || null,
    spinning: !!wheelStore.spinning,
    spinEndsAt: wheelStore.spinEndsAt || 0,
    maxSlots: WHEEL_MAX_SLOTS,

    manualCount: combined.manualCount,
    tokenCount: combined.tokenCount,
    tokenMeta: { ...(wheelTokenMeta || {}) },
  };
}

function wheelIsSpinningNow() {
  const now = Date.now();
  return !!(
    wheelStore.spinning &&
    wheelStore.spinEndsAt &&
    now < wheelStore.spinEndsAt
  );
}

let wheelNsp = null;

function wheelEmitUpdate(force = true) {
  if (!wheelNsp) return;
  wheelNsp.emit("wheel:update", publicWheelState());
  if (force) wheelNsp.emit("update", publicWheelState());
}

function wheelEmitError(socket, msg) {
  try {
    socket.emit("wheel:error", msg);
    socket.emit("error", msg);
  } catch {
    // ignore
  }
}

function wheelRequireAdmin(socket) {
  const u = socket?.data?.user;
  if (!u || !isAdminUser(u)) {
    wheelEmitError(socket, "Nav ADMIN.");
    return null;
  }
  return u;
}

function wheelBlockIfSpinning(socket) {
  if (wheelIsSpinningNow()) {
    wheelEmitError(socket, "Spin notiek — pagaidi, kamēr beidzas.");
    return true;
  }
  return false;
}

function wheelAdd(nameRaw, countRaw) {
  const name = String(nameRaw || "").trim().slice(0, 60);
  if (!name) return { ok: false, message: "Nav vārda." };

  let count = parseInt(countRaw ?? 1, 10);
  if (!Number.isFinite(count) || count <= 0) count = 1;
  count = Math.max(1, Math.min(1000, count));

  const manual = wheelStore.manualSlots;
  if (manual.length + count > WHEEL_MAX_SLOTS) {
    return {
      ok: false,
      message: `Par daudz ierakstu (max ${WHEEL_MAX_SLOTS}).`,
    };
  }

  for (let i = 0; i < count; i++) manual.push(name);

  saveWheelStore();
  wheelSyncTokenSlots(true);

  return { ok: true, name, count };
}

function findUserKeyCaseInsensitive(nameRaw) {
  const q = String(nameRaw || "").trim().toLowerCase();
  if (!q) return null;
  if (USERS[nameRaw]) return nameRaw;
  for (const k of Object.keys(USERS || {})) {
    if (String(k).toLowerCase() === q) return k;
  }
  return null;
}

function wheelRemoveAllByName(nameRaw) {
  const name = String(nameRaw || "").trim();
  if (!name) return { ok: false, message: "Nav vārda." };

  const needle = name.toLowerCase();

  const beforeManual = wheelStore.manualSlots.length;
  wheelStore.manualSlots = wheelStore.manualSlots.filter(
    (x) => String(x || "").toLowerCase() !== needle
  );
  const removedManual = beforeManual - wheelStore.manualSlots.length;

  const key = findUserKeyCaseInsensitive(name);
  let tokensBefore = null;
  let tokensNow = null;
  let userMatched = null;

  if (key && USERS[key]) {
    userMatched = USERS[key].username;
    tokensBefore = Math.max(0, Math.floor(USERS[key].tokens || 0));
    USERS[key].tokens = 0;
    tokensNow = 0;
    saveUsers(USERS);
  }

  saveWheelStore();
  wheelSyncTokenSlots(true);

  return {
    ok: true,
    name,
    removedManual,
    userMatched,
    tokensBefore,
    tokensNow,
  };
}

function wheelRemoveOneByIndex(indexRaw) {
  const idx = parseInt(indexRaw, 10);
  if (!Number.isFinite(idx)) return { ok: false, message: "Nederīgs index." };

  const combined = wheelGetCombinedSlots();
  const slots = combined.slots;

  if (idx < 0 || idx >= slots.length) {
    return { ok: false, message: "Index ārpus robežām." };
  }

  const manualLen = combined.manualCount;
  const removedName = slots[idx];

  if (idx < manualLen) {
    wheelStore.manualSlots.splice(idx, 1);
    saveWheelStore();
    wheelSyncTokenSlots(true);
    return { ok: true, index: idx, name: removedName, source: "manual" };
  }

  const key = findUserKeyCaseInsensitive(removedName);
  const u = key ? USERS[key] : null;
  if (u) {
    const prev = Math.max(0, Math.floor(u.tokens || 0));
    u.tokens = Math.max(0, prev - 1);
    saveUsers(USERS);
    wheelSyncTokenSlots(true);
    return {
      ok: true,
      index: idx,
      name: u.username,
      source: "token",
      tokensNow: u.tokens,
    };
  }

  wheelSyncTokenSlots(true);
  return { ok: true, index: idx, name: removedName, source: "token" };
}

function wheelShuffle() {
  const arr = wheelStore.manualSlots;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  saveWheelStore();
  wheelSyncTokenSlots(true);
}

function wheelApplySettings({ spinMs, removeOnWin }) {
  const ms = parseInt(
    spinMs ?? wheelStore.settings.spinMs ?? WHEEL_DEFAULT_SPIN_MS,
    10
  );
  wheelStore.settings.spinMs =
    Number.isFinite(ms) && ms >= 3000 && ms <= 60000
      ? ms
      : WHEEL_DEFAULT_SPIN_MS;
  if (typeof removeOnWin === "boolean")
    wheelStore.settings.removeOnWin = removeOnWin;
  saveWheelStore();
}

function wheelFinishSpin(spinId, io) {
  if (!wheelStore.spinning) return;
  if (wheelStore.spinId !== spinId) return;

  const last = wheelStore.lastSpin;
  const removeOnWin = !!wheelStore.settings?.removeOnWin;

  if (removeOnWin && last && last.winnerName) {
    const winnerName = String(last.winnerName || "").trim();
    const src = String(last.winnerSource || "manual");

    if (src === "manual") {
      const mi = Number.isFinite(last.manualIndex) ? last.manualIndex : -1;
      if (
        mi >= 0 &&
        mi < wheelStore.manualSlots.length &&
        wheelStore.manualSlots[mi] === winnerName
      ) {
        wheelStore.manualSlots.splice(mi, 1);
      } else {
        const j = wheelStore.manualSlots.findIndex((x) => x === winnerName);
        if (j >= 0) wheelStore.manualSlots.splice(j, 1);
      }
      saveWheelStore();
    } else if (src === "token") {
      const key = findUserKeyCaseInsensitive(winnerName);
      const u = key ? USERS[key] : null;
      if (u) {
        const prev = Math.max(0, Math.floor(u.tokens || 0));
        u.tokens = Math.max(0, prev - 1);
        saveUsers(USERS);
      }
    }
  }

  wheelStore.spinning = false;
  wheelStore.spinEndsAt = 0;
  wheelStore.spinId = null;

  wheelSyncTokenSlots(true);

  saveWheelStore();
  wheelEmitUpdate(true);

  if (WHEEL_ANNOUNCE_TO_CHAT && last?.winnerName && io) {
    io.emit("chatMessage", {
      username: "SYSTEM",
      text: `🎡 Laimes rats: uzvarēja ${last.winnerName}!`,
      ts: Date.now(),
    });
  }
}

function wheelStartSpin(byUsername, io) {
  if (wheelIsSpinningNow()) return { ok: false, message: "Spin jau notiek." };

  wheelSyncTokenSlots(true);

  const combined = wheelGetCombinedSlots();
  const slots = combined.slots;

  const n = slots.length;
  if (!n) return { ok: false, message: "Nav neviena ieraksta ratā." };

  const spinMs = parseInt(
    wheelStore.settings?.spinMs ?? WHEEL_DEFAULT_SPIN_MS,
    10
  );
  const ms =
    Number.isFinite(spinMs) && spinMs >= 3000 && spinMs <= 60000
      ? spinMs
      : WHEEL_DEFAULT_SPIN_MS;

  const winnerIndex = crypto.randomInt(0, n);
  const winnerName = slots[winnerIndex];

  const manualCount = combined.manualCount;
  const winnerSource = winnerIndex < manualCount ? "manual" : "token";
  const manualIndex = winnerSource === "manual" ? winnerIndex : -1;

  const spinId = crypto.randomBytes(8).toString("hex");
  const now = Date.now();

  wheelStore.lastSpin = {
    winnerName,
    winnerIndex,
    winnerSource,
    manualIndex,
    by: String(byUsername || "ADMIN"),
    at: now,
    spinMs: ms,
    slotsCount: n,
    manualCount: combined.manualCount,
    tokenCount: combined.tokenCount,
  };
  wheelStore.spinning = true;
  wheelStore.spinEndsAt = now + ms;
  wheelStore.spinId = spinId;

  saveWheelStore();
  wheelEmitUpdate(true);

  const spinPayload = {
    winnerIndex,
    winnerName,
    winnerSource,
    slotsCount: n,
    spinMs: ms,
    by: String(byUsername || "ADMIN"),
    at: now,
    manualCount: combined.manualCount,
    tokenCount: combined.tokenCount,
  };

  if (wheelNsp) {
    wheelNsp.emit("wheel:spin", spinPayload);
    wheelNsp.emit("spin", spinPayload);
  }

  setTimeout(() => wheelFinishSpin(spinId, io), ms + 30);

  return { ok: true, ...spinPayload };
}

// ======== Vārdu saraksts ========
let WORDS = [];
try {
  const raw = fs.readFileSync(WORDS_FILE, "utf8");
  WORDS = raw
    .split(/\r?\n/)
    .map((w) => w.trim().toUpperCase())
    .filter((w) => w.length >= MIN_WORD_LEN && w.length <= MAX_WORD_LEN);
  console.log("Ielādēti vārdi:", WORDS.length);
} catch (err) {
  console.error("Neizdevās ielādēt words.txt:", err);
}

// ======== Rank loģika (40 līmeņi) ========
// Rank tabula ir ārpus funkcijas (ātrāk + vieglāk papildināt).
// Pirmie 25 līmeņi saglabāti kā iepriekš, pievienoti nākamie līmeņi + krāsas.
const RANK_TABLE = [
  // 1..25 (legacy)
  { minXp: 0, title: "Jauniņais", color: "#9CA3AF" },
  { minXp: 40, title: "Burtu Skolnieks", color: "#94A3B8" },
  { minXp: 90, title: "Vārdu Mednieks", color: "#60A5FA" },
  { minXp: 160, title: "Burtošanas Aizrautis", color: "#38BDF8" },
  { minXp: 250, title: "Vārdu Taktikis", color: "#34D399" },
  { minXp: 360, title: "Leksikas Kareivis", color: "#22C55E" },
  { minXp: 490, title: "Leksikas Bruņinieks", color: "#A3E635" },
  { minXp: 640, title: "Erudīcijas Cīnītājs", color: "#FBBF24" },
  { minXp: 810, title: "Erudīcijas Kapteinis", color: "#F59E0B" },
  { minXp: 1000, title: "Erudīcijas Komandieris", color: "#FB7185" },
  { minXp: 1200, title: "Smadzeņu Atlēts", color: "#F43F5E" },
  { minXp: 1450, title: "Loģikas Inženieris", color: "#E879F9" },
  { minXp: 1750, title: "Stratēģijas Arhitekts", color: "#C084FC" },
  { minXp: 2100, title: "Vārdu Burvis", color: "#A78BFA" },
  { minXp: 2500, title: "Vārdu Maģistrs", color: "#818CF8" },
  { minXp: 2950, title: "Vārdu Profesors", color: "#6366F1" },
  { minXp: 3450, title: "ZONAS Sargs", color: "#22D3EE" },
  { minXp: 4000, title: "ZONAS Boss", color: "#06B6D4" },
  { minXp: 4600, title: "ZONAS Karalis", color: "#10B981" },
  { minXp: 5250, title: "Bugats Māceklis", color: "#14B8A6" },
  { minXp: 5950, title: "Bugats Elites Spēlētājs", color: "#F97316" },
  { minXp: 6700, title: "Bugats PRIME", color: "#EF4444" },
  { minXp: 7500, title: "Bugats Mītiskais", color: "#8B5CF6" },
  { minXp: 8350, title: "Kosmiskais Prāts", color: "#7C3AED" },
  { minXp: 9250, title: "Nemirstīgais ZONAS Mīts", color: "#FDE047" },

  // 26..40 (jaunie)
  { minXp: 10200, title: "ZONAS Leģenda", color: "#FACC15" },
  { minXp: 11200, title: "ZONAS Titāns", color: "#FDBA74" },
  { minXp: 12300, title: "ZONAS Arhonts", color: "#FB7185" },
  { minXp: 13500, title: "ZONAS Imperators", color: "#F43F5E" },
  { minXp: 14800, title: "Vārdu Sensojs", color: "#38BDF8" },
  { minXp: 16200, title: "Leksikas Vētra", color: "#22C55E" },
  { minXp: 17700, title: "Diakritiku Meistars", color: "#A3E635" },
  { minXp: 19300, title: "Kosmiskais Arhitekts", color: "#A78BFA" },
  { minXp: 21000, title: "ZONAS Dievība", color: "#E879F9" },
  { minXp: 22800, title: "Bugats Panteons", color: "#FDE047" },
  { minXp: 24700, title: "Mūžīgais Vārdu Avots", color: "#FFFFFF" },
  { minXp: 26700, title: "Absolūtais ZONAS Apex", color: "#00E5FF" },
  { minXp: 28800, title: "Vārdu Multiverss", color: "#7CFF6B" },
  { minXp: 31000, title: "Nemirstīgais PRIME Mīts", color: "#FF4DFF" },
  { minXp: 33300, title: "ZONAS Bezgalība", color: "#FFD166" },
];

function calcRankFromXp(xp) {
  const currentXp = Number.isFinite(Number(xp)) ? Number(xp) : 0;
  let currentIndex = 0;
  for (let i = 0; i < RANK_TABLE.length; i++) {
    const r = RANK_TABLE[i];
    if (currentXp >= r.minXp) currentIndex = i;
    else break;
  }

  const current = RANK_TABLE[currentIndex] || RANK_TABLE[0];
  const next = RANK_TABLE[currentIndex + 1] || null;
  const level = currentIndex + 1;

  const minXp = Number(current?.minXp) || 0;
  const nextMinXp = next ? Number(next.minXp) || null : null;
  const isMax = !next;

  return {
    level,
    title: current?.title || "—",
    color: current?.color || "#9CA3AF",
    minXp,
    nextMinXp,
    isMax,
  };
}

function ensureRankFields(u) {
  const info = calcRankFromXp(u?.xp || 0);
  if (u) {
    u.rankLevel = info.level;
    u.rankTitle = info.title;
    u.rankColor = info.color;
  }
  return info;
}

function getTokenPrice() {
  return BASE_TOKEN_PRICE;
}

// ======== Dienas atslēga pēc LV laika ========
function todayKey(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(date);
}

// ======== Daily Chest helperi ========
function ensureDailyChest(user) {
  if (!user.dailyChest || typeof user.dailyChest !== "object")
    user.dailyChest = {};
  if (typeof user.dailyChest.lastDate !== "string") user.dailyChest.lastDate = "";
  if (typeof user.dailyChest.streak !== "number") user.dailyChest.streak = 0;
  if (typeof user.dailyChest.totalOpens !== "number")
    user.dailyChest.totalOpens = 0;
}

function getTzOffsetMinutes(timeZone, date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "shortOffset",
      hour: "2-digit",
    }).formatToParts(date);

    const tz =
      parts.find((p) => p.type === "timeZoneName")?.value || "GMT+0";
    const m = tz.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
    if (!m) return 0;
    const sign = m[1] === "-" ? -1 : 1;
    const hh = parseInt(m[2], 10) || 0;
    const mm = parseInt(m[3] || "0", 10) || 0;
    return sign * (hh * 60 + mm);
  } catch {
    return 0;
  }
}

function nextMidnightRigaTs(now = new Date()) {
  const key = todayKey(now);
  const [y, mo, d] = key.split("-").map((x) => parseInt(x, 10));
  const probe = new Date(Date.UTC(y, mo - 1, d + 1, 12, 0, 0));
  const offsetMin = getTzOffsetMinutes(TZ, probe);
  const utcMidnight = Date.UTC(y, mo - 1, d + 1, 0, 0, 0);
  return utcMidnight - offsetMin * 60 * 1000;
}

// ======== Anti-AFK + pasīvie coini ========
function markActivity(user) {
  const now = Date.now();
  let passiveChanged = false;

  if (!user.lastActionAt) {
    user.lastActionAt = now;
    user.lastPassiveTickAt = now;
    return passiveChanged;
  }
  if (!user.lastPassiveTickAt) {
    user.lastPassiveTickAt = user.lastActionAt;
  }

  if (now - user.lastActionAt > AFK_BREAK_MS) {
    user.lastActionAt = now;
    user.lastPassiveTickAt = now;
    return passiveChanged;
  }

  user.lastActionAt = now;
  const diff = now - user.lastPassiveTickAt;

  if (diff >= PASSIVE_INTERVAL_MS) {
    const ticks = Math.floor(diff / PASSIVE_INTERVAL_MS);
    const gained = ticks * PASSIVE_COINS_PER_TICK;
    user.coins = (user.coins || 0) + gained;
    user.lastPassiveTickAt += ticks * PASSIVE_INTERVAL_MS;
    passiveChanged = true;
  }
  return passiveChanged;
}

// ======== MISIJU HELPERI ========
function ensureDailyMissions(user) {
  const key = todayKey();

  // helperi deterministiskai izvēlei (lai vienam useram vienā dienā nemainās)
  function xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return h >>> 0;
    };
  }
  function mulberry32(a) {
    return function () {
      let t = (a += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clampInt(n, lo, hi) {
    const x = Math.floor(Number(n) || 0);
    return Math.max(lo, Math.min(hi, x));
  }

  function computeMissionTier(u) {
    // 0..5 (augstāks => grūtākas misijas). Balstās uz rankLevel.
    const info = ensureRankFields(u);
    const lvl = Math.max(1, Number(info?.level || u?.rankLevel || 1));
    return clampInt(Math.floor((lvl - 1) / 7), 0, 5);
  }

  // Misiju target “caps” (lai neuzģenerē neizpildāmas vai absurdi lielas misijas).
  // Piemēri:
  // - chest_open: var atvērt tikai 1x dienā
  // - token_buys: lai nav paywall/absurdi targeti
  // - reveal_used: lai nav pārāk daudz “spied ar pinceti”
  const MISSION_TARGET_CAPS = {
    chest_open: 1,
    token_buys: 3,
    reveal_used: 2,
  };

  function scaleTarget(baseTarget, tier, type) {
    const b = Math.max(1, Math.floor(Number(baseTarget) || 1));
    // dažiem tipiem lēnāka skale, lai nebūtu absurdi
    const mult =
      type === "token_buys" || type === "reveal_used"
        ? 1 + tier * 0.25
        : type === "fast_wins" || type === "perfect_wins" || type === "duel_wins"
        ? 1 + tier * 0.35
        : 1 + tier * 0.45;

    let target = Math.max(1, Math.round(b * mult));
    const cap = Number(MISSION_TARGET_CAPS[type]);
    if (Number.isFinite(cap) && cap >= 1) target = Math.min(target, Math.floor(cap));
    return target;
  }

  function scaleRewards(baseRewards, tier) {
    const rw = baseRewards || {};
    const mult = 1 + tier * 0.18;
    return {
      xp: Math.max(0, Math.round((rw.xp || 0) * mult)),
      coins: Math.max(0, Math.round((rw.coins || 0) * mult)),
      tokens: Math.max(0, Math.round((rw.tokens || 0) * (tier >= 4 ? 1.2 : 1))),
    };
  }

  function formatTitle(tpl, ctx) {
    const s = String(tpl || "");
    return s
      .replaceAll("{target}", String(ctx.target))
      .replaceAll("{sec}", String(ctx.sec ?? ""))
      .replaceAll("{maxAttempts}", String(ctx.maxAttempts ?? ""));
  }

  function pickWeightedUnique(pool, count, rng) {
    const out = [];
    const used = new Set();
    const items = (Array.isArray(pool) ? pool : []).filter(Boolean);

    function pickOne() {
      const candidates = items.filter((m) => !used.has(m.id));
      if (!candidates.length) return null;
      let total = 0;
      for (const m of candidates) total += Math.max(0.0001, Number(m.weight) || 1);
      let r = rng() * total;
      for (const m of candidates) {
        r -= Math.max(0.0001, Number(m.weight) || 1);
        if (r <= 0) return m;
      }
      return candidates[candidates.length - 1];
    }

    for (let i = 0; i < count; i++) {
      const m = pickOne();
      if (!m) break;
      used.add(m.id);
      out.push(m);
    }
    return out;
  }

  function buildDailyMissions(u) {
    const tier = computeMissionTier(u);
    const seed = xmur3(`${key}|${u?.username || "user"}`)();
    const rng = mulberry32(seed);

    const desired = DAILY_MISSIONS_COUNT;

    // garantējam, ka ir vismaz 1 no pamata tipiem (wins/xp/guesses)
    const basics = DAILY_MISSION_POOL.filter((m) =>
      ["wins", "xp", "guesses"].includes(m.type)
    );
    const others = DAILY_MISSION_POOL.filter((m) => !basics.includes(m));

    const selected = [];
    selected.push(...pickWeightedUnique(basics, 1, rng));
    // vēl 1 basic, lai misijas nav pārāk "eksotiskas"
    selected.push(...pickWeightedUnique(basics, 1, rng));
    selected.push(...pickWeightedUnique(others, Math.max(0, desired - selected.length), rng));

    const uniqById = new Map();
    for (const m of selected) {
      if (m && m.id && !uniqById.has(m.id)) uniqById.set(m.id, m);
    }
    const finalDefs = Array.from(uniqById.values()).slice(0, desired);

    return finalDefs.map((def) => {
      const target = scaleTarget(def.baseTarget, tier, def.type);
      const rewards = scaleRewards(def.baseRewards, tier);
      const title = formatTitle(def.title, {
        target,
        sec: def.sec,
        maxAttempts: def.maxAttempts,
      });
      return {
        id: `${def.id}_${key}`, // unikāls katrai dienai (lai vecas misijas nesajaucas)
        code: def.id, // stabils kods tipam
        title,
        type: def.type,
        target,
        progress: 0,
        isCompleted: false,
        isClaimed: false,
        rewards,
        meta: {
          sec: def.sec,
          maxAttempts: def.maxAttempts,
        },
      };
    });
  }

  if (user.missionsDate !== key || !Array.isArray(user.missions) || !user.missions.length) {
    user.missionsDate = key;
    user.missions = buildDailyMissions(user);
  } else {
    // Migrācija/upgrade tajā pašā dienā:
    // - ja vecais formāts (nav code/meta) -> pievienojam
    // - ja misiju ir mazāk nekā DAILY_MISSIONS_COUNT -> pieliekam klāt līdz vēlamajam skaitam
    let changed = false;

    const codeFromLegacyId = (id) => {
      const s = String(id || "").toLowerCase();
      if (s.startsWith("win")) return "wins";
      if (s.startsWith("xp")) return "xp";
      if (s.startsWith("guess")) return "guesses";
      return String(id || "").trim() || "unknown";
    };

    const defByCodeOrType = (code, type) => {
      const c = String(code || "");
      const t = String(type || "");
      return (
        DAILY_MISSION_POOL.find((d) => d && (d.id === c || d.type === t || d.id === t)) || null
      );
    };

    for (const m of user.missions) {
      if (!m || typeof m !== "object") continue;
      if (!m.code) {
        m.code = codeFromLegacyId(m.id);
        changed = true;
      }
      if (!m.meta || typeof m.meta !== "object") {
        m.meta = {};
        changed = true;
      }

      // Fix: target caps (neizpildāmi / pārāk lieli targeti)
      const cap = Number(MISSION_TARGET_CAPS[m.type]);
      const curTarget = Math.max(1, Math.floor(Number(m.target) || 1));
      if (Number.isFinite(cap) && cap >= 1 && curTarget > cap) {
        m.target = Math.floor(cap);

        // title var saturēt {target} (reveal/tokenbuy). Pārrakstām to ar jauno target.
        const def = defByCodeOrType(m.code, m.type);
        if (def && def.title) {
          const title = formatTitle(def.title, {
            target: m.target,
            sec: def.sec,
            maxAttempts: def.maxAttempts,
          });
          m.title = title;

          // meta saskaņošana (ja vajag)
          if (def.sec != null) m.meta.sec = def.sec;
          if (def.maxAttempts != null) m.meta.maxAttempts = def.maxAttempts;
        }

        // progress tiek turēts kā max value, tāpēc clampā pietiek ar jauno target
        if ((m.progress || 0) >= m.target) m.isCompleted = true;
        changed = true;
      }

      if (typeof m.isCompleted !== "boolean") {
        m.isCompleted = (m.progress || 0) >= (m.target || 0);
        changed = true;
      }
      if (typeof m.isClaimed !== "boolean") {
        m.isClaimed = false;
        changed = true;
      }
    }

    const desired = DAILY_MISSIONS_COUNT;
    if (Array.isArray(user.missions) && user.missions.length < desired) {
      const existingCodes = new Set(
        user.missions
          .map((m) => (m && m.code ? String(m.code) : ""))
          .filter(Boolean)
      );

      const fresh = buildDailyMissions(user);
      const add = [];
      for (const m of fresh) {
        if (add.length + user.missions.length >= desired) break;
        const c = m && m.code ? String(m.code) : "";
        if (!c) continue;
        if (existingCodes.has(c)) continue;
        existingCodes.add(c);
        add.push(m);
      }

      if (add.length) {
        user.missions.push(...add);
        changed = true;
      }
    }

    if (changed) {
      // nekas vairāk; saveUsers notiek pie /me vai /missions endpointiem
    }
  }
}

function getPublicMissions(user) {
  ensureDailyMissions(user);
  return user.missions.map((m) => ({
    id: m.id,
    title: m.title,
    target: m.target,
    progress: m.progress || 0,
    isCompleted: !!m.isCompleted,
    isClaimed: !!m.isClaimed,
    rewards: m.rewards || {},
  }));
}

function updateMissionsOnGuess(user, { isWin, xpGain, winTimeMs, wordLen, attemptsUsed }) {
  ensureDailyMissions(user);
  let changed = false;

  for (const m of user.missions) {
    const prevProgress = m.progress || 0;
    switch (m.type) {
      case "wins":
        if (isWin) {
          m.progress = prevProgress + 1;
          changed = true;
        }
        break;
      case "xp":
        if (xpGain > 0) {
          m.progress = prevProgress + xpGain;
          changed = true;
        }
        break;
      case "guesses":
        m.progress = prevProgress + 1;
        changed = true;
        break;
      case "streak":
        // progress ir max sasniegtais streak šodien (nevis +1)
        if (isWin) {
          const s = Math.max(0, Math.floor(user.streak || 0));
          if (s > prevProgress) {
            m.progress = s;
            changed = true;
          }
        }
        break;
      case "fast_wins": {
        if (!isWin) break;
        const sec = Number(m?.meta?.sec || 75);
        const lim = Number.isFinite(sec) && sec > 0 ? sec * 1000 : 75 * 1000;
        if (Number.isFinite(winTimeMs) && winTimeMs > 0 && winTimeMs <= lim) {
          m.progress = prevProgress + 1;
          changed = true;
        }
        break;
      }
      case "perfect_wins": {
        if (!isWin) break;
        const maxA = Number(m?.meta?.maxAttempts || 3);
        const lim = Number.isFinite(maxA) && maxA >= 1 ? maxA : 3;
        if (Number.isFinite(attemptsUsed) && attemptsUsed > 0 && attemptsUsed <= lim) {
          m.progress = prevProgress + 1;
          changed = true;
        }
        break;
      }
      case "long_wins_7":
        if (isWin && Number(wordLen) === 7) {
          m.progress = prevProgress + 1;
          changed = true;
        }
        break;
      default:
        break;
    }
    if (m.progress >= m.target && !m.isCompleted) {
      m.isCompleted = true;
      changed = true;
    }
  }

  return changed;
}

function resetDailyCountersIfNeeded(user) {
  const today = todayKey();
  if (user.duelWinsTodayDate !== today) {
    user.duelWinsTodayDate = today;
    user.duelWinsToday = 0;
  }
  if (user.tokensBoughtTodayDate !== today) {
    user.tokensBoughtTodayDate = today;
    user.tokensBoughtToday = 0;
  }
  if (user.revealUsedTodayDate !== today) {
    user.revealUsedTodayDate = today;
    user.revealUsedToday = 0;
  }
}

function updateMissionsGenericCounter(user, type, nextValue) {
  ensureDailyMissions(user);
  let changed = false;
  for (const m of user.missions) {
    if (m.type !== type) continue;
    const prev = m.progress || 0;
    const nv = Math.max(prev, Math.floor(nextValue || 0));
    if (nv !== prev) {
      m.progress = nv;
      changed = true;
    }
    if (m.progress >= m.target && !m.isCompleted) {
      m.isCompleted = true;
      changed = true;
    }
  }
  return changed;
}

function updateMissionsOnDuelWin(user) {
  resetDailyCountersIfNeeded(user);
  user.duelWinsToday = (user.duelWinsToday || 0) + 1;
  return updateMissionsGenericCounter(user, "duel_wins", user.duelWinsToday);
}

function updateMissionsOnTokenBuy(user, qty = 1) {
  resetDailyCountersIfNeeded(user);
  user.tokensBoughtToday = (user.tokensBoughtToday || 0) + Math.max(1, Math.floor(qty || 1));
  return updateMissionsGenericCounter(user, "token_buys", user.tokensBoughtToday);
}

function updateMissionsOnRevealUsed(user) {
  resetDailyCountersIfNeeded(user);
  user.revealUsedToday = (user.revealUsedToday || 0) + 1;
  return updateMissionsGenericCounter(user, "reveal_used", user.revealUsedToday);
}

function updateMissionsOnChestOpen(user) {
  return updateMissionsGenericCounter(user, "chest_open", 1);
}

function resetWinsTodayIfNeeded(user) {
  const today = todayKey();
  if (user.winsTodayDate !== today) {
    user.winsTodayDate = today;
    user.winsToday = 0;
  }
}

// ======== Medaļu loģika (8 globālie līderi) ========
function computeMedalsForUser(targetUser) {
  if (!targetUser) return [];
  const all = Object.values(USERS || {});
  if (!all.length) return [];

  const today = todayKey();

  function bestByField(field, filterFn) {
    let max = 0;
    let winners = [];
    for (const u of all) {
      if (filterFn && !filterFn(u)) continue;
      const v = u[field] || 0;
      if (v <= 0) continue;
      if (v > max) {
        max = v;
        winners = [u.username];
      } else if (v === max) {
        winners.push(u.username);
      }
    }
    return { max, winners };
  }

  function bestMinTime(field) {
    let best = Infinity;
    let winners = [];
    for (const u of all) {
      const v = u[field] || 0;
      if (!v || v <= 0) continue;
      if (v < best) {
        best = v;
        winners = [u.username];
      } else if (v === best) {
        winners.push(u.username);
      }
    }
    return { best, winners };
  }

  const medals = [];

  const topScore = bestByField("score");
  if (
    topScore.max > 0 &&
    topScore.winners.length === 1 &&
    topScore.winners[0] === targetUser.username
  ) {
    medals.push({ code: "TOP_SCORE", icon: "🏆", label: "TOP punktos" });
  }

  const topBestStreak = bestByField("bestStreak");
  if (
    topBestStreak.max > 0 &&
    topBestStreak.winners.length === 1 &&
    topBestStreak.winners[0] === targetUser.username
  ) {
    medals.push({ code: "BEST_STREAK", icon: "🔥", label: "Garākais streak" });
  }

  const fastWin = bestMinTime("bestWinTimeMs");
  if (
    fastWin.best < Infinity &&
    fastWin.winners.length === 1 &&
    fastWin.winners[0] === targetUser.username
  ) {
    medals.push({ code: "FAST_WIN", icon: "⚡", label: "Ātrākais vārds" });
  }

  const marathon = bestByField("totalGuesses");
  if (
    marathon.max > 0 &&
    marathon.winners.length === 1 &&
    marathon.winners[0] === targetUser.username
  ) {
    medals.push({ code: "MARATHON", icon: "⏱️", label: "Maratona spēlētājs" });
  }

  const dailyChamp = bestByField("winsToday", (u) => u.winsTodayDate === today);
  if (
    dailyChamp.max > 0 &&
    dailyChamp.winners.length === 1 &&
    dailyChamp.winners[0] === targetUser.username
  ) {
    medals.push({ code: "DAILY_CHAMP", icon: "👑", label: "Šodienas čempions" });
  }

  const topXp = bestByField("xp");
  if (
    topXp.max > 0 &&
    topXp.winners.length === 1 &&
    topXp.winners[0] === targetUser.username
  ) {
    medals.push({ code: "XP_KING", icon: "🧠", label: "XP līderis" });
  }

  const coinKing = bestByField("coins");
  if (
    coinKing.max > 0 &&
    coinKing.winners.length === 1 &&
    coinKing.winners[0] === targetUser.username
  ) {
    medals.push({ code: "COIN_KING", icon: "💰", label: "Naudas maiss" });
  }

  const tokenKing = bestByField("tokens");
  if (
    tokenKing.max > 0 &&
    tokenKing.winners.length === 1 &&
    tokenKing.winners[0] === targetUser.username
  ) {
    medals.push({ code: "TOKEN_KING", icon: "🎟️", label: "Žetonu karalis" });
  }

  return medals;
}

function mergeMedals(dynamicMedals, userSpecialMedals) {
  const out = [];
  const seen = new Set();

  const add = (m) => {
    if (!m) return;
    const code = String(m.code || "").trim();
    if (!code) return;
    if (seen.has(code)) return;
    seen.add(code);
    out.push({ code, icon: m.icon || "🏅", label: m.label || code });
  };

  (Array.isArray(userSpecialMedals) ? userSpecialMedals : []).forEach(add);
  (Array.isArray(dynamicMedals) ? dynamicMedals : []).forEach(add);

  return out;
}

// ======== SEASON / HOF loģika ========
function championMedalCode(seasonId) {
  const sid = Number(seasonId) || 0;
  return sid === 1 ? "SEASON1_CHAMPION" : `SEASON${sid}_CHAMPION`;
}
function championMedalLabel(seasonId) {
  const sid = Number(seasonId) || 0;
  return sid === 1 ? "Sezona 1 čempions" : `Sezona ${sid} čempions`;
}
function defaultSeasonFinishedAt(seasonId) {
  const sid = Number(seasonId) || 0;
  if (sid === 1 && Number.isFinite(SEASON1_END_AT)) return SEASON1_END_AT;

  if (Number(seasonState?.id) === sid && Number.isFinite(seasonState?.endAt)) {
    return seasonState.endAt;
  }
  return Date.now();
}

function ensureSpecialMedals(user) {
  if (!user) return;
  if (!Array.isArray(user.specialMedals)) user.specialMedals = [];
}

function addSpecialMedalOnce(user, medal) {
  if (!user || !medal) return false;
  ensureSpecialMedals(user);
  const code = String(medal.code || "").trim();
  if (!code) return false;
  if (user.specialMedals.some((m) => m && m.code === code)) return false;
  user.specialMedals.push({
    code,
    icon: medal.icon || "🏅",
    label: medal.label || code,
    ts: typeof medal.ts === "number" ? medal.ts : Date.now(),
  });
  return true;
}

function removeSpecialMedalFromAllUsers(code) {
  if (!code) return false;
  let changed = false;
  for (const u of Object.values(USERS || {})) {
    if (!u || !u.username) continue;
    if (!Array.isArray(u.specialMedals)) u.specialMedals = [];
    const before = u.specialMedals.length;
    u.specialMedals = u.specialMedals.filter((m) => !(m && m.code === code));
    if (u.specialMedals.length !== before) changed = true;
  }
  return changed;
}

function upsertHallOfFameWinner(
  seasonId,
  username,
  scoreOverride,
  finishedAtOverride
) {
  const sid = Number(seasonId) || 0;
  if (sid <= 0) return { ok: false, message: "Nederīgs seasonId." };

  const uname = String(username || "").trim();
  if (!uname) return { ok: false, message: "Nav username." };

  const key = findUserKeyCaseInsensitive(uname);
  const champ = key ? USERS[key] : null;
  if (!champ) return { ok: false, message: "Lietotājs nav atrasts users.json." };

  const medalCode = championMedalCode(sid);
  const finishedAt =
    Number.isFinite(Number(finishedAtOverride)) && Number(finishedAtOverride) > 0
      ? Number(finishedAtOverride)
      : defaultSeasonFinishedAt(sid);

  const rankInfo = ensureRankFields(champ);

  const hofEntry = {
    seasonId: sid,
    username: champ.username,
    score:
      scoreOverride !== undefined && scoreOverride !== null && scoreOverride !== ""
        ? Math.max(0, Math.floor(Number(scoreOverride) || 0))
        : champ.score || 0,
    xp: champ.xp || 0,
    rankTitle: champ.rankTitle || rankInfo.title || "",
    rankLevel: champ.rankLevel || rankInfo.level || 1,
    avatarUrl: champ.avatarUrl || null,
    finishedAt,
    overriddenAt: Date.now(),
  };

  seasonStore.hallOfFame = (seasonStore.hallOfFame || []).filter(
    (x) => !(x && x.seasonId === sid)
  );
  seasonStore.hallOfFame.unshift(hofEntry);
  seasonStore.hallOfFame = seasonStore.hallOfFame.slice(0, 20);

  removeSpecialMedalFromAllUsers(medalCode);
  ensureSpecialMedals(champ);
  addSpecialMedalOnce(champ, {
    code: medalCode,
    icon: "🏆",
    label: championMedalLabel(sid),
    ts: finishedAt,
  });

  saveUsers(USERS);
  saveJsonAtomic(SEASONS_FILE, seasonStore);

  return { ok: true, hofEntry };
}

function getTop1UserByScore() {
  const all = Object.values(USERS || {});
  if (!all.length) return null;

  const sorted = all
    .filter((u) => u && u.username && !u.isBanned)
    .slice()
    .sort((a, b) => {
      const ds = (b.score || 0) - (a.score || 0);
      if (ds !== 0) return ds;
      const dx = (b.xp || 0) - (a.xp || 0);
      if (dx !== 0) return dx;
      return String(a.username).localeCompare(String(b.username));
    });

  return sorted[0] || null;
}

function finalizeSeasonIfNeeded(seasonId) {
  if (!seasonId) return null;
  const sid = Number(seasonId) || 0;
  if (sid <= 0) return null;

  if (seasonStore.hallOfFame.some((x) => x && x.seasonId === sid)) {
    return null;
  }

  const champ = getTop1UserByScore();
  if (!champ) return null;

  const rankInfo = ensureRankFields(champ);
  const finishedAt = Date.now();

  const hofEntry = {
    seasonId: sid,
    username: champ.username,
    score: champ.score || 0,
    xp: champ.xp || 0,
    rankTitle: champ.rankTitle || rankInfo.title || "",
    rankLevel: champ.rankLevel || rankInfo.level || 1,
    avatarUrl: champ.avatarUrl || null,
    finishedAt,
  };

  seasonStore.hallOfFame.unshift(hofEntry);
  seasonStore.hallOfFame = seasonStore.hallOfFame.slice(0, 20);

  addSpecialMedalOnce(champ, {
    code: championMedalCode(sid),
    icon: "🏆",
    label: championMedalLabel(sid),
    ts: finishedAt,
  });

  saveUsers(USERS);
  saveJsonAtomic(SEASONS_FILE, seasonStore);
  return hofEntry;
}

function resetCoinsAndTokensForAllUsers() {
  for (const u of Object.values(USERS || {})) {
    if (!u || !u.username) continue;
    u.coins = 0;
    u.tokens = 0;
  }
  saveUsers(USERS);

  wheelSyncTokenSlots(true);
  wheelEmitUpdate(true);
}

function computeNextSeasonEndAt(startAt, nextSeasonId) {
  const envEnd = process.env.SEASON_END_AT;
  if (envEnd) {
    const ts = new Date(envEnd).getTime();
    if (Number.isFinite(ts) && ts > startAt) return ts;
  }

  if (Number(nextSeasonId) === 2) {
    if (
      Number.isFinite(SEASON2_END_AT_DEFAULT) &&
      SEASON2_END_AT_DEFAULT > startAt
    ) {
      return SEASON2_END_AT_DEFAULT;
    }
  }

  return startAt + SEASON_DAYS * 24 * 60 * 60 * 1000;
}

function startSeasonFlow({ byAdminUsername } = {}) {
  const now = Date.now();
  const cur = seasonState || seasonStore.current;

  const curId = Number(cur?.id || 1) || 1;
  const curEnded = !!(cur?.endAt && now >= cur.endAt);

  if (!curEnded && cur && !cur.active) {
    cur.active = true;
    cur.startedAt = cur.startedAt || now;
    seasonStore.current = cur;
    seasonState = seasonStore.current;
    saveJsonAtomic(SEASONS_FILE, seasonStore);
    return {
      mode: "started_current",
      season: seasonState,
      hofEntry: null,
      didReset: false,
    };
  }

  if (!curEnded && cur && cur.active) {
    return {
      mode: "already_active",
      season: cur,
      hofEntry: null,
      didReset: false,
    };
  }

  const hofEntry = finalizeSeasonIfNeeded(curId);

  const nextId = curId + 1;
  const nextStart = now;
  const nextEnd = computeNextSeasonEndAt(nextStart, nextId);

  seasonState = {
    id: nextId,
    name: `SEZONA ${nextId}`,
    active: true,
    startedAt: nextStart,
    endAt: nextEnd,
  };

  seasonStore.current = seasonState;
  saveJsonAtomic(SEASONS_FILE, seasonStore);

  let didReset = false;
  if (RESET_COINS_TOKENS_ON_ROLLOVER) {
    resetCoinsAndTokensForAllUsers();
    didReset = true;
  }

  if (byAdminUsername) {
    console.log(`SEASON rollover by ${byAdminUsername}: now ${seasonState.name}`);
  }

  return { mode: "rolled_next", season: seasonState, hofEntry, didReset };
}

// ======== JWT helperi ========
function buildMePayload(u) {
  const rankInfo = ensureRankFields(u);
  ensureDuelEloFields(u);
  const dynamicMedals = computeMedalsForUser(u);
  const medals = mergeMedals(dynamicMedals, u.specialMedals);

  const xp = u.xp || 0;
  const minXp = Number(rankInfo.minXp) || 0;
  const nextMinXp =
    rankInfo.nextMinXp === null || rankInfo.nextMinXp === undefined
      ? null
      : Number(rankInfo.nextMinXp) || null;

  const need =
    nextMinXp && Number.isFinite(nextMinXp) && nextMinXp > minXp ? nextMinXp - minXp : 0;
  const inLevel = Math.max(0, xp - minXp);
  const pct = need > 0 ? Math.max(0, Math.min(100, (inLevel / need) * 100)) : 100;
  const toNext = need > 0 ? Math.max(0, nextMinXp - xp) : 0;

  return {
    username: u.username,
    xp,
    score: u.score || 0,
    coins: u.coins || 0,
    tokens: u.tokens || 0,
    streak: u.streak || 0,
    bestStreak: u.bestStreak || 0,
    duelElo: u.duelElo,
    duelEloGames: u.duelEloGames || 0,
    rankTitle: u.rankTitle || rankInfo.title,
    rankLevel: u.rankLevel || rankInfo.level,
    rankColor: u.rankColor || rankInfo.color,
    rankMinXp: minXp,
    rankNextMinXp: nextMinXp, // null => MAX rank
    rankInLevelXp: inLevel,
    rankNeedXp: need, // 0 => MAX rank
    rankToNextXp: toNext,
    rankProgressPct: Math.round(pct * 10) / 10,
    rankIsMax: !!rankInfo.isMax,
    tokenPriceCoins: getTokenPrice(u),
    medals,
    avatarUrl: u.avatarUrl || null,
    supporter: !!u.supporter,
    revealLetterCostCoins: REVEAL_LETTER_COST_COINS,
  };
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = String(authHeader).replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ message: "Nav token" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = USERS[payload.username];
    if (!user)
      return res.status(401).json({ message: "Lietotājs nav atrasts" });
    if (user.isBanned) {
      return res
        .status(403)
        .json({ message: "Lietotājs ir nobanots no VĀRDU ZONAS." });
    }
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ message: "Nederīgs token" });
  }
}

// ======== Express + Socket.IO ========
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(cors(corsOptions));
app.use(express.json({ limit: BODY_JSON_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: BODY_URLENC_LIMIT }));

app.use((err, req, res, next) => {
  if (err && (err.type === "entity.too.large" || err.status === 413)) {
    return res.status(413).json({
      message:
        "Payload Too Large: pieprasījums ir par lielu. Samazini failu vai palielini BODY_JSON_LIMIT serverī.",
    });
  }
  return next(err);
});

const HAS_STATIC_INDEX = fs.existsSync(STATIC_INDEX);

// Health / root
app.get("/", (_req, res) => {
  if (HAS_STATIC_INDEX) return res.sendFile(STATIC_INDEX);
  return res.send("VĀRDU ZONA OK");
});
app.get("/health", (_req, res) => res.json({ ok: true }));
app.post("/logout", (_req, res) => res.json({ ok: true }));

if (HAS_STATIC_INDEX) {
  app.use(express.static(STATIC_DIR));
  // Backward-compat for older /wordle URLs (Hostinger -> Render)
  app.use("/wordle", express.static(STATIC_DIR));
}

// wheel state
app.get("/wheel/state", (_req, res) => {
  res.json(publicWheelState());
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors:
    CORS_ORIGINS === "*"
      ? { origin: "*", methods: ["GET", "POST"] }
      : { origin: CORS_ORIGINS, methods: ["GET", "POST"], credentials: true },
});

// ======== ONLINE saraksts ========
const onlineBySocket = new Map(); // socket.id -> username

function getMiniUserPayload(username) {
  const u = USERS[username];
  if (!u) {
    return {
      username,
      avatarUrl: null,
      rankLevel: 1,
      rankTitle: "—",
      rankColor: "#9CA3AF",
      supporter: false,
    };
  }
  const info = ensureRankFields(u);
  return {
    username,
    avatarUrl: u.avatarUrl || null,
    rankLevel: u.rankLevel || info.level || 1,
    rankTitle: u.rankTitle || info.title || "—",
    rankColor: u.rankColor || info.color || "#9CA3AF",
    supporter: !!u.supporter,
  };
}

let lastOnlineSig = "";
function broadcastOnlineList(force = false) {
  const uniq = Array.from(new Set(onlineBySocket.values()))
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  const users = uniq.map((username) => getMiniUserPayload(username));

  const sig = users
    .map(
      (u) =>
        `${u.username}|${u.avatarUrl || ""}|${u.rankLevel || 0}|${
          u.rankTitle || ""
        }|${u.supporter ? 1 : 0}`
    )
    .join(";");

  if (!force && sig === lastOnlineSig) return;
  lastOnlineSig = sig;

  io.emit("onlineList", { count: users.length, users });
}
setInterval(() => broadcastOnlineList(false), 30 * 1000);

// ======== LEADERBOARD (TOP10) ========
function computeTop10Leaderboard() {
  const arr = Object.values(USERS || {})
    .filter((u) => u && u.username && !u.isBanned)
    .slice();

  arr.forEach((u) => ensureRankFields(u));

  arr.sort((a, b) => {
    const ds = (b.score || 0) - (a.score || 0);
    if (ds !== 0) return ds;
    const dx = (b.xp || 0) - (a.xp || 0);
    if (dx !== 0) return dx;
    return String(a.username).localeCompare(String(b.username));
  });

  return arr.slice(0, 10).map((u, idx) => ({
    place: idx + 1,
    username: u.username,
    score: u.score || 0,
    xp: u.xp || 0,
    rankTitle: u.rankTitle || "—",
    rankLevel: u.rankLevel || 1,
    rankColor: u.rankColor || "#9CA3AF",
    avatarUrl: u.avatarUrl || null,
    supporter: !!u.supporter,
  }));
}

let lastLbSig = "";
function broadcastLeaderboard(force = false) {
  const top = computeTop10Leaderboard();
  const sig = top
    .map(
      (u) =>
        `${u.place}|${u.username}|${u.score}|${u.xp}|${u.rankLevel}|${
          u.avatarUrl || ""
        }|${u.supporter ? 1 : 0}`
    )
    .join(";");

  if (!force && sig === lastLbSig) return;
  lastLbSig = sig;

  io.emit("leaderboard:update", top);
}
setInterval(() => broadcastLeaderboard(false), 45 * 1000);

// === Admin & čata helperi ===
function broadcastSystemMessage(text) {
  io.emit("chatMessage", { username: "SYSTEM", text, ts: Date.now() });
}

// ======== DM helperi ========
function ensureDm(user) {
  if (!user || typeof user !== "object") return null;
  if (!user.dm || typeof user.dm !== "object") user.dm = {};
  if (!user.dm.threads || typeof user.dm.threads !== "object") user.dm.threads = {};
  if (!user.dm.unread || typeof user.dm.unread !== "object") user.dm.unread = {};
  if (!user.dm.lastRead || typeof user.dm.lastRead !== "object") user.dm.lastRead = {};

  // migrācija/clean-up: veci bugaini keyi (piem. "[object Object]")
  try {
    for (const k of Object.keys(user.dm.threads)) {
      const ks = String(k || "").trim();
      if (!ks || ks.startsWith("[object")) delete user.dm.threads[k];
    }
    for (const k of Object.keys(user.dm.unread)) {
      const ks = String(k || "").trim();
      if (!ks || ks.startsWith("[object")) delete user.dm.unread[k];
    }
    for (const k of Object.keys(user.dm.lastRead)) {
      const ks = String(k || "").trim();
      if (!ks || ks.startsWith("[object")) delete user.dm.lastRead[k];
    }
  } catch {}

  // Normalizācija: apvienojam thread/unread keyus case-insensitive, lai nav dubult-threadi ("Bugats" vs "bugats").
  try {
    const canonName = (name) => {
      const raw = String(name || "").trim();
      if (!raw) return "";
      const key = findUserKeyCaseInsensitive(raw);
      const u = key ? USERS[key] : null;
      return (u && u.username) || raw;
    };

    // threads: pārliekam uz kanonisko key + merge
    const newThreads = {};
    for (const [k, arr] of Object.entries(user.dm.threads || {})) {
      const ck = canonName(k);
      if (!ck) continue;
      const list = Array.isArray(arr) ? arr.filter(Boolean) : [];
      if (!newThreads[ck]) newThreads[ck] = [];
      newThreads[ck].push(...list);
    }
    // sakārtojam pēc ts un nogriežam limitu
    for (const [k, arr] of Object.entries(newThreads)) {
      arr.sort((a, b) => (Number(a?.ts) || 0) - (Number(b?.ts) || 0));
      if (arr.length > DM_THREAD_MAX) newThreads[k] = arr.slice(-DM_THREAD_MAX);
    }
    user.dm.threads = newThreads;

    // unread: apvienojam (sum) uz kanonisko key
    const newUnread = {};
    for (const [k, v] of Object.entries(user.dm.unread || {})) {
      const ck = canonName(k);
      if (!ck) continue;
      newUnread[ck] = Math.max(0, Number(newUnread[ck]) || 0) + Math.max(0, Number(v) || 0);
    }
    user.dm.unread = newUnread;

    // lastRead: ņemam max uz kanonisko key
    const newLastRead = {};
    for (const [k, v] of Object.entries(user.dm.lastRead || {})) {
      const ck = canonName(k);
      if (!ck) continue;
      const ts = Math.max(0, Number(v) || 0);
      newLastRead[ck] = Math.max(Number(newLastRead[ck]) || 0, ts);
    }
    user.dm.lastRead = newLastRead;
  } catch {}

  return user.dm;
}

function dmThreadKeyFor(userA, userB) {
  // saglabājam thread zem “other username” (string), lai frontā vienkārši atvērt
  const getName = (x) => {
    if (typeof x === "string") return x.trim();
    if (x && typeof x === "object" && typeof x.username === "string") return x.username.trim();
    return "";
  };
  return getName(userB);
}

function dmZeroUnreadCaseInsensitive(dm, otherUsername) {
  if (!dm || typeof dm !== "object") return;
  if (!dm.unread || typeof dm.unread !== "object") dm.unread = {};
  const target = String(otherUsername || "").trim();
  if (!target) return;
  const t = target.toLowerCase();
  for (const k of Object.keys(dm.unread)) {
    if (String(k).toLowerCase() === t) dm.unread[k] = 0;
  }
  dm.unread[target] = 0;
}

function dmSanitizeText(raw) {
  if (typeof raw !== "string") return "";
  let t = raw.trim();
  if (!t) return "";
  if (t.length > DM_MAX_LEN) t = t.slice(0, DM_MAX_LEN);
  return t;
}

function dmComputeUnread(dm) {
  const byUser = dm?.unread && typeof dm.unread === "object" ? dm.unread : {};
  let total = 0;
  for (const v of Object.values(byUser)) total += Math.max(0, Number(v) || 0);
  // bonus: dodam inbox preview (front-end var uzreiz uzbūvēt “Inbox” pēc refresh)
  let threads = [];
  try {
    const th = dm?.threads && typeof dm.threads === "object" ? dm.threads : {};
    const keys = new Set([...Object.keys(th), ...Object.keys(byUser)]);
    for (const withUser of keys) {
      const arr = Array.isArray(th?.[withUser]) ? th[withUser] : [];
      const last = arr.length ? arr[arr.length - 1] : null;
      threads.push({
        with: withUser,
        unread: Math.max(0, Number(byUser?.[withUser]) || 0),
        lastTs: Number(last?.ts) || 0,
        lastFrom: last?.from || "",
        lastText: last?.text ? String(last.text).slice(0, 80) : "",
      });
    }
    threads.sort(
      (a, b) =>
        (b.unread - a.unread) ||
        (b.lastTs - a.lastTs) ||
        String(a.with).localeCompare(String(b.with))
    );
    threads = threads.slice(0, 60);
  } catch {}
  return { total, byUser, threads };
}

function dmPushMessage(fromUser, toUser, text) {
  const from = fromUser?.username;
  const to = toUser?.username;
  if (!from || !to) return null;

  const dmFrom = ensureDm(fromUser);
  const dmTo = ensureDm(toUser);
  if (!dmFrom || !dmTo) return null;

  const msg = {
    id: crypto.randomBytes(8).toString("hex"),
    from,
    to,
    text,
    ts: Date.now(),
  };

  const keyFrom = dmThreadKeyFor(fromUser, toUser);
  const keyTo = dmThreadKeyFor(toUser, fromUser);
  if (!keyFrom || !keyTo) return null;

  if (!Array.isArray(dmFrom.threads[keyFrom])) dmFrom.threads[keyFrom] = [];
  if (!Array.isArray(dmTo.threads[keyTo])) dmTo.threads[keyTo] = [];

  dmFrom.threads[keyFrom].push(msg);
  dmTo.threads[keyTo].push(msg);

  if (dmFrom.threads[keyFrom].length > DM_THREAD_MAX) {
    dmFrom.threads[keyFrom] = dmFrom.threads[keyFrom].slice(-DM_THREAD_MAX);
  }
  if (dmTo.threads[keyTo].length > DM_THREAD_MAX) {
    dmTo.threads[keyTo] = dmTo.threads[keyTo].slice(-DM_THREAD_MAX);
  }

  // increment unread only saņēmējam
  dmTo.unread[keyTo] = Math.max(0, Number(dmTo.unread[keyTo]) || 0) + 1;

  return msg;
}

function kickUserByName(username, reason) {
  const ids = [];
  for (const [sid, uname] of onlineBySocket.entries()) {
    if (uname === username) ids.push(sid);
  }

  for (const sid of ids) {
    const s = io.sockets.sockets.get(sid);
    if (s) {
      try {
        s.emit("forceDisconnect", { reason: reason || "kick" });
      } catch {}
      s.disconnect(true);
    }
    onlineBySocket.delete(sid);
  }

  broadcastOnlineList(true);
}

function handleAdminCommand(raw, adminUser, adminSocket) {
  const parts = raw.slice(1).trim().split(/\s+/);
  const cmd = (parts[0] || "").toLowerCase();
  const targetName = parts[1];
  const arg = parts[2];

  if (!cmd) {
    adminSocket.emit("chatMessage", {
      username: "SYSTEM",
      text: "Komanda nav norādīta.",
      ts: Date.now(),
    });
    return;
  }

  if (["ban", "unban", "kick", "mute", "unmute"].includes(cmd) && !targetName) {
    adminSocket.emit("chatMessage", {
      username: "SYSTEM",
      text: "Norādi lietotājvārdu. Piem.: /kick Nick",
      ts: Date.now(),
    });
    return;
  }

  const key = targetName ? findUserKeyCaseInsensitive(targetName) : null;
  const target = key ? USERS[key] : null;

  switch (cmd) {
    case "kick":
      if (!target) {
        adminSocket.emit("chatMessage", {
          username: "SYSTEM",
          text: `Lietotājs '${targetName}' nav atrasts.`,
          ts: Date.now(),
        });
        return;
      }
      kickUserByName(target.username, "kick");
      broadcastSystemMessage(
        `Admin ${adminUser.username} izmeta lietotāju ${target.username}.`
      );
      break;

    case "ban":
      if (!target) {
        adminSocket.emit("chatMessage", {
          username: "SYSTEM",
          text: `Lietotājs '${targetName}' nav atrasts.`,
          ts: Date.now(),
        });
        return;
      }
      target.isBanned = true;
      saveUsers(USERS);
      kickUserByName(target.username, "ban");
      broadcastSystemMessage(
        `Admin ${adminUser.username} nobanoja lietotāju ${target.username}.`
      );
      wheelSyncTokenSlots(true);
      wheelEmitUpdate(true);
      break;

    case "unban":
      if (!target) {
        adminSocket.emit("chatMessage", {
          username: "SYSTEM",
          text: `Lietotājs '${targetName}' nav atrasts.`,
          ts: Date.now(),
        });
        return;
      }
      target.isBanned = false;
      saveUsers(USERS);
      broadcastSystemMessage(
        `Admin ${adminUser.username} atbanoja lietotāju ${target.username}.`
      );
      wheelSyncTokenSlots(true);
      wheelEmitUpdate(true);
      break;

    case "mute": {
      if (!target) {
        adminSocket.emit("chatMessage", {
          username: "SYSTEM",
          text: `Lietotājs '${targetName}' nav atrasts.`,
          ts: Date.now(),
        });
        return;
      }
      const minutesRaw = parseInt(arg || "5", 10);
      const mins = Number.isNaN(minutesRaw)
        ? 5
        : Math.max(1, Math.min(1440, minutesRaw));
      target.mutedUntil = Date.now() + mins * 60 * 1000;
      saveUsers(USERS);
      broadcastSystemMessage(
        `Admin ${adminUser.username} uzlika mute lietotājam ${target.username} uz ${mins} min.`
      );
      break;
    }

    case "unmute":
      if (!target) {
        adminSocket.emit("chatMessage", {
          username: "SYSTEM",
          text: `Lietotājs '${targetName}' nav atrasts.`,
          ts: Date.now(),
        });
        return;
      }
      target.mutedUntil = 0;
      saveUsers(USERS);
      broadcastSystemMessage(
        `Admin ${adminUser.username} noņēma mute lietotājam ${target.username}.`
      );
      break;

    case "seasonstart": {
      if (!isAdminUser(adminUser)) {
        adminSocket.emit("chatMessage", {
          username: "SYSTEM",
          text: "Tikai admins var startēt sezonu.",
          ts: Date.now(),
        });
        return;
      }

      const result = startSeasonFlow({ byAdminUsername: adminUser.username });

      if (result.mode === "already_active") {
        adminSocket.emit("chatMessage", {
          username: "SYSTEM",
          text: `${result.season.name} jau ir aktīva.`,
          ts: Date.now(),
        });
        return;
      }

      const endStr = result.season.endAt
        ? new Date(result.season.endAt).toLocaleString("lv-LV", { timeZone: TZ })
        : "—";

      if (result.mode === "rolled_next") {
        if (result.hofEntry) {
          broadcastSystemMessage(
            `🏆 Sezona ${result.hofEntry.seasonId} čempions: ${result.hofEntry.username} (score ${result.hofEntry.score}). Ierakstīts Hall of Fame!`
          );
          io.emit("seasonHofUpdate", { top: seasonStore.hallOfFame[0] || null });
        }

        broadcastSystemMessage(
          `📢 ${result.season.name} ir sākusies! (beigsies: ${endStr})${
            result.didReset ? " Coins + žetoni visiem ir resetoti." : ""
          }`
        );
      } else {
        broadcastSystemMessage(
          `📢 ${result.season.name} ir sākusies! (beigsies: ${endStr})`
        );
      }

      io.emit("seasonUpdate", result.season);

      adminSocket.emit("chatMessage", {
        username: "SYSTEM",
        text: `${result.season.name} ir aktīva.`,
        ts: Date.now(),
      });
      break;
    }

    case "seasononline": {
      const now = Date.now();
      const endTs = seasonState?.endAt || 0;
      let text;

      if (!seasonState?.active) {
        if (!endTs) {
          text = `${
            seasonState?.name || "SEZONA"
          } vēl nav sākusies. Beigu datums nav iestatīts.`;
        } else {
          const endStr = new Date(endTs).toLocaleString("lv-LV", {
            timeZone: TZ,
          });
          text = `${seasonState.name} nav aktīva. Plānotās beigas: ${endStr}.`;
        }
      } else if (!endTs) {
        text = `${seasonState.name} ir aktīva, bet beigu datums nav iestatīts.`;
      } else if (now >= endTs) {
        const endStr = new Date(endTs).toLocaleString("lv-LV", {
          timeZone: TZ,
        });
        text = `${seasonState.name} jau ir beigusies (beidzās ${endStr}).`;
      } else {
        const diffMs = endTs - now;
        const totalSec = Math.floor(diffMs / 1000);
        const days = Math.floor(totalSec / (24 * 3600));
        const hours = Math.floor((totalSec % (24 * 3600)) / 3600);
        const minsInt = Math.floor((totalSec % 3600) / 60);
        const secs = totalSec % 60;

        const endStr = new Date(endTs).toLocaleString("lv-LV", {
          timeZone: TZ,
        });

        text = `${seasonState.name} ir aktīva. Līdz sezonas beigām: ${days}d ${hours}h ${minsInt}m ${secs}s (līdz ${endStr}).`;
      }

      adminSocket.emit("chatMessage", {
        username: "SYSTEM",
        text,
        ts: Date.now(),
      });
      break;
    }

    case "hofset": {
      // /hofset <seasonId> <username> [score]
      const sid = parseInt(parts[1] || "", 10);
      const uname = String(parts[2] || "").trim();
      const scoreOverride = parts[3];

      if (!Number.isFinite(sid) || sid <= 0 || !uname) {
        adminSocket.emit("chatMessage", {
          username: "SYSTEM",
          text: "Lietošana: /hofset <seasonId> <username> [score]",
          ts: Date.now(),
        });
        return;
      }

      const r = upsertHallOfFameWinner(sid, uname, scoreOverride, null);
      if (!r.ok) {
        adminSocket.emit("chatMessage", {
          username: "SYSTEM",
          text: `HOF error: ${r.message}`,
          ts: Date.now(),
        });
        return;
      }

      io.emit("seasonHofUpdate", { top: seasonStore.hallOfFame[0] || null });

      adminSocket.emit("chatMessage", {
        username: "SYSTEM",
        text: `OK: Sezona ${sid} čempions = ${r.hofEntry.username} (score ${r.hofEntry.score}).`,
        ts: Date.now(),
      });
      break;
    }

    default:
      adminSocket.emit("chatMessage", {
        username: "SYSTEM",
        text:
          "Nezināma komanda. Pieejams: /kick, /ban, /unban, /mute <min>, /unmute, /seasonstart, /seasononline, /hofset <sid> <username> [score].",
        ts: Date.now(),
      });
  }
}

// ======== AUTH ENDPOINTI ========
const DEVICE_SIGNUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const DEVICE_SIGNUP_MAX = 1; // max konti 24h uz vienu deviceId
const DUEL_ELO_DEFAULT = 1000;
const DUEL_ELO_K_BASE = 32;
const DUEL_ELO_K_NEWBIE = 40; // pirmajās spēlēs ātrāk stabilizējas

function getDeviceIdFromReq(req) {
  const h =
    (req && req.headers && (req.headers["x-vz-device-id"] || req.headers["x-device-id"])) || "";
  const b = req && req.body && (req.body.deviceId || req.body.deviceID || req.body.did);
  const raw = typeof b === "string" && b.trim() ? b : typeof h === "string" ? h : "";
  const s = String(raw || "").trim();
  if (!s) return "";
  // vienkāršs, drošs formāts (UUID/slug)
  if (s.length < 8 || s.length > 80) return "";
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) return "";
  return s;
}

function countRecentSignupsForDeviceId(deviceId, now = Date.now()) {
  if (!deviceId) return 0;
  let n = 0;
  for (const u of Object.values(USERS || {})) {
    if (!u || typeof u !== "object") continue;
    const createdAt = Number(u.createdAt) || 0;
    if (!createdAt) continue;
    if (now - createdAt > DEVICE_SIGNUP_WINDOW_MS) continue;
    if (u.createdDeviceId && String(u.createdDeviceId) === deviceId) {
      n++;
      continue;
    }
    const ids = Array.isArray(u.deviceIds) ? u.deviceIds : [];
    if (ids.includes(deviceId)) n++;
  }
  return n;
}

function ensureDuelEloFields(u) {
  if (!u) return { elo: DUEL_ELO_DEFAULT, games: 0 };
  if (!Number.isFinite(u.duelElo)) u.duelElo = DUEL_ELO_DEFAULT;
  if (!Number.isFinite(u.duelEloGames)) {
    const w = Number(u.duelsWon) || 0;
    const l = Number(u.duelsLost) || 0;
    u.duelEloGames = Math.max(0, w + l);
  }
  return { elo: u.duelElo, games: u.duelEloGames };
}

function duelEloExpected(ra, rb) {
  // 1 / (1 + 10^((Rb-Ra)/400))
  return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}

function duelEloK(u) {
  const g = Number(u?.duelEloGames) || 0;
  return g < 20 ? DUEL_ELO_K_NEWBIE : DUEL_ELO_K_BASE;
}

function applyDuelEloWinLoss(winner, loser) {
  if (!winner || !loser) return;
  ensureDuelEloFields(winner);
  ensureDuelEloFields(loser);

  const ra = Number(winner.duelElo) || DUEL_ELO_DEFAULT;
  const rb = Number(loser.duelElo) || DUEL_ELO_DEFAULT;
  const ea = duelEloExpected(ra, rb);
  const eb = 1 - ea;

  const ka = duelEloK(winner);
  const kb = duelEloK(loser);

  const ra2 = ra + ka * (1 - ea);
  const rb2 = rb + kb * (0 - eb);

  winner.duelElo = Math.round(ra2);
  loser.duelElo = Math.round(rb2);
  winner.duelEloGames = (Number(winner.duelEloGames) || 0) + 1;
  loser.duelEloGames = (Number(loser.duelEloGames) || 0) + 1;
}

async function signupHandler(req, res) {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res
      .status(400)
      .json({ message: "Nepieciešams username un password" });
  }

  const name = String(username).trim();
  if (!/^[a-zA-Z0-9_\-]{3,20}$/.test(name)) {
    return res.status(400).json({
      message: "Nickname: 3-20 simboli, tikai burti/cipari/ - _",
    });
  }
  if (USERS[name]) {
    return res.status(400).json({ message: "Šāds lietotājs jau eksistē" });
  }

  // Anti-alt: 24h limits uz ierīci (deviceId)
  const deviceId = getDeviceIdFromReq(req);
  if (deviceId) {
    const recent = countRecentSignupsForDeviceId(deviceId, Date.now());
    if (recent >= DEVICE_SIGNUP_MAX) {
      return res.status(429).json({
        message: "No šīs ierīces pēdējo 24h laikā jau izveidots konts. Pamēģini vēlāk.",
        code: "DEVICE_SIGNUP_LIMIT",
      });
    }
  }

  const hash = await bcrypt.hash(password, 10);
  const now = Date.now();

  const user = {
    username: name,
    passwordHash: hash,
    createdAt: now,
    createdDeviceId: deviceId || null,
    deviceIds: deviceId ? [deviceId] : [],
    xp: 0,
    score: 0,
    coins: 0,
    tokens: 0,
    streak: 0,
    bestStreak: 0,
    currentRound: null,
    lastActionAt: now,
    lastPassiveTickAt: now,
    isBanned: false,
    mutedUntil: 0,
    missionsDate: "",
    missions: [],
    totalGuesses: 0,
    bestWinTimeMs: 0,
    winsToday: 0,
    winsTodayDate: "",
    dailyLoginDate: "",
    duelsWon: 0,
    duelsLost: 0,
    duelElo: DUEL_ELO_DEFAULT,
    duelEloGames: 0,
    duelWinsToday: 0,
    duelWinsTodayDate: "",
    tokensBoughtToday: 0,
    tokensBoughtTodayDate: "",
    revealUsedToday: 0,
    revealUsedTodayDate: "",
    avatarUrl: null,
    supporter: false,
    dailyChest: { lastDate: "", streak: 0, totalOpens: 0 },
    specialMedals: [],
    lastChatAt: 0,
    lastChatText: "",
    lastChatTextAt: 0,
    lastGuessAt: 0,
    badLenCount: 0,
    badLenWindowStart: 0,
    guessBlockedUntil: 0,
  };

  ensureRankFields(user);
  ensureDailyMissions(user);
  ensureDailyChest(user);
  ensureSpecialMedals(user);
  resetDailyCountersIfNeeded(user);

  USERS[name] = user;
  saveUsers(USERS);

  broadcastLeaderboard(false);

  const token = jwt.sign({ username: name }, JWT_SECRET, { expiresIn: "30d" });
  return res.json({ ...buildMePayload(user), token });
}

app.post("/signup", signupHandler);

async function loginHandler(req, res) {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res
      .status(400)
      .json({ message: "Nepieciešams username un password" });
  }

  const name = String(username).trim();
  const user = USERS[name];
  if (!user) return res.status(400).json({ message: "Lietotājs nav atrasts" });

  if (user.isBanned) {
    return res.status(403).json({
      message:
        "Šis lietotājs ir nobanots no VĀRDU ZONAS. Sazinies ar Bugats.",
    });
  }

  const ok = await bcrypt.compare(password, user.passwordHash || "");
  if (!ok) return res.status(400).json({ message: "Nepareiza parole" });

  // Ierīces ID (ja ir) – uzkrājam pie user (noder nākotnē anti-abuse)
  const deviceId = getDeviceIdFromReq(req);
  if (deviceId) {
    if (!Array.isArray(user.deviceIds)) user.deviceIds = [];
    if (!user.deviceIds.includes(deviceId)) user.deviceIds.push(deviceId);
    while (user.deviceIds.length > 5) user.deviceIds.shift();
  }

  markActivity(user);
  ensureDailyMissions(user);
  resetWinsTodayIfNeeded(user);
  resetDailyCountersIfNeeded(user);
  ensureDailyChest(user);
  ensureSpecialMedals(user);
  ensureRankFields(user);

  if (typeof user.supporter !== "boolean") user.supporter = false;

  saveUsers(USERS);

  const token = jwt.sign({ username: name }, JWT_SECRET, { expiresIn: "30d" });
  return res.json({ ...buildMePayload(user), token });
}

app.post("/login", loginHandler);
app.post("/signin", loginHandler);

// ======== /me ========
app.get("/me", authMiddleware, (req, res) => {
  const u = req.user;
  markActivity(u);
  ensureDailyMissions(u);
  resetWinsTodayIfNeeded(u);
  resetDailyCountersIfNeeded(u);
  ensureDailyChest(u);
  ensureSpecialMedals(u);
  ensureRankFields(u);
  if (typeof u.supporter !== "boolean") u.supporter = false;
  saveUsers(USERS);
  res.json(buildMePayload(u));
});

// ======== AVATĀRA ENDPOINTS ========
app.post("/avatar", authMiddleware, (req, res) => {
  try {
    const user = req.user;
    const { avatar } = req.body || {};

    markActivity(user);

    if (!avatar || typeof avatar !== "string") {
      return res.status(400).json({ message: "Nav avatāra dati." });
    }
    if (!avatar.startsWith("data:image/")) {
      return res.status(400).json({ message: "Nekorekts avatāra formāts." });
    }

    if (avatar.length > AVATAR_MAX_CHARS) {
      return res.status(400).json({
        message: `Avatārs ir par lielu. Max: ~${Math.round(
          AVATAR_MAX_CHARS / (1024 * 1024)
        )}MB base64. Ieteikums: samazini bildi (piem. 512x512) un saglabā WEBP/JPG.`,
      });
    }

    user.avatarUrl = avatar;
    saveUsers(USERS);

    broadcastOnlineList(true);
    broadcastLeaderboard(false);

    return res.json({ ok: true, avatarUrl: user.avatarUrl });
  } catch (err) {
    console.error("POST /avatar kļūda:", err);
    return res
      .status(500)
      .json({ message: "Servera kļūda avatāra saglabāšanā." });
  }
});

// ======== Publiska profila API ========
function buildPublicProfilePayload(targetUser, requester) {
  const rankInfo = ensureRankFields(targetUser);
  const isAdmin = requester && isAdminUser(requester);
  ensureDuelEloFields(targetUser);

  const dynamicMedals = computeMedalsForUser(targetUser);
  const medals = mergeMedals(dynamicMedals, targetUser.specialMedals);

  const xp = targetUser.xp || 0;
  const minXp = Number(rankInfo.minXp) || 0;
  const nextMinXp =
    rankInfo.nextMinXp === null || rankInfo.nextMinXp === undefined
      ? null
      : Number(rankInfo.nextMinXp) || null;
  const need =
    nextMinXp && Number.isFinite(nextMinXp) && nextMinXp > minXp ? nextMinXp - minXp : 0;
  const inLevel = Math.max(0, xp - minXp);
  const pct = need > 0 ? Math.max(0, Math.min(100, (inLevel / need) * 100)) : 100;
  const toNext = need > 0 ? Math.max(0, nextMinXp - xp) : 0;

  const payload = {
    username: targetUser.username,
    xp,
    score: targetUser.score || 0,
    coins: targetUser.coins || 0,
    tokens: targetUser.tokens || 0,
    streak: targetUser.streak || 0,
    bestStreak: targetUser.bestStreak || 0,
    duelElo: targetUser.duelElo,
    duelEloGames: targetUser.duelEloGames || 0,
    rankTitle: targetUser.rankTitle || rankInfo.title,
    rankLevel: targetUser.rankLevel || rankInfo.level,
    rankColor: targetUser.rankColor || rankInfo.color,
    rankMinXp: minXp,
    rankNextMinXp: nextMinXp,
    rankInLevelXp: inLevel,
    rankNeedXp: need,
    rankToNextXp: toNext,
    rankProgressPct: Math.round(pct * 10) / 10,
    rankIsMax: !!rankInfo.isMax,
    medals,
    duelsWon: targetUser.duelsWon || 0,
    duelsLost: targetUser.duelsLost || 0,
    avatarUrl: targetUser.avatarUrl || null,
    supporter: !!targetUser.supporter,
  };

  if (isAdmin) {
    payload.isBanned = !!targetUser.isBanned;
    payload.mutedUntil = targetUser.mutedUntil || 0;
  }
  return payload;
}

app.get("/player/:username", authMiddleware, (req, res) => {
  const requester = req.user;
  const name = String(req.params.username || "").trim();
  const key = findUserKeyCaseInsensitive(name);
  const user = key ? USERS[key] : null;
  if (!user) return res.status(404).json({ message: "Lietotājs nav atrasts" });
  res.json(buildPublicProfilePayload(user, requester));
});
app.get("/profile/:username", authMiddleware, (req, res) => {
  const requester = req.user;
  const name = String(req.params.username || "").trim();
  const key = findUserKeyCaseInsensitive(name);
  const user = key ? USERS[key] : null;
  if (!user) return res.status(404).json({ message: "Lietotājs nav atrasts" });
  res.json(buildPublicProfilePayload(user, requester));
});

// ======== MISIJU ENDPOINTI ========
app.get("/missions", authMiddleware, (req, res) => {
  const user = req.user;
  markActivity(user);
  ensureDailyMissions(user);
  resetWinsTodayIfNeeded(user);
  resetDailyCountersIfNeeded(user);
  ensureDailyChest(user);
  ensureSpecialMedals(user);
  ensureRankFields(user);
  saveUsers(USERS);
  res.json(getPublicMissions(user));
});

app.post("/missions/claim", authMiddleware, (req, res) => {
  const user = req.user;
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ message: "Nav norādīts misijas ID" });

  markActivity(user);
  ensureDailyMissions(user);
  resetDailyCountersIfNeeded(user);
  ensureDailyChest(user);
  ensureSpecialMedals(user);

  const mission = (user.missions || []).find((m) => m.id === id);
  if (!mission) return res.status(404).json({ message: "Misija nav atrasta" });
  if (!mission.isCompleted)
    return res.status(400).json({ message: "Misija vēl nav pabeigta" });
  if (mission.isClaimed)
    return res.status(400).json({ message: "Balva jau saņemta" });

  const rw = mission.rewards || {};
  const addXp = rw.xp || 0;
  const addCoins = rw.coins || 0;
  const addTokens = rw.tokens || 0;

  user.xp = (user.xp || 0) + addXp;
  user.coins = (user.coins || 0) + addCoins;
  user.tokens = (user.tokens || 0) + addTokens;

  mission.isClaimed = true;
  ensureRankFields(user);

  saveUsers(USERS);
  broadcastLeaderboard(false);

  if (addTokens > 0) {
    wheelSyncTokenSlots(true);
    wheelEmitUpdate(true);
  }

  res.json({ me: buildMePayload(user), missions: getPublicMissions(user) });
});

// ======== DAILY CHEST ENDPOINTI ========
app.get("/chest/status", authMiddleware, (req, res) => {
  const user = req.user;
  markActivity(user);
  ensureDailyChest(user);
  saveUsers(USERS);

  const today = todayKey();
  const available = user.dailyChest.lastDate !== today;

  res.json({
    available,
    today,
    lastDate: user.dailyChest.lastDate || null,
    streak: user.dailyChest.streak || 0,
    nextAt: nextMidnightRigaTs(),
  });
});

app.post("/chest/open", authMiddleware, (req, res) => {
  const user = req.user;
  markActivity(user);
  ensureDailyChest(user);
  ensureDailyMissions(user);
  resetDailyCountersIfNeeded(user);

  const today = todayKey();
  const available = user.dailyChest.lastDate !== today;

  if (!available) {
    return res.status(409).json({
      message: "Daily Chest jau ir atvērts šodien. Nāc rīt!",
      nextAt: nextMidnightRigaTs(),
    });
  }

  const yesterdayKey = todayKey(new Date(Date.now() - 24 * 3600 * 1000));
  if (user.dailyChest.lastDate === yesterdayKey) user.dailyChest.streak += 1;
  else user.dailyChest.streak = 1;

  user.dailyChest.lastDate = today;
  user.dailyChest.totalOpens = (user.dailyChest.totalOpens || 0) + 1;

  const streak = user.dailyChest.streak;

  const coinsBase = 40 + crypto.randomInt(0, 81); // 40..120
  const xpBase = 10 + crypto.randomInt(0, 21); // 10..30

  const streakBonusCoins = Math.min(90, (streak - 1) * 12);
  const streakBonusXp = Math.min(35, (streak - 1) * 4);

  const coinsGain = coinsBase + streakBonusCoins;
  const xpGain = xpBase + streakBonusXp;

  const tokenChance = Math.min(0.25, 0.06 + streak * 0.01);
  const tokensGain = Math.random() < tokenChance ? 1 : 0;

  user.coins = (user.coins || 0) + coinsGain;
  user.xp = (user.xp || 0) + xpGain;
  user.tokens = (user.tokens || 0) + tokensGain;

  updateMissionsOnChestOpen(user);
  ensureRankFields(user);
  saveUsers(USERS);
  broadcastLeaderboard(false);

  if (tokensGain > 0) {
    wheelSyncTokenSlots(true);
    wheelEmitUpdate(true);
  }

  io.emit("chatMessage", {
    username: "SYSTEM",
    text: `🎁 ${user.username} atvēra Daily Chest: +${coinsGain} coins, +${xpGain} XP${
      tokensGain ? `, +${tokensGain} žetons` : ""
    } (streak ${user.dailyChest.streak})`,
    ts: Date.now(),
  });

  return res.json({
    ok: true,
    rewards: { coins: coinsGain, xp: xpGain, tokens: tokensGain },
    streak: user.dailyChest.streak,
    nextAt: nextMidnightRigaTs(),
    me: buildMePayload(user),
  });
});

// ======== SEZONA API ========
app.get("/season", authMiddleware, (_req, res) => {
  res.json({ ...seasonState, hallOfFameTop: seasonStore.hallOfFame[0] || null });
});
app.get("/season/state", (_req, res) => {
  res.json({ ...seasonState, hallOfFameTop: seasonStore.hallOfFame[0] || null });
});
app.get("/season/hof", authMiddleware, (_req, res) => {
  res.json(seasonStore.hallOfFame || []);
});
app.post("/season/hof/override", authMiddleware, (req, res) => {
  const admin = req.user;
  if (!isAdminUser(admin)) {
    return res.status(403).json({ message: "Tikai admins." });
  }

  const { seasonId, username, score, finishedAt } = req.body || {};
  const r = upsertHallOfFameWinner(seasonId, username, score, finishedAt);

  if (!r.ok) return res.status(400).json({ message: r.message });

  io.emit("seasonHofUpdate", { top: seasonStore.hallOfFame[0] || null });

  broadcastSystemMessage(
    `🏆 Hall of Fame labots: Sezona ${r.hofEntry.seasonId} čempions = ${r.hofEntry.username} (score ${r.hofEntry.score}).`
  );

  return res.json({
    ok: true,
    top: seasonStore.hallOfFame[0] || null,
    entry: r.hofEntry,
    hallOfFame: seasonStore.hallOfFame || [],
  });
});
app.post("/season/start", authMiddleware, (req, res) => {
  const user = req.user;
  if (!isAdminUser(user)) {
    return res.status(403).json({ message: "Tikai admins var startēt sezonu." });
  }

  const result = startSeasonFlow({ byAdminUsername: user.username });

  io.emit("seasonUpdate", result.season);
  if (result.mode === "rolled_next" && result.hofEntry) {
    io.emit("seasonHofUpdate", { top: seasonStore.hallOfFame[0] || null });
  }

  res.json({
    ...result.season,
    mode: result.mode,
    hofEntry: result.hofEntry || null,
    didReset: !!result.didReset,
  });
});

// ======== Spēles loģika ========
function pickRandomWord() {
  if (!WORDS.length) return { word: "BUGAT", len: 5 };
  const idx = crypto.randomInt(0, WORDS.length);
  const w = WORDS[idx] || "BUGAT";
  return { word: String(w).toUpperCase(), len: String(w).length };
}

function startNewRoundForUser(user) {
  const { word, len } = pickRandomWord();
  user.currentRound = {
    word,
    len,
    attemptsLeft: MAX_ATTEMPTS,
    finished: false,
    startedAt: Date.now(),

    // Ability: reveal 1 letter
    revealUsed: false,
    reveal: null,

    // (NEW) Lai reveal-letter neatver jau pareizi zināmu pozīciju
    knownCorrect: new Array(len).fill(false),

    // (NEW) Solo raunda vēsture, lai var atjaunot pēc refresh/disconnect
    history: [], // [{ guess, pattern, ts }]
  };
  return user.currentRound;
}

// ======== START ROUND ========
app.get("/start-round", authMiddleware, (req, res) => {
  const user = req.user;
  markActivity(user);
  ensureDailyMissions(user);
  ensureDailyChest(user);

  // ja ir aktīvs raunds — atgriežam to, plus reveal info
  if (user.currentRound && !user.currentRound.finished) {
    // migrācija drošībai
    if (typeof user.currentRound.revealUsed !== "boolean")
      user.currentRound.revealUsed = false;
    if (!user.currentRound.reveal || typeof user.currentRound.reveal !== "object")
      user.currentRound.reveal = null;
    if (!Array.isArray(user.currentRound.knownCorrect)) {
      const len = Math.max(0, Math.floor(user.currentRound.len || 0));
      user.currentRound.knownCorrect = len > 0 ? new Array(len).fill(false) : [];
    }
    if (!Array.isArray(user.currentRound.history)) user.currentRound.history = [];

    saveUsers(USERS);

    const revealUsed = !!user.currentRound.revealUsed;
    const reveal =
      revealUsed && user.currentRound.reveal
        ? {
            pos: user.currentRound.reveal.pos,
            letter: user.currentRound.reveal.letter,
          }
        : null;

    return res.json({
      len: user.currentRound.len,
      revealUsed,
      reveal,
      attemptsLeft: user.currentRound.attemptsLeft ?? null,
      startedAt: user.currentRound.startedAt ?? null,
      history: user.currentRound.history.slice(0, MAX_ATTEMPTS).map((h) => ({
        guess: h?.guess,
        pattern: h?.pattern,
        ts: h?.ts,
      })),
    });
  }

  // citādi sākam jaunu
  const round = startNewRoundForUser(user);
  saveUsers(USERS);
  return res.json({
    len: round.len,
    revealUsed: false,
    reveal: null,
    attemptsLeft: round.attemptsLeft ?? null,
    startedAt: round.startedAt ?? null,
    history: [],
  });
});

// ======== Ability: Atvērt 1 burtu (1x katrā raundā) ========
// POST /ability/reveal-letter
// Body: { avoid?: number[] }  // pozīcijas, ko klients grib izvairīties (piem. jau aizpildītās ailes)
app.post("/ability/reveal-letter", authMiddleware, (req, res) => {
  const user = req.user;
  markActivity(user);
  resetDailyCountersIfNeeded(user);

  // ja nav raunda vai ir beidzies — sākam jaunu
  if (!user.currentRound || user.currentRound.finished) {
    startNewRoundForUser(user);
  }
  const round = user.currentRound;

  if (!round || round.finished || round.attemptsLeft <= 0) {
    saveUsers(USERS);
    return res
      .status(400)
      .json({ message: "Raunds ir beidzies.", code: "ROUND_FINISHED" });
  }

  if (round.revealUsed) {
    return res.status(400).json({
      message: "Šajā raundā burts jau tika atvērts.",
      code: "ALREADY_USED",
    });
  }

  if (!Array.isArray(round.knownCorrect)) {
    const len = Math.max(0, Math.floor(round.len || 0));
    round.knownCorrect = len > 0 ? new Array(len).fill(false) : [];
  }

  const cost = REVEAL_LETTER_COST_COINS;
  if (!Number.isFinite(cost) || cost <= 0) {
    return res.status(500).json({
      message: "Servera konfigurācijas kļūda (REVEAL_LETTER_COST_COINS).",
      code: "CONFIG_ERROR",
    });
  }

  if ((user.coins || 0) < cost) {
    return res.status(400).json({
      message: "Nepietiek coins šai spējai.",
      code: "INSUFFICIENT_COINS",
      need: cost,
      have: user.coins || 0,
    });
  }

  const avoidRaw = req.body && Array.isArray(req.body.avoid) ? req.body.avoid : [];
  const avoid = new Set(
    avoidRaw
      .map((x) => Number(x))
      .filter((n) => Number.isInteger(n) && n >= 0 && n < round.len)
  );

  const allPos = [];
  for (let i = 0; i < round.len; i++) allPos.push(i);

  // prioritāte: atveram tikai tādu pozīciju, kas vēl nav zināma kā pareiza
  let pool = allPos.filter((i) => !avoid.has(i) && !round.knownCorrect?.[i]);
  if (!pool.length) pool = allPos;

  // ja pat pēc fallbacka visas pozīcijas jau ir zināmas kā pareizas, nav jēgas atvērt
  const unknownAny = allPos.some((i) => !round.knownCorrect?.[i]);
  if (!unknownAny) {
    saveUsers(USERS);
    return res.status(400).json({
      message: "Visi burti jau ir atminēti pareizajās vietās.",
      code: "ALL_KNOWN",
    });
  }

  const pos = pool[crypto.randomInt(0, pool.length)];
  const letter = String(round.word[pos] || "").toUpperCase();

  user.coins = (user.coins || 0) - cost;

  round.revealUsed = true;
  round.reveal = { pos, letter, cost, ts: Date.now() };

  updateMissionsOnRevealUsed(user);
  saveUsers(USERS);

  return res.json({
    ok: true,
    len: round.len,
    pos,
    letter,
    cost,
    coins: user.coins || 0,
    tokens: user.tokens || 0,
  });
});

// ======== Guess / pattern ========
function buildPattern(secret, guess) {
  const sArr = secret.split("");
  const gArr = guess.split("");
  const result = new Array(gArr.length).fill("absent");

  const counts = {};
  for (const ch of sArr) counts[ch] = (counts[ch] || 0) + 1;

  for (let i = 0; i < gArr.length; i++) {
    if (gArr[i] === sArr[i]) {
      result[i] = "correct";
      counts[gArr[i]] -= 1;
    }
  }
  for (let i = 0; i < gArr.length; i++) {
    if (result[i] === "correct") continue;
    const ch = gArr[i];
    if (counts[ch] > 0) {
      result[i] = "present";
      counts[ch] -= 1;
    }
  }
  return result;
}

function enforceGuessRate(user) {
  const now = Date.now();

  if (user.guessBlockedUntil && now < user.guessBlockedUntil) {
    return {
      ok: false,
      status: 429,
      message: "Tu min pārāk haotiski. Pamēģini pēc dažām sekundēm.",
    };
  }

  if (user.lastGuessAt && now - user.lastGuessAt < GUESS_RATE_MS) {
    return {
      ok: false,
      status: 429,
      message: "Pārāk ātri. Mēģini vēlreiz pēc ~1s.",
    };
  }

  user.lastGuessAt = now;
  return { ok: true };
}

function trackBadLength(user) {
  const now = Date.now();
  if (
    !user.badLenWindowStart ||
    now - user.badLenWindowStart > BAD_LEN_WINDOW_MS
  ) {
    user.badLenWindowStart = now;
    user.badLenCount = 0;
  }
  user.badLenCount = (user.badLenCount || 0) + 1;
  if (user.badLenCount >= BAD_LEN_MAX) {
    user.guessBlockedUntil = now + BAD_LEN_BLOCK_MS;
    return true;
  }
  return false;
}

app.post("/guess", authMiddleware, (req, res) => {
  const user = req.user;
  markActivity(user);
  ensureDailyMissions(user);
  resetDailyCountersIfNeeded(user);
  ensureDailyChest(user);

  const gate = enforceGuessRate(user);
  if (!gate.ok) {
    saveUsers(USERS);
    return res.status(gate.status).json({ message: gate.message });
  }

  const guessRaw = (req.body?.guess || "").toString().trim().toUpperCase();
  if (!user.currentRound || user.currentRound.finished) {
    saveUsers(USERS);
    return res.status(400).json({ message: "Nav aktīva raunda" });
  }

  const round = user.currentRound;
  if (!Array.isArray(round.knownCorrect)) {
    const len2 = Math.max(0, Math.floor(round.len || 0));
    round.knownCorrect = len2 > 0 ? new Array(len2).fill(false) : [];
  }
  if (!Array.isArray(round.history)) round.history = [];

  if (guessRaw.length !== round.len) {
    const blocked = trackBadLength(user);
    saveUsers(USERS);
    return res.status(400).json({
      message: blocked
        ? `Vārdam jābūt ${round.len} burtiem. Tu pārāk bieži kļūdījies — īss locks.`
        : `Vārdam jābūt ${round.len} burtiem`,
    });
  }

  if (!GUESS_ALLOWED_RE.test(guessRaw)) {
    saveUsers(USERS);
    return res.status(400).json({
      message: "Minējumā drīkst būt tikai burti (A-Z + latviešu burti).",
    });
  }

  if (round.attemptsLeft <= 0) {
    round.finished = true;
    saveUsers(USERS);
    return res.json({
      pattern: buildPattern(round.word, guessRaw),
      win: false,
      finished: true,
      attemptsLeft: 0,
    });
  }

  user.totalGuesses = (user.totalGuesses || 0) + 1;

  const pattern = buildPattern(round.word, guessRaw);

  // (NEW) atzīmējam pozīcijas, kur burts jau ir pareizi atminēts
  for (let i = 0; i < round.len; i++) {
    if (guessRaw[i] && guessRaw[i] === round.word[i]) {
      round.knownCorrect[i] = true;
    }
  }

  round.attemptsLeft -= 1;

  const len = round.len;
  const isWin = guessRaw === round.word;
  const finished = isWin || round.attemptsLeft <= 0;

  let xpGain = 0;
  let coinsGain = 0;
  let winTimeMs = 0;
  let attemptsUsed = 0;

  if (isWin) {
    const prevStreak = user.streak || 0;
    user.streak = prevStreak + 1;

    resetWinsTodayIfNeeded(user);
    user.winsToday = (user.winsToday || 0) + 1;

    if (round.startedAt) {
      const winTime = Date.now() - round.startedAt;
      winTimeMs = winTime;
      if (!user.bestWinTimeMs || winTime < user.bestWinTimeMs) {
        user.bestWinTimeMs = winTime;
      }
    }

    xpGain = XP_PER_WIN_BASE;
    const extraLetters = Math.max(0, len - MIN_WORD_LEN);
    xpGain += XP_PER_LETTER_BONUS * extraLetters;

    const streakSteps = Math.min(user.streak - 1, XP_STREAK_MAX_STEPS);
    if (streakSteps > 0) xpGain += XP_PER_STREAK_STEP * streakSteps;

    coinsGain = COINS_PER_WIN_BASE;
    coinsGain += COINS_PER_LETTER_BONUS * extraLetters;

    const coinStreakBonus = Math.min(user.streak - 1, COINS_STREAK_MAX_BONUS);
    if (coinStreakBonus > 0) coinsGain += coinStreakBonus;

    user.xp = (user.xp || 0) + xpGain;
    user.score = (user.score || 0) + SCORE_PER_WIN;
    user.coins = (user.coins || 0) + coinsGain;

    user.bestStreak = Math.max(user.bestStreak || 0, user.streak || 0);

    ensureRankFields(user);

    io.emit("playerWin", {
      username: user.username,
      xpGain,
      coinsGain,
      rankTitle: user.rankTitle,
      rankLevel: user.rankLevel,
      rankColor: user.rankColor || "#9CA3AF",
      avatarUrl: user.avatarUrl || null,
      streak: user.streak || 0,
    });
  } else {
    if (finished) user.streak = 0;
  }

  round.finished = finished;

  try {
    round.history.push({ guess: guessRaw, pattern, ts: Date.now() });
    if (round.history.length > MAX_ATTEMPTS) round.history = round.history.slice(-MAX_ATTEMPTS);
  } catch {}

  attemptsUsed = Math.max(1, MAX_ATTEMPTS - (round.attemptsLeft || 0));
  updateMissionsOnGuess(user, {
    isWin,
    xpGain,
    winTimeMs,
    wordLen: len,
    attemptsUsed,
  });

  saveUsers(USERS);

  if (isWin) broadcastLeaderboard(false);

  res.json({
    pattern,
    win: isWin,
    finished,
    attemptsLeft: round.attemptsLeft,
    rewards: isWin ? { xpGain, coinsGain } : null,
  });
});

// ======== Token buy ========
app.post("/buy-token", authMiddleware, (req, res) => {
  const user = req.user;
  markActivity(user);
  ensureDailyMissions(user);
  resetDailyCountersIfNeeded(user);
  ensureDailyChest(user);

  const price = getTokenPrice(user);
  if ((user.coins || 0) < price) {
    saveUsers(USERS);
    return res.status(400).json({ message: "Nepietiek coins" });
  }

  user.coins = (user.coins || 0) - price;
  user.tokens = (user.tokens || 0) + 1;

  updateMissionsOnTokenBuy(user, 1);

  saveUsers(USERS);
  broadcastLeaderboard(false);

  wheelSyncTokenSlots(true);
  wheelEmitUpdate(true);

  io.emit("tokenBuy", { username: user.username, tokens: user.tokens || 0 });

  res.json({
    coins: user.coins,
    tokens: user.tokens,
    tokenPriceCoins: getTokenPrice(user),
  });
});

// ===== Leaderboard =====
app.get("/leaderboard", (_req, res) => {
  res.json(computeTop10Leaderboard());
});

// ===== DUEĻU HELPERI (Socket.IO pusē) =====
function getSocketByUsername(username) {
  for (const [sid, uname] of onlineBySocket.entries()) {
    if (uname === username) {
      const s = io.sockets.sockets.get(sid);
      if (s) return s;
    }
  }
  return null;
}

function finishDuel(duel, winnerName, reason) {
  if (!duel || duel.status === "finished") return;

  duel.status = "finished";
  duel.finishedReason = reason || "finished";
  duel.winner = winnerName || null;

  const [p1, p2] = duel.players;
  const s1 = getSocketByUsername(p1);
  const s2 = getSocketByUsername(p2);

  const u1 = USERS[p1];
  const u2 = USERS[p2];

  const rows1 = duel.rowsUsed?.[p1] ?? 0;
  const rows2 = duel.rowsUsed?.[p2] ?? 0;
  const left1 = duel.attemptsLeft?.[p1] ?? 0;
  const left2 = duel.attemptsLeft?.[p2] ?? 0;
  const scoreText = `${p1}: ${rows1}/${DUEL_MAX_ATTEMPTS} (left ${left1}) — ${p2}: ${rows2}/${DUEL_MAX_ATTEMPTS} (left ${left2})`;

  if (winnerName && u1 && u2) {
    const isRanked = duel.ranked !== false;
    // ELO snapshot pirms izmaiņām
    let eloBefore = null;
    if (isRanked) {
      ensureDuelEloFields(u1);
      ensureDuelEloFields(u2);
      eloBefore = { [p1]: u1.duelElo, [p2]: u2.duelElo };
    }

    const winner = USERS[winnerName];
    const loser = winnerName === p1 ? u2 : u1;

    if (winner) {
      winner.duelsWon = (winner.duelsWon || 0) + 1;
      winner.xp = (winner.xp || 0) + DUEL_REWARD_XP;
      winner.coins = (winner.coins || 0) + DUEL_REWARD_COINS;
      updateMissionsOnDuelWin(winner);
      ensureRankFields(winner);
    }
    if (loser) {
      loser.duelsLost = (loser.duelsLost || 0) + 1;
    }

    // Ranked ELO update (tikai, ja ir uzvarētājs)
    if (isRanked && winner && loser) {
      applyDuelEloWinLoss(winner, loser);
    }

    saveUsers(USERS);
    broadcastLeaderboard(false);

    const eloAfter = (duel.ranked !== false && u1 && u2)
      ? { [p1]: u1.duelElo, [p2]: u2.duelElo }
      : null;

    const eloDelta1 =
      eloBefore && eloAfter ? Number(eloAfter[p1] || 0) - Number(eloBefore[p1] || 0) : 0;
    const eloDelta2 =
      eloBefore && eloAfter ? Number(eloAfter[p2] || 0) - Number(eloBefore[p2] || 0) : 0;

    if (s1)
      s1.emit("duel.end", {
        duelId: duel.id,
        winner: winnerName,
        youWin: winnerName === p1,
        reason,
        opponent: p2,
        scoreText,
        len: duel.len,
        startedAt: duel.startedAt || null,
        expiresAt: duel.expiresAt || null,
        ranked: duel.ranked !== false,
        yourElo: eloAfter ? eloAfter[p1] : null,
        opponentElo: eloAfter ? eloAfter[p2] : null,
        eloDelta: eloAfter ? eloDelta1 : null,
      });
    if (s2)
      s2.emit("duel.end", {
        duelId: duel.id,
        winner: winnerName,
        youWin: winnerName === p2,
        reason,
        opponent: p1,
        scoreText,
        len: duel.len,
        startedAt: duel.startedAt || null,
        expiresAt: duel.expiresAt || null,
        ranked: duel.ranked !== false,
        yourElo: eloAfter ? eloAfter[p2] : null,
        opponentElo: eloAfter ? eloAfter[p1] : null,
        eloDelta: eloAfter ? eloDelta2 : null,
      });

    const other = winnerName === p1 ? p2 : p1;
    broadcastSystemMessage(`⚔️ ${winnerName} uzvarēja dueli pret ${other}!`);
  } else {
    if (s1)
      s1.emit("duel.end", {
        duelId: duel.id,
        winner: null,
        youWin: false,
        reason,
        opponent: p2,
        scoreText,
        len: duel.len,
        startedAt: duel.startedAt || null,
        expiresAt: duel.expiresAt || null,
        ranked: duel.ranked !== false,
      });
    if (s2)
      s2.emit("duel.end", {
        duelId: duel.id,
        winner: null,
        youWin: false,
        reason,
        opponent: p1,
        scoreText,
        len: duel.len,
        startedAt: duel.startedAt || null,
        expiresAt: duel.expiresAt || null,
        ranked: duel.ranked !== false,
      });
  }

  userToDuel.delete(p1);
  userToDuel.delete(p2);
  duels.delete(duel.id);
}

// Duēļu timeout watchdog
setInterval(() => {
  const now = Date.now();
  for (const duel of duels.values()) {
    // Pending invite timeout (citādi userToDuel var iestrēgt pēc ignorēta invite/refresh)
    if (duel.status === "pending" && duel.expiresAt && now >= duel.expiresAt) {
      finishDuel(duel, null, "declined");
      continue;
    }
    if (duel.status === "active" && duel.expiresAt && now >= duel.expiresAt) {
      finishDuel(duel, null, "timeout");
    }
  }
}, 1000);

// ===== DIENAS LOGIN BONUSS =====
const DAILY_LOGIN_COINS = 10;
function grantDailyLoginBonus(user) {
  if (!user) return 0;
  const today = todayKey();
  if (user.dailyLoginDate === today) return 0;
  user.dailyLoginDate = today;
  user.coins = (user.coins || 0) + DAILY_LOGIN_COINS;
  saveUsers(USERS);
  return DAILY_LOGIN_COINS;
}

// ===== SEZONAS AUTO-BEIGAS + AUTO-HOF =====
let seasonEndedBroadcasted = false;
setInterval(() => {
  const now = Date.now();
  if (!(seasonState?.endAt && now >= seasonState.endAt)) return;

  if (seasonState.active) {
    seasonState.active = false;
    seasonStore.current = seasonState;
    saveJsonAtomic(SEASONS_FILE, seasonStore);
    io.emit("seasonUpdate", seasonState);
    seasonEndedBroadcasted = false;
  }

  const hofEntry = finalizeSeasonIfNeeded(seasonState.id);
  if (hofEntry) {
    io.emit("seasonHofUpdate", { top: seasonStore.hallOfFame[0] || null });
    broadcastSystemMessage(
      `🏆 ${seasonState.name} čempions: ${hofEntry.username} (score ${hofEntry.score}). Ierakstīts Hall of Fame!`
    );
  }

  if (!seasonEndedBroadcasted) {
    const endStr = new Date(seasonState.endAt).toLocaleString("lv-LV", {
      timeZone: TZ,
    });
    broadcastSystemMessage(`⏳ ${seasonState.name} ir beigusies (${endStr}).`);
    io.emit("seasonUpdate", seasonState);
    seasonEndedBroadcasted = true;
  }
}, 1500);

// ======== Socket.IO auth middleware ========
function extractSocketToken(socket) {
  const fromAuth = socket?.handshake?.auth?.token;
  const fromQuery = socket?.handshake?.query?.token;

  const hdr = socket?.handshake?.headers?.authorization;
  const fromHeader =
    typeof hdr === "string" ? hdr.replace(/^Bearer\s+/i, "").trim() : "";

  const t = fromAuth || fromQuery || fromHeader;
  return t ? String(t).trim() : "";
}

io.use((socket, next) => {
  const nsp = socket.nsp?.name || "/";
  const token = extractSocketToken(socket);

  // /wheel: atļaujam arī bez token (read-only)
  if (nsp === "/wheel") {
    if (!token) return next();
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = USERS[payload.username];
      if (user && !user.isBanned) socket.data.user = user;
      return next();
    } catch {
      return next();
    }
  }

  if (!token) return next(new Error("Nav token"));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = USERS[payload.username];
    if (!user) return next(new Error("Lietotājs nav atrasts"));
    if (user.isBanned) return next(new Error("Lietotājs ir nobanots"));
    socket.data.user = user;
    return next();
  } catch {
    return next(new Error("Nederīgs token"));
  }
});

// ======== WHEEL namespace (/wheel) ========
wheelNsp = io.of("/wheel");

wheelNsp.use((socket, next) => {
  const token = extractSocketToken(socket);
  if (!token) return next();
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = USERS[payload.username];
    if (user && !user.isBanned) socket.data.user = user;
  } catch {}
  return next();
});

// initial token sync
wheelSyncTokenSlots(true);

wheelNsp.on("connection", (socket) => {
  const getMe = () => {
    const u = socket.data.user || null;
    return {
      username: u?.username || null,
      isAdmin: u ? isAdminUser(u) : false,
    };
  };

  socket.emit("wheel:me", getMe());
  socket.emit("wheel:update", publicWheelState());
  socket.emit("update", publicWheelState());

  const bind = (action, fn) => {
    socket.on(`wheel:${action}`, fn);
    socket.on(action, fn);
  };

  bind("auth", (payload = {}) => {
    const t = String(payload?.token || "").trim();
    if (!t) return wheelEmitError(socket, "Nav token.");
    try {
      const p = jwt.verify(t, JWT_SECRET);
      const user = USERS[p?.username];
      if (user && !user.isBanned) {
        socket.data.user = user;
      } else {
        socket.data.user = null;
      }
      socket.emit("wheel:me", getMe());
      socket.emit("wheel:update", publicWheelState());
      socket.emit("update", publicWheelState());
    } catch {
      wheelEmitError(socket, "Nederīgs token.");
    }
  });

  bind("join", () => {
    socket.emit("wheel:update", publicWheelState());
    socket.emit("update", publicWheelState());
  });

  bind("syncTokens", () => {
    const admin = wheelRequireAdmin(socket);
    if (!admin) return;
    if (wheelBlockIfSpinning(socket)) return;
    wheelSyncTokenSlots(true);
    wheelEmitUpdate(true);
  });

  function applyTokenChange(payload = {}, mode = "auto") {
    const admin = wheelRequireAdmin(socket);
    if (!admin) return;
    if (wheelBlockIfSpinning(socket)) return;

    const username = String(
      payload.username ?? payload.user ?? payload.name ?? payload.nick ?? ""
    )
      .trim()
      .slice(0, 30);

    if (!username) return wheelEmitError(socket, "Nav username.");

    const key = findUserKeyCaseInsensitive(username);
    const target = key ? USERS[key] : null;
    if (!target) return wheelEmitError(socket, "Lietotājs nav atrasts.");

    let nextTokens = Math.max(0, Math.floor(target.tokens || 0));

    if (mode === "set") {
      const v = parseInt(payload.set ?? payload.value ?? payload.tokens, 10);
      if (!Number.isFinite(v) || v < 0) return wheelEmitError(socket, "Nederīgs set.");
      nextTokens = v;
    } else if (mode === "delta") {
      const d = parseInt(payload.delta ?? payload.d ?? payload.change, 10);
      if (!Number.isFinite(d) || d === 0) return wheelEmitError(socket, "Nederīgs delta.");
      nextTokens = Math.max(0, nextTokens + d);
    } else {
      const hasSet =
        payload.set !== undefined && payload.set !== null && payload.set !== "";
      const hasDelta =
        payload.delta !== undefined && payload.delta !== null && payload.delta !== "";
      if (!hasSet && !hasDelta) return wheelEmitError(socket, "Norādi set vai delta.");

      if (hasSet) {
        const v = parseInt(payload.set, 10);
        if (!Number.isFinite(v) || v < 0) return wheelEmitError(socket, "Nederīgs set.");
        nextTokens = v;
      } else {
        const d = parseInt(payload.delta, 10);
        if (!Number.isFinite(d) || d === 0) return wheelEmitError(socket, "Nederīgs delta.");
        nextTokens = Math.max(0, nextTokens + d);
      }
    }

    target.tokens = nextTokens;
    saveUsers(USERS);

    wheelSyncTokenSlots(true);
    wheelEmitUpdate(true);

    socket.emit("wheel:tokensUpdated", {
      username: target.username,
      tokens: nextTokens,
    });
  }

  bind("adjustTokens", (payload = {}) => applyTokenChange(payload, "auto"));
  bind("tokenAdjust", (payload = {}) => applyTokenChange(payload, "delta"));
  bind("tokenSet", (payload = {}) => applyTokenChange(payload, "set"));

  bind("add", (payload = {}) => {
    const admin = wheelRequireAdmin(socket);
    if (!admin) return;
    if (wheelBlockIfSpinning(socket)) return;

    const name =
      payload.name ?? payload.username ?? payload.nick ?? payload.player ?? "";
    const count =
      payload.count ?? payload.tickets ?? payload.qty ?? payload.amount ?? 1;

    const r = wheelAdd(name, count);
    if (!r.ok) return wheelEmitError(socket, r.message);
    wheelEmitUpdate(true);
  });

  bind("remove", (payload = {}) => {
    const admin = wheelRequireAdmin(socket);
    if (!admin) return;
    if (wheelBlockIfSpinning(socket)) return;

    if (payload && (payload.index || payload.index === 0)) {
      const r = wheelRemoveOneByIndex(payload.index);
      if (!r.ok) return wheelEmitError(socket, r.message);
      wheelEmitUpdate(true);
      return;
    }

    const name = payload.name ?? payload.username ?? payload.nick ?? "";
    const r = wheelRemoveAllByName(name);
    if (!r.ok) return wheelEmitError(socket, r.message);
    wheelEmitUpdate(true);
  });

  bind("settings", (payload = {}) => {
    const admin = wheelRequireAdmin(socket);
    if (!admin) return;
    if (wheelBlockIfSpinning(socket)) return;

    wheelApplySettings({
      spinMs: payload.spinMs ?? payload.spin_ms ?? payload.ms ?? payload.durationMs,
      removeOnWin:
        typeof payload.removeOnWin === "boolean"
          ? payload.removeOnWin
          : typeof payload.remove_on_win === "boolean"
          ? payload.remove_on_win
          : undefined,
    });

    wheelEmitUpdate(true);
  });

  bind("shuffle", () => {
    const admin = wheelRequireAdmin(socket);
    if (!admin) return;
    if (wheelBlockIfSpinning(socket)) return;

    wheelShuffle();
    wheelEmitUpdate(true);
  });

  bind("spin", () => {
    const admin = wheelRequireAdmin(socket);
    if (!admin) return;

    const r = wheelStartSpin(admin.username, io);
    if (!r.ok) return wheelEmitError(socket, r.message);
  });
});

// ======== Socket.IO pamat-connection (spēle) ========
io.on("connection", (socket) => {
  const user = socket.data.user;
  if (!user) {
    socket.disconnect();
    return;
  }

  const passiveChanged = markActivity(user);

  // Ja lietotājs ir aktīvā duelī un viņš pārlādē lapu, dodam iespēju turpināt
  try {
    const duelId = userToDuel.get(user.username);
    const duel = duelId ? duels.get(duelId) : null;
    if (duel && duel.status === "active") {
      socket.emit("duel.resume", {
        duelId: duel.id,
        len: duel.len,
        opponent: getDuelOpponent(duel, user.username),
        startedAt: duel.startedAt || null,
        expiresAt: duel.expiresAt || null,
        serverNow: Date.now(),
        countdownMs: DUEL_COUNTDOWN_MS,
        ranked: duel.ranked !== false,
        attemptsLeft: duel.attemptsLeft?.[user.username] ?? null,
        rowsUsed: duel.rowsUsed?.[user.username] ?? null,
        history: Array.isArray(duel.history?.[user.username]) ? duel.history[user.username] : [],
      });
    }
  } catch {}
  ensureDailyMissions(user);
  ensureDailyChest(user);
  ensureSpecialMedals(user);
  ensureRankFields(user);
  if (typeof user.supporter !== "boolean") user.supporter = false;

  const bonus = grantDailyLoginBonus(user);
  if (bonus > 0) {
    socket.emit("chatMessage", {
      username: "SYSTEM",
      text: `Dienas ienākšanas bonuss: +${bonus} coins!`,
      ts: Date.now(),
    });
  }

  if (passiveChanged) saveUsers(USERS);

  onlineBySocket.set(socket.id, user.username);
  broadcastOnlineList(true);
  broadcastLeaderboard(false);

  socket.emit("seasonUpdate", seasonState);
  socket.emit("seasonHofUpdate", { top: seasonStore.hallOfFame[0] || null });

  // DM: uzreiz iedodam neizlasīto skaitu (badge sync)
  try {
    const u = USERS[user.username] || user;
    ensureDm(u);
    socket.emit("dm.unread", dmComputeUnread(u.dm));
  } catch {}

  socket.on("leaderboard:top10", () => {
    socket.emit("leaderboard:update", computeTop10Leaderboard());
  });

  // ========== ČATS ==========
  socket.on("chatMessage", (text) => {
    if (typeof text !== "string") return;
    let msg = text.trim();
    if (!msg) return;
    if (msg.length > CHAT_MAX_LEN) msg = msg.slice(0, CHAT_MAX_LEN);

    const u = USERS[user.username] || user;

    const passiveChanged2 = markActivity(u);
    ensureRankFields(u);

    const now = Date.now();

    if (u.isBanned) {
      socket.emit("chatMessage", {
        username: "SYSTEM",
        text: "Tu esi nobanots no VĀRDU ZONAS.",
        ts: Date.now(),
      });
      if (passiveChanged2) saveUsers(USERS);
      return;
    }

    if (u.mutedUntil && u.mutedUntil > now) {
      const until = new Date(u.mutedUntil).toLocaleTimeString("lv-LV", {
        hour: "2-digit",
        minute: "2-digit",
      });
      socket.emit("chatMessage", {
        username: "SYSTEM",
        text: `Tev ir mute līdz ${until}.`,
        ts: Date.now(),
      });
      if (passiveChanged2) saveUsers(USERS);
      return;
    }

    if (u.lastChatAt && now - u.lastChatAt < CHAT_RATE_MS) {
      if (passiveChanged2) saveUsers(USERS);
      return;
    }
    u.lastChatAt = now;

    if (
      u.lastChatText &&
      u.lastChatText === msg &&
      u.lastChatTextAt &&
      now - u.lastChatTextAt < CHAT_DUP_WINDOW_MS
    ) {
      if (passiveChanged2) saveUsers(USERS);
      return;
    }
    u.lastChatText = msg;
    u.lastChatTextAt = now;

    const isAdmin = isAdminUser(u);
    if (isAdmin && (msg.startsWith("/") || msg.startsWith("!"))) {
      handleAdminCommand(msg, u, socket);
      if (passiveChanged2) saveUsers(USERS);
      return;
    }

    if (passiveChanged2) saveUsers(USERS);

    io.emit("chatMessage", {
      username: u.username,
      text: msg,
      ts: Date.now(),
      avatarUrl: u.avatarUrl || null,
      rankTitle: u.rankTitle || "—",
      rankLevel: u.rankLevel || 1,
      rankColor: u.rankColor || "#9CA3AF",
      supporter: !!u.supporter,
    });
  });

  // ========== PRIVĀTAIS ČATS (DM) ==========
  socket.on("dm.send", (payload) => {
    const sender = USERS[user.username] || user;
    const now = Date.now();

    const toRaw =
      typeof payload === "string"
        ? ""
        : payload?.to ?? payload?.username ?? payload?.target ?? "";
    const textRaw = typeof payload === "string" ? payload : payload?.text ?? "";

    const toName = String(toRaw || "").trim();
    const text = dmSanitizeText(textRaw);
    if (!toName) return socket.emit("dm.error", { message: "Nav norādīts saņēmējs." });
    if (!text) return socket.emit("dm.error", { message: "Ziņa ir tukša." });

    if (sender.isBanned) {
      return socket.emit("dm.error", { message: "Tu esi nobanots." });
    }
    if (sender.mutedUntil && sender.mutedUntil > now) {
      const until = new Date(sender.mutedUntil).toLocaleTimeString("lv-LV", {
        hour: "2-digit",
        minute: "2-digit",
      });
      return socket.emit("dm.error", { message: `Tev ir mute līdz ${until}.` });
    }

    // anti-spam
    if (sender.lastDmAt && now - sender.lastDmAt < DM_RATE_MS) return;
    sender.lastDmAt = now;
    if (
      sender.lastDmText &&
      sender.lastDmText === text &&
      sender.lastDmTextAt &&
      now - sender.lastDmTextAt < DM_DUP_WINDOW_MS
    ) {
      return;
    }
    sender.lastDmText = text;
    sender.lastDmTextAt = now;

    const key = findUserKeyCaseInsensitive(toName);
    const target = key ? USERS[key] : null;
    if (!target) return socket.emit("dm.error", { message: "Lietotājs nav atrasts." });
    if (target.username === sender.username)
      return socket.emit("dm.error", { message: "Nevari rakstīt sev." });

    // aktivitāte (anti-afk)
    markActivity(sender);
    markActivity(target);

    const msg = dmPushMessage(sender, target, text);
    if (!msg) return socket.emit("dm.error", { message: "Neizdevās nosūtīt ziņu." });

    saveUsers(USERS);

    // sūtītājam apstiprinājums
    socket.emit("dm.sent", { message: msg, with: target.username });

    // saņēmējam ziņa + unread sync (netraucē spēlei; frontā var rādīt toast)
    const targetSocket = getSocketByUsername(target.username);
    if (targetSocket) {
      targetSocket.emit("dm.message", {
        message: msg,
        fromUser: getMiniUserPayload(sender.username),
      });
      try {
        ensureDm(target);
        targetSocket.emit("dm.unread", dmComputeUnread(target.dm));
      } catch {}
    }
  });

  socket.on("dm.history", (payload) => {
    const me = USERS[user.username] || user;
    const otherRaw =
      typeof payload === "string" ? payload : payload?.with ?? payload?.username ?? payload?.user ?? "";
    const otherName = String(otherRaw || "").trim();
    if (!otherName) return socket.emit("dm.history", { with: "", messages: [] });

    ensureDm(me);
    const key = findUserKeyCaseInsensitive(otherName);
    const other = key ? USERS[key] : null;
    const otherUsername = other?.username || otherName;

    const threadKey = dmThreadKeyFor(me, otherUsername);
    const arr = Array.isArray(me.dm.threads?.[threadKey]) ? me.dm.threads[threadKey] : [];

    // sūtam pēdējās 60 ziņas, lai nav milzīgs payload
    socket.emit("dm.history", {
      with: otherUsername,
      messages: arr.slice(-60),
    });
  });

  socket.on("dm.read", (payload) => {
    const me = USERS[user.username] || user;
    const otherRaw =
      typeof payload === "string" ? payload : payload?.with ?? payload?.username ?? payload?.user ?? "";
    const otherName = String(otherRaw || "").trim();
    if (!otherName) return;

    ensureDm(me);
    const key = findUserKeyCaseInsensitive(otherName);
    const other = key ? USERS[key] : null;
    const otherUsername = other?.username || otherName;

    me.dm.lastRead[otherUsername] = Date.now();
    dmZeroUnreadCaseInsensitive(me.dm, otherUsername);
    saveUsers(USERS);
    socket.emit("dm.unread", dmComputeUnread(me.dm));
  });

  // Dzēst visu DM sarunu (tikai šim lietotājam / "delete for me")
  // payload: { with: "OtherUser" }
  socket.on("dm.clearThread", (payload) => {
    const me = USERS[user.username] || user;
    const otherRaw =
      typeof payload === "string" ? payload : payload?.with ?? payload?.username ?? payload?.user ?? "";
    const otherName = String(otherRaw || "").trim();
    if (!otherName) return socket.emit("dm.error", { message: "Nav norādīta saruna." });

    ensureDm(me);
    const key = findUserKeyCaseInsensitive(otherName);
    const other = key ? USERS[key] : null;
    const otherUsername = other?.username || otherName;
    if (!otherUsername || otherUsername === me.username)
      return socket.emit("dm.error", { message: "Nederīga saruna." });

    const threadKey = dmThreadKeyFor(me, otherUsername);
    try {
      if (me.dm.threads && typeof me.dm.threads === "object") delete me.dm.threads[threadKey];
    } catch {}
    try {
      if (me.dm.lastRead && typeof me.dm.lastRead === "object") delete me.dm.lastRead[otherUsername];
    } catch {}
    dmZeroUnreadCaseInsensitive(me.dm, otherUsername);

    saveUsers(USERS);
    socket.emit("dm.cleared", { with: otherUsername });
    socket.emit("dm.unread", dmComputeUnread(me.dm));
  });

  // ========== DUEĻI ==========
  socket.on("duel.challenge", (targetNameRaw) => {
    const challenger = socket.data.user;
    const challengerName = challenger.username;
    const isObj = targetNameRaw && typeof targetNameRaw === "object";
    const targetName = String(
      isObj
        ? targetNameRaw.target || targetNameRaw.username || targetNameRaw.opponent || ""
        : targetNameRaw || ""
    ).trim();
    // default: ranked (back-compat ar veco klientu, kas sūta tikai string)
    const ranked = isObj ? targetNameRaw.ranked !== false : true;

    if (!targetName)
      return socket.emit("duel.error", { message: "Nav norādīts pretinieks." });
    if (targetName === challengerName)
      return socket.emit("duel.error", { message: "Nevari izaicināt sevi." });

    const key = findUserKeyCaseInsensitive(targetName);
    const targetUser = key ? USERS[key] : null;
    if (!targetUser)
      return socket.emit("duel.error", { message: "Lietotājs nav atrasts." });

    if (userToDuel.has(challengerName))
      return socket.emit("duel.error", { message: "Tu jau esi citā duelī." });
    if (userToDuel.has(targetUser.username))
      return socket.emit("duel.error", {
        message: "Pretinieks jau ir citā duelī.",
      });

    const targetSocket = getSocketByUsername(targetUser.username);
    if (!targetSocket)
      return socket.emit("duel.error", {
        message: "Pretinieks nav tiešsaistē.",
      });

    const { word, len } = pickRandomWord();
    const duelId = crypto.randomBytes(8).toString("hex");

    const duel = {
      id: duelId,
      players: [challengerName, targetUser.username],
      challenger: challengerName,
      target: targetUser.username,
      word,
      len,
      ranked,
      status: "pending",
      createdAt: Date.now(),
      startedAt: null,
      expiresAt: Date.now() + DUEL_INVITE_TIMEOUT_MS,
      attemptsLeft: {
        [challengerName]: DUEL_MAX_ATTEMPTS,
        [targetUser.username]: DUEL_MAX_ATTEMPTS,
      },
      rowsUsed: { [challengerName]: 0, [targetUser.username]: 0 },
      history: { [challengerName]: [], [targetUser.username]: [] }, // [{ guess, pattern, ts }]
      winner: null,
      finishedReason: null,
    };

    duels.set(duelId, duel);
    userToDuel.set(challengerName, duelId);
    userToDuel.set(targetUser.username, duelId);

    socket.emit("duel.waiting", {
      duelId,
      opponent: targetUser.username,
      len,
      ranked,
    });
    targetSocket.emit("duel.invite", {
      duelId,
      from: challengerName,
      len,
      ranked,
    });
  });

  socket.on("duel.decline", (payload) => {
    const u = socket.data.user;
    const duelId = typeof payload === "string" ? payload : payload?.duelId;
    const duel = duelId ? duels.get(duelId) : null;
    if (!duel) return;

    if (duel.status !== "pending") return;
    const [p1, p2] = duel.players;

    if (u.username !== p1 && u.username !== p2) return;

    // vienmēr beidzam caur finishDuel, lai abiem klientiem atnāk duel.end
    // (pretējā gadījumā izaicinātājam var palikt "gaidām atbildi..." karājoties)
    finishDuel(duel, null, "declined");
  });

  socket.on("duel.accept", (payload) => {
    const u = socket.data.user;
    const duelId = typeof payload === "string" ? payload : payload?.duelId;
    const duel = duelId ? duels.get(duelId) : null;
    if (!duel) return;

    if (duel.status !== "pending") return;

    const [p1, p2] = duel.players;
    if (u.username !== p1 && u.username !== p2) return;

    duel.status = "active";
    // spēle sākas pēc īsas atskaites, bet faktiskais laiks ir pilnas 2 min
    duel.startedAt = Date.now() + DUEL_COUNTDOWN_MS;
    duel.expiresAt = duel.startedAt + DUEL_MAX_DURATION_MS;

    const s1 = getSocketByUsername(p1);
    const s2 = getSocketByUsername(p2);

    const basePayload = {
      duelId,
      len: duel.len,
      startedAt: duel.startedAt,
      expiresAt: duel.expiresAt,
      serverNow: Date.now(),
      countdownMs: DUEL_COUNTDOWN_MS,
      ranked: duel.ranked !== false,
    };
    if (s1) s1.emit("duel.start", { ...basePayload, opponent: p2 });
    if (s2) s2.emit("duel.start", { ...basePayload, opponent: p1 });
  });

  socket.on("duel.guess", (payload) => {
    const u = socket.data.user;
    const duelId = payload?.duelId;
    const guess = String(payload?.guess || "").trim().toUpperCase();
    const duel = duelId ? duels.get(duelId) : null;
    if (!duel) return;

    if (duel.status !== "active") return;
    if (!duel.players.includes(u.username)) return;

    // neļaujam minēt pirms atskaites beigām (fair play)
    if (duel.startedAt && Date.now() < duel.startedAt) {
      return socket.emit("duel.error", { message: "Duelis vēl nav sācies. Pagaidi atskaiti!" });
    }

    if (!guess || guess.length !== duel.len) {
      return socket.emit("duel.error", { message: `Vārdam jābūt ${duel.len} burtiem.` });
    }
    if (!GUESS_ALLOWED_RE.test(guess)) {
      return socket.emit("duel.error", { message: "Minējumā drīkst būt tikai burti (A-Z + LV)." });
    }

    const left = duel.attemptsLeft[u.username] ?? 0;
    if (left <= 0) return;

    duel.attemptsLeft[u.username] = left - 1;
    duel.rowsUsed[u.username] = (duel.rowsUsed[u.username] || 0) + 1;

    const pattern = buildPattern(duel.word, guess);
    const win = guess === duel.word;
    const attemptsLeftNow = duel.attemptsLeft[u.username] ?? 0;
    const finished = attemptsLeftNow <= 0 && !win;

    try {
      if (!duel.history) duel.history = {};
      if (!Array.isArray(duel.history[u.username])) duel.history[u.username] = [];
      duel.history[u.username].push({ guess, pattern, ts: Date.now() });
    } catch {}

    // Backward/forward compat: daži klienti klausās "duel.result", citi "duel.guessResult"
    const resultPayload = {
      duelId,
      guess,
      pattern,
      win,
      finished,
      attemptsLeft: attemptsLeftNow,
    };
    socket.emit("duel.result", resultPayload);
    socket.emit("duel.guessResult", resultPayload);

    if (win) {
      finishDuel(duel, u.username, "win");
      return;
    }

    // ja abi iztērējuši mēģinājumus -> neizšķirts (timeout/none)
    const [p1, p2] = duel.players;
    const l1 = duel.attemptsLeft[p1] ?? 0;
    const l2 = duel.attemptsLeft[p2] ?? 0;
    if (l1 <= 0 && l2 <= 0) finishDuel(duel, null, "no_attempts");
  });

  socket.on("disconnect", () => {
    // Pending invite tīram, bet ACTIVE dueli NEbeidzam (lai refresh gadījumā var turpināt).
    // ACTIVE duelis tāpat beigsies ar 2min timeout.
    try {
      const u = socket.data.user;
      const uname = u && u.username ? u.username : null;
      if (uname && userToDuel.has(uname)) {
        const duelId = userToDuel.get(uname);
        const duel = duelId ? duels.get(duelId) : null;

        if (duel && duel.status === "pending") finishDuel(duel, null, "declined");
      }
    } catch {}

    onlineBySocket.delete(socket.id);
    broadcastOnlineList(true);
  });
});

// ======== WHEEL server init ========
wheelSyncTokenSlots(true);

// ======== HTTP listen ========
httpServer.listen(PORT, () => {
  console.log(`VĀRDU ZONA serveris iet uz porta ${PORT}`);
});
