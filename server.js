// ======== KONFIGS ========
const SERVER_URL = "https://bugats-wordle-server.onrender.com"; // pielāgo ja nepieciešams
const socketOpts = { transports: ["websocket"] };

// ======== PALĪGFUNKCIJAS ========
function $(sel) { return document.querySelector(sel); }
function createEl(tag, cls) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  return el;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function getCID() {
  let cid = localStorage.getItem("varduzonaCID");
  if (!cid) {
    cid = crypto.randomUUID();
    localStorage.setItem("varduzonaCID", cid);
  }
  return cid;
}
function showToast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  el.classList.remove("hidden");
  setTimeout(() => el.classList.remove("show"), 2200);
}

// ======== AUTENTIFIKĀCIJA ========

// vienkāršs login/signup dialogs
async function showAuthModal() {
  const username = prompt("Ievadi savu segvārdu:");
  if (!username) return showAuthModal();

  const password = prompt("Ievadi paroli:");
  if (!password) return showAuthModal();

  // mēģinām login, ja neizdodas — signup
  let res = await fetch(`${SERVER_URL}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });

  if (res.status === 401) {
    // ja nav profila — izveidojam
    res = await fetch(`${SERVER_URL}/api/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, cid: getCID() })
    });
  }

  const data = await res.json();
  if (data.error) return showToast(data.error);

  localStorage.setItem("jwtToken", data.token);
  localStorage.setItem("nickname", data.profile.username);

  showToast("Sveiks, " + data.profile.username + "!");
  connectSocket();
}

// ======== SOCKET SAVIENOJUMS ========
let socket = null;
let state = {
  rows: 6,
  cols: 5,
  currentRow: 0,
  currentCol: 0,
  wordLength: 5,
  roundId: null,
  maxAttempts: 6,
  isLocked: false,
};

function connectSocket() {
  const token = localStorage.getItem("jwtToken");
  if (!token) return showAuthModal();

  socket = io(SERVER_URL, {
    ...socketOpts,
    auth: { token, cid: getCID() }
  });

  socket.on("connect", () => {
    $("#connection-indicator").textContent = "Savienots";
    $("#connection-indicator").className = "conn-text conn-ok";
  });

  socket.on("disconnect", () => {
    $("#connection-indicator").textContent = "Nav savienojuma ar serveri";
    $("#connection-indicator").className = "conn-text conn-err";
  });

  // ======== SERVERA NOTIKUMI ========

  socket.on("hello", (data) => {
    console.log("HELLO", data);
    state.roundId = data.roundId;
    state.wordLength = data.wordLength;
    state.maxAttempts = data.maxAttempts;

    updateHUD(data.stats);
    renderLeaderboard(data.leaderboard);
    renderOnline(data.onlinePlayers);
    renderChat(data.chatHistory);
    renderFeed(data.recentSolves);
    renderMissions(data.dailyMissions.missions, data.dailyProgress.completed);

    initGrid(state.wordLength);
    $("#attempts-left").textContent = state.maxAttempts;
  });

  socket.on("guessResult", (res) => {
    if (res.error) return showToast(res.msg);
    const row = state.currentRow;
    res.letters.forEach((l, i) => {
      fillTile(row, i, l.letter);
      flipTile(row, i, l.status);
    });
    if (res.isWin) {
      showToast("Pareizi!");
      playSound("snd-win");
      spawnConfetti();
      socket.emit("requestNewRound");
    } else {
      $("#attempts-left").textContent = res.attemptsLeft;
      state.currentRow++;
      state.currentCol = 0;
    }
  });

  socket.on("statsUpdate", (data) => updateHUD(data));
  socket.on("leaderboardUpdate", (d) => renderLeaderboard(d.players));
  socket.on("onlinePlayers", (d) => renderOnline(d.players));
  socket.on("wordSolvedFeed", (d) => appendFeedItem(d));
  socket.on("chatMessage", (d) => appendChatMessage(d));
  socket.on("dailyMissionsCompleted", (d) => {
    showToast("Misija izpildīta: " + d.missions.map(m => m.text).join(", "));
  });
  socket.on("coinUpdate", (d) => {
    $("#coins-value").textContent = d.coins;
    playSound("snd-coins");
  });
  socket.on("banned", (d) => {
    alert(d.reason);
    localStorage.clear();
    location.reload();
  });
}

// ======== UI UN SPĒLES FUNKCIJAS ========

function initGrid(cols) {
  const grid = $("#grid");
  grid.innerHTML = "";
  grid.style.setProperty("--cols", cols);
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < cols; c++) {
      const t = createEl("div", "tile");
      grid.appendChild(t);
    }
  }
  state.currentRow = 0;
  state.currentCol = 0;
}

function fillTile(row, col, letter) {
  const index = row * state.wordLength + col;
  const tile = $("#grid").children[index];
  if (tile) {
    tile.textContent = letter.toUpperCase();
    tile.classList.add("tile-filled");
  }
}

