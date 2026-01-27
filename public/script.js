// ================== KONFIGS ==================
const API_BASE = "https://bugats-wordle-server.onrender.com"; // TAVS RENDER SERVERIS

// ===== Helperi =====
function $(sel) {
  return document.querySelector(sel);
}
function createEl(tag, cls) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  return el;
}

// ===== Klienta stāvoklis =====
const state = {
  token: null,
  username: null,

  rows: 6,
  cols: 5,
  currentRow: 0,
  currentCol: 0,
  wordLength: 5,
  isLocked: false,
  roundFinished: false, // vai drīkst sākt jaunu raundu

  gridTiles: [], // [row][col] -> tile element
  keyboardButtons: new Map(), // key -> button
  shiftOn: false,

  socket: null,
};

// ===== DOM REF =====
const authScreen = $("#auth-screen");
const gameScreen = $("#game-screen");

const signupForm = $("#signup-form");
const signupUsername = $("#signup-username");
const signupPassword = $("#signup-password");

const loginForm = $("#login-form");
const loginUsername = $("#login-username");
const loginPassword = $("#login-password");

const authError = $("#auth-error");

const statUsername = $("#stat-username");
const statRank = $("#stat-rank");
const statXp = $("#stat-xp");
const statScore = $("#stat-score");
const statCoins = $("#stat-coins");
const statTokens = $("#stat-tokens");
const statStreak = $("#stat-streak");

// opcionali – ja HTML pusē ir medaļu josla
const statMedalsStrip = $("#player-medals");

const btnLogout = $("#btn-logout");
const newRoundBtn = $("#new-round-btn");

const gridEl = $("#grid");
const attemptsLeftEl = $("#attempts-left");
const roundStatusEl = $("#round-status");

const keyboardEl = $("#keyboard");

const leaderboardBody = $("#leaderboard-body");
const onlineCountEl = $("#online-count");
const onlineListEl = $("#online-list");

const chatMessagesEl = $("#chat-messages");
const chatInputEl = $("#chat-input");
const chatSendBtn = $("#chat-send");

const missionsListEl = $("#missions-list"); // DIENAS MISIJAS UL

const profilePopupEl = $("#player-profile-popup");
const profileCloseBtn = $("#profile-popup-close");
const ppUsernameEl = $("#pp-username");
const ppRankEl = $("#pp-rank");
const ppXpEl = $("#pp-xp");
const ppScoreEl = $("#pp-score");
const ppCoinsEl = $("#pp-coins");
const ppTokensEl = $("#pp-tokens");
const ppBestEl = $("#pp-best");
// ja popup HTML pusē ieliksi <div id="pp-medals"></div> — rādīšu arī medaļas
const ppMedalsEl = $("#pp-medals");

// ==================== AUTH LOĢIKA ====================

