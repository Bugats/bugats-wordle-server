// ======== VĀRDU ZONA — Bugats edition v1.1 ========
// Serveris ar login/signup, XP, ranks, čatu, misijām, CID un JWT
// Atjaunināts: 2025-11-25 — Pievienots dailyMissions, novērsta "missions undefined" kļūda

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

// ======== Ceļi un konstantes ========
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 10080;

const JWT_SECRET = process.env.JWT_SECRET || "BUGATS_VARDU_ZONA_SUPER_SLEPENS_JWT";
const USERS_FILE = path.join(__dirname, "users.json");
const WORDS_FILE = path.join(__dirname, "words.txt");

const MIN_WORD_LEN = 5;
const MAX_WORD_LEN = 7;
const MAX_ATTEMPTS = 6;
const ADMIN_USERNAMES = ["Bugats"];

// ======== Failu funkcijas ========
function safeReadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function safeWriteJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Neizdevās saglabāt failu:", file, e);
  }
}

// ======== Lietotāji ========
let users = safeReadJson(USERS_FILE, []);
function findUserByUsername(name) {
  return users.find((u) => u.username.toLowerCase() === name.toLowerCase());
}
function findUserById(id) {
  return users.find((u) => u.id === id);
}
function ensureUserStats(u) {
  if (!u) return;
  u.xp ??= 0;
  u.coins ??= 0;
  u.tokens ??= 0;
  u.wins ??= 0;
  u.streak ??= 0;
  u.bestStreak ??= 0;
  u.rankTitle ??= "Jauniņais I";
  u.cid ??= null;
}
function saveUsers() {
  safeWriteJson(USERS_FILE, users);
}
function xpToRank(xp) {
  if (xp >= 5000) return "Leģenda";
  if (xp >= 2500) return "Čempions";
  if (xp >= 1500) return "Meistars";
  if (xp >= 800) return "Profesionālis";
  if (xp >= 400) return "Entuziasts";
  if (xp >= 150) return "Spēlētājs";
  if (xp >= 50) return "Jauniņais II";
  return "Jauniņais I";
}
function recalcRank(u) {
  u.rankTitle = xpToRank(u.xp || 0);
}
users.forEach(ensureUserStats);

// ======== Vārdu saraksts ========
let allWords = [];
try {
  const raw = fs.readFileSync(WORDS_FILE, "utf8");
  allWords = raw.split(/\r?\n/).map(w => w.trim().toLowerCase())
    .filter(w => w && w.length >= MIN_WORD_LEN && w.length <= MAX_WORD_LEN);
  if (!allWords.length) console.warn("words.txt ir tukšs vai neatbilstošs.");
} catch (e) {
  console.error("Neizdevās nolasīt words.txt:", e);
}
const validWordsSet = new Set(allWords);
function randomWord() {
  return allWords.length ? allWords[Math.floor(Math.random() * allWords.length)] : "bugat";
}

// ======== Spēles dati ========
let roundCounter = 1;
let currentRound = {
  id: String(roundCounter),
  word: randomWord(),
  createdAt: Date.now(),
  attemptsByUserId: new Map(),
  solvedUsers: new Set(),
};
console.log("Starta vārds:", currentRound.word);

let recentSolves = [];
let chatHistory = [];
let dailyChampion = null;
const xpTodayByUserId = new Map();
const bannedUserIds = new Set();

// ======== Express un Socket.IO ========
const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_, res) => res.json({ ok: true, roundId: currentRound.id }));

// ======== Signup / Login ========
function createToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "30d" });
}

app.post("/api/signup", async (req, res) => {
  try {
    const { username, password, cid } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "Nepieciešams lietotājvārds un parole" });
    if (findUserByUsername(username)) return res.status(409).json({ error: "Šāds lietotājvārds jau eksistē" });
    if (cid && users.find(u => u.cid === cid)) return res.status(409).json({ error: "Šai ierīcei jau ir profils" });

    const hash = await bcrypt.hash(password, 10);
    const user = {
      id: "u_" + Date.now().toString(36),
      username: username.trim(),
      passwordHash: hash,
      xp: 0, coins: 0, tokens: 0, wins: 0,
      streak: 0, bestStreak: 0,
      rankTitle: "Jauniņais I",
      cid: cid || null
    };
    users.push(user);
    saveUsers();
    const token = createToken(user);
    res.json({ token, profile: user });
  } catch (e) {
    console.error("Signup kļūda:", e);
    res.status(500).json({ error: "Servera kļūda" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = findUserByUsername(username || "");
    if (!user) return res.status(401).json({ error: "Nepareizs lietotājvārds vai parole" });
    const ok = await bcrypt.compare(password || "", user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Nepareizs lietotājvārds vai parole" });
    ensureUserStats(user);
    const token = createToken(user);
    res.json({ token, profile: user });
  } catch (e) {
    console.error("Login kļūda:", e);
    res.status(500).json({ error: "Servera kļūda" });
  }
});

// ======== HTTP + IO ========
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*", methods: ["GET", "POST"] } });

// ======== Socket autentifikācija ========
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const cid = socket.handshake.auth?.cid || null;
  if (!token) return next(new Error("NO_AUTH"));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = findUserById(payload.id);
    if (!user) return next(new Error("USER_NOT_FOUND"));
    if (bannedUserIds.has(user.id)) return next(new Error("BANNED"));
    socket.data.user = user;
    socket.data.cid = cid;
    ensureUserStats(user);
    next();
  } catch {
    next(new Error("BAD_TOKEN"));
  }
});

