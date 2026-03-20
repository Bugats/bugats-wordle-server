"use strict";

const API_BASE = "https://bugats-wordle-server.onrender.com";
const SOCKET_URL = API_BASE;

const $ = (s) => document.querySelector(s);

const TAU = Math.PI * 2;

const el = {
  canvas: $("#wheelCanvas"),
  pointerName: $("#pointerName"),

  connDot: $("#connDot"),
  connLabel: $("#connLabel"),
  statusLabel: $("#statusLabel"),

  slotsCount: $("#slotsCount"),
  manualCount: $("#manualCount"),
  tokenCount: $("#tokenCount"),

  tokenTicketsUsed: $("#tokenTicketsUsed"),
  tokenTicketsTotal: $("#tokenTicketsTotal"),
  tokenUsers: $("#tokenUsers"),
  truncateNote: $("#truncateNote"),

  lastSpinLabel: $("#lastSpinLabel"),

  adminGate: $("#adminGate"),
  adminPanel: $("#adminPanel"),

  manualName: $("#manualName"),
  manualQty: $("#manualQty"),
  btnManualAdd: $("#btnManualAdd"),
  btnManualShuffle: $("#btnManualShuffle"),
  btnSyncTokens: $("#btnSyncTokens"),

  tokUser: $("#tokUser"),
  tokValue: $("#tokValue"),
  btnTokSet: $("#btnTokSet"),
  btnTokPlus: $("#btnTokPlus"),
  btnTokMinus: $("#btnTokMinus"),
  btnTokZero: $("#btnTokZero"),

  spinMs: $("#spinMs"),
  removeOnWin: $("#removeOnWin"),
  btnSaveSettings: $("#btnSaveSettings"),
  btnSpin: $("#btnSpin"),

  ticketsList: $("#ticketsList"),
};

function safeText(node, txt) {
  if (!node) return;
  node.textContent = String(txt ?? "");
}

function getAuthToken() {
  const keys = [
    "vz_token",
    "wordle_token",
    "token",
    "zole_token", // fallback, ja kādreiz kopīgs auth
  ];
  for (const k of keys) {
    const v = localStorage.getItem(k);
    if (v && String(v).trim()) return String(v).trim();
  }
  return "";
}

let socket = null;
let me = { username: null, isAdmin: false };

let wheelState = null;

let canvas = el.canvas;
let ctx = canvas.getContext("2d", { alpha: true });

let dpr = Math.max(1, window.devicePixelRatio || 1);

let wheelRot = 0;
let spinningLocal = false;
let spinStart = 0;
let spinDur = 0;
let spinFrom = 0;
let spinTo = 0;
let spinSlotsSnapshot = null;

function setConn(ok) {
  if (!el.connDot) return;
  el.connDot.classList.toggle("ok", !!ok);
  safeText(el.connLabel, ok ? "ONLINE" : "OFFLINE");
}

