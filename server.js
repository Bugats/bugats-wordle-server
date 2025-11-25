// =====================================================
//  VĀRDU ZONA — BUGATS ULTIMATE SERVER (2025)
//  Login/Register, JWT, XP, Rank, Streak, Coins, Tokens
//  5–7 burti, Krāsošana, Win/Lose, Top Listi, Chat
// =====================================================

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs";
import path from "path";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { fileURLToPath } from "url";

// ================= PATHS =================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10080;
const JWT_SECRET = process.env.JWT_SECRET || "VARDU_ZONA_SUPER_SECRET_2025";

const USERS_FILE = path.join(__dirname, "users.json");
const WORDS_FILE = path.join(__dirname, "words.txt");

// ================= USERS =================
function loadUsers() {
    if (!fs.existsSync(USERS_FILE)) return {};
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}
function saveUsers(data) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

// ================= LOAD WORDS =================
let WORDS = fs.readFileSync(WORDS_FILE, "utf8")
    .split("\n")
    .map(w => w.trim().toLowerCase())
    .filter(w => w.length >= 5 && w.length <= 7);

// ================= RANKS =================
function calculateRank(xp) {
    if (xp < 20) return "Jauniņais I";
    if (xp < 40) return "Jauniņais II";
    if (xp < 70) return "Jauniņais III";
    if (xp < 100) return "Jauniņais IV";

    if (xp < 160) return "Prasmīgais I";
    if (xp < 230) return "Prasmīgais II";
    if (xp < 320) return "Prasmīgais III";

    if (xp < 500) return "Meistars I";
    if (xp < 800) return "Meistars II";
    if (xp < 1200) return "Meistars III";

    if (xp < 1800) return "Elite I";
    if (xp < 2500) return "Elite II";

    if (xp < 4000) return "Leģenda";

    return "Nemirstīgais";
}

// ================= EXPRESS =================
const app = express();
const httpServer = createServer(app);

app.use(cors());
app.use(express.json());

// ================= REGISTER =================
app.post("/register", async (req, res) => {
    const { nick, password } = req.body;

    if (!nick || !password) return res.status(400).json({ error: "Bad data" });

    const users = loadUsers();
    if (users[nick]) return res.status(400).json({ error: "Nickname exists" });

    const hash = await bcrypt.hash(password, 10);

    users[nick] = {
        password: hash,
        xp: 0,
        rank: "Jauniņais I",
        streak: 0,
        coins: 0,
        tokens: 0
    };

    saveUsers(users);

    const token = jwt.sign({ nick }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, nick });
});

// ================= LOGIN =================
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

// ================= GAME STATE =================
let roundWord = "";
let roundLength = 5;
let roundId = 0;
let attempts = {}; // nick → count
let roundOver = false;

// ================= NEW ROUND =================
function newRound() {
    const w = WORDS[Math.floor(Math.random() * WORDS.length)];
    roundWord = w;
    roundLength = w.length;
    roundId = Date.now();
    attempts = {};
    roundOver = false;

    io.emit("roundStart", {
        roundId,
        length: roundLength
    });
}

// ================= WORD COLORING =================
function colorWord(word, targetWord) {
    const res = Array(word.length).fill("absent");
    const used = {};

    // correct
    for (let i = 0; i < word.length; i++) {
        if (word[i] === targetWord[i]) {
            res[i] = "correct";
            used[i] = true;
        }
    }

    // present
    for (let i = 0; i < word.length; i++) {
        if (res[i] === "correct") continue;

        for (let j = 0; j < targetWord.length; j++) {
            if (!used[j] && word[i] === targetWord[j]) {
                res[i] = "present";
                used[j] = true;
                break;
            }
        }
    }

    return res;
}

// ================= TOP LISTS =================
function generateTopLists() {
    const users = loadUsers();

    const arr = Object.entries(users).map(([nick, u]) => ({
        nick,
        xp: u.xp || 0,
        streak: u.streak || 0,
        coins: u.coins || 0,
        tokens: u.tokens || 0
    }));

    return {
        xpTop: arr.slice().sort((a,b)=>b.xp - a.xp).slice(0,10),
        streakTop: arr.slice().sort((a,b)=>b.streak - a.streak).slice(0,10),
        coinsTop: arr.slice().sort((a,b)=>b.coins - a.coins).slice(0,10),
        tokensTop: arr.slice().sort((a,b)=>b.tokens - a.tokens).slice(0,10)
    };
}

// AUTO TOP PUSH
setInterval(() => {
    io.emit("topData", generateTopLists());
}, 5000);

// ================= SOCKET.IO =================
const io = new Server(httpServer, {
    cors: { origin: "*" }
});

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

    io.to("players").emit("online",
        io.sockets.adapter.rooms.get("players")?.size || 1
    );

    socket.emit("roundStart", {
        roundId,
        length: roundLength
    });

    // ================= CHAT =================
    socket.on("chat", msg => {
        if (!msg) return;
        io.emit("chat", { nick, msg });
    });

    // ================= GUESS =================
    socket.on("guess", word => {
        if (roundOver) return;
        if (word.length !== roundLength) return;

        attempts[nick] = (attempts[nick] || 0) + 1;
        if (attempts[nick] > 6) return;

        const target = colorWord(word, roundWord);

        io.emit("guess", { nick, word, target });

        if (word === roundWord) {
            roundOver = true;

            const users = loadUsers();
            const u = users[nick];

            u.xp += 20;
            u.streak++;
            u.coins += 5;
            u.tokens += 1;
            u.rank = calculateRank(u.xp);

            saveUsers(users);

            io.emit("win", {
                nick,
                xp: u.xp,
                rank: u.rank,
                coins: u.coins,
                tokens: u.tokens
            });

            setTimeout(newRound, 4000);
        }

        // AUTO LOSE
        if (attempts[nick] === 6) {
            io.emit("lose", { nick });
        }
    });

    socket.on("disconnect", () => {
        io.to("players").emit("online",
            io.sockets.adapter.rooms.get("players")?.size || 0
        );
    });
});

// ================= START =================
newRound();

httpServer.listen(PORT, () => {
    console.log("VĀRDU ZONA server running on", PORT);
});
