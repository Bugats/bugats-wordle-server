// ======== VĀRDU ZONA — Bugats edition ========
// Serveris ar login/signup, JWT, XP, RANKIEM (40 līmeņi),
// streak, coins, žetoniem, pasīvajiem coiniem ar Anti-AFK,
// TOP10, online sarakstu un čatu + ADMIN komandām + MISIJĀM + MEDAĻĀM + 1v1 DUEĻIEM.
// + SEZONAS + HOF
// + LAIMES RATS (/wheel namespace) ar persistent wheel.json
// + Ability: atvērt 1 burtu par coins (1x katrā raundā)
//
// Politika: neaktīvi konti NETIEK dzēsti un XP/score/streak/medaļas NETIEK nullētas
// par neaktivitāti. Profils un punkti paliek; tikai ban un atsevišķas admin darbības
// (piem. sezonas coins/tokens reset) maina datus.

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import pino from "pino";
import pinoHttp from "pino-http";
import { createClient } from "@supabase/supabase-js";
import bracketsManagerPkg from "brackets-manager";
import bracketsJsonDbPkg from "brackets-json-db";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ======== Konstantes ========
const PORT = process.env.PORT || 10080;
const JWT_SECRET = (() => {
  const configured = String(process.env.JWT_SECRET || "").trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "test") return "test-only-jwt-secret";
  throw new Error("JWT_SECRET is required");
})();

const USERS_FILE = process.env.USERS_FILE || path.join(__dirname, "users.json");
const REPORTS_FILE =
  process.env.REPORTS_FILE || path.join(__dirname, "reports.json");
const WORDS_FILE = path.join(__dirname, "words.txt");

// Seasons storage
const SEASONS_FILE =
  process.env.SEASONS_FILE || path.join(__dirname, "seasons.json");

// Static frontend (Render)
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, "public");
const STATIC_INDEX = path.join(STATIC_DIR, "index.html");
const TOURNAMENTS_FILE =
  process.env.TOURNAMENTS_FILE || path.join(__dirname, "tournaments.json");
const TOURNAMENTS_DB_FILE =
  process.env.TOURNAMENTS_DB_FILE ||
  path.join(__dirname, "tournaments.brackets.json");

const { BracketsManager } = bracketsManagerPkg;
const { JsonDatabase } = bracketsJsonDbPkg;

// ====== Supabase (storage + optional DB) ======
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
).trim();
const SUPABASE_STORAGE_BUCKET = String(
  process.env.SUPABASE_STORAGE_BUCKET || "avatars"
).trim();
const SUPABASE_STORAGE_PUBLIC =
  String(process.env.SUPABASE_STORAGE_PUBLIC ?? "0") === "1";
const SUPABASE_AVATAR_CACHE_CONTROL = String(
  process.env.SUPABASE_AVATAR_CACHE_CONTROL || "3600"
).trim();
const SUPABASE_AVATAR_SIGNED_TTL = (() => {
  const v = parseInt(process.env.SUPABASE_AVATAR_SIGNED_TTL || "3600", 10);
  return Number.isFinite(v) && v >= 60 && v <= 86400 ? v : 3600;
})();
const SUPABASE_ENABLED = !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const ONESIGNAL_APP_ID = String(process.env.ONESIGNAL_APP_ID || "").trim();
const ONESIGNAL_SAFARI_WEB_ID = String(
  process.env.ONESIGNAL_SAFARI_WEB_ID || ""
).trim();
const ONESIGNAL_PROMPT_DELAY_SECONDS = (() => {
  const v = parseInt(process.env.ONESIGNAL_PROMPT_DELAY_SECONDS || "25", 10);
  return Number.isFinite(v) && v >= 0 && v <= 300 ? v : 25;
})();
const supabase = SUPABASE_ENABLED
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

// ====== Word config ======
const MIN_WORD_LEN = 5;
const MAX_WORD_LEN = 7;
const MAX_ATTEMPTS = 6;

// ====== Ability costs ======
const REVEAL_LETTER_COST_COINS = Number(
  process.env.REVEAL_LETTER_COST_COINS || 25
);

const BASE_TOKEN_PRICE = 150;
const VIP_DURATION_DAYS = (() => {
  const v = parseInt(process.env.VIP_DURATION_DAYS || "30", 10);
  return Number.isFinite(v) && v >= 1 && v <= 365 ? v : 30;
})();
const VIP_MAX_ACTIVE_TOURNAMENTS = (() => {
  const v = parseInt(process.env.VIP_MAX_ACTIVE_TOURNAMENTS || "1", 10);
  return Number.isFinite(v) && v >= 1 && v <= 10 ? v : 1;
})();
const VIP_TOURNAMENT_COOLDOWN_MINUTES = (() => {
  const v = parseInt(process.env.VIP_TOURNAMENT_COOLDOWN_MINUTES || "180", 10);
  return Number.isFinite(v) && v >= 0 && v <= 10080 ? v : 180;
})();
const VIP_TOURNAMENT_MAX_PARTICIPANTS = (() => {
  const v = parseInt(process.env.VIP_TOURNAMENT_MAX_PARTICIPANTS || "16", 10);
  return Number.isFinite(v) && v >= 2 && v <= 128 ? v : 16;
})();
const WEEKLY_TOURNAMENT_ENABLED =
  String(process.env.WEEKLY_TOURNAMENT_ENABLED || "1") === "1";
const WEEKLY_TOURNAMENT_TITLE = String(
  process.env.WEEKLY_TOURNAMENT_TITLE || "Piektdienas turnīrs"
).trim();
const WEEKLY_TOURNAMENT_WEEKDAY = 5; // 1=Mon ... 7=Sun (Riga TZ)
const WEEKLY_TOURNAMENT_HOUR = (() => {
  const v = parseInt(process.env.WEEKLY_TOURNAMENT_HOUR || "20", 10);
  return Number.isFinite(v) && v >= 0 && v <= 23 ? v : 20;
})();
const WEEKLY_TOURNAMENT_MINUTE = (() => {
  const v = parseInt(process.env.WEEKLY_TOURNAMENT_MINUTE || "0", 10);
  return Number.isFinite(v) && v >= 0 && v <= 59 ? v : 0;
})();
const WEEKLY_TOURNAMENT_SLOTS = (() => {
  const fallback = process.env.NODE_ENV === "test" ? 32 : 8;
  const v = parseInt(process.env.WEEKLY_TOURNAMENT_SLOTS || `${fallback}`, 10);
  return Number.isFinite(v) && v >= 2 && v <= 32 ? v : fallback;
})();
const WEEKLY_TOURNAMENT_MODE_ROTATION_RAW = String(
  process.env.WEEKLY_TOURNAMENT_MODE_ROTATION ||
    "single_elimination,double_elimination,round_robin"
).trim();
const WEEKLY_TOURNAMENT_MIN_ACCOUNT_AGE_HOURS = (() => {
  const fallback = process.env.NODE_ENV === "test" ? 0 : 0;
  const v = parseInt(
    process.env.WEEKLY_TOURNAMENT_MIN_ACCOUNT_AGE_HOURS || `${fallback}`,
    10
  );
  return Number.isFinite(v) && v >= 0 && v <= 720 ? v : fallback;
})();
const WEEKLY_TOURNAMENT_MIN_TOTAL_GUESSES = (() => {
  const fallback = process.env.NODE_ENV === "test" ? 0 : 0;
  const v = parseInt(
    process.env.WEEKLY_TOURNAMENT_MIN_TOTAL_GUESSES || `${fallback}`,
    10
  );
  return Number.isFinite(v) && v >= 0 && v <= 500 ? v : fallback;
})();
const WEEKLY_TOURNAMENT_REQUIRE_UNIQUE_DEVICE =
  String(process.env.WEEKLY_TOURNAMENT_REQUIRE_UNIQUE_DEVICE || "1") === "1";
const ONESIGNAL_REST_API_KEY = String(
  process.env.ONESIGNAL_REST_API_KEY || ""
).trim();
const DAY_MS = 24 * 60 * 60 * 1000;
const TITLE_MAX_LEN = (() => {
  const v = parseInt(process.env.TITLE_MAX_LEN || "32", 10);
  return Number.isFinite(v) && v >= 8 && v <= 64 ? v : 32;
})();
const EMAIL_MAX_LEN = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const REGION_NAMES = ["Zemgale", "Latgale", "Vidzeme", "Kurzeme"];
const REGION_MAP = new Map(REGION_NAMES.map((n) => [n.toLowerCase(), n]));
const REGION_POINTS_PER_WIN = (() => {
  const v = parseInt(process.env.REGION_POINTS_PER_WIN || "1", 10);
  return Number.isFinite(v) && v >= 0 && v <= 50 ? v : 1;
})();
const REGION_POINTS_MAX_ACTION = (() => {
  const v = parseInt(process.env.REGION_POINTS_MAX_ACTION || "10", 10);
  return Number.isFinite(v) && v >= 1 && v <= 100 ? v : 10;
})();
const REGION_BONUS_MULTIPLIER = (() => {
  const v = parseInt(process.env.REGION_BONUS_MULTIPLIER || "2", 10);
  return Number.isFinite(v) && v >= 1 && v <= 5 ? v : 2;
})();
const REGION_BONUS_WINDOWS = (() => {
  const raw = String(process.env.REGION_BONUS_WINDOWS || "20:00-21:00").trim();
  const parts = raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const windows = [];
  for (const p of parts) {
    const [a, b] = p.split("-").map((x) => x.trim());
    if (!a || !b) continue;
    const toMin = (s) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(s);
      if (!m) return null;
      const hh = parseInt(m[1], 10);
      const mm = parseInt(m[2], 10);
      if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
      if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
      return hh * 60 + mm;
    };
    const start = toMin(a);
    const end = toMin(b);
    if (start == null || end == null) continue;
    if (start === end) continue;
    windows.push({ start, end });
  }
  return windows;
})();
const REGION_MVP_BOOST = (() => {
  const v = parseInt(process.env.REGION_MVP_BOOST || "20", 10);
  return Number.isFinite(v) && v >= 0 && v <= 1000 ? v : 20;
})();

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
    : CORS_ORIGINS_RAW.split(",")
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
// Inline avatārs (base64) broadcastiem / meta — sargājam RAM
const AVATAR_INLINE_MAX_CHARS = (() => {
  const v = parseInt(process.env.AVATAR_INLINE_MAX_CHARS || "120000", 10);
  return Number.isFinite(v) && v >= 0 ? v : 120000;
})();
const DM_META_AVATAR_MAX_CHARS = (() => {
  const v = parseInt(process.env.DM_META_AVATAR_MAX_CHARS || "0", 10);
  return Number.isFinite(v) && v >= 0 ? v : 0;
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
const ALLOW_ADMIN_SIGNUP =
  String(
    process.env.ALLOW_ADMIN_SIGNUP ??
      (process.env.NODE_ENV === "test" ? "1" : "0")
  ) === "1";
const ADMIN_USERNAMES_LC = new Set(
  ADMIN_USERNAMES.map((x) => String(x || "").toLowerCase())
);
function isAdminName(name) {
  return ADMIN_USERNAMES_LC.has(String(name || "").toLowerCase());
}
function isAdminUser(u) {
  return !!u && isAdminName(u.username);
}
function normalizeTitle(title) {
  const cleaned = String(title || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned.length > TITLE_MAX_LEN
    ? cleaned.slice(0, TITLE_MAX_LEN)
    : cleaned;
}
function avatarForBroadcast(u) {
  if (!u || typeof u !== "object") return null;
  return compactAvatarUrl(resolveAvatarUrl(u), AVATAR_INLINE_MAX_CHARS);
}
function normalizeRegion(region) {
  const key = String(region || "")
    .trim()
    .toLowerCase();
  return REGION_MAP.get(key) || "";
}
function normalizeEmail(raw) {
  const email = String(raw || "")
    .trim()
    .toLowerCase();
  if (!email) return "";
  if (email.length > EMAIL_MAX_LEN) return "";
  if (!EMAIL_RE.test(email)) return "";
  return email;
}
function compactAvatarUrl(raw, maxChars = AVATAR_INLINE_MAX_CHARS) {
  if (typeof raw !== "string") return null;
  const url = raw.trim();
  if (!url) return null;
  if (url.startsWith("data:image/")) {
    if (!Number.isFinite(maxChars) || maxChars <= 0) return null;
    return url.length <= maxChars ? url : null;
  }
  return url;
}
function sanitizeStorageKeySegment(raw) {
  return String(raw || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 80);
}
function mimeToExt(mime) {
  switch (String(mime || "").toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/svg+xml":
      return "svg";
    default:
      return "";
  }
}
function parseAvatarDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl.trim());
  if (!m) return null;
  const mime = m[1];
  const b64 = m[2];
  try {
    const buffer = Buffer.from(b64, "base64");
    if (!buffer || !buffer.length) return null;
    return { mime, buffer };
  } catch {
    return null;
  }
}
let supabaseBucketReady = false;
async function ensureSupabaseBucket() {
  if (!SUPABASE_ENABLED || !supabase) return false;
  if (supabaseBucketReady) return true;
  const bucket = SUPABASE_STORAGE_BUCKET || "avatars";
  try {
    const { data, error } = await supabase.storage.getBucket(bucket);
    if (!error && data) {
      supabaseBucketReady = true;
      return true;
    }
  } catch {}
  try {
    const { error } = await supabase.storage.createBucket(bucket, {
      public: !!SUPABASE_STORAGE_PUBLIC,
    });
    if (error && !String(error.message || "").includes("already exists")) {
      console.error("Supabase bucket create error:", error);
      return false;
    }
    supabaseBucketReady = true;
    return true;
  } catch (err) {
    console.error("Supabase bucket ensure error:", err);
    return false;
  }
}
function getSupabasePublicUrl(path) {
  if (!SUPABASE_ENABLED || !supabase || !SUPABASE_STORAGE_PUBLIC) return null;
  if (!path) return null;
  try {
    const res = supabase.storage
      .from(SUPABASE_STORAGE_BUCKET)
      .getPublicUrl(path);
    return res?.data?.publicUrl || null;
  } catch {
    return null;
  }
}
const avatarSignedCache = new Map(); // path -> { url, expiresAt }
async function getSupabaseSignedUrl(path) {
  if (!SUPABASE_ENABLED || !supabase || !path)
    return { url: null, expiresAt: 0 };
  if (SUPABASE_STORAGE_PUBLIC) {
    return { url: getSupabasePublicUrl(path), expiresAt: 0 };
  }
  const cached = avatarSignedCache.get(path);
  if (cached && cached.url && cached.expiresAt - Date.now() > 60 * 1000) {
    return cached;
  }
  try {
    const { data, error } = await supabase.storage
      .from(SUPABASE_STORAGE_BUCKET)
      .createSignedUrl(path, SUPABASE_AVATAR_SIGNED_TTL);
    if (error || !data?.signedUrl) return { url: null, expiresAt: 0 };
    const expiresAt = Date.now() + SUPABASE_AVATAR_SIGNED_TTL * 1000;
    const entry = { url: data.signedUrl, expiresAt };
    avatarSignedCache.set(path, entry);
    return entry;
  } catch {
    return { url: null, expiresAt: 0 };
  }
}
function resolveAvatarUrl(user) {
  if (!user) return null;
  if (SUPABASE_ENABLED && user.avatarPath) {
    if (SUPABASE_STORAGE_PUBLIC) return getSupabasePublicUrl(user.avatarPath);
    return null;
  }
  if (typeof user.avatarUrl === "string" && user.avatarUrl.trim()) {
    return user.avatarUrl.trim();
  }
  return null;
}
async function resolveAvatarUrlAsync(user) {
  if (!user) return { url: null, expiresAt: 0 };
  if (SUPABASE_ENABLED && user.avatarPath) {
    if (SUPABASE_STORAGE_PUBLIC) {
      return { url: getSupabasePublicUrl(user.avatarPath), expiresAt: 0 };
    }
    return getSupabaseSignedUrl(user.avatarPath);
  }
  if (typeof user.avatarUrl === "string" && user.avatarUrl.trim()) {
    return { url: user.avatarUrl.trim(), expiresAt: 0 };
  }
  return { url: null, expiresAt: 0 };
}
function clampInt(n, lo, hi, fallback = lo) {
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x)) return fallback;
  return Math.max(lo, Math.min(hi, x));
}

// ======== Laika zona ========
const TZ = "Europe/Riga";

// ======== SEZONA 1 / 2 endAt ========
const SEASON1_END_AT = new Date("2025-12-26T23:59:59+02:00").getTime();
const SEASON2_END_AT_DEFAULT = new Date("2026-03-21T23:59:59+02:00").getTime();

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

const DAILY_MISSION_BONUS_REWARD = {
  xp: parseInt(process.env.DAILY_MISSION_BONUS_XP || "80", 10),
  coins: parseInt(process.env.DAILY_MISSION_BONUS_COINS || "60", 10),
  tokens: parseInt(process.env.DAILY_MISSION_BONUS_TOKENS || "1", 10),
};

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
const CHAT_STORE_MODE = String(process.env.CHAT_STORE_MODE || "none")
  .trim()
  .toLowerCase();
const CHAT_STORE_ON_SUPABASE =
  CHAT_STORE_MODE === "supabase" && SUPABASE_ENABLED;
const CHAT_STORE_TABLE = String(
  process.env.CHAT_STORE_TABLE || "chat_messages"
).trim();
const CHAT_HISTORY_LIMIT = (() => {
  const v = parseInt(process.env.CHAT_HISTORY_LIMIT || "60", 10);
  return Number.isFinite(v) && v >= 0 && v <= 500 ? v : 60;
})();
const CHAT_RETENTION_DAYS = (() => {
  const v = parseInt(process.env.CHAT_RETENTION_DAYS || "14", 10);
  return Number.isFinite(v) && v >= 1 && v <= 3650 ? v : 14;
})();
const CHAT_CLEANUP_INTERVAL_MS = (() => {
  const v = parseInt(process.env.CHAT_CLEANUP_INTERVAL_MS || "21600000", 10); // 6h
  return Number.isFinite(v) && v >= 60000 ? v : 21600000;
})();

// ======== PRIVĀTAIS ČATS (DM) ========
const DM_MAX_LEN = 400;
const DM_RATE_MS = 650;
const DM_DUP_WINDOW_MS = 5000;
const DM_TYPING_RATE_MS = 800;
const DM_THREAD_MAX = 200; // max ziņas vienā sarunā (katram userim)
// DM storage mode: "client" (default) = netiek glabāts serverī
const DM_STORE_MODE = String(process.env.DM_STORE_MODE || "client")
  .trim()
  .toLowerCase();
const DM_STORE_ON_SERVER = DM_STORE_MODE === "server";
const REPORT_REASON_MAX_LEN = 220;
const REPORT_TEXT_MAX_LEN = 200;
const REPORTS_MAX = (() => {
  const v = parseInt(process.env.REPORTS_MAX || "2000", 10);
  return Number.isFinite(v) && v >= 100 && v <= 20000 ? v : 2000;
})();
const REPORT_RETENTION_DAYS = (() => {
  const v = parseInt(process.env.REPORT_RETENTION_DAYS || "180", 10);
  return Number.isFinite(v) && v >= 7 && v <= 3650 ? v : 180;
})();

// ======== Storage mode (users/reports) ========
const USERS_STORE_MODE = String(process.env.USERS_STORE_MODE || "file")
  .trim()
  .toLowerCase();
const USERS_STORE_ON_SUPABASE =
  USERS_STORE_MODE === "supabase" && SUPABASE_ENABLED;
const USERS_STORE_TABLE = String(
  process.env.USERS_STORE_TABLE || "vz_users"
).trim();
const USERS_STORE_BATCH = (() => {
  const v = parseInt(process.env.USERS_STORE_BATCH || "500", 10);
  return Number.isFinite(v) && v >= 50 && v <= 2000 ? v : 500;
})();

const REPORTS_STORE_MODE = String(process.env.REPORTS_STORE_MODE || "file")
  .trim()
  .toLowerCase();
const REPORTS_STORE_ON_SUPABASE =
  REPORTS_STORE_MODE === "supabase" && SUPABASE_ENABLED;