function setAdminUI() {
  const isAdmin = !!me.isAdmin;
  if (el.adminPanel) el.adminPanel.hidden = !isAdmin;
  if (el.adminGate) el.adminGate.style.display = isAdmin ? "none" : "block";
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function normalizeAngle(a) {
  let x = a % TAU;
  if (x < 0) x += TAU;
  return x;
}

function abbr(name) {
  const s = String(name || "").trim();
  if (!s) return "—";
  if (s.length <= 3) return s.toUpperCase();
  return s.slice(0, 3).toUpperCase();
}

function resizeCanvas() {
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  dpr = Math.max(1, window.devicePixelRatio || 1);

  const w = Math.max(320, Math.floor(rect.width));
  const h = Math.max(320, Math.floor(rect.height));

  const bw = Math.floor(w * dpr);
  const bh = Math.floor(h * dpr);

  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  draw();
}

window.addEventListener("resize", () => {
  resizeCanvas();
});

function getSlotsForDraw() {
  if (spinningLocal && Array.isArray(spinSlotsSnapshot) && spinSlotsSnapshot.length) {
    return spinSlotsSnapshot;
  }
  return (wheelState && Array.isArray(wheelState.slots)) ? wheelState.slots : [];
}

function draw() {
  if (!ctx || !canvas) return;

  const slots = getSlotsForDraw();
  const n = slots.length;

  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  // ja nav slotu
  if (!n) {
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "rgba(233,236,255,.75)";
    ctx.font = "700 16px system-ui,Segoe UI,Arial";
    ctx.textAlign = "center";
    ctx.fillText("Nav ierakstu ratā", (w / dpr) / 2, (h / dpr) / 2);
    ctx.restore();
    safeText(el.pointerName, "—");
    return;
  }

  // zīmējam ratu
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * 0.42;

  const seg = TAU / n;

  // centrs
  ctx.save();
  ctx.translate(cx, cy);

  // fons
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.05, 0, TAU);
  ctx.fillStyle = "rgba(0,0,0,.18)";
  ctx.fill();

  // segmenti
  for (let i = 0; i < n; i++) {
    const a0 = -Math.PI / 2 + wheelRot + i * seg;
    const a1 = a0 + seg;

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r, a0, a1);
    ctx.closePath();

    // bez konkrētu krāsu “theme” prasības nav – te ir minimāls alternējošs tonis
    const alt = i % 2 === 0;
    ctx.fillStyle = alt ? "rgba(255,255,255,.10)" : "rgba(255,255,255,.06)";
    ctx.fill();

    ctx.strokeStyle = "rgba(255,255,255,.10)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // teksts tikai, ja segmenti nav pārāk šauri
    if (n <= 70 || seg > 0.18) {
      const mid = (a0 + a1) / 2;
      ctx.save();
      ctx.rotate(mid);
      ctx.translate(r * 0.72, 0);
      ctx.rotate(Math.PI / 2);

      ctx.fillStyle = "rgba(233,236,255,.9)";
      ctx.font = `800 ${Math.max(10, Math.min(16, Math.floor((seg * 180 / Math.PI) * 0.9)))}px system-ui,Segoe UI,Arial`;
      ctx.textAlign = "center";
      ctx.fillText(abbr(slots[i]), 0, 0);
      ctx.restore();
    }
  }

  // centra “poga”
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.12, 0, TAU);
  ctx.fillStyle = "rgba(0,0,0,.35)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,.16)";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.restore();

  // pointerName: kas šobrīd ir augšā
  const idx = getIndexAtPointer(wheelRot, n);
  safeText(el.pointerName, slots[idx] || "—");
}

function getIndexAtPointer(rot, n) {
  if (!n) return 0;
  const seg = TAU / n;
  // mūsu “0” rotācija nav centrs; centrs ir pie -0.5 seg (skat spin target)
  const x = ((-(rot / seg) - 0.5) % n + n) % n;
  return Math.floor(x);
}

function renderTicketsList() {
  if (!el.ticketsList) return;
  const s = wheelState;
  const slots = (s && Array.isArray(s.slots)) ? s.slots : [];
  const manualCount = Number(s?.manualCount || 0);
  const tokenMeta = s?.tokenMeta || {};

  // group counts
  const m = new Map();
  const t = new Map();

  for (let i = 0; i < slots.length; i++) {
    const name = String(slots[i] || "").trim();
    if (!name) continue;
    if (i < manualCount) m.set(name, (m.get(name) || 0) + 1);
    else t.set(name, (t.get(name) || 0) + 1);
  }

  const names = Array.from(new Set([...m.keys(), ...t.keys()]));
  names.sort((a, b) => {
    const dt = (t.get(b) || 0) - (t.get(a) || 0);
    if (dt !== 0) return dt;
    const dm = (m.get(b) || 0) - (m.get(a) || 0);
    if (dm !== 0) return dm;
    return a.localeCompare(b);
  });

  el.ticketsList.innerHTML = "";

  if (!names.length) {
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "Saraksts ir tukšs.";
    el.ticketsList.appendChild(d);
    return;
  }

  for (const name of names) {
    const mc = m.get(name) || 0;
    const tc = t.get(name) || 0;

    const row = document.createElement("div");
    row.className = "ticketRow";

    const left = document.createElement("div");
    const nm = document.createElement("div");
    nm.className = "ticketName";
    nm.textContent = name;

    const badges = document.createElement("div");
    badges.className = "badges";

    if (mc > 0) {
      const b = document.createElement("span");
      b.className = "badge m";
      b.textContent = `MANUAL: ${mc}`;
      badges.appendChild(b);
    }
    if (tc > 0) {
      const b = document.createElement("span");
      b.className = "badge t";
      b.textContent = `TOKEN: ${tc}`;
      badges.appendChild(b);
    }

    left.appendChild(nm);
    left.appendChild(badges);

    const actions = document.createElement("div");
    actions.className = "actions";

    // token +/- tikai adminam un ja ir token biļetes (lai nespiestu uz random manuāliem vārdiem)
    if (me.isAdmin && tc > 0) {
      const bMinus = document.createElement("button");
      bMinus.className = "miniBtn pm";
      bMinus.textContent = "−";
      bMinus.title = "Token -1";
      bMinus.onclick = () => emitAdjustTokens(name, -1);

      const bPlus = document.createElement("button");
      bPlus.className = "miniBtn pm";
      bPlus.textContent = "+";
      bPlus.title = "Token +1";
      bPlus.onclick = () => emitAdjustTokens(name, +1);

      actions.appendChild(bMinus);
      actions.appendChild(bPlus);
    }

    // X: noņem no visa (manual + token)
    const bX = document.createElement("button");
    bX.className = "miniBtn x";
    bX.textContent = "×";
    bX.title = "Noņemt no visa (manual + token)";
    bX.disabled = !me.isAdmin;
    bX.onclick = () => {
      if (!me.isAdmin) return;

      // manual: remove all by name
      if (mc > 0) emitRemoveByName(name);

      // token: uz nulli (noņem visas biļetes)
      if (tc > 0) emitSetTokens(name, 0);
    };

    actions.appendChild(bX);

    row.appendChild(left);
    row.appendChild(actions);

    el.ticketsList.appendChild(row);
  }

  // truncate info
  if (el.truncateNote) {
    const truncated = !!tokenMeta.tokenTicketsTruncated;
    el.truncateNote.hidden = !truncated;
  }
}