function flipTile(row, col, status) {
  const index = row * state.wordLength + col;
  const tile = $("#grid").children[index];
  if (!tile) return;
  tile.classList.add("tile-flip");
  setTimeout(() => {
    tile.classList.add("tile-" + status);
  }, 180);
  playSound("snd-flip");
}

function updateHUD(stats) {
  if (!stats) return;
  $("#xp-value").textContent = stats.xp ?? 0;
  $("#streak-value").textContent = stats.streak ?? 0;
  $("#rank-label").textContent = stats.rankTitle ?? "Jauniņais I";
  $("#coins-value").textContent = stats.coins ?? 0;
  $("#tokens-value").textContent = stats.tokens ?? 0;
}

function renderLeaderboard(players) {
  const ul = $("#leaderboard-list");
  ul.innerHTML = "";
  (players || []).slice(0, 7).forEach((p, i) => {
    const li = createEl("li");
    li.innerHTML = `<span class="pos">${i + 1}</span><span class="lb-name">${p.name}</span><span class="lb-xp">${p.xp} XP</span>`;
    ul.appendChild(li);
  });
}

function renderOnline(players) {
  const ul = $("#online-list");
  ul.innerHTML = "";
  (players || []).forEach((p) => {
    const li = createEl("li", "online-player");
    li.innerHTML = `<div class="online-avatar">${p.name[0]}</div><div class="online-text"><div class="online-name">${p.name}</div><div class="online-rank">${p.rankTitle}</div></div>`;
    ul.appendChild(li);
  });
  $("#online-count").textContent = players.length;
}

function renderChat(list) {
  const ul = $("#chat-list");
  ul.innerHTML = "";
  list.forEach(appendChatMessage);
}

function appendChatMessage(msg) {
  const ul = $("#chat-list");
  const li = createEl("li", "chat-item");
  li.innerHTML = `<div class="chat-name">${msg.name}</div><div class="chat-text">${msg.text}</div>`;
  ul.appendChild(li);
  ul.scrollTop = ul.scrollHeight;
}

function renderFeed(list) {
  const ul = $("#feed-list");
  ul.innerHTML = "";
  list.forEach(appendFeedItem);
}

function appendFeedItem(d) {
  const ul = $("#feed-list");
  const li = createEl("li", "feed-item");
  li.innerHTML = `<span class="feed-name">${d.name}</span><span class="feed-text">atminēja vārdu!</span><span class="feed-xp">+${d.xpGain} XP</span>`;
  ul.prepend(li);
}

function renderMissions(missions, completed) {
  const ul = $("#missions-list");
  ul.innerHTML = "";
  (missions || []).forEach((m) => {
    const li = createEl("li", "mission-item" + (completed[m.key] ? " done" : ""));
    li.innerHTML = `<span class="mission-text">${m.text}</span>`;
    ul.appendChild(li);
  });
}

function playSound(id) {
  const el = $("#" + id);
  if (!el) return;
  el.currentTime = 0;
  el.play().catch(() => {});
}

function spawnConfetti() {
  const canvas = $("#confetti-canvas");
  const ctx = canvas.getContext("2d");
  const w = (canvas.width = window.innerWidth);
  const h = (canvas.height = window.innerHeight);
  const particles = Array.from({ length: 80 }, () => ({
    x: Math.random() * w,
    y: Math.random() * h - h,
    r: Math.random() * 6 + 4,
    d: Math.random() * 0.015 + 0.01,
    color: `hsl(${Math.random() * 360},100%,50%)`,
  }));
  let frame;
  function draw() {
    ctx.clearRect(0, 0, w, h);
    for (const p of particles) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, 2 * Math.PI);
      ctx.fillStyle = p.color;
      ctx.fill();
    }
    update();
    frame = requestAnimationFrame(draw);
  }
  function update() {
    for (const p of particles) {
      p.y += p.d * 100;
      if (p.y > h) p.y = -10;
    }
  }
  draw();
  setTimeout(() => cancelAnimationFrame(frame), 3000);
}

// ======== KLAVIATŪRA ========
document.addEventListener("keydown", (e) => {
  if (!socket) return;
  if (state.isLocked) return;

  const key = e.key.toLowerCase();
  if (key === "enter") {
    if (state.currentCol === state.wordLength) {
      const word = Array.from($("#grid").children)
        .slice(state.currentRow * state.wordLength, (state.currentRow + 1) * state.wordLength)
        .map((t) => t.textContent)
        .join("")
        .toLowerCase();
      socket.emit("guess", { word, roundId: state.roundId });
    }
  } else if (key === "backspace") {
    if (state.currentCol > 0) {
      state.currentCol--;
      fillTile(state.currentRow, state.currentCol, "");
    }
  } else if (/^[a-zāčēģīķļņōŗšūž]$/i.test(key)) {
    if (state.currentCol < state.wordLength) {
      fillTile(state.currentRow, state.currentCol, key);
      state.currentCol++;
    }
  }
});

// ======== START ========
window.addEventListener("load", () => {
  const token = localStorage.getItem("jwtToken");
  if (token) connectSocket();
  else showAuthModal();
});
