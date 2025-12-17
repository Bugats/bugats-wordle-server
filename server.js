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

const MIN_WORD_LEN = 5;
const MAX_WORD_LEN = 7;
const MAX_ATTEMPTS = 6;

const BASE_TOKEN_PRICE = 150;

// Admin lietotāji
const ADMIN_USERNAMES = ["Bugats", "BugatsLV"];

// ======== SEZONA 1 – servera stāvoklis ========
// Latvia ziemā ir UTC+2, tāpēc +02:00 ir korekti.
const SEASON1_END_AT = new Date("2025-12-26T23:59:59+02:00").getTime();

let seasonState = {
  id: 1,
  name: "SEZONA 1",
  active: false,
  startedAt: 0,
  endAt: SEASON1_END_AT,
};

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

// ======== Failu helperi ========
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
  fs.writeFileSync(USERS_FILE, JSON.stringify(arr, null, 2), "utf8");
}

let USERS = loadUsers();

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

function getTokenPrice() {
  return BASE_TOKEN_PRICE;
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
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

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
  if (topScore.max > 0 && topScore.winners.length === 1 && topScore.winners[0] === targetUser.username) {
    medals.push({ code: "TOP_SCORE", icon: "🏆", label: "TOP punktos" });
  }

  const topBestStreak = bestByField("bestStreak");
  if (topBestStreak.max > 0 && topBestStreak.winners.length === 1 && topBestStreak.winners[0] === targetUser.username) {
    medals.push({ code: "BEST_STREAK", icon: "🔥", label: "Garākais streak" });
  }

  const fastWin = bestMinTime("bestWinTimeMs");
  if (fastWin.best < Infinity && fastWin.winners.length === 1 && fastWin.winners[0] === targetUser.username) {
    medals.push({ code: "FAST_WIN", icon: "⚡", label: "Ātrākais vārds" });
  }

  const marathon = bestByField("totalGuesses");
  if (marathon.max > 0 && marathon.winners.length === 1 && marathon.winners[0] === targetUser.username) {
    medals.push({ code: "MARATHON", icon: "⏱️", label: "Maratona spēlētājs" });
  }

  const dailyChamp = bestByField("winsToday", (u) => u.winsTodayDate === today);
  if (dailyChamp.max > 0 && dailyChamp.winners.length === 1 && dailyChamp.winners[0] === targetUser.username) {
    medals.push({ code: "DAILY_CHAMP", icon: "👑", label: "Šodienas čempions" });
  }

  const topXp = bestByField("xp");
  if (topXp.max > 0 && topXp.winners.length === 1 && topXp.winners[0] === targetUser.username) {
    medals.push({ code: "XP_KING", icon: "🧠", label: "XP līderis" });
  }

  const coinKing = bestByField("coins");
  if (coinKing.max > 0 && coinKing.winners.length === 1 && coinKing.winners[0] === targetUser.username) {
    medals.push({ code: "COIN_KING", icon: "💰", label: "Naudas maiss" });
  }

  const tokenKing = bestByField("tokens");
  if (tokenKing.max > 0 && tokenKing.winners.length === 1 && tokenKing.winners[0] === targetUser.username) {
    medals.push({ code: "TOKEN_KING", icon: "🎟️", label: "Žetonu karalis" });
  }

  return medals;
}

