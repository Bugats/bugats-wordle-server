// ======== VĀRDU ZONA — Bugats edition ========
// Serveris ar login/signup, JWT, XP, RANKIEM (25 līmeņi),
// streak, coins, žetoniem, pasīvajiem coiniem ar Anti-AFK,
// TOP10, online sarakstu un čatu + ADMIN komandām + MISIJĀM.

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

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
const ADMIN_USERNAMES = ["BugatsLV"];

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

// ======== Failu helperi ========
function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  try {
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    if (!raw.trim()) return {};
    const arr = JSON.parse(raw);
    const out = {};
    for (const u of arr) {
      if (!u || !u.username) continue;

      if (typeof u.isBanned !== "boolean") u.isBanned = false;
      if (typeof u.mutedUntil !== "number") u.mutedUntil = 0;
      if (!u.lastActionAt) u.lastActionAt = Date.now();
      if (!u.lastPassiveTickAt) u.lastPassiveTickAt = u.lastActionAt;
      if (typeof u.bestStreak !== "number") u.bestStreak = 0;

      if (typeof u.missionsDate !== "string") u.missionsDate = "";
      if (!Array.isArray(u.missions)) u.missions = [];

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
    .map((w) => w.trim())
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

function getTokenPrice(user) {
  const tokens = user.tokens || 0;
  return BASE_TOKEN_PRICE + tokens * 50;
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

// ======== JWT helperi ========
function buildMePayload(u) {
  const rankInfo = calcRankFromXp(u.xp || 0);
  u.rankLevel = rankInfo.level;
  u.rankTitle = rankInfo.title;
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
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// ======== ONLINE saraksts ========
// socket.id -> username
const onlineBySocket = new Map();

// Vienkārša ONLINE loģika – visi aktīvie socketi
function broadcastOnlineList() {
  const users = Array.from(new Set(onlineBySocket.values()));
  io.emit("onlineList", { count: users.length, users });
}

// Periodiski pārsūtām online sarakstu
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

    default:
      adminSocket.emit("chatMessage", {
        username: "SYSTEM",
        text:
          "Nezināma komanda. Pieejams: /kick, /ban, /unban, /mute <min>, /unmute.",
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
  };

  const rankInfo = calcRankFromXp(user.xp);
  user.rankLevel = rankInfo.level;
  user.rankTitle = rankInfo.title;

  ensureDailyMissions(user);

  USERS[name] = user;
  saveUsers(USERS);

  const token = jwt.sign({ username: name }, JWT_SECRET, { expiresIn: "30d" });
  return res.json({
    ...buildMePayload(user),
    token,
  });
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
  saveUsers(USERS);

  const token = jwt.sign({ username: name }, JWT_SECRET, { expiresIn: "30d" });
  return res.json({
    ...buildMePayload(user),
    token,
  });
}

app.post("/login", loginHandler);
app.post("/signin", loginHandler);

app.get("/me", authMiddleware, (req, res) => {
  const u = req.user;
  markActivity(u);
  ensureDailyMissions(u);
  saveUsers(USERS);
  res.json(buildMePayload(u));
});

// Publiska profila API
app.get("/player/:username", authMiddleware, (req, res) => {
  const requester = req.user;
  const name = String(req.params.username || "").trim();
  const user = USERS[name];

  if (!user) {
    return res.status(404).json({ message: "Lietotājs nav atrasts" });
  }

  const isAdmin = ADMIN_USERNAMES.includes(requester.username);

  const rankInfo = calcRankFromXp(user.xp || 0);
  user.rankLevel = rankInfo.level;
  user.rankTitle = rankInfo.title;

  const payload = {
    username: user.username,
    xp: user.xp || 0,
    score: user.score || 0,
    coins: user.coins || 0,
    tokens: user.tokens || 0,
    streak: user.streak || 0,
    bestStreak: user.bestStreak || 0,
    rankTitle: user.rankTitle,
    rankLevel: user.rankLevel,
  };

  if (isAdmin) {
    payload.isBanned = !!user.isBanned;
    payload.mutedUntil = user.mutedUntil || 0;
  }

  res.json(payload);
});

// ======== MISIJU ENDPOINTI ========
app.get("/missions", authMiddleware, (req, res) => {
  const user = req.user;
  markActivity(user);
  ensureDailyMissions(user);
  saveUsers(USERS);
  res.json(getPublicMissions(user));
});

app.post("/missions/claim", authMiddleware, (req, res) => {
  const user = req.user;
  const { id } = req.body || {};
  if (!id) {
    return res.status(400).json({ message: "Nav norādīts misijas ID" });
  }

  markActivity(user);
  ensureDailyMissions(user);

  const mission = (user.missions || []).find((m) => m.id === id);
  if (!mission) {
    return res.status(404).json({ message: "Misija nav atrasta" });
  }
  if (!mission.isCompleted) {
    return res.status(400).json({ message: "Misija vēl nav pabeigta" });
  }
  if (mission.isClaimed) {
    return res.status(400).json({ message: "Balva jau saņemta" });
  }

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

  res.json({
    me: buildMePayload(user),
    missions: getPublicMissions(user),
  });
});

// ======== Spēles loģika ========
function pickRandomWord() {
  if (!WORDS.length) {
    return { word: "BUGAT", len: 5 };
  }
  const idx = Math.floor(Math.random() * WORDS.length);
  const w = WORDS[idx].trim();
  return { word: w.toUpperCase(), len: w.length };
}

app.get("/start-round", authMiddleware, (req, res) => {
  const user = req.user;
  markActivity(user);
  ensureDailyMissions(user);

  const { word, len } = pickRandomWord();
  user.currentRound = {
    word,
    len,
    attemptsLeft: MAX_ATTEMPTS,
    finished: false,
  };

  saveUsers(USERS);
  res.json({ len });
});

function buildPattern(secret, guess) {
  const sArr = secret.split("");
  const gArr = guess.split("");
  const result = new Array(gArr.length).fill("absent");
  const counts = {};
  for (const ch of sArr) {
    counts[ch] = (counts[ch] || 0) + 1;
  }
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
    return res
      .status(400)
      .json({ message: `Vārdam jābūt ${round.len} burtiem` });
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

    xpGain = XP_PER_WIN_BASE;
    const extraLetters = Math.max(0, len - MIN_WORD_LEN);
    xpGain += XP_PER_LETTER_BONUS * extraLetters;

    const streakSteps = Math.min(user.streak - 1, XP_STREAK_MAX_STEPS);
    if (streakSteps > 0) {
      xpGain += XP_PER_STREAK_STEP * streakSteps;
    }

    coinsGain = COINS_PER_WIN_BASE;
    coinsGain += COINS_PER_LETTER_BONUS * extraLetters;

    const coinStreakBonus = Math.min(user.streak - 1, COINS_STREAK_MAX_BONUS);
    if (coinStreakBonus > 0) {
      coinsGain += coinStreakBonus;
    }

    user.xp = (user.xp || 0) + xpGain;
    user.score = (user.score || 0) + SCORE_PER_WIN;
    user.coins = (user.coins || 0) + coinsGain;

    user.bestStreak = Math.max(user.bestStreak || 0, user.streak || 0);

    round.finished = true;

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
    if (finished) {
      user.streak = 0;
    }
  }

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

  io.emit("tokenBuy", {
    username: user.username,
    tokens: user.tokens || 0,
  });

  res.json({
    coins: user.coins,
    tokens: user.tokens,
    tokenPriceCoins: getTokenPrice(user),
  });
});

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
  }));
  res.json(top);
});

