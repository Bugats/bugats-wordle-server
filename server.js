// ======== VĀRDU ZONA — Bugats edition ========
// Serveris ar login/signup, JWT, XP, RANKIEM (25 līmeņi),
// streak, coins, žetoniem, pasīvajiem coiniem ar Anti-AFK,
// TOP10, online sarakstu un čatu + ADMIN komandām + MISIJĀM + MEDAĻĀM + 1v1 DUEĻIEM.

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto"; // drošāka random izvēle

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

const MIN_WORD_LEN = 5;
const MAX_WORD_LEN = 7;
const MAX_ATTEMPTS = 6;

const BASE_TOKEN_PRICE = 150;

// ======== Season rollover: coins/tokens reset (ENV slēdzis) ========
// Default: ON (1). Lai izslēgtu: RESET_COINS_TOKENS_ON_ROLLOVER=0
const RESET_COINS_TOKENS_ON_ROLLOVER =
  String(process.env.RESET_COINS_TOKENS_ON_ROLLOVER ?? "1") === "1";

// ======== Lielie request body limiti (FIX 413 Payload Too Large) ========
const BODY_JSON_LIMIT = process.env.BODY_JSON_LIMIT || "25mb";
const BODY_URLENC_LIMIT = process.env.BODY_URLENC_LIMIT || BODY_JSON_LIMIT;

// ======== CORS (default: atvērts) ========
// Ja gribi ierobežot:
// CORS_ORIGINS="https://thezone.lv,https://www.thezone.lv"
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
          if (!origin) return cb(null, true); // curl / server-to-server
          return cb(null, CORS_ORIGINS.includes(origin));
        },
        credentials: true,
      };

// Avatāra max garums (base64 string).
// env: AVATAR_MAX_CHARS="8000000"
const AVATAR_MAX_CHARS = (() => {
  const v = parseInt(process.env.AVATAR_MAX_CHARS || "", 10);
  if (Number.isFinite(v) && v > 200000) return v;
  return 6 * 1024 * 1024; // ~6.29M chars
})();

// Admin lietotāji (case-insensitive)
// (bonus) vari paplašināt ar ENV: ADMIN_USERNAMES="BugatsLV,AnotherNick"
const ADMIN_USERNAMES = (() => {
  const raw = String(process.env.ADMIN_USERNAMES || "").trim();
  const defaults = ["BugatsLV"]; // ADMINI tikai BugatsLV
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

// ======== SEZONA 1 – beigu datums (vēsturiskais) ========
const SEASON1_END_AT = new Date("2025-12-26T23:59:59+02:00").getTime();

// ======== SEZONA 2 – default beigu datums (prasība: februāra vidus) ========
const SEASON2_END_AT_DEFAULT = new Date("2026-02-15T23:59:59+02:00").getTime();

// ======== SEASON CONFIG ========
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
const CHAT_RATE_MS = 900; // 1 ziņa ~ 0.9s
const CHAT_DUP_WINDOW_MS = 4000; // vienāds teksts 4s logā -> ignorējam

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

// atomic save (pret bojātu JSON, ja process nokrīt rakstīšanas laikā)
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

// Boot fix: ja Sezona 2 jau ir startēta, bet endAt nav “februāra vidus” (un nav SEASON_END_AT env)
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

  // MIGRĀCIJA: vecais formāts ar out.slots -> manualSlots
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
if (!fs.existsSync(WHEEL_FILE)) {
  saveJsonAtomic(WHEEL_FILE, wheelStore);
} else {
  saveJsonAtomic(WHEEL_FILE, wheelStore);
}

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

// wheel namespace ref (iestatās pēc io init)
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

// ======== MANUĀLIE sloti (wheel:add) ========
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
  // tiešā atslēga
  if (USERS[nameRaw]) return nameRaw;
  // meklējam pēc lower
  for (const k of Object.keys(USERS || {})) {
    if (String(k).toLowerCase() === q) return k;
  }
  return null;
}

// (UPDATED) noņem “no visurienes” (manualSlots + tokens=0), case-insensitive
function wheelRemoveAllByName(nameRaw) {
  const name = String(nameRaw || "").trim();
  if (!name) return { ok: false, message: "Nav vārda." };

  const needle = name.toLowerCase();

  const beforeManual = wheelStore.manualSlots.length;
  wheelStore.manualSlots = wheelStore.manualSlots.filter(
    (x) => String(x || "").toLowerCase() !== needle
  );
  const removedManual = beforeManual - wheelStore.manualSlots.length;

  // ja šis ir reāls user, uzliekam tokens=0
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

  // token slots: noņem 1 biļeti (tokens -1)
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
  return fmt.format(date); // YYYY-MM-DD
}

// ======== Daily Chest helperi ========
function ensureDailyChest(user) {
  if (!user.dailyChest || typeof user.dailyChest !== "object")
    user.dailyChest = {};
  if (typeof user.dailyChest.lastDate !== "string")
    user.dailyChest.lastDate = "";
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
// atgriež true, ja piešķīra pasīvos coinus
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
    console.log(
      `Pasīvie coini: ${user.username} +${gained} (tagad: ${user.coins})`
    );
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

// (UZLABOJUMS) vairs nesaglabā pati; atgriež changed
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

// ======== SEASON 2 / HALL OF FAME loģika ========
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

// ADMIN override: pārraksta HOF sezonas čempionu + sakārto medaļu
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

  if (champ.isBanned) {
    console.log("HOF override: champ ir banned:", uname);
  }

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

  const removedAny = removeSpecialMedalFromAllUsers(medalCode);
  ensureSpecialMedals(champ);
  addSpecialMedalOnce(champ, {
    code: medalCode,
    icon: "🏆",
    label: championMedalLabel(sid),
    ts: finishedAt,
  });

  saveUsers(USERS);
  saveJsonAtomic(SEASONS_FILE, seasonStore);

  return { ok: true, hofEntry, removedAny };
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
  } catch (err) {
    return res.status(401).json({ message: "Nederīgs token" });
  }
}