// ======== JWT helperi ========
function buildMePayload(u) {
  const rankInfo = calcRankFromXp(u.xp || 0);
  u.rankLevel = rankInfo.level;
  u.rankTitle = rankInfo.title;

  const medals = computeMedalsForUser(u);

  return {
    username: u.username,
    xp: u.xp || 0,
    score: u.score || 0,
    coins: u.coins || 0,
    tokens: u.tokens || 0,
    streak: u.streak || 0,
    bestStreak: u.bestStreak || 0,
    rankTitle: u.rankTitle,
    rankLevel: u.rankLevel,
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
      return res.status(403).json({ message: "Lietotājs ir nobanots no VĀRDU ZONAS." });
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
app.use(express.json());

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

function broadcastOnlineList() {
  const uniq = Array.from(new Set(onlineBySocket.values()));
  const users = uniq.map((username) => ({
    username,
    avatarUrl: getAvatarByUsername(username),
  }));
  io.emit("onlineList", { count: users.length, users });
}

setInterval(() => {
  broadcastOnlineList();
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
  for (const [sid, uname] of onlineBySocket.entries()) {
    if (uname === username) {
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
  }
  broadcastOnlineList();
}

function handleAdminCommand(raw, adminUser, adminSocket) {
  const parts = raw.slice(1).trim().split(/\s+/);
  const cmd = (parts[0] || "").toLowerCase();
  const targetName = parts[1];
  const arg = parts[2];

  if (!cmd) {
    adminSocket.emit("chatMessage", { username: "SYSTEM", text: "Komanda nav norādīta.", ts: Date.now() });
    return;
  }

  if (["ban", "unban", "kick", "mute", "unmute"].includes(cmd) && !targetName) {
    adminSocket.emit("chatMessage", { username: "SYSTEM", text: "Norādi lietotājvārdu. Piem.: /kick Nick", ts: Date.now() });
    return;
  }

  const target = targetName ? USERS[targetName] : null;

  switch (cmd) {
    case "kick":
      if (!target) {
        adminSocket.emit("chatMessage", { username: "SYSTEM", text: `Lietotājs '${targetName}' nav atrasts.`, ts: Date.now() });
        return;
      }
      kickUserByName(targetName, "kick");
      broadcastSystemMessage(`Admin ${adminUser.username} izmeta lietotāju ${targetName}.`);
      break;

    case "ban":
      if (!target) {
        adminSocket.emit("chatMessage", { username: "SYSTEM", text: `Lietotājs '${targetName}' nav atrasts.`, ts: Date.now() });
        return;
      }
      target.isBanned = true;
      saveUsers(USERS);
      kickUserByName(targetName, "ban");
      broadcastSystemMessage(`Admin ${adminUser.username} nobanoja lietotāju ${targetName}.`);
      break;

    case "unban":
      if (!target) {
        adminSocket.emit("chatMessage", { username: "SYSTEM", text: `Lietotājs '${targetName}' nav atrasts.`, ts: Date.now() });
        return;
      }
      target.isBanned = false;
      saveUsers(USERS);
      broadcastSystemMessage(`Admin ${adminUser.username} atbanoja lietotāju ${targetName}.`);
      break;

    case "mute": {
      if (!target) {
        adminSocket.emit("chatMessage", { username: "SYSTEM", text: `Lietotājs '${targetName}' nav atrasts.`, ts: Date.now() });
        return;
      }
      const minutes = parseInt(arg || "5", 10);
      const mins = Number.isNaN(minutes) ? 5 : Math.max(1, minutes);
      target.mutedUntil = Date.now() + mins * 60 * 1000;
      saveUsers(USERS);
      broadcastSystemMessage(`Admin ${adminUser.username} uzlika mute lietotājam ${targetName} uz ${mins} min.`);
      break;
    }

    case "unmute":
      if (!target) {
        adminSocket.emit("chatMessage", { username: "SYSTEM", text: `Lietotājs '${targetName}' nav atrasts.`, ts: Date.now() });
        return;
      }
      target.mutedUntil = 0;
      saveUsers(USERS);
      broadcastSystemMessage(`Admin ${adminUser.username} noņēma mute lietotājam ${targetName}.`);
      break;

    case "seasonstart": {
      if (!ADMIN_USERNAMES.includes(adminUser.username)) {
        adminSocket.emit("chatMessage", { username: "SYSTEM", text: "Tikai admins var startēt sezonu.", ts: Date.now() });
        return;
      }

      const now = Date.now();
      if (seasonState.endAt && now >= seasonState.endAt) {
        const endStr = new Date(seasonState.endAt).toLocaleString("lv-LV", { timeZone: "Europe/Riga" });
        adminSocket.emit("chatMessage", { username: "SYSTEM", text: `${seasonState.name} vairs nevar startēt — sezona beidzās ${endStr}.`, ts: Date.now() });
        return;
      }

      if (seasonState.active) {
        adminSocket.emit("chatMessage", { username: "SYSTEM", text: `${seasonState.name} jau ir aktīva.`, ts: Date.now() });
        return;
      }

      seasonState.active = true;
      seasonState.startedAt = Date.now();

      broadcastSystemMessage(`📢 ${seasonState.name} ir sākusies! Līdz 26. decembrim krāj žetonus laimes ratam.`);
      io.emit("seasonUpdate", seasonState);

      adminSocket.emit("chatMessage", { username: "SYSTEM", text: `${seasonState.name} ir startēta.`, ts: Date.now() });
      break;
    }

    case "seasononline": {
      const now = Date.now();
      const endTs = seasonState.endAt || 0;
      let text;

      if (!seasonState.active) {
        if (!endTs) {
          text = `${seasonState.name} vēl nav sākusies. Beigu datums nav iestatīts.`;
        } else {
          const endStr = new Date(endTs).toLocaleString("lv-LV", { timeZone: "Europe/Riga" });
          text = `${seasonState.name} vēl nav sākusies. Plānotās beigas: ${endStr}.`;
        }
      } else if (!endTs) {
        text = `${seasonState.name} ir aktīva, bet beigu datums nav iestatīts.`;
      } else if (now >= endTs) {
        const endStr = new Date(endTs).toLocaleString("lv-LV", { timeZone: "Europe/Riga" });
        text = `${seasonState.name} jau ir beigusies (beidzās ${endStr}).`;
      } else {
        const diffMs = endTs - now;
        const totalSec = Math.floor(diffMs / 1000);
        const days = Math.floor(totalSec / (24 * 3600));
        const hours = Math.floor((totalSec % (24 * 3600)) / 3600);
        const mins = Math.floor((totalSec % 3600) / 60);
        const secs = totalSec % 60;

        const endStr = new Date(endTs).toLocaleString("lv-LV", { timeZone: "Europe/Riga" });

        text = `${seasonState.name} ir aktīva. Līdz sezonas beigām: ${days}d ${hours}h ${mins}m ${secs}s (līdz ${endStr}).`;
      }

      adminSocket.emit("chatMessage", { username: "SYSTEM", text, ts: Date.now() });
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
    return res.status(400).json({ message: "Nepieciešams username un password" });
  }

  const name = String(username).trim();
  if (!/^[a-zA-Z0-9_\-]{3,20}$/.test(name)) {
    return res.status(400).json({ message: "Nickname: 3-20 simboli, tikai burti/cipari/ - _" });
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
  };

  const rankInfo = calcRankFromXp(user.xp);
  user.rankLevel = rankInfo.level;
  user.rankTitle = rankInfo.title;

  ensureDailyMissions(user);

  USERS[name] = user;
  saveUsers(USERS);

  const token = jwt.sign({ username: name }, JWT_SECRET, { expiresIn: "30d" });
  return res.json({ ...buildMePayload(user), token });
}

app.post("/signup", signupHandler);

async function loginHandler(req, res) {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ message: "Nepieciešams username un password" });
  }

  const name = String(username).trim();
  const user = USERS[name];
  if (!user) {
    return res.status(400).json({ message: "Lietotājs nav atrasts" });
  }

  if (user.isBanned) {
    return res.status(403).json({ message: "Šis lietotājs ir nobanots no VĀRDU ZONAS. Sazinies ar Bugats." });
  }

  const ok = await bcrypt.compare(password, user.passwordHash || "");
  if (!ok) {
    return res.status(400).json({ message: "Nepareiza parole" });
  }

  markActivity(user);
  ensureDailyMissions(user);
  resetWinsTodayIfNeeded(user);
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

    const MAX_LEN = 3 * 1024 * 1024;
    if (avatar.length > MAX_LEN) {
      return res.status(400).json({ message: "Avatārs ir par lielu (samazini bildi līdz ~2MB)." });
    }

    user.avatarUrl = avatar;
    saveUsers(USERS);

    // uzreiz atjaunojam online listu, lai citi redz jauno avataru
    broadcastOnlineList();

    return res.json({ ok: true, avatarUrl: user.avatarUrl });
  } catch (err) {
    console.error("POST /avatar kļūda:", err);
    return res.status(500).json({ message: "Servera kļūda avatāra saglabāšanā." });
  }
});