// ======== Palīgfunkcijas ========
function buildLettersResult(guess, secret) {
  const letters = [];
  const secretArr = secret.split("");
  const used = Array(secretArr.length).fill(false);
  for (let i = 0; i < guess.length; i++) {
    if (guess[i] === secretArr[i]) {
      letters.push({ letter: guess[i], status: "correct" });
      used[i] = true;
    } else letters.push({ letter: guess[i], status: "absent" });
  }
  for (let i = 0; i < guess.length; i++) {
    if (letters[i].status === "correct") continue;
    for (let j = 0; j < secretArr.length; j++) {
      if (!used[j] && secretArr[j] === guess[i]) {
        used[j] = true;
        letters[i].status = "present";
        break;
      }
    }
  }
  return letters;
}
function getStats(u) {
  return {
    xp: u.xp, coins: u.coins, tokens: u.tokens,
    wins: u.wins, streak: u.streak, bestStreak: u.bestStreak,
    rankTitle: u.rankTitle
  };
}
function getLeaderboard() {
  return users.map(u => ({
    id: u.id, name: u.username, xp: u.xp, rankTitle: u.rankTitle
  })).sort((a, b) => b.xp - a.xp).slice(0, 50);
}
function broadcastLeaderboard() {
  io.emit("leaderboardUpdate", { players: getLeaderboard() });
}
function broadcastOnline() {
  const players = [];
  for (const s of io.sockets.sockets.values()) {
    const u = s.data.user;
    if (!players.find(p => p.id === u.id))
      players.push({ id: u.id, name: u.username, rankTitle: u.rankTitle });
  }
  io.emit("onlinePlayers", { players });
}

// ======== Spēle ========
io.on("connection", (socket) => {
  const user = socket.data.user;
  console.log("Savienojās:", user.username);

  socket.emit("hello", {
    roundId: currentRound.id,
    wordLength: currentRound.word.length,
    maxAttempts: MAX_ATTEMPTS,
    stats: getStats(user),
    leaderboard: getLeaderboard(),
    onlinePlayers: [],
    recentSolves,
    chatHistory,
    dailyMissions: {
      missions: [
        { key: "solve1", text: "Atmini 1 vārdu šodien", target: 1 },
        { key: "solve3", text: "Atmini 3 vārdus šodien", target: 3 },
        { key: "rounds5", text: "Nospēlē 5 raundus", target: 5 }
      ]
    },
    dailyProgress: {
      completed: {}
    }
  });

  broadcastOnline();
  broadcastLeaderboard();

  socket.on("guess", (data) => {
    const word = String(data.word || "").toLowerCase();
    if (word.length !== currentRound.word.length)
      return socket.emit("guessResult", { error: true, msg: "Nepareizs garums" });
    if (!validWordsSet.has(word))
      return socket.emit("guessResult", { error: true, msg: "Nav vārdnīcā" });

    const att = currentRound.attemptsByUserId.get(user.id) || 0;
    if (att >= MAX_ATTEMPTS)
      return socket.emit("guessResult", { error: true, msg: "Nav vairs mēģinājumu" });

    const attemptsUsed = att + 1;
    currentRound.attemptsByUserId.set(user.id, attemptsUsed);
    const res = buildLettersResult(word, currentRound.word);
    const isWin = word === currentRound.word;

    socket.emit("guessResult", { letters: res, isWin, attemptsLeft: MAX_ATTEMPTS - attemptsUsed });

    if (isWin) {
      user.xp += 10;
      user.coins += 5;
      user.streak++;
      recalcRank(user);
      saveUsers();
      recentSolves.unshift({ name: user.username, xpGain: 10, streak: user.streak, coinsGain: 5 });
      io.emit("wordSolvedFeed", { name: user.username, xpGain: 10, streak: user.streak, coinsGain: 5 });
      socket.emit("statsUpdate", getStats(user));
      broadcastLeaderboard();
      startNewRound();
    } else if (attemptsUsed >= MAX_ATTEMPTS) {
      user.streak = 0;
      saveUsers();
      socket.emit("statsUpdate", getStats(user));
    }
  });

  socket.on("chatMessage", (msg) => {
    if (!msg.text) return;
    const entry = { name: user.username, text: msg.text.slice(0, 200) };
    chatHistory.push(entry);
    chatHistory = chatHistory.slice(-50);
    io.emit("chatMessage", entry);
  });

  socket.on("requestNewRound", startNewRound);
  socket.on("disconnect", () => {
    console.log("Atslēdzās:", user.username);
    broadcastOnline();
  });
});

function startNewRound() {
  roundCounter++;
  currentRound = {
    id: String(roundCounter),
    word: randomWord(),
    createdAt: Date.now(),
    attemptsByUserId: new Map(),
    solvedUsers: new Set(),
  };
  console.log("Jauns raunds:", currentRound.word);
  io.emit("newRound", {
    roundId: currentRound.id,
    wordLength: currentRound.word.length,
    maxAttempts: MAX_ATTEMPTS
  });
}

// ======== Coins par online laiku ========
setInterval(() => {
  for (const s of io.sockets.sockets.values()) {
    const u = s.data.user;
    u.coins++;
    s.emit("coinUpdate", { coins: u.coins, gained: 1 });
  }
  saveUsers();
}, 60000);

// ======== Start ========
httpServer.listen(PORT, () => console.log("VĀRDU ZONA serveris darbojas uz porta:", PORT));
