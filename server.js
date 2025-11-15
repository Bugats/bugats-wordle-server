// server.js — VĀRDU ZONA (Bugats Wordle) serveris
// Node + Socket.IO, izmanto words.txt

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ======= KONST =======
const PORT = process.env.PORT || 10080;
const MAX_ATTEMPTS = 6;

// ======= PALĪGFUNKCIJAS =======

function normalizeWord(word) {
  // pārvēršam uz augšējiem burtiem un noņemam garumzīmes salīdzināšanai
  const map = {
    "ā": "A","Ā": "A",
    "č": "C","Č": "C",
    "ē": "E","Ē": "E",
    "ģ": "G","Ģ": "G",
    "ī": "I","Ī": "I",
    "ķ": "K","Ķ": "K",
    "ļ": "L","Ļ": "L",
    "ņ": "N","Ņ": "N",
    "š": "S","Š": "S",
    "ū": "U","Ū": "U",
    "ž": "Z","Ž": "Z"
  };
  return (word || "")
    .split("")
    .map(ch => map[ch] || ch.toUpperCase())
    .join("");
}

function loadWords() {
  const filePath = path.join(__dirname, "words.txt");
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).map(x => x.trim()).filter(Boolean);

  const list = [];
  for (const line of lines) {
    const orig = line;
    const norm = normalizeWord(orig);
    if (norm.length !== 5) continue; // spēle ir 5-burtu
    list.push({ original: orig, normalized: norm });
  }
  if (list.length === 0) {
    throw new Error("words.txt neatrod nevienu 5-burtu vārdu!");
  }
  return list;
}

const WORDS = loadWords();

// ======= SPĒLES STATUSS =======

let currentWord = null; // { original, normalized }
let currentRoundId = 1;
let lastRoundStart = Date.now();

// spēlētāju dati (24h robežās RAM)
const players = new Map(); // id -> playerObj

function pickNewWord() {
  const prev = currentWord ? currentWord.original : null;
  let candidate;
  do {
    candidate = WORDS[Math.floor(Math.random() * WORDS.length)];
  } while (WORDS.length > 1 && candidate.original === prev);

  currentWord = candidate;
  currentRoundId += 1;
  lastRoundStart = Date.now();
  console.log("Jauns vārds:", currentWord.original, "round", currentRoundId);
}

pickNewWord();

// ======= Player helperi =======

function getPlayerIdFromSocket(socket) {
  const auth = socket.handshake.auth || {};
  return auth.cid || socket.id;
}

function getOrCreatePlayer(socket) {
  const id = getPlayerIdFromSocket(socket);
  let player = players.get(id);
  if (!player) {
    const auth = socket.handshake.auth || {};
    let name = auth.name || "Spēlētājs";
    name = String(name).trim().slice(0, 20) || "Spēlētājs";

    player = {
      id,
      name,
      xp: 0,
      wins: 0,
      streak: 0,
      bestStreak: 0,
      rankTitle: "Jauniņais I",
      lastSeenAt: Date.now()
    };
    players.set(id, player);
  } else {
    player.lastSeenAt = Date.now();
  }
  return player;
}

function calcRankTitle(xp) {
  if (xp >= 500) return "Vārdu leģenda";
  if (xp >= 250) return "Vārdu meistars";
  if (xp >= 120) return "Vārdu mednieks";
  if (xp >= 50) return "Jauniņais II";
  return "Jauniņais I";
}

function buildLeaderboardArray() {
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;

  // izmetam sen neredzētos (vairāk par 24h)
  for (const [id, p] of players.entries()) {
    if (now - p.lastSeenAt > DAY_MS) {
      players.delete(id);
    }
  }

  return Array.from(players.values())
    .sort((a, b) => {
      if (b.xp !== a.xp) return b.xp - a.xp;
      if (b.wins !== a.wins) return b.wins - a.wins;
      return b.bestStreak - a.bestStreak;
    })
    .slice(0, 20)
    .map(p => ({
      id: p.id,
      name: p.name,
      xp: p.xp,
      wins: p.wins,
      streak: p.streak,
      bestStreak: p.bestStreak,
      rankTitle: p.rankTitle
    }));
}

function getOnlineCount() {
  const room = io.sockets.adapter.rooms.get("game");
  return room ? room.size : 0;
}

// ======= XP piešķiršana =======

function applyWinXP(socket) {
  const player = getOrCreatePlayer(socket);

  player.wins += 1;
  player.streak += 1;
  if (player.streak > player.bestStreak) {
    player.bestStreak = player.streak;
  }

  const gainedXP = 10 + player.streak * 5; // 10 XP + 5 XP par katru streaku
  player.xp += gainedXP;
  player.rankTitle = calcRankTitle(player.xp);

  const statsPayload = {
    xp: player.xp,
    wins: player.wins,
    streak: player.streak,
    bestStreak: player.bestStreak,
    rankTitle: player.rankTitle,
    gainedXP
  };

  socket.emit("statsUpdate", statsPayload);
  io.to("game").emit("leaderboardUpdate", {
    players: buildLeaderboardArray()
  });
}

