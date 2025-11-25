// ======== VĀRDU ZONA — SERVER ====

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs";
import path from "path";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { fileURLToPath } from "url";

// ===== Paths =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10080;
const JWT_SECRET = process.env.JWT_SECRET || "BUGATS_ULTIMATE_2025";

const USERS_FILE = path.join(__dirname, "users.json");
const WORDS_FILE = path.join(__dirname, "words.txt");

// ===== User Helpers =====
function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}
function saveUsers(u) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2));
}

// ===== Load Words 5–7 =====
let WORDS = fs.readFileSync(WORDS_FILE, "utf8")
  .split("\n")
  .map(w => w.trim().toLowerCase())
  .filter(w => w.length >= 5 && w.length <= 7);

// ===== Express =====
const app = express();
app.use(cors());
app.use(express.json());

// ===== LOGIN / REGISTER =====
app.post("/register", async (req, res) => {
  const { nick, password } = req.body;

  if (!nick || !password) return res.status(400).json({ error: "Bad data" });

  const users = loadUsers();
  if (users[nick]) return res.status(400).json({ error: "Nick exists" });

  const hash = await bcrypt.hash(password, 10);

  users[nick] = {
    password: hash,
    xp: 0,
    streak: 0,
    rank: "Jauniņais I",
    coins: 0,
    tokens: 0
  };

  saveUsers(users);

  const token = jwt.sign({ nick }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, nick });
});

app.post("/login", async (req, res) => {
  const { nick, password } = req.body;

  const users = loadUsers();
  const u = users[nick];
  if (!u) return res.status(400).json({ error: "User not found" });

  const ok = await bcrypt.compare(password, u.password);
  if (!ok) return res.status(400).json({ error: "Bad password" });

  const token = jwt.sign({ nick }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, nick });
});

// ===== Ranks =====
function calcRank(xp) {
  if (xp < 20) return "Jauniņais I";
  if (xp < 50) return "Jauniņais II";
  if (xp < 90) return "Jauniņais III";
  if (xp < 140) return "Jauniņais IV";
  if (xp < 200) return "Jauniņais V";
  if (xp < 260) return "Prasmīgais I";
  if (xp < 330) return "Prasmīgais II";
  if (xp < 420) return "Prasmīgais III";
  if (xp < 520) return "Prasmīgais IV";
  if (xp < 650) return "Prasmīgais V";
  if (xp < 800) return "Meistars I";
  if (xp < 1000) return "Meistars II";
  if (xp < 1300) return "Meistars III";
  if (xp < 1600) return "Meistars IV";
  if (xp < 2000) return "Elite I";
  if (xp < 2600) return "Elite II";
  if (xp < 3300) return "Elite III";
  if (xp < 4200) return "Elite IV";
  if (xp < 5200) return "Elite V";
  if (xp < 7000) return "Leģenda";
  return "Nemirstīgais";
}

// ===== Socket.IO =====
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

// ===== Game State =====
let roundWord = WORDS[Math.floor(Math.random() * WORDS.length)];
let roundId = Date.now();
let attempts = {};
let roundOver = false;

function startNewRound() {
  roundWord = WORDS[Math.floor(Math.random() * WORDS.length)];
  roundId = Date.now();
  attempts = {};
  roundOver = false;

  io.emit("roundStart", {
    roundId,
    length: roundWord.length
  });

  console.log("NEW WORD:", roundWord);
}

// ===== Coloring Logic =====
function evaluateGuess(guess, target) {
  const result = [];

  const wordLetters = target.split("");
  const guessLetters = guess.split("");

  // correct
  for (let i = 0; i < target.length; i++) {
    if (guessLetters[i] === wordLetters[i]) {
      result[i] = "correct";
      wordLetters[i] = null;
      guessLetters[i] = null;
    }
  }

  // present
  for (let i = 0; i < target.length; i++) {
    if (guessLetters[i]) {
      if (wordLetters.includes(guessLetters[i])) {
        result[i] = "present";
        wordLetters[wordLetters.indexOf(guessLetters[i])] = null;
      } else {
        result[i] = "absent";
      }
    }
  }

  return result;
}

// ===== Socket Events =====
io.on("connection", socket => {
  let nick = null;

  try {
    const data = jwt.verify(socket.handshake.auth.token, JWT_SECRET);
    nick = data.nick;
  } catch {
    socket.disconnect();
    return;
  }

  socket.join("players");
  io.to("players").emit("online", io.sockets.adapter.rooms.get("players")?.size || 1);

  // Send round info
  socket.emit("roundStart", {
    roundId,
    length: roundWord.length
  });

  // ===== Chat =====
  socket.on("chat", msg => {
    if (!msg) return;
    io.emit("chat", { nick, msg });
  });

  // ===== Guess =====
  socket.on("guess", word => {
    if (roundOver) return;
    if (!word || typeof word !== "string") return;
    if (word.length !== roundWord.length) return;

    attempts[nick] = (attempts[nick] || 0) + 1;
    if (attempts[nick] > 6) return;

    const target = evaluateGuess(word, roundWord);

    io.emit("guess", { nick, word, target });

    if (word === roundWord) {
      roundOver = true;

      const users = loadUsers();
      const u = users[nick];

      u.streak++;
      u.xp += 20;
      u.coins += 5;
      u.tokens += 1;
      u.rank = calcRank(u.xp);

      saveUsers(users);

      io.emit("win", {
        nick,
        word: roundWord,
        rank: u.rank,
        xp: u.xp,
        coins: u.coins,
        tokens: u.tokens
      });

      setTimeout(startNewRound, 4000);
    }
  });

  socket.on("disconnect", () => {
    io.to("players").emit("online", io.sockets.adapter.rooms.get("players")?.size || 0);
  });
});

// ===== Server start =====
httpServer.listen(PORT, () => console.log("SERVER OK on", PORT));
