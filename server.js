// server.js — VĀRDU ZONA backend: Auth + Wordle + XP/Rank/Coins/Tokens/Streak + Leaderboard + Socket.IO

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);

const PORT = process.env.PORT || 10080;
const JWT_SECRET = process.env.JWT_SECRET || "BUGATS_VARDU_ZONA_SUPER_TOKENS";

const USERS_FILE = path.join(__dirname, "users.json");
const WORDS_FILE = path.join(__dirname, "words.txt");

const MIN_WORD_LEN = 5;
const MAX_WORD_LEN = 7;
const MAX_ATTEMPTS = 6;

// XP/coins parametri
const BASE_XP_PER_WIN = 50;
const XP_PER_ATTEMPT_LEFT = 10;

const BASE_COINS_PER_WIN = 20;
const COINS_PER_ATTEMPT_LEFT = 3;

const TOKEN_PRICE_COINS = 150;

// Ik pēc 20 min +2 coins
const PASSIVE_PERIOD_MS = 20 * 60 * 1000;
const PASSIVE_COINS = 2;

// Rank tabula
const RANKS = [
  { minXp: 0, title: "Jauniņais I" },
  { minXp: 200, title: "Jauniņais II" },
  { minXp: 600, title: "Cīnītājs" },
  { minXp: 1200, title: "Pro I" },
  { minXp: 2500, title: "Pro II" },
  { minXp: 4000, title: "Leģenda" },
];

function getRank(xp) {
  let current = RANKS[0];
  let level = 1;
  for (let i = 0; i < RANKS.length; i++) {
    if (xp >= RANKS[i].minXp) {
      current = RANKS[i];
      level = i + 1;
    }
  }
  return { title: current.title, level };
}

// ====== MIDDLEWARE ======
app.use(express.json());
app.use(
  cors({
    origin: ["https://thezone.lv", "https://www.thezone.lv"],
    methods: ["GET", "POST", "OPTIONS"],
  })
);

// ====== USERS ======
function getUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) {
      fs.writeFileSync(USERS_FILE, "[]", "utf8");
      return [];
    }
    const raw = fs.readFileSync(USERS_FILE, "utf8").trim();
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.map((u) => ({
      username: u.username,
      password: u.password,
      xp: u.xp ?? 0,
      coins: u.coins ?? 0,
      tokens: u.tokens ?? 0,
      score: u.score ?? 0,
      streak: u.streak ?? 0,
      bestStreak: u.bestStreak ?? 0,
      lastPassiveAt: u.lastPassiveAt || null,
      createdAt: u.createdAt || new Date().toISOString(),
    }));
  } catch (err) {
    console.error("getUsers error:", err);
    return [];
  }
}

function saveUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
  } catch (err) {
    console.error("saveUsers error:", err);
  }
}

function findUser(users, username) {
  return users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase()
  );
}

// Ik pēc 20 min +2 coins (kad lietotājs veic jebkuru darbību)
function applyPassiveIncome(user) {
  const now = Date.now();
  if (!user.lastPassiveAt) {
    user.lastPassiveAt = new Date(now).toISOString();
    return 0;
  }
  const last = new Date(user.lastPassiveAt).getTime();
  const diff = now - last;
  if (diff < PASSIVE_PERIOD_MS) return 0;

  const periods = Math.floor(diff / PASSIVE_PERIOD_MS);
  const gain = periods * PASSIVE_COINS;

  user.coins += gain;
  user.lastPassiveAt = new Date(last + periods * PASSIVE_PERIOD_MS).toISOString();
  return gain;
}

// ====== WORDS ======
let WORD_LIST = [];

function loadWords() {
  try {
    if (!fs.existsSync(WORDS_FILE)) {
      console.warn("words.txt nav atrasts!");
      WORD_LIST = [];
      return;
    }
    const raw = fs.readFileSync(WORDS_FILE, "utf8");
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(
        (w) =>
          w &&
          w.length >= MIN_WORD_LEN &&
          w.length <= MAX_WORD_LEN &&
          !w.includes(" ")
      );
    WORD_LIST = lines;
    console.log("Ielādēti vārdi:", WORD_LIST.length);
  } catch (err) {
    console.error("loadWords error:", err);
    WORD_LIST = [];
  }
}

loadWords();

// rounds: username -> { word, attemptsLeft }
const ROUNDS = new Map();

// ====== AUTH REST ======
app.post("/signup", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res
      .status(400)
      .json({ message: "Nepieciešams lietotājvārds un parole" });
  }

  const users = getUsers();
  if (findUser(users, username)) {
    return res.status(400).json({ message: "Šāds lietotājvārds jau eksistē" });
  }

  const hashed = bcrypt.hashSync(password, 10);
  const nowIso = new Date().toISOString();
  const newUser = {
    username,
    password: hashed,
    createdAt: nowIso,
    xp: 0,
    coins: 0,
    tokens: 0,
    score: 0,
    streak: 0,
    bestStreak: 0,
    lastPassiveAt: nowIso,
  };

  users.push(newUser);
  saveUsers(users);

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "7d" });
  const rank = getRank(newUser.xp);

  return res.status(201).json({
    token,
    username,
    xp: newUser.xp,
    coins: newUser.coins,
    tokens: newUser.tokens,
    score: newUser.score,
    streak: newUser.streak,
    bestStreak: newUser.bestStreak,
    rankTitle: rank.title,
    rankLevel: rank.level,
  });
});

