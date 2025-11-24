// server.js — VĀRDU ZONA (Bugats edition) ar kontiem (signup/login)

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

// ===== Ceļi un konstantes =====

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10080;

const JWT_SECRET =
  process.env.JWT_SECRET || "BUGATS_VARDU_ZONA_SUPER_SLEPENS_JWT";

const USERS_FILE = path.join(__dirname, "users.json");
const WORDS_FILE = path.join(__dirname, "words.txt");

// Spēles konfigurācija
const MIN_WORD_LEN = 5;
const MAX_WORD_LEN = 7;
const MAX_ATTEMPTS = 6;

// Admin lietotājvārdi (ar šiem username būs admin panelis ONLINE sarakstā)
const ADMIN_USERNAMES = ["Bugats"];

// ===== Palīgfunkcijas failiem =====

function safeReadJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw);
  } catch (e) {
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

// ===== Lietotāji (users.json) =====

let users = safeReadJson(USERS_FILE, []);

function findUserByUsername(name) {
  if (!name) return null;
  return users.find(
    (u) => u.username.toLowerCase() === name.toLowerCase()
  );
}

function findUserById(id) {
  if (!id) return null;
  return users.find((u) => u.id === id);
}

function saveUsers() {
  safeWriteJson(USERS_FILE, users);
}

function ensureUserStats(u) {
  if (!u) return;
  if (typeof u.xp !== "number") u.xp = 0;
  if (typeof u.coins !== "number") u.coins = 0;
  if (typeof u.tokens !== "number") u.tokens = 0;
  if (typeof u.wins !== "number") u.wins = 0;
  if (typeof u.streak !== "number") u.streak = 0;
  if (typeof u.bestStreak !== "number") u.bestStreak = 0;
  if (!u.rankTitle) u.rankTitle = "Jauniņais I";
  if (typeof u.medalsCount !== "number") u.medalsCount = 0;
  if (!u.lastMedal) u.lastMedal = null;
  if (!u.bestFastWin) u.bestFastWin = null;
}

users.forEach(ensureUserStats);

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

// ===== Vārdu saraksts (words.txt) =====

let allWords = [];
try {
  const raw = fs.readFileSync(WORDS_FILE, "utf8");
  allWords = raw
    .split(/\r?\n/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w && w.length >= MIN_WORD_LEN && w.length <= MAX_WORD_LEN);
  if (!allWords.length) {
    console.warn("words.txt ir tukšs vai neatbilstošs.");
  }
} catch (e) {
  console.error("Neizdevās nolasīt words.txt:", e);
}
const validWordsSet = new Set(allWords);

function randomWord() {
  if (!allWords.length) {
    return "bugat"; // fallback
  }
  const idx = Math.floor(Math.random() * allWords.length);
  return allWords[idx];
}

// ===== Daily misijas =====

const DAILY_MISSIONS = [
  { key: "solve1", text: "Atmini 1 vārdu šodien", target: 1 },
  { key: "solve3", text: "Atmini 3 vārdus šodien", target: 3 },
  { key: "rounds5", text: "Nospēlē 5 raundus (minējumus)", target: 5 },
];

// userId -> { completed: {key:true}, solves: number, rounds: number }
const dailyProgressByUserId = new Map();

// ===== Runde =====

let roundCounter = 1;
let currentRound = {
  id: String(roundCounter),
  word: randomWord(),
  createdAt: Date.now(),
  attemptsByUserId: new Map(), // userId -> attempts skaits
  solvedUsers: new Set(), // userIds
};

console.log("Starta vārds:", currentRound.word);

// ===== Feed / čats / čempions =====

let recentSolves = []; // {name,xpGain,streak,coinsGain}
let chatHistory = []; // {name,text}
let dailyChampion = null; // {userId,name,xpToday}
const xpTodayByUserId = new Map();

// ===== Bani =====

const bannedUserIds = new Set();

// ===== Express + Socket.IO =====

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ ok: true, roundId: currentRound.id });
});

