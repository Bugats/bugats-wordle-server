// script.js — VĀRDU ZONA klients (Bugats edition)
// XP, ranki, streaki, coins, žetoni, misijas, čats, TOP, online,
// konfeti, mūzika, klaviatūra ar Shift garumzīmēm + NOTIS uz katras pogas.

// ===================== Helper funkcijas =====================
function $(sel) {
  return document.querySelector(sel);
}
function $all(sel) {
  return Array.from(document.querySelectorAll(sel));
}
function createEl(tag, cls) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  return el;
}
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ===================== SERVER URL (Render) =====================

// Pielāgo šo Render URL, ja tev ir cits:
const SERVER_URL =
  window.location.hostname === "localhost"
    ? "http://localhost:10080"
    : "https://bugats-wordle-server.onrender.com";

// Niks no localStorage (tīri kosmētikai – īsto niku dod serveris)
function getStoredNick() {
  const v = localStorage.getItem("vz_name");
  if (!v) return null;
  return v.toString().trim().slice(0, 20) || null;
}
function setStoredNick(name) {
  if (!name) return;
  localStorage.setItem("vz_name", name.toString().trim().slice(0, 20));
}

// ===================== LATVIEŠU GARUMZĪMES (Shift režīms) =====================

const LATV_MAP = {
  a: "ā",
  c: "č",
  e: "ē",
  g: "ģ",
  i: "ī",
  k: "ķ",
  l: "ļ",
  n: "ņ",
  s: "š",
  u: "ū",
  z: "ž",
};
const LATV_MAP_REVERSE = {};
Object.keys(LATV_MAP).forEach((b) => {
  LATV_MAP_REVERSE[LATV_MAP[b]] = b;
});

function toGarums(ch) {
  const low = ch.toLowerCase();
  if (LATV_MAP[low]) {
    const out = LATV_MAP[low];
    return ch === ch.toUpperCase() ? out.toUpperCase() : out;
  }
  return ch;
}
function fromGarums(ch) {
  const low = ch.toLowerCase();
  if (LATV_MAP_REVERSE[low]) {
    const out = LATV_MAP_REVERSE[low];
    return ch === ch.toUpperCase() ? out.toUpperCase() : out;
  }
  return ch;
}

// ===================== AUDIO: NOTIS KLAVIATŪRAS POGĀM =====================

const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;

function ensureAudioCtx() {
  if (!AudioCtx) return;
  if (!audioCtx) {
    audioCtx = new AudioCtx();
  }
}

const KEY_NOTE_ORDER = "QWERTYUIOPASDFGHJKLZXCVBNM";
const BASE_FREQ = 320; // pamatfrekvence

const KEY_FREQ_MAP = {};
KEY_NOTE_ORDER.split("").forEach((ch, i) => {
  KEY_FREQ_MAP[ch] = BASE_FREQ * Math.pow(2, i / 12);
});

function playKeyNote(rawKey) {
  if (!AudioCtx) return;
  ensureAudioCtx();
  if (!audioCtx) return;

  const key = (rawKey || "").toString().toUpperCase();
  const freq = KEY_FREQ_MAP[key] || BASE_FREQ;

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = "sine";
  osc.frequency.value = freq;

  const now = audioCtx.currentTime;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.35, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);

  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.start(now);
  osc.stop(now + 0.16);
}

// ===================== SFX SKAŅAS (flip / win / coins / mission) =====================

const sfx = {
  flip: new Audio("sounds/flip.mp3"),
  win: new Audio("sounds/win.mp3"),
  coins: new Audio("sounds/coins.mp3"),
  mission: new Audio("sounds/mission.mp3"),
};

function playSfx(name) {
  const a = sfx[name];
  if (!a) return;
  try {
    a.currentTime = 0;
    a.play().catch(() => {});
  } catch (e) {
    // ignorējam mobilo/pārlūka ierobežojumus
  }
}

// ===================== KONFETI (vienkāršs efekts) =====================

const confettiCanvas = $("#confetti-canvas");
let confettiCtx = null;
if (confettiCanvas && confettiCanvas.getContext) {
  confettiCtx = confettiCanvas.getContext("2d");
}
let confettiParticles = [];
let confettiActive = false;

function spawnConfettiBurst() {
  if (!confettiCtx) return;
  const w = (confettiCanvas.width = window.innerWidth);
  const h = (confettiCanvas.height = window.innerHeight);
  const colors = ["#facc15", "#22c55e", "#38bdf8", "#f97316", "#e11d48"];
  confettiParticles = [];
  for (let i = 0; i < 120; i++) {
    confettiParticles.push({
      x: Math.random() * w,
      y: -20 + Math.random() * 40,
      vy: 2 + Math.random() * 4,
      vx: -1 + Math.random() * 2,
      size: 4 + Math.random() * 4,
      color: colors[Math.floor(Math.random() * colors.length)],
      life: 0,
      maxLife: 120 + Math.random() * 60,
    });
  }
  confettiActive = true;
  requestAnimationFrame(confettiLoop);
}

