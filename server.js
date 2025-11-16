// server.js — VĀRDU ZONA serveris (Node + Socket.IO) ar:
// - XP, rankiem, streakiem
// - Dienas vārdu + Dienas čempionu
// - Unikāliem nikiem (Bugats, Bugats 2, Bugats 3, ...)

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== Konstantes =====
const PORT = process.env.PORT || 10080;
const MAX_ATTEMPTS = 6;

// ===== Ranku definīcijas (XP threshold) =====
const RANKS = [
  { name: "Jauniņais I", xp: 0 },
  { name: "Jauniņais II", xp: 100 },
  { name: "Meklētājs I", xp: 250 },
  { name: "Meklētājs II", xp: 500 },
  { name: "Vārdu Mednieks I", xp: 800 },
  { name: "Vārdu Mednieks II", xp: 1200 },
  { name: "Vārdu Šāvējs I", xp: 1700 },
  { name: "Vārdu Šāvējs II", xp: 2300 },
  { name: "Vārdu Burvis I", xp: 3000 },
  { name: "Vārdu Burvis II", xp: 3800 },
  { name: "Lingo Leģenda I", xp: 4700 },
  { name: "Lingo Leģenda II", xp: 5700 },
  { name: "Bugats Čempions I", xp: 7000 },
  { name: "Bugats Čempions II", xp: 8500 },
  { name: "Bugats Elites I", xp: 10000 },
  { name: "Bugats Elites II", xp: 12000 },
  { name: "Bugats Imperators I", xp: 15000 },
  { name: "Bugats Imperators II", xp: 19000 },
  { name: "Valodas Dievs", xp: 24000 },
];

function getRankName(xp) {
  let current = RANKS[0]?.name || "Jauniņais I";
  for (const r of RANKS) {
    if (xp >= r.xp) current = r.name;
    else break;
  }
  return current;
}

// ===== Palīgfunkcijas =====

// normalizē: mazajiem burtiem, noņem diakritikas un visu, kas nav a–z
function normalizeWord(str) {
  if (!str) return "";
  let s = str
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  s = s.replace(/[^a-z]/g, "");
  return s;
}

// vērtē minējumu: atgriež masīvu ["correct"|"present"|"absent", ...]
function evaluateGuess(guessNorm, targetNorm) {
  const len = targetNorm.length;
  const result = Array(len).fill("absent");
  const targetArr = targetNorm.split("");
  const guessArr = guessNorm.split("");

  // precīzie
  for (let i = 0; i < len; i++) {
    if (guessArr[i] === targetArr[i]) {
      result[i] = "correct";
      targetArr[i] = null;
    }
  }

  // ir vārdā, citā vietā
  for (let i = 0; i < len; i++) {
    if (result[i] === "correct") continue;
    const idx = targetArr.indexOf(guessArr[i]);
    if (idx !== -1) {
      result[i] = "present";
      targetArr[idx] = null;
    }
  }

  return result;
}

// ===== Words.txt ielāde (5-burtu vārdi) =====
let WORD_LIST = [];

function loadWords() {
  const filePath = path.join(__dirname, "words.txt");
  const txt = fs.readFileSync(filePath, "utf8");

  WORD_LIST = txt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => ({
      raw: line,
      norm: normalizeWord(line),
    }))
    .filter((w) => w.norm.length === 5);

  console.log(`Loaded ${WORD_LIST.length} words with length 5 from words.txt`);
}

loadWords();

// ===== Globālais raunds visiem spēlētājiem =====
let currentWord = null; // { raw, norm }
let currentRoundId = 1;

function pickNewWord() {
  if (!WORD_LIST.length) {
    loadWords();
  }
  const prev = currentWord ? currentWord.raw : null;
  let candidate;
  do {
    candidate = WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)];
  } while (WORD_LIST.length > 1 && candidate.raw === prev);

  currentWord = candidate;
  currentRoundId += 1;
  console.log("Jauns vārds:", currentWord.raw, "| raunds:", currentRoundId);
}

// sākuma vārds
pickNewWord();

// ===== Dienas vārds / čempions =====
let dailyState = {
  dateKey: null,        // "YYYY-MM-DD"
  roundId: null,        // kādam raundam šodien piesaistīts Dienas vārds
  championId: null,
  championName: null,
};

function getTodayKey() {
  return new Date().toISOString().slice(0, 10); // pietiek ar UTC
}

function ensureDailyRound() {
  const today = getTodayKey();
  if (dailyState.dateKey !== today) {
    // jauna diena → šībrīža vārds kļūst par dienas vārdu
    dailyState = {
      dateKey: today,
      roundId: currentRoundId,
      championId: null,
      championName: null,
    };
    console.log(
      "[DAILY] Jauna diena:",
      today,
      "| roundId:",
      currentRoundId,
      "| vārds:",
      currentWord?.raw
    );
  }
}

