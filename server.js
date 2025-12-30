// ======== VĀRDU ZONA — Bugats edition (server.js) ========
// Minimal working baseline + ABILITIES (REVEAL / +ROW / FREEZE)
// ESM (Render-friendly)

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ======== CONFIG ========
const PORT = process.env.PORT || 10080;
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME__JWT_SECRET";
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const USERS_PATH = path.join(DATA_DIR, "users.json");
const WORDS_PATH = path.join(DATA_DIR, "words.txt");

// Game rules
const BASE_ATTEMPTS = 6;
const ROUND_FIRST_LETTER_DELAY_MS = 20_000;
const ROUND_LOCK_MS = 1200;
const ROUND_TIME_MS = 180_000; // starts after first guess
const GUESS_RATE_MS = 1000;

// Ability rules
const ABILITY_TYPES = ["reveal", "extraRow", "freeze"];
const FREEZE_SECONDS = 5;

// ======== FS helpers ========
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function nowMs() {
  return Date.now();
}

function todayKeyUTC() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

// ======== Users store ========
ensureDir(DATA_DIR);
if (!fs.existsSync(USERS_PATH)) writeJsonAtomic(USERS_PATH, { users: [] });

function loadUsers() {
  const db = readJsonSafe(USERS_PATH, { users: [] });
  if (!db.users || !Array.isArray(db.users)) db.users = [];
  return db;
}
function saveUsers(db) {
  writeJsonAtomic(USERS_PATH, db);
}

function normUsername(u) {
  return String(u || "")
    .trim()
    .replace(/\s+/g, "")
    .toLowerCase();
}

function publicUser(u) {
  return {
    username: u.username,
    displayName: u.displayName || u.username,
    avatarUrl: u.avatarUrl || "",
    xp: u.xp || 0,
    coins: u.coins || 0,
    tokens: u.tokens || 0,
    streak: u.streak || 0,
    rank: u.rank || 1,
  };
}

function ensureUserAbilities(u) {
  if (!u.abilities || typeof u.abilities !== "object") {
    u.abilities = { reveal: 1, extraRow: 1, freeze: 1 };
  }
  for (const t of ABILITY_TYPES) {
    if (typeof u.abilities[t] !== "number") u.abilities[t] = 0;
  }

  if (!u.abilitiesLastRecharge) u.abilitiesLastRecharge = "";
  const tk = todayKeyUTC();
  if (u.abilitiesLastRecharge !== tk) {
    // Daily recharge: set to 1 each (simple + predictable)
    u.abilities = { reveal: 1, extraRow: 1, freeze: 1 };
    u.abilitiesLastRecharge = tk;
  }

  if (!u.abilityCooldowns || typeof u.abilityCooldowns !== "object") {
    u.abilityCooldowns = { revealUntil: 0, extraRowUntil: 0, freezeUntil: 0 };
  }
  if (typeof u.abilityCooldowns.revealUntil !== "number") u.abilityCooldowns.revealUntil = 0;
  if (typeof u.abilityCooldowns.extraRowUntil !== "number") u.abilityCooldowns.extraRowUntil = 0;
  if (typeof u.abilityCooldowns.freezeUntil !== "number") u.abilityCooldowns.freezeUntil = 0;
}

function ensureUserRoundState(u) {
  if (!u.currentRound || typeof u.currentRound !== "object") {
    u.currentRound = null;
  }
}

// ======== Words ========
function loadWords() {
  try {
    if (!fs.existsSync(WORDS_PATH)) {
      fs.writeFileSync(WORDS_PATH, "LATVIJA\nRĪGA\nSAULE\n", "utf8");
    }
    const raw = fs.readFileSync(WORDS_PATH, "utf8");
    return raw
      .split(/\r?\n/g)
      .map((w) => w.trim())
      .filter(Boolean)
      .map((w) => w.toUpperCase());
  } catch {
    return ["LATVIJA", "RĪGA", "SAULE"];
  }
}

const WORDS = loadWords();

function pickWord() {
  const idx = crypto.randomInt(0, WORDS.length);
  const w = WORDS[idx] || "LATVIJA";
  // If user uses variable length words list; keep as is.
  return w.toUpperCase();
}