function confettiLoop() {
  if (!confettiActive || !confettiCtx) return;
  const w = (confettiCanvas.width = window.innerWidth);
  const h = (confettiCanvas.height = window.innerHeight);

  confettiCtx.clearRect(0, 0, w, h);

  confettiParticles.forEach((p) => {
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.02;
    p.life++;

    confettiCtx.fillStyle = p.color;
    confettiCtx.fillRect(p.x, p.y, p.size, p.size);
  });

  confettiParticles = confettiParticles.filter(
    (p) => p.y < h + 20 && p.life < p.maxLife
  );
  if (!confettiParticles.length) {
    confettiActive = false;
    return;
  }
  requestAnimationFrame(confettiLoop);
}

// ===================== FONA VADS (dopamīna vads) =====================

const bgVeinEl = $("#bg-vein");

function pulseVeinSmall() {
  if (!bgVeinEl) return;
  bgVeinEl.classList.remove("vein-pulse-small");
  void bgVeinEl.offsetWidth;
  bgVeinEl.classList.add("vein-pulse-small");
}

function pulseVeinBig() {
  if (!bgVeinEl) return;
  bgVeinEl.classList.remove("vein-pulse-big");
  void bgVeinEl.offsetWidth;
  bgVeinEl.classList.add("vein-pulse-big");
}

// ===================== STATE =====================

const state = {
  rows: 6,
  cols: 5, // tiks pārrakstīts no servera
  currentRow: 0,
  currentCol: 0,
  roundId: null,
  maxAttempts: 6,
  isLocked: false,
  isRoundOver: false,
  gridTiles: [], // [row][col] -> tile element
  keyboardButtons: new Map(), // key -> btn
  shiftOn: false,

  socket: null,
  isAdmin: false,

  // stats
  xp: 0,
  coins: 0,
  tokens: 0,
  wins: 0,
  streak: 0,
  bestStreak: 0,
  rankTitle: "Jauniņais I",

  medalsCount: 0,
  lastMedal: null,
  bestFastWin: null,

  // vietējie
  nickname: "Spēlētājs",

  lastGuessTs: 0,
};

// ===================== DOM REF =====================

const gridEl = $("#grid");
const attemptsLeftEl = $("#attempts-left");
const roundStatusEl = $("#round-status");
const connectionIndicatorEl = $("#connection-indicator");
const onlineCountEl = $("#online-count");
const keyboardEl = $("#keyboard");
const newGameBtn = $("#new-game-btn");

const nickLabelEl = $("#nick-label");
const avatarCircleEl = $("#avatar-circle");
const avatarInputEl = $("#avatar-input");
const profileBtn = $("#profile-btn");

const xpValueEl = $("#xp-value");
const streakValueEl = $("#streak-value");
const rankLabelEl = $("#rank-label");
const coinsValueEl = $("#coins-value");
const tokensValueEl = $("#tokens-value");

const leaderboardListEl = $("#leaderboard-list");
const dailyChampionEl = $("#daily-champion");
const missionsListEl = $("#missions-list");
const onlineListEl = $("#online-list");
const feedListEl = $("#feed-list");

const chatListEl = $("#chat-list");
const chatInputEl = $("#chat-input");
const chatSendBtn = $("#chat-send");

const toastEl = $("#toast");

// Shop
const shopOpenBtn = $("#shop-open-btn");
const shopModalEl = $("#shop-modal");
const shopCloseBtn = $("#shop-close-btn");
const shopCoinsEl = $("#shop-coins");
const shopTokensEl = $("#shop-tokens");
const buyTokenBtn = $("#buy-token-btn");

// BG mūzika
const bgMusicEl = $("#bg-music");
const musicToggleBtn = $("#music-toggle");

// Nick conflict modal
const nickConflictModalEl = $("#nick-conflict-modal");
const nickConflictOriginalEl = $("#nick-conflict-original");
const nickConflictSuggestionEl = $("#nick-conflict-suggestion");
const nickConflictYesBtn = $("#nick-conflict-yes");
const nickConflictNoBtn = $("#nick-conflict-no");

// Profila modālis
const profileModalEl = $("#profile-modal");
const profileCloseBtn = $("#profile-close-btn");
const profileNameEl = $("#profile-name");
const profileTagEl = $("#profile-tag");
const profileRankEl = $("#profile-rank");
const profileXpEl = $("#profile-xp");
const profileWinsEl = $("#profile-wins");
const profileStreakEl = $("#profile-streak");
const profileBestStreakEl = $("#profile-beststreak");
const profileCoinsEl = $("#profile-coins");
const profileTokensEl = $("#profile-tokens");

// Medaļu lauki
const profileMedalsCountEl = $("#profile-medals");
const profileLastMedalEl = $("#profile-last-medal");
const profileBestFastEl = $("#profile-best-fast");

// ===================== TOAST =====================

