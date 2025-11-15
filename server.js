// server.js — Bugats Wordle (multiplayer scoreboard)

// ====== IMPORTI ======
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

// ====== BĀZES SETUP ======
const app = express();
app.use(cors());

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 10000;

// ====== WORDLE KONFIGS ======
const MAX_ATTEMPTS = 6;

// Vienkāršs 5-burtu vārdu saraksts (vari nomainīt uz LV vārdiem)
const WORDS = [
  "CHAIR", "PIPER", "GREEN", "BUGAT", "APPLE",
  "STONE", "LIGHT", "WATER", "HEART", "SMILE",
  "NIGHT", "MUSIC", "SUPER", "POWER", "GAMES",
  "WORLD", "PEACE", "TIGER", "LEVEL", "POINT",
  "SMOKE", "FLASH", "BRAIN", "SWEET", "STORM"
];

function randomWord() {
  const idx = Math.floor(Math.random() * WORDS.length);
  return WORDS[idx].toUpperCase();
}

// ====== SERVERA STĀVOKLIS ======
/*
 players: Map(socket.id -> {
   nick: string,
   wins: number,
   currentWord: string,
   attempts: number,
   roundFinished: boolean
 })
*/
const players = new Map();

// ====== PALĪGFUNKCIJAS ======
function createPlayer(socket, nick) {
  const cleanNick = String(nick || "").trim() || ("Viesis-" + socket.id.slice(0, 4));

  const player = {
    nick: cleanNick,
    wins: 0,
    currentWord: randomWord(),
    attempts: 0,
    roundFinished: false
  };

  players.set(socket.id, player);
  console.log(`Player joined: ${player.nick} (${socket.id})`);

  // Nosūtām info tikai konkrētajam spēlētājam
  socket.emit("joined", {
    nick: player.nick,
    maxAttempts: MAX_ATTEMPTS,
    wordLength: player.currentWord.length
  });
}

function startNewRoundFor(socketId) {
  const player = players.get(socketId);
  if (!player) return;

  player.currentWord = randomWord();
  player.attempts = 0;
  player.roundFinished = false;

  const socket = io.sockets.sockets.get(socketId);
  if (socket) {
    socket.emit("roundStarted", {
      wordLength: player.currentWord.length,
      maxAttempts: MAX_ATTEMPTS
    });
  }
}

function buildLeaderboard() {
  const list = [];
  for (const [, p] of players) {
    list.push({ nick: p.nick, wins: p.wins });
  }
  // Sakārto pēc uzvarām
  list.sort((a, b) => b.wins - a.wins);
  // top 20 pietiek
  return list.slice(0, 20);
}

function broadcastLeaderboard() {
  io.emit("leaderboard", buildLeaderboard());
}

function evaluateGuess(guess, target) {
  const len = target.length;
  const result = new Array(len).fill("absent");

  const tArr = target.split("");
  const gArr = guess.split("");

  const count = {};
  for (const ch of tArr) {
    count[ch] = (count[ch] || 0) + 1;
  }

  // Zaļie
  for (let i = 0; i < len; i++) {
    if (gArr[i] === tArr[i]) {
      result[i] = "correct";
      count[gArr[i]]--;
    }
  }

  // Dzeltenie
  for (let i = 0; i < len; i++) {
    if (result[i] === "correct") continue;
    const ch = gArr[i];
    if (count[ch] > 0) {
      result[i] = "present";
      count[ch]--;
    }
  }

  return result;
}

// ====== SOCKET.IO LOĢIKA ======
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // Pievienošanās ar niku
  socket.on("join", (payload) => {
    try {
      const nick = payload?.nick || "";
      createPlayer(socket, nick);
      broadcastLeaderboard();
    } catch (err) {
      console.error("join error:", err);
      socket.emit("errorMessage", { msg: "Kļūda pievienojoties." });
    }
  });

  // Jauns raunds (spēlētājs spiež "Jauna spēle")
  socket.on("newRound", () => {
    const player = players.get(socket.id);
    if (!player) return;
    startNewRoundFor(socket.id);
  });

  // Minējums
  socket.on("guess", (payload) => {
    const word = String(payload?.word || "").toUpperCase().trim();
    const player = players.get(socket.id);
    if (!player) return;

    if (player.roundFinished) {
      socket.emit("guessResult", {
        error: true,
        msg: "Raunds jau beidzies. Spied 'Jauna spēle'."
      });
      return;
    }

    if (!/^[A-Z]{5}$/.test(word)) {
      socket.emit("guessResult", {
        error: true,
        msg: "Jābūt tieši 5 burtiem (A–Z)."
      });
      return;
    }

    if (player.attempts >= MAX_ATTEMPTS) {
      socket.emit("guessResult", {
        error: true,
        msg: "Mēģinājumi beigušies. Spied 'Jauna spēle'."
      });
      player.roundFinished = true;
      return;
    }

    player.attempts++;

    const target = player.currentWord;
    const result = evaluateGuess(word, target);
    const isWin = word === target;

    let finishedRound = false;
    let correctWord = null;

    if (isWin) {
      player.wins++;
      finishedRound = true;
      correctWord = target;
      player.roundFinished = true;
      console.log(`WIN: ${player.nick} uzminēja ${target}`);
      broadcastLeaderboard();
    } else if (player.attempts >= MAX_ATTEMPTS) {
      finishedRound = true;
      correctWord = target;
      player.roundFinished = true;
      console.log(`LOSE: ${player.nick} neuzminēja ${target}`);
    }

    socket.emit("guessResult", {
      error: false,
      word,
      result,
      isWin,
      remainingAttempts: Math.max(0, MAX_ATTEMPTS - player.attempts),
      finishedRound,
      correctWord // parāda tikai pašam spēlētājam
    });
  });

  socket.on("disconnect", () => {
    const p = players.get(socket.id);
    if (p) {
      console.log(`Client disconnected: ${p.nick} (${socket.id})`);
      players.delete(socket.id);
      broadcastLeaderboard();
    } else {
      console.log(`Client disconnected: ${socket.id}`);
    }
  });
});

// ====== START ======
httpServer.listen(PORT, () => {
  console.log("Bugats Wordle server running on port", PORT);
});