// ===== Spēlētāji ar XP (24h RAM) =====
const players = new Map(); // id -> playerObj

function getPlayerId(socket) {
  const auth = socket.handshake.auth || {};
  return auth.cid || socket.id;
}

// Unikāla nika ģenerēšana: Bugats, Bugats 2, Bugats 3, ...
function getUniqueName(desired, idForThisPlayer) {
  let base = desired || "Spēlētājs";
  base = base.trim();
  if (!base) base = "Spēlētājs";

  const taken = new Set();
  for (const p of players.values()) {
    if (p.id !== idForThisPlayer) {
      taken.add(p.name.toLowerCase());
    }
  }

  let name = base;
  let i = 2;
  while (taken.has(name.toLowerCase())) {
    name = `${base} ${i}`;
    i++;
  }
  return name;
}

function getOrCreatePlayer(socket) {
  const id = getPlayerId(socket);
  const auth = socket.handshake.auth || {};
  let desiredName = (auth.name || "Spēlētājs").toString().trim().slice(0, 20);
  if (!desiredName) desiredName = "Spēlētājs";

  let player = players.get(id);

  if (!player) {
    const uniqueName = getUniqueName(desiredName, id);
    player = {
      id,
      name: uniqueName,
      xp: 0,
      wins: 0,
      games: 0,
      streak: 0,
      bestStreak: 0,
      rankTitle: getRankName(0),
      lastSeenAt: Date.now(),
    };
    players.set(id, player);
  } else {
    // ja klients atnāk ar citu niku – mēģinām atjaunot, bet saglabājam unikalitāti
    const uniqueName = getUniqueName(desiredName, id);
    player.name = uniqueName;
    player.lastSeenAt = Date.now();
  }

  return player;
}

function buildLeaderboard() {
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;

  // tīrām vecos (24h)
  for (const [id, p] of players.entries()) {
    if (now - p.lastSeenAt > DAY_MS) {
      players.delete(id);
    }
  }

  return Array.from(players.values())
    .sort((a, b) => {
      if (b.xp !== a.xp) return b.xp - a.xp;
      if (b.wins !== a.wins) return b.wins - a.wins;
      return a.games - b.games;
    })
    .slice(0, 20)
    .map((p) => ({
      id: p.id,
      name: p.name,
      xp: p.xp,
      wins: p.wins,
      streak: p.streak,
      bestStreak: p.bestStreak,
      rankTitle: p.rankTitle,
    }));
}

function getOnlineCount(io) {
  const room = io.sockets.adapter.rooms.get("game");
  return room ? room.size : 0;
}

// ===== XP piešķiršana (ar Dienas čempiona bonusu) =====
function applyResult(io, socket, { isWin, isDailyChampion }) {
  const player = getOrCreatePlayer(socket);
  player.games += 1;

  let xpGain = 0;

  if (isWin) {
    player.wins += 1;
    player.streak = (player.streak || 0) + 1;
    if (player.streak > player.bestStreak) {
      player.bestStreak = player.streak;
    }

    const attemptsUsed = socket.data.attempts || 0;
    const attemptsLeft = Math.max(0, MAX_ATTEMPTS - attemptsUsed);

    // pamat XP par uzvaru
    xpGain = 50 + attemptsLeft * 10;
    if (player.streak >= 2) {
      xpGain += player.streak * 10;
    }

    // Dienas čempiona bonuss tikai pirmajam
    if (isDailyChampion) {
      xpGain += 150; // varēsim vēlāk pielāgot, ja gribēsi
    }
  } else {
    // par zaudējumu ļoti mazs XP
    xpGain = 5;
    player.streak = 0;
  }

  player.xp += xpGain;
  player.rankTitle = getRankName(player.xp);

  const statsPayload = {
    xp: player.xp,
    wins: player.wins,
    streak: player.streak,
    bestStreak: player.bestStreak,
    rankTitle: player.rankTitle,
    gainedXP: xpGain,
  };

  // šim spēlētājam statistika
  socket.emit("statsUpdate", statsPayload);

  // visiem – leaderboard
  io.to("game").emit("leaderboardUpdate", {
    players: buildLeaderboard(),
  });

  console.log(
    `[XP] ${isWin ? "WIN" : "FAIL"} ${player.name} → +${xpGain} XP (kopā ${
      player.xp
    }), streak ${player.streak}${
      isDailyChampion ? " [DAILY CHAMPION]" : ""
    }`
  );
}

// ===== Express + Socket.IO =====
const app = express();

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    roundId: currentRoundId,
    daily: {
      dateKey: dailyState.dateKey,
      roundId: dailyState.roundId,
      championName: dailyState.championName || null,
    },
  });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// ===== Socket.IO loģika =====