let toastTimeout = null;
function showToast(msg, ms = 2200) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  toastEl.classList.remove("hidden");
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toastEl.classList.remove("show");
    toastEl.classList.add("hidden");
  }, ms);
}

// ===================== CONNECTION STATUS =====================

function setConnectionStatus(ok) {
  if (!connectionIndicatorEl) return;
  if (ok) {
    connectionIndicatorEl.textContent = "Savienots ar serveri";
    connectionIndicatorEl.classList.remove("conn-err");
    connectionIndicatorEl.classList.add("conn-ok");
  } else {
    connectionIndicatorEl.textContent = "Nav savienojuma ar serveri";
    connectionIndicatorEl.classList.remove("conn-ok");
    connectionIndicatorEl.classList.add("conn-err");
  }
}

// ===================== GRID =====================

function buildGrid(cols) {
  state.cols = cols;
  gridEl.style.setProperty("--cols", cols);
  gridEl.innerHTML = "";
  state.gridTiles = [];
  state.currentRow = 0;
  state.currentCol = 0;
  state.isLocked = false;
  state.isRoundOver = false;

  for (let r = 0; r < state.rows; r++) {
    const rowArr = [];
    for (let c = 0; c < cols; c++) {
      const tile = createEl("div", "tile");
      tile.dataset.row = r;
      tile.dataset.col = c;
      gridEl.appendChild(tile);
      rowArr.push(tile);
    }
    state.gridTiles.push(rowArr);
  }
  attemptsLeftEl.textContent = state.maxAttempts;
  roundStatusEl.textContent = "";
}

function resetForNewRound(wordLength, maxAttempts, roundId) {
  state.roundId = roundId;
  state.maxAttempts = maxAttempts;
  state.currentRow = 0;
  state.currentCol = 0;
  state.isLocked = false;
  state.isRoundOver = false;
  buildGrid(wordLength);
  if (newGameBtn) {
    newGameBtn.disabled = true;
    newGameBtn.classList.add("btn-disabled");
  }
}

// ===================== KLAVIATŪRA (virt.) =====================

const KEYBOARD_LAYOUT = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["shift", "z", "x", "c", "v", "b", "n", "m", "backspace"],
  ["enter"],
];

function buildKeyboard() {
  keyboardEl.innerHTML = "";
  state.keyboardButtons.clear();

  KEYBOARD_LAYOUT.forEach((row) => {
    const rowEl = createEl("div", "kb-row");
    row.forEach((key) => {
      const btn = createEl("button", "key");
      btn.type = "button";

      if (key === "enter") {
        btn.textContent = "ENTER";
        btn.classList.add("key-wide", "key-sm");
        btn.dataset.key = "ENTER";
      } else if (key === "backspace") {
        btn.textContent = "⌫";
        btn.classList.add("key-wide", "key-sm");
        btn.dataset.key = "BACKSPACE";
      } else if (key === "shift") {
        btn.textContent = "SHIFT";
        btn.classList.add("key-wide", "key-sm");
        btn.dataset.key = "SHIFT";
      } else {
        btn.textContent = key.toUpperCase();
        btn.dataset.key = key.toUpperCase();
      }

      rowEl.appendChild(btn);
      state.keyboardButtons.set(btn.dataset.key, btn);
    });
    keyboardEl.appendChild(rowEl);
  });
}

function updateShiftVisual() {
  const shiftBtn = state.keyboardButtons.get("SHIFT");
  if (!shiftBtn) return;
  if (state.shiftOn) {
    shiftBtn.classList.add("key-present");
  } else {
    shiftBtn.classList.remove("key-present");
  }
}

// ===================== BURTU IEVADĪŠANA =====================

function currentRowWord() {
  if (state.currentRow >= state.rows) return "";
  const tiles = state.gridTiles[state.currentRow];
  return tiles.map((t) => (t.textContent || "").trim()).join("");
}

function setTileLetter(row, col, ch) {
  const tile = state.gridTiles[row]?.[col];
  if (!tile) return;
  tile.textContent = ch.toUpperCase();
  if (ch) tile.classList.add("tile-filled", "tile-pop");
}

function clearTileLetter(row, col) {
  const tile = state.gridTiles[row]?.[col];
  if (!tile) return;
  tile.textContent = "";
  tile.classList.remove("tile-filled");
}

function handleCharInput(rawCh) {
  if (state.isLocked || state.isRoundOver) return;
  if (state.currentRow >= state.rows) return;
  if (state.currentCol >= state.cols) return;

  let ch = rawCh;
  if (!ch) return;

  if (state.shiftOn) {
    ch = toGarums(ch);
  }

  ch = ch.toLowerCase();
  if (!/^[a-zāčēģīķļņšūž]$/i.test(ch)) return;

  setTileLetter(state.currentRow, state.currentCol, ch);
  state.currentCol++;

  pulseVeinSmall();
}

