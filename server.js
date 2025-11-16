// server.js — VĀRDU ZONA serveris (Node + Socket.IO) ar
// XP, rankiem, streakiem, Dienas čempionu, PERSISTENCI,
// online spēlētāju sarakstu un real-time kill-feed.

// ========== IMPORTI ==========
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ========== KONSTANTES ==========
const PORT = process.env.PORT || 10080;
const MAX_ATTEMPTS = 6;

// Failā glabāsim visus spēlētājus + Dienas čempionu
const DATA_FILE = path.join(__dirname, "vardu-zona-data.json");

// ========== Ranku definīcijas ==========
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

// ========== Palīgfunkcijas vārdam ==========
// JAUNA VERSIJA — saglabā latviešu garumzīmes/mīkstinājumus.
function normalizeWord(str) {
  if (!str) return "";
  let s = str.toString().trim().toLowerCase();
  // atļaujam a–z + latviešu diakritiskos burtus
  s = s.replace(/[^a-zāčēģīķļņšūž]/g, "");
  return s;
}

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

// ========== words.txt ielāde (5-burtu) ==========
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

// ========== GLOBĀLAIS RAUNDS ==========
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

pickNewWord();

// ========== Spēlētāji + Dienas čempions (PERSISTENCE) ==========

const players = new Map(); // id -> playerObj
let dailyChampion = null;

// Kill-feed: pēdējie atminētāji
const recentSolves = []; // { name, xpGain, streak, ts }

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      console.log("DATA_FILE nav, sāku ar tukšu bāzi.");
      return;
    }
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const json = JSON.parse(raw);

    if (Array.isArray(json.players)) {
      json.players.forEach((p) => {
        if (!p.id || !p.name) return;
        const player = {
          id: p.id,
          name: p.name,
          xp: p.xp || 0,
          wins: p.wins || 0,
          games: p.games || 0,
          streak: p.streak || 0,
          bestStreak: p.bestStreak || 0,
          rankTitle: p.rankTitle || getRankName(p.xp || 0),
          lastSeenAt: p.lastSeenAt || Date.now(),
        };
        players.set(player.id, player);
      });
    }

    if (json.dailyChampion) {
      dailyChampion = json.dailyChampion;
    }

    console.log(
      `Ielādēti ${players.size} spēlētāji no faila un dailyChampion = ${
        dailyChampion ? dailyChampion.name + " (" + dailyChampion.date + ")" : "nav"
      }`
    );
  } catch (err) {
    console.error("Kļūda ielādējot DATA_FILE:", err);
  }
}