app.post("/signin", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res
      .status(400)
      .json({ message: "Nepieciešams lietotājvārds un parole" });
  }

  const users = getUsers();
  const user = findUser(users, username);
  if (!user) {
    return res.status(401).json({ message: "Nepareizs lietotājvārds vai parole" });
  }

  const ok = bcrypt.compareSync(password, user.password);
  if (!ok) {
    return res.status(401).json({ message: "Nepareizs lietotājvārds vai parole" });
  }

  const passiveGain = applyPassiveIncome(user);
  if (passiveGain > 0) saveUsers(users);

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "7d" });
  const rank = getRank(user.xp);

  return res.json({
    token,
    username: user.username,
    xp: user.xp,
    coins: user.coins,
    tokens: user.tokens,
    score: user.score,
    streak: user.streak,
    bestStreak: user.bestStreak,
    rankTitle: rank.title,
    rankLevel: rank.level,
  });
});

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const [, token] = header.split(" ");
  if (!token) {
    return res.status(401).json({ message: "Nav autorizēts" });
  }
  jwt.verify(token, JWT_SECRET, (err, payload) => {
    if (err) return res.status(401).json({ message: "Token nederīgs" });
    req.user = payload;
    next();
  });
}

// Spēlētāja karte
app.get("/me", authMiddleware, (req, res) => {
  const users = getUsers();
  const user = findUser(users, req.user.username);
  if (!user) return res.status(404).json({ message: "Lietotājs nav atrasts" });

  const passiveGain = applyPassiveIncome(user);
  if (passiveGain > 0) saveUsers(users);

  const rank = getRank(user.xp);
  res.json({
    username: user.username,
    xp: user.xp,
    coins: user.coins,
    tokens: user.tokens,
    score: user.score,
    streak: user.streak,
    bestStreak: user.bestStreak,
    rankTitle: rank.title,
    rankLevel: rank.level,
    tokenPriceCoins: TOKEN_PRICE_COINS,
  });
});

// TOP 10 leaderboard
app.get("/leaderboard", (req, res) => {
  const users = getUsers();
  const sorted = [...users].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.xp ?? 0) - (a.xp ?? 0);
  });

  const top10 = sorted.slice(0, 10).map((u, idx) => {
    const rank = getRank(u.xp);
    return {
      place: idx + 1,
      username: u.username,
      score: u.score,
      xp: u.xp,
      coins: u.coins,
      tokens: u.tokens,
      streak: u.streak,
      bestStreak: u.bestStreak,
      rankTitle: rank.title,
      rankLevel: rank.level,
    };
  });

  res.json(top10);
});

// Žetonu pirkšana
app.post("/buy-token", authMiddleware, (req, res) => {
  const users = getUsers();
  const user = findUser(users, req.user.username);
  if (!user) return res.status(404).json({ message: "Lietotājs nav atrasts" });

  applyPassiveIncome(user);

  if (user.coins < TOKEN_PRICE_COINS) {
    return res
      .status(400)
      .json({ message: `Nepietiek coins (vajag ${TOKEN_PRICE_COINS})` });
  }

  user.coins -= TOKEN_PRICE_COINS;
  user.tokens += 1;
  saveUsers(users);

  const rank = getRank(user.xp);

  // Paziņojums visiem par žetona pirkumu
  io.emit("tokenBuy", {
    username: user.username,
    tokens: user.tokens,
  });

  res.json({
    username: user.username,
    xp: user.xp,
    coins: user.coins,
    tokens: user.tokens,
    score: user.score,
    streak: user.streak,
    bestStreak: user.bestStreak,
    rankTitle: rank.title,
    rankLevel: rank.level,
  });
});

// ====== GAME (Wordle REST) ======
app.get("/start-round", authMiddleware, (req, res) => {
  if (!WORD_LIST.length) {
    loadWords();
  }
  if (!WORD_LIST.length) {
    return res
      .status(500)
      .json({ message: "words.txt nav ielādēts vai tajā nav vārdu" });
  }

  const word =
    WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)].toUpperCase();

  ROUNDS.set(req.user.username, {
    word,
    attemptsLeft: MAX_ATTEMPTS,
  });

  return res.json({
    len: word.length,
    attemptsLeft: MAX_ATTEMPTS,
  });
});

