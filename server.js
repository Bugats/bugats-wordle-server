// ======== VĀRDU ZONA — Bugats edition ========
// Serveris ar login/signup, JWT, XP, rank, streak, coins, žetoniem,
// pasīvajiem coiniem ar Anti-AFK, TOP10, online sarakstu un čatu.

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ======== Konstantes ========
const PORT = process.env.PORT || 10080;
const JWT_SECRET = process.env.JWT_SECRET || "BUGATS_VARDU_ZONA_SUPER_SLEPENS_JWT";

const USERS_FILE = path.join(__dirname, "users.json");
const WORDS_FILE = path.join(__dirname, "words.txt");

const MIN_WORD_LEN = 5;
const MAX_WORD_LEN = 7;
const MAX_ATTEMPTS = 6;

const BASE_TOKEN_PRICE = 150;

// XP / coins par uzvaru (pielāgo, ja gribi)
const XP_PER_WIN = 10;
const SCORE_PER_WIN = 1;
const COINS_PER_WIN = 3;

// Pasīvie coini
const PASSIVE_COINS_PER_TICK = 2;             // cik coins par reālu spēlēšanas periodu
const PASSIVE_INTERVAL_MS = 20 * 60 * 1000;   // 20 min
const AFK_BREAK_MS = 3 * 60 * 1000;           // ja >3 min bez aktivitātes, pasīvais periods pārtrūkst

// ======== Palīgfunkcijas failiem ========
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

// ======== Rank loģika ========
function calcRankFromXp(xp) {
  // vienkārša sistēma: ik pa 50 XP jauns līmenis
  const level = Math.max(1, Math.floor((xp || 0) / 50) + 1);
  let title;
  if (level <= 3) title = "Jauniņais";
  else if (level <= 6) title = "Spēlētājs";
  else if (level <= 9) title = "Meistars";
  else title = "Leģenda";
  return { level, title: `${title} ${level}` };
}

function getTokenPrice(user) {
  // var vienkārši būt konstants vai atkarīgs no žetonu skaita
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

  // ja starpība starp iepriekšējo aktivitāti un tagad > AFK_BREAK_MS,
  // tad uzskatām, ka viņš bija AFK – pasīvo periodu resetojam
  if (now - user.lastActionAt > AFK_BREAK_MS) {
    user.lastActionAt = now;
    user.lastPassiveTickAt = now;
    return;
  }

  // normāla aktivitāte: uzkrājam pasīvos coinus tikai šeit
  user.lastActionAt = now;
  const diff = now - user.lastPassiveTickAt;

  if (diff >= PASSIVE_INTERVAL_MS) {
    const ticks = Math.floor(diff / PASSIVE_INTERVAL_MS);
    const gained = ticks * PASSIVE_COINS_PER_TICK;
    user.coins = (user.coins || 0) + gained;
    user.lastPassiveTickAt += ticks * PASSIVE_INTERVAL_MS;
    console.log(
      `Pasīvie coini: ${user.username} +${gained} coins (tagad: ${user.coins})`
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

// ======== Express + Socket.IO setup ========
const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// ======== ONLINE saraksts ========
const onlineBySocket = new Map(); // socket.id -> username

function broadcastOnlineList() {
  const set = new Set(onlineBySocket.values());
  const users = Array.from(set);
  io.emit("onlineList", { count: users.length, users });
}

// ======== Auth endpoints ========

// Reģistrācija
app.post("/signup", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ message: "Nepieciešams username un password" });
  }

  const name = String(username).trim();
  if (!/^[a-zA-Z0-9_\-]{3,20}$/.test(name)) {
    return res
      .status(400)
      .json({ message: "Nickname: 3-20 simboli, tikai burti/cipari/ - _" });
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
    rankTitle: user.rankTitle,
    rankLevel: user.rankLevel,
  });
});

// Login
app.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ message: "Nepieciešams username un password" });
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

  // login arī skaitām kā aktivitāti
  markActivity(user);
  const rankInfo = calcRankFromXp(user.xp);
  user.rankLevel = rankInfo.level;
  user.rankTitle = rankInfo.title;
  saveUsers(USERS);

  const token = jwt.sign({ username: name }, JWT_SECRET, { expiresIn: "30d" });
  return res.json({
    token,
    username: name,
    xp: user.xp,
    score: user.score,
    coins: user.coins,
    tokens: user.tokens,
    streak: user.streak || 0,
    bestStreak: user.bestStreak || 0,
    rankTitle: user.rankTitle,
    rankLevel: user.rankLevel,
  });
});

// ======== /me ========
app.get("/me", authMiddleware, (req, res) => {
  const u = req.user;
  const rankInfo = calcRankFromXp(u.xp);
  u.rankLevel = rankInfo.level;
  u.rankTitle = rankInfo.title;

  // tikai info – šeit markActivity neliekam, lai /me spams neskaitās aktivitāte
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
  const list = WORDS;
  const idx = Math.floor(Math.random() * list.length);
  const w = list[idx].trim();
  return { word: w.toUpperCase(), len: w.length };
}

// Jauns raunds
app.get("/start-round", authMiddleware, (req, res) => {
  const user = req.user;
  markActivity(user); // aktivitāte

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

// Palīgfunkcija Wordle patternam
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
  markActivity(user); // Anti-AFK + pasīvie coini

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

  let win = guessRaw === round.word;
  let finished = win || round.attemptsLeft <= 0;

  let xpGain = 0;
  let coinsGain = 0;

  if (win) {
    xpGain = XP_PER_WIN;
    coinsGain = COINS_PER_WIN;
    user.xp = (user.xp || 0) + XP_PER_WIN;
    user.score = (user.score || 0) + SCORE_PER_WIN;
    user.coins = (user.coins || 0) + COINS_PER_WIN;

    user.streak = (user.streak || 0) + 1;
    user.bestStreak = Math.max(user.bestStreak || 0, user.streak || 0);

    round.finished = true;

    const rankInfo = calcRankFromXp(user.xp);
    user.rankLevel = rankInfo.level;
    user.rankTitle = rankInfo.title;

    // paziņojums visiem par uzvaru
    io.emit("playerWin", {
      username: user.username,
      xpGain,
      coinsGain,
      rankTitle: user.rankTitle,
      streak: user.streak || 0,
    });
  } else {
    // zaudēts minējums – streak reset tikai, ja raunds beidzas
    if (finished) {
      user.streak = 0;
    }
  }

  saveUsers(USERS);

  res.json({
    pattern,
    win,
    finished,
    attemptsLeft: round.attemptsLeft,
    rewards: win ? { xpGain, coinsGain } : null,
  });
});

// Žetona pirkšana
app.post("/buy-token", authMiddleware, (req, res) => {
  const user = req.user;
  markActivity(user); // aktivitāte (arī Anti-AFK)

  const price = getTokenPrice(user);
  if ((user.coins || 0) < price) {
    return res.status(400).json({ message: "Nepietiek coins" });
  }

  user.coins = (user.coins || 0) - price;
  user.tokens = (user.tokens || 0) + 1;

  saveUsers(USERS);

  // globāls paziņojums
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
app.get("/leaderboard", async (req, res) => {
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

  // pirmā aktivitāte — connection
  markActivity(user);
  saveUsers(USERS);

  // Čats
  socket.on("chatMessage", (text) => {
    if (typeof text !== "string") return;
    const msg = text.trim();
    if (!msg) return;

    // čatošana = aktivitāte (Anti-AFK)
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
