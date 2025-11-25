// ======== VĀRDU ZONA — Bugats edition (Render server.js) ========

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

// ======== Ceļi un konstantes ========
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 10000;

const JWT_SECRET = process.env.JWT_SECRET || "BUGATS_VARDU_ZONA_SUPER_SLEPENS_JWT";
const USERS_FILE = path.join(__dirname, "users.json");
const WORDS_FILE = path.join(__dirname, "words.txt");

// ======== Express un CORS ========
const app = express();
app.use(express.json());
app.use(cors({
  origin: [
    "https://thezone.lv",
    "https://www.thezone.lv",
    "http://localhost:10080"
  ],
  methods: ["GET", "POST"],
  credentials: true
}));

// ======== HTTP Server + Socket.IO ========
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: [
      "https://thezone.lv",
      "https://www.thezone.lv",
      "http://localhost:10080"
    ],
    methods: ["GET", "POST"],
    credentials: true
  },
  allowEIO3: true,
  transports: ["polling", "websocket"]
});

// ======== Lietotāji ========
function readUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    return {};
  }
}
function writeUsers(data) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

// ======== JWT ========
function createToken(username) {
  return jwt.sign({ username }, JWT_SECRET, { expiresIn: "24h" });
}
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ======== API: login/signup/password ========
app.post("/signup", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ message: "Nepieciešams lietotājvārds un parole." });

  const users = readUsers();
  if (users[username])
    return res.status(400).json({ message: "Lietotājvārds jau eksistē." });

  const hash = await bcrypt.hash(password, 10);
  users[username] = { password: hash, xp: 0, coins: 0 };
  writeUsers(users);

  const token = createToken(username);
  res.json({ token, message: "Reģistrācija veiksmīga." });
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const users = readUsers();
  const user = users[username];
  if (!user) return res.status(400).json({ message: "Lietotājs nav atrasts." });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ message: "Nepareiza parole." });

  const token = createToken(username);
  res.json({ token, message: "Pieteikšanās veiksmīga." });
});

app.post("/change-password", async (req, res) => {
  const { token, oldPassword, newPassword, confirmNew } = req.body;
  const data = verifyToken(token);
  if (!data) return res.status(401).json({ message: "Token nederīgs." });
  if (newPassword !== confirmNew)
    return res.status(400).json({ message: "Paroles nesakrīt." });

  const users = readUsers();
  const user = users[data.username];
  if (!user) return res.status(404).json({ message: "Lietotājs nav atrasts." });

  const match = await bcrypt.compare(oldPassword, user.password);
  if (!match) return res.status(401).json({ message: "Nepareiza vecā parole." });

  users[data.username].password = await bcrypt.hash(newPassword, 10);
  writeUsers(users);
  res.json({ message: "Parole veiksmīgi nomainīta." });
});

// ======== SOCKET.IO ========
io.on("connection", (socket) => {
  console.log("🔌 Jauns savienojums:", socket.id);

  socket.emit("hello", {
    roundId: "demo-round",
    maxAttempts: 6,
    wordLength: 5,
    stats: { xp: 0, coins: 0, tokens: 0, rankTitle: "Jauniņais I" },
    leaderboard: [],
    onlineCount: io.engine.clientsCount,
    dailyChampion: null
  });

  socket.on("guess", (data) => {
    socket.emit("guessResult", {
      letters: data.word.split("").map(ch => ({
        letter: ch,
        status: "absent"
      })),
      attemptsLeft: 6
    });
  });

  socket.on("disconnect", () => {
    console.log("❌ Atvienojās:", socket.id);
  });
});

// ======== Serveris ========
httpServer.listen(PORT, () => {
  console.log(`✅ Serveris darbojas uz porta ${PORT}`);
});
