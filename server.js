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

// Seasons storage (JAUNS)
const SEASONS_FILE =
  process.env.SEASONS_FILE || path.join(__dirname, "seasons.json");

const MIN_WORD_LEN = 5;
const MAX_WORD_LEN = 7;
const MAX_ATTEMPTS = 6;

const BASE_TOKEN_PRICE = 150;

// ======== Lielie request body limiti (FIX 413 Payload Too Large) ========
// Ja vajag vēl vairāk, vari Render iestatījumos pielikt env:
// BODY_JSON_LIMIT="25mb" un BODY_URLENC_LIMIT="25mb"
const BODY_JSON_LIMIT = process.env.BODY_JSON_LIMIT || "25mb";
const BODY_URLENC_LIMIT = process.env.BODY_URLENC_LIMIT || BODY_JSON_LIMIT;

// Avatāra max garums (base64 string). 2.4MB bilde -> ~3.2MB base64,
// tāpēc paceļam ievērojami, bet ne bezgalīgi.
// Ja vajag, vari iestatīt env: AVATAR_MAX_CHARS="8000000"
const AVATAR_MAX_CHARS = (() => {
  const v = parseInt(process.env.AVATAR_MAX_CHARS || "", 10);
  if (Number.isFinite(v) && v > 200000) return v;
  return 6 * 1024 * 1024; // ~6.29M chars
})();

// Admin lietotāji
const ADMIN_USERNAMES = ["Bugats", "BugatsLV"];

// ======== Laika zona ========
const TZ = "Europe/Riga";

// ======== SEZONA 1 – beigu datums (vēsturiskais) ========
// 2025-12-26 ir ziemā, tāpēc +02:00 ir ok.
const SEASON1_END_AT = new Date("2025-12-26T23:59:59+02:00").getTime();

// ======== SEZONA 2 – default beigu datums (prasība: februāra vidus) ========
// (ja nav uzlikts env SEASON_END_AT, un tiek startēta/pielāgota Sezona 2)
const SEASON2_END_AT_DEFAULT = new Date("2026-02-15T23:59:59+02:00").getTime();

// ======== SEASON CONFIG ========
// Cik dienas ilgst jaunā sezona, ja nav endAt (default 30)
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

// duelId -> duel objekts
const duels = new Map();
// username -> duelId
const userToDuel = new Map();

// ======== ČATS (mini anti-spam) ========
const CHAT_MAX_LEN = 200;
const CHAT_RATE_MS = 900; // 1 ziņa ~ 0.9s
const CHAT_DUP_WINDOW_MS = 4000; // vienāds teksts 4s logā -> ignorējam

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

    // Aizsardzība: ja kādreiz failā nonāk objekts, pārvēršam par masīvu
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

      // Aktīvais raunds (ja nav – būs null)
      if (!u.currentRound) u.currentRound = null;

      // Avatārs
      if (typeof u.avatarUrl !== "string") u.avatarUrl = null;

      // Daily Chest
      if (!u.dailyChest || typeof u.dailyChest !== "object") u.dailyChest = {};
      if (typeof u.dailyChest.lastDate !== "string") u.dailyChest.lastDate = "";
      if (typeof u.dailyChest.streak !== "number") u.dailyChest.streak = 0;
      if (typeof u.dailyChest.totalOpens !== "number")
        u.dailyChest.totalOpens = 0;

      // (JAUNS) Pastāvīgās medaļas (piem., Sezonas čempions)
      if (!Array.isArray(u.specialMedals)) u.specialMedals = [];

      // Čats (anti-spam state)
      if (typeof u.lastChatAt !== "number") u.lastChatAt = 0;
      if (typeof u.lastChatText !== "string") u.lastChatText = "";
      if (typeof u.lastChatTextAt !== "number") u.lastChatTextAt = 0;

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
  // (UPGRADE) atomic write
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
    hallOfFame: [], // [{ seasonId, username, score, xp, rankTitle, rankLevel, avatarUrl, finishedAt }]
  };
}

let seasonStore = loadJsonSafe(SEASONS_FILE, null);
if (!seasonStore || typeof seasonStore !== "object") {
  seasonStore = buildInitialSeasonStore();
  saveJsonAtomic(SEASONS_FILE, seasonStore);
} else {
  if (!seasonStore.current) seasonStore.current = buildInitialSeasonStore().current;
  if (!Array.isArray(seasonStore.hallOfFame)) seasonStore.hallOfFame = [];
}

