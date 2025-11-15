// Bugats Wordle serveris ar words.txt
// Saderīgs ar front-end (join, guess, newRound, leaderboard, guessResult)

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10000;
const MAX_ATTEMPTS = 6;

// ===== Helper: normalizē latviešu burtus uz A-Z =====
const LV_MAP = {
  "ā": "a",
  "č": "c",
  "ē": "e",
  "ģ": "g",
  "ī": "i",
  "ķ": "k",
  "ļ": "l",
  "ņ": "n",
  "š": "s",
  "ū": "u",
  "ž": "z",
};

function normalizeWord(raw) {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(/[āčēģīķļņšūž]/g, ch => LV_MAP[ch] || ch)
    .replace(/[^a-z]/g, "");
}

// ===== Ielādējam words.txt =====
let WORD_LIST = [];

try {
  const txt = fs.readFileSync(path.join(__dirname, "words.txt"), "utf8");

  WORD_LIST = txt
    .split(/\r?\n/)
    .map(line => normalizeWord(line))
    .filter(w => w.length === 5); // tikai 5-burtu vārdi

  console.log("Loaded words from words.txt:", WORD_LIST.length);

  if (WORD_LIST.length === 0) {
    console.warn("⚠️ words.txt nav neviena korekta 5-burtu vārda pēc normalizācijas!");
    WORD_LIST = ["bugat", "prime", "spels", "vards", "lauks"]; // rezerves
  }
} catch (err) {
  console.error("❌ Neizdevās nolasīt words.txt:", err);
  WORD_LIST = ["bugat", "prime", "spels", "vards", "lauks"];
}

function getRandomWord() {
  return WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)].toUpperCase();
}

// ===== Spēles stāvoklis =====
let currentWord = getRandomWord();
let leaderboard = {}; // { nick: wins }

console.log("First word:", currentWord);

// ===== Express + Socket.IO =====
const app = express();
app.use(cors());

app.get("/health", (req, res) => {
  res.json({ ok: true, wordLength: currentWord.length });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// ===== Leaderboard palīgfunkcija =====
function formatLeaderboard() {
  return Object.entries(leaderboard)
    .map(([nick, wins]) => ({ nick, wins }))
    .sort((a, b) => b.wins - a.wins)
    .slice(0, 50);
}

// ===== Socket.IO loģika =====
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.data.attempts = 0;
  socket.data.nick = "Guest" + socket.id.slice(-4);

  socket.on("join", ({ nick }) => {
    if (typeof nick === "string" && nick.trim().length > 0) {
      socket.data.nick = nick.trim().slice(0, 20);
    }
    socket.data.attempts = 0;

    socket.emit("joined", { nick: socket.data.nick });
    socket.emit("roundStarted", { maxAttempts: MAX_ATTEMPTS });

    io.emit("leaderboard", formatLeaderboard());
  });

  socket.on("newRound", () => {
    currentWord = getRandomWord();
    console.log("New round word:", currentWord);

    socket.data.attempts = 0;
    socket.emit("roundStarted", { maxAttempts: MAX_ATTEMPTS });
  });

  socket.on("guess", ({ word }) => {
    if (!word || typeof word !== "string") {
      return socket.emit("guessResult", {
        error: true,
        msg: "Nederīgs vārds.",
      });
    }

    const guessRaw = word.trim().toLowerCase();
    const guessNorm = normalizeWord(guessRaw).toUpperCase();

    if (guessNorm.length !== currentWord.length) {
      return socket.emit("guessResult", {
        error: true,
        msg: `Jābūt ${currentWord.length} burtiem.`,
      });
    }

    if (typeof socket.data.attempts !== "number") {
      socket.data.attempts = 0;
    }
    if (socket.data.attempts >= MAX_ATTEMPTS) {
      return socket.emit("guessResult", {
        error: true,
        msg: "Nav atlikušo mēģinājumu. Spied 'Jauna spēle'.",
      });
    }

    socket.data.attempts++;
    const remainingAttempts = Math.max(0, MAX_ATTEMPTS - socket.data.attempts);

    const target = currentWord;
    const result = new Array(target.length);
    const targetLetters = target.split("");

    // Zaļie
    for (let i = 0; i < guessNorm.length; i++) {
      if (guessNorm[i] === targetLetters[i]) {
        result[i] = "correct";
        targetLetters[i] = "*";
      }
    }

    // Dzeltenie / pelēkie
    for (let i = 0; i < guessNorm.length; i++) {
      if (!result[i]) {
        const idx = targetLetters.indexOf(guessNorm[i]);
        if (idx !== -1) {
          result[i] = "present";
          targetLetters[idx] = "*";
        } else {
          result[i] = "absent";
        }
      }
    }

    const isWin = guessNorm === target;
    let finishedRound = false;
    let correctWordToSend = undefined;

    if (isWin) {
      finishedRound = true;
      correctWordToSend = target;
      const nick = socket.data.nick || "Guest";
      leaderboard[nick] = (leaderboard[nick] || 0) + 1;

      io.emit("leaderboard", formatLeaderboard());

      // serverī uzreiz sagatavojam nākamo vārdu
      currentWord = getRandomWord();
      console.log("Word solved by", socket.data.nick, "-> new word:", currentWord);
    } else if (remainingAttempts <= 0) {
      finishedRound = true;
      correctWordToSend = target;
    }

    socket.emit("guessResult", {
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

// ===== START =====
httpServer.listen(PORT, () => {
  console.log("Bugats Wordle server running on port", PORT);
});