// ======== Publiska profila API ========
function buildPublicProfilePayload(targetUser, requester) {
  const rankInfo = calcRankFromXp(targetUser.xp || 0);
  targetUser.rankLevel = rankInfo.level;
  targetUser.rankTitle = rankInfo.title;

  const isAdmin = requester && ADMIN_USERNAMES.includes(requester.username);

  const payload = {
    username: targetUser.username,
    xp: targetUser.xp || 0,
    score: targetUser.score || 0,
    coins: targetUser.coins || 0,
    tokens: targetUser.tokens || 0,
    streak: targetUser.streak || 0,
    bestStreak: targetUser.bestStreak || 0,
    rankTitle: targetUser.rankTitle,
    rankLevel: targetUser.rankLevel,
    medals: computeMedalsForUser(targetUser),
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
  saveUsers(USERS);
  res.json(getPublicMissions(user));
});

app.post("/missions/claim", authMiddleware, (req, res) => {
  const user = req.user;
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ message: "Nav norādīts misijas ID" });

  markActivity(user);
  ensureDailyMissions(user);

  const mission = (user.missions || []).find((m) => m.id === id);
  if (!mission) return res.status(404).json({ message: "Misija nav atrasta" });
  if (!mission.isCompleted) return res.status(400).json({ message: "Misija vēl nav pabeigta" });
  if (mission.isClaimed) return res.status(400).json({ message: "Balva jau saņemta" });

  const rw = mission.rewards || {};
  const addXp = rw.xp || 0;
  const addCoins = rw.coins || 0;
  const addTokens = rw.tokens || 0;

  user.xp = (user.xp || 0) + addXp;
  user.coins = (user.coins || 0) + addCoins;
  user.tokens = (user.tokens || 0) + addTokens;

  mission.isClaimed = true;

  const rankInfo = calcRankFromXp(user.xp);
  user.rankLevel = rankInfo.level;
  user.rankTitle = rankInfo.title;

  saveUsers(USERS);

  res.json({ me: buildMePayload(user), missions: getPublicMissions(user) });
});