const REPORTS_STORE_TABLE = String(
  process.env.REPORTS_STORE_TABLE || "vz_reports"
).trim();
const REPORTS_STORE_BATCH = (() => {
  const v = parseInt(process.env.REPORTS_STORE_BATCH || "500", 10);
  return Number.isFinite(v) && v >= 50 && v <= 2000 ? v : 500;
})();

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
  const suffix = `${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}`;
  const tmp = `${file}.${suffix}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

// ======== TURNĪRI (brackets-manager) ========
const TOURNAMENT_NAME_MAX_LEN = 64;
const TOURNAMENT_MAX_PARTICIPANTS = 128;
const TOURNAMENT_STAGE_TYPES = new Set([
  "single_elimination",
  "double_elimination",
  "round_robin",
]);
const TOURNAMENT_GRAND_FINAL_TYPES = new Set(["none", "simple", "double"]);

function normalizeWeeklyTournamentModes(raw) {
  const list = String(raw || "")
    .split(",")
    .map((x) =>
      String(x || "")
        .trim()
        .toLowerCase()
    )
    .filter((x) => TOURNAMENT_STAGE_TYPES.has(x));
  const uniq = [];
  const seen = new Set();
  for (const mode of list) {
    if (seen.has(mode)) continue;
    seen.add(mode);
    uniq.push(mode);
  }
  return uniq.length ? uniq : ["single_elimination"];
}

const WEEKLY_TOURNAMENT_MODES = normalizeWeeklyTournamentModes(
  WEEKLY_TOURNAMENT_MODE_ROTATION_RAW
);

function tournamentModeLabel(mode) {
  const key = String(mode || "")
    .trim()
    .toLowerCase();
  if (key === "single_elimination") return "Izslēgšanas turnīrs";
  if (key === "double_elimination") return "Dubultā izslēgšana";
  if (key === "round_robin") return "Apļa turnīrs";
  return "Turnīrs";
}

function weekdayInTz(date = new Date(), tz = TZ) {
  const short = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
  }).format(date);
  const map = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return map[short] || 1;
}

function rigaLocalDateToUtcTs(y, mo, d, hh, mm) {
  const probe = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const offsetMin = getTzOffsetMinutes(TZ, probe);
  return Date.UTC(y, mo - 1, d, hh, mm, 0) - offsetMin * 60 * 1000;
}

function nextWeeklyTournamentStartAt(nowTs = Date.now()) {
  const now = new Date(nowTs);
  const parts = datePartsInTz(now, TZ);
  const curWeekday = weekdayInTz(now, TZ);
  const nowMinutes = minutesInTz(now, TZ);
  const targetMinutes = WEEKLY_TOURNAMENT_HOUR * 60 + WEEKLY_TOURNAMENT_MINUTE;

  let addDays = (WEEKLY_TOURNAMENT_WEEKDAY - curWeekday + 7) % 7;
  if (addDays === 0 && nowMinutes >= targetMinutes) addDays = 7;

  const base = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
  base.setUTCDate(base.getUTCDate() + addDays);
  const y = base.getUTCFullYear();
  const mo = base.getUTCMonth() + 1;
  const d = base.getUTCDate();
  return rigaLocalDateToUtcTs(
    y,
    mo,
    d,
    WEEKLY_TOURNAMENT_HOUR,
    WEEKLY_TOURNAMENT_MINUTE
  );
}

function weeklyModeForStartAt(startAtTs) {
  const ts = Math.max(0, Number(startAtTs) || Date.now());
  const weekAnchor = weekKey(new Date(ts), TZ); // YYYY-MM-DD (Monday)
  const [y, mo, d] = String(weekAnchor)
    .split("-")
    .map((x) => parseInt(x, 10));
  const asUtc = Date.UTC(y || 1970, (mo || 1) - 1, d || 1);
  const refMondayUtc = Date.UTC(1970, 0, 5); // first Monday of 1970
  const idx = Math.max(0, Math.floor((asUtc - refMondayUtc) / (7 * DAY_MS)));
  const modes = Array.isArray(WEEKLY_TOURNAMENT_MODES)
    ? WEEKLY_TOURNAMENT_MODES
    : ["single_elimination"];
  return modes[idx % modes.length] || "single_elimination";
}

function buildInitialWeeklyQueue(nowTs = Date.now()) {
  return {
    startAt: nextWeeklyTournamentStartAt(nowTs),
    slots: WEEKLY_TOURNAMENT_SLOTS,
    participants: [],
    remindersSent: [],
    lastCycle: null, // { kind, at, joined, tournamentId, note }
    createdAt: nowTs,
  };
}

function buildInitialTournamentStore() {
  return {
    nextTournamentId: 1,
    tournaments: [],
    weeklyQueue: buildInitialWeeklyQueue(Date.now()),
  };
}

function normalizeWeeklyQueue(raw, nowTs = Date.now()) {
  const base = buildInitialWeeklyQueue(nowTs);
  const src = raw && typeof raw === "object" ? raw : {};
  const startAt = Math.max(0, Number(src.startAt) || 0);
  const slots = Math.max(
    2,
    Math.min(32, Math.floor(Number(src.slots) || WEEKLY_TOURNAMENT_SLOTS))
  );
  const participants = Array.isArray(src.participants)
    ? src.participants
        .map((u) => String(u || "").trim())
        .filter(Boolean)
        .slice(0, slots)
    : [];
  const seen = new Set();
  const deduped = [];
  for (const name of participants) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(name);
  }
  const remindersSent = Array.isArray(src.remindersSent)
    ? src.remindersSent
        .map((x) => String(x || "").trim())
        .filter(Boolean)
        .slice(0, 6)
    : [];
  const out = {
    startAt: startAt > nowTs - 8 * DAY_MS ? startAt : base.startAt,
    slots,
    participants: deduped,
    remindersSent,
    lastCycle:
      src.lastCycle && typeof src.lastCycle === "object" ? src.lastCycle : null,
    createdAt: Math.max(0, Number(src.createdAt) || nowTs),
  };
  if (out.participants.length > out.slots) {
    out.participants = out.participants.slice(0, out.slots);
  }
  return out;
}

function normalizeTournamentStore(raw) {
  const base = buildInitialTournamentStore();
  const out = raw && typeof raw === "object" ? raw : base;

  if (!Array.isArray(out.tournaments)) out.tournaments = [];
  out.tournaments = out.tournaments
    .filter((t) => t && typeof t === "object")
    .map((t) => ({
      id: Math.max(1, Math.floor(Number(t.id) || 0)),
      name: normalizeTournamentName(t.name),
      type: normalizeTournamentType(t.type),
      stageId: Number.isFinite(Number(t.stageId))
        ? Math.floor(Number(t.stageId))
        : null,
      createdAt: Math.max(0, Number(t.createdAt) || 0),
      createdBy: String(t.createdBy || "").trim(),
      participantCount: Math.max(
        0,
        Math.floor(Number(t.participantCount) || 0)
      ),
      status:
        t.status === "completed" || t.status === "archived"
          ? t.status
          : "active",
      completedAt: Math.max(0, Number(t.completedAt) || 0),
    }));

  const maxId = out.tournaments.reduce(
    (m, t) => Math.max(m, Math.floor(Number(t.id) || 0)),
    0
  );
  const next = Math.floor(Number(out.nextTournamentId) || 0);
  out.nextTournamentId = Math.max(maxId + 1, next || 1);
  out.weeklyQueue = normalizeWeeklyQueue(out.weeklyQueue, Date.now());
  return out;
}

function saveTournamentStore() {
  saveJsonAtomic(TOURNAMENTS_FILE, tournamentStore);
}

function ensureVipFields(u) {
  if (!u || typeof u !== "object") return;
  if (!Number.isFinite(Number(u.vipUntil))) u.vipUntil = 0;
  u.vipUntil = Math.max(0, Math.floor(Number(u.vipUntil) || 0));
  if (typeof u.vipTier !== "string") u.vipTier = "none";
  if (typeof u.vipLastTournamentAt !== "number") u.vipLastTournamentAt = 0;
  if (typeof u.vipLastPurchaseAt !== "number") u.vipLastPurchaseAt = 0;
}

function isVipActive(u, now = Date.now()) {
  ensureVipFields(u);
  return Number(u?.vipUntil || 0) > now;
}

function canCreateTournament(u, now = Date.now()) {
  return isAdminUser(u) || isVipActive(u, now);
}

function countActiveTournamentsByCreator(username) {
  const name = String(username || "")
    .trim()
    .toLowerCase();
  if (!name) return 0;
  return (tournamentStore.tournaments || []).filter((t) => {
    const creator = String(t?.createdBy || "")
      .trim()
      .toLowerCase();
    const status = String(t?.status || "active")
      .trim()
      .toLowerCase();
    return creator === name && status !== "completed" && status !== "archived";
  }).length;
}

function formatMinutesLabel(mins) {
  const m = Math.max(0, Math.floor(Number(mins) || 0));
  if (!m) return "0 min";
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (!h) return `${rest} min`;
  if (!rest) return `${h}h`;
  return `${h}h ${rest}m`;
}

function validateTournamentCreateAccess(user, seedingLen) {
  if (isAdminUser(user)) return { ok: true, mode: "admin" };

  if (!isVipActive(user)) {
    return {
      ok: false,
      status: 403,
      message: "Turnīru veidošanai vajag aktīvu VIP statusu.",
    };
  }

  if (seedingLen > VIP_TOURNAMENT_MAX_PARTICIPANTS) {
    return {
      ok: false,
      status: 400,
      message: `VIP turnīrā max ${VIP_TOURNAMENT_MAX_PARTICIPANTS} dalībnieki.`,
    };
  }

  const activeByUser = countActiveTournamentsByCreator(user?.username);
  if (activeByUser >= VIP_MAX_ACTIVE_TOURNAMENTS) {
    return {
      ok: false,
      status: 400,
      message: `VIP limits: max ${VIP_MAX_ACTIVE_TOURNAMENTS} aktīvs turnīrs.`,
    };
  }

  const cooldownMs = VIP_TOURNAMENT_COOLDOWN_MINUTES * 60 * 1000;
  const last = Math.max(0, Number(user?.vipLastTournamentAt) || 0);
  if (cooldownMs > 0 && last > 0) {
    const waitMs = cooldownMs - (Date.now() - last);
    if (waitMs > 0) {
      return {
        ok: false,
        status: 400,
        message: `VIP cooldown: pagaidi ${formatMinutesLabel(
          Math.ceil(waitMs / 60000)
        )}.`,
      };
    }
  }

  return { ok: true, mode: "vip" };
}

function parseNonNegativeIntId(raw) {
  const id = Number(raw);
  if (!Number.isFinite(id) || id < 0 || !Number.isInteger(id)) return null;
  return id;
}

function parseTournamentId(raw) {
  const id = parseNonNegativeIntId(raw);
  if (id == null || id < 1) return null;
  return id;
}

function getTournamentMetaById(tournamentId) {
  const id = parseTournamentId(tournamentId);
  if (!id) return null;
  return (
    tournamentStore.tournaments.find((t) => Number(t?.id) === Number(id)) ||
    null
  );
}

function normalizeTournamentName(raw) {
  const name = String(raw || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) return "";
  return name.slice(0, TOURNAMENT_NAME_MAX_LEN);
}

function normalizeTournamentType(raw) {
  const type = String(raw || "single_elimination")
    .trim()
    .toLowerCase();
  if (TOURNAMENT_STAGE_TYPES.has(type)) return type;
  return "single_elimination";
}

function sanitizeTournamentSeeding(seeding) {
  if (!Array.isArray(seeding)) return [];
  const out = [];
  const seen = new Set();
  for (const item of seeding) {
    const name = String(item || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!name) continue;
    const normalized = name.slice(0, 30);
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= TOURNAMENT_MAX_PARTICIPANTS) break;
  }
  return out;
}

function buildTournamentStageSettings(type, rawSettings) {
  const settings = {};
  const src = rawSettings && typeof rawSettings === "object" ? rawSettings : {};

  if (Number.isFinite(Number(src.matchesChildCount))) {
    const cc = Math.floor(Number(src.matchesChildCount));
    if (cc >= 1 && cc <= 9) settings.matchesChildCount = cc;
  }

  if (type === "single_elimination") {
    if (typeof src.consolationFinal === "boolean") {
      settings.consolationFinal = src.consolationFinal;
    }
  }

  if (type === "double_elimination") {
    const gf = String(src.grandFinal || "simple")
      .trim()
      .toLowerCase();
    settings.grandFinal = TOURNAMENT_GRAND_FINAL_TYPES.has(gf) ? gf : "simple";
  }

  if (type === "round_robin") {
    const mode = String(src.roundRobinMode || "simple")
      .trim()
      .toLowerCase();
    settings.roundRobinMode = mode === "double" ? "double" : "simple";
    if (Number.isFinite(Number(src.groupCount))) {
      const gc = Math.floor(Number(src.groupCount));
      if (gc >= 1 && gc <= 32) settings.groupCount = gc;
    }
  }

  return Object.keys(settings).length ? settings : undefined;
}

async function getTournamentSnapshot(tournamentId) {
  const data = await tournamentManager.get.tournamentData(tournamentId);
  const currentStage = await tournamentManager.get.currentStage(tournamentId);
  const currentRound = currentStage
    ? await tournamentManager.get.currentRound(currentStage.id)
    : null;
  const currentMatches = currentStage
    ? await tournamentManager.get.currentMatches(currentStage.id)
    : [];
  return { data, currentStage, currentRound, currentMatches };
}

async function getTournamentParticipantNameMap(tournamentId) {
  const rows =
    (await tournamentDb.select("participant", {
      tournament_id: tournamentId,
    })) || [];
  const out = new Map();
  for (const p of rows) {
    if (!p || p.id == null) continue;
    out.set(Number(p.id), String(p.name || "").trim());
  }
  return out;
}

let tournamentStore = normalizeTournamentStore(
  loadJsonSafe(TOURNAMENTS_FILE, null)
);
saveTournamentStore();
const tournamentDb = new JsonDatabase(TOURNAMENTS_DB_FILE);
const tournamentManager = new BracketsManager(tournamentDb);

function getUserByUsernameLoose(username) {
  const target = String(username || "")
    .trim()
    .toLowerCase();
  if (!target) return null;
  for (const u of Object.values(USERS || {})) {
    if (!u) continue;
    if (
      String(u.username || "")
        .trim()
        .toLowerCase() === target
    )
      return u;
  }
  return null;
}

function getUserDeviceIdSet(user) {
  const set = new Set();
  if (!user || typeof user !== "object") return set;
  const first = String(user.createdDeviceId || "").trim();
  if (first) set.add(first);
  const many = Array.isArray(user.deviceIds) ? user.deviceIds : [];
  for (const raw of many) {
    const v = String(raw || "").trim();
    if (v) set.add(v);
  }
  return set;
}

function hasSharedDevice(candidate, usernames) {
  if (!WEEKLY_TOURNAMENT_REQUIRE_UNIQUE_DEVICE) return false;
  const mine = getUserDeviceIdSet(candidate);
  if (!mine.size) return false;
  for (const uname of usernames || []) {
    const other = getUserByUsernameLoose(uname);
    if (!other || other.username === candidate.username) continue;
    const theirs = getUserDeviceIdSet(other);
    if (!theirs.size) continue;
    for (const did of mine) {
      if (theirs.has(did)) return true;
    }
  }
  return false;
}

function evaluateWeeklyJoinEligibility(user, queuedUsers = []) {
  if (!user) {
    return { ok: false, message: "Lietotājs nav atrasts." };
  }
  if (isAdminUser(user)) return { ok: true };

  const now = Date.now();
  const createdAt = Math.max(0, Number(user.createdAt) || 0);
  const ageHours = createdAt ? (now - createdAt) / (60 * 60 * 1000) : null;
  if (ageHours !== null && ageHours < WEEKLY_TOURNAMENT_MIN_ACCOUNT_AGE_HOURS) {
    return {
      ok: false,
      message: `Profils ir pārāk jauns. Vajag vismaz ${WEEKLY_TOURNAMENT_MIN_ACCOUNT_AGE_HOURS}h kopš reģistrācijas.`,
    };
  }

  const guesses = Math.max(0, Number(user.totalGuesses) || 0);
  if (guesses < WEEKLY_TOURNAMENT_MIN_TOTAL_GUESSES) {
    return {
      ok: false,
      message: `Lai pieteiktos turnīram, vispirms nospēlē vismaz ${WEEKLY_TOURNAMENT_MIN_TOTAL_GUESSES} minējumus.`,
    };
  }

  if (hasSharedDevice(user, queuedUsers)) {
    return {
      ok: false,
      message:
        "Šis profils izskatās pēc alt/fake (sakrīt ierīce ar citu dalībnieku). Izmanto unikālu spēlētāja kontu.",
    };
  }

  return { ok: true };
}

function ensureWeeklyQueueState(nowTs = Date.now()) {
  if (
    !tournamentStore.weeklyQueue ||
    typeof tournamentStore.weeklyQueue !== "object"
  ) {
    tournamentStore.weeklyQueue = buildInitialWeeklyQueue(nowTs);
    saveTournamentStore();
    return tournamentStore.weeklyQueue;
  }
  const q = tournamentStore.weeklyQueue;
  const slots = Math.max(
    2,
    Math.min(32, Math.floor(Number(q.slots) || WEEKLY_TOURNAMENT_SLOTS))
  );
  let changed = false;
  if (slots !== Number(q.slots)) {
    q.slots = slots;
    changed = true;
  }
  if (!Array.isArray(q.participants)) {
    q.participants = [];
    changed = true;
  }
  if (!Array.isArray(q.remindersSent)) {
    q.remindersSent = [];
    changed = true;
  }
  if (!Number.isFinite(Number(q.startAt)) || Number(q.startAt) <= 0) {
    q.startAt = nextWeeklyTournamentStartAt(nowTs);
    q.participants = [];
    q.remindersSent = [];
    changed = true;
  }
  if (changed) saveTournamentStore();
  return q;
}

function resetWeeklyQueueCycle(reason = "", nowTs = Date.now(), extra = {}) {
  const q = ensureWeeklyQueueState(nowTs);
  q.lastCycle = {
    kind: String(reason || "rolled").trim() || "rolled",
    at: nowTs,
    joined: Array.isArray(q.participants) ? q.participants.length : 0,
    ...extra,
  };
  q.startAt = nextWeeklyTournamentStartAt(
    Math.max(nowTs + 1000, q.startAt + 1000)
  );
  q.participants = [];
  q.remindersSent = [];
  q.createdAt = nowTs;
  q.slots = WEEKLY_TOURNAMENT_SLOTS;
  saveTournamentStore();
  return q;
}

function formatWeeklyTournamentName(startAtTs) {
  const dt = new Date(Number(startAtTs) || Date.now());
  const datePart = dt.toLocaleDateString("lv-LV", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const timePart = dt.toLocaleTimeString("lv-LV", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${WEEKLY_TOURNAMENT_TITLE} ${datePart} ${timePart}`;
}

function buildWeeklyQueuePayload(user) {
  const q = ensureWeeklyQueueState(Date.now());
  const participants = Array.isArray(q.participants) ? q.participants : [];
  const mode = weeklyModeForStartAt(Number(q.startAt) || Date.now());
  const username = String(user?.username || "").trim();
  const isJoined = !!participants.find(
    (u) =>
      String(u || "")
        .trim()
        .toLowerCase() === username.toLowerCase()
  );
  const now = Date.now();
  const startedWindowPassed = now >= Number(q.startAt || 0);
  const slots = Math.max(
    2,
    Math.floor(Number(q.slots) || WEEKLY_TOURNAMENT_SLOTS)
  );
  const full = participants.length >= slots;
  const elig = evaluateWeeklyJoinEligibility(user, participants);
  const canJoin =
    WEEKLY_TOURNAMENT_ENABLED &&
    !startedWindowPassed &&
    !full &&
    !isJoined &&
    !!elig.ok;

  return {
    enabled: WEEKLY_TOURNAMENT_ENABLED,
    title: WEEKLY_TOURNAMENT_TITLE,
    mode,
    modeLabel: tournamentModeLabel(mode),
    startAt: Number(q.startAt || 0),
    now,
    slots,
    joinedCount: participants.length,
    participants: participants.slice(0, slots),
    isJoined,
    canJoin,
    startsOnlyWhenFull: true,
    waitForAllSlots: true,
    joinBlockedReason: canJoin
      ? ""
      : isJoined
        ? "Tu jau esi pieteicies."
        : elig.message || "",
    rules: [
      "Starts tikai tad, ja aizņemti visi sloti.",
      `Nākamais starts: piektdien ${String(WEEKLY_TOURNAMENT_HOUR).padStart(
        2,
        "0"
      )}:${String(WEEKLY_TOURNAMENT_MINUTE).padStart(2, "0")} (Rīga).`,
      "Neizšķirts mačā nav atļauts.",
      `Anti-fake: vismaz ${WEEKLY_TOURNAMENT_MIN_TOTAL_GUESSES} minējumi + unikāla ierīce starp dalībniekiem.`,
    ],
    lastCycle: q.lastCycle || null,
  };
}

async function sendOneSignalNotificationToUsers(usernames, heading, content) {
  if (!ONESIGNAL_APP_ID || !ONESIGNAL_REST_API_KEY) return false;
  const ids = Array.isArray(usernames)
    ? usernames.map((u) => String(u || "").trim()).filter(Boolean)
    : [];
  if (!ids.length) return false;
  try {
    const response = await fetch("https://api.onesignal.com/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Key ${ONESIGNAL_REST_API_KEY}`,
      },
      body: JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        include_external_user_ids: ids,
        headings: { en: heading },
        contents: { en: content },
        url: "/game.html",
      }),
    });
    return response.ok;
  } catch (err) {
    console.warn("OneSignal push send error:", err);
    return false;
  }
}