function scoreGuess(guess, target) {
  const len = target.length;
  const result = new Array(len).fill("absent");
  const freq = {};

  for (let i = 0; i < len; i++) {
    const ch = target[i];
    freq[ch] = (freq[ch] || 0) + 1;
  }

  for (let i = 0; i < len; i++) {
    if (guess[i] === target[i]) {
      result[i] = "correct";
      freq[guess[i]] -= 1;
    }
  }

  for (let i = 0; i < len; i++) {
    if (result[i] === "correct") continue;
    const ch = guess[i];
    if (freq[ch] > 0) {
      result[i] = "present";
      freq[ch] -= 1;
    }
  }

  return result;
}

app.post("/guess", authMiddleware, (req, res) => {
  const { guess } = req.body || {};
  const username = req.user.username;

  const round = ROUNDS.get(username);
  if (!round) {
    return res.status(400).json({ message: "Raunds nav sākts" });
  }

  if (!guess || typeof guess !== "string") {
    return res.status(400).json({ message: "Nav minējuma" });
  }

  const g = guess.trim().toUpperCase();
  if (g.length !== round.word.length) {
    return res
      .status(400)
      .json({ message: `Vārdā jābūt tieši ${round.word.length} burtiem` });
  }

  if (round.attemptsLeft <= 0) {
    return res.status(400).json({ message: "Nav atlikušu mēģinājumu" });
  }

  const pattern = scoreGuess(g, round.word);
  round.attemptsLeft -= 1;

  let win = g === round.word;
  let finished = win || round.attemptsLeft <= 0;
  let rewards = null;

  const users = getUsers();
  let user = findUser(users, username);
  if (!user) {
    const nowIso = new Date().toISOString();
    user = {
      username,
      password: "",
      xp: 0,
      coins: 0,
      tokens: 0,
      score: 0,
      streak: 0,
      bestStreak: 0,
      lastPassiveAt: nowIso,
      createdAt: nowIso,
    };
    users.push(user);
  }

  applyPassiveIncome(user);

  if (finished) {
    if (win) {
      const rankBefore = getRank(user.xp);

      const xpGain =
        BASE_XP_PER_WIN + XP_PER_ATTEMPT_LEFT * round.attemptsLeft;
      const coinsGain =
        BASE_COINS_PER_WIN +
        COINS_PER_ATTEMPT_LEFT * round.attemptsLeft +
        (rankBefore.level - 1) * 5;
      const scoreGain = 1;

      user.xp += xpGain;
      user.coins += coinsGain;
      user.score += scoreGain;

      // streaks
      user.streak = (user.streak || 0) + 1;
      user.bestStreak = Math.max(user.bestStreak || 0, user.streak);

      const rankAfter = getRank(user.xp);

      rewards = {
        xpGain,
        coinsGain,
        scoreGain,
        newXp: user.xp,
        newCoins: user.coins,
        newScore: user.score,
        rankTitle: rankAfter.title,
        rankLevel: rankAfter.level,
        streak: user.streak,
        bestStreak: user.bestStreak,
      };

      // Dopamīna casino win-event uz visiem
      io.emit("playerWin", {
        username,
        xpGain,
        coinsGain,
        rankTitle: rankAfter.title,
        rankLevel: rankAfter.level,
        streak: user.streak,
        bestStreak: user.bestStreak,
        wordLen: round.word.length,
      });
    } else {
      // ja zaudē — streak nullējas
      user.streak = 0;
    }

    saveUsers(users);
  }

  if (finished) {
    ROUNDS.delete(username);
  } else {
    ROUNDS.set(username, round);
  }

  return res.json({
    pattern,
    attemptsLeft: round.attemptsLeft,
    finished,
    win,
    rewards,
  });
});

// healthcheck
app.get("/", (req, res) => {
  res.json({ ok: true, service: "VARDU ZONA backend" });
});

// ====== SOCKET.IO: online + chat + win-feed ======
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: ["https://thezone.lv", "https://www.thezone.lv"],
    methods: ["GET", "POST"],
  },
});

const onlineUsers = new Map(); // socket.id -> { username }

io.use((socket, next) => {
  const { token } = socket.handshake.auth || {};
  if (!token) return next(new Error("No token"));

  jwt.verify(token, JWT_SECRET, (err, payload) => {
    if (err) return next(new Error("Bad token"));
    socket.user = { username: payload.username };
    next();
  });
});

function broadcastOnline() {
  const list = [...onlineUsers.values()].map((u) => u.username);
  const unique = [...new Set(list)];
  io.emit("onlineList", { count: unique.length, users: unique });
}

io.on("connection", (socket) => {
  const username = socket.user?.username || "Nezināms";

  onlineUsers.set(socket.id, { username });
  broadcastOnline();

  socket.on("chatMessage", (text) => {
    const msgText = String(text || "").trim().slice(0, 200);
    if (!msgText) return;
    const msg = {
      username,
      text: msgText,
      ts: Date.now(),
    };
    io.emit("chatMessage", msg);
  });

  socket.on("disconnect", () => {
    onlineUsers.delete(socket.id);
    broadcastOnline();
  });
});

// ====== START ======
httpServer.listen(PORT, () => {
  console.log("VĀRDU ZONA serveris klausās uz porta", PORT);
});