// ===== Signup / Login API =====

function createToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

app.post("/api/signup", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res
        .status(400)
        .json({ error: "Nepieciešams lietotājvārds un parole" });
    }
    if (username.length < 3 || username.length > 20) {
      return res
        .status(400)
        .json({ error: "Lietotājvārdam jābūt 3–20 simboliem" });
    }
    if (findUserByUsername(username)) {
      return res.status(409).json({ error: "Šāds lietotājvārds jau ir" });
    }

    const hash = await bcrypt.hash(password, 10);
    const user = {
      id: "u_" + Date.now().toString(36) + Math.random().toString(36).slice(2),
      username: username.trim().slice(0, 20),
      passwordHash: hash,
      createdAt: new Date().toISOString(),
      xp: 0,
      coins: 0,
      tokens: 0,
      wins: 0,
      streak: 0,
      bestStreak: 0,
      rankTitle: "Jauniņais I",
      medalsCount: 0,
      lastMedal: null,
      bestFastWin: null,
    };
    users.push(user);
    saveUsers();

    const token = createToken(user);
    return res.json({
      token,
      profile: {
        id: user.id,
        username: user.username,
        xp: user.xp,
        coins: user.coins,
        tokens: user.tokens,
        streak: user.streak,
        rankTitle: user.rankTitle,
      },
    });
  } catch (e) {
    console.error("Signup kļūda:", e);
    res.status(500).json({ error: "Servera kļūda" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = findUserByUsername(username || "");
    if (!user) {
      return res
        .status(401)
        .json({ error: "Nepareizs lietotājvārds vai parole" });
    }
    const ok = await bcrypt.compare(password || "", user.passwordHash);
    if (!ok) {
      return res
        .status(401)
        .json({ error: "Nepareizs lietotājvārds vai parole" });
    }
    ensureUserStats(user);
    const token = createToken(user);
    res.json({
      token,
      profile: {
        id: user.id,
        username: user.username,
        xp: user.xp,
        coins: user.coins,
        tokens: user.tokens,
        streak: user.streak,
        rankTitle: user.rankTitle,
      },
    });
  } catch (e) {
    console.error("Login kļūda:", e);
    res.status(500).json({ error: "Servera kļūda" });
  }
});

// ===== HTTP server + Socket.IO =====

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// ===== Socket autentifikācija (JWT) =====

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("NO_AUTH"));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = findUserById(payload.id);
    if (!user) return next(new Error("USER_NOT_FOUND"));
    if (bannedUserIds.has(user.id)) {
      return next(new Error("BANNED"));
    }
    ensureUserStats(user);
    socket.data.user = user;
    return next();
  } catch (e) {
    return next(new Error("BAD_TOKEN"));
  }
});

// ===== Palīgfunkcijas spēlei =====

function buildLettersResult(guess, secret) {
  const letters = [];
  const secretArr = secret.split("");
  const used = Array(secretArr.length).fill(false);

  // correct
  for (let i = 0; i < guess.length; i++) {
    const g = guess[i];
    if (g === secretArr[i]) {
      letters.push({ letter: g, status: "correct" });
      used[i] = true;
    } else {
      letters.push({ letter: g, status: "absent" }); // pagaidām
    }
  }
  // present
  for (let i = 0; i < guess.length; i++) {
    if (letters[i].status === "correct") continue;
    const g = guess[i];
    let found = -1;
    for (let j = 0; j < secretArr.length; j++) {
      if (!used[j] && secretArr[j] === g) {
        found = j;
        break;
      }
    }
    if (found !== -1) {
      used[found] = true;
      letters[i].status = "present";
    }
  }
  return letters;
}