async function maybeSendWeeklyQueueReminders(nowTs = Date.now()) {
  const q = ensureWeeklyQueueState(nowTs);
  const participants = Array.isArray(q.participants) ? q.participants : [];
  if (!participants.length) return;
  const msToStart = Number(q.startAt || 0) - nowTs;
  if (msToStart <= 0) return;

  const reminders = [
    { key: "60m", ms: 60 * 60 * 1000, msg: "Turnīrs sākas pēc ~60 minūtēm." },
    { key: "15m", ms: 15 * 60 * 1000, msg: "Turnīrs sākas pēc ~15 minūtēm." },
  ];

  for (const r of reminders) {
    if (msToStart > r.ms) continue;
    if (q.remindersSent.includes(r.key)) continue;
    q.remindersSent.push(r.key);
    saveTournamentStore();
    await sendOneSignalNotificationToUsers(
      participants,
      "VĀRDU ZONA turnīra atgādinājums",
      `${r.msg} Ja trūkst sloti, aicini draugu.`
    );
  }
}

async function createTournamentFromWeeklyQueue(queue, nowTs = Date.now()) {
  const participants = Array.isArray(queue?.participants)
    ? queue.participants.map((u) => String(u || "").trim()).filter(Boolean)
    : [];
  const slots = Math.max(
    2,
    Math.floor(Number(queue?.slots) || WEEKLY_TOURNAMENT_SLOTS)
  );
  if (participants.length < slots) return null;
  const seeding = participants.slice(0, slots);
  const mode = weeklyModeForStartAt(Number(queue?.startAt) || nowTs);
  const tournamentId = Number(tournamentStore.nextTournamentId || 1);
  tournamentStore.nextTournamentId = tournamentId + 1;

  const name = formatWeeklyTournamentName(Number(queue?.startAt) || nowTs);
  const stage = await tournamentManager.create.stage({
    tournamentId,
    name,
    type: mode,
    seeding,
    settings: buildTournamentStageSettings(mode, {}),
  });

  const meta = {
    id: tournamentId,
    name,
    type: mode,
    stageId: stage?.id ?? null,
    createdAt: nowTs,
    createdBy: "SYSTEM",
    participantCount: seeding.length,
    status: "active",
    completedAt: 0,
  };
  tournamentStore.tournaments.push(meta);
  saveTournamentStore();
  io.emit("tournament:update", { tournamentId, event: "created" });
  broadcastSystemMessage(
    `🏟️ ${name} (${tournamentModeLabel(mode)}) ir sācies! (${seeding.length}/${slots} dalībnieki)`
  );
  await sendOneSignalNotificationToUsers(
    seeding,
    "Turnīrs ir sācies",
    `${name} starts tagad. Veiksmi!`
  );
  return meta;
}

async function processWeeklyTournamentQueue(nowTs = Date.now()) {
  if (!WEEKLY_TOURNAMENT_ENABLED) return;
  const q = ensureWeeklyQueueState(nowTs);
  await maybeSendWeeklyQueueReminders(nowTs);
  if (nowTs < Number(q.startAt || 0)) return;

  const slots = Math.max(
    2,
    Math.floor(Number(q.slots) || WEEKLY_TOURNAMENT_SLOTS)
  );
  const joined = Array.isArray(q.participants) ? q.participants.length : 0;
  if (joined < slots) {
    const next = resetWeeklyQueueCycle("not_full", nowTs, {
      note: `Sākums atcelts: sloti ${joined}/${slots}.`,
    });
    broadcastSystemMessage(
      `⏸️ Nedēļas turnīrs nestartēja (${joined}/${slots}). Nākamais starts: ${new Date(
        next.startAt
      ).toLocaleString("lv-LV", { timeZone: TZ })}.`
    );
    return;
  }

  const created = await createTournamentFromWeeklyQueue(q, nowTs);
  if (!created) return;
  resetWeeklyQueueCycle("started", nowTs, {
    tournamentId: created.id,
    note: `Starts ar ${joined}/${slots}.`,
  });
}