// “seasonState” saglabājam, lai neko nesalauztu frontā (tas pats shape kā līdz šim)
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

  // ja pašreizējais endAt ir agrāks par prasīto mid-Feb, pielāgojam uz mid-Feb
  if (seasonState.endAt < SEASON2_END_AT_DEFAULT) {
    seasonState.endAt = SEASON2_END_AT_DEFAULT;
    seasonStore.current = seasonState;
    saveJsonAtomic(SEASONS_FILE, seasonStore);
    console.log("Season 2 endAt adjusted to mid-Feb (default).");
  }
})();

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

// (UPGRADE) vienots helperis rank lauku uzturēšanai
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
  // Aprēķinam “rītdienas 00:00” pēc LV laika
  const key = todayKey(now);
  const [y, mo, d] = key.split("-").map((x) => parseInt(x, 10));

  // offsetu ņemam ap pusdienlaiku rītdienā (drošāk DST gadījumos)
  const probe = new Date(Date.UTC(y, mo - 1, d + 1, 12, 0, 0));
  const offsetMin = getTzOffsetMinutes(TZ, probe);

  const utcMidnight = Date.UTC(y, mo - 1, d + 1, 0, 0, 0);
  return utcMidnight - offsetMin * 60 * 1000;
}

// ======== Anti-AFK + pasīvie coini ========
function markActivity(user) {
  const now = Date.now();

  if (!user.lastActionAt) {
    user.lastActionAt = now;
    user.lastPassiveTickAt = now;
    return;
  }
  if (!user.lastPassiveTickAt) {
    user.lastPassiveTickAt = user.lastActionAt;
  }

  // ja AFK pārtraukums – restartējam pasīvos
  if (now - user.lastActionAt > AFK_BREAK_MS) {
    user.lastActionAt = now;
    user.lastPassiveTickAt = now;
    return;
  }

  user.lastActionAt = now;
  const diff = now - user.lastPassiveTickAt;

  if (diff >= PASSIVE_INTERVAL_MS) {
    const ticks = Math.floor(diff / PASSIVE_INTERVAL_MS);
    const gained = ticks * PASSIVE_COINS_PER_TICK;
    user.coins = (user.coins || 0) + gained;
    user.lastPassiveTickAt += ticks * PASSIVE_INTERVAL_MS;
    console.log(
      `Pasīvie coini: ${user.username} +${gained} (tagad: ${user.coins})`
    );
  }
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

  if (changed) saveUsers(USERS);
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

// (JAUNS) apvieno dinamiskās + pastāvīgās medaļas (bez dublikātiem pēc code)
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
function getTop1UserByScore() {
  const all = Object.values(USERS || {});
  if (!all.length) return null;

  // TOP1 = score desc; ja vienāds -> xp desc; ja vienāds -> username asc
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

function finalizeSeasonIfNeeded(seasonId) {
  if (!seasonId) return null;
  const sid = Number(seasonId) || 0;
  if (sid <= 0) return null;

  // Idempotence: ja jau ir HoF ieraksts šai sezonai — nedublējam
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

  // Sezonas čempiona medaļa (pastāvīgā)
  if (sid === 1) {
    addSpecialMedalOnce(champ, {
      code: "SEASON1_CHAMPION",
      icon: "🏆",
      label: "Sezona 1 čempions",
      ts: finishedAt,
    });
  } else {
    addSpecialMedalOnce(champ, {
      code: `SEASON${sid}_CHAMPION`,
      icon: "🏆",
      label: `Sezona ${sid} čempions`,
      ts: finishedAt,
    });
  }

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
}

function computeNextSeasonEndAt(startAt, nextSeasonId) {
  // Ja gribi fiksētu endAt, vari ielikt env: SEASON_END_AT="2026-01-31T23:59:59+02:00"
  const envEnd = process.env.SEASON_END_AT;
  if (envEnd) {
    const ts = new Date(envEnd).getTime();
    if (Number.isFinite(ts) && ts > startAt) return ts;
  }

  // Sezona 2 – fiksēts “februāra vidus”
  if (Number(nextSeasonId) === 2) {
    if (Number.isFinite(SEASON2_END_AT_DEFAULT) && SEASON2_END_AT_DEFAULT > startAt) {
      return SEASON2_END_AT_DEFAULT;
    }
  }

  return startAt + SEASON_DAYS * 24 * 60 * 60 * 1000;
}

// Galvenais: startē sezonu vai pārslēdz uz nākamo, ja iepriekšējā beigusies
function startSeasonFlow({ byAdminUsername } = {}) {
  const now = Date.now();
  const cur = seasonState || seasonStore.current;

  const curId = Number(cur?.id || 1) || 1;
  const curEnded = !!(cur?.endAt && now >= cur.endAt);

  // Ja current sezona vēl nav beigusies un nav aktīva — vienkārši aktivizējam to
  if (!curEnded && cur && !cur.active) {
    cur.active = true;
    cur.startedAt = cur.startedAt || now;

    seasonStore.current = cur;
    seasonState = seasonStore.current;
    saveJsonAtomic(SEASONS_FILE, seasonStore);

    return { mode: "started_current", season: seasonState, hofEntry: null };
  }

  // Ja current sezona ir aktīva un nav beigusies — neko nedaram
  if (!curEnded && cur && cur.active) {
    return { mode: "already_active", season: cur, hofEntry: null };
  }

  // Ja current sezona ir beigusies — finalizējam + pārslēdzam uz nākamo
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

  // reset coins + tokens visiem (prasība)
  resetCoinsAndTokensForAllUsers();

  if (byAdminUsername) {
    console.log(`SEASON rollover by ${byAdminUsername}: now ${seasonState.name}`);
  }

  return { mode: "rolled_next", season: seasonState, hofEntry };
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
  };
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ message: "Nav token" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = USERS[payload.username];
    if (!user) return res.status(401).json({ message: "Lietotājs nav atrasts" });
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
app.use(cors());

// ======== BODY PARSER LIMITI (TE IR FIX) ========
app.use(express.json({ limit: BODY_JSON_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: BODY_URLENC_LIMIT }));

// Lai 413 vienmēr atgriežas kā JSON (nevis HTML), citādi clientā ir "Non-JSON response"
app.use((err, req, res, next) => {
  if (err && (err.type === "entity.too.large" || err.status === 413)) {
    return res.status(413).json({
      message:
        "Payload Too Large: pieprasījums ir par lielu. Samazini failu vai palielini BODY_JSON_LIMIT serverī.",
    });
  }
  return next(err);
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// ======== ONLINE saraksts ========
// socket.id -> username
const onlineBySocket = new Map();

function getAvatarByUsername(username) {
  return USERS[username]?.avatarUrl || null;
}

// (UPGRADE) mini profila dati online listam + TOP/krāsām (bez /profile)
function getMiniUserPayload(username) {
  const u = USERS[username];
  if (!u) {
    return { username, avatarUrl: null, rankLevel: 1, rankTitle: "—" };
  }
  const info = ensureRankFields(u);
  return {
    username,
    avatarUrl: u.avatarUrl || null,
    rankLevel: u.rankLevel || info.level || 1,
    rankTitle: u.rankTitle || info.title || "—",
    supporter: !!u.supporter, // droši, ja nākotnē ieliksi
  };
}

// (UPGRADE) neemitējam onlineList, ja nav izmaiņu (mazāk traffic, ātrāks UI)
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
        `${u.username}|${u.avatarUrl || ""}|${u.rankLevel || 0}|${u.rankTitle || ""}|${
          u.supporter ? 1 : 0
        }`
    )
    .join(";");

  if (!force && sig === lastOnlineSig) return;
  lastOnlineSig = sig;

  io.emit("onlineList", { count: users.length, users });
}

setInterval(() => {
  broadcastOnlineList(false);
}, 30 * 1000);

// === Admin & čata helperi ===
function broadcastSystemMessage(text) {
  const payload = {
    username: "SYSTEM",
    text,
    ts: Date.now(),
  };
  io.emit("chatMessage", payload);
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

  if (
    ["ban", "unban", "kick", "mute", "unmute"].includes(cmd) &&
    !targetName
  ) {
    adminSocket.emit("chatMessage", {
      username: "SYSTEM",
      text: "Norādi lietotājvārdu. Piem.: /kick Nick",
      ts: Date.now(),
    });
    return;
  }

  const target = targetName ? USERS[targetName] : null;

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
      kickUserByName(targetName, "kick");
      broadcastSystemMessage(
        `Admin ${adminUser.username} izmeta lietotāju ${targetName}.`
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
      kickUserByName(targetName, "ban");
      broadcastSystemMessage(
        `Admin ${adminUser.username} nobanoja lietotāju ${targetName}.`
      );
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
        `Admin ${adminUser.username} atbanoja lietotāju ${targetName}.`
      );
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
      const minutes = parseInt(arg || "5", 10);
      const mins = Number.isNaN(minutes) ? 5 : Math.max(1, minutes);
      target.mutedUntil = Date.now() + mins * 60 * 1000;
      saveUsers(USERS);
      broadcastSystemMessage(
        `Admin ${adminUser.username} uzlika mute lietotājam ${targetName} uz ${mins} min.`
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
        `Admin ${adminUser.username} noņēma mute lietotājam ${targetName}.`
      );
      break;

    case "seasonstart": {
      if (!ADMIN_USERNAMES.includes(adminUser.username)) {
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
          io.emit("seasonHofUpdate", {
            top: seasonStore.hallOfFame[0] || null,
          });
        }
        broadcastSystemMessage(
          `📢 ${result.season.name} ir sākusies! (beigsies: ${endStr}) Coins + žetoni visiem ir resetoti.`
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
        const mins = Math.floor((totalSec % 3600) / 60);
        const secs = totalSec % 60;

        const endStr = new Date(endTs).toLocaleString("lv-LV", {
          timeZone: TZ,
        });

        text = `${seasonState.name} ir aktīva. Līdz sezonas beigām: ${days}d ${hours}h ${mins}m ${secs}s (līdz ${endStr}).`;
      }

      adminSocket.emit("chatMessage", {
        username: "SYSTEM",
        text,
        ts: Date.now(),
      });
      break;
    }

    default:
      adminSocket.emit("chatMessage", {
        username: "SYSTEM",
        text: "Nezināma komanda. Pieejams: /kick, /ban, /unban, /mute <min>, /unmute, /seasonstart, /seasononline.",
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
    dailyChest: { lastDate: "", streak: 0, totalOpens: 0 },
    // (JAUNS) pastāvīgās medaļas (piem., sezonu čempions)
    specialMedals: [],
    // Čats (anti-spam)
    lastChatAt: 0,
    lastChatText: "",
    lastChatTextAt: 0,
  };

  ensureRankFields(user);

  ensureDailyMissions(user);
  ensureDailyChest(user);

  USERS[name] = user;
  saveUsers(USERS);

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
  if (!user) {
    return res.status(400).json({ message: "Lietotājs nav atrasts" });
  }

  if (user.isBanned) {
    return res.status(403).json({
      message: "Šis lietotājs ir nobanots no VĀRDU ZONAS. Sazinies ar Bugats.",
    });
  }

  const ok = await bcrypt.compare(password, user.passwordHash || "");
  if (!ok) {
    return res.status(400).json({ message: "Nepareiza parole" });
  }

  markActivity(user);
  ensureDailyMissions(user);
  resetWinsTodayIfNeeded(user);
  ensureDailyChest(user);
  ensureSpecialMedals(user);
  ensureRankFields(user);
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
  saveUsers(USERS);

  res.json(buildMePayload(u));
});

// ======== AVATĀRA ENDPOINTS ========
app.post("/avatar", authMiddleware, (req, res) => {
  try {
    const user = req.user;
    const { avatar } = req.body || {};

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

  const isAdmin = requester && ADMIN_USERNAMES.includes(requester.username);

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
  const user = USERS[name];
  if (!user) return res.status(404).json({ message: "Lietotājs nav atrasts" });
  res.json(buildPublicProfilePayload(user, requester));
});

app.get("/profile/:username", authMiddleware, (req, res) => {
  const requester = req.user;
  const name = String(req.params.username || "").trim();
  const user = USERS[name];
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

  res.json({ me: buildMePayload(user), missions: getPublicMissions(user) });
});

// ======== DAILY CHEST ENDPOINTI (SALABO "Cannot GET /chest/status") ========
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
app.get("/season", authMiddleware, (req, res) => {
  res.json({
    ...seasonState,
    hallOfFameTop: seasonStore.hallOfFame[0] || null,
  });
});

// (SADERĪBA) vecais UI mēdz saukt /season/state — iedodam to pašu (publiski, minimāli)
app.get("/season/state", (_req, res) => {
  res.json({
    ...seasonState,
    hallOfFameTop: seasonStore.hallOfFame[0] || null,
  });
});

// (JAUNS) Hall of Fame endpoint (speciālais TOP)
app.get("/season/hof", authMiddleware, (req, res) => {
  res.json(seasonStore.hallOfFame || []);
});

app.post("/season/start", authMiddleware, (req, res) => {
  const user = req.user;
  if (!ADMIN_USERNAMES.includes(user.username)) {
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

app.post("/guess", authMiddleware, (req, res) => {
  const user = req.user;
  markActivity(user);
  ensureDailyMissions(user);
  ensureDailyChest(user);

  const guessRaw = (req.body?.guess || "").toString().trim().toUpperCase();
  if (!user.currentRound || user.currentRound.finished) {
    return res.status(400).json({ message: "Nav aktīva raunda" });
  }

  const round = user.currentRound;
  if (guessRaw.length !== round.len) {
    return res.status(400).json({ message: `Vārdam jābūt ${round.len} burtiem` });
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
      rankLevel: user.rankLevel, // (UPGRADE) krāsām uzreiz
      avatarUrl: user.avatarUrl || null, // (UPGRADE) bez fetch
      streak: user.streak || 0,
    });
  } else {
    if (finished) user.streak = 0;
  }

  round.finished = finished;

  updateMissionsOnGuess(user, { isWin, xpGain });
  saveUsers(USERS);

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
    return res.status(400).json({ message: "Nepietiek coins" });
  }

  user.coins = (user.coins || 0) - price;
  user.tokens = (user.tokens || 0) + 1;

  saveUsers(USERS);

  io.emit("tokenBuy", { username: user.username, tokens: user.tokens || 0 });

  res.json({
    coins: user.coins,
    tokens: user.tokens,
    tokenPriceCoins: getTokenPrice(user),
  });
});

// ===== Leaderboard (ar avatarUrl + rankLevel TOP krāsām) =====
app.get("/leaderboard", (_req, res) => {
  const arr = Object.values(USERS || {})
    .filter((u) => u && u.username && !u.isBanned)
    .slice();

  // sakārtojam rank laukus
  arr.forEach((u) => ensureRankFields(u));

  // stabils sort: score desc, xp desc, username asc
  arr.sort((a, b) => {
    const ds = (b.score || 0) - (a.score || 0);
    if (ds !== 0) return ds;
    const dx = (b.xp || 0) - (a.xp || 0);
    if (dx !== 0) return dx;
    return String(a.username).localeCompare(String(b.username));
  });

  const top = arr.slice(0, 10).map((u, idx) => ({
    place: idx + 1,
    username: u.username,
    score: u.score || 0,
    xp: u.xp || 0,
    rankTitle: u.rankTitle || "—",
    rankLevel: u.rankLevel || 1, // (UPGRADE) TOP10 krāsām
    avatarUrl: u.avatarUrl || null,
    supporter: !!u.supporter,
  }));

  res.json(top);
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

  // 1) izslēdzam sezonu
  if (seasonState.active) {
    seasonState.active = false;
    seasonStore.current = seasonState;
    saveJsonAtomic(SEASONS_FILE, seasonStore);
    io.emit("seasonUpdate", seasonState);

    // ļaujam izsūtīt vienu "beigusies" paziņojumu
    seasonEndedBroadcasted = false;
  }

  // 2) freeze TOP1 -> Hall of Fame (izpildās tikai 1x uz sezonu)
  const hofEntry = finalizeSeasonIfNeeded(seasonState.id);
  if (hofEntry) {
    io.emit("seasonHofUpdate", { top: seasonStore.hallOfFame[0] || null });
    broadcastSystemMessage(
      `🏆 ${seasonState.name} čempions: ${hofEntry.username} (score ${hofEntry.score}). Ierakstīts Hall of Fame!`
    );
  }

  // 3) paziņojums, ka sezona beigusies (1x)
  if (!seasonEndedBroadcasted) {
    const endStr = new Date(seasonState.endAt).toLocaleString("lv-LV", {
      timeZone: TZ,
    });
    broadcastSystemMessage(`⏳ ${seasonState.name} ir beigusies (${endStr}).`);
    io.emit("seasonUpdate", seasonState);
    seasonEndedBroadcasted = true;
  }
}, 1500);

// ======== Socket.IO pamat-connection ========
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("Nav token"));

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = USERS[payload.username];
    if (!user) return next(new Error("Lietotājs nav atrasts"));
    if (user.isBanned) return next(new Error("Lietotājs ir nobanots"));
    socket.data.user = user;
    return next();
  } catch (err) {
    return next(new Error("Nederīgs token"));
  }
});