function handleBackspace() {
  if (state.isLocked || state.isRoundOver) return;
  if (state.currentRow >= state.rows) return;
  if (state.currentCol > 0) {
    state.currentCol--;
    clearTileLetter(state.currentRow, state.currentCol);
  }
}

function handleEnter() {
  if (state.isLocked || state.isRoundOver) return;
  if (state.currentRow >= state.rows) return;

  const now = Date.now();
  if (now - state.lastGuessTs < 900) {
    showToast("Pagaidi sekundi pirms nākamā minējuma.");
    return;
  }

  const word = currentRowWord();
  if (word.length !== state.cols) {
    showToast(`Vārdā jābūt ${state.cols} burtiem.`);
    return;
  }
  if (!state.socket) return;

  state.isLocked = true;
  state.lastGuessTs = now;

  state.socket.emit("guess", {
    word,
    roundId: state.roundId,
  });
}

function applyGuessResultToRow(letters, isWin) {
  const row = state.currentRow;
  const tiles = state.gridTiles[row];
  if (!tiles) return;

  playSfx("flip");

  letters.forEach((obj, i) => {
    const tile = tiles[i];
    if (!tile) return;

    tile.textContent = (obj.letter || "").toUpperCase();
    tile.classList.add("tile-flip");

    setTimeout(() => {
      tile.classList.remove("tile-flip");
      tile.classList.remove("tile-correct", "tile-present", "tile-absent");
      if (obj.status === "correct") tile.classList.add("tile-correct");
      else if (obj.status === "present") tile.classList.add("tile-present");
      else tile.classList.add("tile-absent");
      updateKeyboardFromLetter(obj.letter, obj.status);
    }, 220);
  });

  if (isWin) {
    setTimeout(() => {
      roundStatusEl.textContent = "Pareizi!";
      state.isRoundOver = true;
      state.isLocked = false;
      spawnConfettiBurst();
      pulseVeinBig();
      playSfx("win");
      if (newGameBtn) {
        newGameBtn.disabled = false;
        newGameBtn.classList.remove("btn-disabled");
      }
    }, 260);
  } else {
    state.currentRow++;
    state.currentCol = 0;
    state.isLocked = false;
    if (state.currentRow >= state.rows) {
      state.isRoundOver = true;
      if (newGameBtn) {
        newGameBtn.disabled = false;
        newGameBtn.classList.remove("btn-disabled");
      }
    }
  }
}

// ===================== KLAVIATŪRAS KRĀSAS =====================

function updateKeyboardFromLetter(letter, status) {
  if (!letter) return;
  const key = letter.toUpperCase();
  const btn = state.keyboardButtons.get(key);
  if (!btn) return;

  if (status === "correct") {
    btn.classList.remove("key-present", "key-absent");
    btn.classList.add("key-correct");
  } else if (status === "present") {
    if (!btn.classList.contains("key-correct")) {
      btn.classList.remove("key-absent");
      btn.classList.add("key-present");
    }
  } else if (status === "absent") {
    if (
      !btn.classList.contains("key-correct") &&
      !btn.classList.contains("key-present")
    ) {
      btn.classList.add("key-absent");
    }
  }
}

// ===================== KLAVIATŪRAS EVENTI =====================

// Virtuālā klaviatūra
keyboardEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".key");
  if (!btn) return;
  const key = btn.dataset.key;
  if (!key) return;

  if (key === "SHIFT") {
    state.shiftOn = !state.shiftOn;
    updateShiftVisual();
    playKeyNote("Q");
    return;
  }

  if (key === "ENTER") {
    playKeyNote("Z");
    handleEnter();
    return;
  }
  if (key === "BACKSPACE") {
    playKeyNote("X");
    handleBackspace();
    return;
  }

  handleCharInput(key);
  playKeyNote(key);
});

// Fiziskā tastatūra
document.addEventListener("keydown", (e) => {
  if (e.key === "Shift") {
    state.shiftOn = true;
    updateShiftVisual();
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    playKeyNote("Z");
    handleEnter();
    return;
  }
  if (e.key === "Backspace") {
    e.preventDefault();
    playKeyNote("X");
    handleBackspace();
    return;
  }

  const key = e.key;
  if (key.length === 1) {
    let ch = key;
    if (state.shiftOn) {
      ch = toGarums(ch);
    }
    if (/^[a-zāčēģīķļņšūž]$/i.test(ch)) {
      handleCharInput(ch);
      playKeyNote(ch);
    }
  }
});

document.addEventListener("keyup", (e) => {
  if (e.key === "Shift") {
    state.shiftOn = false;
    updateShiftVisual();
  }
});

// ===================== SOCKET.IO =====================