// ======== Socket.IO ========
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
  saveUsers(USERS);

  onlineBySocket.set(socket.id, user.username);
  broadcastOnlineList();

  socket.on("chatMessage", (text) => {
    if (typeof text !== "string") return;
    const msg = text.trim();
    if (!msg) return;

    const u = USERS[user.username] || user;
    markActivity(u);
    ensureDailyMissions(u);

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

    const isAdmin = ADMIN_USERNAMES.includes(u.username);
    if (isAdmin && msg.startsWith("/")) {
      handleAdminCommand(msg, u, socket);
      return;
    }

    saveUsers(USERS);

    const payload = {
      username: u.username,
      text: msg,
      ts: Date.now(),
    };
    io.emit("chatMessage", payload);
  });

  socket.on("disconnect", () => {
    onlineBySocket.delete(socket.id);
    broadcastOnlineList();
    console.log("Atvienojās:", user.username, "socket:", socket.id);
  });
});
// ===== DIENAS LOGIN BONUSS (coins par katru dienu) =====

// Cik coins par vienu pieslēgšanās dienu
const DAILY_LOGIN_COINS = 10;

/**
 * Piešķir dienas login bonusu, ja lietotājs šodien vēl nav saņēmis.
 * Atgriež piešķirto coins daudzumu vai 0.
 */
function grantDailyLoginBonus(user) {
  if (!user) return 0;

  // todayKey() jau ir definēta augstāk (tiek lietota misijām)
  const today = todayKey();

  // Ja jau šodien bonuss piešķirts – neko nedodam
  if (user.dailyLoginDate === today) {
    return 0;
  }

  // Saglabājam, ka šodien bonuss saņemts
  user.dailyLoginDate = today;

  const bonus = DAILY_LOGIN_COINS;
  user.coins = (user.coins || 0) + bonus;

  saveUsers(USERS);
  return bonus;
}

// Papildu Socket.IO "connection" handleris – strādā kopā ar esošo
io.on("connection", (socket) => {
  const user = socket.data.user;
  if (!user) return;

  const bonus = grantDailyLoginBonus(user);
  if (bonus > 0) {
    // Ziņa tikai šim spēlētājam
    socket.emit("chatMessage", {
      username: "SYSTEM",
      text: `Dienas ienākšanas bonuss: +${bonus} coins!`,
      ts: Date.now(),
    });
  }
});
// ===== OVERRIDE: žetona cena fiksēta 150 coins =====
// Šis pārraksta iepriekš definēto getTokenPrice,
// lai žetons VIENMĒR maksātu 150 coins.
function getTokenPrice(user) {
  return 150;
}
// ======== Start ========
httpServer.listen(PORT, () => {
  console.log("VĀRDU ZONA serveris klausās portā", PORT);
});