async function apiPost(path, body) {
  const res = await fetch(API_BASE + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { Authorization: "Bearer " + state.token } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    const txt = await res.text();
    let msg = txt;
    try {
      const j = JSON.parse(txt);
      msg = j.message || txt;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

async function apiGet(path) {
  const res = await fetch(API_BASE + path, {
    headers: {
      ...(state.token ? { Authorization: "Bearer " + state.token } : {}),
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    let msg = txt;
    try {
      const j = JSON.parse(txt);
      msg = j.message || txt;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

function setAuthError(msg) {
  if (!authError) return;
  authError.textContent = msg || "";
}

function saveAuth(token, username) {
  state.token = token;
  state.username = username;
  localStorage.setItem("vz_token", token);
  localStorage.setItem("vz_username", username);
}

function clearAuth() {
  state.token = null;
  state.username = null;
  localStorage.removeItem("vz_token");
  localStorage.removeItem("vz_username");
}

async function handleSignup(e) {
  e.preventDefault();
  setAuthError("");
  try {
    const username = signupUsername.value.trim();
    const password = signupPassword.value;
    const data = await apiPost("/signup", { username, password });
    saveAuth(data.token, data.username);
    await enterGameAfterAuth();
  } catch (err) {
    setAuthError(err.message || "Signup kļūda");
  }
}

async function handleLogin(e) {
  e.preventDefault();
  setAuthError("");
  try {
    const username = loginUsername.value.trim();
    const password = loginPassword.value;
    const data = await apiPost("/login", { username, password });
    saveAuth(data.token, data.username);
    await enterGameAfterAuth();
  } catch (err) {
    setAuthError(err.message || "Login kļūda");
  }
}

async function enterGameAfterAuth() {
  try {
    const me = await apiGet("/me");
    updateStats(me);
    switchToGameScreen();
    initSocket();
    await startNewRound();
    refreshLeaderboard();
    refreshMissions(); // DIENAS MISIJAS pēc login
  } catch (err) {
    setAuthError(err.message || "Neizdevās ielādēt profilu");
    clearAuth();
  }
}

function switchToGameScreen() {
  if (!authScreen || !gameScreen) return;
  authScreen.classList.add("hidden");
  gameScreen.classList.remove("hidden");
  if (statUsername) statUsername.textContent = state.username || "";

  // tumšais fons spēlei
  document.body.classList.remove("auth-page-body");
  document.body.classList.add("vz-body-game");
}

function switchToAuthScreen() {
  if (!authScreen || !gameScreen) return;
  gameScreen.classList.add("hidden");
  authScreen.classList.remove("hidden");

  document.body.classList.remove("vz-body-game");
  document.body.classList.add("auth-page-body");
}

// Logout poga
if (btnLogout) {
  btnLogout.addEventListener("click", () => {
    if (state.socket) {
      state.socket.disconnect();
      state.socket = null;
    }
    clearAuth();
    switchToAuthScreen();
  });
}

// Formu eventi
if (signupForm) signupForm.addEventListener("submit", handleSignup);
if (loginForm) loginForm.addEventListener("submit", handleLogin);

// Auto-login, ja token jau ir
(async function autoLogin() {
  const token = localStorage.getItem("vz_token");
  const username = localStorage.getItem("vz_username");
  if (!token || !username) return;

  state.token = token;
  state.username = username;
  try {
    const me = await apiGet("/me");
    updateStats(me);
    switchToGameScreen();
    initSocket();
    await startNewRound();
    refreshLeaderboard();
    refreshMissions(); // DIENAS MISIJAS arī auto-login gadījumā
  } catch (err) {
    clearAuth();
  }
})();

// ==================== STATS / PROFILS ====================

function renderPlayerMedals(medals) {
  if (!statMedalsStrip) return;
  statMedalsStrip.innerHTML = "";

  const list = medals || [];
  if (!list.length) {
    const span = createEl("span", "vz-medal-empty");
    span.textContent = "nav vēl";
    statMedalsStrip.appendChild(span);
    return;
  }

  list.forEach((m) => {
    const span = createEl("span", "vz-medal");
    span.textContent = (m.icon || "") + " " + (m.label || "");
    statMedalsStrip.appendChild(span);
  });
}

function updateStats(me) {
  if (!me) return;
  if (statUsername) statUsername.textContent = me.username;
  if (statRank) statRank.textContent = `${me.rankTitle} (L${me.rankLevel})`;
  if (statXp) statXp.textContent = me.xp;
  if (statScore) statScore.textContent = me.score;
  if (statCoins) statCoins.textContent = me.coins;
  if (statTokens) statTokens.textContent = me.tokens;
  if (statStreak) statStreak.textContent = me.streak;

  // medaļas no /me
  if (me.medals && statMedalsStrip) {
    renderPlayerMedals(me.medals);
  }

  // profila "karstums" pēc streak
  const card = document.querySelector(".vz-player-card");
  if (card) {
    if (me.streak >= 3) card.classList.add("vz-profile-hot");
    else card.classList.remove("vz-profile-hot");
  }
}

// PROFILA POPUP
function showPlayerProfile(data) {
  if (!data || !profilePopupEl) return;
  if (ppUsernameEl) ppUsernameEl.textContent = data.username;
  if (ppRankEl) ppRankEl.textContent = `${data.rankTitle} (L${data.rankLevel})`;
  if (ppXpEl) ppXpEl.textContent = data.xp;
  if (ppScoreEl) ppScoreEl.textContent = data.score;
  if (ppCoinsEl) ppCoinsEl.textContent = data.coins;
  if (ppTokensEl) ppTokensEl.textContent = data.tokens;
  if (ppBestEl) ppBestEl.textContent = data.bestStreak;

  // medaļas popupā (ja ir HTML elements)
  if (ppMedalsEl) {
    ppMedalsEl.innerHTML = "";
    const medals = data.medals || [];
    if (!medals.length) {
      ppMedalsEl.textContent = "Medaļas: nav vai neizšķirts ar citiem.";
    } else {
      const ul = createEl("ul", "pp-medals-list");
      medals.forEach((m) => {
        const li = createEl("li", "pp-medal-item");
        li.textContent = (m.icon || "") + " " + (m.label || "");
        ul.appendChild(li);
      });
      ppMedalsEl.appendChild(ul);
    }
  }

  profilePopupEl.classList.remove("hidden");
}

function hidePlayerProfile() {
  if (!profilePopupEl) return;
  profilePopupEl.classList.add("hidden");
}
if (profileCloseBtn) {
  profileCloseBtn.addEventListener("click", hidePlayerProfile);
}
if (profilePopupEl) {
  profilePopupEl.addEventListener("click", (e) => {
    if (e.target === profilePopupEl) hidePlayerProfile();
  });
}

async function openProfile(username) {
  if (!username || !state.token) return;
  try {
    // izmanto JAM jaunāko maršrutu no servera: /profile/:username
    const data = await apiGet("/profile/" + encodeURIComponent(username));
    showPlayerProfile(data);
  } catch (err) {
    console.error("Profila kļūda:", err);
  }
}

// ==================== DIENAS MISIJAS ====================

function renderMissions(missions) {
  if (!missionsListEl) return;
  missionsListEl.innerHTML = "";

  if (!missions || !missions.length) {
    const li = createEl("li", "mission-item");
    const status = createEl("div", "mission-status");
    status.textContent = "Šodien nav pieejamu misiju.";
    li.appendChild(status);
    missionsListEl.appendChild(li);
    return;
  }

  missions.forEach((m) => {
    const li = createEl("li", "mission-item");

    const title = createEl("div", "mission-title");
    title.textContent = m.title;
    li.appendChild(title);

    const progress = createEl("div", "mission-progress");
    progress.textContent = `${m.progress}/${m.target}`;
    li.appendChild(progress);

    const rw = m.rewards || {};
    const rewardParts = [];
    if (rw.xp) rewardParts.push(`+${rw.xp} XP`);
    if (rw.coins) rewardParts.push(`+${rw.coins} coins`);
    if (rw.tokens) rewardParts.push(`+${rw.tokens} žetoni`);

    if (rewardParts.length) {
      const rewardsEl = createEl("div", "mission-rewards");
      rewardsEl.textContent = "Balva: " + rewardParts.join(", ");
      li.appendChild(rewardsEl);
    }

    const bottom = createEl("div", "mission-bottom");
    li.appendChild(bottom);

    const statusSpan = createEl(
      "span",
      m.isCompleted
        ? m.isClaimed
          ? "mission-status-done"
          : "mission-status"
        : "mission-status"
    );

    if (!m.isCompleted) {
      statusSpan.textContent = "Progressā";
    } else if (m.isCompleted && !m.isClaimed) {
      statusSpan.textContent = "Gatavs saņemšanai";
    } else {
      statusSpan.textContent = "Balva saņemta";
    }

    bottom.appendChild(statusSpan);

    if (m.isCompleted && !m.isClaimed) {
      const btn = createEl("button", "mission-claim-btn");
      btn.textContent = "Saņemt";
      btn.addEventListener("click", () => claimMission(m.id));
      bottom.appendChild(btn);
    }

    missionsListEl.appendChild(li);
  });
}

async function refreshMissions() {
  if (!missionsListEl || !state.token) return;
  try {
    const data = await apiGet("/missions");
    const missions = Array.isArray(data) ? data : Array.isArray(data.missions) ? data.missions : [];
    renderMissions(missions);
  } catch (err) {
    console.error("Misiju kļūda:", err);
  }
}

async function claimMission(id) {
  try {
    const data = await apiPost("/missions/claim", { id });
    if (data.me) updateStats(data.me);
    if (data.missions) renderMissions(data.missions);
    appendSystemMessage("✅ Misijas balva saņemta!");
  } catch (err) {
    console.error("Misijas claim kļūda:", err);
    appendSystemMessage(err.message || "Misijas kļūda, mēģini vēlreiz.");
  }
}

// ==================== GRID / SPĒLE ====================

function resetGrid(len) {
  state.wordLength = len;
  state.cols = len;
  state.currentRow = 0;
  state.currentCol = 0;
  state.isLocked = false;
  state.roundFinished = false;

  if (!gridEl) return;
  gridEl.innerHTML = "";
  state.gridTiles = [];

  for (let r = 0; r < state.rows; r++) {
    const rowEl = createEl("div", "grid-row");
    const rowTiles = [];
    for (let c = 0; c < state.cols; c++) {
      const tile = createEl("div", "tile");
      tile.dataset.row = r;
      tile.dataset.col = c;
      rowEl.appendChild(tile);
      rowTiles.push(tile);
    }
    gridEl.appendChild(rowEl);
    state.gridTiles.push(rowTiles);
  }

  if (attemptsLeftEl) attemptsLeftEl.textContent = state.rows;
  if (roundStatusEl) roundStatusEl.textContent = "";

  if (newRoundBtn) {
    newRoundBtn.disabled = true; // sākumā nevar spiest
  }
}

async function startNewRound() {
  if (!state.token) return;
  try {
    const data = await apiGet("/start-round");
    const len = data.len || 5;
    resetGrid(len);
    // atjauno solo raundu pēc refresh/disconnect (ja serveris atdod history)
if (Array.isArray(data.history) && data.history.length) {
  data.history.forEach((h, r) => {
    const guess = String(h?.guess || "");
    for (let c = 0; c < guess.length; c++) {
      const tile = state.gridTiles?.[r]?.[c];
      if (!tile) continue;
      tile.dataset.letter = guess[c];
      tile.textContent = guess[c];
    }
    revealRow(r, h?.pattern || []);
  });
 
  state.currentRow = data.history.length;
  state.currentCol = 0;
  state.isLocked = false;
}
 
if (attemptsLeftEl && data.attemptsLeft != null) {
  attemptsLeftEl.textContent = data.attemptsLeft;
}
  } catch (err) {
    console.error("start-round kļūda:", err);
    if (roundStatusEl)
      roundStatusEl.textContent = "Neizdevās sākt raundu";
  }
}

// Jauns raunds poga – tikai, ja iepriekšējais raunds ir beidzies
if (newRoundBtn) {
  newRoundBtn.addEventListener("click", () => {
    if (!state.roundFinished) {
      if (roundStatusEl)
        roundStatusEl.textContent =
          "Pabeidz raundu līdz galam, tad var sākt jaunu.";
      return;
    }
    startNewRound();
  });
}

// Fiziskās tastatūras apstrāde
window.addEventListener("keydown", (e) => {
  const active = document.activeElement;
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
    return;
  }

  if (state.isLocked) return;

  if (e.key === "Enter") {
    e.preventDefault();
    playControlNote("enter");
    submitGuess();
    return;
  }
  if (e.key === "Backspace") {
    e.preventDefault();
    playControlNote("backspace");
    deleteLetter();
    return;
  }

  if (e.key === "Shift") {
    e.preventDefault();
    toggleShift();
    // vari ielikt mazu toni arī te, ja gribi:
    // playControlNote("shift");
    return;
  }

  const ch = normalizeLetter(e.key);
  if (!ch) return;
  e.preventDefault();
  addLetter(ch);
  playKeyNote(ch); // KLAVIERU NOTS PIE KATRA BURTA
});

// Latvian burti ar Shift
const LATVIAN_MAP = {
  A: "Ā",
  C: "Č",
  E: "Ē",
  G: "Ģ",
  I: "Ī",
  K: "Ķ",
  L: "Ļ",
  N: "Ņ",
  S: "Š",
  U: "Ū",
  Z: "Ž",
};

// droša pret speciālajiem taustiņiem
function normalizeLetter(raw) {
  if (raw == null) return "";

  let ch = String(raw);

  if (ch.length !== 1) return "";

  ch = ch.toUpperCase();

  if (state.shiftOn && LATVIAN_MAP[ch]) {
    return LATVIAN_MAP[ch];
  }

  return ch;
}

function addLetter(ch) {
  if (state.currentCol >= state.cols || state.currentRow >= state.rows) return;
  const tile = state.gridTiles[state.currentRow][state.currentCol];
  tile.textContent = ch;
  tile.dataset.letter = ch;
  tile.classList.remove("flip", "correct", "present", "absent");
  state.currentCol++;
}

function deleteLetter() {
  if (state.currentCol <= 0) return;
  state.currentCol--;
  const tile = state.gridTiles[state.currentRow][state.currentCol];
  tile.textContent = "";
  tile.dataset.letter = "";
  tile.classList.remove("flip", "correct", "present", "absent");
}

async function submitGuess() {
  if (state.isLocked) return;
  if (state.currentCol !== state.cols) {
    flashRow(state.currentRow);
    if (roundStatusEl)
      roundStatusEl.textContent = `Vārdam jābūt ${state.cols} burtiem.`;
    return;
  }

  const letters = [];
  for (let c = 0; c < state.cols; c++) {
    const tile = state.gridTiles[state.currentRow][c];
    letters.push(tile.dataset.letter || "");
  }
  const guess = letters.join("");
  if (!guess || guess.length !== state.cols) return;

  state.isLocked = true;
  try {
    const data = await apiPost("/guess", { guess });
    const pattern = data.pattern || [];
    revealRow(state.currentRow, pattern);

    if (attemptsLeftEl)
      attemptsLeftEl.textContent = data.attemptsLeft ?? 0;

    if (data.win) {
      if (roundStatusEl)
        roundStatusEl.textContent = "Precīzi! Tu atminēji vārdu!";
      showWinEffects();
      state.roundFinished = true;
      if (newRoundBtn) newRoundBtn.disabled = false;

      const me = await apiGet("/me");
      updateStats(me);
      refreshMissions();

      setTimeout(() => {
        startNewRound();
      }, 1500);
    } else if (data.finished) {
      if (roundStatusEl)
        roundStatusEl.textContent = "Raunds beidzies!";
      state.roundFinished = true;
      if (newRoundBtn) newRoundBtn.disabled = false;

      const me = await apiGet("/me");
      updateStats(me);
      refreshMissions();

      setTimeout(() => {
        startNewRound();
      }, 1500);
    } else {
      state.currentRow++;
      state.currentCol = 0;
      state.isLocked = false;
      const me = await apiGet("/me");
      updateStats(me);
      refreshMissions();
    }
  } catch (err) {
    console.error("/guess kļūda:", err);
    if (roundStatusEl)
      roundStatusEl.textContent = err.message || "Kļūda minējumā";
    state.isLocked = false;
  }
}

function revealRow(rowIndex, pattern) {
  for (let c = 0; c < state.cols; c++) {
    const tile = state.gridTiles[rowIndex][c];
    const res = pattern[c] || "absent";
    setTimeout(() => {
      tile.classList.add("flip");
      tile.classList.remove("correct", "present", "absent");
      tile.classList.add(res);
      updateKeyboardColor(tile.dataset.letter, res);
    }, c * 120);
  }
}

function flashRow(rowIndex) {
  const row = state.gridTiles[rowIndex];
  row.forEach((tile) => {
    tile.classList.add("shake");
    setTimeout(() => tile.classList.remove("shake"), 300);
  });
}

function showWinEffects() {
  if (!gridEl) return;
  gridEl.classList.add("win-glow");
  setTimeout(() => gridEl.classList.remove("win-glow"), 1200);
}

// ==================== EKRĀNA TASTATŪRA ====================

const KEYBOARD_LAYOUT = [
  ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
  ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
  ["SHIFT", "Z", "X", "C", "V", "B", "N", "M", "⌫", "ENTER"],
];

function buildKeyboard() {
  if (!keyboardEl) return;

  keyboardEl.innerHTML = "";
  state.keyboardButtons.clear();

  KEYBOARD_LAYOUT.forEach((row) => {
    const rowEl = createEl("div", "kb-row");
    row.forEach((key) => {
      const btn = createEl("button", "kb-key");
      btn.textContent = key;
      if (key === "SHIFT") btn.classList.add("kb-shift");
      if (key === "ENTER") btn.classList.add("kb-enter");
      if (key === "⌫") btn.classList.add("kb-backspace");

      btn.addEventListener("click", () => {
  if (state.isLocked && key !== "SHIFT") return;

  if (key === "ENTER") {
    playControlNote("enter");
    submitGuess();
  } else if (key === "⌫") {
    playControlNote("backspace");
    deleteLetter();
  } else if (key === "SHIFT") {
    toggleShift();
    // playControlNote("shift"); // ja gribi skaņu arī Shift
  } else {
    const ch = normalizeLetter(key);
    if (ch) {
      addLetter(ch);
      playKeyNote(ch); // KLAVIERU NOTS ARĪ UZ EKRĀNA TAUSTIŅIEM
    }
  }
});

      rowEl.appendChild(btn);
      if (key.length === 1 || key === "SHIFT") {
        state.keyboardButtons.set(key, btn);
      }
    });
    keyboardEl.appendChild(rowEl);
  });

  updateShiftVisual();
}

function toggleShift() {
  state.shiftOn = !state.shiftOn;
  updateShiftVisual();
}

function updateShiftVisual() {
  if (!keyboardEl) return;
  keyboardEl
    .querySelectorAll(".kb-shift")
    .forEach((btn) => btn.classList.toggle("kb-shift-on", !!state.shiftOn));
}

function updateKeyboardColor(letter, status) {
  if (!letter) return;
  const base = letter.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const btnNormal = state.keyboardButtons.get(base);
  const btnLatvian = state.keyboardButtons.get(letter);

  [btnNormal, btnLatvian].forEach((btn) => {
    if (!btn) return;
    const priority = { correct: 3, present: 2, absent: 1 };
    const current = btn.dataset.status || "";
    if (current && priority[current] >= priority[status]) return;
    btn.dataset.status = status;
    btn.classList.remove("correct", "present", "absent");
    btn.classList.add(status);
  });
}

// ==================== LEADERBOARD / ONLINE ====================

async function refreshLeaderboard() {
  try {
    const list = await apiGet("/leaderboard");
    if (!leaderboardBody) return;
    leaderboardBody.innerHTML = "";
    list.forEach((item) => {
      const tr = document.createElement("tr");

      const tdPlace = document.createElement("td");
      tdPlace.textContent = item.place;
      tr.appendChild(tdPlace);

      const tdName = document.createElement("td");
      const span = document.createElement("span");
      span.textContent = item.username;
      span.className = "clickable-username";
      span.addEventListener("click", () => openProfile(item.username));
      tdName.appendChild(span);
      tr.appendChild(tdName);

      const tdScore = document.createElement("td");
      tdScore.textContent = item.score;
      tdScore.style.textAlign = "right";

      // rankTitle neliekam atsevišķā kolonnā, bet varam ielikt kā tooltip
      if (item.rankTitle) {
        tdScore.title = item.rankTitle;
      }

      tr.appendChild(tdScore);

      leaderboardBody.appendChild(tr);
    });
  } catch (err) {
    console.error("Leaderboard kļūda:", err);
  }
}
setInterval(refreshLeaderboard, 15000);

// ONLINE saraksts
function updateOnlineList(data) {
  const { count, users } = data || { count: 0, users: [] };
  if (onlineCountEl) onlineCountEl.textContent = count || 0;
  if (!onlineListEl) return;
  onlineListEl.innerHTML = "";
 (users || []).forEach((u) => {
  const name = typeof u === "string" ? u : (u && u.username) ? u.username : "";
  if (!name) return;
 
  const li = document.createElement("li");
  const span = document.createElement("span");
  span.textContent = name;
  span.className = "clickable-username";
  span.addEventListener("click", () => openProfile(name));
  li.appendChild(span);
  onlineListEl.appendChild(li);
});
}

// ==================== ČATS / SOCKET ====================

function appendChatMessage(msg) {
  if (!chatMessagesEl) return;
  const row = createEl("div", "chat-row");
  const time = new Date(msg.ts || Date.now());
  const timeStr = time.toLocaleTimeString("lv-LV", {
    hour: "2-digit",
    minute: "2-digit",
  });

  const timeSpan = createEl("span", "chat-time");
  timeSpan.textContent = `[${timeStr}] `;
  row.appendChild(timeSpan);

  const nameSpan = createEl(
    "span",
    msg.username === "SYSTEM" ? "chat-name-system" : "chat-name"
  );
  if (msg.username === "SYSTEM") {
    nameSpan.textContent = "SYSTEM: ";
  } else {
    const clickable = createEl("span", "clickable-username");
    clickable.textContent = msg.username + ": ";
    clickable.addEventListener("click", () => openProfile(msg.username));
    nameSpan.appendChild(clickable);
  }
  row.appendChild(nameSpan);

  const textSpan = createEl("span", "chat-text");
  textSpan.textContent = msg.text;
  row.appendChild(textSpan);

  chatMessagesEl.appendChild(row);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function appendSystemMessage(text) {
  appendChatMessage({
    username: "SYSTEM",
    text,
    ts: Date.now(),
  });
}

function initSocket() {
  if (!state.token) return;
  if (typeof io === "undefined") {
    console.error("Socket.IO klients nav ielādēts");
    return;
  }

  if (state.socket) {
    state.socket.disconnect();
    state.socket = null;
  }

  const socket = io(API_BASE, {
    auth: { token: state.token },
    transports: ["websocket", "polling"],
  });

  state.socket = socket;

  socket.on("connect", () => {
  appendSystemMessage("Pieslēgts VĀRDU ZONAS serverim.");
  startNewRound();       // atjauno gridu pēc reconnect
  refreshLeaderboard();
  refreshMissions();
});

  socket.on("connect_error", (err) => {
    console.error("Socket connect_error:", err.message || err);
    appendSystemMessage("Neizdevās pieslēgties čatam.");
  });

  socket.on("disconnect", () => {
    appendSystemMessage("Atvienots no servera.");
  });

  socket.on("chatMessage", (msg) => {
    // Dienas login bonuss atnāks kā SYSTEM ziņa ar tekstu "Dienas ienākšanas bonuss..."
    if (
      msg.username === "SYSTEM" &&
      typeof msg.text === "string" &&
      msg.text.toLowerCase().includes("dienas ienākšanas bonuss")
    ) {
      // te vari pielikt kādu speciālu vizuālo efektu, ja gribi
    }
    appendChatMessage(msg);
  });

  socket.on("onlineList", (data) => {
    updateOnlineList(data);
  });

  socket.on("playerWin", (info) => {
    const txt = `🔥 ${info.username} atminēja vārdu! +${info.xpGain} XP, +${info.coinsGain} coins (streak: ${info.streak}) — rank: ${info.rankTitle}`;
    appendSystemMessage(txt);
  });

  socket.on("tokenBuy", (info) => {
    const txt = `🎟️ ${info.username} nopirka žetonu! Tagad: ${info.tokens} žetoni.`;
    appendSystemMessage(txt);
  });

  socket.on("forceDisconnect", ({ reason }) => {
    appendSystemMessage("Tevi atvienoja: " + (reason || ""));
    socket.disconnect();
  });
}

// Čata sūtīšana
function sendChatMessage() {
  const text = chatInputEl ? chatInputEl.value.trim() : "";
  if (!text) return;
  if (!state.socket) return;
  state.socket.emit("chatMessage", text);
  if (chatInputEl) chatInputEl.value = "";
}

if (chatSendBtn) {
  chatSendBtn.addEventListener("click", sendChatMessage);
}
if (chatInputEl) {
  chatInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendChatMessage();
    }
  });
}

// ==================== INIT ====================

buildKeyboard();