// ======== Wordle eval (unicode-safe-ish) ========
function splitGraphemes(s) {
  // Good enough for LV letters; uses codepoints
  return Array.from(String(s || ""));
}
function evalGuess(word, guess) {
  const W = splitGraphemes(word.toUpperCase());
  const G = splitGraphemes(guess.toUpperCase());
  const n = W.length;

  const res = new Array(n).fill("absent");
  const counts = new Map();

  // first pass greens
  for (let i = 0; i < n; i++) {
    const w = W[i];
    const g = G[i];
    if (g === w) {
      res[i] = "correct";
    } else {
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }

  // second pass yellows
  for (let i = 0; i < n; i++) {
    if (res[i] === "correct") continue;
    const g = G[i];
    const c = counts.get(g) || 0;
    if (c > 0) {
      res[i] = "present";
      counts.set(g, c - 1);
    }
  }

  const isWin = res.every((x) => x === "correct");
  const firstGreen = res[0] === "correct";
  return { res, isWin, firstGreen };
}

// ======== Game state (global round) ========
let ROUND = {
  id: "INIT",
  word: pickWord(),
  startedAt: nowMs(),
  lockUntil: nowMs() + ROUND_LOCK_MS,
  firstLetterAt: nowMs() + ROUND_FIRST_LETTER_DELAY_MS,
  firstLetterSent: false,
  firstGuessAt: null,
  endsAt: null,
  freezeUntil: 0,
  freezeCaster: "",
  winner: "",
};

let roundTimer = null;
let firstLetterTimer = null;

function scheduleFirstLetter(io) {
  if (firstLetterTimer) clearTimeout(firstLetterTimer);
  const delay = Math.max(0, ROUND.firstLetterAt - nowMs());
  firstLetterTimer = setTimeout(() => {
    if (ROUND.firstLetterSent) return;
    ROUND.firstLetterSent = true;
    const letter = splitGraphemes(ROUND.word)[0] || "";
    io.emit("round:firstLetter", { letter, roundId: ROUND.id });
  }, delay);
}

function scheduleRoundEnd(io) {
  if (roundTimer) clearTimeout(roundTimer);
  if (!ROUND.endsAt) return;
  const delay = Math.max(0, ROUND.endsAt - nowMs());
  roundTimer = setTimeout(() => {
    endRound(io, { reason: "timer" });
  }, delay);
}

function newRoundId() {
  return crypto.randomBytes(3).toString("hex").toUpperCase(); // 6 chars
}

function startNewRound(io) {
  ROUND = {
    id: newRoundId(),
    word: pickWord(),
    startedAt: nowMs(),
    lockUntil: nowMs() + ROUND_LOCK_MS,
    firstLetterAt: nowMs() + ROUND_FIRST_LETTER_DELAY_MS,
    firstLetterSent: false,
    firstGuessAt: null,
    endsAt: null,
    freezeUntil: 0,
    freezeCaster: "",
    winner: "",
  };

  // reset per-user round state
  const db = loadUsers();
  for (const u of db.users) {
    ensureUserAbilities(u);
    ensureUserRoundState(u);

    // Join penalty: if you join after first guess, you start from next row.
    // Here (new round) everyone starts at 0.
    u.currentRound = {
      roundId: ROUND.id,
      attemptsUsed: 0,
      maxAttempts: BASE_ATTEMPTS,
      guesses: [],
      gotFirstGreenBonus: false,
      usedAbilities: { reveal: false, extraRow: false, freeze: false },
      revealedHints: [], // indices revealed via ability
      lastGuessAt: 0,
      wrongLenCount: 0,
      mutedUntil: 0,
    };
  }
  saveUsers(db);

  io.emit("round:new", {
    roundId: ROUND.id,
    wordLen: splitGraphemes(ROUND.word).length,
    lockMs: ROUND_LOCK_MS,
    firstLetterInMs: ROUND_FIRST_LETTER_DELAY_MS,
    startedAt: ROUND.startedAt,
  });

  scheduleFirstLetter(io);
}

function endRound(io, { reason }) {
  // announce, then auto next
  io.emit("round:end", { roundId: ROUND.id, reason, winner: ROUND.winner || "" });

  setTimeout(() => startNewRound(io), 2500);
}

// ======== Auth ========
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "30d" });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ======== Express app ========
const app = express();
app.use(express.json({ limit: "1mb" }));

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (CORS_ORIGINS.includes("*")) return cb(null, true);
      if (CORS_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked"), false);
    },
    credentials: true,
  })
);

