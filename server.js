// =====================================================
//  VĀRDU ZONA — BUGATS ULTIMATE SERVER (RANK C SISTĒMA)
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

// ================= LOAD WORDS (5–7 burti) =================
let WORDS = fs.readFileSync(WORDS_FILE, "utf8")
    .split("\n")
    .map(w => w.trim().toLowerCase())
    .filter(w => w.length >= 5 && w.length <= 7);

// ================= RANKS – C varianta trepe =================
// Rekrutētājs I–V, Jauniņais I–V, Prasmīgais I–V, Meistars I–V,
// Eksperts I–V, Elite I–V, Leģenda I–V, Mītiskais, Nemirstīgais
function calculateRank(xp) {
    if (xp < 20)  return "Rekrutētājs I";
    if (xp < 40)  return "Rekrutētājs II";
    if (xp < 60)  return "Rekrutētājs III";
    if (xp < 80)  return "Rekrutētājs IV";
    if (xp < 100) return "Rekrutētājs V";

    if (xp < 140) return "Jauniņais I";
    if (xp < 180) return "Jauniņais II";
    if (xp < 220) return "Jauniņais III";
    if (xp < 260) return "Jauniņais IV";
    if (xp < 300) return "Jauniņais V";

    if (xp < 350) return "Prasmīgais I";
    if (xp < 400) return "Prasmīgais II";
    if (xp < 450) return "Prasmīgais III";
    if (xp < 500) return "Prasmīgais IV";
    if (xp < 550) return "Prasmīgais V";

    if (xp < 620) return "Meistars I";
    if (xp < 690) return "Meistars II";
    if (xp < 760) return "Meistars III";
    if (xp < 830) return "Meistars IV";
    if (xp < 900) return "Meistars V";

    if (xp < 1000) return "Eksperts I";
    if (xp < 1100) return "Eksperts II";
    if (xp < 1200) return "Eksperts III";
    if (xp < 1300) return "Eksperts IV";
    if (xp < 1400) return "Eksperts V";

    if (xp < 1600) return "Elite I";
    if (xp < 1800) return "Elite II";
    if (xp < 2000) return "Elite III";
    if (xp < 2200) return "Elite IV";
    if (xp < 2400) return "Elite V";

    if (xp < 2700) return "Leģenda I";
    if (xp < 3000) return "Leģenda II";
    if (xp < 3500) return "Leģenda III";
    if (xp < 4000) return "Leģenda IV";
    if (xp < 5000) return "Leģenda V";

    if (xp < 7000) return "Mītiskais";
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
        rank: "Rekrutētājs I",
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

    console.log("NEW ROUND WORD (hidden for players):", roundWord);
}

// ================= WORD COLORING =================
function colorWord(word, targetWord) {
    const res = Array(word.length).fill("absent");
    const used = {};

    // Correct vietas
    for (let i = 0; i < word.length; i++) {
        if (word[i] === targetWord[i]) {
            res[i] = "correct";
            used[i] = true;
        }
    }

    // Present nepareizās vietās
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

// Auto TOP push ik pēc 5s
// (klients to lasa ar socket.on("topData", ...))
let io; // definējam augstāk, lai setInterval var izmantot
setTimeout(() => {
    if (io) {
        setInterval(() => {
            io.emit("topData", generateTopLists());
        }, 5000);
    }
}, 2000);

// ================= SOCKET.IO =================
io = new Server(httpServer, { cors: { origin: "*" } });

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

    io.to("players").emit(
        "online",
        io.sockets.adapter.rooms.get("players")?.size || 1
    );

    // Pēc connect nosūtām aktuālo raundu
    socket.emit("roundStart", {
        roundId,
        length: roundLength
    });

    // ================= CHAT =================
    socket.on("chat", msg => {
        if (!msg || typeof msg !== "string") return;
        io.emit("chat", { nick, msg });
    });

    // ================= GUESS =================
    socket.on("guess", word => {
        if (roundOver) return;
        if (typeof word !== "string") return;
        word = word.toLowerCase().trim();
        if (word.length !== roundLength) return;

        attempts[nick] = (attempts[nick] || 0) + 1;
        if (attempts[nick] > 6) return;

        const target = colorWord(word, roundWord);

        io.emit("guess", { nick, word, target });

        // Uzvara
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

        // Zaudējums šim spēlētājam (6 mēģinājumi iztērēti)
        if (attempts[nick] === 6 && word !== roundWord) {
            io.emit("lose", { nick });
        }
    });

    socket.on("disconnect", () => {
        io.to("players").emit(
            "online",
            io.sockets.adapter.rooms.get("players")?.size || 0
        );
    });
});

// ================= START =================
newRound();

httpServer.listen(PORT, () => {
    console.log("VĀRDU ZONA server running on", PORT);
});