function setupSocket() {
  // JWT tokens no login (index.html)
  const token = localStorage.getItem("varduzona_token");
  if (!token) {
    showToast("Nepieciešama autorizācija");
    window.location.href = "index.html";
    return;
  }

  const socket = io(SERVER_URL, {
    transports: ["websocket"],
    auth: { token },
  });

  state.socket = socket;

  socket.on("connect", () => {
    setConnectionStatus(true);
  });

  socket.on("disconnect", () => {
    setConnectionStatus(false);
  });

  socket.on("hello", (payload) => {
    try {
      setConnectionStatus(true);

      state.roundId = payload.roundId;
      state.maxAttempts = payload.maxAttempts || 6;
      const wl = payload.wordLength || 5;

      buildKeyboard();
      resetForNewRound(wl, state.maxAttempts, state.roundId);

      const s = payload.stats || {};
      state.xp = s.xp || 0;
      state.coins = s.coins || 0;
      state.tokens = s.tokens || 0;
      state.wins = s.wins || 0;
      state.streak = s.streak || 0;
      state.bestStreak = s.bestStreak || 0;
      state.rankTitle = s.rankTitle || "Jauniņais I";
      state.medalsCount = s.medalsCount || 0;
      state.lastMedal = s.lastMedal || null;
      state.bestFastWin = s.bestFastWin || null;

      state.isAdmin = !!payload.isAdmin;

      updateHudFromState();
      updateProfileModal();

      const finalName = payload.finalName || "Spēlētājs";
      nickLabelEl.textContent = finalName;

      const oldNick = getStoredNick();
      if (!oldNick) {
        setStoredNick(finalName);
      } else if (oldNick !== finalName) {
        if (nickConflictModalEl) {
          nickConflictOriginalEl.textContent = oldNick;
          nickConflictSuggestionEl.textContent = finalName;
          nickConflictModalEl.classList.remove("hidden");
        } else {
          setStoredNick(finalName);
        }
      }

      if (payload.leaderboard) {
        renderLeaderboard(payload.leaderboard);
      }
      if (payload.onlineCount != null) {
        onlineCountEl.textContent = payload.onlineCount;
      }
      if (payload.onlinePlayers) {
        renderOnlinePlayers(payload.onlinePlayers);
      }
      if (payload.recentSolves) {
        renderFeedFromArray(payload.recentSolves);
      }
      if (payload.chatHistory) {
        chatListEl.innerHTML = "";
        payload.chatHistory.forEach((m) => addChatMessage(m.name, m.text));
      }

      if (payload.dailyMissions) {
        renderDailyMissions(
          payload.dailyMissions.missions || [],
          payload.dailyProgress
        );
      }

      if (payload.dailyChampion) {
        dailyChampionEl.textContent =
          "Dienas čempions: " + payload.dailyChampion.name;
      } else {
        dailyChampionEl.textContent = "Dienas čempions: vēl nav";
      }
    } catch (err) {
      console.error("hello handler error", err);
    }
  });

  socket.on("onlineCount", (data) => {
    if (data && typeof data.count === "number") {
      onlineCountEl.textContent = data.count;
    }
  });

  socket.on("leaderboardUpdate", (data) => {
    if (!data || !Array.isArray(data.players)) return;
    renderLeaderboard(data.players);
  });

  socket.on("onlinePlayers", (data) => {
    if (!data || !Array.isArray(data.players)) return;
    renderOnlinePlayers(data.players);
  });

  socket.on("guessResult", (res) => {
    if (res.error) {
      state.isLocked = false;
      if (res.msg) showToast(res.msg);
      return;
    }

    if (!Array.isArray(res.letters)) {
      state.isLocked = false;
      return;
    }

    attemptsLeftEl.textContent = res.attemptsLeft ?? state.maxAttempts;
    applyGuessResultToRow(res.letters, !!res.isWin);
  });

  socket.on("newRound", (data) => {
    const wl = data.wordLength || 5;
    const maxAtt = data.maxAttempts || 6;
    state.roundId = data.roundId;
    resetForNewRound(wl, maxAtt, data.roundId);
  });

  socket.on("wordSolvedFeed", (data) => {
    if (!data) return;
    addFeedItem(data.name, data.xpGain, data.streak, data.coinsGain);
  });

  socket.on("chatMessage", (msg) => {
    if (!msg) return;
    addChatMessage(msg.name, msg.text);
  });

  socket.on("statsUpdate", (s) => {
    if (!s) return;
    state.xp = s.xp ?? state.xp;
    state.coins = s.coins ?? state.coins;
    state.tokens = s.tokens ?? state.tokens;
    state.wins = s.wins ?? state.wins;
    state.streak = s.streak ?? state.streak;
    state.bestStreak = s.bestStreak ?? state.bestStreak;
    state.rankTitle = s.rankTitle ?? state.rankTitle;

    state.medalsCount = s.medalsCount ?? state.medalsCount;
    state.lastMedal = s.lastMedal ?? state.lastMedal;
    state.bestFastWin = s.bestFastWin ?? state.bestFastWin;

    updateHudFromState();
    updateProfileModal();

    if (s.gainedXP || s.gainedCoins || s.dailyBonus) {
      let msgParts = [];
      if (s.gainedXP) msgParts.push("+" + s.gainedXP + " XP");
      if (s.gainedCoins) msgParts.push("+" + s.gainedCoins + " coins");
      if (s.dailyBonus) msgParts.push("Dienas bonuss +" + s.dailyBonus + " XP");
      if (msgParts.length) showToast(msgParts.join(" · "));

      if (s.gainedCoins) {
        playSfx("coins");
      }
    }
  });

  socket.on("dailyMissionsCompleted", (data) => {
    if (!data || !Array.isArray(data.missions)) return;
    const texts = data.missions.map((m) => m.text || m.key);
    if (texts.length) {
      showToast("Pabeigtas misijas: " + texts.join(", "));
      playSfx("mission");
    }
  });

  socket.on("dailyChampionUpdate", (data) => {
    if (!data) return;
    dailyChampionEl.textContent = "Dienas čempions: " + data.name;
    if (data.bonusXp && data.bonusXp > 0) {
      showToast(
        data.name + " kļuva par Dienas čempionu! (+" + data.bonusXp + " XP)"
      );
    }
  });

  socket.on("coinUpdate", (data) => {
    if (!data) return;
    if (typeof data.coins === "number") {
      state.coins = data.coins;
      updateHudFromState();
      updateProfileModal();
    }
    if (data.gained > 0) {
      showToast("+" + data.gained + " coins par online laiku");
      playSfx("coins");
    }
  });

  socket.on("roundMedal", (data) => {
    if (!data) return;
    const type = data.type || "";
    let label = "";
    if (type === "gold") label = "ZELTA medaļa";
    else if (type === "silver") label = "SUDRABA medaļa";
    else if (type === "bronze") label = "BRONZAS medaļa";
    if (label) {
      showToast(
        data.name +
          " ieguva " +
          label +
          ` (${data.attemptsUsed}. mēģinājumā, garums ${data.wordLength})`
      );
    }
  });

  socket.on("shopError", (data) => {
    if (data && data.msg) showToast(data.msg);
  });

  socket.on("banned", (data) => {
    const msg =
      (data && data.reason) ||
      "Tavs profils ir bloķēts VĀRDU ZONA spēlē.";
    alert(msg);
    setConnectionStatus(false);
  });
}