function getStatsPayload(u) {
  return {
    xp: u.xp,
    coins: u.coins,
    tokens: u.tokens,
    wins: u.wins,
    streak: u.streak,
    bestStreak: u.bestStreak,
    rankTitle: u.rankTitle,
    medalsCount: u.medalsCount,
    lastMedal: u.lastMedal,
    bestFastWin: u.bestFastWin,
  };
}

function getLeaderboard() {
  const arr = users
    .map((u) => ({
      id: u.id,
      name: u.username,
      xp: u.xp || 0,
      rankTitle: u.rankTitle || xpToRank(u.xp || 0),
    }))
    .sort((a, b) => b.xp - a.xp)
    .slice(0, 50);
  return arr;
}

function getOnlinePlayers() {
  const list = [];
  for (const s of io.sockets.sockets.values()) {
    const u = s.data.user;
    if (!u) continue;
    list.push({
      id: u.id,
      name: u.username,
      rankTitle: u.rankTitle,
    });
  }
  return list;
}

function broadcastOnline() {
  const players = getOnlinePlayers();
  io.emit("onlinePlayers", { players });
  io.emit("onlineCount", { count: players.length });
}

function broadcastLeaderboard() {
  io.emit("leaderboardUpdate", { players: getLeaderboard() });
}

function getOrCreateDailyProgress(userId) {
  let p = dailyProgressByUserId.get(userId);
  if (!p) {
    p = { completed: {}, solves: 0, rounds: 0 };
    dailyProgressByUserId.set(userId, p);
  }
  return p;
}

function getDailyProgressPayload(userId) {
  const p = dailyProgressByUserId.get(userId);
  if (!p) return { completed: {} };
  return {
    completed: { ...p.completed },
  };
}

function checkDailyMissions(user, socket, isSolve) {
  const prog = getOrCreateDailyProgress(user.id);
  if (isSolve) prog.solves += 1;
  prog.rounds += 1;

  const newlyCompleted = [];

  for (const m of DAILY_MISSIONS) {
    if (prog.completed[m.key]) continue;
    if (m.key === "solve1" && prog.solves >= 1) {
      prog.completed[m.key] = true;
      newlyCompleted.push(m);
      user.xp += 5;
    } else if (m.key === "solve3" && prog.solves >= 3) {
      prog.completed[m.key] = true;
      newlyCompleted.push(m);
      user.xp += 10;
    } else if (m.key === "rounds5" && prog.rounds >= 5) {
      prog.completed[m.key] = true;
      newlyCompleted.push(m);
      user.xp += 10;
    }
  }

  if (newlyCompleted.length) {
    recalcRank(user);
    saveUsers();
    socket.emit("dailyMissionsCompleted", {
      missions: newlyCompleted.map((m) => ({
        key: m.key,
        text: m.text,
      })),
    });
    socket.emit("statsUpdate", {
      ...getStatsPayload(user),
      gainedXP: 0,
      gainedCoins: 0,
      dailyBonus: 0,
    });
  }
}

function updateDailyChampion(user, gainedXp) {
  if (!gainedXp) return;
  const prev = xpTodayByUserId.get(user.id) || 0;
  const now = prev + gainedXp;
  xpTodayByUserId.set(user.id, now);

  if (!dailyChampion || now > dailyChampion.xpToday) {
    dailyChampion = { userId: user.id, name: user.username, xpToday: now };
    io.emit("dailyChampionUpdate", {
      name: user.username,
      bonusXp: 0,
    });
  }
}

function awardMedal(user, attemptsUsed, wordLength) {
  let type = null;
  if (attemptsUsed === 1) type = "gold";
  else if (attemptsUsed === 2) type = "silver";
  else if (attemptsUsed === 3) type = "bronze";

  if (!type) return;

  user.medalsCount = (user.medalsCount || 0) + 1;
  user.lastMedal = {
    type,
    attemptsUsed,
    wordLength,
  };

  if (
    !user.bestFastWin ||
    attemptsUsed < user.bestFastWin.attemptsUsed
  ) {
    user.bestFastWin = { attemptsUsed, wordLength };
  }

  io.emit("roundMedal", {
    name: user.username,
    type,
    attemptsUsed,
    wordLength,
  });
}