function loadUsers(listOverride) {
  try {
    let arr = null;
    if (typeof listOverride !== "undefined") {
      arr = listOverride;
    } else {
      if (!fs.existsSync(USERS_FILE)) return {};
      const raw = fs.readFileSync(USERS_FILE, "utf8");
      if (!raw.trim()) return {};
      arr = JSON.parse(raw);
    }

    const list = Array.isArray(arr) ? arr : Object.values(arr || {});
    const out = {};
    const seenEmails = new Set();

    for (const u of list) {
      if (!u || !u.username) continue;

      if (!DM_STORE_ON_SERVER && u.dm) {
        delete u.dm;
      }

      if (typeof u.isBanned !== "boolean") u.isBanned = false;
      if (typeof u.mutedUntil !== "number") u.mutedUntil = 0;
      if (!u.lastActionAt) u.lastActionAt = Date.now();
      if (!u.lastPassiveTickAt) u.lastPassiveTickAt = u.lastActionAt;
      if (!u.lastLoginAt)
        u.lastLoginAt = u.createdAt || u.lastActionAt || Date.now();
      if (typeof u.bestStreak !== "number") u.bestStreak = 0;

      if (typeof u.missionsDate !== "string") u.missionsDate = "";
      if (!Array.isArray(u.missions)) u.missions = [];
      if (typeof u.missionsBonusDate !== "string") u.missionsBonusDate = "";

      // Statistika medaļām
      if (typeof u.totalGuesses !== "number") u.totalGuesses = 0;
      if (typeof u.bestWinTimeMs !== "number") u.bestWinTimeMs = 0;
      if (typeof u.winsToday !== "number") u.winsToday = 0;
      if (typeof u.winsTodayDate !== "string") u.winsTodayDate = "";
      if (typeof u.dailyLoginDate !== "string") u.dailyLoginDate = "";
      if (typeof u.weeklyKey !== "string") u.weeklyKey = "";
      if (typeof u.weeklyWins !== "number") u.weeklyWins = 0;
      if (typeof u.weeklyXp !== "number") u.weeklyXp = 0;
      if (typeof u.weeklyScore !== "number") u.weeklyScore = 0;

      // Duēļu statistika
      if (typeof u.duelsWon !== "number") u.duelsWon = 0;
      if (typeof u.duelsLost !== "number") u.duelsLost = 0;
      if (typeof u.duelWinsToday !== "number") u.duelWinsToday = 0;
      if (typeof u.duelWinsTodayDate !== "string") u.duelWinsTodayDate = "";

      // Ekonomikas / ability dienas skaitītāji (misijām)
      if (typeof u.tokensBoughtToday !== "number") u.tokensBoughtToday = 0;
      if (typeof u.tokensBoughtTodayDate !== "string")
        u.tokensBoughtTodayDate = "";
      if (typeof u.revealUsedToday !== "number") u.revealUsedToday = 0;
      if (typeof u.revealUsedTodayDate !== "string") u.revealUsedTodayDate = "";

      // Aktīvais raunds
      if (!u.currentRound) u.currentRound = null;

      // Avatārs
      if (typeof u.avatarUrl !== "string") u.avatarUrl = null;
      if (typeof u.avatarPath !== "string") u.avatarPath = "";
      if (typeof u.avatarUpdatedAt !== "number") u.avatarUpdatedAt = 0;
      if (
        SUPABASE_ENABLED &&
        u.avatarPath &&
        SUPABASE_STORAGE_PUBLIC &&
        !u.avatarUrl
      ) {
        const pub = getSupabasePublicUrl(u.avatarPath);
        if (pub) u.avatarUrl = pub;
      }

      // E-pasts (nav obligāts)
      if (typeof u.email !== "string") u.email = "";
      const cleanedEmail = normalizeEmail(u.email);
      if (cleanedEmail && !seenEmails.has(cleanedEmail)) {
        u.email = cleanedEmail;
        seenEmails.add(cleanedEmail);
      } else {
        u.email = "";
      }

      // Supporter flag
      if (typeof u.supporter !== "boolean") u.supporter = false;
      ensureVipFields(u);

      // Tituls (cosmetic)
      if (typeof u.title !== "string") u.title = "";
      u.title = normalizeTitle(u.title);

      // Novads (klan)
      if (typeof u.region !== "string") u.region = "";
      u.region = normalizeRegion(u.region);
      if (!Number.isFinite(u.regionPoints)) u.regionPoints = 0;
      if (!Number.isFinite(u.regionBoost)) u.regionBoost = 0;
      u.regionPoints = Math.max(0, Math.floor(u.regionPoints));
      u.regionBoost = Math.max(0, Math.floor(u.regionBoost));
      if (!u.regionAttacks || typeof u.regionAttacks !== "object")
        u.regionAttacks = {};
      try {
        const cleaned = {};
        for (const [k, v] of Object.entries(u.regionAttacks || {})) {
          const rk = normalizeRegion(k);
          if (!rk) continue;
          const val = Math.max(0, Math.floor(Number(v) || 0));
          if (!val) continue;
          cleaned[rk] = (cleaned[rk] || 0) + val;
        }
        u.regionAttacks = cleaned;
      } catch {
        u.regionAttacks = {};
      }

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
      if (DM_STORE_ON_SERVER) {
        if (!u.dm || typeof u.dm !== "object") u.dm = {};
        if (!u.dm.threads || typeof u.dm.threads !== "object")
          u.dm.threads = {};
        if (!u.dm.unread || typeof u.dm.unread !== "object") u.dm.unread = {};
        if (!u.dm.lastRead || typeof u.dm.lastRead !== "object")
          u.dm.lastRead = {};
        // DM anti-spam state
        if (typeof u.lastDmAt !== "number") u.lastDmAt = 0;
        if (typeof u.lastDmText !== "string") u.lastDmText = "";
        if (typeof u.lastDmTextAt !== "number") u.lastDmTextAt = 0;
      } else if (u.dm) {
        delete u.dm;
      }

      // Bloķētie lietotāji (case-insensitive map)
      if (
        !u.blocks ||
        typeof u.blocks !== "object" ||
        Array.isArray(u.blocks)
      ) {
        const next = {};
        if (Array.isArray(u.blocks)) {
          for (const item of u.blocks) {
            const raw = String(item || "").trim();
            if (!raw) continue;
            next[raw.toLowerCase()] = raw;
          }
        }
        u.blocks = next;
      }
      try {
        const cleaned = {};
        for (const [k, v] of Object.entries(u.blocks || {})) {
          const raw = String(v || k || "").trim();
          if (!raw) continue;
          cleaned[raw.toLowerCase()] = raw;
        }
        u.blocks = cleaned;
      } catch {
        u.blocks = {};
      }

      // Draugi + ielūgumi
      if (!Array.isArray(u.friends)) u.friends = [];
      if (!u.friendInvitesIn || typeof u.friendInvitesIn !== "object")
        u.friendInvitesIn = {};
      if (!u.friendInvitesOut || typeof u.friendInvitesOut !== "object")
        u.friendInvitesOut = {};

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

let usersSavePending = null;
let usersSaveTimer = null;
let usersSaveInFlight = false;
let usersStoreErrorLogged = false;

function sanitizeUserForStorage(user) {
  if (!user || typeof user !== "object") return null;
  let out = user;
  if (!DM_STORE_ON_SERVER && out.dm) {
    out = { ...out };
    delete out.dm;
  }
  if (SUPABASE_ENABLED && out.avatarPath) {
    if (!SUPABASE_STORAGE_PUBLIC && out.avatarUrl) {
      out = { ...out, avatarUrl: null };
    } else if (
      typeof out.avatarUrl === "string" &&
      out.avatarUrl.startsWith("data:image/")
    ) {
      out = { ...out, avatarUrl: null };
    }
  }
  return out;
}

function buildUsersStorageList(users) {
  const list = [];
  for (const u of Object.values(users || {})) {
    const out = sanitizeUserForStorage(u);
    if (out && out.username) list.push(out);
  }
  return list;
}

function pruneUsersForMemory(users) {
  if (!users || typeof users !== "object") return false;
  let changed = false;
  for (const u of Object.values(users)) {
    if (!u || typeof u !== "object") continue;
    if (
      SUPABASE_ENABLED &&
      u.avatarPath &&
      !SUPABASE_STORAGE_PUBLIC &&
      u.avatarUrl
    ) {
      u.avatarUrl = null;
      changed = true;
    }
    if (
      typeof u.avatarUrl === "string" &&
      u.avatarUrl.startsWith("data:image/") &&
      u.avatarUrl.length > AVATAR_INLINE_MAX_CHARS
    ) {
      u.avatarUrl = null;
      changed = true;
    }
    if (!DM_STORE_ON_SERVER) continue;
    const threads =
      u.dm?.threads && typeof u.dm.threads === "object" ? u.dm.threads : null;
    if (!threads) continue;
    for (const arr of Object.values(threads)) {
      if (!Array.isArray(arr)) continue;
      for (const msg of arr) {
        const meta = msg?.meta;
        if (!meta || typeof meta !== "object") continue;
        const av = meta.avatarUrl;
        if (typeof av === "string" && av.startsWith("data:image/")) {
          if (
            !DM_META_AVATAR_MAX_CHARS ||
            av.length > DM_META_AVATAR_MAX_CHARS
          ) {
            meta.avatarUrl = null;
            changed = true;
          }
        }
      }
    }
  }
  return changed;
}

async function loadUsersFromSupabase() {
  if (!USERS_STORE_ON_SUPABASE || !supabase) return null;
  try {
    const { data, error } = await supabase
      .from(USERS_STORE_TABLE)
      .select("username,data");
    if (error) {
      if (!usersStoreErrorLogged) {
        console.error("Supabase users load error:", error);
        usersStoreErrorLogged = true;
      }
      return null;
    }
    const list = Array.isArray(data)
      ? data.map((row) => {
          const obj = row?.data && typeof row.data === "object" ? row.data : {};
          if (!obj.username && row?.username) obj.username = row.username;
          return obj;
        })
      : [];
    return loadUsers(list);
  } catch (err) {
    if (!usersStoreErrorLogged) {
      console.error("Supabase users load error:", err);
      usersStoreErrorLogged = true;
    }
    return null;
  }
}

async function saveUsersToSupabase(list) {
  if (!USERS_STORE_ON_SUPABASE || !supabase) return;
  const rows = Array.isArray(list)
    ? list
        .filter((u) => u && u.username)
        .map((u) => ({ username: u.username, data: u }))
    : [];
  if (!rows.length) return;
  try {
    for (let i = 0; i < rows.length; i += USERS_STORE_BATCH) {
      const chunk = rows.slice(i, i + USERS_STORE_BATCH);
      const { error } = await supabase
        .from(USERS_STORE_TABLE)
        .upsert(chunk, { onConflict: "username" });
      if (error && !usersStoreErrorLogged) {
        console.error("Supabase users save error:", error);
        usersStoreErrorLogged = true;
      }
    }
  } catch (err) {
    if (!usersStoreErrorLogged) {
      console.error("Supabase users save error:", err);
      usersStoreErrorLogged = true;
    }
  }
}

async function flushUsersSave() {
  if (usersSaveInFlight || !usersSavePending) return;
  const list = usersSavePending;
  usersSavePending = null;
  usersSaveInFlight = true;
  try {
    await saveUsersToSupabase(list);
  } finally {
    usersSaveInFlight = false;
  }
  if (usersSavePending) flushUsersSave();
}

function queueUsersSave(list) {
  if (!USERS_STORE_ON_SUPABASE || !supabase) return;
  usersSavePending = list;
  if (usersSaveTimer) return;
  usersSaveTimer = setTimeout(() => {
    usersSaveTimer = null;
    flushUsersSave();
  }, 1500);
}

function saveUsers(users) {
  const arr = buildUsersStorageList(users);
  if (USERS_STORE_ON_SUPABASE && supabase) {
    queueUsersSave(arr);
    return;
  }
  saveJsonAtomic(USERS_FILE, arr);
}

let USERS = {};

function pruneReports(list) {
  const days = Math.max(1, REPORT_RETENTION_DAYS);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return (Array.isArray(list) ? list : []).filter((r) => {
    const ts = Math.max(0, Number(r?.ts) || 0);
    return !ts || ts >= cutoff;
  });
}

function loadReports() {
  if (!fs.existsSync(REPORTS_FILE)) return [];
  try {
    const raw = fs.readFileSync(REPORTS_FILE, "utf8");
    if (!raw.trim()) return [];
    const arr = JSON.parse(raw);
    return pruneReports(Array.isArray(arr) ? arr.filter(Boolean) : []);
  } catch (err) {
    console.error("Kļūda lasot reports.json:", err);
    return [];
  }
}

let reportsSavePending = null;
let reportsSaveTimer = null;
let reportsSaveInFlight = false;
let reportsStoreErrorLogged = false;

async function loadReportsFromSupabase() {
  if (!REPORTS_STORE_ON_SUPABASE || !supabase) return null;
  try {
    const { data, error } = await supabase
      .from(REPORTS_STORE_TABLE)
      .select("id,ts,reporter,reported,reason,message_id,message_text,source")
      .order("ts", { ascending: false })
      .limit(REPORTS_MAX);
    if (error) {
      if (!reportsStoreErrorLogged) {
        console.error("Supabase reports load error:", error);
        reportsStoreErrorLogged = true;
      }
      return null;
    }
    const list = Array.isArray(data)
      ? data.map((row) => ({
          id: row?.id ?? "",
          ts: Math.max(0, Number(row?.ts) || 0),
          reporter: row?.reporter || "",
          reported: row?.reported || "",
          reason: row?.reason || "",
          messageId: row?.message_id || "",
          messageText: row?.message_text || "",
          source: row?.source || "",
        }))
      : [];
    return pruneReports(list);
  } catch (err) {
    if (!reportsStoreErrorLogged) {
      console.error("Supabase reports load error:", err);
      reportsStoreErrorLogged = true;
    }
    return null;
  }
}

async function saveReportsToSupabase(list) {
  if (!REPORTS_STORE_ON_SUPABASE || !supabase) return;
  const rows = Array.isArray(list)
    ? list
        .filter((r) => r && r.id)
        .map((r) => ({
          id: r.id,
          ts: Math.max(0, Number(r.ts) || 0),
          reporter: r.reporter || "",
          reported: r.reported || "",
          reason: r.reason || "",
          message_id: r.messageId || "",
          message_text: r.messageText || "",
          source: r.source || "",
        }))
    : [];
  if (!rows.length) return;
  try {
    for (let i = 0; i < rows.length; i += REPORTS_STORE_BATCH) {
      const chunk = rows.slice(i, i + REPORTS_STORE_BATCH);
      const { error } = await supabase
        .from(REPORTS_STORE_TABLE)
        .upsert(chunk, { onConflict: "id" });
      if (error && !reportsStoreErrorLogged) {
        console.error("Supabase reports save error:", error);
        reportsStoreErrorLogged = true;
      }
    }
  } catch (err) {
    if (!reportsStoreErrorLogged) {
      console.error("Supabase reports save error:", err);
      reportsStoreErrorLogged = true;
    }
  }
}

async function flushReportsSave() {
  if (reportsSaveInFlight || !reportsSavePending) return;
  const list = reportsSavePending;
  reportsSavePending = null;
  reportsSaveInFlight = true;
  try {
    await saveReportsToSupabase(list);
  } finally {
    reportsSaveInFlight = false;
  }
  if (reportsSavePending) flushReportsSave();
}

function queueReportsSave(list) {
  if (!REPORTS_STORE_ON_SUPABASE || !supabase) return;
  reportsSavePending = list;
  if (reportsSaveTimer) return;
  reportsSaveTimer = setTimeout(() => {
    reportsSaveTimer = null;
    flushReportsSave();
  }, 1500);
}

function saveReports(list) {
  const arr = pruneReports(Array.isArray(list) ? list.slice(-REPORTS_MAX) : []);
  if (REPORTS_STORE_ON_SUPABASE && supabase) {
    queueReportsSave(arr);
    return;
  }
  saveJsonAtomic(REPORTS_FILE, arr);
}

let REPORTS = [];

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
    regionMvp: { lastDate: "", winners: {} },
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
  if (!seasonStore.regionMvp || typeof seasonStore.regionMvp !== "object") {
    seasonStore.regionMvp = { lastDate: "", winners: {} };
  }
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

// Boot fix: ja Sezona 2 jau ir startēta, bet endAt nav “marta beigas”
(() => {
  const envEnd = process.env.SEASON_END_AT;
  if (envEnd) return;
  if (!seasonState || Number(seasonState.id) !== 2) return;
  if (!seasonState.endAt || !Number.isFinite(seasonState.endAt)) return;

  if (seasonState.endAt < SEASON2_END_AT_DEFAULT) {
    seasonState.endAt = SEASON2_END_AT_DEFAULT;
    seasonStore.current = seasonState;
    saveJsonAtomic(SEASONS_FILE, seasonStore);
    console.log("Season 2 endAt adjusted to late-March (default).");
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
  const name = String(nameRaw || "")
    .trim()
    .slice(0, 60);
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
  const q = String(nameRaw || "")
    .trim()
    .toLowerCase();
  if (!q) return null;
  if (USERS[nameRaw]) return nameRaw;
  for (const k of Object.keys(USERS || {})) {
    if (String(k).toLowerCase() === q) return k;
  }
  return null;
}
function findUserKeyByEmail(emailRaw) {
  const email = normalizeEmail(emailRaw);
  if (!email) return null;
  for (const [k, u] of Object.entries(USERS || {})) {
    if (!u || typeof u !== "object") continue;
    if (u.email && u.email === email) return k;
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

// ======== Izaicinājums draugam (viens vārds, mazāk mēģinājumu = uzvara) ========
const CHALLENGE_TTL_MS = 24 * 60 * 60 * 1000;
const CHALLENGE_ID_LEN = 8;
const challenges = new Map();

function genChallengeId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < CHALLENGE_ID_LEN; i++) {
    id += chars[crypto.randomInt(0, chars.length)];
  }
  return id;
}

function pruneExpiredChallenges() {
  const now = Date.now();
  for (const [id, c] of challenges.entries()) {
    if (c.createdAt && now - c.createdAt > CHALLENGE_TTL_MS)
      challenges.delete(id);
  }
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

function datePartsInTz(date = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [y, m, d] = fmt.format(date).split("-");
  return { y: Number(y) || 0, m: Number(m) || 0, d: Number(d) || 0 };
}

function weekKey(date = new Date(), tz = TZ) {
  const parts = datePartsInTz(date, tz);
  const base = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
  const weekday = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
  }).format(date);
  const map = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const dow = map[weekday] || 1;
  base.setUTCDate(base.getUTCDate() - (dow - 1));
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(base);
}

function minutesInTz(date = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(date);
  const h = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
  const m = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}

function isRegionBonusActive(date = new Date()) {
  if (!REGION_BONUS_WINDOWS.length) return false;
  if (REGION_BONUS_MULTIPLIER <= 1) return false;
  const t = minutesInTz(date, TZ);
  for (const w of REGION_BONUS_WINDOWS) {
    if (w.start < w.end) {
      if (t >= w.start && t < w.end) return true;
    } else {
      if (t >= w.start || t < w.end) return true;
    }
  }
  return false;
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

    const tz = parts.find((p) => p.type === "timeZoneName")?.value || "GMT+0";
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
        : type === "fast_wins" ||
            type === "perfect_wins" ||
            type === "duel_wins"
          ? 1 + tier * 0.35
          : 1 + tier * 0.45;

    let target = Math.max(1, Math.round(b * mult));
    const cap = Number(MISSION_TARGET_CAPS[type]);
    if (Number.isFinite(cap) && cap >= 1)
      target = Math.min(target, Math.floor(cap));
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
      for (const m of candidates)
        total += Math.max(0.0001, Number(m.weight) || 1);
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
    selected.push(
      ...pickWeightedUnique(others, Math.max(0, desired - selected.length), rng)
    );

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

  if (
    user.missionsDate !== key ||
    !Array.isArray(user.missions) ||
    !user.missions.length
  ) {
    user.missionsDate = key;
    user.missions = buildDailyMissions(user);
    user.missionsBonusDate = "";
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
        DAILY_MISSION_POOL.find(
          (d) => d && (d.id === c || d.type === t || d.id === t)
        ) || null
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

function getMissionBonusStatus(user) {
  ensureDailyMissions(user);
  const list = Array.isArray(user.missions) ? user.missions : [];
  const total = list.length;
  const completed = list.filter((m) => m && m.isCompleted).length;
  const today = todayKey();
  const isClaimed = user.missionsBonusDate === today;
  const rewards = {
    xp: Math.max(0, Number(DAILY_MISSION_BONUS_REWARD.xp) || 0),
    coins: Math.max(0, Number(DAILY_MISSION_BONUS_REWARD.coins) || 0),
    tokens: Math.max(0, Number(DAILY_MISSION_BONUS_REWARD.tokens) || 0),
  };
  return {
    total,
    completed,
    isCompleted: total > 0 && completed >= total,
    isClaimed,
    rewards,
  };
}

function updateMissionsOnGuess(
  user,
  { isWin, xpGain, winTimeMs, wordLen, attemptsUsed }
) {
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
        if (
          Number.isFinite(attemptsUsed) &&
          attemptsUsed > 0 &&
          attemptsUsed <= lim
        ) {
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
  user.tokensBoughtToday =
    (user.tokensBoughtToday || 0) + Math.max(1, Math.floor(qty || 1));
  return updateMissionsGenericCounter(
    user,
    "token_buys",
    user.tokensBoughtToday
  );
}

function updateMissionsOnRevealUsed(user) {
  resetDailyCountersIfNeeded(user);
  user.revealUsedToday = (user.revealUsedToday || 0) + 1;
  return updateMissionsGenericCounter(
    user,
    "reveal_used",
    user.revealUsedToday
  );
}

function updateMissionsOnChestOpen(user) {
  return updateMissionsGenericCounter(user, "chest_open", 1);
}

function resetWinsTodayIfNeeded(user) {
  const today = todayKey();
  if (user.winsTodayDate !== today) {
    awardRegionMvpIfNeeded(today);
    user.winsTodayDate = today;
    user.winsToday = 0;
  }
}

function ensureWeekly(user) {
  const key = weekKey();
  if (user.weeklyKey !== key) {
    user.weeklyKey = key;
    user.weeklyWins = 0;
    user.weeklyXp = 0;
    user.weeklyScore = 0;
    return true;
  }
  return false;
}

function computeWeeklyLeaderboard(requester) {
  const key = weekKey();
  const list = [];
  let changed = false;

  for (const u of Object.values(USERS || {})) {
    if (!u || !u.username || u.isBanned) continue;
    if (ensureWeekly(u)) changed = true;
    if (u.weeklyKey !== key) continue;
    const wins = Math.max(0, Math.floor(Number(u.weeklyWins) || 0));
    const score = Math.max(0, Math.floor(Number(u.weeklyScore) || 0));
    const xp = Math.max(0, Math.floor(Number(u.weeklyXp) || 0));
    if (!wins && !score && !xp) continue;
    ensureRankFields(u);
    list.push({
      username: u.username,
      wins,
      score,
      xp,
      rankLevel: u.rankLevel || 1,
      rankColor: u.rankColor || "#9CA3AF",
      rankTitle: u.rankTitle || "—",
      avatarUrl: avatarForBroadcast(u),
    });
  }

  list.sort(
    (a, b) =>
      b.wins - a.wins ||
      b.score - a.score ||
      b.xp - a.xp ||
      String(a.username).localeCompare(String(b.username))
  );

  const top = list.slice(0, 10);
  let you = null;
  if (requester && requester.username) {
    const idx = list.findIndex((x) => x.username === requester.username);
    if (idx >= 0) {
      you = { ...list[idx], rank: idx + 1 };
    }
  }

  if (changed) saveUsers(USERS);
  return { weekKey: key, list: top, you };
}

function awardRegionMvpIfNeeded(today) {
  if (!seasonStore.regionMvp || typeof seasonStore.regionMvp !== "object") {
    seasonStore.regionMvp = { lastDate: "", winners: {} };
  }
  if (seasonStore.regionMvp.lastDate === today) return;

  const yesterdayKey = todayKey(new Date(Date.now() - 24 * 3600 * 1000));
  const bestByRegion = new Map(
    REGION_NAMES.map((r) => [r, { username: "", wins: 0, score: 0 }])
  );

  for (const u of Object.values(USERS || {})) {
    if (!u || !u.username || u.isBanned) continue;
    if (u.winsTodayDate !== yesterdayKey) continue;
    const region = normalizeRegion(u.region);
    if (!region) continue;
    const wins = Number(u.winsToday || 0);
    if (wins <= 0) continue;
    const score = Number(u.score || 0);
    const cur = bestByRegion.get(region);
    if (!cur) continue;
    if (
      wins > cur.wins ||
      (wins === cur.wins && score > cur.score) ||
      (wins === cur.wins && score === cur.score && u.username < cur.username)
    ) {
      bestByRegion.set(region, { username: u.username, wins, score });
    }
  }

  const winners = {};
  const winList = [];
  let didChange = false;
  for (const [region, best] of bestByRegion.entries()) {
    if (!best.username) continue;
    winners[region] = { username: best.username, wins: best.wins };
    const u = USERS[best.username];
    if (u && REGION_MVP_BOOST > 0) {
      u.regionBoost =
        Math.max(0, Math.floor(u.regionBoost || 0)) + REGION_MVP_BOOST;
      didChange = true;
    }
    winList.push(`${region}: ${best.username} (${best.wins})`);
  }

  seasonStore.regionMvp.lastDate = today;
  seasonStore.regionMvp.winners = winners;
  saveJsonAtomic(SEASONS_FILE, seasonStore);
  if (didChange) saveUsers(USERS);

  if (winList.length) {
    const bonusMsg =
      REGION_MVP_BOOST > 0 ? ` (+${REGION_MVP_BOOST} novada punkti)` : "";
    broadcastSystemMessage(
      `🏅 Novadu MVP (${yesterdayKey}): ${winList.join(" • ")}${bonusMsg}`
    );
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
    medals.push({
      code: "DAILY_CHAMP",
      icon: "👑",
      label: "Šodienas čempions",
    });
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
  if (!champ)
    return { ok: false, message: "Lietotājs nav atrasts users.json." };

  const medalCode = championMedalCode(sid);
  const finishedAt =
    Number.isFinite(Number(finishedAtOverride)) &&
    Number(finishedAtOverride) > 0
      ? Number(finishedAtOverride)
      : defaultSeasonFinishedAt(sid);

  const rankInfo = ensureRankFields(champ);

  const hofEntry = {
    seasonId: sid,
    username: champ.username,
    score:
      scoreOverride !== undefined &&
      scoreOverride !== null &&
      scoreOverride !== ""
        ? Math.max(0, Math.floor(Number(scoreOverride) || 0))
        : champ.score || 0,
    xp: champ.xp || 0,
    rankTitle: champ.rankTitle || rankInfo.title || "",
    rankLevel: champ.rankLevel || rankInfo.level || 1,
    avatarUrl: avatarForBroadcast(champ),
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
    avatarUrl: avatarForBroadcast(champ),
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
    console.log(
      `SEASON rollover by ${byAdminUsername}: now ${seasonState.name}`
    );
  }

  return { mode: "rolled_next", season: seasonState, hofEntry, didReset };
}

// ======== JWT helperi ========
async function buildMePayload(u) {
  ensureVipFields(u);
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
    nextMinXp && Number.isFinite(nextMinXp) && nextMinXp > minXp
      ? nextMinXp - minXp
      : 0;
  const inLevel = Math.max(0, xp - minXp);
  const pct =
    need > 0 ? Math.max(0, Math.min(100, (inLevel / need) * 100)) : 100;
  const toNext = need > 0 ? Math.max(0, nextMinXp - xp) : 0;

  const { url: avatarUrl, expiresAt: avatarUrlExpiresAt } =
    await resolveAvatarUrlAsync(u);

  return {
    username: u.username,
    email: u.email || "",
    title: u.title || "",
    region: u.region || "",
    regionPoints: Math.max(0, Math.floor(u.regionPoints || 0)),
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
    avatarUrl: avatarUrl || null,
    avatarUrlExpiresAt: avatarUrlExpiresAt || null,
    supporter: !!u.supporter,
    vip: {
      active: isVipActive(u),
      until: Number(u.vipUntil || 0),
      tier: u.vipTier || "none",
      canCreateTournament: canCreateTournament(u),
      purchaseEnabled: false,
    },
    canCreateTournament: canCreateTournament(u),
    isAdmin: isAdminUser(u),
    revealLetterCostCoins: REVEAL_LETTER_COST_COINS,
    blockedUsers: listBlocks(u),
  };
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = String(authHeader)
    .replace(/^Bearer\s+/i, "")
    .trim();
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

const logger = pino(
  process.env.LOG_PRETTY === "1"
    ? {
        level: process.env.LOG_LEVEL || "info",
        transport: {
          target: "pino-pretty",
          options: { translateTime: "SYS:standard", ignore: "pid,hostname" },
        },
      }
    : { level: process.env.LOG_LEVEL || "info" }
);

app.use(
  pinoHttp({
    logger,
    autoLogging: { ignore: (req) => req.url === "/health" },
    redact: ["req.headers.authorization"],
  })
);

app.use(
  helmet({
    // Keep static assets embeddable for existing webview/TWA use-cases.
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        // Frontend talks to Render API host and Socket.IO over HTTPS/WSS.
        "connect-src": [
          "'self'",
          "https://bugats-wordle-server.onrender.com",
          "wss://bugats-wordle-server.onrender.com",
          "https://cdn.onesignal.com",
          "https://onesignal.com",
          "https://*.onesignal.com",
        ],
        // Frontend uses local bundle + selected external SDK hosts.
        "script-src": [
          "'self'",
          "https://cdn.jsdelivr.net",
          "https://unpkg.com",
          "https://cdn.onesignal.com",
        ],
        // Allow the in-game radio stream host while keeping strict defaults.
        "media-src": ["'self'", "https://stream.nightride.fm"],
      },
    },
  })
);

const globalRateLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  limit: Number(process.env.RATE_LIMIT_MAX || 300),
  standardHeaders: "draft-7",
  legacyHeaders: false,
});
const signupRateLimiter = rateLimit({
  windowMs: Number(process.env.SIGNUP_RATE_LIMIT_WINDOW_MS || 60_000),
  limit: Number(process.env.SIGNUP_RATE_LIMIT_MAX || 30),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Pārāk daudz reģistrācijas mēģinājumu. Pamēģini vēlāk." },
});
const loginRateLimiter = rateLimit({
  windowMs: Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 60_000),
  limit: Number(process.env.LOGIN_RATE_LIMIT_MAX || 50),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { message: "Pārāk daudz login mēģinājumu. Pamēģini vēlāk." },
});
const passwordResetRateLimiter = rateLimit({
  windowMs: Number(process.env.PASSWORD_RESET_RATE_LIMIT_WINDOW_MS || 60_000),
  limit: Number(process.env.PASSWORD_RESET_RATE_LIMIT_MAX || 20),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Pārāk daudz paroles atjaunošanas mēģinājumu." },
});
const guessRateLimiter = rateLimit({
  windowMs: Number(process.env.GUESS_RATE_LIMIT_WINDOW_MS || 60_000),
  limit: Number(process.env.GUESS_RATE_LIMIT_MAX || 180),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Pārāk daudz minējumu īsā laikā." },
});
app.use((req, res, next) => {
  if (req.path.startsWith("/socket.io")) return next();
  return globalRateLimiter(req, res, next);
});

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
app.get("/runtime-config.js", (_req, res) => {
  const payload = {
    oneSignalAppId: ONESIGNAL_APP_ID || "",
    oneSignalSafariWebId: ONESIGNAL_SAFARI_WEB_ID || "",
    oneSignalPromptDelaySeconds: ONESIGNAL_PROMPT_DELAY_SECONDS,
  };
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.send(
    `window.VZ_RUNTIME_CONFIG = Object.assign({}, window.VZ_RUNTIME_CONFIG || {}, ${JSON.stringify(
      payload
    )});`
  );
});

if (HAS_STATIC_INDEX) {
  app.use(express.static(STATIC_DIR));
  // Backward-compat for older /wordle URLs (Hostinger -> Render)
  app.use("/wordle", express.static(STATIC_DIR));
  // Allow serving /.well-known (assetlinks.json) for TWA verification
  app.use(
    "/.well-known",
    express.static(path.join(STATIC_DIR, ".well-known"), { dotfiles: "allow" })
  );
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
      region: "",
    };
  }
  const info = ensureRankFields(u);
  return {
    username,
    avatarUrl: avatarForBroadcast(u),
    rankLevel: u.rankLevel || info.level || 1,
    rankTitle: u.rankTitle || info.title || "—",
    rankColor: u.rankColor || info.color || "#9CA3AF",
    supporter: !!u.supporter,
    region: u.region || "",
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
        }|${u.supporter ? 1 : 0}|${u.region || ""}`
    )
    .join(";");

  if (!force && sig === lastOnlineSig) return;
  lastOnlineSig = sig;

  io.emit("onlineList", { count: users.length, users });
}
setInterval(() => broadcastOnlineList(false), 30 * 1000);
setInterval(() => {
  processWeeklyTournamentQueue(Date.now()).catch((err) => {
    console.warn("Weekly queue scheduler error:", err);
  });
}, 15 * 1000);
processWeeklyTournamentQueue(Date.now()).catch((err) => {
  console.warn("Weekly queue initial tick error:", err);
});

function socketRateLimited(socket, key, minMs) {
  if (!socket || !minMs || minMs <= 0) return false;
  const now = Date.now();
  const store = socket.data._rate || (socket.data._rate = {});
  const last = store[key] || 0;
  if (now - last < minMs) return true;
  store[key] = now;
  return false;
}

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
    avatarUrl: avatarForBroadcast(u),
    supporter: !!u.supporter,
  }));
}

function computeStreakLeaderboard() {
  const arr = Object.values(USERS || {})
    .filter((u) => u && u.username && !u.isBanned)
    .slice();
  arr.forEach((u) => ensureRankFields(u));
  arr.sort((a, b) => {
    const dStreak = (b.bestStreak || 0) - (a.bestStreak || 0);
    if (dStreak !== 0) return dStreak;
    const ds = (b.score || 0) - (a.score || 0);
    if (ds !== 0) return ds;
    return String(a.username).localeCompare(String(b.username));
  });
  return arr.slice(0, 10).map((u, idx) => ({
    place: idx + 1,
    username: u.username,
    score: u.score || 0,
    bestStreak: u.bestStreak || 0,
    rankTitle: u.rankTitle || "—",
    rankLevel: u.rankLevel || 1,
    rankColor: u.rankColor || "#9CA3AF",
    avatarUrl: avatarForBroadcast(u),
    supporter: !!u.supporter,
  }));
}

function computeDailyLeaderboard() {
  const today = todayKey();
  const arr = Object.values(USERS || {})
    .filter(
      (u) =>
        u &&
        u.username &&
        !u.isBanned &&
        u.winsTodayDate === today &&
        (u.winsToday || 0) > 0
    )
    .slice();
  arr.forEach((u) => ensureRankFields(u));
  arr.sort((a, b) => {
    const dw = (b.winsToday || 0) - (a.winsToday || 0);
    if (dw !== 0) return dw;
    const ds = (b.score || 0) - (a.score || 0);
    if (ds !== 0) return ds;
    return String(a.username).localeCompare(String(b.username));
  });
  return arr.slice(0, 10).map((u, idx) => ({
    place: idx + 1,
    username: u.username,
    winsToday: u.winsToday || 0,
    score: u.score || 0,
    rankTitle: u.rankTitle || "—",
    rankLevel: u.rankLevel || 1,
    rankColor: u.rankColor || "#9CA3AF",
    avatarUrl: avatarForBroadcast(u),
    supporter: !!u.supporter,
  }));
}

function computeRegionStats() {
  const base = REGION_NAMES.map((name) => ({
    region: name,
    players: 0,
    score: 0,
    xp: 0,
  }));
  const byRegion = new Map(base.map((r) => [r.region, r]));
  const attacks = new Map(REGION_NAMES.map((r) => [r, 0]));

  for (const u of Object.values(USERS || {})) {
    if (!u || !u.username || u.isBanned) continue;
    const region = normalizeRegion(u.region);
    if (region) {
      const row = byRegion.get(region);
      if (row) {
        row.players += 1;
        row.score +=
          Number(u.score || 0) + Math.max(0, Number(u.regionBoost || 0));
        row.xp += Number(u.xp || 0);
      }
    }
    if (u.regionAttacks && typeof u.regionAttacks === "object") {
      for (const [k, v] of Object.entries(u.regionAttacks)) {
        const rk = normalizeRegion(k);
        if (!rk) continue;
        const val = Math.max(0, Math.floor(Number(v) || 0));
        if (!val) continue;
        attacks.set(rk, (attacks.get(rk) || 0) + val);
      }
    }
  }

  const out = base.map((r) => {
    const attacked = attacks.get(r.region) || 0;
    const score = Math.max(0, r.score - attacked);
    return {
      region: r.region,
      players: r.players,
      score,
      xp: r.xp,
      avgScore: r.players ? Math.round((score / r.players) * 10) / 10 : 0,
    };
  });

  out.sort((a, b) => {
    const ds = (b.score || 0) - (a.score || 0);
    if (ds !== 0) return ds;
    const dp = (b.players || 0) - (a.players || 0);
    if (dp !== 0) return dp;
    return String(a.region).localeCompare(String(b.region));
  });

  return out;
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

// ======== Čata vēsture (Supabase, optional) ========
let chatStoreErrorLogged = false;
let chatHistoryErrorLogged = false;
let chatCleanupErrorLogged = false;

function buildChatStoreRow(payload) {
  const username = String(payload?.username || "").trim();
  const text = String(payload?.text || "").trim();
  if (!username || !text) return null;
  return {
    username,
    text,
    ts: Math.max(0, Number(payload?.ts) || Date.now()),
    rank_level: Number(payload?.rankLevel) || 0,
    rank_color: payload?.rankColor || null,
    rank_title: payload?.rankTitle || null,
    supporter: !!payload?.supporter,
    region: payload?.region || null,
  };
}

async function chatStoreMessage(payload) {
  if (!CHAT_STORE_ON_SUPABASE || !supabase) return;
  const row = buildChatStoreRow(payload);
  if (!row) return;
  try {
    const { error } = await supabase.from(CHAT_STORE_TABLE).insert(row);
    if (error && !chatStoreErrorLogged) {
      console.error("Supabase chat store error:", error);
      chatStoreErrorLogged = true;
    }
  } catch (err) {
    if (!chatStoreErrorLogged) {
      console.error("Supabase chat store error:", err);
      chatStoreErrorLogged = true;
    }
  }
}

async function loadChatHistory(limit = CHAT_HISTORY_LIMIT) {
  if (!CHAT_STORE_ON_SUPABASE || !supabase) return [];
  if (!Number.isFinite(limit) || limit <= 0) return [];
  try {
    const { data, error } = await supabase
      .from(CHAT_STORE_TABLE)
      .select(
        "id,username,text,ts,rank_level,rank_color,rank_title,supporter,region"
      )
      .order("ts", { ascending: false })
      .limit(limit);
    if (error) {
      if (!chatHistoryErrorLogged) {
        console.error("Supabase chat history error:", error);
        chatHistoryErrorLogged = true;
      }
      return [];
    }
    const list = Array.isArray(data)
      ? data
          .map((row) => ({
            id: row?.id ?? undefined,
            username: row?.username || "",
            text: row?.text || "",
            ts: Number(row?.ts) || 0,
            rankLevel: row?.rank_level || 0,
            rankColor: row?.rank_color || "#9CA3AF",
            rankTitle: row?.rank_title || "—",
            supporter: !!row?.supporter,
            region: row?.region || "",
          }))
          .filter((m) => m.username && m.text)
      : [];
    return list.reverse();
  } catch (err) {
    if (!chatHistoryErrorLogged) {
      console.error("Supabase chat history error:", err);
      chatHistoryErrorLogged = true;
    }
    return [];
  }
}

async function cleanupChatHistory() {
  if (!CHAT_STORE_ON_SUPABASE || !supabase || CHAT_RETENTION_DAYS <= 0) return;
  const cutoff = Date.now() - CHAT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  try {
    const { error } = await supabase
      .from(CHAT_STORE_TABLE)
      .delete()
      .lt("ts", cutoff);
    if (error && !chatCleanupErrorLogged) {
      console.error("Supabase chat cleanup error:", error);
      chatCleanupErrorLogged = true;
    }
  } catch (err) {
    if (!chatCleanupErrorLogged) {
      console.error("Supabase chat cleanup error:", err);
      chatCleanupErrorLogged = true;
    }
  }
}

// ======== DM helperi ========
function ensureDm(user) {
  if (!user || typeof user !== "object") return null;
  if (!user.dm || typeof user.dm !== "object") user.dm = {};
  if (!user.dm.threads || typeof user.dm.threads !== "object")
    user.dm.threads = {};
  if (!user.dm.unread || typeof user.dm.unread !== "object")
    user.dm.unread = {};
  if (!user.dm.lastRead || typeof user.dm.lastRead !== "object")
    user.dm.lastRead = {};

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
      newUnread[ck] =
        Math.max(0, Number(newUnread[ck]) || 0) + Math.max(0, Number(v) || 0);
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
    if (x && typeof x === "object" && typeof x.username === "string")
      return x.username.trim();
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

function dmBuildMeta(u) {
  if (!u) return null;
  const info = ensureRankFields(u);
  return {
    rankLevel: u.rankLevel || info.level || 1,
    rankTitle: u.rankTitle || info.title || "—",
    rankColor: u.rankColor || info.color || "#9CA3AF",
    region: u.region || "",
    avatarUrl: compactAvatarUrl(resolveAvatarUrl(u), DM_META_AVATAR_MAX_CHARS),
    supporter: !!u.supporter,
  };
}

function dmGetLastRead(dm, otherUsername) {
  if (!dm || typeof dm !== "object") return 0;
  const by = dm.lastRead && typeof dm.lastRead === "object" ? dm.lastRead : {};
  const target = String(otherUsername || "").trim();
  if (!target) return 0;
  const t = target.toLowerCase();
  for (const [k, v] of Object.entries(by)) {
    if (String(k || "").toLowerCase() === t) return Math.max(0, Number(v) || 0);
  }
  return 0;
}

function blockKey(name) {
  return String(name || "")
    .trim()
    .toLowerCase();
}

function ensureBlocks(user) {
  if (!user || typeof user !== "object") return null;
  if (
    !user.blocks ||
    typeof user.blocks !== "object" ||
    Array.isArray(user.blocks)
  ) {
    user.blocks = {};
  }
  return user.blocks;
}

function isBlocked(user, otherName) {
  const key = blockKey(otherName);
  if (!key) return false;
  const blocks = ensureBlocks(user);
  return !!(blocks && blocks[key]);
}

function addBlock(user, otherName, displayName) {
  const key = blockKey(otherName);
  if (!key) return false;
  const blocks = ensureBlocks(user);
  if (!blocks) return false;
  blocks[key] = displayName || String(otherName || "").trim();
  return true;
}

function removeBlock(user, otherName) {
  const key = blockKey(otherName);
  if (!key) return false;
  const blocks = ensureBlocks(user);
  if (!blocks) return false;
  delete blocks[key];
  return true;
}

function listBlocks(user) {
  const blocks = ensureBlocks(user);
  if (!blocks) return [];
  return Object.values(blocks).filter(Boolean);
}

function ensureFriends(user) {
  if (!user || typeof user !== "object") return null;
  if (!Array.isArray(user.friends)) user.friends = [];
  if (!user.friendInvitesIn || typeof user.friendInvitesIn !== "object")
    user.friendInvitesIn = {};
  if (!user.friendInvitesOut || typeof user.friendInvitesOut !== "object")
    user.friendInvitesOut = {};

  const cleanList = [];
  const seen = new Set();
  for (const raw of user.friends) {
    const name = String(raw || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleanList.push(name);
  }
  user.friends = cleanList;

  const cleanInvites = (inv) => {
    const out = {};
    for (const [k, v] of Object.entries(inv || {})) {
      let name = "";
      let ts = 0;
      if (v && typeof v === "object") {
        name = String(v.name || k || "").trim();
        ts = Math.max(0, Number(v.ts) || 0);
      } else {
        name = String(v || k || "").trim();
      }
      if (!name) continue;
      out[name.toLowerCase()] = { name, ts };
    }
    return out;
  };

  user.friendInvitesIn = cleanInvites(user.friendInvitesIn);
  user.friendInvitesOut = cleanInvites(user.friendInvitesOut);
  return user;
}

function areFriends(user, otherName) {
  ensureFriends(user);
  const key = String(otherName || "")
    .trim()
    .toLowerCase();
  if (!key) return false;
  return (user.friends || []).some(
    (n) => String(n || "").toLowerCase() === key
  );
}

function addFriend(user, otherName) {
  ensureFriends(user);
  const name = String(otherName || "").trim();
  if (!name) return false;
  const key = name.toLowerCase();
  if (user.friends.some((n) => String(n || "").toLowerCase() === key))
    return false;
  user.friends.push(name);
  return true;
}

function removeFriend(user, otherName) {
  ensureFriends(user);
  const key = String(otherName || "")
    .trim()
    .toLowerCase();
  if (!key) return false;
  const before = user.friends.length;
  user.friends = user.friends.filter(
    (n) => String(n || "").toLowerCase() !== key
  );
  return user.friends.length !== before;
}

function setInvite(map, otherName, ts = Date.now()) {
  const name = String(otherName || "").trim();
  if (!name) return false;
  map[name.toLowerCase()] = { name, ts: Math.max(0, Number(ts) || 0) };
  return true;
}

function removeInvite(map, otherName) {
  const key = String(otherName || "")
    .trim()
    .toLowerCase();
  if (!key) return false;
  delete map[key];
  return true;
}

function listInvites(map) {
  const arr = [];
  for (const v of Object.values(map || {})) {
    if (!v || !v.name) continue;
    arr.push({ name: v.name, ts: Math.max(0, Number(v.ts) || 0) });
  }
  arr.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return arr;
}

function getFriendsPayload(user) {
  ensureFriends(user);
  return {
    friends: (user.friends || [])
      .slice()
      .sort((a, b) => String(a).localeCompare(String(b))),
    incoming: listInvites(user.friendInvitesIn),
    outgoing: listInvites(user.friendInvitesOut),
  };
}

function emitFriendsUpdate(username) {
  const key = findUserKeyCaseInsensitive(username);
  const u = key ? USERS[key] : null;
  if (!u) return;
  const socket = getSocketByUsername(u.username);
  if (socket) socket.emit("friends.update", getFriendsPayload(u));
}

function dmComputeUnread(dm) {
  if (!DM_STORE_ON_SERVER) {
    return { total: 0, byUser: {}, threads: [], mode: "client" };
  }
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
        b.unread - a.unread ||
        b.lastTs - a.lastTs ||
        String(a.with).localeCompare(String(b.with))
    );
    threads = threads.slice(0, 60);
  } catch {}
  return { total, byUser, threads, mode: "server" };
}

function dmPushMessage(fromUser, toUser, text, extra = {}) {
  const from = fromUser?.username;
  const to = toUser?.username;
  if (!from || !to) return null;

  const dmFrom = ensureDm(fromUser);
  const dmTo = ensureDm(toUser);
  if (!dmFrom || !dmTo) return null;

  const base = {
    id: crypto.randomBytes(8).toString("hex"),
    from,
    to,
    text,
    ts: Date.now(),
  };
  if (extra.reply) base.reply = extra.reply;

  const meta = dmBuildMeta(fromUser);
  const msgFrom = { ...base, meta };
  const msgTo = { ...base, meta };

  const keyFrom = dmThreadKeyFor(fromUser, toUser);
  const keyTo = dmThreadKeyFor(toUser, fromUser);
  if (!keyFrom || !keyTo) return null;

  if (!Array.isArray(dmFrom.threads[keyFrom])) dmFrom.threads[keyFrom] = [];
  if (!Array.isArray(dmTo.threads[keyTo])) dmTo.threads[keyTo] = [];

  dmFrom.threads[keyFrom].push(msgFrom);
  dmTo.threads[keyTo].push(msgTo);

  if (dmFrom.threads[keyFrom].length > DM_THREAD_MAX) {
    dmFrom.threads[keyFrom] = dmFrom.threads[keyFrom].slice(-DM_THREAD_MAX);
  }
  if (dmTo.threads[keyTo].length > DM_THREAD_MAX) {
    dmTo.threads[keyTo] = dmTo.threads[keyTo].slice(-DM_THREAD_MAX);
  }

  // increment unread only saņēmējam
  dmTo.unread[keyTo] = Math.max(0, Number(dmTo.unread[keyTo]) || 0) + 1;

  return msgFrom;
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

  if (
    [
      "ban",
      "unban",
      "kick",
      "mute",
      "unmute",
      "title",
      "settitle",
      "region",
    ].includes(cmd) &&
    !targetName
  ) {
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

    case "title":
    case "settitle": {
      if (!target) {
        adminSocket.emit("chatMessage", {
          username: "SYSTEM",
          text: `Lietotājs '${targetName}' nav atrasts.`,
          ts: Date.now(),
        });
        return;
      }
      const titleRaw = parts.slice(2).join(" ");
      const nextTitle = normalizeTitle(titleRaw);
      target.title = nextTitle;
      saveUsers(USERS);
      broadcastOnlineList(true);
      adminSocket.emit("chatMessage", {
        username: "SYSTEM",
        text: nextTitle
          ? `OK: ${target.username} tituls = "${nextTitle}".`
          : `OK: ${target.username} titulam noņemts.`,
        ts: Date.now(),
      });
      break;
    }

    case "region": {
      if (!target) {
        adminSocket.emit("chatMessage", {
          username: "SYSTEM",
          text: `Lietotājs '${targetName}' nav atrasts.`,
          ts: Date.now(),
        });
        return;
      }
      const regionRaw = parts.slice(2).join(" ");
      const nextRegion = normalizeRegion(regionRaw);
      if (!nextRegion) {
        adminSocket.emit("chatMessage", {
          username: "SYSTEM",
          text: "Nederīgs novads. Pieejams: Zemgale, Latgale, Vidzeme, Kurzeme.",
          ts: Date.now(),
        });
        return;
      }
      target.region = nextRegion;
      saveUsers(USERS);
      adminSocket.emit("chatMessage", {
        username: "SYSTEM",
        text: `OK: ${target.username} novads = ${nextRegion}.`,
        ts: Date.now(),
      });
      break;
    }

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
        ? new Date(result.season.endAt).toLocaleString("lv-LV", {
            timeZone: TZ,
          })
        : "—";

      if (result.mode === "rolled_next") {
        if (result.hofEntry) {
          broadcastSystemMessage(
            `🏆 Sezona ${result.hofEntry.seasonId} čempions: ${result.hofEntry.username} (score ${result.hofEntry.score}). Ierakstīts Hall of Fame!`
          );
          io.emit("seasonHofUpdate", {
            top: seasonStore.hallOfFame[0] || null,
          });
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
        text: "Nezināma komanda. Pieejams: /kick, /ban, /unban, /mute <min>, /unmute, /title <user> <tituls>, /region <user> <novads>, /seasonstart, /seasononline, /hofset <sid> <username> [score].",
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
    (req &&
      req.headers &&
      (req.headers["x-vz-device-id"] || req.headers["x-device-id"])) ||
    "";
  const b =
    req && req.body && (req.body.deviceId || req.body.deviceID || req.body.did);
  const raw =
    typeof b === "string" && b.trim() ? b : typeof h === "string" ? h : "";
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
  const { username, password, region, email } = req.body || {};
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
  const existingUserKey = findUserKeyCaseInsensitive(name);
  if (existingUserKey) {
    return res.status(400).json({ message: "Šāds lietotājs jau eksistē" });
  }
  if (isAdminName(name) && !ALLOW_ADMIN_SIGNUP) {
    return res.status(403).json({
      message:
        "Šis nickname ir rezervēts. Izvēlies citu vai sazinies ar administratoru.",
    });
  }

  // Anti-alt: 24h limits uz ierīci (deviceId)
  const deviceId = getDeviceIdFromReq(req);
  if (deviceId) {
    const recent = countRecentSignupsForDeviceId(deviceId, Date.now());
    if (recent >= DEVICE_SIGNUP_MAX) {
      return res.status(429).json({
        message:
          "No šīs ierīces pēdējo 24h laikā jau izveidots konts. Pamēģini vēlāk.",
        code: "DEVICE_SIGNUP_LIMIT",
      });
    }
  }

  const canonRegion = normalizeRegion(region);
  if (!canonRegion) {
    return res.status(400).json({
      message: "Izvēlies novadu: Zemgale, Latgale, Vidzeme vai Kurzeme.",
    });
  }

  const cleanedEmail = normalizeEmail(email);
  if (email && !cleanedEmail) {
    return res.status(400).json({ message: "Nekorekts e-pasts." });
  }
  if (cleanedEmail) {
    const existingEmailKey = findUserKeyByEmail(cleanedEmail);
    if (existingEmailKey) {
      return res.status(400).json({ message: "Šis e-pasts jau izmantots." });
    }
  }

  const hash = await bcrypt.hash(password, 10);
  const now = Date.now();

  const user = {
    username: name,
    email: cleanedEmail || "",
    passwordHash: hash,
    createdAt: now,
    lastLoginAt: now,
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
    missionsBonusDate: "",
    totalGuesses: 0,
    bestWinTimeMs: 0,
    winsToday: 0,
    winsTodayDate: "",
    weeklyKey: "",
    weeklyWins: 0,
    weeklyXp: 0,
    weeklyScore: 0,
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
    avatarPath: "",
    avatarUpdatedAt: 0,
    title: "",
    region: canonRegion,
    regionPoints: 0,
    regionBoost: 0,
    regionAttacks: {},
    supporter: false,
    vipUntil: 0,
    vipTier: "none",
    vipLastTournamentAt: 0,
    vipLastPurchaseAt: 0,
    dailyChest: { lastDate: "", streak: 0, totalOpens: 0 },
    specialMedals: [],
    blocks: {},
    friends: [],
    friendInvitesIn: {},
    friendInvitesOut: {},
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
  return res.json({ ...(await buildMePayload(user)), token });
}

app.post("/signup", signupRateLimiter, signupHandler);

async function loginHandler(req, res) {
  const { username, password, email, identifier, login } = req.body || {};
  const rawId = String(username || email || identifier || login || "").trim();
  if (!rawId || !password) {
    return res
      .status(400)
      .json({ message: "Nepieciešams lietotājvārds vai e-pasts un parole" });
  }

  let user = null;
  if (rawId.includes("@")) {
    const cleanedEmail = normalizeEmail(rawId);
    if (!cleanedEmail) {
      return res.status(400).json({ message: "Nekorekts e-pasts." });
    }
    const key = findUserKeyByEmail(cleanedEmail);
    user = key ? USERS[key] : null;
  } else {
    const key = findUserKeyCaseInsensitive(rawId);
    user = key ? USERS[key] : null;
  }
  if (!user) return res.status(400).json({ message: "Lietotājs nav atrasts" });
  const name = user.username;

  if (user.isBanned) {
    return res.status(403).json({
      message:
        "Šis lietotājs ir nobanots no VĀRDU ZONAS. Sazināties: thezone@news.thezone.lv",
    });
  }

  const ok = await bcrypt.compare(password, user.passwordHash || "");
  if (!ok) return res.status(400).json({ message: "Nepareiza parole" });

  user.lastLoginAt = Date.now();

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
  return res.json({ ...(await buildMePayload(user)), token });
}

app.post("/login", loginRateLimiter, loginHandler);
app.post("/signin", loginRateLimiter, loginHandler);

// ======== Paroles atjaunošana ========
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 h
const passwordResetTokens = new Map(); // token -> { username, expiresAt }
const BASE_URL = String(
  process.env.BASE_URL || "https://bugats-wordle-server.onrender.com"
).replace(/\/$/, "");
const RESEND_API_KEY = String(process.env.RESEND_API_KEY || "").trim();
const RESEND_FROM = String(
  process.env.RESEND_FROM || "Vārdu Zona <noreply@thezone.lv>"
).trim();

function prunePasswordResetTokens() {
  const now = Date.now();
  for (const [tok, data] of passwordResetTokens.entries()) {
    if (data && data.expiresAt && data.expiresAt < now)
      passwordResetTokens.delete(tok);
  }
}

async function sendPasswordResetEmail(toEmail, resetLink) {
  if (!RESEND_API_KEY) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [toEmail],
      subject: "VĀRDU ZONA – paroles atjaunošana",
      html: `
        <p>Sveiki!</p>
        <p>Tu pieprasīji paroles atjaunošanu VĀRDU ZONA kontam.</p>
        <p>Nospied linku zemāk, lai izvēlētos jaunu paroli (links der 1 stundu):</p>
        <p><a href="${resetLink}">${resetLink}</a></p>
        <p>Ja tu nepieprasīji atjaunošanu, ignorē šo e-pastu.</p>
        <p>— VĀRDU ZONA</p>
      `.trim(),
    }),
  });
  return res.ok;
}

app.post(
  "/password-reset-request",
  passwordResetRateLimiter,
  async (req, res) => {
    const rawEmail = String(req.body?.email ?? "").trim();
    const rawUsername = String(req.body?.username ?? "").trim();
    const cleanedEmail = normalizeEmail(rawEmail);
    if (!RESEND_API_KEY) {
      return res.status(503).json({
        message:
          "Paroles atjaunošana pagaidām nav pieejama. Sazinies: thezone@news.thezone.lv",
      });
    }
    if (!cleanedEmail && !rawUsername) {
      return res
        .status(400)
        .json({ message: "Ievadi e-pastu vai lietotājvārdu." });
    }
    prunePasswordResetTokens();
    let key = null;
    let toEmail = null;
    if (cleanedEmail) {
      key = findUserKeyByEmail(cleanedEmail);
      if (key && USERS[key] && USERS[key].email) toEmail = USERS[key].email;
    }
    if (!key && rawUsername) {
      key = findUserKeyCaseInsensitive(rawUsername);
      if (key && USERS[key] && USERS[key].email) toEmail = USERS[key].email;
      if (key && USERS[key] && !USERS[key].email) {
        return res.json({
          ok: true,
          noEmailOnAccount: true,
          message:
            "Šim kontam nav reģistrēts e-pasts. Pievieno e-pastu profilā (ja atceries paroli) vai raksti uz thezone@news.thezone.lv ar lietotājvārdu.",
        });
      }
    }
    if (!key || !toEmail) {
      return res.json({
        ok: true,
        message:
          "Ja konts ar šādu e-pastu vai lietotājvārdu eksistē un ir e-pasts, saņemsi e-pastu ar norādījumiem.",
      });
    }
    const username = USERS[key].username;
    const token = crypto.randomBytes(32).toString("hex");
    passwordResetTokens.set(token, {
      username,
      expiresAt: Date.now() + PASSWORD_RESET_TTL_MS,
    });
    const resetLink = `${BASE_URL}/reset-password.html?token=${encodeURIComponent(token)}`;
    const sent = await sendPasswordResetEmail(toEmail, resetLink);
    if (!sent) {
      passwordResetTokens.delete(token);
      return res
        .status(500)
        .json({ message: "Neizdevās nosūtīt e-pastu. Mēģini vēlreiz vēlāk." });
    }
    return res.json({
      ok: true,
      message:
        "Ja konts ar šādu e-pastu vai lietotājvārdu eksistē un ir e-pasts, saņemsi e-pastu ar norādījumiem.",
    });
  }
);

app.post("/password-reset", async (req, res) => {
  const { token, newPassword } = req.body || {};
  const rawToken = String(token ?? "").trim();
  const rawPassword = String(newPassword ?? "").trim();
  if (!rawToken)
    return res.status(400).json({ message: "Trūkst atjaunošanas koda." });
  if (!rawPassword || rawPassword.length < 6) {
    return res
      .status(400)
      .json({ message: "Jaunajai parolei jābūt vismaz 6 simbolus garai." });
  }
  prunePasswordResetTokens();
  const data = passwordResetTokens.get(rawToken);
  if (
    !data ||
    !data.username ||
    (data.expiresAt && data.expiresAt < Date.now())
  ) {
    return res.status(400).json({
      message: "Kods ir nederīgs vai beidzies. Pieprasi atjaunošanu vēlreiz.",
    });
  }
  const key = findUserKeyCaseInsensitive(data.username);
  if (!key || !USERS[key]) {
    passwordResetTokens.delete(rawToken);
    return res.status(400).json({ message: "Lietotājs nav atrasts." });
  }
  const hash = await bcrypt.hash(rawPassword, 10);
  USERS[key].passwordHash = hash;
  saveUsers(USERS);
  passwordResetTokens.delete(rawToken);
  return res.json({
    ok: true,
    message: "Parole nomainīta. Vari ienākt ar jauno paroli.",
  });
});

// ======== Admin: iestatīt lietotāja paroli (esošajiem bez e-pasta) ========
app.post(
  "/admin/user/:username/set-password",
  authMiddleware,
  async (req, res) => {
    if (!req.user || !isAdminUser(req.user)) {
      return res.status(403).json({ message: "Tikai administrators." });
    }
    const targetUsername = String(req.params.username || "").trim();
    const newPassword = String(req.body?.newPassword ?? "").trim();
    if (!targetUsername)
      return res.status(400).json({ message: "Norādi lietotājvārdu." });
    if (!newPassword || newPassword.length < 6) {
      return res
        .status(400)
        .json({ message: "Jaunajai parolei jābūt vismaz 6 simbolus garai." });
    }
    const key = findUserKeyCaseInsensitive(targetUsername);
    if (!key || !USERS[key]) {
      return res.status(404).json({ message: "Lietotājs nav atrasts." });
    }
    USERS[key].passwordHash = await bcrypt.hash(newPassword, 10);
    saveUsers(USERS);
    return res.json({
      ok: true,
      message: `Parole lietotājam ${USERS[key].username} nomainīta.`,
    });
  }
);

// ======== /me ========
app.get("/me", authMiddleware, async (req, res) => {
  const u = req.user;
  markActivity(u);
  ensureDailyMissions(u);
  resetWinsTodayIfNeeded(u);
  resetDailyCountersIfNeeded(u);
  ensureDailyChest(u);
  ensureSpecialMedals(u);
  ensureRankFields(u);
  if (typeof u.supporter !== "boolean") u.supporter = false;
  ensureVipFields(u);
  saveUsers(USERS);
  res.json(await buildMePayload(u));
});

app.get("/vip/status", authMiddleware, (req, res) => {
  const user = req.user;
  ensureVipFields(user);
  res.json({
    active: isVipActive(user),
    until: Number(user.vipUntil || 0),
    tier: user.vipTier || "none",
    canCreateTournament: canCreateTournament(user),
    purchaseEnabled: false,
    message:
      "VIP par žetoniem nav pieejams. Žetoni paredzēti laimes rata slotiem.",
  });
});

app.post("/vip/buy", authMiddleware, async (req, res) => {
  return res.status(403).json({
    message:
      "VIP pirkšana ar žetoniem ir izslēgta. Žetoni paredzēti tikai laimes ratam.",
  });
});

app.post("/admin/vip/grant", authMiddleware, async (req, res) => {
  const admin = req.user;
  if (!isAdminUser(admin)) {
    return res.status(403).json({ message: "Tikai admins." });
  }

  const targetName = String(req.body?.username || "").trim();
  if (!targetName) {
    return res.status(400).json({ message: "Norādi username." });
  }

  const key = findUserKeyCaseInsensitive(targetName);
  const target = key ? USERS[key] : null;
  if (!target) {
    return res.status(404).json({ message: "Lietotājs nav atrasts." });
  }

  ensureVipFields(target);
  const daysRaw = parseInt(req.body?.days ?? VIP_DURATION_DAYS, 10);
  const days =
    Number.isFinite(daysRaw) && daysRaw >= 1 && daysRaw <= 365
      ? daysRaw
      : VIP_DURATION_DAYS;
  const now = Date.now();
  const startAt = Math.max(now, Number(target.vipUntil || 0));
  target.vipUntil = startAt + days * DAY_MS;
  target.vipTier = "vip_basic";
  target.vipLastPurchaseAt = now;

  saveUsers(USERS);

  io.emit("vip:updated", {
    username: target.username,
    active: isVipActive(target),
    until: Number(target.vipUntil || 0),
  });

  return res.json({
    ok: true,
    username: target.username,
    vip: {
      active: isVipActive(target),
      until: Number(target.vipUntil || 0),
      tier: target.vipTier || "vip_basic",
      canCreateTournament: canCreateTournament(target),
    },
  });
});

// ======== E-pasta piesaiste (tikai savam profilam) ========
// Atļauj arī tukšu – lietotājs noņem e-pastu (vairs nesaņems jaunumus)
app.post("/email", authMiddleware, (req, res) => {
  const user = req.user;
  const rawEmail = (req.body?.email ?? "").trim();
  if (rawEmail === "") {
    user.email = "";
    saveUsers(USERS);
    return res.json({ ok: true, email: "" });
  }
  const cleanedEmail = normalizeEmail(rawEmail);
  if (!cleanedEmail) {
    return res.status(400).json({ message: "Nekorekts e-pasts." });
  }
  const existingKey = findUserKeyByEmail(cleanedEmail);
  if (
    existingKey &&
    USERS[existingKey] &&
    USERS[existingKey].username !== user.username
  ) {
    return res.status(400).json({ message: "Šis e-pasts jau izmantots." });
  }
  user.email = cleanedEmail;
  saveUsers(USERS);
  return res.json({ ok: true, email: user.email });
});

// ======== AVATĀRA ENDPOINTS ========
app.post("/avatar", authMiddleware, async (req, res) => {
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

    if (SUPABASE_ENABLED) {
      const okBucket = await ensureSupabaseBucket();
      if (!okBucket) {
        return res.status(503).json({
          message: "Supabase storage nav pieejams. Pārbaudi konfigurāciju.",
        });
      }
      const parsed = parseAvatarDataUrl(avatar);
      if (!parsed) {
        return res.status(400).json({ message: "Nekorekts avatāra formāts." });
      }
      const ext = mimeToExt(parsed.mime) || "png";
      const safeUser = sanitizeStorageKeySegment(user.username || "user");
      const filePath = `${safeUser}/${Date.now()}.${ext}`;
      const prevPath = user.avatarPath || "";

      const { error: uploadError } = await supabase.storage
        .from(SUPABASE_STORAGE_BUCKET)
        .upload(filePath, parsed.buffer, {
          contentType: parsed.mime,
          cacheControl: SUPABASE_AVATAR_CACHE_CONTROL,
          upsert: true,
        });
      if (uploadError) {
        console.error("Supabase avatar upload error:", uploadError);
        return res
          .status(500)
          .json({ message: "Neizdevās augšupielādēt avatāru." });
      }
      if (prevPath && prevPath !== filePath) {
        supabase.storage
          .from(SUPABASE_STORAGE_BUCKET)
          .remove([prevPath])
          .catch(() => {});
      }
      user.avatarPath = filePath;
      user.avatarUpdatedAt = Date.now();
      user.avatarUrl = SUPABASE_STORAGE_PUBLIC
        ? getSupabasePublicUrl(filePath)
        : null;
    } else {
      user.avatarUrl = avatar;
      user.avatarPath = "";
      user.avatarUpdatedAt = Date.now();
    }

    saveUsers(USERS);
    broadcastOnlineList(true);
    broadcastLeaderboard(false);

    const { url: avatarUrl, expiresAt: avatarUrlExpiresAt } =
      await resolveAvatarUrlAsync(user);
    return res.json({
      ok: true,
      avatarUrl: avatarUrl || null,
      avatarUrlExpiresAt: avatarUrlExpiresAt || null,
    });
  } catch (err) {
    console.error("POST /avatar kļūda:", err);
    return res
      .status(500)
      .json({ message: "Servera kļūda avatāra saglabāšanā." });
  }
});

// ======== Publiska profila API ========
async function buildPublicProfilePayload(targetUser, requester) {
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
    nextMinXp && Number.isFinite(nextMinXp) && nextMinXp > minXp
      ? nextMinXp - minXp
      : 0;
  const inLevel = Math.max(0, xp - minXp);
  const pct =
    need > 0 ? Math.max(0, Math.min(100, (inLevel / need) * 100)) : 100;
  const toNext = need > 0 ? Math.max(0, nextMinXp - xp) : 0;

  const { url: avatarUrl, expiresAt: avatarUrlExpiresAt } =
    await resolveAvatarUrlAsync(targetUser);

  const payload = {
    username: targetUser.username,
    title: targetUser.title || "",
    region: targetUser.region || "",
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
    avatarUrl: avatarUrl || null,
    avatarUrlExpiresAt: avatarUrlExpiresAt || null,
    supporter: !!targetUser.supporter,
  };

  if (requester && requester.username === targetUser.username) {
    payload.email = targetUser.email || "";
  }

  if (isAdmin) {
    payload.isBanned = !!targetUser.isBanned;
    payload.mutedUntil = targetUser.mutedUntil || 0;
  }
  return payload;
}

app.get("/player/:username", authMiddleware, async (req, res) => {
  const requester = req.user;
  const name = String(req.params.username || "").trim();
  const key = findUserKeyCaseInsensitive(name);
  const user = key ? USERS[key] : null;
  if (!user) return res.status(404).json({ message: "Lietotājs nav atrasts" });
  res.json(await buildPublicProfilePayload(user, requester));
});
app.get("/profile/:username", authMiddleware, async (req, res) => {
  const requester = req.user;
  const name = String(req.params.username || "").trim();
  const key = findUserKeyCaseInsensitive(name);
  const user = key ? USERS[key] : null;
  if (!user) return res.status(404).json({ message: "Lietotājs nav atrasts" });
  res.json(await buildPublicProfilePayload(user, requester));
});

// ======== DRAUGI ========
app.get("/friends", authMiddleware, (req, res) => {
  const user = req.user;
  markActivity(user);
  ensureFriends(user);
  saveUsers(USERS);
  res.json(getFriendsPayload(user));
});

app.post("/friends/request", authMiddleware, (req, res) => {
  const user = req.user;
  const toRaw = req.body?.to || req.body?.username || req.body?.user || "";
  const toName = String(toRaw || "").trim();
  if (!toName)
    return res.status(400).json({ message: "Nav nor��dīts lietotājs." });
  if (toName === user.username)
    return res.status(400).json({ message: "Nevari pievienot sevi." });

  const key = findUserKeyCaseInsensitive(toName);
  const target = key ? USERS[key] : null;
  if (!target)
    return res.status(404).json({ message: "Lietotājs nav atrasts." });

  ensureFriends(user);
  ensureFriends(target);
  if (areFriends(user, target.username)) {
    return res.status(400).json({ message: "Jūs jau esat draugi." });
  }
  if (isBlocked(user, target.username) || isBlocked(target, user.username)) {
    return res.status(400).json({ message: "Drauga ielūgums nav pieejams." });
  }

  const keyLower = target.username.toLowerCase();
  // ja viņš jau uzaicinājis tevi -> auto accept
  if (user.friendInvitesIn[keyLower]) {
    removeInvite(user.friendInvitesIn, target.username);
    removeInvite(target.friendInvitesOut, user.username);
    addFriend(user, target.username);
    addFriend(target, user.username);
    saveUsers(USERS);
    emitFriendsUpdate(user.username);
    emitFriendsUpdate(target.username);
    return res.json({ ok: true, friends: getFriendsPayload(user) });
  }

  setInvite(target.friendInvitesIn, user.username);
  setInvite(user.friendInvitesOut, target.username);
  saveUsers(USERS);
  emitFriendsUpdate(user.username);
  emitFriendsUpdate(target.username);
  return res.json({ ok: true, friends: getFriendsPayload(user) });
});

app.post("/friends/accept", authMiddleware, (req, res) => {
  const user = req.user;
  const fromRaw = req.body?.from || req.body?.username || req.body?.user || "";
  const fromName = String(fromRaw || "").trim();
  if (!fromName)
    return res.status(400).json({ message: "Nav norādīts lietotājs." });

  const key = findUserKeyCaseInsensitive(fromName);
  const other = key ? USERS[key] : null;
  if (!other)
    return res.status(404).json({ message: "Lietotājs nav atrasts." });

  ensureFriends(user);
  ensureFriends(other);
  if (!user.friendInvitesIn[other.username.toLowerCase()]) {
    return res.status(400).json({ message: "Nav ielūguma no šī lietotāja." });
  }

  removeInvite(user.friendInvitesIn, other.username);
  removeInvite(other.friendInvitesOut, user.username);
  addFriend(user, other.username);
  addFriend(other, user.username);
  saveUsers(USERS);
  emitFriendsUpdate(user.username);
  emitFriendsUpdate(other.username);
  res.json({ ok: true, friends: getFriendsPayload(user) });
});

app.post("/friends/decline", authMiddleware, (req, res) => {
  const user = req.user;
  const fromRaw = req.body?.from || req.body?.username || req.body?.user || "";
  const fromName = String(fromRaw || "").trim();
  if (!fromName)
    return res.status(400).json({ message: "Nav norādīts lietotājs." });

  const key = findUserKeyCaseInsensitive(fromName);
  const other = key ? USERS[key] : null;
  if (!other)
    return res.status(404).json({ message: "Lietotājs nav atrasts." });

  ensureFriends(user);
  ensureFriends(other);
  removeInvite(user.friendInvitesIn, other.username);
  removeInvite(other.friendInvitesOut, user.username);
  saveUsers(USERS);
  emitFriendsUpdate(user.username);
  emitFriendsUpdate(other.username);
  res.json({ ok: true, friends: getFriendsPayload(user) });
});

app.post("/friends/cancel", authMiddleware, (req, res) => {
  const user = req.user;
  const toRaw = req.body?.to || req.body?.username || req.body?.user || "";
  const toName = String(toRaw || "").trim();
  if (!toName)
    return res.status(400).json({ message: "Nav norādīts lietotājs." });

  const key = findUserKeyCaseInsensitive(toName);
  const other = key ? USERS[key] : null;
  if (!other)
    return res.status(404).json({ message: "Lietotājs nav atrasts." });

  ensureFriends(user);
  ensureFriends(other);
  removeInvite(user.friendInvitesOut, other.username);
  removeInvite(other.friendInvitesIn, user.username);
  saveUsers(USERS);
  emitFriendsUpdate(user.username);
  emitFriendsUpdate(other.username);
  res.json({ ok: true, friends: getFriendsPayload(user) });
});

app.post("/friends/remove", authMiddleware, (req, res) => {
  const user = req.user;
  const otherRaw = req.body?.user || req.body?.username || req.body?.to || "";
  const otherName = String(otherRaw || "").trim();
  if (!otherName)
    return res.status(400).json({ message: "Nav norādīts lietotājs." });

  const key = findUserKeyCaseInsensitive(otherName);
  const other = key ? USERS[key] : null;
  if (!other)
    return res.status(404).json({ message: "Lietotājs nav atrasts." });

  ensureFriends(user);
  ensureFriends(other);
  removeFriend(user, other.username);
  removeFriend(other, user.username);
  saveUsers(USERS);
  emitFriendsUpdate(user.username);
  emitFriendsUpdate(other.username);
  res.json({ ok: true, friends: getFriendsPayload(user) });
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
  res.json({
    missions: getPublicMissions(user),
    bonus: getMissionBonusStatus(user),
  });
});

app.post("/missions/claim", authMiddleware, async (req, res) => {
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

  res.json({
    me: await buildMePayload(user),
    missions: getPublicMissions(user),
    bonus: getMissionBonusStatus(user),
  });
});

app.post("/missions/bonus", authMiddleware, async (req, res) => {
  const user = req.user;
  markActivity(user);
  ensureDailyMissions(user);
  resetDailyCountersIfNeeded(user);
  ensureDailyChest(user);
  ensureSpecialMedals(user);

  const bonus = getMissionBonusStatus(user);
  if (!bonus.isCompleted) {
    return res
      .status(400)
      .json({ message: "Visas misijas vēl nav pabeigtas." });
  }
  if (bonus.isClaimed) {
    return res.status(400).json({ message: "Dienas bonus balva jau saņemta." });
  }

  const rw = bonus.rewards || {};
  const addXp = rw.xp || 0;
  const addCoins = rw.coins || 0;
  const addTokens = rw.tokens || 0;

  user.xp = (user.xp || 0) + addXp;
  user.coins = (user.coins || 0) + addCoins;
  user.tokens = (user.tokens || 0) + addTokens;
  user.missionsBonusDate = todayKey();
  ensureRankFields(user);

  saveUsers(USERS);
  broadcastLeaderboard(false);

  if (addTokens > 0) {
    wheelSyncTokenSlots(true);
    wheelEmitUpdate(true);
  }

  res.json({
    me: await buildMePayload(user),
    missions: getPublicMissions(user),
    bonus: getMissionBonusStatus(user),
  });
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

app.post("/chest/open", authMiddleware, async (req, res) => {
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
    me: await buildMePayload(user),
  });
});

// ======== SEZONA API ========
app.get("/season", authMiddleware, (_req, res) => {
  res.json({
    ...seasonState,
    hallOfFameTop: seasonStore.hallOfFame[0] || null,
  });
});
app.get("/season/state", (_req, res) => {
  res.json({
    ...seasonState,
    hallOfFameTop: seasonStore.hallOfFame[0] || null,
  });
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
    return res
      .status(403)
      .json({ message: "Tikai admins var startēt sezonu." });
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

// ======== TURNĪRI (brackets-manager) ========
app.get("/tournaments", authMiddleware, async (req, res) => {
  try {
    await processWeeklyTournamentQueue(Date.now());
  } catch (err) {
    console.warn("Weekly queue tick on /tournaments failed:", err);
  }
  const list = [...(tournamentStore.tournaments || [])].sort(
    (a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)
  );
  res.json({
    tournaments: list,
    schedule: buildWeeklyQueuePayload(req.user),
  });
});

app.post("/tournaments", authMiddleware, async (req, res) => {
  try {
    const requester = req.user;
    ensureVipFields(requester);

    const name = normalizeTournamentName(req.body?.name);
    if (!name) {
      return res.status(400).json({ message: "Norādi turnīra nosaukumu." });
    }

    const type = normalizeTournamentType(req.body?.type);
    const seeding = sanitizeTournamentSeeding(req.body?.seeding);
    if (seeding.length < 2) {
      return res
        .status(400)
        .json({ message: "Turnīram vajag vismaz 2 dalībniekus." });
    }

    const access = validateTournamentCreateAccess(requester, seeding.length);
    if (!access.ok) {
      return res
        .status(Number(access.status) || 403)
        .json({ message: access.message || "Nav tiesību veidot turnīru." });
    }

    const tournamentId = Number(tournamentStore.nextTournamentId || 1);
    tournamentStore.nextTournamentId = tournamentId + 1;

    const stage = await tournamentManager.create.stage({
      tournamentId,
      name,
      type,
      seeding,
      settings: buildTournamentStageSettings(type, req.body?.settings),
    });

    const meta = {
      id: tournamentId,
      name,
      type,
      stageId: stage?.id ?? null,
      createdAt: Date.now(),
      createdBy: requester.username,
      participantCount: seeding.length,
      status: "active",
      completedAt: 0,
    };

    tournamentStore.tournaments.push(meta);
    saveTournamentStore();
    if (!isAdminUser(requester)) {
      requester.vipLastTournamentAt = Date.now();
      saveUsers(USERS);
    }

    io.emit("tournament:update", {
      tournamentId,
      event: "created",
    });

    return res.json({ ok: true, tournament: meta, stage });
  } catch (err) {
    console.error("Tournament create error:", err);
    return res.status(400).json({
      message: "Neizdevās izveidot turnīru.",
      detail: String(err?.message || err || ""),
    });
  }
});

app.post("/tournaments/weekly/join", authMiddleware, async (req, res) => {
  if (!WEEKLY_TOURNAMENT_ENABLED) {
    return res.status(404).json({ message: "Nedēļas turnīrs nav ieslēgts." });
  }
  try {
    await processWeeklyTournamentQueue(Date.now());
  } catch (err) {
    console.warn("Weekly queue pre-join tick failed:", err);
  }

  const q = ensureWeeklyQueueState(Date.now());
  const now = Date.now();
  const username = String(req.user?.username || "").trim();
  if (!username) return res.status(401).json({ message: "Nav lietotāja." });

  const slots = Math.max(
    2,
    Math.floor(Number(q.slots) || WEEKLY_TOURNAMENT_SLOTS)
  );
  const participants = Array.isArray(q.participants) ? q.participants : [];
  const alreadyJoined = participants.some(
    (u) =>
      String(u || "")
        .trim()
        .toLowerCase() === username.toLowerCase()
  );
  if (alreadyJoined) {
    return res.json({
      ok: true,
      joined: true,
      message: "Tu jau esi pieteicies nedēļas turnīram.",
      schedule: buildWeeklyQueuePayload(req.user),
    });
  }

  if (now >= Number(q.startAt || 0)) {
    return res.status(409).json({
      message:
        "Pieteikšanās logs šim turnīram ir beidzies. Piesakies nākamajai nedēļai.",
      schedule: buildWeeklyQueuePayload(req.user),
    });
  }

  if (participants.length >= slots) {
    return res.status(409).json({
      message: "Visi turnīra sloti jau aizņemti.",
      schedule: buildWeeklyQueuePayload(req.user),
    });
  }

  const eligibility = evaluateWeeklyJoinEligibility(req.user, participants);
  if (!eligibility.ok) {
    return res.status(403).json({
      message:
        eligibility.message ||
        "Profils neatbilst nedēļas turnīra drošības prasībām.",
      schedule: buildWeeklyQueuePayload(req.user),
    });
  }

  q.participants.push(username);
  saveTournamentStore();
  io.emit("tournament:update", { event: "weekly_join", username });

  const joinedCount = q.participants.length;
  if (joinedCount >= slots) {
    broadcastSystemMessage(
      `✅ Nedēļas turnīra sloti ir pilni (${joinedCount}/${slots}). Starts piektdien plkst. ${String(
        WEEKLY_TOURNAMENT_HOUR
      ).padStart(
        2,
        "0"
      )}:${String(WEEKLY_TOURNAMENT_MINUTE).padStart(2, "0")} (${TZ}).`
    );
  }

  return res.json({
    ok: true,
    joined: true,
    message:
      joinedCount >= slots
        ? "Pieteikts! Visi sloti aizņemti — turnīrs startēs grafikā."
        : "Pieteikts nedēļas turnīram. Ja trūkst sloti, aicini draugu.",
    schedule: buildWeeklyQueuePayload(req.user),
  });
});

app.get("/tournaments/:id", authMiddleware, async (req, res) => {
  try {
    const tournamentId = parseTournamentId(req.params.id);
    if (!tournamentId) {
      return res.status(400).json({ message: "Nederīgs turnīra ID." });
    }
    const meta = getTournamentMetaById(tournamentId);
    if (!meta) return res.status(404).json({ message: "Turnīrs nav atrasts." });

    const snapshot = await getTournamentSnapshot(tournamentId);

    if (!snapshot.currentStage && meta.status !== "completed") {
      meta.status = "completed";
      if (!meta.completedAt) meta.completedAt = Date.now();
      saveTournamentStore();
    }

    let finalStandings = [];
    try {
      if (meta.stageId != null && !snapshot.currentStage) {
        finalStandings = await tournamentManager.get.finalStandings(
          meta.stageId
        );
      }
    } catch {
      finalStandings = [];
    }

    return res.json({
      tournament: meta,
      ...snapshot,
      finalStandings,
    });
  } catch (err) {
    console.error("Tournament load error:", err);
    return res.status(500).json({ message: "Neizdevās ielādēt turnīru." });
  }
});

app.post(
  "/tournaments/:id/matches/:matchId/report",
  authMiddleware,
  async (req, res) => {
    try {
      const tournamentId = parseTournamentId(req.params.id);
      const matchId = parseNonNegativeIntId(req.params.matchId);
      if (!tournamentId || matchId == null) {
        return res
          .status(400)
          .json({ message: "Nederīgs turnīra vai mača ID." });
      }

      const meta = getTournamentMetaById(tournamentId);
      if (!meta)
        return res.status(404).json({ message: "Turnīrs nav atrasts." });

      const match = await tournamentDb.select("match", matchId);
      if (!match) return res.status(404).json({ message: "Mačs nav atrasts." });

      const stage = await tournamentDb.select("stage", match.stage_id);
      if (!stage || Number(stage.tournament_id) !== Number(tournamentId)) {
        return res
          .status(404)
          .json({ message: "Mačs neietilpst norādītajā turnīrā." });
      }

      const participantMap =
        await getTournamentParticipantNameMap(tournamentId);
      const p1Name =
        match?.opponent1?.id != null
          ? participantMap.get(Number(match.opponent1.id)) || ""
          : "";
      const p2Name =
        match?.opponent2?.id != null
          ? participantMap.get(Number(match.opponent2.id)) || ""
          : "";

      const requester = String(req.user?.username || "")
        .trim()
        .toLowerCase();
      const canReportAsPlayer =
        (p1Name && p1Name.toLowerCase() === requester) ||
        (p2Name && p2Name.toLowerCase() === requester);
      if (!isAdminUser(req.user) && !canReportAsPlayer) {
        return res.status(403).json({
          message:
            "Šī mača rezultātu drīkst iesniegt tikai dalībnieks vai admins.",
        });
      }

      const forfeitRaw = String(req.body?.forfeit || "")
        .trim()
        .toLowerCase();
      if (
        forfeitRaw === "opponent1" ||
        forfeitRaw === "1" ||
        forfeitRaw === "opponent2" ||
        forfeitRaw === "2"
      ) {
        const op1Forfeit = forfeitRaw === "opponent1" || forfeitRaw === "1";
        await tournamentManager.update.match({
          id: matchId,
          opponent1: op1Forfeit
            ? { forfeit: true, result: "loss" }
            : { result: "win" },
          opponent2: op1Forfeit
            ? { result: "win" }
            : { forfeit: true, result: "loss" },
        });
      } else {
        const score1 = Number(req.body?.score1);
        const score2 = Number(req.body?.score2);
        if (
          !Number.isFinite(score1) ||
          !Number.isFinite(score2) ||
          score1 < 0 ||
          score2 < 0
        ) {
          return res.status(400).json({
            message: "Norādi korektus score1 un score2 (>= 0).",
          });
        }
        if (score1 === score2) {
          return res.status(400).json({
            message: "Neizšķirts nav atbalstīts šim mačam.",
          });
        }
        await tournamentManager.update.match({
          id: matchId,
          opponent1: {
            score: Math.floor(score1),
            result: score1 > score2 ? "win" : "loss",
          },
          opponent2: {
            score: Math.floor(score2),
            result: score2 > score1 ? "win" : "loss",
          },
        });
      }

      const updated = await tournamentDb.select("match", matchId);
      if (!updated) {
        return res
          .status(500)
          .json({ message: "Neizdevās nolasīt atjaunināto maču." });
      }

      const snapshot = await getTournamentSnapshot(tournamentId);
      if (!snapshot.currentStage && meta.status !== "completed") {
        meta.status = "completed";
        if (!meta.completedAt) meta.completedAt = Date.now();
        saveTournamentStore();
      }

      io.emit("tournament:update", {
        tournamentId,
        event: "match_reported",
        matchId,
      });

      return res.json({
        ok: true,
        tournament: meta,
        match: updated,
      });
    } catch (err) {
      console.error("Tournament match report error:", err);
      return res.status(400).json({
        message: "Neizdevās iesniegt mača rezultātu.",
        detail: String(err?.message || err || ""),
      });
    }
  }
);

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
    if (
      !user.currentRound.reveal ||
      typeof user.currentRound.reveal !== "object"
    )
      user.currentRound.reveal = null;
    if (!Array.isArray(user.currentRound.knownCorrect)) {
      const len = Math.max(0, Math.floor(user.currentRound.len || 0));
      user.currentRound.knownCorrect =
        len > 0 ? new Array(len).fill(false) : [];
    }
    if (!Array.isArray(user.currentRound.history))
      user.currentRound.history = [];

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

// ======== Izaicinājums draugam ========
app.post("/challenge/create", authMiddleware, (req, res) => {
  pruneExpiredChallenges();
  const user = req.user;
  const { word, len } = pickRandomWord();
  const id = genChallengeId();
  const baseUrl = (
    req.get("origin") ||
    req.protocol + "://" + req.get("host") ||
    ""
  ).replace(/\/$/, "");
  challenges.set(id, {
    id,
    word,
    len,
    player1: user.username,
    player2: null,
    attempts1: null,
    attempts2: null,
    completed1: false,
    completed2: false,
    history1: [],
    history2: [],
    createdAt: Date.now(),
  });
  return res.json({
    challengeId: id,
    shareUrl: `${baseUrl}/game.html?challenge=${id}`,
    player1: user.username,
    len,
  });
});

app.get("/challenge/:id", authMiddleware, (req, res) => {
  pruneExpiredChallenges();
  const c = challenges.get(String(req.params.id || "").trim());
  if (!c)
    return res
      .status(404)
      .json({ message: "Izaicinājums nav atrasts vai ir beidzies." });
  const me = req.user.username;
  const isPlayer1 = c.player1 === me;
  const isPlayer2 = c.player2 === me;
  const status = !c.player2
    ? "waiting"
    : c.completed1 && c.completed2
      ? "finished"
      : "active";
  const payload = {
    challengeId: c.id,
    player1: c.player1,
    player2: c.player2 || null,
    len: c.len,
    status,
    myAttempts: isPlayer1 ? c.attempts1 : isPlayer2 ? c.attempts2 : null,
    opponentAttempts: isPlayer1 ? c.attempts2 : isPlayer2 ? c.attempts1 : null,
  };
  if (status === "finished") {
    payload.winner =
      c.attempts1 != null && c.attempts2 != null
        ? c.attempts1 < c.attempts2
          ? c.player1
          : c.attempts2 < c.attempts1
            ? c.player2
            : null
        : null;
    payload.attempts1 = c.attempts1;
    payload.attempts2 = c.attempts2;
  }
  return res.json(payload);
});

app.post("/challenge/:id/join", authMiddleware, (req, res) => {
  pruneExpiredChallenges();
  const id = String(req.params.id || "").trim();
  const c = challenges.get(id);
  if (!c) return res.status(404).json({ message: "Izaicinājums nav atrasts." });
  if (c.player2)
    return res
      .status(400)
      .json({ message: "Izaicinājumam jau ir otrs spēlētājs." });
  const me = req.user.username;
  if (c.player1 === me)
    return res
      .status(400)
      .json({ message: "Nevari pievienoties savam izaicinājumam." });
  c.player2 = me;
  return res.json({
    ok: true,
    challengeId: id,
    len: c.len,
    player1: c.player1,
    player2: me,
  });
});

app.post("/challenge/:id/guess", authMiddleware, (req, res) => {
  pruneExpiredChallenges();
  const id = String(req.params.id || "").trim();
  const c = challenges.get(id);
  if (!c) return res.status(404).json({ message: "Izaicinājums nav atrasts." });
  if (!c.player2)
    return res
      .status(400)
      .json({ message: "Otrs spēlētājs vēl nav pievienojies." });
  const me = req.user.username;
  const isPlayer1 = c.player1 === me;
  const isPlayer2 = c.player2 === me;
  if (!isPlayer1 && !isPlayer2)
    return res
      .status(403)
      .json({ message: "Tu neesi šī izaicinājuma dalībnieks." });

  const guessRaw = (req.body?.guess || "").toString().trim().toUpperCase();
  if (guessRaw.length !== c.len) {
    return res.status(400).json({ message: `Vārdam jābūt ${c.len} burtiem.` });
  }
  if (!GUESS_ALLOWED_RE.test(guessRaw)) {
    return res.status(400).json({
      message: "Minējumā drīkst būt tikai burti (A-Z + latviešu burti).",
    });
  }

  let history = isPlayer1 ? c.history1 : c.history2;
  if (!Array.isArray(history)) {
    history = [];
    if (isPlayer1) c.history1 = history;
    else c.history2 = history;
  }
  const currentAttempts = history.length;
  if (currentAttempts >= MAX_ATTEMPTS) {
    return res
      .status(400)
      .json({ message: "Tu jau esi iztērējis visus mēģinājumus." });
  }
  if (isPlayer1 && c.completed1)
    return res
      .status(400)
      .json({ message: "Tu jau esi pabeidzis šo izaicinājumu." });
  if (isPlayer2 && c.completed2)
    return res
      .status(400)
      .json({ message: "Tu jau esi pabeidzis šo izaicinājumu." });

  const pattern = buildPattern(c.word, guessRaw);
  const isWin = guessRaw === c.word;
  const attemptsUsed = currentAttempts + 1;
  history.push({ guess: guessRaw, pattern, ts: Date.now() });

  if (isPlayer1) {
    if (isWin || attemptsUsed >= MAX_ATTEMPTS) {
      c.completed1 = true;
      c.attempts1 = isWin ? attemptsUsed : MAX_ATTEMPTS;
    }
  } else {
    if (isWin || attemptsUsed >= MAX_ATTEMPTS) {
      c.completed2 = true;
      c.attempts2 = isWin ? attemptsUsed : MAX_ATTEMPTS;
    }
  }

  const bothDone = c.completed1 && c.completed2;
  let winner = null;
  if (bothDone && c.attempts1 != null && c.attempts2 != null) {
    if (c.attempts1 < c.attempts2) winner = c.player1;
    else if (c.attempts2 < c.attempts1) winner = c.player2;
  }

  return res.json({
    pattern,
    win: isWin,
    finished: isPlayer1 ? c.completed1 : c.completed2,
    attemptsUsed,
    attemptsLeft: MAX_ATTEMPTS - attemptsUsed,
    bothDone,
    winner: bothDone ? winner : undefined,
    attempts1: bothDone ? c.attempts1 : undefined,
    attempts2: bothDone ? c.attempts2 : undefined,
    player1: bothDone ? c.player1 : undefined,
  });
});

app.get("/challenge/:id/history", authMiddleware, (req, res) => {
  const id = String(req.params.id || "").trim();
  const c = challenges.get(id);
  if (!c) return res.status(404).json({ message: "Izaicinājums nav atrasts." });
  const me = req.user.username;
  const isPlayer1 = c.player1 === me;
  const isPlayer2 = c.player2 === me;
  if (!isPlayer1 && !isPlayer2)
    return res
      .status(403)
      .json({ message: "Tu neesi šī izaicinājuma dalībnieks." });
  const history = isPlayer1 ? c.history1 : c.history2;
  return res.json({
    history: Array.isArray(history) ? history : [],
    len: c.len,
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

  const avoidRaw =
    req.body && Array.isArray(req.body.avoid) ? req.body.avoid : [];
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

app.post("/guess", guessRateLimiter, authMiddleware, (req, res) => {
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
    ensureWeekly(user);
    user.weeklyWins = (user.weeklyWins || 0) + 1;
    user.weeklyScore = (user.weeklyScore || 0) + SCORE_PER_WIN;
    user.weeklyXp = (user.weeklyXp || 0) + xpGain;
    if (REGION_POINTS_PER_WIN > 0) {
      let regionPointsGain = REGION_POINTS_PER_WIN;
      if (isRegionBonusActive()) regionPointsGain *= REGION_BONUS_MULTIPLIER;
      user.regionPoints =
        Math.max(0, Math.floor(user.regionPoints || 0)) + regionPointsGain;
    }

    user.bestStreak = Math.max(user.bestStreak || 0, user.streak || 0);

    ensureRankFields(user);

    io.emit("playerWin", {
      username: user.username,
      xpGain,
      coinsGain,
      rankTitle: user.rankTitle,
      rankLevel: user.rankLevel,
      rankColor: user.rankColor || "#9CA3AF",
      avatarUrl: avatarForBroadcast(user),
      streak: user.streak || 0,
    });
  } else {
    if (finished) user.streak = 0;
  }

  round.finished = finished;

  try {
    round.history.push({ guess: guessRaw, pattern, ts: Date.now() });
    if (round.history.length > MAX_ATTEMPTS)
      round.history = round.history.slice(-MAX_ATTEMPTS);
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
app.get("/leaderboard/streak", (_req, res) => {
  res.json(computeStreakLeaderboard());
});
app.get("/leaderboard/daily", (_req, res) => {
  res.json(computeDailyLeaderboard());
});
app.get("/leaderboard", (_req, res) => {
  res.json(computeTop10Leaderboard());
});

// ===== Weekly challenge =====
app.get("/weekly", authMiddleware, (req, res) => {
  const user = req.user;
  markActivity(user);
  ensureWeekly(user);
  res.json(computeWeeklyLeaderboard(user));
});

// ===== Regions (Novadi) =====
function computeMyRegionRank(user) {
  const region = normalizeRegion(user?.region);
  if (!region) return null;
  const inRegion = Object.values(USERS || {})
    .filter(
      (u) =>
        u && u.username && !u.isBanned && normalizeRegion(u.region) === region
    )
    .slice();
  inRegion.sort((a, b) => {
    const ds = (b.score || 0) - (a.score || 0);
    if (ds !== 0) return ds;
    return String(a.username).localeCompare(String(b.username));
  });
  const idx = inRegion.findIndex((u) => u.username === user.username);
  if (idx < 0) return null;
  return { place: idx + 1, totalInRegion: inRegion.length };
}

app.get("/regions/stats", authMiddleware, (req, res) => {
  const regions = computeRegionStats();
  const myRegionRank = computeMyRegionRank(req.user);
  res.json({ regions, myRegionRank });
});

app.post("/region", authMiddleware, async (req, res) => {
  const user = req.user;
  const region = normalizeRegion(req.body?.region);
  if (!region) {
    return res.status(400).json({
      message: "Nederīgs novads. Pieejams: Zemgale, Latgale, Vidzeme, Kurzeme.",
    });
  }
  if (user.region) {
    return res.status(400).json({ message: "Novads jau ir izvēlēts." });
  }
  user.region = region;
  saveUsers(USERS);
  broadcastOnlineList(true);
  res.json({ ok: true, me: await buildMePayload(user) });
});

app.post("/region/boost", authMiddleware, async (req, res) => {
  const user = req.user;
  const amount = clampInt(req.body?.amount, 1, REGION_POINTS_MAX_ACTION, 1);
  const points = Math.max(0, Math.floor(user.regionPoints || 0));
  if (points < amount) {
    return res.status(400).json({ message: "Nepietiek novada punktu." });
  }
  user.regionPoints = points - amount;
  user.regionBoost = Math.max(0, Math.floor(user.regionBoost || 0)) + amount;
  saveUsers(USERS);
  res.json({ ok: true, me: await buildMePayload(user) });
});

app.post("/region/attack", authMiddleware, async (req, res) => {
  const user = req.user;
  const target = normalizeRegion(req.body?.region);
  if (!target) {
    return res.status(400).json({ message: "Izvēlies pretinieka novadu." });
  }
  if (user.region && target === user.region) {
    return res.status(400).json({ message: "Nevari uzbrukt savam novadam." });
  }
  const amount = clampInt(req.body?.amount, 1, REGION_POINTS_MAX_ACTION, 1);
  const points = Math.max(0, Math.floor(user.regionPoints || 0));
  if (points < amount) {
    return res.status(400).json({ message: "Nepietiek novada punktu." });
  }
  user.regionPoints = points - amount;
  if (!user.regionAttacks || typeof user.regionAttacks !== "object")
    user.regionAttacks = {};
  user.regionAttacks[target] =
    (Number(user.regionAttacks[target]) || 0) + amount;
  saveUsers(USERS);
  res.json({ ok: true, me: await buildMePayload(user) });
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

    const eloAfter =
      duel.ranked !== false && u1 && u2
        ? { [p1]: u1.duelElo, [p2]: u2.duelElo }
        : null;

    const eloDelta1 =
      eloBefore && eloAfter
        ? Number(eloAfter[p1] || 0) - Number(eloBefore[p1] || 0)
        : 0;
    const eloDelta2 =
      eloBefore && eloAfter
        ? Number(eloAfter[p2] || 0) - Number(eloBefore[p2] || 0)
        : 0;

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
      if (!Number.isFinite(v) || v < 0)
        return wheelEmitError(socket, "Nederīgs set.");
      nextTokens = v;
    } else if (mode === "delta") {
      const d = parseInt(payload.delta ?? payload.d ?? payload.change, 10);
      if (!Number.isFinite(d) || d === 0)
        return wheelEmitError(socket, "Nederīgs delta.");
      nextTokens = Math.max(0, nextTokens + d);
    } else {
      const hasSet =
        payload.set !== undefined && payload.set !== null && payload.set !== "";
      const hasDelta =
        payload.delta !== undefined &&
        payload.delta !== null &&
        payload.delta !== "";
      if (!hasSet && !hasDelta)
        return wheelEmitError(socket, "Norādi set vai delta.");

      if (hasSet) {
        const v = parseInt(payload.set, 10);
        if (!Number.isFinite(v) || v < 0)
          return wheelEmitError(socket, "Nederīgs set.");
        nextTokens = v;
      } else {
        const d = parseInt(payload.delta, 10);
        if (!Number.isFinite(d) || d === 0)
          return wheelEmitError(socket, "Nederīgs delta.");
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
      spinMs:
        payload.spinMs ?? payload.spin_ms ?? payload.ms ?? payload.durationMs,
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
        history: Array.isArray(duel.history?.[user.username])
          ? duel.history[user.username]
          : [],
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
    if (DM_STORE_ON_SERVER) ensureDm(u);
    socket.emit("dm.unread", dmComputeUnread(u?.dm));
    socket.emit("dm.blocked", { list: listBlocks(u) });
    socket.emit("friends.update", getFriendsPayload(u));
  } catch {}

  if (CHAT_STORE_ON_SUPABASE && CHAT_HISTORY_LIMIT > 0) {
    loadChatHistory(CHAT_HISTORY_LIMIT)
      .then((messages) => {
        if (messages && messages.length) {
          socket.emit("chatHistory", { messages });
        }
      })
      .catch(() => {});
  }

  socket.on("leaderboard:top10", () => {
    if (socketRateLimited(socket, "lbTop10", 2000)) return;
    socket.emit("leaderboard:update", computeTop10Leaderboard());
  });

  // ========== ČATS ==========
  socket.on("chatMessage", (text) => {
    if (socketRateLimited(socket, "chatMessage", CHAT_RATE_MS)) return;
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

    const chatPayload = {
      username: u.username,
      text: msg,
      ts: Date.now(),
      avatarUrl: avatarForBroadcast(u),
      rankTitle: u.rankTitle || "—",
      rankLevel: u.rankLevel || 1,
      rankColor: u.rankColor || "#9CA3AF",
      supporter: !!u.supporter,
      region: u.region || "",
    };
    io.emit("chatMessage", chatPayload);
    if (CHAT_STORE_ON_SUPABASE) {
      chatStoreMessage(chatPayload).catch(() => {});
    }
  });

  // ========== PRIVĀTAIS ČATS (DM) ==========
  socket.on("dm.send", (payload) => {
    const sender = USERS[user.username] || user;
    const now = Date.now();

    const toRaw =
      typeof payload === "string"
        ? ""
        : (payload?.to ?? payload?.username ?? payload?.target ?? "");
    const textRaw =
      typeof payload === "string" ? payload : (payload?.text ?? "");

    const toName = String(toRaw || "").trim();
    const text = dmSanitizeText(textRaw);
    if (!toName)
      return socket.emit("dm.error", { message: "Nav norādīts saņēmējs." });
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
    if (!target)
      return socket.emit("dm.error", { message: "Lietotājs nav atrasts." });
    if (target.username === sender.username)
      return socket.emit("dm.error", { message: "Nevari rakstīt sev." });

    if (isBlocked(sender, target.username)) {
      return socket.emit("dm.error", {
        message: "Tu esi nobloķējis šo lietotāju.",
      });
    }
    if (isBlocked(target, sender.username)) {
      return socket.emit("dm.error", {
        message: "Lietotājs tevi ir nobloķējis.",
      });
    }

    // aktivitāte (anti-afk)
    markActivity(sender);
    markActivity(target);

    let reply = null;
    if (payload && typeof payload === "object" && payload.reply) {
      const rid = String(payload.reply?.id || "").trim();
      const rfrom = String(payload.reply?.from || "").trim();
      let rtext = String(payload.reply?.text || "").trim();
      if (rtext.length > 80) rtext = rtext.slice(0, 80);
      if (
        rid &&
        rfrom &&
        rtext &&
        (rfrom === sender.username || rfrom === target.username)
      ) {
        reply = { id: rid, from: rfrom, text: rtext };
      }
    }

    if (!DM_STORE_ON_SERVER) {
      const msg = {
        id: crypto.randomBytes(8).toString("hex"),
        from: sender.username,
        to: target.username,
        text,
        ts: Date.now(),
        meta: dmBuildMeta(sender),
      };
      if (reply) msg.reply = reply;
      saveUsers(USERS);

      socket.emit("dm.sent", {
        message: msg,
        with: target.username,
        mode: "client",
      });
      const targetSocket = getSocketByUsername(target.username);
      if (targetSocket) {
        targetSocket.emit("dm.message", {
          message: msg,
          fromUser: getMiniUserPayload(sender.username),
          mode: "client",
        });
        targetSocket.emit("dm.unread", dmComputeUnread(null));
      }
      return;
    }

    const msg = dmPushMessage(sender, target, text, { reply });
    if (!msg)
      return socket.emit("dm.error", { message: "Neizdevās nosūtīt ziņu." });

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

  socket.on("dm.typing", (payload) => {
    if (socketRateLimited(socket, "dmTyping", DM_TYPING_RATE_MS)) return;
    const sender = USERS[user.username] || user;
    const toRaw =
      typeof payload === "string"
        ? payload
        : (payload?.with ?? payload?.to ?? payload?.username ?? "");
    const toName = String(toRaw || "").trim();
    if (!toName) return;
    const key = findUserKeyCaseInsensitive(toName);
    const target = key ? USERS[key] : null;
    if (!target || target.username === sender.username) return;
    const targetSocket = getSocketByUsername(target.username);
    if (!targetSocket) return;
    if (
      isBlocked(sender, target.username) ||
      isBlocked(target, sender.username)
    )
      return;
    const typing = !!(payload && typeof payload === "object"
      ? payload.typing
      : false);
    targetSocket.emit("dm.typing", { from: sender.username, typing });
  });

  socket.on("dm.edit", (payload) => {
    const me = USERS[user.username] || user;
    const otherRaw =
      typeof payload === "string"
        ? payload
        : (payload?.with ?? payload?.to ?? payload?.username ?? "");
    const otherName = String(otherRaw || "").trim();
    const id = String(payload?.id || "").trim();
    const text = dmSanitizeText(payload?.text || "");
    if (!otherName || !id)
      return socket.emit("dm.error", { message: "Nederīga ziņa." });
    if (!text) return socket.emit("dm.error", { message: "Ziņa ir tukša." });

    if (!DM_STORE_ON_SERVER) {
      const key = findUserKeyCaseInsensitive(otherName);
      const other = key ? USERS[key] : null;
      const otherUsername = other?.username || otherName;
      const message = {
        id,
        from: me.username,
        to: otherUsername,
        text,
        edited: true,
        editedAt: Date.now(),
      };
      socket.emit("dm.edited", {
        with: otherUsername,
        message,
        mode: "client",
      });
      const targetSocket = getSocketByUsername(otherUsername);
      if (targetSocket) {
        targetSocket.emit("dm.edited", {
          with: me.username,
          message,
          mode: "client",
        });
      }
      return;
    }

    ensureDm(me);
    const key = findUserKeyCaseInsensitive(otherName);
    const other = key ? USERS[key] : null;
    const otherUsername = other?.username || otherName;
    const threadKey = dmThreadKeyFor(me, otherUsername);
    const arr = Array.isArray(me.dm.threads?.[threadKey])
      ? me.dm.threads[threadKey]
      : [];
    const idx = arr.findIndex((m) => m && m.id === id);
    if (idx === -1)
      return socket.emit("dm.error", { message: "Ziņa nav atrasta." });
    const msg = arr[idx];
    if (msg?.from !== me.username)
      return socket.emit("dm.error", {
        message: "Vari rediģēt tikai savas ziņas.",
      });

    arr[idx] = { ...msg, text, edited: true, editedAt: Date.now() };
    saveUsers(USERS);
    socket.emit("dm.edited", { with: otherUsername, message: arr[idx] });
  });

  socket.on("dm.delete", (payload) => {
    const me = USERS[user.username] || user;
    const otherRaw =
      typeof payload === "string"
        ? payload
        : (payload?.with ?? payload?.to ?? payload?.username ?? "");
    const otherName = String(otherRaw || "").trim();
    const id = String(payload?.id || "").trim();
    if (!otherName || !id)
      return socket.emit("dm.error", { message: "Nederīga ziņa." });

    if (!DM_STORE_ON_SERVER) {
      const key = findUserKeyCaseInsensitive(otherName);
      const other = key ? USERS[key] : null;
      const otherUsername = other?.username || otherName;
      socket.emit("dm.deleted", { with: otherUsername, id, mode: "client" });
      const targetSocket = getSocketByUsername(otherUsername);
      if (targetSocket) {
        targetSocket.emit("dm.deleted", {
          with: me.username,
          id,
          mode: "client",
        });
      }
      return;
    }

    ensureDm(me);
    const key = findUserKeyCaseInsensitive(otherName);
    const other = key ? USERS[key] : null;
    const otherUsername = other?.username || otherName;
    const threadKey = dmThreadKeyFor(me, otherUsername);
    const arr = Array.isArray(me.dm.threads?.[threadKey])
      ? me.dm.threads[threadKey]
      : [];
    const idx = arr.findIndex((m) => m && m.id === id);
    if (idx === -1)
      return socket.emit("dm.error", { message: "Ziņa nav atrasta." });
    const msg = arr[idx];
    if (msg?.from !== me.username)
      return socket.emit("dm.error", {
        message: "Vari dzēst tikai savas ziņas.",
      });

    arr[idx] = { ...msg, text: "", deleted: true, deletedAt: Date.now() };
    saveUsers(USERS);
    socket.emit("dm.deleted", { with: otherUsername, id });
  });

  socket.on("dm.block", (payload) => {
    const me = USERS[user.username] || user;
    const otherRaw =
      typeof payload === "string"
        ? payload
        : (payload?.with ?? payload?.username ?? payload?.user ?? "");
    const otherName = String(otherRaw || "").trim();
    if (!otherName)
      return socket.emit("dm.error", { message: "Nav norādīts lietotājs." });
    if (otherName === me.username) {
      return socket.emit("dm.error", { message: "Nevari bloķēt sevi." });
    }

    const key = findUserKeyCaseInsensitive(otherName);
    const other = key ? USERS[key] : null;
    const otherUsername = other?.username || otherName;

    addBlock(me, otherUsername, other?.username || otherName);
    if (DM_STORE_ON_SERVER) {
      ensureDm(me);
      dmZeroUnreadCaseInsensitive(me.dm, otherUsername);
    }
    saveUsers(USERS);
    socket.emit("dm.blocked", {
      list: listBlocks(me),
      with: otherUsername,
      blocked: true,
    });
    socket.emit("dm.unread", dmComputeUnread(me.dm));
  });

  socket.on("dm.unblock", (payload) => {
    const me = USERS[user.username] || user;
    const otherRaw =
      typeof payload === "string"
        ? payload
        : (payload?.with ?? payload?.username ?? payload?.user ?? "");
    const otherName = String(otherRaw || "").trim();
    if (!otherName)
      return socket.emit("dm.error", { message: "Nav norādīts lietotājs." });

    const key = findUserKeyCaseInsensitive(otherName);
    const other = key ? USERS[key] : null;
    const otherUsername = other?.username || otherName;

    removeBlock(me, otherUsername);
    saveUsers(USERS);
    socket.emit("dm.blocked", {
      list: listBlocks(me),
      with: otherUsername,
      blocked: false,
    });
  });

  socket.on("dm.report", (payload) => {
    const me = USERS[user.username] || user;
    const otherRaw =
      typeof payload === "string"
        ? payload
        : (payload?.with ?? payload?.username ?? payload?.user ?? "");
    const otherName = String(otherRaw || "").trim();
    if (!otherName)
      return socket.emit("dm.error", { message: "Nav norādīts lietotājs." });
    if (otherName === me.username) {
      return socket.emit("dm.error", { message: "Nevari ziņot par sevi." });
    }

    const key = findUserKeyCaseInsensitive(otherName);
    const other = key ? USERS[key] : null;
    const otherUsername = other?.username || otherName;

    let reason = "";
    if (payload && typeof payload === "object" && payload.reason) {
      reason = String(payload.reason || "").trim();
      if (reason.length > REPORT_REASON_MAX_LEN)
        reason = reason.slice(0, REPORT_REASON_MAX_LEN);
    }

    let messageText = "";
    const rawText = payload && typeof payload === "object" ? payload.text : "";
    if (rawText) {
      messageText = String(rawText || "").trim();
      if (messageText.length > REPORT_TEXT_MAX_LEN) {
        messageText = messageText.slice(0, REPORT_TEXT_MAX_LEN);
      }
    }

    const report = {
      id: crypto.randomBytes(8).toString("hex"),
      ts: Date.now(),
      reporter: me.username,
      reported: otherUsername,
      reason,
      messageId: String(payload?.id || "").trim() || null,
      messageText: messageText || null,
      source: "dm",
    };
    REPORTS.push(report);
    if (REPORTS.length > REPORTS_MAX) REPORTS = REPORTS.slice(-REPORTS_MAX);
    saveReports(REPORTS);
    socket.emit("dm.reported", { ok: true });
  });

  socket.on("dm.history", (payload) => {
    const me = USERS[user.username] || user;
    const otherRaw =
      typeof payload === "string"
        ? payload
        : (payload?.with ?? payload?.username ?? payload?.user ?? "");
    const otherName = String(otherRaw || "").trim();
    if (!otherName)
      return socket.emit("dm.history", { with: "", messages: [] });

    if (!DM_STORE_ON_SERVER) {
      return socket.emit("dm.history", {
        with: otherName,
        messages: [],
        peerLastRead: 0,
        mode: "client",
      });
    }

    ensureDm(me);
    const key = findUserKeyCaseInsensitive(otherName);
    const other = key ? USERS[key] : null;
    const otherUsername = other?.username || otherName;

    const threadKey = dmThreadKeyFor(me, otherUsername);
    const arr = Array.isArray(me.dm.threads?.[threadKey])
      ? me.dm.threads[threadKey]
      : [];
    const peerLastRead = other ? dmGetLastRead(other.dm, me.username) : 0;

    // sūtam pēdējās 60 ziņas, lai nav milzīgs payload
    socket.emit("dm.history", {
      with: otherUsername,
      messages: arr.slice(-60),
      peerLastRead,
      mode: "server",
    });
  });

  socket.on("dm.read", (payload) => {
    const me = USERS[user.username] || user;
    const otherRaw =
      typeof payload === "string"
        ? payload
        : (payload?.with ?? payload?.username ?? payload?.user ?? "");
    const otherName = String(otherRaw || "").trim();
    if (!otherName) return;

    if (!DM_STORE_ON_SERVER) {
      const readAt = Date.now();
      socket.emit("dm.unread", dmComputeUnread(null));
      const otherKey = findUserKeyCaseInsensitive(otherName);
      const otherUser = otherKey ? USERS[otherKey] : null;
      const otherSocket = getSocketByUsername(otherUser?.username || otherName);
      if (
        otherSocket &&
        !isBlocked(me, otherUser?.username || otherName) &&
        !(otherUser && isBlocked(otherUser, me.username))
      ) {
        otherSocket.emit("dm.read", {
          with: me.username,
          ts: readAt,
          mode: "client",
        });
      }
      return;
    }

    ensureDm(me);
    const key = findUserKeyCaseInsensitive(otherName);
    const other = key ? USERS[key] : null;
    const otherUsername = other?.username || otherName;

    const readAt = Date.now();
    me.dm.lastRead[otherUsername] = readAt;
    dmZeroUnreadCaseInsensitive(me.dm, otherUsername);
    saveUsers(USERS);
    socket.emit("dm.unread", dmComputeUnread(me.dm));

    const otherSocket = getSocketByUsername(otherUsername);
    if (
      otherSocket &&
      !isBlocked(me, otherUsername) &&
      !(other && isBlocked(other, me.username))
    ) {
      otherSocket.emit("dm.read", { with: me.username, ts: readAt });
    }
  });

  // Dzēst visu DM sarunu (tikai šim lietotājam / "delete for me")
  // payload: { with: "OtherUser" }
  socket.on("dm.clearThread", (payload) => {
    const me = USERS[user.username] || user;
    const otherRaw =
      typeof payload === "string"
        ? payload
        : (payload?.with ?? payload?.username ?? payload?.user ?? "");
    const otherName = String(otherRaw || "").trim();
    if (!otherName)
      return socket.emit("dm.error", { message: "Nav norādīta saruna." });

    if (!DM_STORE_ON_SERVER) {
      const key = findUserKeyCaseInsensitive(otherName);
      const other = key ? USERS[key] : null;
      const otherUsername = other?.username || otherName;
      if (!otherUsername || otherUsername === me.username) {
        return socket.emit("dm.error", { message: "Nederīga saruna." });
      }
      socket.emit("dm.cleared", { with: otherUsername, mode: "client" });
      socket.emit("dm.unread", dmComputeUnread(null));
      const targetSocket = getSocketByUsername(otherUsername);
      if (targetSocket) {
        targetSocket.emit("dm.cleared", { with: me.username, mode: "client" });
      }
      return;
    }

    ensureDm(me);
    const key = findUserKeyCaseInsensitive(otherName);
    const other = key ? USERS[key] : null;
    const otherUsername = other?.username || otherName;
    if (!otherUsername || otherUsername === me.username)
      return socket.emit("dm.error", { message: "Nederīga saruna." });

    const threadKey = dmThreadKeyFor(me, otherUsername);
    try {
      if (me.dm.threads && typeof me.dm.threads === "object")
        delete me.dm.threads[threadKey];
    } catch {}
    try {
      if (me.dm.lastRead && typeof me.dm.lastRead === "object")
        delete me.dm.lastRead[otherUsername];
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
        ? targetNameRaw.target ||
            targetNameRaw.username ||
            targetNameRaw.opponent ||
            ""
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
    const guess = String(payload?.guess || "")
      .trim()
      .toUpperCase();
    const duel = duelId ? duels.get(duelId) : null;
    if (!duel) return;

    if (duel.status !== "active") return;
    if (!duel.players.includes(u.username)) return;

    // neļaujam minēt pirms atskaites beigām (fair play)
    if (duel.startedAt && Date.now() < duel.startedAt) {
      return socket.emit("duel.error", {
        message: "Duelis vēl nav sācies. Pagaidi atskaiti!",
      });
    }

    if (!guess || guess.length !== duel.len) {
      return socket.emit("duel.error", {
        message: `Vārdam jābūt ${duel.len} burtiem.`,
      });
    }
    if (!GUESS_ALLOWED_RE.test(guess)) {
      return socket.emit("duel.error", {
        message: "Minējumā drīkst būt tikai burti (A-Z + LV).",
      });
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
      if (!Array.isArray(duel.history[u.username]))
        duel.history[u.username] = [];
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

        if (duel && duel.status === "pending")
          finishDuel(duel, null, "declined");
      }
    } catch {}

    onlineBySocket.delete(socket.id);
    broadcastOnlineList(true);
  });
});

async function initDataStores() {
  let usersLoadedFromDb = false;
  if (USERS_STORE_ON_SUPABASE) {
    const fromDb = await loadUsersFromSupabase();
    if (fromDb && Object.keys(fromDb).length) {
      USERS = fromDb;
      usersLoadedFromDb = true;
    } else {
      USERS = loadUsers();
    }
  } else {
    USERS = loadUsers();
  }

  if (REPORTS_STORE_ON_SUPABASE) {
    const fromDb = await loadReportsFromSupabase();
    REPORTS = fromDb || loadReports();
  } else {
    REPORTS = loadReports();
  }
  if (REPORTS_STORE_ON_SUPABASE) {
    saveReports(REPORTS);
  }

  const pruned = pruneUsersForMemory(USERS);
  if (
    pruned ||
    !DM_STORE_ON_SERVER ||
    (USERS_STORE_ON_SUPABASE && !usersLoadedFromDb)
  ) {
    saveUsers(USERS);
  }
}

async function startServer() {
  await initDataStores();

  // ======== WHEEL server init ========
  wheelSyncTokenSlots(true);

  if (CHAT_STORE_ON_SUPABASE && CHAT_RETENTION_DAYS > 0) {
    cleanupChatHistory().catch(() => {});
    setInterval(() => {
      cleanupChatHistory().catch(() => {});
    }, CHAT_CLEANUP_INTERVAL_MS);
  }

  // ======== HTTP listen ========
  httpServer.listen(PORT, () => {
    logger.info({ port: PORT }, "VĀRDU ZONA serveris palaists");
  });
}

if (process.env.NODE_ENV !== "test") {
  startServer().catch((err) => {
    logger.error({ err }, "Server start failed");
    process.exit(1);
  });
}

export { app, httpServer, io, logger, startServer };
