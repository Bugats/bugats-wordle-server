// ====== VĀRDU ZONA — SERVERIS (Render + Hostinger stabilā versija) ======
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs";
import path from "path";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 10080;

const JWT_SECRET = process.env.JWT_SECRET || "BUGATS_SUPER_SLEPENS_JWT";
const USERS_FILE = path.join(__dirname, "users.json");
const WORDS_FILE = path.join(__dirname, "words.txt");

// ===== EXPRESS =====
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== CORS KONFIGURĀCIJA (ļauj thezone.lv frontend pieslēgties) =====
app.use(
  cors({
    origin: [
      "https://thezone.lv",
      "https://www.thezone.lv",
      "http://localhost:10080",
    ],
    methods: ["GET", "POST"],
    credentials: true,
  })
);

// ===== HTTP + SOCKET.IO =====
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: [
      "https://thezone.lv",
      "https://www.thezone.lv",
      "http://localhost:10080",
    ],
    methods: ["GET", "POST"],
  },
});

// ===== PALĪGFUNCTIONS =====
function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ===== SIGNUP =====
app.post("/signup", async (req, res) => {
  const { username, password, confirmPassword } = req.body;
  if (!username || !password || !confirmPassword)
    return res.status(400).json({ error: "Nepieciešams viss ievadīts." });

  if (password !== confirmPassword)
    return res.status(400).json({ error: "Paroles nesakrīt." });

  const users = loadUsers();
  if (users.find((u) => u.username === username))
    return res.status(400).json({ error: "Lietotājvārds jau eksistē." });

  const hashed = await bcrypt.hash(password, 10);
  const newUser = {
    id: Date.now(),
    username,
    password: hashed,
    xp: 0,
    coins: 0,
    tokens: 0,
    streak: 0,
    rank: "Jauniņais I",
  };
  users.push(newUser);
  saveUsers(users);

  const token = jwt.sign({ username }, JWT_SECRET);
  res.json({ message: "Profils izveidots!", token });
});

// ===== SIGNIN =====
app.post("/signin", async (req, res) => {
  const { username, password } = req.body;
  const users = loadUsers();
  const user = users.find((u) => u.username === username);
  if (!user) return res.status(400).json({ error: "Nepareizs lietotājvārds." });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(400).json({ error: "Nepareiza parole." });

  const token = jwt.sign({ username }, JWT_SECRET);
  res.json({ message: "Pieteikšanās veiksmīga!", token });
});

// ===== SOCKET.IO =====
io.on("connection", (socket) => {
  console.log("Jauns klients:", socket.id);

  socket.emit("welcome", { msg: "Savienots ar VĀRDU ZONA serveri!" });

  socket.on("disconnect", () => {
    console.log("Klients atvienots:", socket.id);
  });
});

// ===== START =====
httpServer.listen(PORT, () => {
  console.log(`✅ Serveris darbojas uz porta ${PORT}`);
});