app.get("/health", (req, res) => res.json({ ok: true }));

// Static (Hostinger front can proxy; keep for local)
app.use(express.static(path.join(__dirname, "public")));

// ======== REST auth ========
app.post("/api/signup", async (req, res) => {
  const usernameRaw = req.body?.username;
  const password = String(req.body?.password || "");
  const username = normUsername(usernameRaw);

  if (!username || username.length < 3) return res.status(400).json({ error: "Invalid username" });
  if (!password || password.length < 4) return res.status(400).json({ error: "Password too short" });

  const db = loadUsers();
  if (db.users.some((u) => u.username === username)) {
    return res.status(409).json({ error: "Username exists" });
  }

  const passHash = await bcrypt.hash(password, 10);
  const user = {
    username,
    displayName: username,
    passHash,
    createdAt: nowMs(),
    xp: 0,
    rank: 1,
    coins: 0,
    tokens: 0,
    streak: 0,
    avatarUrl: "",
    abilities: { reveal: 1, extraRow: 1, freeze: 1 },
    abilitiesLastRecharge: todayKeyUTC(),
    abilityCooldowns: { revealUntil: 0, extraRowUntil: 0, freezeUntil: 0 },
    currentRound: null,
  };

  db.users.push(user);
  saveUsers(db);

  const token = signToken({ username });
  return res.json({ token, me: publicUser(user) });
});

app.post("/api/login", async (req, res) => {
  const username = normUsername(req.body?.username);
  const password = String(req.body?.password || "");

  const db = loadUsers();
  const user = db.users.find((u) => u.username === username);
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const ok = await bcrypt.compare(password, user.passHash || "");
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  ensureUserAbilities(user);
  ensureUserRoundState(user);
  saveUsers(db);

  const token = signToken({ username });
  return res.json({ token, me: publicUser(user) });
});

app.get("/api/me", (req, res) => {
  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const payload = verifyToken(token);
  if (!payload?.username) return res.status(401).json({ error: "Unauthorized" });

  const db = loadUsers();
  const user = db.users.find((u) => u.username === payload.username);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  ensureUserAbilities(user);
  ensureUserRoundState(user);
  saveUsers(db);

  res.json({
    me: publicUser(user),
    abilities: user.abilities,
    abilityCooldowns: user.abilityCooldowns,
  });
});

app.get("/api/leaderboard", (req, res) => {
  const db = loadUsers();
  const top = [...db.users]
    .sort((a, b) => (b.xp || 0) - (a.xp || 0))
    .slice(0, 10)
    .map((u) => ({ username: u.username, avatarUrl: u.avatarUrl || "", xp: u.xp || 0 }));
  res.json({ top });
});

// ======== Socket.IO ========
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (CORS_ORIGINS.includes("*")) return cb(null, true);
      if (CORS_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked"), false);
    },
    credentials: true,
  },
});

function getUserByUsername(db, username) {
  return db.users.find((u) => u.username === username);
}

function abilitiesStatePayload(u) {
  return {
    charges: { ...u.abilities },
    cooldowns: { ...u.abilityCooldowns },
    usedThisRound: u.currentRound?.usedAbilities || { reveal: false, extraRow: false, freeze: false },
  };
}

function getRoundStateForClient(u) {
  const wordLen = splitGraphemes(ROUND.word).length;
  const cr = u.currentRound;
  return {
    roundId: ROUND.id,
    wordLen,
    startedAt: ROUND.startedAt,
    lockUntil: ROUND.lockUntil,
    firstLetterAt: ROUND.firstLetterAt,
    endsAt: ROUND.endsAt,
    winner: ROUND.winner || "",
    // player-specific
    attemptsUsed: cr?.attemptsUsed ?? 0,
    maxAttempts: cr?.maxAttempts ?? BASE_ATTEMPTS,
    guesses: cr?.guesses ?? [],
    freezeUntil: ROUND.freezeUntil || 0,
    freezeCaster: ROUND.freezeCaster || "",
  };
}

