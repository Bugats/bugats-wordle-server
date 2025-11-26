// server.js — VĀRDU ZONA auth + Wordle backend

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

// ====== MIDDLEWARE ======
app.use(express.json());

// Atļaujam thezone.lv frontend
app.use(
  cors({
    origin: ["https://thezone.lv", "https://www.thezone.lv"],
    methods: ["GET", "POST", "OPTIONS"],
  })
);

// Ja vajadzēs statiskos failus no servera
app.use(express.static(path.join(__dirname, "public")));

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
    return Array.isArray(data) ? data : [];
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
  const exists = users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase()
  );
  if (exists) {
    return res.status(400).json({ message: "Šāds lietotājvārds jau eksistē" });
  }

  const hashed = bcrypt.hashSync(password, 10);
  const newUser = {
    username,
    password: hashed,
    createdAt: new Date().toISOString(),
    xp: 0,
    coins: 0,
  };

  users.push(newUser);
  saveUsers(users);

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "7d" });
  return res.status(201).json({
    token,
    username,
    xp: newUser.xp,
    coins: newUser.coins,
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
  const user = users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase()
  );
  if (!user) {
    return res.status(401).json({ message: "Nepareizs lietotājvārds vai parole" });
  }

  const ok = bcrypt.compareSync(password, user.password);
  if (!ok) {
    return res.status(401).json({ message: "Nepareizs lietotājvārds vai parole" });
  }

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "7d" });
  return res.json({
    token,
    username: user.username,
    xp: user.xp ?? 0,
    coins: user.coins ?? 0,
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

app.get("/me", authMiddleware, (req, res) => {
  const users = getUsers();
  const user = users.find(
    (u) => u.username.toLowerCase() === req.user.username.toLowerCase()
  );
  if (!user) return res.status(404).json({ message: "Lietotājs nav atrasts" });

  res.json({
    username: user.username,
    xp: user.xp ?? 0,
    coins: user.coins ?? 0,
  });
});

// ====== GAME API ======

// jauns raunds: izvēlamies random vārdu ar garumu 5–7
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

// palīgfunkcija Wordle krāsošanai
function scoreGuess(guess, target) {
  const len = target.length;
  const result = new Array(len).fill("absent");

  const freq = {};
  for (let i = 0; i < len; i++) {
    const ch = target[i];
    freq[ch] = (freq[ch] || 0) + 1;
  }

  // vispirms "correct"
  for (let i = 0; i < len; i++) {
    if (guess[i] === target[i]) {
      result[i] = "correct";
      freq[guess[i]] -= 1;
    }
  }

  // tad "present"
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

  const win = g === round.word;
  const finished = win || round.attemptsLeft <= 0;

  if (finished) {
    // šeit vēlāk varēs piešķirt XP/coins un saglabāt users.json
    // pēc raunda varam noņemt no kartes
    ROUNDS.delete(username);
  } else {
    ROUNDS.set(username, round);
  }

  return res.json({
    pattern,           // ["correct","present","absent",...]
    attemptsLeft: round.attemptsLeft,
    finished,
    win,
  });
});

// healthcheck
app.get("/", (req, res) => {
  res.json({ ok: true, service: "VARDU ZONA backend" });
});

app.listen(PORT, () => {
  console.log("VĀRDU ZONA serveris klausās uz porta", PORT);
});
