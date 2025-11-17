// server.js — VĀRDU ZONA serveris (Node + Socket.IO) ar
// XP, rankiem, streakiem, Dienas čempionu, PERSISTENCI,
// ONLINE sarakstu, kill-feed, ČATU, DIENAS MISIJĀM, COINS, ŽETONIEM,
// un ADMIN: BAN (pēc ID/CID), KICK, MUTE, UNBAN.

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

// COINS parametri
// 1 žetons = 100 coins
const COINS_PER_WIN_BASE = 3;        // bāze par uzvaru
const COINS_PER_ATTEMPT_LEFT = 1;    // +1 coin par katru atlikušā mēģinājuma punktu
const COINS_STREAK_MAX_BONUS = 5;    // max +5 coins par streak
// Coins par uzturēšanos spēlē: 1 coin ik pēc 10 min online
const COIN_TICK_MS = 10 * 60 * 1000; // 10 min
const COINS_PER_TICK = 1;

// Failā glabāsim visus spēlētājus + Dienas čempionu + BAN sarakstu
const DATA_FILE = path.join(__dirname, "vardu-zona-data.json");

// ========== Ranku definīcijas ==========
const RANKS = [
  { name: "Jauniņais I", xp: 0 },
  { name: "Jauniņais II", xp: 80 },
  { name: "Jauniņais III", xp: 180 },

  { name: "Vārdu Skolnieks I", xp: 320 },
  { name: "Vārdu Skolnieks II", xp: 500 },
  { name: "Vārdu Skolnieks III", xp: 720 },

  { name: "Vārdu Meklētājs I", xp: 1000 },
  { name: "Vārdu Meklētājs II", xp: 1350 },
  { name: "Vārdu Meklētājs III", xp: 1750 },

  { name: "Vārdu Mednieks I", xp: 2200 },
  { name: "Vārdu Mednieks II", xp: 2700 },
  { name: "Vārdu Mednieks III", xp: 3250 },

  { name: "Vārdu Šāvējs I", xp: 3850 },
  { name: "Vārdu Šāvējs II", xp: 4500 },
  { name: "Vārdu Šāvējs III", xp: 5200 },

  { name: "Vārdu Burvis I", xp: 5950 },
  { name: "Vārdu Burvis II", xp: 6750 },
  { name: "Vārdu Burvis III", xp: 7600 },

  { name: "Lingo Leģenda I", xp: 8500 },
  { name: "Lingo Leģenda II", xp: 9450 },
  { name: "Lingo Leģenda III", xp: 10450 },

  { name: "Lingo Čempions I", xp: 11550 },
  { name: "Lingo Čempions II", xp: 12750 },
  { name: "Lingo Čempions III", xp: 14050 },

  { name: "Valodas Imperators I", xp: 15450 },
  { name: "Valodas Imperators II", xp: 16950 },
  { name: "Valodas Imperators III", xp: 18550 },

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

// ========== DIENAS MISIJU BĀZE ==========
const MISSION_POOL = [
  {
    key: "fast_1",
    type: "fastWins",
    target: 1,
    xpReward: 25,
    coinsReward: 30,
    text: "Atmini 1 vārdu max 3 mēģinājumos",
  },
  {
    key: "win_1",
    type: "wins",
    target: 1,
    xpReward: 10,
    coinsReward: 15,
    text: "Atmini 1 vārdu šodien",
  },
  {
    key: "games_10",
    type: "games",
    target: 10,
    xpReward: 30,
    coinsReward: 40,
    text: "Nospēlē 10 raundus šodien",
  },
  {
    key: "wins_3",
    type: "wins",
    target: 3,
    xpReward: 40,
    coinsReward: 60,
    text: "Atmini 3 vārdus šodien",
  },
  {
    key: "games_5",
    type: "games",
    target: 5,
    xpReward: 20,
    coinsReward: 25,
    text: "Nospēlē 5 raundus šodien",
  },
  {
    key: "fast_2",
    type: "fastWins",
    target: 2,
    xpReward: 35,
    coinsReward: 50,
    text: "Atmini 2 vārdus max 3 mēģinājumos",
  },
];

function todayString() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// deterministisks random no dienas ID, lai misijas visiem shārējas
function seededRandomFromString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0) / 4294967296;
}