// ===================== HUD / PROFILS =====================

function updateHudFromState() {
  if (xpValueEl) xpValueEl.textContent = state.xp;
  if (streakValueEl) streakValueEl.textContent = state.streak;
  if (rankLabelEl) rankLabelEl.textContent = state.rankTitle;
  if (coinsValueEl) coinsValueEl.textContent = state.coins;
  if (tokensValueEl) tokensValueEl.textContent = state.tokens;

  if (shopCoinsEl) shopCoinsEl.textContent = state.coins;
  if (shopTokensEl) shopTokensEl.textContent = state.tokens;
}

function updateProfileModal() {
  if (!profileModalEl) return;
  profileNameEl.textContent = nickLabelEl.textContent || state.nickname;
  profileRankEl.textContent = state.rankTitle;
  profileXpEl.textContent = state.xp;
  profileWinsEl.textContent = state.wins;
  profileStreakEl.textContent = state.streak;
  profileBestStreakEl.textContent = state.bestStreak;
  profileCoinsEl.textContent = state.coins;
  profileTokensEl.textContent = state.tokens;

  if (profileTagEl) {
    profileTagEl.classList.remove("hidden");
  }

  if (profileMedalsCountEl) {
    profileMedalsCountEl.textContent = state.medalsCount || 0;
  }
  if (profileLastMedalEl) {
    if (state.lastMedal) {
      const m = state.lastMedal;
      let txt = "";
      if (m.type === "gold") txt += "Zelta";
      else if (m.type === "silver") txt += "Sudraba";
      else if (m.type === "bronze") txt += "Bronzas";
      txt += ` · ${m.attemptsUsed}. mēģ., garums ${m.wordLength}`;
      profileLastMedalEl.textContent = txt;
    } else {
      profileLastMedalEl.textContent = "Vēl nav medaļu";
    }
  }
  if (profileBestFastEl) {
    if (state.bestFastWin) {
      const m = state.bestFastWin;
      profileBestFastEl.textContent =
        m.attemptsUsed + ". mēģinājums · garums " + m.wordLength;
    } else {
      profileBestFastEl.textContent = "Vēl nav ātro uzvaru";
    }
  }
}

// ===================== LEADERBOARD =====================

function renderLeaderboard(players) {
  leaderboardListEl.innerHTML = "";
  if (!players.length) return;
  players.forEach((p, idx) => {
    const li = createEl("li");
    const posSpan = createEl("span", "pos");
    posSpan.textContent = idx + 1 + ".";
    const nameSpan = createEl("span", "lb-name");
    nameSpan.textContent = p.name || "Spēlētājs";
    const xpSpan = createEl("span", "lb-xp");
    xpSpan.textContent = (p.xp || 0) + " XP";

    li.appendChild(posSpan);
    li.appendChild(nameSpan);
    li.appendChild(xpSpan);

    leaderboardListEl.appendChild(li);
  });
}