// ======== Express + Socket.IO ========
const app = express();

// Hardening (safe)
app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(cors(corsOptions));

// ======== BODY PARSER LIMITI ========
app.use(express.json({ limit: BODY_JSON_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: BODY_URLENC_LIMIT }));

// 413 kā JSON
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

// vienkāršs logout
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

setInterval(() => {
  broadcastOnlineList(false);
}, 30 * 1000);

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

setInterval(() => {
  broadcastLeaderboard(false);
}, 45 * 1000);

// === Admin & čata helperi ===
function broadcastSystemMessage(text) {
  io.emit("chatMessage", { username: "SYSTEM", text, ts: Date.now() });
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
      } catch (e) {
        console.error("forceDisconnect emit error:", e);
      }
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
      const scoreOverride = parts[3]; // optional

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

  const hash = await bcrypt.hash(password, 10);
  const now = Date.now();

  const user = {
    username: name,
    passwordHash: hash,
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

  markActivity(user);
  ensureDailyMissions(user);
  resetWinsTodayIfNeeded(user);
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

  const dynamicMedals = computeMedalsForUser(targetUser);
  const medals = mergeMedals(dynamicMedals, targetUser.specialMedals);

  const payload = {
    username: targetUser.username,
    xp: targetUser.xp || 0,
    score: targetUser.score || 0,
    coins: targetUser.coins || 0,
    tokens: targetUser.tokens || 0,
    streak: targetUser.streak || 0,
    bestStreak: targetUser.bestStreak || 0,
    rankTitle: targetUser.rankTitle || rankInfo.title,
    rankLevel: targetUser.rankLevel || rankInfo.level,
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

  const tokenChance = Math.min(0.25, 0.06 + streak * 0.01); // līdz 25%
  const tokensGain = Math.random() < tokenChance ? 1 : 0;

  user.coins = (user.coins || 0) + coinsGain;
  user.xp = (user.xp || 0) + xpGain;
  user.tokens = (user.tokens || 0) + tokensGain;

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
  };
  return user.currentRound;
}

app.get("/start-round", authMiddleware, (req, res) => {
  const user = req.user;
  markActivity(user);
  ensureDailyMissions(user);
  ensureDailyChest(user);

  if (user.currentRound && !user.currentRound.finished) {
    saveUsers(USERS);
    return res.json({ len: user.currentRound.len });
  }

  const round = startNewRoundForUser(user);
  saveUsers(USERS);
  res.json({ len: round.len });
});

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
  round.attemptsLeft -= 1;

  const len = round.len;
  const isWin = guessRaw === round.word;
  const finished = isWin || round.attemptsLeft <= 0;

  let xpGain = 0;
  let coinsGain = 0;

  if (isWin) {
    const prevStreak = user.streak || 0;
    user.streak = prevStreak + 1;

    resetWinsTodayIfNeeded(user);
    user.winsToday = (user.winsToday || 0) + 1;

    if (round.startedAt) {
      const winTime = Date.now() - round.startedAt;
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
      avatarUrl: user.avatarUrl || null,
      streak: user.streak || 0,
    });
  } else {
    if (finished) user.streak = 0;
  }

  round.finished = finished;

  updateMissionsOnGuess(user, { isWin, xpGain });

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