// ======== SEZONA API ========
app.get("/season", authMiddleware, (req, res) => {
  res.json(seasonState);
});

app.post("/season/start", authMiddleware, (req, res) => {
  const user = req.user;
  if (!ADMIN_USERNAMES.includes(user.username)) {
    return res.status(403).json({ message: "Tikai admins var startēt sezonu." });
  }

  const now = Date.now();
  if (seasonState.endAt && now >= seasonState.endAt) {
    const endStr = new Date(seasonState.endAt).toLocaleString("lv-LV", { timeZone: "Europe/Riga" });
    return res.status(400).json({ message: `${seasonState.name} vairs nevar startēt — sezona beidzās ${endStr}.` });
  }

  if (!seasonState.active) {
    seasonState.active = true;
    seasonState.startedAt = Date.now();

    broadcastSystemMessage(`📢 ${seasonState.name} ir sākusies! Līdz 26. decembrim krāj žetonus laimes ratam.`);
    io.emit("seasonUpdate", seasonState);
  }

  res.json(seasonState);
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

    const rankInfo = calcRankFromXp(user.xp);
    user.rankLevel = rankInfo.level;
    user.rankTitle = rankInfo.title;

    io.emit("playerWin", {
      username: user.username,
      xpGain,
      coinsGain,
      rankTitle: user.rankTitle,
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

// ===== Leaderboard (ar avatarUrl) =====
app.get("/leaderboard", (req, res) => {
  const arr = Object.values(USERS);
  arr.forEach((u) => {
    const info = calcRankFromXp(u.xp || 0);
    u.rankLevel = info.level;
    u.rankTitle = info.title;
  });

  arr.sort((a, b) => (b.score || 0) - (a.score || 0));

  const top = arr.slice(0, 10).map((u, idx) => ({
    place: idx + 1,
    username: u.username,
    score: u.score || 0,
    xp: u.xp || 0,
    rankTitle: u.rankTitle,
    avatarUrl: u.avatarUrl || null,
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
      const info = calcRankFromXp(winner.xp);
      winner.rankLevel = info.level;
      winner.rankTitle = info.title;
    }
    if (loser) {
      loser.duelsLost = (loser.duelsLost || 0) + 1;
    }

    saveUsers(USERS);

    if (s1) s1.emit("duel.end", { duelId: duel.id, winner: winnerName, youWin: winnerName === p1, reason });
    if (s2) s2.emit("duel.end", { duelId: duel.id, winner: winnerName, youWin: winnerName === p2, reason });

    const other = winnerName === p1 ? p2 : p1;
    broadcastSystemMessage(`⚔️ ${winnerName} uzvarēja dueli pret ${other}!`);
  } else {
    if (s1) s1.emit("duel.end", { duelId: duel.id, winner: null, youWin: false, reason });
    if (s2) s2.emit("duel.end", { duelId: duel.id, winner: null, youWin: false, reason });
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

// ===== SEZONAS AUTO-BEIGAS (lai pats izslēdzas) =====
let seasonEndedBroadcasted = false;
setInterval(() => {
  const now = Date.now();
  if (seasonState.endAt && now >= seasonState.endAt) {
    if (seasonState.active) {
      seasonState.active = false;
      seasonState.startedAt = seasonState.startedAt || 0;
      seasonEndedBroadcasted = false; // ļaujam vienu paziņojumu
      io.emit("seasonUpdate", seasonState);
    }
    if (!seasonEndedBroadcasted) {
      const endStr = new Date(seasonState.endAt).toLocaleString("lv-LV", { timeZone: "Europe/Riga" });
      broadcastSystemMessage(`⏳ ${seasonState.name} ir beigusies (${endStr}).`);
      io.emit("seasonUpdate", seasonState);
      seasonEndedBroadcasted = true;
    }
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
  broadcastOnlineList();

  socket.emit("seasonUpdate", seasonState);

  // ========== ČATS ==========
  socket.on("chatMessage", (text) => {
    if (typeof text !== "string") return;
    const msg = text.trim();
    if (!msg) return;

    const u = USERS[user.username] || user;
    markActivity(u);
    ensureDailyMissions(u);

    const now = Date.now();

    if (u.isBanned) {
      socket.emit("chatMessage", { username: "SYSTEM", text: "Tu esi nobanots no VĀRDU ZONAS.", ts: Date.now() });
      return;
    }

    if (u.mutedUntil && u.mutedUntil > now) {
      const until = new Date(u.mutedUntil).toLocaleTimeString("lv-LV", { hour: "2-digit", minute: "2-digit" });
      socket.emit("chatMessage", { username: "SYSTEM", text: `Tev ir mute līdz ${until}.`, ts: Date.now() });
      return;
    }

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
    });
  });

  // ========== DUEĻI ==========
  socket.on("duel.challenge", (targetNameRaw) => {
    const challenger = socket.data.user;
    const challengerName = challenger.username;
    const targetName = String(targetNameRaw || "").trim();

    if (!targetName) return socket.emit("duel.error", { message: "Nav norādīts pretinieks." });
    if (targetName === challengerName) return socket.emit("duel.error", { message: "Nevari izaicināt sevi." });

    const targetUser = USERS[targetName];
    if (!targetUser) return socket.emit("duel.error", { message: "Lietotājs nav atrasts." });

    if (userToDuel.has(challengerName)) return socket.emit("duel.error", { message: "Tu jau esi citā duelī." });
    if (userToDuel.has(targetName)) return socket.emit("duel.error", { message: "Pretinieks jau ir citā duelī." });

    const targetSocket = getSocketByUsername(targetName);
    if (!targetSocket) return socket.emit("duel.error", { message: "Pretinieks nav tiešsaistē." });

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
      attemptsLeft: { [challengerName]: DUEL_MAX_ATTEMPTS, [targetName]: DUEL_MAX_ATTEMPTS },
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
    if (!duel) return socket.emit("duel.error", { message: "Duēlis nav atrasts." });
    if (!duel.players.includes(userName)) return socket.emit("duel.error", { message: "Tu neesi šajā duelī." });
    if (duel.status !== "pending") return socket.emit("duel.error", { message: "Duēlis jau ir sācies." });

    duel.status = "active";
    duel.startedAt = Date.now();
    duel.expiresAt = duel.startedAt + DUEL_MAX_DURATION_MS;

    const [p1, p2] = duel.players;
    const s1 = getSocketByUsername(p1);
    const s2 = getSocketByUsername(p2);

    if (s1) s1.emit("duel.start", { duelId: duel.id, len: duel.len, opponent: p2, expiresAt: duel.expiresAt });
    if (s2) s2.emit("duel.start", { duelId: duel.id, len: duel.len, opponent: p1, expiresAt: duel.expiresAt });

    broadcastSystemMessage(`⚔️ Duēlis sākas: ${p1} vs ${p2}! Kurš pirmais atminēs vārdu?`);
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
    if (sOther) sOther.emit("duel.end", { duelId: duel.id, winner: null, youWin: false, reason: "declined" });
    socket.emit("duel.end", { duelId: duel.id, winner: null, youWin: false, reason: "declined" });

    userToDuel.delete(p1);
    userToDuel.delete(p2);
    duels.delete(duel.id);
  });

  socket.on("duel.guess", (payload) => {
    const duelId = payload?.duelId;
    const rawGuess = (payload?.guess || "").toString().trim().toUpperCase();
    const userName = socket.data.user.username;

    const duel = duels.get(duelId);
    if (!duel) return socket.emit("duel.error", { message: "Duēlis nav atrasts." });
    if (duel.status !== "active") return socket.emit("duel.error", { message: "Duēlis nav aktīvs." });

    const now = Date.now();
    if (duel.expiresAt && now >= duel.expiresAt) {
      finishDuel(duel, null, "timeout");
      socket.emit("duel.error", { message: "Duēļa laiks ir beidzies." });
      return;
    }

    if (!duel.players.includes(userName)) return socket.emit("duel.error", { message: "Tu neesi šajā duelī." });
    if (rawGuess.length !== duel.len) return socket.emit("duel.error", { message: `Vārdam duelī jābūt ${duel.len} burtiem.` });
    if (duel.attemptsLeft[userName] <= 0) return socket.emit("duel.error", { message: "Tev vairs nav mēģinājumu duelī." });

    duel.rowsUsed[userName] = (duel.rowsUsed[userName] || 0) + 1;
    duel.attemptsLeft[userName] -= 1;

    const pattern = buildPattern(duel.word, rawGuess);
    const isWin = rawGuess === duel.word;

    if (isWin) {
      socket.emit("duel.guessResult", { duelId: duel.id, pattern, win: true, finished: true });
      finishDuel(duel, userName, "win");
      return;
    }

    const finishedForPlayer = duel.attemptsLeft[userName] <= 0;

    socket.emit("duel.guessResult", { duelId: duel.id, pattern, win: false, finished: finishedForPlayer });

    const [p1, p2] = duel.players;
    if (!duel.winner && duel.attemptsLeft[p1] <= 0 && duel.attemptsLeft[p2] <= 0) {
      finishDuel(duel, null, "no_winner");
    }
  });

  socket.on("disconnect", () => {
    const username = user.username;

    const duelId = userToDuel.get(username);
    if (duelId) {
      const duel = duels.get(duelId);
      if (duel && duel.status !== "finished") {
        const other = duel.players.find((p) => p !== username);
        finishDuel(duel, other, "opponent_disconnect");
      }
    }

    onlineBySocket.delete(socket.id);
    broadcastOnlineList();
    console.log("Atvienojās:", user.username, "socket:", socket.id);
  });
});

// ======== Start ========
httpServer.listen(PORT, () => {
  console.log("VĀRDU ZONA serveris klausās portā", PORT);
});