// ===================== ONLINE SPĒLĒTĀJI =====================

function renderOnlinePlayers(list) {
  onlineListEl.innerHTML = "";
  if (!list.length) {
    const li = createEl("li", "online-empty");
    li.textContent = "Šobrīd neviens nav online.";
    onlineListEl.appendChild(li);
    return;
  }

  list.forEach((p) => {
    const li = createEl("li", "online-player");

    const av = createEl("div", "online-avatar");
    av.textContent = (p.name || "?")[0].toUpperCase();

    const txt = createEl("div", "online-text");
    const name = createEl("div", "online-name");
    name.textContent = p.name || "Spēlētājs";
    const rank = createEl("div", "online-rank");
    rank.textContent = p.rankTitle || "";

    txt.appendChild(name);
    txt.appendChild(rank);
    li.appendChild(av);
    li.appendChild(txt);

    if (state.isAdmin) {
      const actions = createEl("div", "online-admin-actions");

      const banBtn = createEl("button", "admin-btn admin-ban");
      banBtn.textContent = "BAN";
      banBtn.addEventListener("click", () => {
        if (!state.socket) return;
        if (
          confirm("Bloķēt profilu: " + (p.name || "Spēlētājs") + " ?")
        ) {
          state.socket.emit("adminBanProfile", {
            playerId: p.id,
            nickname: p.name,
          });
        }
      });

      actions.appendChild(banBtn);
      li.appendChild(actions);
    }

    onlineListEl.appendChild(li);
  });
}

// ===================== FEED “Kas tikko atminēja vārdu” =====================

function addFeedItem(name, xpGain, streak, coinsGain) {
  if (!feedListEl) return;
  const li = createEl("li", "feed-item");

  const nameSpan = createEl("span", "feed-name");
  nameSpan.textContent = name || "Spēlētājs";
  const textSpan = createEl("span", "feed-text");
  textSpan.textContent = "atminēja vārdu";

  li.appendChild(nameSpan);
  li.appendChild(textSpan);

  if (xpGain) {
    const xpSpan = createEl("span", "feed-xp");
    xpSpan.textContent = "+" + xpGain + " XP";
    li.appendChild(xpSpan);
  }
  if (streak > 1) {
    const stSpan = createEl("span", "feed-streak");
    stSpan.textContent = "Streak " + streak;
    li.appendChild(stSpan);
  }
  if (coinsGain) {
    const cSpan = createEl("span", "feed-coins");
    cSpan.textContent = "+" + coinsGain + " coins";
    li.appendChild(cSpan);
  }

  feedListEl.insertBefore(li, feedListEl.firstChild);
  while (feedListEl.children.length > 20) {
    feedListEl.removeChild(feedListEl.lastChild);
  }
}

function renderFeedFromArray(arr) {
  feedListEl.innerHTML = "";
  arr.forEach((e) => addFeedItem(e.name, e.xpGain, e.streak, e.coinsGain));
}

// ===================== ČATS =====================

function addChatMessage(name, text) {
  const li = createEl("li", "chat-item");
  const nameSpan = createEl("span", "chat-name");
  nameSpan.textContent = name || "Spēlētājs";
  const textSpan = createEl("span", "chat-text");
  textSpan.textContent = text || "";
  li.appendChild(nameSpan);
  li.appendChild(textSpan);
  chatListEl.appendChild(li);
  chatListEl.scrollTop = chatListEl.scrollHeight;
}

chatSendBtn.addEventListener("click", () => {
  sendChatMessage();
});
chatInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendChatMessage();
  }
});

function sendChatMessage() {
  if (!state.socket) return;
  const raw = chatInputEl.value.trim();
  if (!raw) return;
  state.socket.emit("chatMessage", { text: raw });
  chatInputEl.value = "";
}

// ===================== DIENAS MISIJAS =====================

function renderDailyMissions(missions, progress) {
  missionsListEl.innerHTML = "";
  const prog = (progress && progress.completed) || {};

  missions.forEach((m) => {
    const li = createEl("li", "mission-item");
    const txt = createEl("div", "mission-text");
    txt.textContent = m.text || "";

    const pr = createEl("div", "mission-progress");
    pr.textContent = `${m.target || "?"} mērķis`;

    li.appendChild(txt);
    li.appendChild(pr);

    if (prog[m.key]) {
      li.classList.add("done");
      pr.textContent = "Pabeigts";
    }

    missionsListEl.appendChild(li);
  });
}

// ===================== SHOP (ŽETONI) =====================

if (shopOpenBtn && shopModalEl) {
  shopOpenBtn.addEventListener("click", () => {
    shopCoinsEl.textContent = state.coins;
    shopTokensEl.textContent = state.tokens;
    shopModalEl.classList.remove("hidden");
  });
}
if (shopCloseBtn && shopModalEl) {
  shopCloseBtn.addEventListener("click", () => {
    shopModalEl.classList.add("hidden");
  });
}
if (buyTokenBtn) {
  buyTokenBtn.addEventListener("click", () => {
    if (!state.socket) return;
    state.socket.emit("buyToken");
  });
}

