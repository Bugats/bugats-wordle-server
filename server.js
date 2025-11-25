import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

const PORT = process.env.PORT || 10080;
const USERS_FILE = path.join(__dirname, "users.json");
const JWT_SECRET = process.env.JWT_SECRET || "BUGATS_SUPER_JWT_SECRET";
const WORDS_FILE = path.join(__dirname, "words.txt");

// ====== Middleware ======
app.use(cors());
app.use(express.json());

// ====== Helper functions ======
function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    return { users: [] };
  }
}
function saveUsers(data) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

// ====== API Routes ======

// Signup
app.post("/signup", async (req, res) => {
  const { username, password, confirmPassword } = req.body;
  if (!username || !password || !confirmPassword)
    return res.json({ ok: false, message: "Aizpildi visus laukus." });

  if (password !== confirmPassword)
    return res.json({ ok: false, message: "Paroles nesakrīt." });

  const db = loadUsers();
  if (db.users.find((u) => u.username === username))
    return res.json({ ok: false, message: "Šāds lietotājs jau eksistē." });

  const hash = await bcrypt.hash(password, 10);
  db.users.push({
    username,
    password: hash,
    xp: 0,
    coins: 0,
    rank: "Jauniņais I",
    streak: 0,
  });
  saveUsers(db);
  res.json({ ok: true });
});

// Login
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const db = loadUsers();
  const user = db.users.find((u) => u.username === username);
  if (!user) return res.json({ ok: false, message: "Nepareizs niks vai parole." });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.json({ ok: false, message: "Nepareizs niks vai parole." });

  const token = jwt.sign({ username }, JWT_SECRET);
  res.json({ ok: true, token, username });
});

// Change password
app.post("/change-password", async (req, res) => {
  const { token, oldPassword, newPassword, confirmNew } = req.body;
  if (!token) return res.json({ ok: false, message: "Nav autorizācijas." });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = loadUsers();
    const user = db.users.find((u) => u.username === decoded.username);
    if (!user) return res.json({ ok: false, message: "Lietotājs nav atrasts." });

    const match = await bcrypt.compare(oldPassword, user.password);
    if (!match) return res.json({ ok: false, message: "Vecā parole nav pareiza." });

    if (newPassword !== confirmNew)
      return res.json({ ok: false, message: "Jaunās paroles nesakrīt." });

    const newHash = await bcrypt.hash(newPassword, 10);
    user.password = newHash;
    saveUsers(db);

    res.json({ ok: true, message: "Parole veiksmīgi nomainīta." });
  } catch (err) {
    res.json({ ok: false, message: "Token nederīgs." });
  }
});

// ====== SOCKET.IO ======
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("Unauthorized"));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.user = decoded.username;
    next();
  } catch {
    next(new Error("Invalid token"));
  }
});

io.on("connection", (socket) => {
  console.log("Savienots:", socket.user);
  socket.emit("hello", { message: `Sveiks, ${socket.user}!` });

  socket.on("disconnect", () => {
    console.log("Atslēdzās:", socket.user);
  });
});

httpServer.listen(PORT, () =>
  console.log(`✅ Serveris darbojas uz porta ${PORT}`)
);
