// server.js — Bugats Wordle serveris (Node + Socket.IO) ar XP + rankiem

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
// XP grinds – jo tālāk, jo nenormāli grūti
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
function normalizeWord(str) {
  if (!str) return "";
  // noņem garumzīmes u.c. diakritiskās zīmes
  let s = str
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // ā → a, ē → e, š → s, utt.

  // atstājam tikai latīņu burtus
  s = s.replace(/[^a-z]/g, "");
  return s;
}

// saliek stāvokļus priekš katra burta
function evaluateGuess(guessNorm, targetNorm) {
  const len = targetNorm.length;
  const result = Array(len).fill("absent");
  const targetArr = targetNorm.split("");
  const guessArr = guessNorm.split("");

  // vispirms precīzie (pareizā vietā)
  for (let i = 0; i < len; i++) {
    if (guessArr[i] === targetArr[i]) {
      result[i] = "correct";
      targetArr[i] = null; // šo burtu vairāk nelietot
    }
  }

  // pēc tam "ir vārdā, bet citā vietā"
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

// ===== Words.txt ielāde =====
let WORD_LIST = [];

function loadWords() {
  const filePath = path.join(__dirname, "words.txt");
  const txt = fs.readFileSync(filePath, "utf8");

  WORD_LIST = txt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      return {
        raw: line,
        norm: normalizeWord(line),
      };
    })
    .filter((w) => w.norm.length === 5); // tikai 5-burtu vārdi

  console.log(`Loaded ${WORD_LIST.length} words with length 5 from words.txt`);
}

loadWords();

// ===== Leaderboard ar XP =====
// nick -> { wins, games, xp }
const leaderboard = new Map();

function updateLeaderboard(nick, isWin, attemptsUsed, maxAttempts) {
  if (!nick) return;
  if (!leaderboard.has(nick)) {
    leaderboard.set(nick, { wins: 0, games: 0, xp: 0 });
  }
  const entry = leaderboard.get(nick);

  entry.games += 1;
  if (isWin) {
    entry.wins += 1;
  }

  // XP piešķiršana:
  // Win: 50 pamata XP + 10 XP par katru atlikušos mēģinājumu
  // Lose: 5 XP (mazs, bet kaut kas)
  let xpGain = 0;
  if (isWin) {
    const attemptsLeft = Math.max(0, maxAttempts - attemptsUsed);
    xpGain = 50 + attemptsLeft * 10;
  } else {
    xpGain = 5;
  }

  entry.xp += xpGain;
}

function getLeaderboardList() {
  return Array.from(leaderboard.entries())
    .map(([nick, data]) => ({
      nick,
      wins: data.wins,
      games: data.games,
      xp: data.xp,
      rank: getRankName(data.xp),
    }))
    // sortē pēc XP, tad pēc uzvarām
    .sort((a, b) => b.xp - a.xp || b.wins - a.wins || a.games - b.games)
    .slice(0, 20);
}

// ===== Express + Socket.IO =====
const app = express();

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// Startē jaunu raundu vienam socketam
function startNewRound(socket) {
  if (!WORD_LIST.length) {
    loadWords();
  }

  const pick = WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)];
  socket.data.currentWordRaw = pick.raw.toUpperCase();  // priekš parādīšanas, ja vajag
  socket.data.currentWordNorm = pick.norm;              // salīdzināšanai
  socket.data.attempts = 0;
  socket.data.finishedRound = false;

  socket.emit("roundStarted", { maxAttempts: MAX_ATTEMPTS });
}

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.data.nick = "Guest";
  socket.data.attempts = 0;
  socket.data.finishedRound = false;
  socket.data.currentWordRaw = null;
  socket.data.currentWordNorm = null;

  socket.on("join", ({ nick }) => {
    const safeNick = (nick || "Guest").toString().trim().slice(0, 20);
    socket.data.nick = safeNick || "Guest";

    // sūtam pašreizējo leaderboard
    socket.emit("leaderboard", getLeaderboardList());

    // sākam raundu
    startNewRound(socket);
  });

  socket.on("newRound", () => {
    // vienkārši sākam jaunu raundu (katram savs vārds)
    startNewRound(socket);
  });

  socket.on("guess", ({ word }) => {
    if (typeof word !== "string") {
      return socket.emit("guessResult", {
        error: true,
        msg: "Nederīgs vārds.",
      });
    }

    if (!socket.data.currentWordNorm) {
      return socket.emit("guessResult", {
        error: true,
        msg: "Raunds vēl nav sācies.",
      });
    }

    const guessRaw = word.trim();
    const guessNorm = normalizeWord(guessRaw);

    if (guessNorm.length !== socket.data.currentWordNorm.length) {
      return socket.emit("guessResult", {
        error: true,
        msg: `Jābūt ${socket.data.currentWordNorm.length} burtiem.`,
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
    const result = evaluateGuess(guessNorm, socket.data.currentWordNorm);
    const isWin = result.every((r) => r === "correct");
    const finishedRound = isWin || socket.data.attempts >= MAX_ATTEMPTS;

    const remainingAttempts = Math.max(
      0,
      MAX_ATTEMPTS - socket.data.attempts
    );

    // Pareizo vārdu sūtam TIKAI, ja ir uzvara
    let correctWordToSend = null;
    if (isWin) {
      correctWordToSend = socket.data.currentWordRaw;
    }

    if (finishedRound) {
      socket.data.finishedRound = true;
      updateLeaderboard(
        socket.data.nick,
        isWin,
        socket.data.attempts,
        MAX_ATTEMPTS
      );
      io.emit("leaderboard", getLeaderboardList());
    }

    socket.emit("guessResult", {
      error: false,
      result,
      isWin,
      finishedRound,
      correctWord: correctWordToSend,
      remainingAttempts,
    });
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

httpServer.listen(PORT, () => {
  console.log("Bugats Wordle server running on port", PORT);
});