io.on("connection", (socket) => {
  socket.join("game");

  // parūpējamies, ka Dienas vārds ir iestatīts šai dienai
  ensureDailyRound();

  const player = getOrCreatePlayer(socket);
  socket.data.attempts = 0;

  // sākuma info klientam: script.js gaida "hello"
  socket.emit("hello", {
    wordLength: currentWord.norm.length,
    maxAttempts: MAX_ATTEMPTS,
    roundId: currentRoundId,
    finalName: player.name, // UNIKĀLI labotais niks
    stats: {
      xp: player.xp,
      wins: player.wins,
      streak: player.streak,
      bestStreak: player.bestStreak,
      rankTitle: player.rankTitle,
    },
    leaderboard: buildLeaderboard(),
    onlineCount: getOnlineCount(io),
    dailyChampion: dailyState.championName
      ? { name: dailyState.championName, dateKey: dailyState.dateKey }
      : null,
  });

  // online skaits visiem
  io.to("game").emit("onlineCount", { count: getOnlineCount(io) });

  // ===== Minējums =====
  socket.on("guess", (payload) => {
    try {
      ensureDailyRound();

      if (!payload || typeof payload.word !== "string") {
        return socket.emit("guessResult", {
          error: true,
          msg: "Nederīgs vārds.",
        });
      }

      const { word, roundId } = payload;

      // ja raunds starp klientu un serveri neatbilst
      if (roundId !== currentRoundId) {
        return socket.emit("guessResult", {
          error: true,
          msg: "Raunds jau ir mainījies. Spied 'Jauna spēle'.",
        });
      }

      if (!currentWord || !currentWord.norm) {
        return socket.emit("guessResult", {
          error: true,
          msg: "Raunds vēl nav gatavs.",
        });
      }

      const guessRaw = word.trim();
      const guessNorm = normalizeWord(guessRaw);
      const display = guessRaw.toUpperCase();

      if (guessNorm.length !== currentWord.norm.length) {
        return socket.emit("guessResult", {
          error: true,
          msg: `Jābūt ${currentWord.norm.length} burtiem.`,
        });
      }

      if (typeof socket.data.attempts !== "number") {
        socket.data.attempts = 0;
      }
      if (socket.data.attempts >= MAX_ATTEMPTS) {
        return socket.emit("guessResult", {
          error: true,
          msg: "Mēģinājumi beigušies.",
        });
      }

      socket.data.attempts += 1;

      const statuses = evaluateGuess(guessNorm, currentWord.norm);
      const letters = statuses.map((st, i) => ({
        letter: display[i],
        status: st,
      }));

      const isWin = statuses.every((s) => s === "correct");
      const attemptsLeft = Math.max(0, MAX_ATTEMPTS - socket.data.attempts);

      // tas, ko script.js gaida: letters, isWin, attemptsLeft
      socket.emit("guessResult", {
        letters,
        isWin,
        attemptsLeft,
      });

      // XP + Dienas čempions
      const playerNow = getOrCreatePlayer(socket);

      if (isWin) {
        let isDailyChampion = false;

        const today = getTodayKey();
        if (
          dailyState.dateKey === today &&
          dailyState.roundId === currentRoundId &&
          !dailyState.championId
        ) {
          // pirmais, kas šodien atmin Dienas vārdu
          dailyState.championId = playerNow.id;
          dailyState.championName = playerNow.name;
          isDailyChampion = true;

          io.to("game").emit("dailyChampionUpdate", {
            name: dailyState.championName,
            dateKey: dailyState.dateKey,
            bonusXp: 150,
          });
        }

        applyResult(io, socket, { isWin: true, isDailyChampion });
        return;
      }

      if (attemptsLeft <= 0) {
        // zaudējums, vārdu NEatklājam
        applyResult(io, socket, { isWin: false, isDailyChampion: false });
      }
    } catch (err) {
      console.error("guess error", err);
      socket.emit("guessResult", {
        error: true,
        msg: "Kļūda apstrādājot minējumu.",
      });
    }
  });

  // ===== Jauna spēle =====
  socket.on("requestNewRound", () => {
    pickNewWord();
    for (const [, s] of io.sockets.sockets) {
      s.data.attempts = 0;
    }
    io.to("game").emit("newRound", {
      roundId: currentRoundId,
      wordLength: currentWord.norm.length,
      maxAttempts: MAX_ATTEMPTS,
    });

    // ja jauna diena – pārliekam Dienas vārdu uz jauno raundu
    ensureDailyRound();
  });

  socket.on("disconnect", () => {
    io.to("game").emit("onlineCount", { count: getOnlineCount(io) });
  });
});

// ===== Start =====
httpServer.listen(PORT, () => {
  console.log("VĀRDU ZONA server running on port", PORT);
});