// ===================== NICK KONFLIKTA MODĀLIS =====================

if (nickConflictYesBtn && nickConflictModalEl) {
  nickConflictYesBtn.addEventListener("click", () => {
    const suggestion = nickConflictSuggestionEl.textContent || "";
    if (suggestion) setStoredNick(suggestion);
    nickLabelEl.textContent = suggestion || "Spēlētājs";
    nickConflictModalEl.classList.add("hidden");
  });
}
if (nickConflictNoBtn && nickConflictModalEl) {
  nickConflictNoBtn.addEventListener("click", () => {
    nickConflictModalEl.classList.add("hidden");
    const newNick = prompt("Ieraksti jaunu segvārdu (līdz 20 simboliem):", "");
    if (newNick && newNick.trim()) {
      setStoredNick(newNick.trim());
      window.location.reload();
    }
  });
}

// ===================== PROFILS =====================

if (profileBtn && profileModalEl) {
  profileBtn.addEventListener("click", () => {
    updateProfileModal();
    profileModalEl.classList.remove("hidden");
  });
}
if (profileCloseBtn && profileModalEl) {
  profileCloseBtn.addEventListener("click", () => {
    profileModalEl.classList.add("hidden");
  });
}

// ===================== AVATARS =====================

if (avatarCircleEl && avatarInputEl) {
  avatarCircleEl.addEventListener("click", () => {
    avatarInputEl.click();
  });

  avatarInputEl.addEventListener("change", () => {
    const file = avatarInputEl.files && avatarInputEl.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    avatarCircleEl.style.backgroundImage = `url("${url}")`;
  });
}

// ===================== JAUNA SPĒLE POGA =====================

if (newGameBtn) {
  newGameBtn.addEventListener("click", () => {
    if (!state.socket) return;
    state.socket.emit("requestNewRound");
    newGameBtn.disabled = true;
    newGameBtn.classList.add("btn-disabled");
  });
}

// ===================== FONA MŪZIKA =====================

let musicOn = false;
if (musicToggleBtn && bgMusicEl) {
  musicToggleBtn.addEventListener("click", async () => {
    try {
      ensureAudioCtx();
    } catch (e) {}

    if (!musicOn) {
      try {
        await bgMusicEl.play();
        musicOn = true;
        musicToggleBtn.textContent = "🎵 Mūzika: ON";
      } catch (err) {
        console.error("BG music play error:", err);
        showToast("Neizdevās palaist mūziku (pārlūka ierobežojumi)");
      }
    } else {
      bgMusicEl.pause();
      musicOn = false;
      musicToggleBtn.textContent = "🎵 Mūzika: OFF";
    }
  });
}

// ===================== INIT =====================

function initNickname() {
  let nick = getStoredNick();
  if (!nick) {
    nick = "Spēlētājs";
    setStoredNick(nick);
  }
  state.nickname = nick;
  nickLabelEl.textContent = nick;
}

function init() {
  initNickname();
  buildKeyboard();
  setupSocket();
  setConnectionStatus(false);
}

document.addEventListener("DOMContentLoaded", init);

// ===================== LOGOUT =====================
const logoutBtn = document.createElement("button");
logoutBtn.textContent = "Iziet no profila";
logoutBtn.className = "pill-btn pill-outline";
logoutBtn.style.marginTop = "10px";
document.querySelector(".hud").appendChild(logoutBtn);

logoutBtn.addEventListener("click", () => {
  if (confirm("Vai tiešām vēlies iziet?")) {
    localStorage.removeItem("varduzona_token");
    window.location.href = "index.html";
  }
});

// ===================== PAROLES MAIŅA =====================
const changePassBtn = document.createElement("button");
changePassBtn.textContent = "Mainīt paroli";
changePassBtn.className = "pill-btn pill-outline";
changePassBtn.style.marginTop = "10px";
document.querySelector(".hud").appendChild(changePassBtn);

changePassBtn.addEventListener("click", async () => {
  const oldPassword = prompt("Ievadi veco paroli:");
  if (!oldPassword) return;
  const newPassword = prompt("Ievadi jauno paroli:");
  if (!newPassword) return;
  const confirmNew = prompt("Atkārto jauno paroli:");
  if (!confirmNew) return;

  const token = localStorage.getItem("varduzona_token");
  if (!token) return alert("Nepieciešama autorizācija.");

  try {
    const res = await fetch(
      "https://bugats-wordle-server.onrender.com/change-password",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, oldPassword, newPassword, confirmNew }),
      }
    );
    const data = await res.json();
    alert(data.message || "Nezināma kļūda");
  } catch (err) {
    alert("Servera kļūda");
  }
});
