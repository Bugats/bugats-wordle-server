import express from "express";
import fs from "fs";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());

// Health check
app.get("/health", (req, res) => res.json({ ok: true }));

// Nolasām words.txt vienreiz startā — ātrākais variants
let WORDS = fs.readFileSync("words.txt", "utf-8")
  .split(/\r?\n/)
  .map(w => w.trim().toLowerCase())
  .filter(w => w.length > 0); // no tukšajām rindām

// Funkcija: nejaušs vārds
function getRandomWord() {
  return WORDS[Math.floor(Math.random() * WORDS.length)];
}

// Servera setup
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

let currentWord = getRandomWord();
let roundActive = true;

// Socket savienojums
io.on("connection", (socket) => {
  console.log("Client connected");

  socket.emit("roundData", { isActive: roundActive });

  socket.on("guess", (guess) => {
    if (!roundActive) return;

    guess = guess.toLowerCase();

    if (guess === currentWord) {
      roundActive = false;
      io.emit("win", guess);
    }
  });

  socket.on("newRound", () => {
    currentWord = getRandomWord();
    roundActive = true;
    io.emit("roundData", { isActive: true });
  });
});

// Start server
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("Bugats Wordle server running on port " + PORT);
});