function applyFail(socket) {
  const player = getOrCreatePlayer(socket);
  player.streak = 0;
  const statsPayload = {
    xp: player.xp,
    wins: player.wins,
    streak: player.streak,
    bestStreak: player.bestStreak,
    rankTitle: player.rankTitle,
    gainedXP: 0
  };
  socket.emit("statsUpdate", statsPayload);
  io.to("game").emit("leaderboardUpdate", {
    players: buildLeaderboardArray()
  });
}

// ======= GUESS SCORE =======

function scoreGuess(guessNorm, targetNorm, guessDisplay) {
  const len = targetNorm.length;
  const result = new Array(len);
  const targetChars = targetNorm.split("");
  const used = new Array(len).fill(false);

  // 1. Pareizie burti pareizajās vietās
  for (let i = 0; i < len; i++) {
    const g = guessNorm[i];
    if (g === targetNorm[i]) {
      result[i] = {
        letter: guessDisplay[i] || guessNorm[i],
        status: "correct"
      };
      used[i] = true;
    }
  }

  // 2. Pareizie burti nepareizajās vietās
  for (let i = 0; i < len; i++) {
    if (result[i]) continue;
    const g = guessNorm[i];
    let foundIndex = -1;
    for (let j = 0; j < len; j++) {
      if (!used[j] && targetChars[j] === g) {
        foundIndex = j;
        break;
      }
    }
    if (foundIndex >= 0) {
      result[i] = {
        letter: guessDisplay[i] || guessNorm[i],
        status: "present"
      };
      used[foundIndex] = true;
    } else {
      result[i] = {
        letter: guessDisplay[i] || guessNorm[i],
        status: "absent"
      };
    }
  }

  return result;
}

// ======= SOCKET.IO =======

io.on("connection", (socket) => {
  socket.join("game");

  const player = getOrCreatePlayer(socket);
  socket.data.attempts = 0;

  // Sveiciena pakete klientam
  socket.emit("hello", {
    wordLength: currentWord.normalized.length,
    maxAttempts: MAX_ATTEMPTS,
    roundId: currentRoundId,
    stats: {
      xp: player.xp,
      wins: player.wins,
      streak: player.streak,
      bestStreak: player.bestStreak,
      rankTitle: player.rankTitle
    },
    leaderboard: buildLeaderboardArray(),
    onlineCount: getOnlineCount()
  });

  // jauns online skaits visiem
  io.to("game").emit("onlineCount", { count: getOnlineCount() });

  // ======= GUESS =======
  socket.on("guess", (payload) => {
    try {
      if (!payload || typeof payload.word !== "string") {
        return socket.emit("guessResult", {
          error: true,
          msg: "Nederīgs vārds."
        });
      }
      const { word, roundId } = payload;

      if (roundId !== currentRoundId) {
        return socket.emit("guessResult", {
          error: true,
          msg: "Raunds jau ir mainījies. Spied 'Jauna spēle'."
        });
      }

      const guessRaw = word.trim();
      const guessDisplay = guessRaw.toUpperCase();
      const guessNorm = normalizeWord(guessRaw);

      if (!guessNorm || guessNorm.length !== currentWord.normalized.length) {
        return socket.emit("guessResult", {
          error: true,
          msg: `Jābūt ${currentWord.normalized.length} burtiem.`
        });
      }

      if (typeof socket.data.attempts !== "number") {
        socket.data.attempts = 0;
      }
      if (socket.data.attempts >= MAX_ATTEMPTS) {
        return socket.emit("guessResult", {
          error: true,
          msg: "Vairs nav mēģinājumu."
        });
      }

      socket.data.attempts += 1;

      const letters = scoreGuess(
        guessNorm,
        currentWord.normalized,
        guessDisplay
      );
      const isWin = letters.every((l) => l.status === "correct");
      const attemptsLeft = MAX_ATTEMPTS - socket.data.attempts;

      socket.emit("guessResult", {
        letters,
        isWin,
        attemptsLeft
      });

      if (isWin) {
        applyWinXP(socket);
        return;
      }

      if (attemptsLeft <= 0) {
        // zaudējums: vārdu NEatklājam
        applyFail(socket);
      }
    } catch (err) {
      console.error("guess error", err);
      socket.emit("guessResult", {
        error: true,
        msg: "Kļūda apstrādājot minējumu."
      });
    }
  });

  // ======= JAUNAIS RAUNDS =======
  socket.on("requestNewRound", () => {
    // tikai viens process — lai nav spam
    pickNewWord();
    for (const [, s] of io.sockets.sockets) {
      s.data.attempts = 0;
    }
    io.to("game").emit("newRound", {
      roundId: currentRoundId,
      wordLength: currentWord.normalized.length,
      maxAttempts: MAX_ATTEMPTS
    });
  });

  socket.on("disconnect", () => {
    io.to("game").emit("onlineCount", { count: getOnlineCount() });
  });
});

// vienkāršs health-check
app.get("/health", (_req, res) => {
  res.json({ ok: true, roundId: currentRoundId });
});

server.listen(PORT, () => {
  console.log("Bugats VĀRDU ZONA server running on port", PORT);
});