function ensureUserHasRound(db, u) {
  const wordLen = splitGraphemes(ROUND.word).length;

  if (!u.currentRound || u.currentRound.roundId !== ROUND.id) {
    // Join penalty: if round already started (first guess happened), start from next row (lose 1 attempt)
    const penalty = ROUND.firstGuessAt ? 1 : 0;
    u.currentRound = {
      roundId: ROUND.id,
      attemptsUsed: penalty,
      maxAttempts: BASE_ATTEMPTS,
      guesses: [],
      gotFirstGreenBonus: false,
      usedAbilities: { reveal: false, extraRow: false, freeze: false },
      revealedHints: [],
      lastGuessAt: 0,
      wrongLenCount: 0,
      mutedUntil: 0,
    };
  }

  // Safety clamps
  u.currentRound.attemptsUsed = Math.max(0, Math.min(u.currentRound.attemptsUsed || 0, BASE_ATTEMPTS + 3));
  u.currentRound.maxAttempts = Math.max(BASE_ATTEMPTS, Math.min(u.currentRound.maxAttempts || BASE_ATTEMPTS, BASE_ATTEMPTS + 3));
  if (!Array.isArray(u.currentRound.guesses)) u.currentRound.guesses = [];

  // If penalty already consumes all, keep it clamped
  if (u.currentRound.attemptsUsed >= u.currentRound.maxAttempts) {
    u.currentRound.attemptsUsed = Math.min(u.currentRound.attemptsUsed, u.currentRound.maxAttempts - 1);
  }

  // ensure guess objects structure
  u.currentRound.guesses = u.currentRound.guesses
    .filter((g) => g && typeof g === "object" && typeof g.guess === "string" && Array.isArray(g.res))
    .slice(0, u.currentRound.maxAttempts);

  // Keep wordLen compatibility (client relies on it)
  if (wordLen <= 0) return;
}

const online = new Map(); // socket.id -> username

io.use((socket, next) => {
  const token =
    socket.handshake.auth?.token ||
    socket.handshake.query?.token ||
    "";

  const payload = verifyToken(String(token));
  if (!payload?.username) return next(new Error("UNAUTHORIZED"));
  socket.data.username = payload.username;
  next();
});

