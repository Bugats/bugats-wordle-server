// server.js — VĀRDU ZONA backend: Auth + Wordle + XP/Rank/Coins/Tokens/Leaderboard

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
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
    // default vērtības, ja kas pietrūkst
    return data.map((u) => ({
      username: u.username,
      password: u.password,
      xp: u.xp ?? 0,
      coins: u.coins ?? 0,
      tokens: u.tokens ?? 0,
      score: u.score ?? 0, // punkti leaderboardam (1 par katru atminētu vārdu)
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

// ====== AUTH ======
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
  const newUser = {
    username,
    password: hashed,
    createdAt: new Date().toISOString(),
    xp: 0,
    coins: 0,
    tokens: 0,
    score: 0,
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

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "7d" });
  const rank = getRank(user.xp);

  return res.json({
    token,
    username: user.username,
    xp: user.xp,
    coins: user.coins,
    tokens: user.tokens,
    score: user.score,
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

  const rank = getRank(user.xp);
  res.json({
    username: user.username,
    xp: user.xp,
    coins: user.coins,
    tokens: user.tokens,
    score: user.score,
    rankTitle: rank.title,
    rankLevel: rank.level,
    tokenPriceCoins: TOKEN_PRICE_COINS,
  });
});

// TOP 10 leaderboard (pēc score, tad XP)
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
      rankTitle: rank.title,
      rankLevel: rank.level,
    };
  });

  res.json(top10);
});

// Žetonu pirkšana (1 žetons = 150 coins)
app.post("/buy-token", authMiddleware, (req, res) => {
  const users = getUsers();
  const user = findUser(users, req.user.username);
  if (!user) return res.status(404).json({ message: "Lietotājs nav atrasts" });

  if (user.coins < TOKEN_PRICE_COINS) {
    return res
      .status(400)
      .json({ message: `Nepietiek coins (vajag ${TOKEN_PRICE_COINS})` });
  }

  user.coins -= TOKEN_PRICE_COINS;
  user.tokens += 1;
  saveUsers(users);

  const rank = getRank(user.xp);
  res.json({
    username: user.username,
    xp: user.xp,
    coins: user.coins,
    tokens: user.tokens,
    score: user.score,
    rankTitle: rank.title,
    rankLevel: rank.level,
  });
});

// ====== GAME (Wordle) ======

// jauns raunds
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

// Wordle scoring
function scoreGuess(guess, target) {
  const len = target.length;
  const result = new Array(len).fill("absent");
  const freq = {};

  for (let i = 0; i < len; i++) {
    const ch = target[i];
    freq[ch] = (freq[ch] || 0) + 1;
  }

  // correct
  for (let i = 0; i < len; i++) {
    if (guess[i] === target[i]) {
      result[i] = "correct";
      freq[guess[i]] -= 1;
    }
  }

  // present
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

// minējums
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

  if (finished && win) {
    // XP/coins/score piešķiršana tikai par atminētu vārdu
    const users = getUsers();
    const user = findUser(users, username) || {
      username,
      password: "",
      xp: 0,
      coins: 0,
      tokens: 0,
      score: 0,
      createdAt: new Date().toISOString(),
    };

    const rankBefore = getRank(user.xp);

    const xpGain =
      BASE_XP_PER_WIN + XP_PER_ATTEMPT_LEFT * round.attemptsLeft;
    const coinsGain =
      BASE_COINS_PER_WIN +
      COINS_PER_ATTEMPT_LEFT * round.attemptsLeft +
      (rankBefore.level - 1) * 5; // jo lielāks ranks, jo vairāk coins
    const scoreGain = 1;

    user.xp += xpGain;
    user.coins += coinsGain;
    user.score += scoreGain;

    // ja users.json vēl nebija šis lietotājs
    if (!findUser(users, username)) {
      users.push(user);
    }

    saveUsers(users);

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
    };
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

app.listen(PORT, () => {
  console.log("VĀRDU ZONA serveris klausās uz porta", PORT);
});
