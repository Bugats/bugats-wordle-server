// ======== VĀRDU ZONA — stabilā servera versija (Hostinger + Render) ========
// JWT + Login/Register, XP + Rank + Streak, Coins, Tokens, Missions, Chat
// Words.txt backend, 6 attempts, serveris atklāj vārdu TIKAI uzvaras brīdī

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs";
import path from "path";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { fileURLToPath } from "url";

// ======== Ceļi un konstantes ========
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10080;
const JWT_SECRET = process.env.JWT_SECRET || "VARDU_ZONA_BUGATS_2025_SECRET";
const USERS_FILE = path.join(__dirname, "users.json");
const WORDS_FILE = path.join(__dirname, "words.txt");

// ======== Helperi ========
function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}
function saveUsers(data) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

// ======== Wordlist ========
let WORDS = fs.readFileSync(WORDS_FILE, "utf8")
  .split("\n")
  .map(w => w.trim().toLowerCase())
  .filter(w => w.length === 5);

// ======== Servera sākums ========
const app = express();
const httpServer = createServer(app);

app.use(cors());
app.use(express.json());

// ======== LOGIN + REGISTER ========
app.post("/register", async (req, res) => {
  const { nick, password } = req.body;

  if (!nick || !password) return res.status(400).json({ error: "Bad data" });

  const users = loadUsers();
  if (users[nick]) return res.status(400).json({ error: "This nickname exists" });

  const hash = await bcrypt.hash(password, 10);

  users[nick] = {
    password: hash,
    xp: 0,
    rank: "Jauniņais I",
    streak: 0,
    coins: 0,
    tokens: 0,
    missions: { daily: 0, weekly: 0 },
  };

  saveUsers(users);

  const token = jwt.sign({ nick }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, nick });
});

app.post("/login", async (req, res) => {
  const { nick, password } = req.body;

  const users = loadUsers();
  const user = users[nick];

  if (!user) return res.status(400).json({ error: "Bad login" });

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: "Bad password" });

  const token = jwt.sign({ nick }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, nick });
});

// ======== RANK Formula ========
function calculateRank(xp) {
  if (xp < 20) return "Jauniņais I";
  if (xp < 40) return "Jauniņais II";
  if (xp < 70) return "Jauniņais III";
  if (xp < 100) return "Jauniņais IV";
  if (xp < 150) return "Jauniņais V";

  if (xp < 200) return "Prasmīgais I";
  if (xp < 260) return "Prasmīgais II";
  if (xp < 320) return "Prasmīgais III";
  if (xp < 400) return "Prasmīgais IV";
  if (xp < 500) return "Prasmīgais V";

  if (xp < 650) return "Meistars I";
  if (xp < 850) return "Meistars II";
  if (xp < 1100) return "Meistars III";
  if (xp < 1400) return "Meistars IV";
  if (xp < 1800) return "Meistars V";

  if (xp < 2200) return "Elite I";
  if (xp < 2600) return "Elite II";
  if (xp < 3000) return "Elite III";
  if (xp < 3500) return "Elite IV";
  if (xp < 4200) return "Elite V";

  if (xp < 5000) return "Leģenda I";
  if (xp < 6000) return "Leģenda II";
  if (xp < 7500) return "Leģenda III";

  if (xp < 10000) return "Mītiskais";

  return "Nemirstīgais";
}

// ======== SOCKET.IO ========
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Spēles stāvoklis
let roundWord = WORDS[Math.floor(Math.random() * WORDS.length)];
let roundId = Date.now();
let guesses = {};
let attempts = {};
let roundOver = false;

function startNewRound() {
  roundWord = WORDS[Math.floor(Math.random() * WORDS.length)];
  roundId = Date.now();
  guesses = {};
  attempts = {};
  roundOver = false;

  io.emit("roundStart", {
    roundId,
    length: 5
  });
}

// ======== SOCKET EVENTS ========
io.on("connection", socket => {
  let nick = null;

  try {
    if (socket.handshake.auth?.token) {
      const data = jwt.verify(socket.handshake.auth.token, JWT_SECRET);
      nick = data.nick;
    }
  } catch (e) {
    socket.disconnect();
    return;
  }

  if (!nick) {
    socket.disconnect();
    return;
  }

  socket.join("players");
  io.to("players").emit("online", io.sockets.adapter.rooms.get("players")?.size || 1);

  // Sūtam round info
  socket.emit("roundStart", {
    roundId,
    length: 5
  });

  // ===== ČATS =====
  socket.on("chat", msg => {
    if (!msg || typeof msg !== "string") return;
    io.emit("chat", { nick, msg });
  });

  // ===== GŪESS =====
  socket.on("guess", word => {
    if (roundOver) return;

    word = String(word).toLowerCase();
    if (word.length !== 5) return;

    attempts[nick] = (attempts[nick] || 0) + 1;
    if (attempts[nick] > 6) return;

    if (!guesses[nick]) guesses[nick] = [];
    guesses[nick].push(word);

    io.emit("guess", { nick, word });

    // Uzvara
    if (word === roundWord) {
      roundOver = true;

      const users = loadUsers();
      const u = users[nick];

      u.streak++;
      u.xp += 20;
      u.coins += 5;
      u.tokens += 1;
      u.rank = calculateRank(u.xp);

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

// ======== START ========
httpServer.listen(PORT, () => {
  console.log("VĀRDU ZONA server running on port", PORT);
});