function saveData() {
  try {
    const data = {
      players: Array.from(players.values()),
      dailyChampion,
      // recentSolves nav jāsaglabā
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("Kļūda saglabājot DATA_FILE:", err);
  }
}

loadData();

// Helperis – šodienas datums (YYYY-MM-DD)
function todayString() {
  return new Date().toISOString().slice(0, 10);
}

// Tagad identitāte = nika string mazajiem burtiem
function getPlayerIdFromAuth(auth) {
  let name = (auth.name || "Spēlētājs").toString().trim().slice(0, 20);
  if (!name) name = "Spēlētājs";
  const id = name.toLowerCase(); // 1 niks = 1 profils
  return { id, name };
}

function getOrCreatePlayer(socket) {
  const auth = socket.handshake.auth || {};
  const { id, name } = getPlayerIdFromAuth(auth);

  let player = players.get(id);
  if (!player) {
    player = {
      id,
      name,
      xp: 0,
      wins: 0,
      games: 0,
      streak: 0,
      bestStreak: 0,
      rankTitle: getRankName(0),
      lastSeenAt: Date.now(),
    };
    players.set(id, player);
    saveData();
  } else {
    player.name = name;
    player.lastSeenAt = Date.now();
    saveData();
  }
  return player;
}

function buildLeaderboard() {
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

// Online saraksts
function buildOnlinePlayers(io) {
  const result = [];
  const seenIds = new Set();

  for (const [, socket] of io.sockets.sockets) {
    if (!socket.rooms.has("game")) continue;
    const auth = socket.handshake.auth || {};
    const { id } = getPlayerIdFromAuth(auth);
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const p = players.get(id);
    result.push({
      id,
      name: p?.name || auth.name || "Spēlētājs",
      xp: p?.xp || 0,
      rankTitle: p?.rankTitle || (p ? getRankName(p.xp) : "Jauniņais I"),
      cid: auth.cid || null,
    });
  }

  result.sort((a, b) => b.xp - a.xp);
  return result;
}

function broadcastOnlinePlayers(io) {
  const list = buildOnlinePlayers(io);
  io.to("game").emit("onlinePlayers", { players: list });
}

// Kill-feed helperis
function pushSolveAndBroadcast(io, player, xpGain) {
  const entry = {
    name: player.name,
    xpGain,
    streak: player.streak || 0,
    ts: Date.now(),
  };

  recentSolves.unshift(entry);
  if (recentSolves.length > 15) {
    recentSolves.pop();
  }

  io.to("game").emit("wordSolvedFeed", {
    name: entry.name,
    xpGain: entry.xpGain,
    streak: entry.streak,
  });
}

// ========== XP piešķiršana + Dienas čempions ==========
function applyResult(io, socket, isWin) {
  const player = getOrCreatePlayer(socket);
  player.games += 1;

  let xpGain = 0;
  let dailyBonus = 0;

  if (isWin) {
    player.wins += 1;
    player.streak = (player.streak || 0) + 1;
    if (player.streak > player.bestStreak) {
      player.bestStreak = player.streak;
    }

    const attemptsUsed = socket.data.attempts || 0;
    const attemptsLeft = Math.max(0, MAX_ATTEMPTS - attemptsUsed);

    xpGain = 50 + attemptsLeft * 10;
    if (player.streak >= 2) {
      xpGain += player.streak * 10;
    }

    const today = todayString();
    if (!dailyChampion || dailyChampion.date !== today) {
      dailyChampion = {
        date: today,
        playerId: player.id,
        name: player.name,
      };

      dailyBonus = 100;
      xpGain += dailyBonus;

      io.to("game").emit("dailyChampionUpdate", {
        name: player.name,
        date: today,
        bonusXp: dailyBonus,
      });

      console.log(
        `[DAILY] Jauns Dienas čempions: ${player.name} (${today}), bonus +${dailyBonus} XP`
      );
    }
  } else {
    xpGain = 5;
    player.streak = 0;
  }

  player.xp += xpGain;
  player.rankTitle = getRankName(player.xp);
  player.lastSeenAt = Date.now();

  saveData();

  const statsPayload = {
    xp: player.xp,
    wins: player.wins,
    streak: player.streak,
    bestStreak: player.bestStreak,
    rankTitle: player.rankTitle,
    gainedXP: xpGain,
    dailyBonus,
  };

  socket.emit("statsUpdate", statsPayload);

  if (isWin) {
    pushSolveAndBroadcast(io, player, xpGain);
  }

  io.to("game").emit("leaderboardUpdate", {
    players: buildLeaderboard(),
  });

  console.log(
    `[XP] ${isWin ? "WIN" : "FAIL"} ${player.name} → +${xpGain} XP (kopā ${
      player.xp
    }), streak ${player.streak}`
  );
}

// ========== Express + Socket.IO ==========
const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true, roundId: currentRoundId });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// ========== SOCKET.IO loģika ==========
io.on("connection", (socket) => {
  socket.join("game");
  const player = getOrCreatePlayer(socket);
  socket.data.attempts = 0;

  const onlinePlayers = buildOnlinePlayers(io);

  socket.emit("hello", {
    wordLength: currentWord.norm.length,
    maxAttempts: MAX_ATTEMPTS,
    roundId: currentRoundId,
    stats: {
      xp: player.xp,
      wins: player.wins,
      streak: player.streak,
      bestStreak: player.bestStreak,
      rankTitle: player.rankTitle,
    },
    leaderboard: buildLeaderboard(),
    onlineCount: getOnlineCount(io),
    onlinePlayers,
    recentSolves: recentSolves.map((e) => ({
      name: e.name,
      xpGain: e.xpGain,
      streak: e.streak,
    })),
  });

  if (dailyChampion && dailyChampion.date === todayString()) {
    socket.emit("dailyChampionUpdate", {
      name: dailyChampion.name,
      date: dailyChampion.date,
      bonusXp: 0,
    });
  }

  io.to("game").emit("onlineCount", { count: getOnlineCount(io) });
  broadcastOnlinePlayers(io);

  socket.on("guess", (payload) => {
    try {
      if (!payload || typeof payload.word !== "string") {
        return socket.emit("guessResult", {
          error: true,
          msg: "Nederīgs vārds.",
        });
      }

      const { word, roundId } = payload;

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

      socket.emit("guessResult", {
        letters,
        isWin,
        attemptsLeft,
      });

      if (isWin) {
        applyResult(io, socket, true);
        return;
      }

      if (attemptsLeft <= 0) {
        applyResult(io, socket, false);
      }
    } catch (err) {
      console.error("guess error", err);
      socket.emit("guessResult", {
        error: true,
        msg: "Kļūda apstrādājot minējumu.",
      });
    }
  });

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
  });

  socket.on("disconnect", () => {
    io.to("game").emit("onlineCount", { count: getOnlineCount(io) });
    broadcastOnlinePlayers(io);
  });
});

// ========== STARTS ==========
httpServer.listen(PORT, () => {
  console.log("VĀRDU ZONA server running on port", PORT);
});
