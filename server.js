// ======== VĀRDU ZONA — Bugats edition ========
// Serveris ar login/signup, JWT, XP, RANKIEM (25 līmeņi),
// streak, coins, žetoniem, pasīvajiem coiniem ar Anti-AFK,
// TOP10, online sarakstu un čatu.

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs"; // IMPORTANT: bcryptjs
import jwt from "jsonwebtoken";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ======== Konstantes ========
const PORT = process.env.PORT || 10080;
const JWT_SECRET =
  process.env.JWT_SECRET || "BUGATS_VARDU_ZONA_SUPER_SLEPENS_JWT";

const USERS_FILE = path.join(__dirname, "users.json");
const WORDS_FILE = path.join(__dirname, "words.txt");

const MIN_WORD_LEN = 5;
const MAX_WORD_LEN = 7;
const MAX_ATTEMPTS = 6;

const BASE_TOKEN_PRICE = 150;

// ========== XP / COINS EKONOMIKA (HARD GRIND) ==========

// XP bāze par uzvaru (mazāka nekā iepriekš)
const XP_PER_WIN_BASE = 8;        // bija 12
const SCORE_PER_WIN = 1;

// Bonuss par garākiem vārdiem (6 un 7 burti) – mazāks
const XP_PER_LETTER_BONUS = 1;    // bija 2

// Streak bonuss (XP) – limitēts
const XP_PER_STREAK_STEP = 1;
const XP_STREAK_MAX_STEPS = 3;    // max +3 XP no streak, nevis +5

// Coins bāze un bonusi – tuvāk oriģinālajam
const COINS_PER_WIN_BASE = 3;     // bija 4
const COINS_PER_LETTER_BONUS = 0; // vairs nav bonusa par garāku vārdu
const COINS_STREAK_MAX_BONUS = 2; // max +2 coins no streak

// ========== Pasīvie coini + Anti-AFK ==========
const PASSIVE_COINS_PER_TICK = 2; // cik coins par aktīvu periodu
const PASSIVE_INTERVAL_MS = 20 * 60 * 1000; // 20 min
const AFK_BREAK_MS = 3 * 60 * 1000; // >3 min bez aktivitātes = AFK reset

// ======== Failu helperi ========
function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  try {
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    if (!raw.trim()) return {};
    const arr = JSON.parse(raw);
    const out = {};
    for (const u of arr) {
      if (u.username) out[u.username] = u;
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
    if (currentXp >= r.minXp) {
      current = r;
    } else {
      break;
    }
  }

  const level = table.indexOf(current) + 1;
  return {
    level,
    title: current.title,
  };
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

  // ja > AFK_BREAK_MS kopš pēdējās aktivitātes → uzskatām, ka bija AFK, resetējam periodu
  if (now - user.lastActionAt > AFK_BREAK_MS) {
    user.lastActionAt = now;
    user.lastPassiveTickAt = now;
    return;
  }

  // normāla aktivitāte
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

// ======== JWT helperis ========
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ message: "Nav token" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = USERS[payload.username];
    if (!user) return res.status(401).json({ message: "Lietotājs nav atrasts" });
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

function broadcastOnlineList() {
  const now = Date.now();
  const activeUsers = new Set();

  for (const username of onlineBySocket.values()) {
    const u = USERS[username];
    if (!u) continue;

    const last = u.lastActionAt || 0;
    // "Online" tikai, ja pēdējā aktivitāte nav vecāka par ONLINE_TIMEOUT_MS
    if (now - last <= ONLINE_TIMEOUT_MS) {
      activeUsers.add(username);
    }
  }

  const users = Array.from(activeUsers);
  io.emit("onlineList", { count: users.length, users });
}

// Regulāri pārskaitām online sarakstu,
// lai AFK spēlētāji pēc ~2 min automātiski pazūd no online skaita
setInterval(() => {
  broadcastOnlineList();
}, 30 * 1000); // ik pēc 30 sekundēm

// ======== AUTH ENDPOINTI ========

// Kopējais signup handleris (reģistrācija)
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
  };

  const rankInfo = calcRankFromXp(user.xp);
  user.rankLevel = rankInfo.level;
  user.rankTitle = rankInfo.title;

  USERS[name] = user;
  saveUsers(USERS);

  const token = jwt.sign({ username: name }, JWT_SECRET, { expiresIn: "30d" });
  return res.json({
    token,
    username: name,
    xp: user.xp,
    score: user.score,
    coins: user.coins,
    tokens: user.tokens,
    streak: user.streak,
    bestStreak: user.bestStreak,
    rankTitle: user.rankTitle,
    rankLevel: user.rankLevel,
  });
}

// Jauns + vecais maršruts (abi dara to pašu)
app.post("/signup", signupHandler);
app.post("/signin", signupHandler);

