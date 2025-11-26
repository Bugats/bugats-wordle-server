// server.js — VĀRDU ZONA backend (Render)

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10080;
const JWT_SECRET = process.env.JWT_SECRET || "BUGATS_VARDU_ZONA_SUPER_TOKENS";

// ===== Middlewares =====
app.use(express.json());

// CORS: atļaujam piekļuvi no thezone.lv
app.use(
  cors({
    origin: ["https://thezone.lv", "https://www.thezone.lv"],
    methods: ["GET", "POST", "OPTIONS"],
  })
);

// ja tev ir kādi statiskie faili servera pusē
app.use(express.static(path.join(__dirname, "public")));

// ===== Ceļi uz failiem =====
const USERS_FILE = path.join(__dirname, "users.json");

// Droša nolasīšana no users.json
function getUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) {
      fs.writeFileSync(USERS_FILE, "[]", "utf8");
      return [];
    }
    const raw = fs.readFileSync(USERS_FILE, "utf8").trim();
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    return [];
  } catch (err) {
    console.error("getUsers error:", err);
    return [];
  }
}

function saveUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
  } catch (err) {
    console.error("saveUsers error:", err);
  }
}

// ===== Auth maršruti =====

// Reģistrācija
app.post("/signup", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res
      .status(400)
      .json({ message: "Nepieciešams lietotājvārds un parole" });
  }

  const users = getUsers();
  const exists = users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase()
  );
  if (exists) {
    return res.status(400).json({ message: "Šāds lietotājvārds jau eksistē" });
  }

  const hashed = bcrypt.hashSync(password, 10);
  const newUser = {
    username,
    password: hashed,
    createdAt: new Date().toISOString(),
    xp: 0,
    coins: 0,
  };

  users.push(newUser);
  saveUsers(users);

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "7d" });
  return res.status(201).json({
    token,
    username,
    xp: newUser.xp,
    coins: newUser.coins,
  });
});

// Pierakstīšanās
app.post("/signin", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res
      .status(400)
      .json({ message: "Nepieciešams lietotājvārds un parole" });
  }

  const users = getUsers();
  const user = users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase()
  );
  if (!user) {
    return res.status(401).json({ message: "Nepareizs lietotājvārds vai parole" });
  }

  const ok = bcrypt.compareSync(password, user.password);
  if (!ok) {
    return res.status(401).json({ message: "Nepareizs lietotājvārds vai parole" });
  }

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "7d" });
  return res.json({
    token,
    username,
    xp: user.xp ?? 0,
    coins: user.coins ?? 0,
  });
});

// JWT pārbaude
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const [, token] = header.split(" ");
  if (!token) {
    return res.status(401).json({ message: "Nav autorizēts" });
  }
  jwt.verify(token, JWT_SECRET, (err, payload) => {
    if (err) return res.status(401).json({ message: "Token nederīgs" });
    req.user = payload;
    next();
  });
}

// Testa aizsargāts maršruts
app.get("/me", authMiddleware, (req, res) => {
  const users = getUsers();
  const user = users.find(
    (u) => u.username.toLowerCase() === req.user.username.toLowerCase()
  );
  if (!user) {
    return res.status(404).json({ message: "Lietotājs nav atrasts" });
  }
  res.json({
    username: user.username,
    xp: user.xp ?? 0,
    coins: user.coins ?? 0,
  });
});

app.get("/", (req, res) => {
  res.json({ ok: true, service: "VARDU ZONA auth server" });
});

app.listen(PORT, () => {
  console.log("VĀRDU ZONA serveris klausās uz porta", PORT);
});