io.on("connection", (socket) => {
  const user = socket.data.user;
  if (!user) {
    socket.disconnect();
    return;
  }

  console.log("Pieslēdzās:", user.username, "socket:", socket.id);

  markActivity(user);
  ensureDailyMissions(user);
  ensureDailyChest(user);
  ensureSpecialMedals(user);
  ensureRankFields(user);

  const bonus = grantDailyLoginBonus(user);
  if (bonus > 0) {
    socket.emit("chatMessage", {
      username: "SYSTEM",
      text: `Dienas ienākšanas bonuss: +${bonus} coins!`,
      ts: Date.now(),
    });
  }

  saveUsers(USERS);

  onlineBySocket.set(socket.id, user.username);
  broadcastOnlineList(true);

  socket.emit("seasonUpdate", seasonState);
  socket.emit("seasonHofUpdate", { top: seasonStore.hallOfFame[0] || null });

  // ========== ČATS ==========
  socket.on("chatMessage", (text) => {
    if (typeof text !== "string") return;
    let msg = text.trim();
    if (!msg) return;

    // server-side max garums (vienmēr droši)
    if (msg.length > CHAT_MAX_LEN) msg = msg.slice(0, CHAT_MAX_LEN);

    const u = USERS[user.username] || user;
    markActivity(u);
    ensureDailyMissions(u);
    ensureDailyChest(u);
    ensureRankFields(u);

    const now = Date.now();

    if (u.isBanned) {
      socket.emit("chatMessage", {
        username: "SYSTEM",
        text: "Tu esi nobanots no VĀRDU ZONAS.",
        ts: Date.now(),
      });
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
      return;
    }

    // mini anti-spam
    if (u.lastChatAt && now - u.lastChatAt < CHAT_RATE_MS) return;
    u.lastChatAt = now;

    if (
      u.lastChatText &&
      u.lastChatText === msg &&
      u.lastChatTextAt &&
      now - u.lastChatTextAt < CHAT_DUP_WINDOW_MS
    ) {
      return;
    }
    u.lastChatText = msg;
    u.lastChatTextAt = now;

    const isAdmin = ADMIN_USERNAMES.includes(u.username);
    if (isAdmin && (msg.startsWith("/") || msg.startsWith("!"))) {
      handleAdminCommand(msg, u, socket);
      return;
    }

    saveUsers(USERS);

    io.emit("chatMessage", {
      username: u.username,
      text: msg,
      ts: Date.now(),
      avatarUrl: u.avatarUrl || null,
      rankTitle: u.rankTitle || "—", // (UPGRADE) var krāsot bez /profile
      rankLevel: u.rankLevel || 1,   // (UPGRADE) var krāsot bez /profile
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

    const targetUser = USERS[targetName];
    if (!targetUser)
      return socket.emit("duel.error", { message: "Lietotājs nav atrasts." });

    if (userToDuel.has(challengerName))
      return socket.emit("duel.error", { message: "Tu jau esi citā duelī." });
    if (userToDuel.has(targetName))
      return socket.emit("duel.error", {
        message: "Pretinieks jau ir citā duelī.",
      });

    const targetSocket = getSocketByUsername(targetName);
    if (!targetSocket)
      return socket.emit("duel.error", {
        message: "Pretinieks nav tiešsaistē.",
      });

    const { word, len } = pickRandomWord();
    const duelId = crypto.randomBytes(8).toString("hex");

    const duel = {
      id: duelId,
      players: [challengerName, targetName],
      word,
      len,
      status: "pending",
      createdAt: Date.now(),
      startedAt: null,
      expiresAt: null,
      attemptsLeft: {
        [challengerName]: DUEL_MAX_ATTEMPTS,
        [targetName]: DUEL_MAX_ATTEMPTS,
      },
      rowsUsed: { [challengerName]: 0, [targetName]: 0 },
      winner: null,
      finishedReason: null,
    };

    duels.set(duelId, duel);
    userToDuel.set(challengerName, duelId);
    userToDuel.set(targetName, duelId);

    socket.emit("duel.waiting", { duelId, opponent: targetName, len });
    targetSocket.emit("duel.invite", { duelId, from: challengerName, len });
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

  socket.on("duel.guess", (payload) => {
    const duelId = payload?.duelId;
    const rawGuess = (payload?.guess || "").toString().trim().toUpperCase();
    const userName = socket.data.user.username;

    const duel = duels.get(duelId);
    if (!duel)
      return socket.emit("duel.error", { message: "Duēlis nav atrasts." });
    if (duel.status !== "active")
      return socket.emit("duel.error", { message: "Duēlis nav aktīvs." });

    const now = Date.now();
    if (duel.expiresAt && now >= duel.expiresAt) {
      finishDuel(duel, null, "timeout");
      socket.emit("duel.error", { message: "Duēļa laiks ir beidzies." });
      return;
    }

    if (!duel.players.includes(userName))
      return socket.emit("duel.error", { message: "Tu neesi šajā duelī." });
    if (rawGuess.length !== duel.len)
      return socket.emit("duel.error", {
        message: `Vārdam duelī jābūt ${duel.len} burtiem.`,
      });
    if (duel.attemptsLeft[userName] <= 0)
      return socket.emit("duel.error", {
        message: "Tev vairs nav mēģinājumu duelī.",
      });

    duel.rowsUsed[userName] = (duel.rowsUsed[userName] || 0) + 1;
    duel.attemptsLeft[userName] -= 1;

    const pattern = buildPattern(duel.word, rawGuess);
    const isWin = rawGuess === duel.word;

    if (isWin) {
      socket.emit("duel.guessResult", {
        duelId: duel.id,
        pattern,
        win: true,
        finished: true,
      });
      finishDuel(duel, userName, "win");
      return;
    }

    const finishedForPlayer = duel.attemptsLeft[userName] <= 0;

    socket.emit("duel.guessResult", {
      duelId: duel.id,
      pattern,
      win: false,
      finished: finishedForPlayer,
    });

    const [p1, p2] = duel.players;
    if (
      !duel.winner &&
      duel.attemptsLeft[p1] <= 0 &&
      duel.attemptsLeft[p2] <= 0
    ) {
      finishDuel(duel, null, "no_winner");
    }
  });

  // ======== DISCONNECT FIX (pret exploit pending duelī) ========
  socket.on("disconnect", () => {
    const username = user.username;

    const duelId = userToDuel.get(username);
    if (duelId) {
      const duel = duels.get(duelId);
      if (duel && duel.status !== "finished") {
        const other = duel.players.find((p) => p !== username);

        if (duel.status === "pending") {
          const sOther = getSocketByUsername(other);
          if (sOther) {
            sOther.emit("duel.end", {
              duelId: duel.id,
              winner: null,
              youWin: false,
              reason: "opponent_disconnect_pending",
            });
          }

          userToDuel.delete(duel.players[0]);
          userToDuel.delete(duel.players[1]);
          duels.delete(duel.id);
        } else {
          finishDuel(duel, other, "opponent_disconnect");
        }
      }
    }

    onlineBySocket.delete(socket.id);
    broadcastOnlineList(true);
    console.log("Atvienojās:", user.username, "socket:", socket.id);
  });
});

// ======== Globāls error handler (lai nekad nekrīt HTML Error page) ========
app.use((err, req, res, next) => {
  if (!err) return next();
  if (res.headersSent) return next(err);

  if (err.type === "entity.too.large" || err.status === 413) {
    return res.status(413).json({
      message:
        "Payload Too Large: pieprasījums ir par lielu. Samazini failu vai palielini limitus serverī.",
    });
  }

  console.error("UNHANDLED ERROR:", err);
  return res.status(500).json({ message: "Servera kļūda." });
});

// ======== Start ========
httpServer.listen(PORT, () => {
  console.log("VĀRDU ZONA serveris klausās portā", PORT);
});