// Login
app.post("/login", async (req, res) => {
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

  const ok = await bcrypt.compare(password, user.passwordHash || "");
  if (!ok) {
    return res.status(400).json({ message: "Nepareiza parole" });
  }

  markActivity(user);

  const rankInfo = calcRankFromXp(user.xp);
  user.rankLevel = rankInfo.level;
  user.rankTitle = rankInfo.title;
  saveUsers(USERS);

  const token = jwt.sign({ username: name }, JWT_SECRET, { expiresIn: "30d" });
  return res.json({
    token,
    username: name,
    xp: user.xp || 0,
    score: user.score || 0,
    coins: user.coins || 0,
    tokens: user.tokens || 0,
    streak: user.streak || 0,
    bestStreak: user.bestStreak || 0,
    rankTitle: user.rankTitle,
    rankLevel: user.rankLevel,
  });
});

// ======== /me ========
app.get("/me", authMiddleware, (req, res) => {
  const u = req.user;
  const rankInfo = calcRankFromXp(u.xp || 0);
  u.rankLevel = rankInfo.level;
  u.rankTitle = rankInfo.title;
  saveUsers(USERS);

  res.json({
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

// Jauns raunds
app.get("/start-round", authMiddleware, (req, res) => {
  const user = req.user;
  markActivity(user);

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

// Pattern priekš flīžu krāsām
function buildPattern(secret, guess) {
  const sArr = secret.split("");
  const gArr = guess.split("");
  const result = new Array(gArr.length).fill("absent");
  const counts = {};
  for (const ch of sArr) {
    counts[ch] = (counts[ch] || 0) + 1;
  }
  // correct
  for (let i = 0; i < gArr.length; i++) {
    if (gArr[i] === sArr[i]) {
      result[i] = "correct";
      counts[gArr[i]] -= 1;
    }
  }
  // present
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

// Minējums
app.post("/guess", authMiddleware, (req, res) => {
  const user = req.user;
  markActivity(user);

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
  let finished = isWin || round.attemptsLeft <= 0;

  let xpGain = 0;
  let coinsGain = 0;

  if (isWin) {
    // streak pirms šīs uzvaras
    const prevStreak = user.streak || 0;
    user.streak = prevStreak + 1;

    // ---- XP aprēķins ----
    xpGain = XP_PER_WIN_BASE;

    const extraLetters = Math.max(0, len - MIN_WORD_LEN); // MIN_WORD_LEN = 5
    xpGain += XP_PER_LETTER_BONUS * extraLetters;

    const streakSteps = Math.min(user.streak - 1, XP_STREAK_MAX_STEPS);
    if (streakSteps > 0) {
      xpGain += XP_PER_STREAK_STEP * streakSteps;
    }

    // ---- COINS aprēķins ----
    coinsGain = COINS_PER_WIN_BASE;

    coinsGain += COINS_PER_LETTER_BONUS * extraLetters;

    const coinStreakBonus = Math.min(user.streak - 1, COINS_STREAK_MAX_BONUS);
    if (coinStreakBonus > 0) {
      coinsGain += coinStreakBonus;
    }

    // XP / score / coins pieaugums
    user.xp = (user.xp || 0) + xpGain;
    user.score = (user.score || 0) + SCORE_PER_WIN;
    user.coins = (user.coins || 0) + coinsGain;

    // streak rekords
    user.bestStreak = Math.max(user.bestStreak || 0, user.streak || 0);

    round.finished = true;

    // rank atjaunošana
    const rankInfo = calcRankFromXp(user.xp);
    user.rankLevel = rankInfo.level;
    user.rankTitle = rankInfo.title;

    // paziņojums visiem
    io.emit("playerWin", {
      username: user.username,
      xpGain,
      coinsGain,
      rankTitle: user.rankTitle,
      streak: user.streak || 0,
    });
  } else {
    // minējums nav pareizs
    if (finished) {
      // raunds beidzies bez uzvaras → streak reset
      user.streak = 0;
    }
  }

  saveUsers(USERS);

  res.json({
    pattern,
    win: isWin,
    finished,
    attemptsLeft: round.attemptsLeft,
    rewards: isWin ? { xpGain, coinsGain } : null,
  });
});

// Žetona pirkšana
app.post("/buy-token", authMiddleware, (req, res) => {
  const user = req.user;
  markActivity(user);

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

// TOP10
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

  onlineBySocket.set(socket.id, user.username);
  broadcastOnlineList();

  console.log("Pieslēdzās:", user.username, "socket:", socket.id);

  markActivity(user);
  saveUsers(USERS);

  socket.on("chatMessage", (text) => {
    if (typeof text !== "string") return;
    const msg = text.trim();
    if (!msg) return;

    markActivity(user);
    saveUsers(USERS);

    const payload = {
      username: user.username,
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

// ======== Start ========
httpServer.listen(PORT, () => {
  console.log("VĀRDU ZONA serveris klausās portā", PORT);
});
