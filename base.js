// ======== VĀRDU ZONA — Bugats edition ========
// Serveris ar login/signup, JWT, XP, RANKIEM (25 līmeņi),
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
const DAILY_MISSIONS_CONFIG = [
  {
    id: "win3",
    title: "Atmini 3 vārdus šodien",
    type: "wins",
    target: 3,
    rewards: { xp: 30, coins: 25, tokens: 0 },
  },
  {
    id: "xp50",
    title: "Nopelni 50 XP šodien",
    type: "xp",
    target: 50,
    rewards: { xp: 0, coins: 35, tokens: 0 },
  },
  {
    id: "guess20",
    title: "Izdari 20 minējumus",
    type: "guesses",
    target: 20,
    rewards: { xp: 20, coins: 15, tokens: 1 },
  },
];

// ======== DUEĻI (1v1) ==========
const DUEL_MAX_ATTEMPTS = 6;
const DUEL_REWARD_XP = 3;
const DUEL_REWARD_COINS = 3;
const DUEL_MAX_DURATION_MS = 2 * 60 * 1000; // 2 min

const duels = new Map(); // duelId -> duel objekts
const userToDuel = new Map(); // username -> duelId

// ======== ČATS (mini anti-spam) ========
const CHAT_MAX_LEN = 200;
const CHAT_RATE_MS = 900;
const CHAT_DUP_WINDOW_MS = 4000;

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

// ======== Rank loģika (25 līmeņi) ========
function calcRankFromXp(xp) {
  const table = [
    { minXp: 0, title: "Jauniņais" },
    { minXp: 40, title: "Burtu Skolnieks" },
    { minXp: 90, title: "Vārdu Mednieks" },
    { minXp: 160, title: "Burtošanas Aizrautis" },
    { minXp: 250, title: "Vārdu Taktikis" },
    { minXp: 360, title: "Leksikas Kareivis" },
    { minXp: 490, title: "Leksikas Bruņinieks" },
    { minXp: 640, title: "Erudīcijas Cīnītājs" },
    { minXp: 810, title: "Erudīcijas Kapteinis" },
    { minXp: 1000, title: "Erudīcijas Komandieris" },
    { minXp: 1200, title: "Smadzeņu Atlēts" },
    { minXp: 1450, title: "Loģikas Inženieris" },
    { minXp: 1750, title: "Stratēģijas Arhitekts" },
    { minXp: 2100, title: "Vārdu Burvis" },
    { minXp: 2500, title: "Vārdu Maģistrs" },
    { minXp: 2950, title: "Vārdu Profesors" },
    { minXp: 3450, title: "ZONAS Sargs" },
    { minXp: 4000, title: "ZONAS Boss" },
    { minXp: 4600, title: "ZONAS Karalis" },
    { minXp: 5250, title: "Bugats Māceklis" },
    { minXp: 5950, title: "Bugats Elites Spēlētājs" },
    { minXp: 6700, title: "Bugats PRIME" },
    { minXp: 7500, title: "Bugats Mītiskais" },
    { minXp: 8350, title: "Kosmiskais Prāts" },
    { minXp: 9250, title: "Nemirstīgais ZONAS Mīts" },
  ];

  const currentXp = xp || 0;
  let current = table[0];
  for (const r of table) {
    if (currentXp >= r.minXp) current = r;
    else break;
  }
  const level = table.indexOf(current) + 1;
  return { level, title: current.title };
}

