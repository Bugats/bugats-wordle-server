// ======== VĀRDU ZONA — Servera versija ========
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs";
import path from "path";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const app = express();
const httpServer = createServer(app);

const JWT_SECRET = process.env.JWT_SECRET || "VARDU_ZONA_BUGATS_2025_SECRET";
const USERS_FILE = path.join(__dirname, "users.json");

app.use(cors());
app.use(express.json());

// Function to load users from the file
function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}

// Function to save users to the file
function saveUsers(data) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

// Handling registration
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
  };

  saveUsers(users);

  const token = jwt.sign({ nick }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, nick });
});

// Handling login
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

// Initialize the WebSocket server
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Server-side game logic (rounds, guesses, etc.)
let roundWord = "mēnes";
let roundId = Date.now();
let guesses = {};
let attempts = {};
let roundOver = false;

function startNewRound() {
  roundWord = "mēnes"; // You can replace this with a random word from a list.
  roundId = Date.now();
  guesses = {};
  attempts = {};
  roundOver = false;

  io.emit("roundStart", {
    roundId,
    length: roundWord.length
  });
}

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

  socket.emit("roundStart", {
    roundId,
    length: roundWord.length
  });

  socket.on("guess", word => {
    if (roundOver) return;

    word = word.toLowerCase();

    if (word.length !== roundWord.length) return;

    attempts[nick] = (attempts[nick] || 0) + 1;
    if (attempts[nick] > 6) return;

    guesses[nick] = word;
    io.emit("guess", { nick, word });

    if (word === roundWord) {
      roundOver = true;

      const users = loadUsers();
      const user = users[nick];

      user.streak++;
      user.xp += 20;
      user.coins += 5;
      user.tokens += 1;

      saveUsers(users);

      io.emit("win", {
        nick,
        word: roundWord,
        rank: user.rank,
        xp: user.xp,
        coins: user.coins,
        tokens: user.tokens
      });

      setTimeout(startNewRound, 4000);
    }
  });

  socket.on("disconnect", () => {
    io.to("players").emit("online", io.sockets.adapter.rooms.get("players")?.size || 0);
  });
});

// Start the server
httpServer.listen(10080, () => {
  console.log("VĀRDU ZONA server running on port 10080");
});