function pickMissionsForDay(dayId) {
  const pool = [...MISSION_POOL];
  const chosen = [];
  let r = seededRandomFromString(dayId);

  while (pool.length && chosen.length < 3) {
    r = (r * 9301 + 49297) % 233280;
    const idx = Math.floor((r / 233280) * pool.length);
    chosen.push(pool.splice(idx, 1)[0]);
  }
  return chosen;
}

let CURRENT_DAY_ID = todayString();
let CURRENT_DAILY_MISSIONS = pickMissionsForDay(CURRENT_DAY_ID);

function refreshDailyMissionsIfNeeded() {
  const today = todayString();
  if (today !== CURRENT_DAY_ID) {
    CURRENT_DAY_ID = today;
    CURRENT_DAILY_MISSIONS = pickMissionsForDay(CURRENT_DAY_ID);
    console.log(
      "[MISIJAS] Jauna diena",
      CURRENT_DAY_ID,
      "→",
      CURRENT_DAILY_MISSIONS.map((m) => m.key).join(", ")
    );
  }
}

// ========== Palīgfunkcijas vārdam ==========
function normalizeWord(str) {
  if (!str) return "";
  let s = str.toString().trim().toLowerCase();
  s = s.replace(/[^a-zāčēģīķļņšūž]/g, "");
  return s;
}

function evaluateGuess(guessNorm, targetNorm) {
  const len = targetNorm.length;
  const result = Array(len).fill("absent");
  const targetArr = targetNorm.split("");
  const guessArr = guessNorm.split("");

  // precīgie
  for (let i = 0; i < len; i++) {
    if (guessArr[i] === targetArr[i]) {
      result[i] = "correct";
      targetArr[i] = null;
    }
  }

  // ir vārdā citā vietā
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

// ========== words.txt ielāde (5–6 burtu) ==========
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
    .filter((w) => w.norm.length === 5 || w.norm.length === 6);

  console.log(
    `Loaded ${WORD_LIST.length} words (length 5–6) from words.txt`
  );
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
  console.log(
    "Jauns vārds:",
    currentWord.raw,
    "| garums:",
    currentWord.norm.length,
    "| raunds:",
    currentRoundId
  );
}

pickNewWord();

// ========== Spēlētāji + Dienas čempions ==========
const players = new Map(); // id (CID vai guest-...) -> playerObj
let dailyChampion = null;

// BAN saraksts: id (CID/guest-...) -> info
const bannedProfiles = new Map();

// MUTE saraksts: id -> { id, name, mutedUntil }
const mutedProfiles = new Map();

// Kill-feed: pēdējie atminētāji
const recentSolves = []; // { name, xpGain, coinsGain, streak, ts }

// ČATS: pēdējās ziņas atmiņā (nav failā)
let chatHistory = []; // { name, text, ts }

// Saglabā max 50 čata ziņas
function pushChatMessage(name, text) {
  chatHistory.push({
    name,
    text,
    ts: Date.now(),
  });
  while (chatHistory.length > 50) {
    chatHistory.shift();
  }
}

// Palīgs, lai pārbaudītu, vai niks jau aizņemts (izņemot konkrēto spēlētāju pēc id)
function isNameTaken(name, exceptId = null) {
  const target = (name || "").toString().trim().toLowerCase();
  if (!target) return false;

  for (const p of players.values()) {
    if (exceptId && p.id === exceptId) continue;
    const pName = (p.name || "").toString().trim().toLowerCase();
    if (pName === target) return true;
  }
  return false;
}

// Ja niks aizņemts, piešķiram Santa_2, Santa_3, ...
function makeUniqueName(baseName, selfId = null) {
  let name = (baseName || "Spēlētājs").toString().trim();
  if (!name) name = "Spēlētājs";

  if (!isNameTaken(name, selfId)) return name;

  let i = 2;
  while (true) {
    const candidate = `${name}_${i}`;
    if (!isNameTaken(candidate, selfId)) return candidate;
    i++;
  }
}