function updateUIFromState() {
  const s = wheelState || {};
  const now = Date.now();

  const spinning = !!(s.spinning && s.spinEndsAt && now < s.spinEndsAt);
  safeText(el.statusLabel, spinning ? "SPIN" : "GATAVS");

  safeText(el.slotsCount, (s.slots && s.slots.length) ? s.slots.length : 0);
  safeText(el.manualCount, s.manualCount || 0);
  safeText(el.tokenCount, s.tokenCount || 0);

  const tm = s.tokenMeta || {};
  safeText(el.tokenUsers, tm.tokenUsers || 0);
  safeText(el.tokenTicketsTotal, tm.tokenTicketsTotal || 0);
  safeText(el.tokenTicketsUsed, tm.tokenTicketsUsed || 0);

  // last spin
  if (s.lastSpin && s.lastSpin.winnerName) {
    safeText(el.lastSpinLabel, `${s.lastSpin.winnerName} (${s.lastSpin.winnerSource || "?"})`);
  } else {
    safeText(el.lastSpinLabel, "—");
  }

  // settings inputs
  if (el.spinMs) el.spinMs.value = String(s.settings?.spinMs ?? 9000);
  if (el.removeOnWin) el.removeOnWin.value = String(!!(s.settings?.removeOnWin));

  renderTicketsList();
  draw();
}

function emitRemoveByName(name) {
  if (!socket) return;
  socket.emit("wheel:remove", { name });
  socket.emit("remove", { name });
}

function emitManualAdd() {
  if (!socket) return;
  const name = String(el.manualName?.value || "").trim();
  const count = parseInt(el.manualQty?.value || "1", 10) || 1;
  socket.emit("wheel:add", { name, count });
  socket.emit("add", { name, count });
}

function emitManualShuffle() {
  if (!socket) return;
  socket.emit("wheel:shuffle");
  socket.emit("shuffle");
}

function emitSyncTokens() {
  if (!socket) return;
  socket.emit("wheel:syncTokens");
  socket.emit("syncTokens");
}

function emitSaveSettings() {
  if (!socket) return;
  const spinMs = parseInt(el.spinMs?.value || "9000", 10);
  const removeOnWin = String(el.removeOnWin?.value || "true") === "true";

  socket.emit("wheel:settings", { spinMs, removeOnWin });
  socket.emit("settings", { spinMs, removeOnWin });
}

function emitSpin() {
  if (!socket) return;
  socket.emit("wheel:spin");
  socket.emit("spin");
}

function emitAdjustTokens(username, delta) {
  if (!socket) return;
  socket.emit("wheel:adjustTokens", { username, delta });
  socket.emit("adjustTokens", { username, delta });
}

function emitSetTokens(username, set) {
  if (!socket) return;
  socket.emit("wheel:adjustTokens", { username, set });
  socket.emit("adjustTokens", { username, set });
}

