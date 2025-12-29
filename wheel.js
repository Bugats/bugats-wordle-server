// ===== VĀRDU ZONA — Laimes rats (wheel.js) =====
"use strict";

const API_BASE = "https://bugats-wordle-server.onrender.com";
const SOCKET_URL = API_BASE;

const $ = (s) => document.querySelector(s);

const connDot = $("#connDot");
const connLabel = $("#connLabel");
const meLabel = $("#meLabel");
const adminBadge = $("#adminBadge");

const canvas = $("#wheelCanvas");
const ctx = canvas.getContext("2d");

const slotsCountEl = $("#slotsCount");
const removeOnWinLabel = $("#removeOnWinLabel");
const spinMsLabel = $("#spinMsLabel");
const lastSpinEl = $("#lastSpin");

const btnSpin = $("#btnSpin");
const btnShuffle = $("#btnShuffle");
const spinSec = $("#spinSec");
const spinSecLabel = $("#spinSecLabel");
const removeOnWin = $("#removeOnWin");

const addName = $("#addName");
const addCount = $("#addCount");
const btnAdd = $("#btnAdd");
const rmName = $("#rmName");
const btnRemoveAll = $("#btnRemoveAll");
const btnRemoveOne = $("#btnRemoveOne");

const listEl = $("#list");
const toastEl = $("#toast");

function setConn(on) {
  if (on) {
    connDot.classList.remove("vz-dot-off");
    connDot.classList.add("vz-dot-on");
    connLabel.textContent = "online";
  } else {
    connDot.classList.remove("vz-dot-on");
    connDot.classList.add("vz-dot-off");
    connLabel.textContent = "offline";
  }
}

function showToast(msg, ms = 2200) {
  if (!toastEl) return;
  toastEl.textContent = String(msg || "");
  toastEl.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.add("hidden"), ms);
}

function getToken() {
  const keys = ["vz_token", "token", "jwt", "auth_token", "bugats_token"];
  for (const k of keys) {
    const v = localStorage.getItem(k);
    if (v && String(v).trim()) return String(v).trim();
  }
  return null;
}

function safeText(el, txt) {
  if (!el) return;
  el.textContent = String(txt ?? "");
}

function clamp(n, a, b) {
  n = Number(n);
  if (!Number.isFinite(n)) return a;
  return Math.max(a, Math.min(b, n));
}