// ====== LOAD / SAVE ======
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
          coins: p.coins || 0,
          tokens: p.tokens || 0,
          wins: p.wins || 0,
          games: p.games || 0,
          streak: p.streak || 0,
          bestStreak: p.bestStreak || 0,
          rankTitle: p.rankTitle || getRankName(p.xp || 0),
          lastSeenAt: p.lastSeenAt || Date.now(),
          daily: p.daily || null,
        };
        players.set(player.id, player);
      });
    }

    if (Array.isArray(json.bannedProfiles)) {
      json.bannedProfiles.forEach((b) => {
        if (!b.id) return;
        bannedProfiles.set(b.id, {
          id: b.id,
          name: b.name || "Bloķēts spēlētājs",
          reason: b.reason || "Admin BAN",
          bannedAt: b.bannedAt || Date.now(),
        });
      });
    }

    if (json.dailyChampion) {
      dailyChampion = json.dailyChampion;
    }

    console.log(
      `Ielādēti ${players.size} spēlētāji, ` +
        `dailyChampion = ${
          dailyChampion ? dailyChampion.name + " (" + dailyChampion.date + ")" : "nav"
        }, banned = ${bannedProfiles.size}`
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
      bannedProfiles: Array.from(bannedProfiles.values()),
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("Kļūda saglabājot DATA_FILE:", err);
  }
}

loadData();

// ===== ADMIN (niks + CID) =====
const ADMIN_IDS = ["bugats"];              // niki (lower-case)
const ADMIN_CIDS = ["cid-cboqqj5n3fm"];    // tavs reālais CID no localStorage "vz_cid"

function isAdminSocket(socket) {
  const auth = socket.handshake.auth || {};
  const cid = auth.cid;
  const nameLower = (auth.name || "").toString().trim().toLowerCase();
  return ADMIN_IDS.includes(nameLower) && ADMIN_CIDS.includes(cid);
}

// ========== Spēlētāju identitāte ==========
// ID = CID (ja ir); niks tiek padarīts unikāls atsevišķi
function getPlayerIdFromAuth(auth) {
  let name = (auth.name || "Spēlētājs").toString().trim().slice(0, 20);
  if (!name) name = "Spēlētājs";

  const cid = auth.cid;
  let nameLower = name.toLowerCase();

  // Rezervējam niku "Bugats" tikai īstajam CID
  if (nameLower === "bugats" && !ADMIN_CIDS.includes(cid)) {
    name = "Bugats_fans";
    nameLower = name.toLowerCase();
  }

  // ID = CID (unikāls spēlētājs), ja nav CID, tad kaut kas no nika
  let id = cid || `guest-${nameLower}`;

  return { id, name };
}

// nodrošina, ka player.daily atbilst šodienai
function ensurePlayerDaily(player) {
  refreshDailyMissionsIfNeeded();
  if (!player.daily || player.daily.dayId !== CURRENT_DAY_ID) {
    player.daily = {
      dayId: CURRENT_DAY_ID,
      progress: {
        wins: 0,
        games: 0,
        fastWins: 0,
        completed: {}, // key -> true
      },
    };
  }
}

function getOrCreatePlayer(socket) {
  const auth = socket.handshake.auth || {};
  const { id, name: rawName } = getPlayerIdFromAuth(auth);

  let player = players.get(id);
  if (!player) {
    const finalName = makeUniqueName(rawName, id);

    player = {
      id,
      name: finalName,
      xp: 0,
      coins: 0,
      tokens: 0,
      wins: 0,
      games: 0,
      streak: 0,
      bestStreak: 0,
      rankTitle: getRankName(0),
      lastSeenAt: Date.now(),
      daily: null,
    };
    players.set(id, player);
  } else {
    // ja lietotājs nomaina niku – piemērojam unikālo variantu
    const finalName = makeUniqueName(rawName, id);
    player.name = finalName;
    player.lastSeenAt = Date.now();
    if (typeof player.coins !== "number") player.coins = 0;
    if (typeof player.tokens !== "number") player.tokens = 0;
  }

  ensurePlayerDaily(player);
  saveData();
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
      coins: p.coins || 0,
      tokens: p.tokens || 0,
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
      coins: p?.coins || 0,
      tokens: p?.tokens || 0,
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
function pushSolveAndBroadcast(io, player, xpGain, coinGain) {
  const entry = {
    name: player.name,
    xpGain,
    coinsGain: coinGain,
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
    coinsGain: entry.coinsGain,
  });
}