function startSpinAnim(payload) {
  const slots = (wheelState && Array.isArray(wheelState.slots)) ? wheelState.slots : [];
  if (!slots.length) return;

  // snapshot, lai spin laikā slots nemainās (serveris var removeOnWin pēc beigām)
  spinSlotsSnapshot = slots.slice();

  const n = payload?.slotsCount || spinSlotsSnapshot.length;
  if (!n) return;

  const winnerIndex = Number(payload?.winnerIndex ?? 0);
  const ms = Number(payload?.spinMs ?? 9000);

  const seg = TAU / n;
  const baseTarget = -((winnerIndex + 0.5) * seg);

  // uztaisām target ar vairākiem apgriezieniem un vienmēr uz priekšu
  const cur = wheelRot;
  const spins = 7;
  const k = Math.ceil((cur - baseTarget) / TAU);
  const target = baseTarget + TAU * (spins + k);

  spinningLocal = true;
  spinStart = performance.now();
  spinDur = Math.max(3000, Math.min(60000, ms));
  spinFrom = cur;
  spinTo = target;

  // uzreiz rādam uzvarētāju labeli
  if (payload?.winnerName) safeText(el.pointerName, payload.winnerName);

  const tick = (tNow) => {
    const t = Math.min(1, (tNow - spinStart) / spinDur);
    const e = easeOutCubic(t);
    wheelRot = spinFrom + (spinTo - spinFrom) * e;
    draw();

    if (t < 1) {
      requestAnimationFrame(tick);
    } else {
      spinningLocal = false;
      wheelRot = spinTo;
      draw();

      // pēc spin beigām pārejam atpakaļ uz live slotiem
      setTimeout(() => {
        spinSlotsSnapshot = null;
        draw();
      }, 120);
    }
  };

  requestAnimationFrame(tick);
}

async function loadInitialState() {
  try {
    const r = await fetch(`${API_BASE}/wheel/state`, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const s = await r.json();
    wheelState = s;
    updateUIFromState();
  } catch {
    // ignore
  }
}

function connect() {
  const token = getAuthToken();

  socket = io(`${SOCKET_URL}/wheel`, {
    transports: ["websocket"],
    auth: token ? { token } : {},
    query: token ? { token } : {},
  });

  socket.on("connect", () => setConn(true));
  socket.on("disconnect", () => setConn(false));
  socket.on("connect_error", () => setConn(false));

  const onUpdate = (s) => {
    wheelState = s;
    updateUIFromState();
  };

  socket.on("wheel:me", (m) => {
    me = m || { username: null, isAdmin: false };
    setAdminUI();
    renderTicketsList();
  });

  socket.on("wheel:update", onUpdate);
  socket.on("update", onUpdate);

  socket.on("wheel:error", (msg) => {
    // klusā režīmā – ja vajag, vari te ielikt toast
    console.warn("wheel:error:", msg);
  });
  socket.on("error", (msg) => {
    console.warn("wheel:error:", msg);
  });

  socket.on("wheel:spin", (payload) => startSpinAnim(payload));
  socket.on("spin", (payload) => startSpinAnim(payload));

  socket.on("wheel:tokensUpdated", (p) => {
    if (!p) return;
    // ja tu izmanto korekcijas inputu – var atjaunot value
    if (me.isAdmin && el.tokUser && el.tokValue) {
      const u = String(el.tokUser.value || "").trim();
      if (u && u === p.username) el.tokValue.value = String(p.tokens ?? "");
    }
  });
}

function wireUI() {
  if (el.btnManualAdd) el.btnManualAdd.onclick = () => emitManualAdd();
  if (el.btnManualShuffle) el.btnManualShuffle.onclick = () => emitManualShuffle();
  if (el.btnSyncTokens) el.btnSyncTokens.onclick = () => emitSyncTokens();
  if (el.btnSaveSettings) el.btnSaveSettings.onclick = () => emitSaveSettings();
  if (el.btnSpin) el.btnSpin.onclick = () => emitSpin();

  // token korekcijas input panelis
  if (el.btnTokSet) el.btnTokSet.onclick = () => {
    const u = String(el.tokUser?.value || "").trim();
    const v = parseInt(el.tokValue?.value || "", 10);
    if (!u || !Number.isFinite(v) || v < 0) return;
    emitSetTokens(u, v);
  };
  if (el.btnTokPlus) el.btnTokPlus.onclick = () => {
    const u = String(el.tokUser?.value || "").trim();
    if (!u) return;
    emitAdjustTokens(u, +1);
  };
  if (el.btnTokMinus) el.btnTokMinus.onclick = () => {
    const u = String(el.tokUser?.value || "").trim();
    if (!u) return;
    emitAdjustTokens(u, -1);
  };
  if (el.btnTokZero) el.btnTokZero.onclick = () => {
    const u = String(el.tokUser?.value || "").trim();
    if (!u) return;
    emitSetTokens(u, 0);
  };
}

(async function init() {
  setConn(false);
  setAdminUI();
  wireUI();
  await loadInitialState();
  connect();
  resizeCanvas();
})();