function ensureRankFields(u) {
  const info = calcRankFromXp(u?.xp || 0);
  if (u) {
    u.rankLevel = info.level;
    u.rankTitle = info.title;
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
  if (
    user.missionsDate !== key ||
    !Array.isArray(user.missions) ||
    !user.missions.length
  ) {
    user.missionsDate = key;
    user.missions = DAILY_MISSIONS_CONFIG.map((m) => ({
      id: m.id,
      title: m.title,
      type: m.type,
      target: m.target,
      progress: 0,
      isCompleted: false,
      isClaimed: false,
      rewards: { ...(m.rewards || {}) },
    }));
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

function updateMissionsOnGuess(user, { isWin, xpGain }) {
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
  const dynamicMedals = computeMedalsForUser(u);
  const medals = mergeMedals(dynamicMedals, u.specialMedals);

  return {
    username: u.username,
    xp: u.xp || 0,
    score: u.score || 0,
    coins: u.coins || 0,
    tokens: u.tokens || 0,
    streak: u.streak || 0,
    bestStreak: u.bestStreak || 0,
    rankTitle: u.rankTitle || rankInfo.title,
    rankLevel: u.rankLevel || rankInfo.level,
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

// Health
app.get("/", (_req, res) => res.send("VĀRDU ZONA OK"));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.post("/logout", (_req, res) => res.json({ ok: true }));

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
      supporter: false,
    };
  }
  const info = ensureRankFields(u);
  return {
    username,
    avatarUrl: u.avatarUrl || null,
    rankLevel: u.rankLevel || info.level || 1,
    rankTitle: u.rankTitle || info.title || "—",
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


// ======== MODULAR: setters/export ========
function setWheelNsp(nsp) {
  wheelNsp = nsp;
}

export {
  ADMIN_USERNAMES, ADMIN_USERNAMES_LC, AFK_BREAK_MS, AVATAR_MAX_CHARS, BAD_LEN_BLOCK_MS, BAD_LEN_MAX,
  BAD_LEN_WINDOW_MS, BASE_TOKEN_PRICE, BODY_JSON_LIMIT, BODY_URLENC_LIMIT, CHAT_DUP_WINDOW_MS, CHAT_MAX_LEN,
  CHAT_RATE_MS, COINS_PER_LETTER_BONUS, COINS_PER_WIN_BASE, COINS_STREAK_MAX_BONUS, CORS_ORIGINS, CORS_ORIGINS_RAW,
  DAILY_MISSIONS_CONFIG, DUEL_MAX_ATTEMPTS, DUEL_MAX_DURATION_MS, DUEL_REWARD_COINS, DUEL_REWARD_XP, GUESS_ALLOWED_RE,
  GUESS_RATE_MS, JWT_SECRET, MAX_ATTEMPTS, MAX_WORD_LEN, MIN_WORD_LEN, PASSIVE_COINS_PER_TICK,
  PASSIVE_INTERVAL_MS, PORT, RESET_COINS_TOKENS_ON_ROLLOVER, REVEAL_LETTER_COST_COINS, SCORE_PER_WIN, SEASON1_END_AT,
  SEASON2_END_AT_DEFAULT, SEASONS_FILE, SEASON_DAYS, TZ, USERS, USERS_FILE,
  WHEEL_ANNOUNCE_TO_CHAT, WHEEL_DEFAULT_SPIN_MS, WHEEL_FILE, WHEEL_MAX_SLOTS, WORDS, WORDS_FILE,
  XP_PER_LETTER_BONUS, XP_PER_STREAK_STEP, XP_PER_WIN_BASE, XP_STREAK_MAX_STEPS, __dirname, __filename,
  addSpecialMedalOnce, app, authMiddleware, broadcastOnlineList, buildInitialSeasonStore, buildInitialWheelStore,
  buildMePayload, calcRankFromXp, championMedalCode, championMedalLabel, computeMedalsForUser, computeNextSeasonEndAt,
  corsOptions, defaultSeasonFinishedAt, duels, ensureDailyChest, ensureDailyMissions, ensureRankFields,
  ensureSpecialMedals, finalizeSeasonIfNeeded, findUserKeyCaseInsensitive, getMiniUserPayload, getPublicMissions, getTokenPrice,
  getTop1UserByScore, getTzOffsetMinutes, httpServer, io, isAdminName, isAdminUser,
  lastOnlineSig, loadJsonSafe, loadUsers, markActivity, mergeMedals, nextMidnightRigaTs,
  normalizeWheelStore, onlineBySocket, publicWheelState, removeSpecialMedalFromAllUsers, resetCoinsAndTokensForAllUsers, resetWinsTodayIfNeeded,
  saveJsonAtomic, saveUsers, saveWheelStore, seasonState, seasonStore, startSeasonFlow,
  todayKey, updateMissionsOnGuess, upsertHallOfFameWinner, userToDuel, wheelAdd, wheelApplySettings,
  wheelBlockIfSpinning, wheelComputeTokenSlots, wheelEmitError, wheelEmitUpdate, wheelFinishSpin, wheelGetCombinedSlots,
  wheelIsSpinningNow, wheelNsp, wheelRemoveAllByName, wheelRemoveOneByIndex, wheelRequireAdmin, wheelShuffle,
  wheelStartSpin, wheelStore, wheelSyncTokenSlots, wheelTokenMeta, wheelTokenSig, wheelTokenSlots,
  setWheelNsp
};