function hashStr(s) {
  s = String(s || "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function colorForName(name) {
  const h = hashStr(name) % 360;
  const s = 68;
  const l = 48;
  return `hsl(${h} ${s}% ${l}%)`;
}

// ======== STATE ========
let socket = null;

let me = null;
let isAdmin = false;

let slots = []; // array of names (repeated per ticket)
let rotation = 0; // radians
let isSpinning = false;

let removeOnWinState = true;
let spinMsState = 9000;

let lastSpin = null;

// ======== UI ENABLE/DISABLE ========
function setAdminUi(enabled) {
  const all = [
    btnSpin,
    btnShuffle,
    spinSec,
    removeOnWin,
    addName,
    addCount,
    btnAdd,
    rmName,
    btnRemoveAll,
    btnRemoveOne,
  ].filter(Boolean);

  for (const el of all) el.disabled = !enabled;

  if (adminBadge) {
    adminBadge.classList.toggle("vz-wheel-badge-off", !enabled);
    adminBadge.classList.toggle("vz-wheel-badge-on", enabled);
    adminBadge.textContent = enabled ? "ADMIN" : "NAV ADMIN";
  }
}

// ======== RENDER LIST ========
function renderList() {
  const map = new Map();
  for (const n of slots) map.set(n, (map.get(n) || 0) + 1);

  const arr = Array.from(map.entries()).sort((a, b) => {
    const dc = b[1] - a[1];
    if (dc !== 0) return dc;
    return String(a[0]).localeCompare(String(b[0]));
  });

  if (!listEl) return;

  if (!arr.length) {
    listEl.innerHTML = `<div class="vz-wheel-empty">Nav nevienas biļetes.</div>`;
    return;
  }

  listEl.innerHTML = arr
    .map(([name, cnt]) => {
      const c = colorForName(name);
      return `
        <div class="vz-wheel-item">
          <div class="vz-wheel-pill" style="background:${c}"></div>
          <div class="vz-wheel-name">${escapeHtml(name)}</div>
          <div class="vz-wheel-count">x${cnt}</div>
        </div>
      `;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ======== DRAW WHEEL ========
function resizeCanvasForDevice() {
  // canvas ir 900x900 HTMLā; pielāgojam DPR, lai ir ass
  const dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
  const cssW = canvas.clientWidth || 900;
  const cssH = canvas.clientHeight || 900;

  // saglabājam kvadrātu
  const size = Math.min(cssW, cssH);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;

  canvas.width = Math.floor(size * dpr);
  canvas.height = Math.floor(size * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawWheel() {
  const w = canvas.clientWidth || 900;
  const h = canvas.clientHeight || 900;
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * 0.46;

  ctx.clearRect(0, 0, w, h);

  // bg ring
  ctx.beginPath();
  ctx.arc(cx, cy, r + 8, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fill();

  const n = slots.length;
  if (!n) {
    // empty
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fill();

    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "700 22px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("NAV BIĻEŠU", cx, cy);
    return;
  }

  const seg = (Math.PI * 2) / n;

  for (let i = 0; i < n; i++) {
    const a0 = rotation + i * seg;
    const a1 = a0 + seg;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a0, a1);
    ctx.closePath();

    ctx.fillStyle = colorForName(slots[i]);
    ctx.fill();

    // divider
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // text
    const mid = (a0 + a1) / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(mid);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.font = "700 16px system-ui, -apple-system, Segoe UI, Roboto, Arial";

    const name = slots[i];
    const label = name.length > 18 ? name.slice(0, 18) + "…" : name;
    ctx.fillText(label, r * 0.62, 0);
    ctx.restore();
  }

  // center cap
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.18, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.18, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,255,255,0.20)";
  ctx.lineWidth = 2;
  ctx.stroke();
}

function tickHud() {
  safeText(slotsCountEl, slots.length);
  safeText(removeOnWinLabel, removeOnWinState ? "ON" : "OFF");
  safeText(spinMsLabel, String(spinMsState));
  safeText(lastSpinEl, lastSpin ? lastSpin.text || "—" : "—");
}

function renderAll() {
  tickHud();
  renderList();
  drawWheel();
}

// ======== SPIN ANIMATION ========
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function normalizeAngle(a) {
  const two = Math.PI * 2;
  a %= two;
  if (a < 0) a += two;
  return a;
}

function spinToIndex(stopIndex, durationMs) {
  if (!slots.length) return;

  const n = slots.length;
  const seg = (Math.PI * 2) / n;

  // pointer ir augšā => angle = -PI/2
  const pointer = -Math.PI / 2;

  // segmenta centrs: rotation + (i+0.5)*seg
  // vēlamies: rotationEnd + (i+0.5)*seg == pointer (mod 2PI)
  const targetRotBase = pointer - (stopIndex + 0.5) * seg;

  // pieliekam vairākas pilnas rotācijas, lai izskatās kā spin
  const extraTurns = 6 + (hashStr(String(Date.now())) % 4); // 6..9
  const targetRot = targetRotBase + extraTurns * Math.PI * 2;

  const startRot = rotation;
  const endRot = targetRot;

  const start = performance.now();
  isSpinning = true;
  setAdminUi(isAdmin && false);

  function frame(now) {
    const t = clamp((now - start) / durationMs, 0, 1);
    const e = easeOutCubic(t);
    rotation = startRot + (endRot - startRot) * e;
    drawWheel();

    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      rotation = normalizeAngle(rotation);
      isSpinning = false;
      setAdminUi(isAdmin);
      renderAll();
    }
  }
  requestAnimationFrame(frame);
}

// ======== ME FETCH ========
async function fetchMe(token) {
  const r = await fetch(`${API_BASE}/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error("Nevar ielādēt /me");
  return r.json();
}

// ======== SOCKET CONNECT ========
function connect() {
  const token = getToken();
  if (!token) {
    setConn(false);
    showToast("Nav token (pieslēdzies spēlē un tad atver ratu).", 5000);
    setAdminUi(false);
    return;
  }

  socket = io(SOCKET_URL, {
    auth: { token },
    transports: ["websocket", "polling"],
  });

  socket.on("connect", () => setConn(true));
  socket.on("disconnect", () => setConn(false));
  socket.on("connect_error", (e) => {
    setConn(false);
    showToast(e?.message || "Savienojuma kļūda", 3500);
  });

  // state no servera
  socket.on("wheel:state", (st) => {
    if (!st || typeof st !== "object") return;
    slots = Array.isArray(st.slots) ? st.slots.slice() : [];
    removeOnWinState = !!st.removeOnWin;
    spinMsState = clamp(st.spinMs || 9000, 3000, 20000);
    lastSpin = st.lastSpin || null;
    renderAll();
  });

  socket.on("wheel:lastSpin", (ls) => {
    lastSpin = ls || null;
    tickHud();
  });

  socket.on("wheel:error", (p) => {
    showToast(p?.message || "Wheel error");
  });

  // pieprasām state
  socket.emit("wheel:getState");
}

async function init() {
  resizeCanvasForDevice();
  window.addEventListener("resize", () => {
    resizeCanvasForDevice();
    renderAll();
  });

  // slider
  const sec = clamp(spinSec?.value || 9, 3, 20);
  safeText(spinSecLabel, `${sec}s`);

  spinSec?.addEventListener("input", () => {
    const v = clamp(spinSec.value, 3, 20);
    safeText(spinSecLabel, `${v}s`);
    spinMsState = v * 1000;
    tickHud();
  });

  removeOnWin?.addEventListener("change", () => {
    removeOnWinState = !!removeOnWin.checked;
    tickHud();
  });

  // me
  const token = getToken();
  if (token) {
    try {
      me = await fetchMe(token);
      safeText(meLabel, me.username || "—");
      isAdmin = ["Bugats", "BugatsLV"].includes(String(me.username || ""));
      setAdminUi(isAdmin);
    } catch {
      safeText(meLabel, "—");
      isAdmin = false;
      setAdminUi(false);
    }
  } else {
    setAdminUi(false);
  }

  // buttons
  btnShuffle?.addEventListener("click", () => {
    if (!socket || !isAdmin) return;
    socket.emit("wheel:shuffle");
  });

  btnAdd?.addEventListener("click", () => {
    if (!socket || !isAdmin) return;
    const name = String(addName.value || "").trim();
    const cnt = clamp(addCount.value || 1, 1, 100);
    if (!name) return showToast("Ievadi vārdu.");
    socket.emit("wheel:add", { name, count: cnt });
    addName.value = "";
    addCount.value = "1";
  });

  btnRemoveAll?.addEventListener("click", () => {
    if (!socket || !isAdmin) return;
    const name = String(rmName.value || "").trim();
    if (!name) return showToast("Ievadi vārdu noņemšanai.");
    socket.emit("wheel:removeAll", { name });
  });

  btnRemoveOne?.addEventListener("click", () => {
    if (!socket || !isAdmin) return;
    const name = String(rmName.value || "").trim();
    if (!name) return showToast("Ievadi vārdu noņemšanai.");
    socket.emit("wheel:removeOne", { name });
  });

  btnSpin?.addEventListener("click", () => {
    if (!socket || !isAdmin || isSpinning) return;
    if (!slots.length) return showToast("Nav ko griezt (0 biļetes).");

    const ms = clamp(spinMsState, 3000, 20000);
    const row = {
      spinMs: ms,
      removeOnWin: !!removeOnWinState,
    };

    // serveris atgriež stopIndex + winner; mēs tikai animējam
    socket.emit("wheel:spin", row, (resp) => {
      if (!resp || resp.ok !== true) {
        showToast(resp?.message || "Spin error");
        return;
      }
      // resp: { ok:true, stopIndex, winner, state }
      const stopIndex = clamp(resp.stopIndex, 0, Math.max(0, slots.length - 1));
      lastSpin = resp.lastSpin || null;
      tickHud();

      spinToIndex(stopIndex, ms);

      // ja serveris atmeta state pēc removeOnWin, atjaunosim pēc delay
      if (resp.state) {
        // neliels delay, lai animācija paspēj “aiziet”
        setTimeout(() => {
          slots = Array.isArray(resp.state.slots) ? resp.state.slots.slice() : slots;
          removeOnWinState = !!resp.state.removeOnWin;
          spinMsState = clamp(resp.state.spinMs || spinMsState, 3000, 20000);
          lastSpin = resp.state.lastSpin || lastSpin;
          renderAll();
        }, Math.min(900, ms - 200));
      }
    });
  });

  // initial draw
  renderAll();
  connect();
}

init();