io.on("connection", (socket) => {
  const username = socket.data.username;
  online.set(socket.id, username);

  // ensure round scheduled
  scheduleFirstLetter(io);

  // emit online list (simple)
  const onlineUsers = Array.from(new Set(Array.from(online.values()))).sort();
  io.emit("online:list", { users: onlineUsers });

  // init state
  {
    const db = loadUsers();
    const u = getUserByUsername(db, username);
    if (!u) {
      socket.emit("fatal", { error: "USER_NOT_FOUND" });
    } else {
      ensureUserAbilities(u);
      ensureUserHasRound(db, u);
      saveUsers(db);

      socket.emit("round:state", getRoundStateForClient(u));
      socket.emit("abilities:state", abilitiesStatePayload(u));
    }
  }

  socket.on("disconnect", () => {
    online.delete(socket.id);
    const onlineUsers = Array.from(new Set(Array.from(online.values()))).sort();
    io.emit("online:list", { users: onlineUsers });
  });

  // ======== GUESS ========
  socket.on("guess:submit", (payload = {}) => {
    const guessRaw = String(payload.guess || "");
    const guess = guessRaw.trim().toUpperCase();
    const t = nowMs();

    const db = loadUsers();
    const u = getUserByUsername(db, username);
    if (!u) return;

    ensureUserAbilities(u);
    ensureUserHasRound(db, u);

    const cr = u.currentRound;

    // round lock
    if (t < ROUND.lockUntil) {
      socket.emit("guess:reject", { reason: "LOCKED", msg: "Mazliet pagaidi..." });
      return;
    }

    // freeze check (freeze affects everyone except caster)
    if (t < (ROUND.freezeUntil || 0) && (ROUND.freezeCaster || "") !== username) {
      socket.emit("guess:reject", { reason: "FROZEN", msg: "FREEZE aktīvs..." });
      return;
    }

    // round ended
    if (ROUND.winner) {
      socket.emit("guess:reject", { reason: "ENDED", msg: "Raunds jau beidzies." });
      return;
    }

    // muted for wrong length spam
    if (t < (cr.mutedUntil || 0)) {
      socket.emit("guess:reject", { reason: "MUTED", msg: "Pārāk bieži. Pagaidi..." });
      return;
    }

    const wordLen = splitGraphemes(ROUND.word).length;

    // length check
    if (splitGraphemes(guess).length !== wordLen) {
      cr.wrongLenCount = (cr.wrongLenCount || 0) + 1;
      if (cr.wrongLenCount >= 3) {
        cr.mutedUntil = t + 10_000;
        cr.wrongLenCount = 0;
        saveUsers(db);
        socket.emit("guess:reject", { reason: "WRONG_LEN_MUTE", msg: "Nepareizs garums. Mute 10s." });
        return;
      }
      saveUsers(db);
      socket.emit("guess:reject", { reason: "WRONG_LEN", msg: `Vārdam jābūt ${wordLen} burti.` });
      return;
    }

    // rate limit
    if (t - (cr.lastGuessAt || 0) < GUESS_RATE_MS) {
      socket.emit("guess:reject", { reason: "RATE", msg: "1 minējums sekundē." });
      return;
    }
    cr.lastGuessAt = t;

    // start global timer on first guess
    if (!ROUND.firstGuessAt) {
      ROUND.firstGuessAt = t;
      ROUND.endsAt = t + ROUND_TIME_MS;
      scheduleRoundEnd(io);
      io.emit("round:timer", { roundId: ROUND.id, endsAt: ROUND.endsAt });
    }

    // attempts check
    if ((cr.attemptsUsed || 0) >= (cr.maxAttempts || BASE_ATTEMPTS)) {
      socket.emit("guess:reject", { reason: "NO_ATTEMPTS", msg: "Nav mēģinājumu." });
      saveUsers(db);
      return;
    }

    const { res, isWin, firstGreen } = evalGuess(ROUND.word, guess);

    cr.guesses.push({ guess, res, at: t });
    cr.attemptsUsed = (cr.attemptsUsed || 0) + 1;

    // scoring (simple)
    u.coins = Number(u.coins || 0);
    u.xp = Number(u.xp || 0);

    let gainCoins = 0;
    let gainXp = 0;

    // +2 for first green position (pos 0), once per round
    if (firstGreen && !cr.gotFirstGreenBonus) {
      cr.gotFirstGreenBonus = true;
      gainCoins += 2;
      gainXp += 2;
    }

    if (isWin) {
      gainCoins += 10;
      gainXp += 10;
      ROUND.winner = username;

      io.emit("round:winner", { roundId: ROUND.id, winner: username });

      // end round quickly
      setTimeout(() => endRound(io, { reason: "winner" }), 1200);
    }

    u.coins += gainCoins;
    u.xp += gainXp;

    // rank (very simple)
    u.rank = Math.max(1, Math.floor((u.xp || 0) / 200) + 1);

    saveUsers(db);

    socket.emit("guess:result", {
      roundId: ROUND.id,
      guess,
      res,
      attemptsUsed: cr.attemptsUsed,
      maxAttempts: cr.maxAttempts,
      gainCoins,
      gainXp,
      coins: u.coins,
      xp: u.xp,
      rank: u.rank,
    });

    // leaderboard push
    const top = [...db.users]
      .sort((a, b) => (b.xp || 0) - (a.xp || 0))
      .slice(0, 10)
      .map((x) => ({ username: x.username, avatarUrl: x.avatarUrl || "", xp: x.xp || 0 }));
    io.emit("leaderboard:top10", { top });
  });

  // ======== ABILITIES ========
  socket.on("ability:use", (payload = {}) => {
    const type = String(payload.type || "").trim();
    if (!ABILITY_TYPES.includes(type)) return;

    const t = nowMs();
    const db = loadUsers();
    const u = getUserByUsername(db, username);
    if (!u) return;

    ensureUserAbilities(u);
    ensureUserHasRound(db, u);
    const cr = u.currentRound;

    // round checks
    if (ROUND.winner) {
      socket.emit("ability:reject", { type, msg: "Raunds beidzies." });
      return;
    }
    if (t < ROUND.lockUntil) {
      socket.emit("ability:reject", { type, msg: "Pagaidi 1s..." });
      return;
    }
    if (!cr || cr.roundId !== ROUND.id) {
      socket.emit("ability:reject", { type, msg: "Nav aktīva raunda." });
      return;
    }

    // already used this round?
    if (cr.usedAbilities?.[type]) {
      socket.emit("ability:reject", { type, msg: "Šo ability šajā raundā jau izmantoji." });
      return;
    }

    // charges
    if ((u.abilities?.[type] || 0) <= 0) {
      socket.emit("ability:reject", { type, msg: "Nav charges (gaidi daily recharge)." });
      return;
    }

    // cooldown
    const cdKey = type === "reveal" ? "revealUntil" : type === "extraRow" ? "extraRowUntil" : "freezeUntil";
    if ((u.abilityCooldowns?.[cdKey] || 0) > t) {
      socket.emit("ability:reject", { type, msg: "Cooldown..." });
      return;
    }

    // Execute
    if (type === "reveal") {
      const wordChars = splitGraphemes(ROUND.word);
      const wordLen = wordChars.length;

      const revealed = Array.isArray(cr.revealedHints) ? cr.revealedHints : [];
      const available = [];
      for (let i = 0; i < wordLen; i++) if (!revealed.includes(i)) available.push(i);
      const idx = available.length
        ? available[crypto.randomInt(0, available.length)]
        : crypto.randomInt(0, wordLen);

      const letter = wordChars[idx] || "";
      cr.revealedHints = [...new Set([...(cr.revealedHints || []), idx])];

      u.abilities.reveal -= 1;
      cr.usedAbilities.reveal = true;
      u.abilityCooldowns.revealUntil = t + 20_000;

      saveUsers(db);

      socket.emit("ability:reveal", {
        roundId: ROUND.id,
        index: idx,
        letter,
      });
      socket.emit("abilities:state", abilitiesStatePayload(u));
      return;
    }

    if (type === "extraRow") {
      const newMax = Math.min(BASE_ATTEMPTS + 3, (cr.maxAttempts || BASE_ATTEMPTS) + 1);

      u.abilities.extraRow -= 1;
      cr.usedAbilities.extraRow = true;
      u.abilityCooldowns.extraRowUntil = t + 20_000;

      cr.maxAttempts = newMax;

      saveUsers(db);

      socket.emit("ability:extraRow", {
        roundId: ROUND.id,
        maxAttempts: newMax,
      });
      socket.emit("abilities:state", abilitiesStatePayload(u));
      return;
    }

    if (type === "freeze") {
      // Freeze others for N seconds; caster can still play.
      const until = t + FREEZE_SECONDS * 1000;

      u.abilities.freeze -= 1;
      cr.usedAbilities.freeze = true;
      u.abilityCooldowns.freezeUntil = t + 45_000;

      ROUND.freezeUntil = until;
      ROUND.freezeCaster = username;

      saveUsers(db);

      io.sockets.sockets.forEach((s) => {
        const u2 = s.data?.username || "";
        const isSelf = u2 === username;
        s.emit("ability:freeze", {
          roundId: ROUND.id,
          by: username,
          seconds: FREEZE_SECONDS,
          self: isSelf,
        });
      });

      // auto clear freeze (safety)
      setTimeout(() => {
        if (ROUND.freezeCaster === username && ROUND.freezeUntil <= nowMs()) {
          ROUND.freezeUntil = 0;
          ROUND.freezeCaster = "";
          io.emit("ability:freezeEnd", { roundId: ROUND.id });
        }
      }, FREEZE_SECONDS * 1000 + 50);

      socket.emit("abilities:state", abilitiesStatePayload(u));
      return;
    }
  });

  // ======== Client asks sync ========
  socket.on("state:sync", () => {
    const db = loadUsers();
    const u = getUserByUsername(db, username);
    if (!u) return;
    ensureUserAbilities(u);
    ensureUserHasRound(db, u);
    saveUsers(db);

    socket.emit("round:state", getRoundStateForClient(u));
    socket.emit("abilities:state", abilitiesStatePayload(u));
  });
});

// Start initial round timers
scheduleFirstLetter(io);

httpServer.listen(PORT, () => {
  console.log(`[VZ] listening on :${PORT}`);
});