function startNewRound() {
  roundCounter += 1;
  currentRound = {
    id: String(roundCounter),
    word: randomWord(),
    createdAt: Date.now(),
    attemptsByUserId: new Map(),
    solvedUsers: new Set(),
  };
  console.log("Jauns raunds:", currentRound.id, "vārds:", currentRound.word);
}

function addToRecentSolves(name, xpGain, streak, coinsGain) {
  recentSolves.unshift({
    name,
    xpGain,
    streak,
    coinsGain,
  });
  if (recentSolves.length > 20) {
    recentSolves = recentSolves.slice(0, 20);
  }
}

// ===== Socket.IO savienojumi =====

io.on("connection", (socket) => {
  const user = socket.data.user;
  const isAdmin = ADMIN_USERNAMES.some(
    (n) => n.toLowerCase() === user.username.toLowerCase()
  );
  socket.data.isAdmin = isAdmin;

  console.log("Savienojās:", user.username, "(", user.id, ")");

  // Hello payload
  const stats = getStatsPayload(user);

  socket.emit("hello", {
    userId: user.id,
    finalName: user.username,
    roundId: currentRound.id,
    maxAttempts: MAX_ATTEMPTS,
    wordLength: currentRound.word.length,
    stats,
    isAdmin,
    leaderboard: getLeaderboard(),
    onlineCount: getOnlinePlayers().length,
    onlinePlayers: getOnlinePlayers(),
    recentSolves,
    chatHistory,
    dailyMissions: { missions: DAILY_MISSIONS },
    dailyProgress: getDailyProgressPayload(user.id),
    dailyChampion: dailyChampion
      ? { name: dailyChampion.name }
      : null,
  });

  broadcastOnline();
  broadcastLeaderboard();

  // ===== Guess =====
  socket.on("guess", (data) => {
    try {
      const word = String(data.word || "").toLowerCase();
      const roundId = String(data.roundId || "");

      if (roundId !== currentRound.id) {
        return socket.emit("guessResult", {
          error: true,
          msg: "Raunds jau ir nomainījies. Pārlādē lapu.",
        });
      }

      if (!word || word.length !== currentRound.word.length) {
        return socket.emit("guessResult", {
          error: true,
          msg: `Vārdā jābūt ${currentRound.word.length} burtiem.`,
        });
      }

      if (!validWordsSet.has(word)) {
        return socket.emit("guessResult", {
          error: true,
          msg: "Šāds vārds nav vārdnīcā.",
        });
      }

      const attemptsMap = currentRound.attemptsByUserId;
      const prevAtt = attemptsMap.get(user.id) || 0;
      if (prevAtt >= MAX_ATTEMPTS) {
        return socket.emit("guessResult", {
          error: true,
          msg: "Nav vairs mēģinājumu šim raundam.",
        });
      }

      const attemptsUsed = prevAtt + 1;
      attemptsMap.set(user.id, attemptsUsed);
      const attemptsLeft = Math.max(0, MAX_ATTEMPTS - attemptsUsed);

      const letters = buildLettersResult(word, currentRound.word);
      const isWin = word === currentRound.word;

      socket.emit("guessResult", {
        letters,
        isWin,
        attemptsLeft,
      });

      // Katrs minējums skaitās "rounds" daily misijai
      checkDailyMissions(user, socket, isWin);

      if (isWin) {
        if (!currentRound.solvedUsers.has(user.id)) {
          currentRound.solvedUsers.add(user.id);

          const baseXp = 10;
          const speedBonus = Math.max(
            0,
            (MAX_ATTEMPTS - attemptsUsed) * 2
          );
          const gainedXp = baseXp + speedBonus;
          const gainedCoins = 5;

          user.xp += gainedXp;
          user.coins += gainedCoins;
          user.wins = (user.wins || 0) + 1;
          user.streak = (user.streak || 0) + 1;
          if (user.streak > (user.bestStreak || 0)) {
            user.bestStreak = user.streak;
          }
          recalcRank(user);

          awardMedal(user, attemptsUsed, currentRound.word.length);
          updateDailyChampion(user, gainedXp);
          saveUsers();

          addToRecentSolves(
            user.username,
            gainedXp,
            user.streak,
            gainedCoins
          );

          io.emit("wordSolvedFeed", {
            name: user.username,
            xpGain: gainedXp,
            streak: user.streak,
            coinsGain: gainedCoins,
          });

          socket.emit("statsUpdate", {
            ...getStatsPayload(user),
            gainedXP: gainedXp,
            gainedCoins: gainedCoins,
            dailyBonus: 0,
          });

          broadcastLeaderboard();
        }
      } else {
        // zaudējums – streak reset
        if (attemptsLeft === 0) {
          user.streak = 0;
          saveUsers();
          socket.emit("statsUpdate", {
            ...getStatsPayload(user),
            gainedXP: 0,
            gainedCoins: 0,
            dailyBonus: 0,
          });
        }
      }
    } catch (e) {
      console.error("guess kļūda:", e);
      socket.emit("guessResult", {
        error: true,
        msg: "Servera kļūda, mēģini vēlreiz.",
      });
    }
  });

  // ===== Jauna spēle =====
  socket.on("requestNewRound", () => {
    startNewRound();
    const payload = {
      roundId: currentRound.id,
      wordLength: currentRound.word.length,
      maxAttempts: MAX_ATTEMPTS,
    };
    io.emit("newRound", payload);
  });

  // ===== Čats =====
  socket.on("chatMessage", (msg) => {
    const text = (msg && msg.text) || "";
    if (!text.trim()) return;
    const entry = {
      name: user.username,
      text: text.trim().slice(0, 200),
    };
    chatHistory.push(entry);
    if (chatHistory.length > 50) {
      chatHistory = chatHistory.slice(-50);
    }
    io.emit("chatMessage", entry);
  });

  // ===== Žetonu veikals =====
  socket.on("buyToken", () => {
    if ((user.coins || 0) < 150) {
      return socket.emit("shopError", {
        msg: "Nepietiek coins (vajag 150).",
      });
    }
    user.coins -= 150;
    user.tokens = (user.tokens || 0) + 1;
    saveUsers();
    socket.emit("statsUpdate", {
      ...getStatsPayload(user),
      gainedXP: 0,
      gainedCoins: 0,
      dailyBonus: 0,
    });
  });

  // ===== Admin BAN =====
  socket.on("adminBanProfile", (data) => {
    if (!socket.data.isAdmin) return;

    const targetId = data && data.playerId;
    if (!targetId) return;

    bannedUserIds.add(targetId);

    for (const s of io.sockets.sockets.values()) {
      const u = s.data.user;
      if (u && u.id === targetId) {
        s.emit("banned", {
          reason: "Tavs profils ir bloķēts VĀRDU ZONA spēlē.",
        });
        s.disconnect(true);
      }
    }
  });

  socket.on("disconnect", () => {
    console.log("Atslēdzās:", user.username);
    broadcastOnline();
  });
});

// ===== Coins par online laiku (piem., 1 coin / 60 sek) =====

setInterval(() => {
  const gain = 1;
  for (const s of io.sockets.sockets.values()) {
    const u = s.data.user;
    if (!u) continue;
    u.coins = (u.coins || 0) + gain;
    ensureUserStats(u);
    s.emit("coinUpdate", {
      coins: u.coins,
      gained: gain,
    });
  }
  saveUsers();
}, 60_000);

// ===== Start =====

httpServer.listen(PORT, () => {
  console.log("VĀRDU ZONA serveris klausās uz porta:", PORT);
});
