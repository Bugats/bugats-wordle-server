// ===========================
//  VĀRDU ZONA — ULTIMATE SERVER
//  Bugats Edition 2025
// ===========================

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs";
import path from "path";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { fileURLToPath } from "url";

// ------------------------------------
// Ceļi un konstantes
// ------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10080;
const JWT_SECRET = process.env.JWT_SECRET || "BUGATS_VZ_ULTIMATE_SECRET";

const USERS_FILE = path.join(__dirname, "users.json");
const WORDS_FILE = path.join(__dirname, "words.txt");

// ------------------------------------
// Failu helperi
// ------------------------------------
function loadUsers() {
    if (!fs.existsSync(USERS_FILE)) return {};
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}
function saveUsers(data) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

// ------------------------------------
// Wordlist — 5–7 burti
// ------------------------------------
let WORDS = fs.readFileSync(WORDS_FILE, "utf8")
    .split("\n")
    .map(w => w.trim().toLowerCase())
    .filter(w => w.length >= 5 && w.length <= 7);

// ------------------------------------
// Express + CORS
// ------------------------------------
const app = express();
const httpServer = createServer(app);

app.use(cors({
    origin: [
        "https://thezone.lv",
        "https://www.thezone.lv"
    ],
    methods: ["GET", "POST"],
    credentials: true
}));
app.use(express.json());

// ------------------------------------
// AUTH — REGISTER
// ------------------------------------
app.post("/register", async (req, res) => {
    const { nick, password } = req.body;

    if (!nick || !password)
        return res.status(400).json({ error: "Bad data" });

    const users = loadUsers();
    if (users[nick])
        return res.status(400).json({ error: "Nickname exists" });

    const hash = await bcrypt.hash(password, 10);

    users[nick] = {
        password: hash,
        xp: 0,
        rank: "Jauniņais I",
        streak: 0,
        coins: 0,
        tokens: 0,
        created: Date.now()
    };

    saveUsers(users);

    const token = jwt.sign({ nick }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, nick });
});

// ------------------------------------
// AUTH — LOGIN
// ------------------------------------
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

// ------------------------------------
// Rank Formula
// ------------------------------------
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

// ------------------------------------
// SOCKET.IO
// ------------------------------------
const io = new Server(httpServer, {
    cors: {
        origin: [
            "https://thezone.lv",
            "https://www.thezone.lv"
        ],
        methods: ["GET", "POST"],
        credentials: true
    }
});

// -------------------------------
// Globālā spēles state
// -------------------------------
let roundWord = WORDS[Math.floor(Math.random() * WORDS.length)];
let roundId = Date.now();
let guesses = {};
let attempts = {};
let roundOver = false;

// -------------------------------
// Jauns raunds
// -------------------------------
function startNewRound() {
    roundWord = WORDS[Math.floor(Math.random() * WORDS.length)];
    roundId = Date.now();
    guesses = {};
    attempts = {};
    roundOver = false;

    io.emit("roundStart", {
        roundId,
        length: roundWord.length
    });
}

// -------------------------------
// Funkcija: sagatavot TOP sarakstus
// -------------------------------
function generateTopLists() {
    const users = loadUsers();
    const arr = Object.entries(users).map(([nick, data]) => ({ nick, ...data }));

    const topXP = [...arr].sort((a,b)=>b.xp - a.xp).slice(0,10);
    const topStreak = [...arr].sort((a,b)=>b.streak - a.streak).slice(0,10);
    const topCoins = [...arr].sort((a,b)=>b.coins - a.coins).slice(0,10);
    const topTokens = [...arr].sort((a,b)=>b.tokens - a.tokens).slice(0,10);

    return {
        xp: topXP,
        streak: topStreak,
        coins: topCoins,
        tokens: topTokens
    };
}

// ------------------------------------
// SOCKET HANDLERS
// ------------------------------------
io.on("connection", socket => {
    let nick = null;

    // JWT verifikācija
    try {
        if (socket.handshake.auth?.token) {
            const data = jwt.verify(socket.handshake.auth.token, JWT_SECRET);
            nick = data.nick;
        }
    } catch {
        socket.disconnect();
        return;
    }

    if (!nick) {
        socket.disconnect();
        return;
    }

    // Ieliek istabā
    socket.join("players");

    // Online counter
    io.to("players").emit(
        "online",
        io.sockets.adapter.rooms.get("players")?.size || 1
    );

    // Nosūtām round info
    socket.emit("roundStart", {
        roundId,
        length: roundWord.length
    });

    // Nosūtām TOP sarakstus
    socket.emit("topUpdate", generateTopLists());

    // ČATS
    socket.on("chat", msg => {
        if (!msg || typeof msg !== "string") return;
        io.emit("chat", { nick, msg });
    });

    // GŪESS
    socket.on("guess", word => {
        if (roundOver) return;

        word = String(word).toLowerCase();
        if (word.length !== roundWord.length) return;

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

            // XP / Currencies
            u.streak++;
            u.xp += 20;
            u.coins += 5;
            u.tokens += 1;
            u.rank = calculateRank(u.xp);

            saveUsers(users);

            // WIN event
            io.emit("win", {
                nick,
                word: roundWord,    // atklājam tikai uz uzvaru
                rank: u.rank,
                xp: u.xp,
                coins: u.coins,
                tokens: u.tokens
            });

            // Atjauno TOP
            io.emit("topUpdate", generateTopLists());

            setTimeout(startNewRound, 4000);
        }
    });

    // Disconnect handler
    socket.on("disconnect", () => {
        io.to("players").emit(
            "online",
            io.sockets.adapter.rooms.get("players")?.size || 0
        );
    });
});

// ------------------------------------
// START SERVER
// ------------------------------------
httpServer.listen(PORT, () => {
    console.log("VĀRDU ZONA ULTIMATE server running on port", PORT);
});