app.post("/buy-token", authMiddleware, (req, res) => {
  const user = req.user;
  markActivity(user);
  ensureDailyMissions(user);
  ensureDailyChest(user);

  const price = getTokenPrice(user);
  if ((user.coins || 0) < price) {
    saveUsers(USERS);
    return res.status(400).json({ message: "Nepietiek coins" });
  }

  user.coins = (user.coins || 0) - price;
  user.tokens = (user.tokens || 0) + 1;

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

  if (winnerName && u1 && u2) {
    const winner = USERS[winnerName];
    const loser = winnerName === p1 ? u2 : u1;

    if (winner) {
      winner.duelsWon = (winner.duelsWon || 0) + 1;
      winner.xp = (winner.xp || 0) + DUEL_REWARD_XP;
      winner.coins = (winner.coins || 0) + DUEL_REWARD_COINS;
      ensureRankFields(winner);
    }
    if (loser) {
      loser.duelsLost = (loser.duelsLost || 0) + 1;
    }

    saveUsers(USERS);
    broadcastLeaderboard(false);

    if (s1)
      s1.emit("duel.end", {
        duelId: duel.id,
        winner: winnerName,
        youWin: winnerName === p1,
        reason,
      });
    if (s2)
      s2.emit("duel.end", {
        duelId: duel.id,
        winner: winnerName,
        youWin: winnerName === p2,
        reason,
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
      });
    if (s2)
      s2.emit("duel.end", {
        duelId: duel.id,
        winner: null,
        youWin: false,
        reason,
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

// ===== SEZONAS AUTO-BEIGAS + AUTO-HOF (TOP1 freeze) =====
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

// ======== Socket.IO auth middleware (atšķiras /wheel) ========
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

  // pārējais (spēle): token obligāts
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
  } catch {
    // nederīgs token -> paliek read-only
  }
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

  // ===== ADMIN: tokenAdjust / tokenSet (un saderība ar adjustTokens) =====
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

  console.log("Pieslēdzās:", user.username, "socket:", socket.id);

  const passiveChanged = markActivity(user);
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
      supporter: !!u.supporter,
    });
  });

  // ========== DUEĻI ==========
  socket.on("duel.challenge", (targetNameRaw) => {
    const challenger = socket.data.user;
    const challengerName = challenger.username;
    const targetName = String(targetNameRaw || "").trim();

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
      word,
      len,
      status: "pending",
      createdAt: Date.now(),
      startedAt: null,
      expiresAt: null,
      attemptsLeft: {
        [challengerName]: DUEL_MAX_ATTEMPTS,
        [targetUser.username]: DUEL_MAX_ATTEMPTS,
      },
      rowsUsed: { [challengerName]: 0, [targetUser.username]: 0 },
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
    });
    targetSocket.emit("duel.invite", {
      duelId,
      from: challengerName,
      len,
    });
  });

  socket.on("duel.accept", (payload) => {
    const duelId = payload?.duelId;
    const userName = socket.data.user.username;
    const duel = duels.get(duelId);
    if (!duel)
      return socket.emit("duel.error", { message: "Duēlis nav atrasts." });
    if (!duel.players.includes(userName))
      return socket.emit("duel.error", { message: "Tu neesi šajā duelī." });
    if (duel.status !== "pending")
      return socket.emit("duel.error", { message: "Duēlis jau ir sācies." });

    duel.status = "active";
    duel.startedAt = Date.now();
    duel.expiresAt = duel.startedAt + DUEL_MAX_DURATION_MS;

    const [p1, p2] = duel.players;
    const s1 = getSocketByUsername(p1);
    const s2 = getSocketByUsername(p2);

    if (s1)
      s1.emit("duel.start", {
        duelId: duel.id,
        len: duel.len,
        opponent: p2,
        expiresAt: duel.expiresAt,
      });
    if (s2)
      s2.emit("duel.start", {
        duelId: duel.id,
        len: duel.len,
        opponent: p1,
        expiresAt: duel.expiresAt,
      });

    broadcastSystemMessage(
      `⚔️ Duēlis sākas: ${p1} vs ${p2}! Kurš pirmais atminēs vārdu?`
    );
  });

  socket.on("duel.decline", (payload) => {
    const duelId = payload?.duelId;
    const userName = socket.data.user.username;
    const duel = duels.get(duelId);
    if (!duel) return;
    if (!duel.players.includes(userName)) return;
    if (duel.status !== "pending") return;

    const [p1, p2] = duel.players;
    const other = p1 === userName ? p2 : p1;

    const sOther = getSocketByUsername(other);
    if (sOther)
      sOther.emit("duel.end", {
        duelId: duel.id,
        winner: null,
        youWin: false,
        reason: "declined",
      });
    socket.emit("duel.end", {
      duelId: duel.id,
      winner: null,
      youWin: false,
      reason: "declined",
    });

    userToDuel.delete(p1);
    userToDuel.delete(p2);
    duels.delete(duel.id);
  });

  socket.on("duel.guess", (payload = {}) => {
    const duelId = payload?.duelId;
    const guess = String(payload?.guess || "")
      .trim()
      .toUpperCase();

    const me = socket.data.user.username;

    const duel = duels.get(duelId);
    if (!duel) return socket.emit("duel.error", { message: "Duēlis nav atrasts." });
    if (!duel.players.includes(me))
      return socket.emit("duel.error", { message: "Tu neesi šajā duelī." });
    if (duel.status !== "active")
      return socket.emit("duel.error", { message: "Duēlis nav aktīvs." });

    const now = Date.now();
    if (duel.expiresAt && now >= duel.expiresAt) {
      finishDuel(duel, null, "timeout");
      return;
    }

    if (!guess) return;
    if (guess.length !== duel.len) {
      return socket.emit("duel.error", {
        message: `Vārdam jābūt ${duel.len} burtiem.`,
      });
    }
    if (!GUESS_ALLOWED_RE.test(guess)) {
      return socket.emit("duel.error", {
        message: "Minējumā drīkst būt tikai burti (A-Z + latviešu burti).",
      });
    }

    const left = duel.attemptsLeft?.[me] ?? DUEL_MAX_ATTEMPTS;
    if (left <= 0) {
      return socket.emit("duel.error", { message: "Tev vairs nav mēģinājumu." });
    }

    const pattern = buildPattern(duel.word, guess);
    const isWin = guess === duel.word;

    duel.attemptsLeft[me] = Math.max(0, left - 1);
    duel.rowsUsed[me] = (duel.rowsUsed[me] || 0) + 1;

    const [p1, p2] = duel.players;
    const other = me === p1 ? p2 : p1;

    const s1 = getSocketByUsername(p1);
    const s2 = getSocketByUsername(p2);

    const progressPayload = {
      duelId: duel.id,
      by: me,
      guess,
      pattern,
      win: isWin,
      attemptsLeft: {
        [p1]: duel.attemptsLeft[p1],
        [p2]: duel.attemptsLeft[p2],
      },
      rowsUsed: {
        [p1]: duel.rowsUsed[p1],
        [p2]: duel.rowsUsed[p2],
      },
      expiresAt: duel.expiresAt,
    };

    if (s1) s1.emit("duel.progress", progressPayload);
    if (s2) s2.emit("duel.progress", progressPayload);

    if (isWin) {
      finishDuel(duel, me, "win");
      return;
    }

    const leftMe = duel.attemptsLeft[me] || 0;
    const leftOther = duel.attemptsLeft[other] || 0;
    if (leftMe <= 0 && leftOther <= 0) {
      finishDuel(duel, null, "no_attempts");
    }
  });

  // ===== disconnect =====
  socket.on("disconnect", () => {
    const uname = onlineBySocket.get(socket.id);
    onlineBySocket.delete(socket.id);

    if (uname) {
      // ja bija duelī — sakārtojam
      const duelId = userToDuel.get(uname);
      if (duelId) {
        const duel = duels.get(duelId);
        if (duel) {
          const [p1, p2] = duel.players;
          const other = uname === p1 ? p2 : p1;

          if (duel.status === "pending") {
            const sOther = getSocketByUsername(other);
            if (sOther) {
              sOther.emit("duel.end", {
                duelId: duel.id,
                winner: null,
                youWin: false,
                reason: "disconnect",
              });
            }
            userToDuel.delete(p1);
            userToDuel.delete(p2);
            duels.delete(duel.id);
          } else if (duel.status === "active") {
            // forfeit: otrs uzvar
            finishDuel(duel, other, "disconnect");
          }
        } else {
          userToDuel.delete(uname);
        }
      }
    }

    broadcastOnlineList(true);
  });
});

// ======== WHEEL API: state tikai ========
// (ir jau /wheel/state augšā)

// ======== Start server ========
httpServer.listen(PORT, () => {
  console.log(`VĀRDU ZONA serveris darbojas uz porta: ${PORT}`);
});