// ===== DIENAS MISIJU PROGRESS PER PLAYER =====
function updateDailyProgressOnRoundEnd(player, { isWin, attemptsUsed }) {
  ensurePlayerDaily(player);
  const prog = player.daily.progress;

  // skaitām šodienas statistiku
  prog.games += 1;
  if (isWin) {
    prog.wins += 1;
    if (attemptsUsed <= 3) {
      prog.fastWins += 1;
    }
  }

  const completedMissions = [];
  let extraXp = 0;
  let extraCoins = 0;

  for (const m of CURRENT_DAILY_MISSIONS) {
    if (prog.completed[m.key]) continue;

    let cur = 0;
    if (m.type === "wins") cur = prog.wins;
    else if (m.type === "games") cur = prog.games;
    else if (m.type === "fastWins") cur = prog.fastWins;

    if (cur >= m.target) {
      prog.completed[m.key] = true;
      extraXp += m.xpReward || 0;
      extraCoins += m.coinsReward || 0;
      completedMissions.push(m);
    }
  }

  return { completedMissions, extraXp, extraCoins };
}

// ========== XP + COINS piešķiršana + Dienas čempions ==========
function applyResult(io, socket, isWin) {
  const player = getOrCreatePlayer(socket);
  player.games += 1;

  let xpGain = 0;
  let coinGain = 0;
  let dailyBonus = 0;

  const attemptsUsed = socket.data.attempts || 0;
  const attemptsLeft = Math.max(0, MAX_ATTEMPTS - attemptsUsed);

  if (isWin) {
    player.wins += 1;
    player.streak = (player.streak || 0) + 1;
    if (player.streak > player.bestStreak) {
      player.bestStreak = player.streak;
    }

    // XP formula
    const baseXP = 5;
    const attemptsBonus = attemptsLeft * 2;
    const streakBonus =
      player.streak > 1 ? Math.min(player.streak - 1, 5) : 0;

    xpGain = baseXP + attemptsBonus + streakBonus;

    // COINS formula
    const baseCoins = COINS_PER_WIN_BASE;
    const attemptsCoinBonus = attemptsLeft * COINS_PER_ATTEMPT_LEFT;
    const streakCoinBonus =
      player.streak > 1
        ? Math.min(player.streak - 1, COINS_STREAK_MAX_BONUS)
        : 0;

    coinGain = baseCoins + attemptsCoinBonus + streakCoinBonus;

    // Dienas čempions
    const today = todayString();
    if (!dailyChampion || dailyChampion.date !== today) {
      dailyChampion = {
        date: today,
        playerId: player.id,
        name: player.name,
      };

      dailyBonus = 50;
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
    xpGain = 0;
    coinGain = 0;
    player.streak = 0;
  }

  // Dienas misijas
  const { completedMissions, extraXp, extraCoins } =
    updateDailyProgressOnRoundEnd(player, { isWin, attemptsUsed });

  xpGain += extraXp;
  coinGain += extraCoins;

  player.xp += xpGain;
  player.coins = (player.coins || 0) + coinGain;
  if (typeof player.tokens !== "number") player.tokens = 0;
  player.rankTitle = getRankName(player.xp);
  player.lastSeenAt = Date.now();

  saveData();

  const statsPayload = {
    xp: player.xp,
    coins: player.coins,
    tokens: player.tokens,
    wins: player.wins,
    streak: player.streak,
    bestStreak: player.bestStreak,
    rankTitle: player.rankTitle,
    gainedXP: xpGain,
    gainedCoins: coinGain,
    dailyBonus,
    dailyMissions: { missions: CURRENT_DAILY_MISSIONS },
    dailyProgress: player.daily ? player.daily.progress : null,
  };

  socket.emit("statsUpdate", statsPayload);

  // paziņojumi par pabeigtajām misijām
  if (completedMissions.length) {
    socket.emit("dailyMissionsCompleted", {
      missions: completedMissions.map((m) => ({
        key: m.key,
        text: m.text,
        xpReward: m.xpReward || 0,
        coinsReward: m.coinsReward || 0,
      })),
    });
    console.log(
      `[MISIJAS] ${player.name} pabeidza: ${completedMissions
        .map((m) => m.key)
        .join(", ")} (+${extraXp} XP, +${extraCoins} coins)`
    );
  }

  if (isWin) {
    pushSolveAndBroadcast(io, player, xpGain, coinGain);
  }

  io.to("game").emit("leaderboardUpdate", {
    players: buildLeaderboard(),
  });

  console.log(
    `[XP/COINS] ${isWin ? "WIN" : "FAIL"} ${player.name} → +${xpGain} XP, +${coinGain} coins (kopā ${player.xp} XP, ${player.coins} coins), streak ${player.streak}`
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
  const auth = socket.handshake.auth || {};
  const { id, name: rawName } = getPlayerIdFromAuth(auth);

  // BAN pārbaude jau pie pieslēgšanās — pēc ID (CID/guest-...)
  if (bannedProfiles.has(id)) {
    socket.emit("banned", {
      reason: "Tavs profils ir bloķēts VĀRDU ZONA spēlē.",
    });
    setTimeout(() => {
      socket.disconnect(true);
    }, 100);
    console.log("[BAN] Bloķēts profils mēģināja pieslēgties:", id, rawName);
    return;
  }

  socket.join("game");
  const player = getOrCreatePlayer(socket);
  socket.data.attempts = 0;
  socket.data.lastCoinTs = Date.now();

  refreshDailyMissionsIfNeeded();
  ensurePlayerDaily(player);

  const onlinePlayers = buildOnlinePlayers(io);

  socket.emit("hello", {
    wordLength: currentWord.norm.length,
    maxAttempts: MAX_ATTEMPTS,
    roundId: currentRoundId,
    stats: {
      xp: player.xp,
      coins: player.coins || 0,
      tokens: player.tokens || 0,
      wins: player.wins,
      streak: player.streak,
      bestStreak: player.bestStreak,
      rankTitle: player.rankTitle,
    },
    finalName: player.name,
    leaderboard: buildLeaderboard(),
    onlineCount: getOnlineCount(io),
    onlinePlayers,
    recentSolves: recentSolves.map((e) => ({
      name: e.name,
      xpGain: e.xpGain,
      streak: e.streak,
      coinsGain: e.coinsGain,
    })),
    chatHistory: chatHistory.map((m) => ({
      name: m.name,
      text: m.text,
    })),
    dailyMissions: { missions: CURRENT_DAILY_MISSIONS },
    dailyProgress: player.daily ? player.daily.progress : null,
    dailyChampion:
      dailyChampion && dailyChampion.date === todayString()
        ? { name: dailyChampion.name, date: dailyChampion.date }
        : null,
    isAdmin: isAdminSocket(socket),
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

  // ===== MINĒJUMS =====
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

  // ===== JAUNS RAUNDS =====
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

  // ===== ČATS =====
  socket.on("chatMessage", (data) => {
    try {
      const raw = (data && data.text) || "";
      let text = raw.toString().trim();
      if (!text) return;

      if (text.length > 140) {
        text = text.slice(0, 140);
      }

      const p = getOrCreatePlayer(socket);
      const name = p.name || "Spēlētājs";

      // MUTE pārbaude
      const mut = mutedProfiles.get(p.id);
      if (mut && mut.mutedUntil && Date.now() < mut.mutedUntil) {
        const msLeft = mut.mutedUntil - Date.now();
        const minutesLeft = Math.ceil(msLeft / 60000);
        socket.emit("muted", { minutes: minutesLeft });
        return;
      }

      pushChatMessage(name, text);

      io.to("game").emit("chatMessage", {
        name,
        text,
      });
    } catch (err) {
      console.error("chatMessage error:", err);
    }
  });

  // ===== ŽETONU PIRKŠANA =====
  socket.on("buyToken", () => {
    try {
      const player = getOrCreatePlayer(socket);
      if (typeof player.coins !== "number") player.coins = 0;
      if (typeof player.tokens !== "number") player.tokens = 0;

      if (player.coins < 100) {
        return socket.emit("shopError", {
          msg: "Nepietiek coins (vajag 100).",
        });
      }

      player.coins -= 100;
      player.tokens += 1;
      player.lastSeenAt = Date.now();
      saveData();

      socket.emit("statsUpdate", {
        xp: player.xp,
        coins: player.coins,
        tokens: player.tokens,
        wins: player.wins,
        streak: player.streak,
        bestStreak: player.bestStreak,
        rankTitle: player.rankTitle,
        gainedXP: 0,
        gainedCoins: 0,
        dailyBonus: 0,
        dailyMissions: { missions: CURRENT_DAILY_MISSIONS },
        dailyProgress: player.daily ? player.daily.progress : null,
      });

      io.to("game").emit("leaderboardUpdate", {
        players: buildLeaderboard(),
      });
      broadcastOnlinePlayers(io);

      console.log(
        `[SHOP] ${player.name} nopirka 1 žetonu → tokens = ${player.tokens}, coins = ${player.coins}`
      );
    } catch (err) {
      console.error("buyToken error:", err);
      socket.emit("shopError", {
        msg: "Neizdevās nopirkt žetonu.",
      });
    }
  });

  // ===== ADMIN: ŽETONU LABOŠANA =====
  socket.on("adminAdjustTokens", (payload = {}) => {
    try {
      if (!isAdminSocket(socket)) {
        console.log("[ADMIN] Neautorizēts mēģinājums adminAdjustTokens");
        return;
      }

      const nickname = (payload.nickname || "").toString().trim().slice(0, 20);
      const delta = Number(payload.deltaTokens || 0);

      if (!nickname || !delta) return;

      const targetNickLower = nickname.toLowerCase();

      // atrodam spēlētāju pēc nika (case-insensitive)
      let player = null;
      for (const p of players.values()) {
        const pNameLower = (p.name || "").toString().trim().toLowerCase();
        if (pNameLower === targetNickLower) {
          player = p;
          break;
        }
      }

      if (!player) {
        socket.emit("shopError", { msg: "Spēlētājs nav atrasts." });
        return;
      }

      if (typeof player.tokens !== "number") player.tokens = 0;
      player.tokens += delta;
      if (player.tokens < 0) player.tokens = 0;

      player.lastSeenAt = Date.now();
      saveData();

      // Atjaunojam stats šim playerim, ja viņš ir online
      for (const [, s] of io.sockets.sockets) {
        const auth = s.handshake.auth || {};
        const { id: sid } = getPlayerIdFromAuth(auth);
        if (sid === player.id) {
          s.emit("statsUpdate", {
            xp: player.xp,
            coins: player.coins || 0,
            tokens: player.tokens || 0,
            wins: player.wins,
            streak: player.streak,
            bestStreak: player.bestStreak,
            rankTitle: player.rankTitle,
            gainedXP: 0,
            gainedCoins: 0,
            dailyBonus: 0,
            dailyMissions: { missions: CURRENT_DAILY_MISSIONS },
            dailyProgress: player.daily ? player.daily.progress : null,
          });
        }
      }

      io.to("game").emit("leaderboardUpdate", {
        players: buildLeaderboard(),
      });
      broadcastOnlinePlayers(io);

      console.log(
        `[ADMIN] Žetoni laboti: ${player.name} (${player.id}) → ` +
          `${delta >= 0 ? "+" : ""}${delta}, tagad tokens = ${player.tokens}`
      );
    } catch (err) {
      console.error("adminAdjustTokens error:", err);
    }
  });

  // ===== ADMIN: PROFILA BAN (pēc ID/CID) =====
  socket.on("adminBanProfile", (payload = {}) => {
    try {
      if (!isAdminSocket(socket)) {
        console.log("[ADMIN] Neautorizēts mēģinājums adminBanProfile");
        return;
      }

      let playerId = (payload.playerId || "").toString();
      const nickname = (payload.nickname || "").toString().trim();

      if (!playerId && !nickname) return;

      let player = null;

      if (playerId) {
        player = players.get(playerId) || null;
      }

      if (!player && nickname) {
        const targetNickLower = nickname.toLowerCase();
        for (const p of players.values()) {
          const pNameLower = (p.name || "").toString().trim().toLowerCase();
          if (pNameLower === targetNickLower) {
            player = p;
            break;
          }
        }
      }

      if (!player) {
        socket.emit("shopError", {
          msg: "Spēlētājs nav atrasts (BAN).",
        });
        return;
      }

      const nameToBan = player.name || nickname || "Bloķēts spēlētājs";

      bannedProfiles.set(player.id, {
        id: player.id,
        name: nameToBan,
        reason: "Admin BAN",
        bannedAt: Date.now(),
      });
      saveData();

      console.log(`[ADMIN] BAN: ${nameToBan} (${player.id})`);

      // IZDZĒŠAM visas šī spēlētāja ziņas no čata vēstures
      const keyLower = (nameToBan || "").toString().trim().toLowerCase();
      chatHistory = chatHistory.filter(
        (m) =>
          (m.name || "").toString().trim().toLowerCase() !== keyLower
      );

      // paziņojam klientiem, lai vizuāli izņem šī nika ziņas
      io.to("game").emit("chatClearPlayer", { name: nameToBan });

      // izmetam visus soketus ar šo player.id
      for (const [, s] of io.sockets.sockets) {
        const auth = s.handshake.auth || {};
        const { id: sid } = getPlayerIdFromAuth(auth);
        if (sid === player.id) {
          s.emit("banned", {
            reason: "Tavs profils ir bloķēts VĀRDU ZONA spēlē.",
          });
          setTimeout(() => s.disconnect(true), 50);
        }
      }

      io.to("game").emit("onlineCount", { count: getOnlineCount(io) });
      broadcastOnlinePlayers(io);
    } catch (err) {
      console.error("adminBanProfile error:", err);
    }
  });

  // ===== ADMIN: KICK =====
  socket.on("adminKickProfile", (payload = {}) => {
    try {
      if (!isAdminSocket(socket)) {
        console.log("[ADMIN] Neautorizēts mēģinājums adminKickProfile");
        return;
      }

      let playerId = (payload.playerId || "").toString();
      const nickname = (payload.nickname || "").toString().trim();

      if (!playerId && nickname) {
        const targetNickLower = nickname.toLowerCase();
        for (const p of players.values()) {
          const pNameLower = (p.name || "").toString().trim().toLowerCase();
          if (pNameLower === targetNickLower) {
            playerId = p.id;
            break;
          }
        }
      }

      if (!playerId) {
        socket.emit("shopError", {
          msg: "Spēlētājs nav atrasts (kick).",
        });
        return;
      }

      for (const [, s] of io.sockets.sockets) {
        const auth = s.handshake.auth || {};
        const { id: sid } = getPlayerIdFromAuth(auth);
        if (sid === playerId) {
          s.emit("kicked", {
            reason: "Tu tiki izmests no istabas.",
          });
          setTimeout(() => s.disconnect(true), 50);
        }
      }

      io.to("game").emit("onlineCount", { count: getOnlineCount(io) });
      broadcastOnlinePlayers(io);
    } catch (err) {
      console.error("adminKickProfile error:", err);
    }
  });

  // ===== ADMIN: MUTE =====
  socket.on("adminMuteProfile", (payload = {}) => {
    try {
      if (!isAdminSocket(socket)) {
        console.log("[ADMIN] Neautorizēts mēģinājums adminMuteProfile");
        return;
      }

      let playerId = (payload.playerId || "").toString();
      const nickname = (payload.nickname || "").toString().trim();
      const minutes = Math.max(
        1,
        parseInt(payload.minutes || "5", 10) || 5
      );

      if (!playerId && nickname) {
        const targetNickLower = nickname.toLowerCase();
        for (const p of players.values()) {
          const pNameLower = (p.name || "").toString().trim().toLowerCase();
          if (pNameLower === targetNickLower) {
            playerId = p.id;
            break;
          }
        }
      }

      if (!playerId) {
        socket.emit("shopError", {
          msg: "Spēlētājs nav atrasts (mute).",
        });
        return;
      }

      const player = players.get(playerId);
      if (!player) {
        socket.emit("shopError", {
          msg: "Spēlētājs nav atrasts (mute).",
        });
        return;
      }

      const until = Date.now() + minutes * 60 * 1000;
      mutedProfiles.set(player.id, {
        id: player.id,
        name: player.name,
        mutedUntil: until,
      });

      // paziņojam mutētajam, ja viņš online
      for (const [, s] of io.sockets.sockets) {
        const auth = s.handshake.auth || {};
        const { id: sid } = getPlayerIdFromAuth(auth);
        if (sid === player.id) {
          s.emit("muted", { minutes });
        }
      }

      console.log(
        `[ADMIN] MUTE: ${player.name} (${player.id}) uz ${minutes} min.`
      );
    } catch (err) {
      console.error("adminMuteProfile error:", err);
    }
  });

  // ===== ADMIN: UNBAN (pēc ID vai nika) =====
  socket.on("adminUnbanProfile", (payload = {}) => {
    try {
      if (!isAdminSocket(socket)) {
        console.log("[ADMIN] Neautorizēts mēģinājums adminUnbanProfile");
        return;
      }

      const nickname = (payload.nickname || "").toString().trim();
      const explicitId = (payload.playerId || "").toString();

      let removed = false;

      if (explicitId && bannedProfiles.has(explicitId)) {
        bannedProfiles.delete(explicitId);
        removed = true;
      } else if (nickname) {
        const key = nickname.toLowerCase();
        let toDeleteId = null;
        for (const [id, bp] of bannedProfiles.entries()) {
          const nLower = (bp.name || "").toString().trim().toLowerCase();
          if (nLower === key) {
            toDeleteId = id;
            break;
          }
        }
        if (toDeleteId) {
          bannedProfiles.delete(toDeleteId);
          removed = true;
        }
      }

      if (removed) {
        saveData();
        console.log(
          `[ADMIN] UNBAN: ${
            explicitId || nickname || "nezināms"
          }`
        );
      } else {
        console.log(
          `[ADMIN] UNBAN: ${
            explicitId || nickname || "nezināms"
          } — nebija ban sarakstā`
        );
      }
    } catch (err) {
      console.error("adminUnbanProfile error:", err);
    }
  });

  // ===== ATVIENOŠANĀS =====
  socket.on("disconnect", () => {
    io.to("game").emit("onlineCount", { count: getOnlineCount(io) });
    broadcastOnlinePlayers(io);
  });
});

// ========== COINS PAR UZTURĒŠANOS ONLINE ==========
setInterval(() => {
  const now = Date.now();
  for (const [, socket] of io.sockets.sockets) {
    if (!socket.rooms.has("game")) continue;
    const player = getOrCreatePlayer(socket);
    if (!socket.data.lastCoinTs) {
      socket.data.lastCoinTs = now;
      continue;
    }
    const diff = now - socket.data.lastCoinTs;
    if (diff < COIN_TICK_MS) continue;

    const ticks = Math.floor(diff / COIN_TICK_MS);
    const gained = ticks * COINS_PER_TICK;
    if (gained <= 0) continue;

    player.coins = (player.coins || 0) + gained;
    if (typeof player.tokens !== "number") player.tokens = 0;
    socket.data.lastCoinTs += ticks * COIN_TICK_MS;

    socket.emit("coinUpdate", {
      coins: player.coins,
      gained,
    });
  }
  saveData();
}, COIN_TICK_MS);

// ========== STARTS ==========
httpServer.listen(PORT, () => {
  console.log("VĀRDU ZONA server running on port", PORT);
});
