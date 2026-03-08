"use strict";

/*
  VĀRDU ZONA — game.js (2025-12-30)

  Patch uzlabojumi:
  - Admin pārbaude case-insensitive (Bugats/bugats u.c.)
  - Robustāks /leaderboard un /missions parse (Array vai objekts)
  - TOP10 avatāru cache ar TTL (24h), lai redz avatar izmaiņas
  - Avatar upload: arī pie invalid faila notīra file input value
  - Buy-token: pēc pirkuma mēģina refresh /me + missions, lai UI sync
*/

// ================== KONFIGS ==================
const API_BASE = "https://bugats-wordle-server.onrender.com";

// Admin lietotāji (tāpat kā serverī / UI)
const ADMIN_USERNAMES = ["Bugats", "BugatsLV"];
const ADMIN_SET = new Set(ADMIN_USERNAMES.map((u) => String(u).trim().toLowerCase()));

function isAdminUsername(u) {
  return ADMIN_SET.has(String(u || "").trim().toLowerCase());
}

const REGION_META = {
  Zemgale: { code: "Z", cls: "vz-region-zemgale", label: "Zemgale" },
  Latgale: { code: "L", cls: "vz-region-latgale", label: "Latgale" },
  Vidzeme: { code: "V", cls: "vz-region-vidzeme", label: "Vidzeme" },
  Kurzeme: { code: "K", cls: "vz-region-kurzeme", label: "Kurzeme" },
};
const REGION_TOTAL_CAP = 500000;

// Nedrīkst rādīt uz ekrāna klaviatūras + ignorējam arī no fiziskās
const DISALLOWED_KEYS = new Set(["Q", "W", "X", "Y"]);

// Fetch timeout (lai UI neiestrēgst pie “karājošiem” requestiem)
const FETCH_TIMEOUT_MS = 12_000;
const FLIP_DELAY_MS = 160;
const FLIP_DURATION_MS = 800;
const PREFERS_REDUCED_MOTION =
  typeof window !== "undefined" &&
  window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ================== AUTH STORAGE (kompatibilitāte) ==================
const AUTH_KEYS = {
  token: ["vz_token", "vzToken", "token"],
  username: ["vz_username", "vzUsername", "username", "nick"],
};

function getStoredFirst(keys) {
  for (const k of keys) {
    try {
      const v = localStorage.getItem(k);
      if (v && String(v).trim()) return String(v).trim();
    } catch {}
  }
  return "";
}

function setStoredAuth(token, username) {
  const t = String(token || "").trim();
  const u = String(username || "").trim();
  if (!t || !u) return;

  // kanoniski
  try {
    localStorage.setItem("vz_token", t);
    localStorage.setItem("vz_username", u);
  } catch {}

  // backward compat (lai citi veci skripti neapstājas)
  try {
    localStorage.setItem("vzToken", t);
    localStorage.setItem("vzUsername", u);
    localStorage.setItem("token", t);
    localStorage.setItem("username", u);
    localStorage.setItem("nick", u);
  } catch {}
}

function clearStoredAuth() {
  const all = new Set([...AUTH_KEYS.token, ...AUTH_KEYS.username, "vz_token", "vz_username"]);
  for (const k of all) {
    try {
      localStorage.removeItem(k);
    } catch {}
  }
}

// ================== STORAGE KEYI ==================
function avatarStorageKey(username) {
  const u = String(username || "").trim() || "unknown";
  return "vz_avatar_" + u;
}
function isSignedAvatarUrl(url) {
  return (
    typeof url === "string" &&
    (url.includes("/storage/v1/object/sign/") || url.includes("token="))
  );
}
function readAvatarStorageEntry(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const trimmed = String(raw).trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("{")) {
      const obj = JSON.parse(trimmed);
      if (!obj || typeof obj !== "object" || !obj.url) return null;
      const exp = Number(obj.exp) || 0;
      const ts = Number(obj.ts) || 0;
      if (exp && Date.now() > exp) {
        try {
          localStorage.removeItem(key);
        } catch {}
        return null;
      }
      return { url: String(obj.url), exp, ts };
    }
    return { url: trimmed, exp: 0, ts: 0 };
  } catch {
    return null;
  }
}
function trimAvatarStorageKeys(keepKey) {
  try {
    const prefix1 = "vz_avatar_";
    const prefix2 = "vz_avatar_top_";
    const ownKey = state.username ? avatarStorageKey(state.username) : "";
    const protect = new Set([keepKey, ownKey, "vz_avatar"].filter(Boolean));
    const entries = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || (!k.startsWith(prefix1) && !k.startsWith(prefix2)) || protect.has(k)) continue;
      const raw = localStorage.getItem(k);
      let ts = 0;
      if (raw && raw.trim().startsWith("{")) {
        try {
          const o = JSON.parse(raw);
          if (o && typeof o.ts === "number") ts = o.ts;
        } catch {}
      }
      entries.push({ key: k, ts });
    }
    if (entries.length < AVATAR_STORAGE_MAX_KEYS) return;
    entries.sort((a, b) => a.ts - b.ts);
    const toRemove = entries.length - AVATAR_STORAGE_MAX_KEYS + 1;
    for (let i = 0; i < toRemove && i < entries.length; i++) {
      try {
        localStorage.removeItem(entries[i].key);
      } catch {}
    }
  } catch {}
}

function writeAvatarStorageEntry(key, url, exp) {
  try {
    if (!url) {
      localStorage.removeItem(key);
      return;
    }
    trimAvatarStorageKeys(key);
    const payload = { url: String(url), ts: Date.now() };
    if (exp && Number.isFinite(exp) && exp > 0) payload.exp = exp;
    localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    try {
      if (url) localStorage.setItem(key, String(url));
      else localStorage.removeItem(key);
    } catch {}
  }
}
function getLocalAvatarEntry(username) {
  const key = avatarStorageKey(username);
  let entry = readAvatarStorageEntry(key);
  // backward-compat ar veco atslēgu
  if (!entry) {
    try {
      const legacy = localStorage.getItem("vz_avatar");
      if (legacy) {
        entry = { url: String(legacy), exp: 0 };
        try {
          writeAvatarStorageEntry(key, entry.url, entry.exp);
        } catch {}
      }
    } catch {}
  }
  return entry;
}
function getLocalAvatar(username) {
  const entry = getLocalAvatarEntry(username);
  return entry?.url || null;
}
function setLocalAvatar(username, dataUrl, expiresAt) {
  const key = avatarStorageKey(username);
  const exp = Number(expiresAt) || 0;
  try {
    if (dataUrl) {
      if (isSignedAvatarUrl(dataUrl) && !exp) {
        localStorage.removeItem(key);
      } else {
        writeAvatarStorageEntry(key, dataUrl, exp);
      }
    } else {
      localStorage.removeItem(key);
    }
  } catch {}
  // backward-compat (tikai data:image)
  try {
    if (dataUrl && String(dataUrl).startsWith("data:image/")) {
      localStorage.setItem("vz_avatar", dataUrl);
    }
  } catch {}
}

// ===== Helperi =====
function getAuraRankFromLevel(level) {
  const lvl = Number(level) || 1;
  if (lvl >= 40) return 10;
  if (lvl >= 36) return 9;
  if (lvl >= 32) return 8;
  if (lvl >= 28) return 7;
  if (lvl >= 24) return 6;
  if (lvl >= 20) return 5;
  if (lvl >= 16) return 4;
  if (lvl >= 12) return 3;
  if (lvl >= 8) return 2;
  if (lvl >= 4) return 1;
  return 0;
}
function getCosmeticTierFromLevel(level) {
  const lvl = Number(level) || 1;
  if (lvl >= 20) return 5;
  if (lvl >= 15) return 4;
  if (lvl >= 10) return 3;
  if (lvl >= 5) return 2;
  return 1;
}
const RANK_MIN_XP = [
  0,40,90,160,250,360,490,640,810,1000,
  1200,1450,1750,2100,2500,2950,3450,4000,4600,5250,
  5950,6700,7500,8350,9250,
  10200,11200,12300,13500,14800,16200,17700,19300,21000,22800,
  24700,26700,28800,31000,33300
];
 
function rankMinXpByLevel(level) {
  const lvl = Math.max(1, Math.min(40, Number(level) || 1));
  return RANK_MIN_XP[lvl - 1] ?? 0;
}
function $(sel) {
  return document.querySelector(sel);
}
function createEl(tag, cls) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  return el;
}
function safeText(el, txt) {
  if (!el) return;
  el.textContent = String(txt ?? "");
}
function applyRankColor(el, color) {
  if (!el) return;
  const c = typeof color === "string" ? color.trim() : "";
  el.style.color = c || ""; // ja nav krāsas -> noņem inline krāsu
}
// ==================== FETCH HELPERS (timeout + JSON drošība) ====================
async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (e) {
    if (e && e.name === "AbortError") {
      throw new Error("Tīkls neatbildēja laikā. Pamēģini vēlreiz.");
    }
    throw new Error("Neizdevās pieslēgties serverim. Pārbaudi internetu un mēģini vēlreiz.");
  } finally {
    clearTimeout(t);
  }
}

async function readJsonOrThrow(res) {
  const txt = await res.text();

  // ja serveris atgriež tukšu body, bet status ok — atgriežam {}
  if (!txt) {
    if (!res.ok) throw new Error("Servera kļūda (" + res.status + ").");
    return {};
  }

  let data = null;
  try {
    data = JSON.parse(txt);
  } catch (e) {
    console.error("Non-JSON response:", txt);
    throw new Error("Servera kļūda (nav korekts JSON).");
  }
  if (!res.ok) throw new Error((data && data.message) || "Servera kļūda (" + res.status + ").");
  return data;
}

// ===== Klienta stāvoklis =====
const state = {
  token: null,
  username: null,
  email: "",
  region: "",
  regionPoints: 0,
  regionAttackTarget: "",
  regionAttackRegion: "",
// DM (privāts čats)
  dmOpenWith: null,
  dmThreads: new Map(), // username -> [{id,from,to,text,ts}]
  dmUnreadTotal: 0,
  dmUnreadByUser: {}, // username -> count
  dmNotifyOn: true,
  dmStorageMode: "client", // "client" | "server"
  dmLastFrom: null,
  dmInboxPreview: [], // servera inbox preview (no dm.unread)
  dmReply: null, // { id, from, text }
  dmEdit: null, // { id, text }
  dmPeerRead: {}, // username -> ts (peer last read)
  dmTypingByUser: {}, // username -> bool
  dmBlockedUsers: [],
  dmBlockedSet: new Set(),
  friends: [],
  friendInvitesIn: [],
  friendInvitesOut: [],
  onlineUsers: new Set(),
  lastShareResult: null,
  rows: 6,
  cols: 5,
  currentRow: 0,
  currentCol: 0,
  wordLength: 5,
  isLocked: false,
  roundFinished: false,

// Ability: atvērt 1 burtu (1x raundā, par coins)
revealUsed: false,
revealHint: null, // { pos, letter, cost }
revealCostCoins: 25,

  gridTiles: [], // [row][col] -> tile element
  keyboardButtons: new Map(), // key -> button
  shiftOn: false,

  socket: null,

  // coins animācijas helperis
  lastCoins: null,
  lastXp: null,

  // 1v1 duelis
  duelMode: false,
  duelId: null,
  duelOpponent: null,

  // Sezona
  season: null,

  // Globālā skaņa
  soundOn: true,

  // Tēma: dark | light | contrast
  theme: "dark",
};

const DM_THREAD_MAX_LOCAL = 200;
const DM_LOCAL_STORAGE_VERSION = 2;
const DM_STORAGE_PERSIST_MS = 800;

const AVATAR_CACHE_MAX_SIZE = 80;
const AVATAR_STORAGE_MAX_KEYS = 50;

let seasonTimerId = null;
let currentProfileName = null; // popupā atvērtais profila vārds

// kešs citu spēlētāju mini avatāriem (username -> url vai null)
const avatarCache = new Map();
// dedupe /profile fetchiem (username -> Promise)
const avatarPending = new Map();

// ==================== DOM REF ====================
const gridEl = $("#grid");
const keyboardEl = $("#keyboard");
const gameMessageEl = $("#game-message");
const winTickerEl = $("#win-ticker");
const hotStreakBannerEl = $("#hot-streak-banner");
const screenFlashEl = $("#screen-flash");

const newRoundBtn = $("#new-round-btn");
const logoutBtn = $("#logout-btn");
const buyTokenBtn = $("#buy-token-btn");
const mobileFsBtn = $("#mobile-fullscreen-btn");
const shareBtn = $("#share-btn");
const shareWhatsappBtn = $("#share-whatsapp-btn");
const shareDiscordBtn = $("#share-discord-btn");
const shareResultBtn = $("#share-result-btn");
const shareResultWhatsappBtn = $("#share-result-wa-btn");
const shareResultDiscordBtn = $("#share-result-discord-btn");
const shareResultNote = $("#share-result-note");

// SEZONA UI
const seasonBoxEl = $("#season-box");
const seasonTitleEl = $("#season-title");
const seasonCountdownEl = $("#season-countdown");
const seasonStartBtn = $("#season-start-btn");

// Profila karte
const playerNameEl = $("#player-name");
const playerTitleEl = $("#player-title");
const playerRegionEl = $("#player-region");
const playerRankEl = $("#player-rank");
const playerXpEl = $("#player-xp");
const playerScoreEl = $("#player-score");
const playerStreakEl = $("#player-streak");
const playerBestStreakEl = $("#player-best-streak");
const playerCoinsEl = $("#player-coins");
const playerTokensEl = $("#player-tokens");
const playerMedalsStripEl = $("#player-medals");

// XP josla
const playerXpBarEl = $("#player-xp-bar");
const playerXpLabelEl = $("#player-xp-label");

// AVATĀRS (profila kartē)
const playerAvatarImgEl = document.getElementById("player-avatar-img");
const playerAvatarInitialsEl = document.getElementById("player-avatar-initials");
const playerAvatarUploadBtnEl = document.getElementById("player-avatar-upload-btn");
const playerAvatarFileEl = document.getElementById("player-avatar-file");

// AVATĀRS (popupā)
const ppAvatarImgEl = document.getElementById("pp-avatar-img");
const ppAvatarInitialsEl = document.getElementById("pp-avatar-initials");

// TOPBAR
const topTimeEl = document.getElementById("vz-topbar-time");
const topDateEl = document.getElementById("vz-topbar-date");
const topWeatherEl = document.getElementById("vz-topbar-weather");
const topNamedayEl = document.getElementById("vz-topbar-nameday");

// Globālā skaņa
const soundToggleBtn = document.getElementById("sound-toggle-btn");
const themeToggleBtn = document.getElementById("theme-toggle-btn");

// Bez interneta + Play Store vērtējums
const offlineOverlayEl = document.getElementById("vz-offline-overlay");
const offlineRetryBtn = document.getElementById("vz-offline-retry-btn");
const rateOverlayEl = document.getElementById("vz-rate-overlay");
const rateLaterBtn = document.getElementById("vz-rate-later-btn");
const rateOpenBtn = document.getElementById("vz-rate-open-btn");

// DUELA OVERLAY DOM REF
const duelOverlayEl = document.getElementById("duel-result-overlay");
const duelWinnerNameEl = document.getElementById("duel-winner-name");
const duelScoreLineEl = document.getElementById("duel-result-rewards");
const duelExtraMsgEl = document.getElementById("duel-result-reason");
const duelOkBtn = document.getElementById("duel-result-close");

// TOP10 + ONLINE
const lbListEl = $("#lb-list");
const streakListEl = $("#streak-list");
const dailyListEl = $("#daily-list");
const regionListEl = $("#region-list");
const regionMyRankEl = document.getElementById("region-my-rank");
const onlineCountEl = $("#online-count");
const onlineListEl = $("#online-list");

// HALL OF FAME
const hofBoxEl = document.getElementById("hof-box");
const hofSeason1El = document.getElementById("hof-season1");

// Misijas
const missionsListEl = $("#missions-list");
const weeklyListEl = $("#weekly-list");
const weeklySubEl = $("#weekly-sub");
const weeklyYouEl = $("#weekly-you");

// Draugi
const friendsListEl = $("#friends-list");
const friendsInvitesEl = $("#friends-invites");
const friendAddInputEl = $("#friend-add-input");
const friendAddBtnEl = $("#friend-add-btn");

// Čats
const chatMessagesEl = $("#chat-messages");
const chatInputEl = $("#chat-input");
const chatSendBtn = $("#chat-send-btn");
const CHAT_EMOJIS = [
  "😀","😁","😂","🤣","🙂","😉","😍","😘",
  "😎","🤔","😅","😭","😡","🤯","😴","🤝",
  "🔥","⚡","🏆","🎯","🎉","💪","✅","❌",
  "❤️","💀","👀","🙏","💸","🧠","🫡","🐸",
];
 
function insertAtCursor(inputEl, text) {
  if (!inputEl) return;
  inputEl.focus();
  const start = inputEl.selectionStart;
  const end = inputEl.selectionEnd;
 
  if (typeof start === "number" && typeof end === "number") {
    const v = inputEl.value || "";
    inputEl.value = v.slice(0, start) + text + v.slice(end);
    const p = start + text.length;
    inputEl.setSelectionRange(p, p);
  } else {
    inputEl.value = (inputEl.value || "") + text;
  }
}
 
function initChatEmojiPicker() {
  const btn = document.getElementById("chat-emoji-btn");
  const panel = document.getElementById("chat-emoji-panel");
  if (!btn || !panel || !chatInputEl) return;
 
  panel.innerHTML = "";
  CHAT_EMOJIS.forEach((e) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = e;
    b.addEventListener("click", () => {
      insertAtCursor(chatInputEl, e);
      panel.classList.add("hidden");
    });
    panel.appendChild(b);
  });
 
  btn.addEventListener("click", () => panel.classList.toggle("hidden"));
 
  document.addEventListener("click", (ev) => {
    if (panel.classList.contains("hidden")) return;
    if (ev.target === btn) return;
    if (panel.contains(ev.target)) return;
    panel.classList.add("hidden");
  });
 
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") panel.classList.add("hidden");
  });
}

// Čata badge / mention popup (no game.html)
const chatUnreadBadgeEl = document.getElementById("chat-unread-badge");
const chatMentionBadgeEl = document.getElementById("chat-mention-badge");
const chatMentionPopupEl = document.getElementById("chat-mention-popup");
const chatMentionPopupTextEl = document.getElementById("chat-mention-popup-text");

// Profila popup
const profilePopupEl = $("#player-profile-popup");
const profileCloseBtn = $("#profile-popup-close");
const ppUsernameEl = $("#pp-username");
const ppTitleEl = $("#pp-title");
const ppRegionEl = $("#pp-region");
const ppRankEl = $("#pp-rank");
const ppXpEl = $("#pp-xp");
const ppScoreEl = $("#pp-score");
const ppCoinsEl = $("#pp-coins");
const ppTokensEl = $("#pp-tokens");
const ppBestEl = $("#pp-best");
const ppMedalsEl = $("#pp-medals");
const ppMsgBtnEl = document.getElementById("pp-msg-btn");
const ppEmailBlockEl = $("#pp-email-block");
const ppEmailInputEl = $("#pp-email-input");
const ppEmailSaveBtn = $("#pp-email-save");
const ppEmailStatusEl = $("#pp-email-status");
const ppEmailRemoveBtn = document.getElementById("pp-email-remove");

// Novads (modal)
const regionModalEl = document.getElementById("region-modal");
const regionModalBtns = regionModalEl
  ? Array.from(regionModalEl.querySelectorAll("[data-region]"))
  : [];

// Novadu sacīkste UI
const regionTotalScoreEl = document.getElementById("region-total-score");
const regionTotalFillEl = document.getElementById("region-total-fill");
const regionPointsEl = document.getElementById("region-points");
const regionBoostBtn = document.getElementById("region-boost-btn");
const regionAttackBtn = document.getElementById("region-attack-btn");
const regionAttackSelect = document.getElementById("region-attack-target");

// Audio MP3
const sClick = $("#s-click");
const sType = $("#s-type");
const sError = $("#s-error");
const sWin = $("#s-win");
const sLose = $("#s-lose");
const sCoin = $("#s-coin");
const sToken = $("#s-token");

// ==================== WEB AUDIO KLAVIERES ====================
let vzAudioCtx = null;

function getVzAudioCtx() {
  if (state.soundOn === false) return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;

  if (!vzAudioCtx) vzAudioCtx = new AC();
  if (vzAudioCtx.state === "suspended") {
    vzAudioCtx.resume().catch(() => {});
  }
  return vzAudioCtx;
}

// Bez Q/W/X/Y
const NOTE_KEYS = [
  "E","R","T","U","I","O","P",
  "A","S","D","F","G","H","J","K","L",
  "Z","C","V","B","N","M",
  "Ā","Č","Ē","Ģ","Ī","Ķ","Ļ","Ņ","Š","Ū","Ž",
];

const BASE_FREQ = 220;

function keyToFrequency(key) {
  const k = (key || "").toUpperCase();
  const idx = NOTE_KEYS.indexOf(k);
  if (idx === -1) return BASE_FREQ;
  const semitoneOffset = idx - 8;
  return BASE_FREQ * Math.pow(2, semitoneOffset / 12);
}

function playKeyNote(key, opts = {}) {
  const ctx = getVzAudioCtx();
  if (!ctx) return;

  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.frequency.value = keyToFrequency(key);
  osc.type = opts.type || "triangle";

  const attack = opts.attack ?? 0.01;
  const decay = opts.decay ?? 0.2;
  const volume = opts.volume ?? 0.18;

  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(volume, now + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + attack + decay);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + attack + decay + 0.05);
}

function playControlNote(kind) {
  const options =
    kind === "enter"
      ? { type: "sine", volume: 0.25, attack: 0.01, decay: 0.25 }
      : { type: "square", volume: 0.2, attack: 0.005, decay: 0.15 };

  const key = kind === "enter" ? "C" : "G";
  playKeyNote(key, options);
  if (kind === "enter") pulseSoundFx("enter");
}

// ==================== API HELPERI ====================
async function apiPost(path, body) {
  const res = await fetchWithTimeout(API_BASE + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { Authorization: "Bearer " + state.token } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  return readJsonOrThrow(res);
}

async function apiGet(path) {
  const res = await fetchWithTimeout(API_BASE + path, {
    headers: {
      ...(state.token ? { Authorization: "Bearer " + state.token } : {}),
    },
  });
  return readJsonOrThrow(res);
}

// ==================== AUDIO HELPERIS ====================
// Rezerves skaņas (Web Audio), ja MP3 nav vai bojāts
function playFallbackSound(kind) {
  if (state.soundOn === false) return;
  const ctx = getVzAudioCtx();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0, now);
    const decay = 0.08;
    if (kind === "s-click") {
      osc.frequency.setValueAtTime(800, now);
      osc.type = "sine";
      gain.gain.linearRampToValueAtTime(0.15, now + 0.02);
      gain.gain.linearRampToValueAtTime(0, now + decay);
      osc.start(now);
      osc.stop(now + decay);
    } else if (kind === "s-type") {
      osc.frequency.setValueAtTime(400, now);
      osc.type = "sine";
      gain.gain.linearRampToValueAtTime(0.08, now + 0.01);
      gain.gain.linearRampToValueAtTime(0, now + 0.04);
      osc.start(now);
      osc.stop(now + 0.04);
    } else if (kind === "s-error") {
      osc.frequency.setValueAtTime(200, now);
      osc.type = "square";
      gain.gain.linearRampToValueAtTime(0.08, now + 0.02);
      gain.gain.linearRampToValueAtTime(0, now + 0.15);
      osc.start(now);
      osc.stop(now + 0.15);
    } else if (kind === "s-win") {
      osc.frequency.setValueAtTime(523, now);
      osc.frequency.setValueAtTime(659, now + 0.08);
      osc.frequency.setValueAtTime(784, now + 0.16);
      osc.type = "sine";
      gain.gain.linearRampToValueAtTime(0.12, now + 0.05);
      gain.gain.linearRampToValueAtTime(0.1, now + 0.25);
      gain.gain.linearRampToValueAtTime(0, now + 0.4);
      osc.start(now);
      osc.stop(now + 0.4);
    } else if (kind === "s-lose") {
      osc.frequency.setValueAtTime(262, now);
      osc.frequency.setValueAtTime(220, now + 0.1);
      osc.type = "sine";
      gain.gain.linearRampToValueAtTime(0.1, now + 0.03);
      gain.gain.linearRampToValueAtTime(0, now + 0.25);
      osc.start(now);
      osc.stop(now + 0.25);
    } else if (kind === "s-coin" || kind === "s-token") {
      osc.frequency.setValueAtTime(988, now);
      osc.frequency.setValueAtTime(1318, now + 0.06);
      osc.type = "sine";
      gain.gain.linearRampToValueAtTime(0.1, now + 0.02);
      gain.gain.linearRampToValueAtTime(0, now + 0.12);
      osc.start(now);
      osc.stop(now + 0.12);
    }
  } catch {}
}

function playSound(audioEl) {
  if (!audioEl) return;
  if (state.soundOn === false) return;
  const kind = audioEl.id || "";
  try {
    if (audioEl.src && !audioEl.error) {
      audioEl.currentTime = 0;
      const playPromise = audioEl.play();
      pulseSoundFx(kind);
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => { playFallbackSound(kind); });
        return;
      }
      return;
    }
  } catch {}
  playFallbackSound(kind);
}

function pulseSoundFx(kind, pos) {
  if (state.soundOn === false) return;
  const fx = window.vzPhaserFx;
  if (!fx || typeof fx.pulseSound !== "function") return;
  try {
    fx.pulseSound(kind, pos || null);
  } catch {}
}

function fxPointFromTile(tile) {
  if (!gridEl || !tile || typeof tile.getBoundingClientRect !== "function") return null;
  try {
    const gridRect = gridEl.getBoundingClientRect();
    const tileRect = tile.getBoundingClientRect();
    return {
      x: tileRect.left - gridRect.left + tileRect.width / 2,
      y: tileRect.top - gridRect.top + tileRect.height / 2,
    };
  } catch {
    return null;
  }
}

function applySoundState() {
  const on = state.soundOn !== false;

  if (soundToggleBtn) {
    soundToggleBtn.textContent = on ? "🔊 Skaņa: ON" : "🔇 Skaņa: OFF";
  }

  const radioAudio = document.getElementById("vz-radio");
  if (radioAudio) radioAudio.muted = !on;
}

const THEME_ORDER = ["dark", "light", "contrast"];
const THEME_LABELS = { dark: "🌙 Tumšs", light: "☀️ Gaišs", contrast: "◐ Augsta kontrasta" };

function applyTheme() {
  document.body.classList.remove("vz-theme-light", "vz-theme-contrast");
  if (state.theme === "light") document.body.classList.add("vz-theme-light");
  else if (state.theme === "contrast") document.body.classList.add("vz-theme-contrast");
  if (themeToggleBtn) themeToggleBtn.textContent = THEME_LABELS[state.theme] || THEME_LABELS.dark;
}

// ==================== BEZ INTERNETA + PLAY STORE VĒRTĒJUMS ====================
function setOfflineOverlay(show) {
  if (!offlineOverlayEl) return;
  if (show) offlineOverlayEl.classList.remove("hidden");
  else offlineOverlayEl.classList.add("hidden");
}

function isTwa() {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia("(display-mode: standalone)").matches) return true;
    if (window.matchMedia("(display-mode: fullscreen)").matches) return true;
    if (navigator.standalone === true) return true;
    return false;
  } catch {
    return false;
  }
}

const RATE_PROMPT_WINS = 3;
const RATE_STORAGE_KEY = "vz_rate_prompt_shown";
const WINS_STORAGE_KEY = "vz_total_wins";

function recordWinAndMaybeShowRatePrompt() {
  try {
    const n = parseInt(localStorage.getItem(WINS_STORAGE_KEY) || "0", 10);
    localStorage.setItem(WINS_STORAGE_KEY, String(n + 1));
    if (n + 1 < RATE_PROMPT_WINS) return;
    if (localStorage.getItem(RATE_STORAGE_KEY) === "1") return;
    if (!isTwa() || !rateOverlayEl) return;
    rateOverlayEl.classList.remove("hidden");
    localStorage.setItem(RATE_STORAGE_KEY, "1");
  } catch {}
}

function hideRateOverlay() {
  if (rateOverlayEl) rateOverlayEl.classList.add("hidden");
}

// ==================== AVATĀRA PALĪGFUNKCIJAS ====================
function setAvatar(imgEl, initialsEl, dataUrl, username) {
  const initial =
    (username && username.charAt(0).toUpperCase()) ||
    (initialsEl && initialsEl.textContent.trim()) ||
    "B";

  if (dataUrl && imgEl) {
    imgEl.src = dataUrl;
    imgEl.style.display = "block";
    if (initialsEl) initialsEl.style.display = "none";
  } else {
    if (imgEl) {
      imgEl.src = "";
      imgEl.style.display = "none";
    }
    if (initialsEl) {
      initialsEl.textContent = initial;
      initialsEl.style.display = "flex";
    }
  }
}

function getCachedAvatarEntry(username) {
  const cached = avatarCache.get(username);
  if (cached === null) return null;
  if (cached && typeof cached === "object") {
    const exp = Number(cached.exp) || 0;
    if (exp && Date.now() > exp) {
      avatarCache.delete(username);
      return undefined;
    }
    return cached;
  }
  if (typeof cached === "string") return { url: cached, exp: 0 };
  return undefined;
}

function applyMiniAvatar(username, imgEl, initialsEl) {
  if (!username || !initialsEl) return;

  initialsEl.textContent = username.charAt(0).toUpperCase();

  if (username === state.username) {
    const localEntry = getLocalAvatarEntry(state.username);
    if (localEntry?.url && imgEl) {
      imgEl.src = localEntry.url;
      imgEl.style.display = "block";
      initialsEl.style.display = "none";
      return;
    }
  }

  if (!imgEl) return;

  const cachedEntry = getCachedAvatarEntry(username);

  if (cachedEntry === null) {
    imgEl.src = "";
    imgEl.style.display = "none";
    initialsEl.style.display = "flex";
    return;
  }

  if (cachedEntry && cachedEntry.url) {
    imgEl.src = cachedEntry.url;
    imgEl.style.display = "block";
    initialsEl.style.display = "none";
    return;
  }

  if (avatarPending.has(username)) {
    avatarPending
      .get(username)
      .then(() => {
        if (document.body.contains(initialsEl)) applyMiniAvatar(username, imgEl, initialsEl);
      })
      .catch(() => {});
    return;
  }

  fetchAvatarForUser(username, imgEl, initialsEl);
}

function fetchAvatarForUser(username, imgEl, initialsEl) {
  if (!username || username === "SYSTEM") return Promise.resolve(null);
  if (avatarPending.has(username)) return avatarPending.get(username);

  const p = (async () => {
    try {
      const data = await apiGet("/profile/" + encodeURIComponent(username));
      const url = data.avatarUrl || null;
      const exp = Number(data.avatarUrlExpiresAt) || 0;
      avatarCache.set(username, url ? { url, exp } : null);
      while (avatarCache.size > AVATAR_CACHE_MAX_SIZE) {
        const firstKey = avatarCache.keys().next().value;
        if (firstKey != null) avatarCache.delete(firstKey);
        else break;
      }

      if (url && imgEl && document.body.contains(imgEl)) {
        imgEl.src = url;
        imgEl.style.display = "block";
        if (initialsEl) initialsEl.style.display = "none";
      } else if (imgEl && initialsEl && document.body.contains(initialsEl)) {
        imgEl.src = "";
        imgEl.style.display = "none";
        initialsEl.style.display = "flex";
      }

      return url;
    } catch (err) {
      console.warn("Neizdevās ielādēt avatāru priekš", username, err);
      avatarCache.set(username, null);

      if (imgEl && initialsEl && document.body.contains(initialsEl)) {
        imgEl.src = "";
        imgEl.style.display = "none";
        initialsEl.style.display = "flex";
      }
      return null;
    } finally {
      avatarPending.delete(username);
    }
  })();

  avatarPending.set(username, p);
  return p;
}

// ==================== PROFILA STATI + MEDAĻAS ====================
function renderPlayerMedals(medals, container, full = false) {
  const strip = container || playerMedalsStripEl;
  if (!strip) return;

  strip.innerHTML = "";

  const list = medals || [];
  if (!list.length) {
    const span = createEl("span", "vz-medal vz-medal-empty");
    span.textContent = "nav vēl";
    strip.appendChild(span);
    return;
  }

  if (full) {
    list.forEach((m) => {
      const span = createEl("span", "vz-medal");
      const icon = m.icon || "★";
      const label = m.label ? " " + m.label : "";
      span.textContent = icon + label;
      strip.appendChild(span);
    });
  } else {
    const MAX_ICONS = 5;
    const visible = list.slice(0, MAX_ICONS);

    visible.forEach((m) => {
      const span = createEl("span", "vz-medal");
      span.textContent = m.icon || "★";
      if (m.label) span.title = m.label;
      strip.appendChild(span);
    });

    const extraCount = list.length - visible.length;
    if (extraCount > 0) {
      const extraSpan = createEl("span", "vz-medal vz-medal-extra");
      extraSpan.textContent = `+${extraCount}`;
      strip.appendChild(extraSpan);
    }
  }
}

// ===== NIKA GLOW TIER =====
function getNameTierFromLevel(level) {
  const lvl = Number(level) || 1;
  if (lvl >= 40) return 15;
  if (lvl >= 38) return 14;
  if (lvl >= 36) return 13;
  if (lvl >= 34) return 12;
  if (lvl >= 32) return 11;
  if (lvl >= 30) return 10;
  if (lvl >= 28) return 9;
  if (lvl >= 26) return 8;
  if (lvl >= 24) return 7;
  if (lvl >= 22) return 6;
  if (lvl >= 19) return 5;
  if (lvl >= 16) return 4;
  if (lvl >= 13) return 3;
  if (lvl >= 10) return 2;
  if (lvl >= 7) return 1;
  return 0;
}

function applyNameTierClass(el, level) {
  if (!el) return;
 
  for (let i = 0; i <= 15; i++) el.classList.remove("vz-name-tier-" + i);
  el.classList.add("vz-name-tier-" + getNameTierFromLevel(level));
}

function buildRegionBadge(region, extraClass = "") {
  const meta = REGION_META[String(region || "").trim()] || null;
  if (!meta) return null;
  const badge = createEl("span", "vz-region-badge");
  badge.textContent = meta.code;
  badge.title = meta.label;
  badge.classList.add(meta.cls);
  if (extraClass) badge.classList.add(extraClass);
  return badge;
}

function renderRegionAttackOptions(currentRegion, preferredTarget = "") {
  if (!regionAttackSelect) return;
  regionAttackSelect.innerHTML = "";
  const regions = Object.keys(REGION_META);
  regions.forEach((r) => {
    if (r === currentRegion) return;
    const opt = document.createElement("option");
    opt.value = r;
    opt.textContent = r;
    regionAttackSelect.appendChild(opt);
  });
  if (!regionAttackSelect.options.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Nav pretinieku";
    regionAttackSelect.appendChild(opt);
  }
  if (preferredTarget) {
    regionAttackSelect.value = preferredTarget;
  }
  if (!regionAttackSelect.value && regionAttackSelect.options.length) {
    regionAttackSelect.selectedIndex = 0;
  }
  state.regionAttackTarget = regionAttackSelect.value || "";
  state.regionAttackRegion = currentRegion || "";
}

function updateRegionPointsUi(points, region) {
  const p = Math.max(0, Math.floor(points || 0));
  state.regionPoints = p;
  if (regionPointsEl) regionPointsEl.textContent = String(p);
  if (regionAttackSelect && region) {
    const shouldRender =
      state.regionAttackRegion !== region || !regionAttackSelect.options.length;
    if (shouldRender) {
      renderRegionAttackOptions(region, state.regionAttackTarget);
    }
  } else if (regionAttackSelect && !region) {
    regionAttackSelect.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Izvēlies novadu";
    regionAttackSelect.appendChild(opt);
  }
  const canSpend = p > 0;
  if (regionBoostBtn) regionBoostBtn.disabled = !canSpend;
  if (regionAttackBtn) {
    const target = regionAttackSelect ? regionAttackSelect.value : "";
    regionAttackBtn.disabled = !canSpend || !target;
  }
}

async function handleRegionBoost() {
  if (!state.token) return;
  if (state.regionPoints <= 0) return;
  if (regionBoostBtn) regionBoostBtn.disabled = true;
  try {
    const data = await apiPost("/region/boost", { amount: 1 });
    if (data?.me) updatePlayerCard(data.me);
    await refreshRegionStats();
  } catch (err) {
    appendSystemMessage(err.message || "Neizdevās pieskaitīt novadam.");
  } finally {
    if (regionBoostBtn) regionBoostBtn.disabled = false;
  }
}

async function handleRegionAttack() {
  if (!state.token) return;
  if (state.regionPoints <= 0) return;
  const target = regionAttackSelect ? regionAttackSelect.value : "";
  if (!target) return;
  if (regionAttackBtn) regionAttackBtn.disabled = true;
  try {
    const data = await apiPost("/region/attack", { region: target, amount: 1 });
    if (data?.me) updatePlayerCard(data.me);
    await refreshRegionStats();
  } catch (err) {
    appendSystemMessage(err.message || "Neizdevās noņemt pretiniekam.");
  } finally {
    if (regionAttackBtn) regionAttackBtn.disabled = false;
  }
}

function updatePlayerCard(me) {
  if (!me) return;

  if (playerNameEl) {
    playerNameEl.textContent = me.username;
    applyNameTierClass(playerNameEl, me.rankLevel);
  }
  if (playerRegionEl) {
    const region = String(me.region || "").trim();
    playerRegionEl.textContent = region || "—";
    playerRegionEl.classList.toggle("vz-title-empty", !region);
    state.region = region || "";
  }
  if (typeof me.email === "string") {
    state.email = me.email;
  }
  if (playerTitleEl) {
    const title = String(me.title || "").trim();
    playerTitleEl.textContent = title || "—";
    playerTitleEl.classList.toggle("vz-title-empty", !title);
  }
  updateRegionPointsUi(me.regionPoints || 0, me.region || "");
  if (Array.isArray(me.blockedUsers)) {
    dmSetBlockedUsers(me.blockedUsers);
    dmUpdateBlockUi();
  }

  if (playerRankEl) playerRankEl.textContent = `${me.rankTitle} (L${me.rankLevel})`;
  applyRankColor(playerNameEl, me.rankColor);
  if (playerXpEl) playerXpEl.textContent = me.xp;
  if (playerScoreEl) playerScoreEl.textContent = me.score;
  if (playerStreakEl) playerStreakEl.textContent = me.streak;
  if (playerBestStreakEl) playerBestStreakEl.textContent = me.bestStreak;

  let avatarUrl = me.avatarUrl || null;
  const avatarExp = Number(me.avatarUrlExpiresAt) || 0;
  const storedEntry = getLocalAvatarEntry(me.username);

  if (avatarUrl) {
    if (!storedEntry || storedEntry.url !== avatarUrl || (avatarExp && storedEntry.exp !== avatarExp)) {
      setLocalAvatar(me.username, avatarUrl, avatarExp);
    }
  } else if (storedEntry?.url) {
    avatarUrl = storedEntry.url;
  }
  setAvatar(playerAvatarImgEl, playerAvatarInitialsEl, avatarUrl, me.username);

  if (playerCoinsEl) {
    if (state.lastCoins !== null && me.coins > state.lastCoins) {
      playerCoinsEl.classList.add("vz-coin-bump");
      setTimeout(() => playerCoinsEl.classList.remove("vz-coin-bump"), 260);
    }
    state.lastCoins = me.coins;
    playerCoinsEl.textContent = me.coins;
  }

  if (playerTokensEl) playerTokensEl.textContent = me.tokens;
  if (playerMedalsStripEl) renderPlayerMedals(me.medals, playerMedalsStripEl, false);

 if (playerXpBarEl && playerXpLabelEl) {
  const level = Math.max(1, me.rankLevel || 1);
 
  let minXp = Number.isFinite(me.rankMinXp) ? me.rankMinXp : null;
let nextMinXp = Number.isFinite(me.rankNextMinXp) ? me.rankNextMinXp : null;
 
// fallback, ja backend vēl nesūta sliekšņus
if (minXp === null) minXp = rankMinXpByLevel(level);
if (nextMinXp === null && level < 40) nextMinXp = rankMinXpByLevel(level + 1);
 
 const xp = typeof me.xp === "number" ? me.xp : 0;
 if (state.lastXp !== null && xp > state.lastXp) {
   playerXpBarEl.classList.add("vz-xp-bump");
   setTimeout(() => playerXpBarEl.classList.remove("vz-xp-bump"), 420);
 }
 state.lastXp = xp;
 
  if (nextMinXp && nextMinXp > minXp) {
    const inLevel = Math.max(0, xp - minXp);
    const need = nextMinXp - minXp;
    const pct = Math.max(0, Math.min(100, (inLevel / need) * 100));
 
    playerXpBarEl.style.width = pct.toFixed(1) + "%";
    playerXpLabelEl.textContent = `${inLevel}/${need} XP līdz L${level + 1}`;
  } else {
    // MAX rank
    playerXpBarEl.style.width = "100%";
    playerXpLabelEl.textContent = "MAX RANK";
  }
}

const card = document.querySelector(".vz-player-card");
if (card) {
  card.classList.remove("vz-rank-low", "vz-rank-mid", "vz-rank-high");
  for (let i = 1; i <= 10; i++) card.classList.remove("vz-rank-" + i);
  for (let i = 1; i <= 5; i++) card.classList.remove("vz-cos-tier-" + i);
 
  const aura = getAuraRankFromLevel(me.rankLevel);
  if (aura) card.classList.add("vz-rank-" + aura);
  card.classList.toggle("vz-player-supporter", !!me.supporter);
  const cosTier = getCosmeticTierFromLevel(me.rankLevel);
  if (cosTier) card.classList.add("vz-cos-tier-" + cosTier);
 
  // hot streak
  if ((me.streak || 0) >= 3) {
    card.classList.add("vz-profile-hot");
    if (hotStreakBannerEl) hotStreakBannerEl.style.display = "block";
  } else {
    card.classList.remove("vz-profile-hot");
    if (hotStreakBannerEl) hotStreakBannerEl.style.display = "none";
  }
}
  
}

// ==================== NOVADI (klani) ====================
let _postLoginInitDone = false;
function isRegionMissing(me) {
  return !me || !String(me.region || "").trim();
}

function showRegionModal() {
  if (!regionModalEl) return;
  regionModalEl.classList.remove("hidden");
}

function hideRegionModal() {
  if (!regionModalEl) return;
  regionModalEl.classList.add("hidden");
}

async function setRegionChoice(region) {
  const value = String(region || "").trim();
  if (!value) return;
  if (!state.token) return;

  regionModalBtns.forEach((b) => (b.disabled = true));
  try {
    const data = await apiPost("/region", { region: value });
    if (data?.me) updatePlayerCard(data.me);
    appendSystemMessage(`Novads saglabāts: ${value}`);
    hideRegionModal();
    await runPostLoginInit();
  } catch (err) {
    console.error("Novada izvēles kļūda:", err);
    appendSystemMessage(err.message || "Neizdevās saglabāt novadu.");
  } finally {
    regionModalBtns.forEach((b) => (b.disabled = false));
  }
}

function bindRegionModal() {
  if (!regionModalEl || !regionModalBtns.length) return;
  if (regionModalEl.dataset.bound === "1") return;
  regionModalEl.dataset.bound = "1";
  regionModalBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const region = btn.getAttribute("data-region") || "";
      setRegionChoice(region);
    });
  });
}

function bindRegionActions() {
  if (regionBoostBtn) regionBoostBtn.addEventListener("click", handleRegionBoost);
  if (regionAttackBtn) regionAttackBtn.addEventListener("click", handleRegionAttack);
  if (regionAttackSelect) {
    regionAttackSelect.addEventListener("change", () => {
      state.regionAttackTarget = regionAttackSelect.value || "";
      updateRegionPointsUi(state.regionPoints, state.region);
    });
  }
}

async function refreshRegionStats() {
  if (!regionListEl || !state.token) return;
  try {
    const raw = await apiGet("/regions/stats");
    const list = Array.isArray(raw) ? raw : raw?.regions || raw?.list || [];
    if (!Array.isArray(list)) return;

    if (regionMyRankEl && raw?.myRegionRank) {
      const r = raw.myRegionRank;
      regionMyRankEl.textContent = `Tu savā novadā: ${r.place}. vieta (no ${r.totalInRegion})`;
      regionMyRankEl.style.display = "block";
    } else if (regionMyRankEl) {
      regionMyRankEl.style.display = "none";
    }

    let totalScore = 0;
    list.forEach((item) => {
      totalScore += Number(item?.score || 0);
    });
    if (regionTotalScoreEl) regionTotalScoreEl.textContent = String(totalScore);
    if (regionTotalFillEl) {
      const totalPct = REGION_TOTAL_CAP
        ? Math.max(0, Math.min(100, (totalScore / REGION_TOTAL_CAP) * 100))
        : 0;
      regionTotalFillEl.style.width = totalPct.toFixed(1) + "%";
    }

    regionListEl.innerHTML = "";
    list.forEach((item, idx) => {
      const li = createEl("li", "vz-region-item");
      if (item.region && item.region === (state?.region || "")) {
        li.classList.add("vz-region-self");
      }

      const row = createEl("div", "vz-region-row");

      const place = createEl("span", "vz-region-place");
      place.textContent = `${idx + 1}.`;
      row.appendChild(place);

      const name = createEl("span", "vz-region-name");
      name.textContent = item.region || "—";
      row.appendChild(name);

      const meta = createEl("span", "vz-region-meta");
      meta.textContent = `(${item.players || 0} spēl.)`;
      row.appendChild(meta);

      const score = createEl("span", "vz-region-score");
      score.textContent = `${item.score || 0} p.`;
      row.appendChild(score);

      const pct = createEl("span", "vz-region-pct");
      const pctVal = REGION_TOTAL_CAP
        ? Math.max(0, Math.min(100, (Number(item.score || 0) / REGION_TOTAL_CAP) * 100))
        : 0;
      pct.textContent = `${pctVal.toFixed(1)}%`;
      row.appendChild(pct);

      li.appendChild(row);

      const bar = createEl("div", "vz-region-bar");
      const fill = createEl("div", "vz-region-bar-fill");
      const metaDef = REGION_META[item.region] || null;
      if (metaDef?.cls) fill.classList.add(metaDef.cls);
      fill.style.width = pctVal.toFixed(1) + "%";
      bar.appendChild(fill);
      li.appendChild(bar);

      regionListEl.appendChild(li);
    });
  } catch (err) {
    console.error("Novadu stats kļūda:", err);
  }
}

async function runPostLoginInit() {
  if (_postLoginInitDone) return;
  _postLoginInitDone = true;

  await refreshSeasonHttp();
  await refreshHof();
  await startNewRound();
  await refreshLeaderboard();
  await refreshWeekly();
  await refreshStreakLeaderboard();
  await refreshDailyLeaderboard();
  await refreshMissions();
  await refreshFriends();
  await refreshRegionStats();
  ensureDailyChestUi();
  await refreshDailyChestStatus();
  if (_chestTickTimer) clearInterval(_chestTickTimer);
  _chestTickTimer = setInterval(refreshDailyChestStatus, 60_000);
  setInterval(() => { if (_chestStatus) renderDailyChestUi(_chestStatus); }, 1000);
  setInterval(refreshRegionStats, 60_000);
  setInterval(refreshStreakLeaderboard, 90_000);
  setInterval(refreshDailyLeaderboard, 90_000);
  initSocket();
}

// ==================== PROFILA POPUP + DM ====================
function handlePersonalMessageClick() {
  const u =
    (ppMsgBtnEl && ppMsgBtnEl.dataset.username ? ppMsgBtnEl.dataset.username : "") ||
    currentProfileName ||
    (ppUsernameEl ? ppUsernameEl.textContent : "");
 
  const username = (u || "").trim();
  if (!username) return;
 
  openDmWith(username);
  hidePlayerProfile();
}

function updateProfileBlockButtons() {
  const name = String(currentProfileName || "").trim();
  const blockBtn = document.getElementById("vz-profile-block-btn");
  const reportBtn = document.getElementById("vz-profile-report-btn");
  if (!blockBtn && !reportBtn) return;

  const isSelf = name && name === state.username;
  if (blockBtn) {
    blockBtn.style.display = isSelf ? "none" : "inline-block";
    blockBtn.textContent = dmIsBlocked(name) ? "🔓 Atbloķēt" : "🚫 Bloķēt";
  }
  if (reportBtn) {
    reportBtn.style.display = isSelf ? "none" : "inline-block";
  }
}

function setProfileEmailStatus(message, kind) {
  if (!ppEmailStatusEl) return;
  ppEmailStatusEl.textContent = message || "";
  ppEmailStatusEl.classList.remove("vz-ok", "vz-error");
  if (kind === "ok") ppEmailStatusEl.classList.add("vz-ok");
  if (kind === "error") ppEmailStatusEl.classList.add("vz-error");
}

async function handleProfileEmailSave() {
  if (!state.token || !ppEmailInputEl) return;
  const raw = String(ppEmailInputEl.value || "").trim();
  if (ppEmailSaveBtn) ppEmailSaveBtn.disabled = true;
  try {
    const data = await apiPost("/email", { email: raw });
    const saved = data?.email ?? "";
    state.email = saved;
    ppEmailInputEl.value = saved;
    setProfileEmailStatus(saved ? "Saglabāts." : "E-pasts noņemts.", saved ? "ok" : "");
  } catch (err) {
    setProfileEmailStatus(err.message || "Neizdevās saglabāt e-pastu.", "error");
  } finally {
    if (ppEmailSaveBtn) ppEmailSaveBtn.disabled = false;
  }
}

async function handleProfileEmailRemove() {
  if (!state.token || !ppEmailInputEl) return;
  if (ppEmailRemoveBtn) ppEmailRemoveBtn.disabled = true;
  try {
    await apiPost("/email", { email: "" });
    state.email = "";
    ppEmailInputEl.value = "";
    setProfileEmailStatus("E-pasts noņemts. Vairs nesaņemsi jaunumus.", "ok");
  } catch (err) {
    setProfileEmailStatus(err.message || "Neizdevās noņemt.", "error");
  } finally {
    if (ppEmailRemoveBtn) ppEmailRemoveBtn.disabled = false;
  }
}

function showPlayerProfile(data) {
  if (!data || !profilePopupEl) return;

  currentProfileName = data.username;
  if (ppMsgBtnEl) ppMsgBtnEl.dataset.username = data.username || "";

  if (ppUsernameEl) {
    ppUsernameEl.textContent = data.username;
    applyNameTierClass(ppUsernameEl, data.rankLevel);
  }
  if (ppRegionEl) {
    const region = String(data.region || "").trim();
    ppRegionEl.textContent = region || "—";
    ppRegionEl.classList.toggle("vz-title-empty", !region);
  }
  if (ppTitleEl) {
    const title = String(data.title || "").trim();
    ppTitleEl.textContent = title || "—";
    ppTitleEl.classList.toggle("vz-title-empty", !title);
  }
  if (ppRankEl) ppRankEl.textContent = `${data.rankTitle} (L${data.rankLevel})`;
  applyRankColor(ppUsernameEl, data.rankColor);
applyRankColor(ppRankEl, data.rankColor);
  if (ppXpEl) ppXpEl.textContent = data.xp;
  if (ppScoreEl) ppScoreEl.textContent = data.score;
  if (ppCoinsEl) ppCoinsEl.textContent = data.coins;
  if (ppTokensEl) ppTokensEl.textContent = data.tokens;
  if (ppBestEl) ppBestEl.textContent = data.bestStreak;

  if (ppMedalsEl) renderPlayerMedals(data.medals, ppMedalsEl, true);

  let avatarForPopup = data.avatarUrl || null;
  const avatarExp = Number(data.avatarUrlExpiresAt) || 0;
  if (data.username === state.username) {
    const storedEntry = getLocalAvatarEntry(state.username);
    if (avatarForPopup) {
      if (
        !storedEntry ||
        storedEntry.url !== avatarForPopup ||
        (avatarExp && storedEntry.exp !== avatarExp)
      ) {
        setLocalAvatar(state.username, avatarForPopup, avatarExp);
      }
    } else if (storedEntry?.url) {
      avatarForPopup = storedEntry.url;
    }
  }
  setAvatar(ppAvatarImgEl, ppAvatarInitialsEl, avatarForPopup, data.username);

  if (profilePopupEl) {
    profilePopupEl.classList.remove("vz-rank-low", "vz-rank-mid", "vz-rank-high");
    for (let i = 1; i <= 10; i++) profilePopupEl.classList.remove("vz-rank-" + i);
    for (let i = 1; i <= 5; i++) profilePopupEl.classList.remove("vz-cos-tier-" + i);
    const aura = getAuraRankFromLevel(data.rankLevel);
    if (aura) profilePopupEl.classList.add("vz-rank-" + aura);
    profilePopupEl.classList.toggle("vz-player-supporter", !!data.supporter);
    const cosTier = getCosmeticTierFromLevel(data.rankLevel);
    if (cosTier) profilePopupEl.classList.add("vz-cos-tier-" + cosTier);
  }

  const isSelf = data.username === state.username;
  if (ppEmailBlockEl) {
    ppEmailBlockEl.classList.toggle("hidden", !isSelf);
  }
  if (isSelf && ppEmailInputEl) {
    ppEmailInputEl.value = data.email || state.email || "";
  }
  setProfileEmailStatus("", "");

  let duelBtn = document.getElementById("vz-profile-duel-btn");
  const inner = profilePopupEl.querySelector(".vz-profile-popup-inner") || profilePopupEl;

  if (!duelBtn && inner) {
    duelBtn = document.createElement("button");
    duelBtn.id = "vz-profile-duel-btn";
    duelBtn.textContent = "⚔️ Izaicināt uz dueli";
    duelBtn.className = "mission-claim-btn";
    duelBtn.style.marginTop = "10px";
    duelBtn.addEventListener("click", handleProfileDuelClick);
    inner.appendChild(duelBtn);
  }

  if (duelBtn) {
    duelBtn.style.display =
      state.username && data.username === state.username ? "none" : "inline-block";
  }

  let blockBtn = document.getElementById("vz-profile-block-btn");
  let reportBtn = document.getElementById("vz-profile-report-btn");

  if (!blockBtn && inner) {
    blockBtn = document.createElement("button");
    blockBtn.id = "vz-profile-block-btn";
    blockBtn.className = "mission-claim-btn";
    blockBtn.style.marginTop = "8px";
    blockBtn.addEventListener("click", () => {
      const name = String(currentProfileName || "").trim();
      if (!name || !state.socket) return;
      if (dmIsBlocked(name)) state.socket.emit("dm.unblock", { with: name });
      else state.socket.emit("dm.block", { with: name });
    });
    inner.appendChild(blockBtn);
  }

  if (!reportBtn && inner) {
    reportBtn = document.createElement("button");
    reportBtn.id = "vz-profile-report-btn";
    reportBtn.className = "mission-claim-btn";
    reportBtn.style.marginTop = "8px";
    reportBtn.textContent = "⚠️ Ziņot";
    reportBtn.addEventListener("click", () => {
      const name = String(currentProfileName || "").trim();
      dmReportUserWith(name);
    });
    inner.appendChild(reportBtn);
  }

  let friendBtn = document.getElementById("vz-profile-friend-btn");
  if (!friendBtn && inner) {
    friendBtn = document.createElement("button");
    friendBtn.id = "vz-profile-friend-btn";
    friendBtn.className = "mission-claim-btn";
    friendBtn.style.marginTop = "8px";
    friendBtn.addEventListener("click", () => handleProfileFriendAction());
    inner.appendChild(friendBtn);
  }

  updateProfileBlockButtons();
  updateProfileFriendButton();

  profilePopupEl.classList.remove("hidden");
}

function hidePlayerProfile() {
  if (!profilePopupEl) return;
  profilePopupEl.classList.add("hidden");
  setProfileEmailStatus("", "");
}

async function openProfile(username) {
  if (!username || username === "SYSTEM" || !state.token) return;
  try {
    const data = await apiGet("/profile/" + encodeURIComponent(username));
    showPlayerProfile(data);
  } catch (err) {
    console.error("Profila kļūda:", err);
    appendSystemMessage("Neizdevās atvērt profilu.");
  }
}

function handleProfileDuelClick() {
  if (!currentProfileName || !state.socket) return;
  if (currentProfileName === state.username) {
    appendSystemMessage("Nevari izaicināt sevi uz dueli.");
    return;
  }
  state.socket.emit("duel.challenge", currentProfileName);
  appendSystemMessage(`Tu izaicināji ${currentProfileName} uz dueli. Gaidām atbildi...`);
  hidePlayerProfile();
}

// ==================== DIENAS MISIJAS ====================
function renderMissions(missions, bonus) {
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

    const statusSpan = createEl("span", "mission-status");

    if (!m.isCompleted) statusSpan.textContent = "Progressā";
    else if (m.isCompleted && !m.isClaimed) statusSpan.textContent = "Gatavs saņemšanai";
    else {
      statusSpan.textContent = "Balva saņemta";
      statusSpan.classList.add("mission-status-done");
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

  if (bonus && typeof bonus === "object") {
    const li = createEl("li", "mission-item");
    li.classList.add("mission-bonus-item");

    const title = createEl("div", "mission-title");
    title.textContent = "Dienas bonus";
    li.appendChild(title);

    const progress = createEl("div", "mission-progress");
    const total = Math.max(0, Number(bonus.total) || 0);
    const completed = Math.max(0, Number(bonus.completed) || 0);
    progress.textContent = `${Math.min(completed, total)}/${total}`;
    li.appendChild(progress);

    const rw = bonus.rewards || {};
    const rewardParts = [];
    if (rw.xp) rewardParts.push(`+${rw.xp} XP`);
    if (rw.coins) rewardParts.push(`+${rw.coins} coins`);
    if (rw.tokens) rewardParts.push(`+${rw.tokens} žetoni`);
    if (rewardParts.length) {
      const rewardsEl = createEl("div", "mission-rewards");
      rewardsEl.textContent = "Bonus balva: " + rewardParts.join(", ");
      li.appendChild(rewardsEl);
    }

    const bottom = createEl("div", "mission-bottom");
    li.appendChild(bottom);

    const statusSpan = createEl("span", "mission-status");
    if (!bonus.isCompleted) statusSpan.textContent = "Progressā";
    else if (bonus.isCompleted && !bonus.isClaimed) statusSpan.textContent = "Gatavs saņemšanai";
    else {
      statusSpan.textContent = "Balva saņemta";
      statusSpan.classList.add("mission-status-done");
    }
    bottom.appendChild(statusSpan);

    if (bonus.isCompleted && !bonus.isClaimed) {
      const btn = createEl("button", "mission-claim-btn");
      btn.textContent = "Saņemt bonusu";
      btn.addEventListener("click", () => claimMissionBonus());
      bottom.appendChild(btn);
    }

    missionsListEl.appendChild(li);
  }
}

function extractMissions(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.missions)) return data.missions;
  if (Array.isArray(data.list)) return data.list;
  return [];
}

function extractMissionBonus(data) {
  if (!data || typeof data !== "object") return null;
  if (data.bonus && typeof data.bonus === "object") return data.bonus;
  return null;
}

async function refreshMissions() {
  if (!state.token) return;
  try {
    const missionsRaw = await apiGet("/missions");
    renderMissions(extractMissions(missionsRaw), extractMissionBonus(missionsRaw));
  } catch (err) {
    console.error("Misiju kļūda:", err);
  }
}

async function claimMission(id) {
  try {
    const data = await apiPost("/missions/claim", { id });
    if (data.me) {
      updatePlayerCard(data.me);
      playSound(sCoin);
    }
    if (data.missions || data.bonus) {
      const missions = extractMissions(data.missions || data);
      const bonus = extractMissionBonus(data);
      renderMissions(missions, bonus);
    }
    appendSystemMessage("✅ Misijas balva saņemta!");
  } catch (err) {
    console.error("Misijas claim kļūda:", err);
    appendSystemMessage(err.message || "Misijas kļūda, mēģini vēlreiz.");
  }
}

async function claimMissionBonus() {
  try {
    const data = await apiPost("/missions/bonus", {});
    if (data.me) {
      updatePlayerCard(data.me);
      playSound(sCoin);
    }
    if (data.missions || data.bonus) {
      const missions = extractMissions(data.missions || data);
      const bonus = extractMissionBonus(data);
      renderMissions(missions, bonus);
    }
    appendSystemMessage("✅ Dienas bonus balva saņemta!");
  } catch (err) {
    console.error("Bonus misijas kļūda:", err);
    appendSystemMessage(err.message || "Bonus balvas kļūda, mēģini vēlreiz.");
  }
}

// ==================== DRAUGI ====================
function applyFriendsPayload(payload) {
  if (!payload || typeof payload !== "object") return;
  state.friends = Array.isArray(payload.friends) ? payload.friends : [];
  state.friendInvitesIn = Array.isArray(payload.incoming) ? payload.incoming : [];
  state.friendInvitesOut = Array.isArray(payload.outgoing) ? payload.outgoing : [];
  renderFriends();
  updateProfileFriendButton();
}

function friendRelation(name) {
  const uname = String(name || "").trim();
  const key = uname.toLowerCase();
  const isFriend = state.friends.some((n) => String(n || "").toLowerCase() === key);
  const incoming = state.friendInvitesIn.some((x) => String(x?.name || "").toLowerCase() === key);
  const outgoing = state.friendInvitesOut.some((x) => String(x?.name || "").toLowerCase() === key);
  return { isFriend, incoming, outgoing };
}

function renderFriends() {
  if (!friendsListEl || !friendsInvitesEl) return;
  friendsListEl.innerHTML = "";
  friendsInvitesEl.innerHTML = "";

  // Incoming invites
  if (state.friendInvitesIn.length) {
    state.friendInvitesIn.forEach((inv) => {
      const name = String(inv?.name || "").trim();
      if (!name) return;
      const row = createEl("div", "vz-friends-invite");
      row.textContent = `${name} uzaicina draugos`;

      const actions = createEl("div", "vz-friends-invite-actions");
      const accept = document.createElement("button");
      accept.textContent = "Pieņemt";
      accept.addEventListener("click", () => friendAccept(name));
      const decline = document.createElement("button");
      decline.textContent = "Noraidīt";
      decline.addEventListener("click", () => friendDecline(name));
      actions.appendChild(accept);
      actions.appendChild(decline);
      row.appendChild(actions);
      friendsInvitesEl.appendChild(row);
    });
  }

  // Outgoing invites
  if (state.friendInvitesOut.length) {
    state.friendInvitesOut.forEach((inv) => {
      const name = String(inv?.name || "").trim();
      if (!name) return;
      const row = createEl("div", "vz-friends-invite");
      row.textContent = `Ielūgums: ${name}`;

      const actions = createEl("div", "vz-friends-invite-actions");
      const cancel = document.createElement("button");
      cancel.textContent = "Atcelt";
      cancel.addEventListener("click", () => friendCancel(name));
      actions.appendChild(cancel);
      row.appendChild(actions);
      friendsInvitesEl.appendChild(row);
    });
  }

  if (!state.friends.length && !state.friendInvitesIn.length && !state.friendInvitesOut.length) {
    const empty = createEl("div", "mission-status");
    empty.textContent = "Nav draugu. Pievieno kādu!";
    friendsInvitesEl.appendChild(empty);
    return;
  }

  state.friends.forEach((name) => {
    const row = createEl("li", "vz-friend-row");
    const left = createEl("div", "vz-friend-left");
    const dot = createEl("span", "vz-friend-status");
    const online = state.onlineUsers.has(String(name || "").trim().toLowerCase());
    if (online) dot.classList.add("vz-friend-online");
    left.appendChild(dot);

    const nick = createEl("span", "vz-friend-name clickable-username");
    nick.textContent = name;
    nick.addEventListener("click", () => openProfile(name));
    left.appendChild(nick);
    row.appendChild(left);

    const actions = createEl("div", "vz-friend-actions");
    const dmBtn = document.createElement("button");
    dmBtn.textContent = "DM";
    dmBtn.addEventListener("click", () => openDmWith(name));
    const rmBtn = document.createElement("button");
    rmBtn.textContent = "Noņemt";
    rmBtn.addEventListener("click", () => friendRemove(name));
    actions.appendChild(dmBtn);
    actions.appendChild(rmBtn);
    row.appendChild(actions);

    friendsListEl.appendChild(row);
  });
}

async function refreshFriends() {
  if (!state.token) return;
  try {
    const data = await apiGet("/friends");
    applyFriendsPayload(data);
  } catch (err) {
    console.error("Draugu kļūda:", err);
  }
}

async function friendRequest(name) {
  const u = String(name || "").trim();
  if (!u) return;
  try {
    const data = await apiPost("/friends/request", { to: u });
    applyFriendsPayload(data.friends || data);
    appendSystemMessage("✅ Ielūgums nosūtīts.");
  } catch (err) {
    appendSystemMessage(err.message || "Neizdevās nosūtīt ielūgumu.");
  }
}

async function friendAccept(name) {
  const u = String(name || "").trim();
  if (!u) return;
  try {
    const data = await apiPost("/friends/accept", { from: u });
    applyFriendsPayload(data.friends || data);
    appendSystemMessage("✅ Draugs pievienots.");
  } catch (err) {
    appendSystemMessage(err.message || "Neizdevās pieņemt ielūgumu.");
  }
}

async function friendDecline(name) {
  const u = String(name || "").trim();
  if (!u) return;
  try {
    const data = await apiPost("/friends/decline", { from: u });
    applyFriendsPayload(data.friends || data);
  } catch (err) {
    appendSystemMessage(err.message || "Neizdevās noraidīt ielūgumu.");
  }
}

async function friendCancel(name) {
  const u = String(name || "").trim();
  if (!u) return;
  try {
    const data = await apiPost("/friends/cancel", { to: u });
    applyFriendsPayload(data.friends || data);
  } catch (err) {
    appendSystemMessage(err.message || "Neizdevās atcelt ielūgumu.");
  }
}

async function friendRemove(name) {
  const u = String(name || "").trim();
  if (!u) return;
  try {
    const data = await apiPost("/friends/remove", { user: u });
    applyFriendsPayload(data.friends || data);
    appendSystemMessage("✅ Draugs noņemts.");
  } catch (err) {
    appendSystemMessage(err.message || "Neizdevās noņemt draugu.");
  }
}

function updateProfileFriendButton() {
  const name = String(currentProfileName || "").trim();
  const btn = document.getElementById("vz-profile-friend-btn");
  if (!btn) return;
  const isSelf = name && name === state.username;
  if (isSelf || !name) {
    btn.style.display = "none";
    return;
  }

  const rel = friendRelation(name);
  btn.style.display = "inline-block";
  if (rel.incoming) btn.textContent = "✅ Pieņemt draugu";
  else if (rel.outgoing) btn.textContent = "⌛ Ielūgts (atcelt)";
  else if (rel.isFriend) btn.textContent = "❌ Noņemt draugu";
  else btn.textContent = "➕ Pievienot draugu";
}

async function handleProfileFriendAction() {
  const name = String(currentProfileName || "").trim();
  if (!name) return;
  const rel = friendRelation(name);
  if (rel.incoming) return friendAccept(name);
  if (rel.outgoing) return friendCancel(name);
  if (rel.isFriend) return friendRemove(name);
  return friendRequest(name);
}

// ==================== GRID / SPĒLES LOĢIKA ====================

// Latvian Shift karte
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

function normalizeLetter(raw) {
  if (raw == null) return "";
  let ch = String(raw);
  if (ch.length !== 1) return "";
  ch = ch.toUpperCase();

  // Ignorējam Q/W/X/Y (gan ekrānā, gan fiziski)
  if (DISALLOWED_KEYS.has(ch)) return "";

  if (state.shiftOn && LATVIAN_MAP[ch]) return LATVIAN_MAP[ch];

  // A-Z bez Q/W/X/Y + LV burti
  if (!/[A-PR-VZĀČĒĢĪĶĻŅŠŪŽ]/.test(ch)) return "";
  return ch;
}

function clearKeyboardStatuses() {
  for (const btn of state.keyboardButtons.values()) {
    if (!btn) continue;
    delete btn.dataset.status;
    btn.classList.remove("correct", "present", "absent");
  }
}

function resetKeyboardForNewRound() {
  state.shiftOn = false;
  clearKeyboardStatuses();
  updateShiftVisual();
}
let _gridGlowInit = false;
let _gridGlowRaf = 0;
let _gridGlowPulseTimer = null;
let _gridGlowPos = { x: 0, y: 0, has: false };

function setGridGlow(x, y, alpha) {
  if (!gridEl) return;
  if (Number.isFinite(x)) gridEl.style.setProperty("--glow-x", `${x}px`);
  if (Number.isFinite(y)) gridEl.style.setProperty("--glow-y", `${y}px`);
  if (Number.isFinite(alpha)) gridEl.style.setProperty("--glow-alpha", String(alpha));
}

function updateGridGlowFromPoint(clientX, clientY, alpha = 0.35) {
  if (!gridEl) return;
  const rect = gridEl.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
  const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
  _gridGlowPos = { x, y, has: true };
  cancelAnimationFrame(_gridGlowRaf);
  _gridGlowRaf = requestAnimationFrame(() => setGridGlow(x, y, alpha));
}

function clearGridGlow() {
  setGridGlow(_gridGlowPos.x, _gridGlowPos.y, 0);
}

function pulseGridGlow() {
  if (!gridEl) return;
  const rect = gridEl.getBoundingClientRect();
  const x = _gridGlowPos.has ? _gridGlowPos.x : rect.width * 0.5;
  const y = _gridGlowPos.has ? _gridGlowPos.y : rect.height * 0.4;
  setGridGlow(x, y, 0.45);
  if (_gridGlowPulseTimer) clearTimeout(_gridGlowPulseTimer);
  _gridGlowPulseTimer = setTimeout(() => setGridGlow(x, y, 0.18), 180);
  setTimeout(() => setGridGlow(x, y, 0), 650);
}

function initGridGlow() {
  if (_gridGlowInit || !gridEl) return;
  _gridGlowInit = true;

  gridEl.addEventListener("pointermove", (e) => updateGridGlowFromPoint(e.clientX, e.clientY, 0.32));
  gridEl.addEventListener("pointerdown", (e) => updateGridGlowFromPoint(e.clientX, e.clientY, 0.45));
  gridEl.addEventListener("pointerleave", clearGridGlow);
  gridEl.addEventListener(
    "touchmove",
    (e) => {
      const t = e.touches && e.touches[0];
      if (t) updateGridGlowFromPoint(t.clientX, t.clientY, 0.3);
    },
    { passive: true }
  );
  gridEl.addEventListener("touchend", clearGridGlow, { passive: true });
}
let _fitGridRaf = 0;
 
function fitGridToViewport() {
  if (!gridEl) return;
 
  const cols = Math.max(3, Number(state.cols) || 5);
  const rows = Math.max(3, Number(state.rows) || 6);
  const gap = 6;
 
  // rezervē vietu apakšā (Jauns raunds / Izlogoties + drošas atstarpes)
  const actionsWrap =
  (newRoundBtn && newRoundBtn.parentElement) ||
  (logoutBtn && logoutBtn.parentElement) ||
  null;
 
const actionsH = actionsWrap ? actionsWrap.getBoundingClientRect().height : 0;
 
// rezervē vietu pogām + safe-area
const safe = (window.visualViewport && window.visualViewport.height)
  ? Math.max(0, window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop)
  : 0;
 
const bottomReserve = Math.max(84, Math.ceil(actionsH) + 12 + safe);
 
  const keyboardH = keyboardEl ? keyboardEl.getBoundingClientRect().height : 0;
  const gridTop = gridEl.getBoundingClientRect().top || 0;
  const keyboardTop = keyboardEl ? keyboardEl.getBoundingClientRect().top : 0;
 
  const vw = Math.min(window.innerWidth, document.documentElement.clientWidth || window.innerWidth);
  const vh = window.innerHeight;
 
  const availW = vw - 24;
  const availHViewport = vh - keyboardH - bottomReserve - gridTop - 12;
  const availHBetween = keyboardTop > gridTop ? keyboardTop - gridTop - 12 : availHViewport;
  const availH = Math.max(0, Math.min(availHViewport, availHBetween));
 
  const maxByW = Math.floor((availW - (cols - 1) * gap) / cols);
  const maxByH = Math.floor((availH - (rows - 1) * gap) / rows);
 
  const size = Math.max(30, Math.min(68, Math.min(maxByW, maxByH)));
 
  gridEl.style.setProperty("--tile-size", size + "px");
  gridEl.style.setProperty("--tile-gap", gap + "px");
}
 
function scheduleFitGrid() {
  cancelAnimationFrame(_fitGridRaf);
  _fitGridRaf = requestAnimationFrame(fitGridToViewport);
}
function resetGrid(len) {
  state.wordLength = len;
  state.cols = len;
  state.currentRow = 0;
  state.currentCol = 0;
  state.isLocked = false;
  state.roundFinished = false;
  state.lastShareResult = null;
  setShareResultVisible(false);
// reset reveal-letter ability katram jaunam raundam
state.revealUsed = false;
state.revealHint = null;
 
ensureRevealAbilityUI();
updateRevealAbilityUI();



  // Baseline: katra raunda startā reset
  resetKeyboardForNewRound();

  if (gridEl) {
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
  }

  if (gameMessageEl) gameMessageEl.textContent = "";
 if (newRoundBtn) {
  newRoundBtn.style.display = "none";
  newRoundBtn.disabled = true;
}
 
scheduleFitGrid();
}

async function startNewRound() {
  if (!state.token) return;
  if (state.duelMode) return;
  try {
    const data = await apiGet("/start-round");
    const len = data.len || 5;
resetGrid(len);


// ja raunds jau bija ar atvērtu burtu (refresh/reconnect), atjaunojam UI un ieliekam hint
if (data && data.revealUsed && data.reveal && Number.isInteger(data.reveal.pos) && data.reveal.letter) {
  state.revealUsed = true;
  state.revealHint = { pos: data.reveal.pos, letter: data.reveal.letter, cost: state.revealCostCoins };
  applyRevealHintFromRow(data.reveal.pos, data.reveal.letter, state.currentRow);
  updateRevealAbilityUI();
}
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
    revealRow(r, h?.pattern || [], { animate: false });
  });
 
  state.currentRow = data.history.length;
  state.currentCol = 0;
  skipHintLockedForward();
}
    if (gameMessageEl) gameMessageEl.textContent = `Jauns raunds (${len} burti).`;
  } catch (err) {
    console.error("start-round kļūda:", err);
    if (gameMessageEl) gameMessageEl.textContent = err.message || "Neizdevās sākt raundu.";
  }
}


function ensureRevealAbilityUI() {
  // UI tiek uzģenerēts JS pusē (nav jāmaina game.html, ja negribi).
  if (document.getElementById("vz-reveal-letter-wrap")) return;
  if (!gridEl) return;

  const wrap = document.createElement("div");
  wrap.id = "vz-reveal-letter-wrap";
  wrap.style.display = "flex";
  wrap.style.alignItems = "center";
  wrap.style.justifyContent = "center";
  wrap.style.gap = "10px";
  wrap.style.margin = "10px 0";

  const btn = document.createElement("button");
  btn.id = "vz-btn-reveal-letter";
  btn.type = "button";
  btn.textContent = `Atvērt 1 burtu (-${state.revealCostCoins} coins)`;
  // mēģinam izmantot esošo button stilu, ja tāds ir
  btn.className = "vz-btn";
  btn.addEventListener("click", useRevealLetter);

  wrap.appendChild(btn);

  // ieliekam starp grid un keyboard, ja tas ir iespējams
  const parent =
    keyboardEl && keyboardEl.parentElement ? keyboardEl.parentElement : gridEl.parentElement;

  if (parent && keyboardEl && keyboardEl.parentElement === parent) {
    parent.insertBefore(wrap, keyboardEl);
  } else if (gridEl) {
    gridEl.insertAdjacentElement("afterend", wrap);
  }
}

function updateRevealAbilityUI() {
  const btn = document.getElementById("vz-btn-reveal-letter");
  if (!btn) return;
 
  const disabled = !!state.duelMode || !!state.isLocked || !!state.roundFinished || !!state.revealUsed;
  btn.disabled = disabled;
 
  if (state.duelMode) {
    btn.textContent = "Reveal nav pieejams duelī";
  } else if (state.revealUsed) {
    btn.textContent = "Burts jau atvērts (šis raunds)";
  } else {
    btn.textContent = `Atvērt 1 burtu (-${state.revealCostCoins} coins)`;
  }
}

function tileIsHintLocked(row, col) {
  const t = state.gridTiles?.[row]?.[col];
  return !!(t && t.dataset && t.dataset.locked === "1");
}

function skipHintLockedForward() {
  // pārbīda kursoru uz nākamo rediģējamo ailīti (izlaiž hint-lock)
  while (state.currentCol < state.cols && tileIsHintLocked(state.currentRow, state.currentCol)) {
    state.currentCol++;
  }
}

function applyRevealHintFromRow(pos, letter, fromRow = state.currentRow) {
  const L = String(letter || "").toUpperCase();
 
  for (let r = fromRow; r < state.rows; r++) {
    const tile = state.gridTiles?.[r]?.[pos];
    if (!tile) continue;
 
    // ja nav burta vai nav vēl atklāts rezultāts, varam ielikt hint burtu
    if (!tile.dataset.letter) {
      tile.dataset.letter = L;
      tile.textContent = L;
    } else {
      const hasResultClass =
        tile.classList.contains("correct") ||
        tile.classList.contains("present") ||
        tile.classList.contains("absent");
 
      if (!hasResultClass) {
        tile.dataset.letter = L;
        tile.textContent = L;
      }
    }
 
    tile.dataset.locked = "1";
    tile.classList.add("hint-locked");
  }
 
  skipHintLockedForward();
}
function applyCorrectLocksFromPattern(fromRowExclusive, guessLetters, pattern) {
  if (!Array.isArray(pattern) || !Array.isArray(guessLetters)) return;
 
  const startRow = Math.max(0, (fromRowExclusive ?? 0) + 1);
 
  for (let pos = 0; pos < state.cols; pos++) {
    if (pattern[pos] !== "correct") continue;
 
    const letter = String(guessLetters[pos] || "").toUpperCase();
    if (!letter) continue;
 
    for (let r = startRow; r < state.rows; r++) {
      const tile = state.gridTiles?.[r]?.[pos];
      if (!tile) continue;
 
      tile.dataset.letter = letter;
      tile.textContent = letter;
      tile.dataset.locked = "1";
      tile.classList.add("hint-locked");
      tile.classList.remove("correct", "present", "absent", "flip", "shake");
    }
  }
}
async function useRevealLetter() {
    if (state.duelMode) return;
  if (state.isLocked || state.roundFinished) return;
  if (state.revealUsed) return;

  try {
    state.isLocked = true;
    updateRevealAbilityUI();

    // Avoid: jau aizpildītās ailes currentRow (lai neatvērtu tur, kur lietotājs jau raksta)
    const avoid = [];
    for (let c = 0; c < state.cols; c++) {
      const tile = state.gridTiles?.[state.currentRow]?.[c];
      if (!tile) continue;
      if (tile.dataset.locked === "1") avoid.push(c);
      else if (tile.dataset.letter) avoid.push(c);
    }

    const data = await apiPost("/ability/reveal-letter", { avoid });

    if (!data || !data.ok) {
      throw new Error("Neizdevās atvērt burtu.");
    }

    // ja serveris atgriež cost, saglabājam UI
    if (Number.isFinite(data.cost)) state.revealCostCoins = data.cost;

    state.revealUsed = true;
    state.revealHint = { pos: data.pos, letter: data.letter, cost: data.cost };

    applyRevealHintFromRow(data.pos, data.letter, state.currentRow);

    // atjaunojam coins/tokens UI
    try {
      const me = await apiGet("/me");
      updatePlayerCard(me);
    } catch (_) {}

    gameMessageEl.textContent = `Atvērts burts: ${String(data.letter || "").toUpperCase()} (pozīcija ${Number(data.pos) + 1})`;
  } catch (err) {
const code = err?.data?.code || err?.data?.error || null;
if (code === "ALREADY_USED") {
  state.revealUsed = true;
  updateRevealAbilityUI();
}
gameMessageEl.textContent = String(err?.message || "Kļūda: reveal-letter");
  } finally {
    state.isLocked = false;
    updateRevealAbilityUI();
  }
}


function addLetter(ch) {
  if (state.isLocked) return;
  if (state.currentRow >= state.rows) return;
// izlaižam hint-lock ailes (ja atvērts burts)
skipHintLockedForward();
if (state.currentCol >= state.cols) return;


  const tile = state.gridTiles[state.currentRow]?.[state.currentCol];
  if (!tile) return;

  tile.textContent = ch;
  tile.dataset.letter = ch;
  tile.classList.remove("correct", "present", "absent", "shake", "flip");

  state.currentCol++;
  skipHintLockedForward();
  playKeyNote(ch);
  pulseSoundFx("type", fxPointFromTile(tile));
  pulseGridGlow();
}

function deleteLetter() {
  if (state.isLocked) return;

  // atrodam iepriekšējo rediģējamo ailīti (izlaiž hint-lock)
  let col = state.currentCol - 1;
  while (col >= 0 && tileIsHintLocked(state.currentRow, col)) col--;

  if (col < 0) return;

  state.currentCol = col;

  const tile = state.gridTiles[state.currentRow]?.[state.currentCol];
  if (!tile) return;

  tile.textContent = "";
  tile.dataset.letter = "";
  tile.classList.remove("correct", "present", "absent", "shake", "flip");

  playControlNote("backspace");
  pulseSoundFx("backspace", fxPointFromTile(tile));
  pulseGridGlow();
}


function flashRow(rowIndex) {
  const row = state.gridTiles[rowIndex] || [];
  row.forEach((tile) => {
    tile.classList.add("shake");
    setTimeout(() => tile.classList.remove("shake"), 300);
  });
  playSound(sError);
}

function updateKeyboardColor(letter, status) {
  if (!letter) return;

  const base = letter.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const btn = state.keyboardButtons.get(base) || state.keyboardButtons.get(letter);

  const priority = { correct: 3, present: 2, absent: 1 };
  if (!btn) return;

  const current = btn.dataset.status || "";
  if (current && priority[current] >= priority[status]) return;

  btn.dataset.status = status;
  btn.classList.remove("correct", "present", "absent");
  btn.classList.add(status);
}

function revealRow(rowIndex, pattern, opts = {}) {
  const animate = opts.animate !== false && !PREFERS_REDUCED_MOTION;
  const half = Math.floor(FLIP_DURATION_MS / 2);
  if (animate) pulseGridGlow();

  for (let c = 0; c < state.cols; c++) {
    const tile = state.gridTiles[rowIndex]?.[c];
    if (!tile) continue;

    const res = pattern[c] || "absent";
    const delay = c * FLIP_DELAY_MS;

    if (!animate) {
      tile.classList.remove("correct", "present", "absent", "flip");
      tile.classList.add(res);
      updateKeyboardColor(tile.dataset.letter, res);
      continue;
    }

    setTimeout(() => {
      tile.classList.remove("flip");
      tile.classList.remove("correct", "present", "absent");
      tile.classList.add("flip");
      setTimeout(() => {
        tile.classList.remove("correct", "present", "absent");
        tile.classList.add(res);
        updateKeyboardColor(tile.dataset.letter, res);
      }, half);
    }, delay);
  }
}

function revealDurationMs() {
  const cols = Math.max(1, state.cols);
  return Math.max(260, (cols - 1) * FLIP_DELAY_MS + FLIP_DURATION_MS);
}

function showWinEffects() {
  if (gridEl) {
    gridEl.classList.add("win-glow");
    setTimeout(() => gridEl.classList.remove("win-glow"), 1200);
  }
  if (screenFlashEl) {
    screenFlashEl.classList.add("vz-screen-flash-active");
    setTimeout(() => screenFlashEl.classList.remove("vz-screen-flash-active"), 200);
  }
  if (typeof confetti === "function") {
    confetti({ particleCount: 80, spread: 70, origin: { y: 0.3 } });
  }
}

// ====== Solo minējums (HTTP /guess) ======
async function submitGuess() {
  if (state.duelMode) {
    submitDuelGuess();
    return;
  }

  if (state.isLocked) return;
  if (state.currentCol !== state.cols) {
    flashRow(state.currentRow);
    if (gameMessageEl) gameMessageEl.textContent = `Vārdam jābūt ${state.cols} burtiem.`;
    return;
  }

  const letters = [];
  for (let c = 0; c < state.cols; c++) {
    letters.push(state.gridTiles[state.currentRow]?.[c]?.dataset.letter || "");
  }
  const guess = letters.join("");
  if (!guess || guess.length !== state.cols) return;

  state.isLocked = true;

  try {
    const data = await apiPost("/guess", { guess });
    const pattern = data.pattern || [];
    revealRow(state.currentRow, pattern);
    const rowIndex = state.currentRow;
const guessLetters = letters.slice(); // kopija

    const isWin = !!data.win;
    const finished = !!data.finished;

    const unlockAfter = revealDurationMs();

    if (isWin) {
      if (gameMessageEl) gameMessageEl.textContent = "Precīzi! Tu atminēji vārdu!";
      playSound(sWin);
      setTimeout(() => showWinEffects(), Math.min(120, unlockAfter));
      state.roundFinished = true;
      setTimeout(() => prepareShareResult(true, rowIndex + 1), unlockAfter + 50);

      if (newRoundBtn) {
        newRoundBtn.style.display = "inline-block";
        newRoundBtn.disabled = false;
       setTimeout(scheduleFitGrid, 0);
       setTimeout(scheduleFitGrid, 250);
      }

      setTimeout(async () => {
        try {
          const me = await apiGet("/me");
          updatePlayerCard(me);
          refreshMissions();
          refreshWeekly();
        } catch {}
      }, unlockAfter);

      setTimeout(recordWinAndMaybeShowRatePrompt, unlockAfter + 600);
      return;
    }

    if (finished) {
      if (gameMessageEl) gameMessageEl.textContent = "Raunds beidzies!";
      state.roundFinished = true;
      setTimeout(() => prepareShareResult(false, rowIndex + 1), unlockAfter + 50);

      if (newRoundBtn) {
        newRoundBtn.style.display = "inline-block";
        newRoundBtn.disabled = false;
       setTimeout(scheduleFitGrid, 0);
       setTimeout(scheduleFitGrid, 250);
      }

      setTimeout(() => playSound(sLose), Math.min(120, unlockAfter));

      setTimeout(async () => {
        try {
          const me = await apiGet("/me");
          updatePlayerCard(me);
          refreshMissions();
          refreshWeekly();
        } catch {}
      }, unlockAfter);

      return;
    }

setTimeout(async () => {
  state.currentRow++;
 
  applyCorrectLocksFromPattern(rowIndex, guessLetters, pattern);
 
  // ja ir atvērts burts šajā raundā, ieliekam to arī nākamajā minēšanas rindā
  if (state.revealHint && Number.isInteger(state.revealHint.pos) && state.revealHint.letter) {
    applyRevealHintFromRow(state.revealHint.pos, state.revealHint.letter, state.currentRow);
  }
 
  state.currentCol = 0;
  skipHintLockedForward();
  state.isLocked = false;
 
  try {
    const me = await apiGet("/me");
    updatePlayerCard(me);
    refreshMissions();
  } catch {}
}, unlockAfter);
  } catch (err) {
    console.error("/guess kļūda:", err);
    if (gameMessageEl) gameMessageEl.textContent = err.message || "Kļūda minējumā.";
    state.isLocked = false;
    playSound(sError);
  }
}

// ====== DUELIS: minējums (Socket.IO duel.guess) ======
function submitDuelGuess() {
  if (!state.socket || !state.duelMode || !state.duelId) return;
  if (state.isLocked) return;

  if (state.currentCol !== state.cols) {
    flashRow(state.currentRow);
    if (gameMessageEl) gameMessageEl.textContent = `Vārdam jābūt ${state.cols} burtiem duelī.`;
    return;
  }

  const letters = [];
  for (let c = 0; c < state.cols; c++) {
    letters.push(state.gridTiles[state.currentRow]?.[c]?.dataset.letter || "");
  }
  const guess = letters.join("");
  if (!guess || guess.length !== state.cols) return;

  state.isLocked = true;
  playControlNote("enter");

  state.socket.emit("duel.guess", { duelId: state.duelId, guess });
}

// ==================== DUELIS – OVERLAY ====================
function ensureDuelRematchBtn() {
  if (!duelOkBtn) return null;
 
  let btn = document.getElementById("duelRematchBtn");
  if (btn) return btn;
 
  btn = document.createElement("button");
  btn.id = "duelRematchBtn";
  btn.type = "button";
  btn.textContent = "🔁 Revanšs";
 
  // paņemam tādu pašu stilu kā OK pogai
  btn.className = duelOkBtn.className || "";
  btn.style.marginLeft = "10px";
 
  duelOkBtn.insertAdjacentElement("afterend", btn);
  return btn;
}
function showDuelResultOverlay(details) {
  if (!duelOverlayEl) return;

  const { winner, youWin, opponent, reason } = details || {};

  let winnerText = "Neviens";
  if (youWin) winnerText = "TU";
  else if (winner) winnerText = winner;

  if (duelWinnerNameEl) duelWinnerNameEl.textContent = winnerText;
  if (duelScoreLineEl) {
  const base = details && details.scoreText ? details.scoreText : "";
  const ranked = details?.ranked !== false;
  const yourElo = details?.yourElo;
 
  let eloTxt = "";
  if (ranked && Number.isFinite(Number(yourElo))) {
    const d = Number(details?.eloDelta);
    const dTxt = Number.isFinite(d) ? (d > 0 ? ` (+${d})` : ` (${d})`) : "";
    eloTxt = ` | ELO: ${Number(yourElo)}${dTxt}`;
  }
 
  duelScoreLineEl.textContent = base + eloTxt;
}

  if (duelExtraMsgEl) {
    let extra = "";
    if (youWin) extra = `Tu uzvarēji dueli pret ${opponent || "pretinieku"}!`;
    else if (winner) extra = `${winner} uzvarēja dueli.`;
    else if (reason === "declined") extra = "Duēlis tika atteikts.";
    else if (!winner && (reason === "timeout" || reason === "no_attempts" || reason === "no_winner"))
  extra = "Neizšķirts!";
else extra = "Duēlis beidzies.";
    duelExtraMsgEl.textContent = extra;
  }
  // winner avatar
const winName = winnerText === "TU" ? state.username : (winner || "");
const winInitial = (winName && winName.charAt(0).toUpperCase()) || "?";
 
const winImg = document.getElementById("duel-winner-avatar");
const winInit = document.getElementById("duel-winner-initials");
 
if (winInit) winInit.textContent = winInitial;
 
if (winImg) {
  let url = null;
 
  if (winName === state.username) {
    const entry = getLocalAvatarEntry(state.username);
    url = entry?.url || null;
  }
 
  if (!url && winName) {
    const cachedEntry = getCachedAvatarEntry(winName);
    if (cachedEntry?.url) url = cachedEntry.url;
  }
 
  if (!url && winName) {
    fetchAvatarForUser(winName, winImg, winInit).catch(() => {});
  } else {
    if (url) {
      winImg.src = url;
      winImg.style.display = "block";
      if (winInit) winInit.style.display = "none";
    } else {
      winImg.src = "";
      winImg.style.display = "none";
      if (winInit) winInit.style.display = "flex";
    }
  }
}
duelOverlayEl.classList.toggle("vz-duel-win", !!youWin);
duelOverlayEl.classList.toggle("vz-duel-lose", !youWin && !!winner);
 duelOverlayEl.classList.remove("hidden");
 if (duelOkBtn) {
  duelOkBtn.disabled = false;
  try { duelOkBtn.focus(); } catch {}
}
}

function hideDuelResultOverlay() {
  if (!duelOverlayEl) return;
  duelOverlayEl.classList.add("hidden");
  duelOverlayEl.classList.remove("vz-duel-win", "vz-duel-lose");
  const b = document.getElementById("duelRematchBtn");
if (b) b.style.display = "none";
}

// ==================== EKRĀNA TASTATŪRA ====================
// Bez Q/W/X/Y
const KEYBOARD_LAYOUT = [
  ["E", "R", "T", "U", "I", "O", "P"],
  ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
  ["SHIFT", "Z", "C", "V", "B", "N", "M", "⌫"],
  ["ENTER"],
];

function buildKeyboard() {
  if (!keyboardEl) return;
  keyboardEl.innerHTML = "";
  state.keyboardButtons.clear();

  KEYBOARD_LAYOUT.forEach((row) => {
    const isEnterRow = row.length === 1 && row[0] === "ENTER";
    const rowEl = createEl("div", "kb-row" + (isEnterRow ? " kb-row-enter" : ""));

    row.forEach((key) => {
      const btn = createEl("button", "kb-key");
      btn.textContent = key;

      if (key === "SHIFT") btn.classList.add("kb-shift");
      if (key === "ENTER") btn.classList.add("kb-enter");
      if (key === "⌫") btn.classList.add("kb-backspace");

      if (key.length === 1 && /[A-Z]/.test(key)) btn.dataset.baseKey = key;

      btn.addEventListener("click", () => {
        // SHIFT drīkst spiest arī lock laikā
        if (state.isLocked && key !== "SHIFT") return;

        if (key === "ENTER") submitGuess();
        else if (key === "⌫") deleteLetter();
        else if (key === "SHIFT") toggleShift();
        else {
          const ch = normalizeLetter(key);
          if (ch) addLetter(ch);
        }
      });

      rowEl.appendChild(btn);

      if (key.length === 1 || key === "SHIFT") state.keyboardButtons.set(key, btn);
    });

    keyboardEl.appendChild(rowEl);
  });

  // startā tīra, lai nav “pārmantoti” stāvokļi
  resetKeyboardForNewRound();
}

function toggleShift() {
  state.shiftOn = !state.shiftOn;
  updateShiftVisual();
}

function updateShiftVisual() {
  if (!keyboardEl) return;

  const on = !!state.shiftOn;

  keyboardEl.querySelectorAll(".kb-shift").forEach((btn) => btn.classList.toggle("kb-shift-on", on));

  keyboardEl.querySelectorAll(".kb-key").forEach((btn) => {
    const base = btn.dataset.baseKey;
    if (!base) return;

    const upper = base.toUpperCase();
    if (DISALLOWED_KEYS.has(upper)) return;

    if (on && LATVIAN_MAP[upper]) btn.textContent = LATVIAN_MAP[upper];
    else btn.textContent = upper;
  });
}

// Fiziskā tastatūra
window.addEventListener("keydown", (e) => {
  const active = document.activeElement;
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;

  // lock laikā atļaujam tikai Enter/Shift
  if (state.isLocked && e.key !== "Enter" && e.key !== "Shift") return;

  if (e.key === "Enter") {
    e.preventDefault();
    submitGuess();
    return;
  }
  if (e.key === "Backspace") {
    e.preventDefault();
    deleteLetter();
    return;
  }
  if (e.key === "Shift") {
    if (e.repeat) return;
    e.preventDefault();
    toggleShift();
    return;
  }

  const ch = normalizeLetter(e.key);
  if (!ch) return;
  e.preventDefault();
  addLetter(ch);
});

// ==================== LEADERBOARD / ONLINE ====================
const TOP_AVATAR_TTL_MS = 24 * 60 * 60 * 1000;

function readAvatarCacheEntry(cacheKey) {
  const entry = readAvatarStorageEntry(cacheKey);
  if (!entry || !entry.url) return null;
  if (entry.exp && Date.now() > entry.exp) return null;
  const ts = Number(entry.ts) || 0;
  if (ts && Date.now() - ts > TOP_AVATAR_TTL_MS) return null;
  return entry;
}

function writeAvatarCacheEntry(cacheKey, url, expiresAt) {
  writeAvatarStorageEntry(cacheKey, url, expiresAt);
}

async function loadLeaderboardAvatar(username, imgEl, initialsEl) {
  if (!username || !imgEl || !initialsEl) return;

  const cacheKey = "vz_avatar_top_" + username;
  let avatarUrl = null;

  const cached = readAvatarCacheEntry(cacheKey);
  avatarUrl = cached?.url || null;

  if (!avatarUrl && state.token) {
    try {
      const profile = await apiGet("/profile/" + encodeURIComponent(username));
      avatarUrl = profile.avatarUrl || null;
      const exp = Number(profile.avatarUrlExpiresAt) || 0;
      if (avatarUrl) writeAvatarCacheEntry(cacheKey, avatarUrl, exp);
    } catch (err) {
      console.warn("TOP avatar /profile kļūda", username, err);
    }
  }

  setAvatar(imgEl, initialsEl, avatarUrl, username);
}

function extractLeaderboard(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.list)) return data.list;
  if (Array.isArray(data.leaderboard)) return data.leaderboard;
  if (Array.isArray(data.top10)) return data.top10;
  if (Array.isArray(data.items)) return data.items;
  return [];
}

async function refreshLeaderboard() {
  try {
    const raw = await apiGet("/leaderboard");
    const list = extractLeaderboard(raw);

    if (!lbListEl) return;
    lbListEl.innerHTML = "";

    list.forEach((item, idx) => {
      const li = createEl("li", "vz-lb-item");
      if (idx < 3) {
        li.classList.add("vz-lb-top", `vz-lb-top-${idx + 1}`);
      }

      const placeSpan = createEl("span", "vz-lb-place");
      placeSpan.textContent = item.place + ".";
      li.appendChild(placeSpan);

      const avatarWrap = createEl("span", "vz-lb-avatar");
      const avatarImg = createEl("img", "vz-lb-avatar-img");
      const avatarInitials = createEl("span", "vz-lb-avatar-initials");
      avatarWrap.appendChild(avatarImg);
      avatarWrap.appendChild(avatarInitials);
      li.appendChild(avatarWrap);

      const spanName = createEl("span", "clickable-username vz-lb-name");
      spanName.textContent = item.username;
      applyRankColor(spanName, item.rankColor);
      spanName.title = item.rankTitle || "";
      spanName.addEventListener("click", () => openProfile(item.username));
      applyNameTierClass(spanName, item.rankLevel);
      li.appendChild(spanName);

      const scoreSpan = createEl("span", "vz-lb-score");
      scoreSpan.textContent = ` — ${item.score} p.`;
      li.appendChild(scoreSpan);

      lbListEl.appendChild(li);

      loadLeaderboardAvatar(item.username, avatarImg, avatarInitials);
    });

    const meName = state.me?.username;
    const lbTargetEl = document.getElementById("lb-target-line");
    if (lbTargetEl && meName && list.length) {
      const myIdx = list.findIndex((x) => x.username === meName);
      if (myIdx === 0) {
        lbTargetEl.textContent = "Tu esi 1. vieta! 🏆";
        lbTargetEl.style.display = "block";
      } else if (myIdx > 0) {
        lbTargetEl.textContent = "Tavs mērķis: pārspēj " + (list[myIdx - 1].username || "");
        lbTargetEl.style.display = "block";
      } else {
        lbTargetEl.style.display = "none";
      }
    }
  } catch (err) {
    console.error("Leaderboard kļūda:", err);
  }
}

function renderLeaderboardList(listEl, list, scoreLabel) {
  if (!listEl) return;
  listEl.innerHTML = "";
  (list || []).forEach((item, idx) => {
    const li = createEl("li", "vz-lb-item");
    if (idx < 3) li.classList.add("vz-lb-top", `vz-lb-top-${idx + 1}`);
    const placeSpan = createEl("span", "vz-lb-place");
    placeSpan.textContent = (item.place != null ? item.place : idx + 1) + ".";
    li.appendChild(placeSpan);
    const avatarWrap = createEl("span", "vz-lb-avatar");
    const avatarImg = createEl("img", "vz-lb-avatar-img");
    const avatarInitials = createEl("span", "vz-lb-avatar-initials");
    avatarWrap.appendChild(avatarImg);
    avatarWrap.appendChild(avatarInitials);
    li.appendChild(avatarWrap);
    const spanName = createEl("span", "clickable-username vz-lb-name");
    spanName.textContent = item.username;
    applyRankColor(spanName, item.rankColor);
    spanName.title = item.rankTitle || "";
    spanName.addEventListener("click", () => openProfile(item.username));
    applyNameTierClass(spanName, item.rankLevel);
    li.appendChild(spanName);
    const scoreSpan = createEl("span", "vz-lb-score");
    scoreSpan.textContent = scoreLabel(item);
    li.appendChild(scoreSpan);
    listEl.appendChild(li);
    loadLeaderboardAvatar(item.username, avatarImg, avatarInitials);
  });
}

async function refreshStreakLeaderboard() {
  try {
    const raw = await apiGet("/leaderboard/streak");
    const list = extractLeaderboard(raw);
    renderLeaderboardList(streakListEl, list, (item) => ` — ${item.bestStreak || 0} 🔥`);
  } catch (err) {
    console.warn("Streak leaderboard kļūda:", err);
  }
}

async function refreshDailyLeaderboard() {
  try {
    const raw = await apiGet("/leaderboard/daily");
    const list = extractLeaderboard(raw);
    renderLeaderboardList(dailyListEl, list, (item) => ` — ${item.winsToday || 0} W`);
  } catch (err) {
    console.warn("Daily leaderboard kļūda:", err);
  }
}

function renderWeekly(payload) {
  if (!weeklyListEl) return;
  const list = Array.isArray(payload?.list) ? payload.list : [];
  weeklyListEl.innerHTML = "";

  if (weeklySubEl) {
    const wk = payload?.weekKey ? String(payload.weekKey) : "";
    weeklySubEl.textContent = wk ? `Nedēļa sākas: ${wk}` : "Šonedēļ";
  }

  if (!list.length) {
    const li = createEl("li", "vz-lb-item");
    li.textContent = "Šonedēļ vēl nav rezultātu.";
    weeklyListEl.appendChild(li);
  } else {
    list.forEach((item, idx) => {
      const li = createEl("li", "vz-lb-item");
      if (idx < 3) {
        li.classList.add("vz-lb-top", `vz-lb-top-${idx + 1}`);
      }

      const placeSpan = createEl("span", "vz-lb-place");
      placeSpan.textContent = String(idx + 1) + ".";
      li.appendChild(placeSpan);

      const avatarWrap = createEl("span", "vz-lb-avatar");
      const avatarImg = createEl("img", "vz-lb-avatar-img");
      const avatarInitials = createEl("span", "vz-lb-avatar-initials");
      avatarWrap.appendChild(avatarImg);
      avatarWrap.appendChild(avatarInitials);
      li.appendChild(avatarWrap);

      const spanName = createEl("span", "clickable-username vz-lb-name");
      spanName.textContent = item.username;
      applyRankColor(spanName, item.rankColor);
      spanName.title = item.rankTitle || "";
      spanName.addEventListener("click", () => openProfile(item.username));
      applyNameTierClass(spanName, item.rankLevel);
      li.appendChild(spanName);

      const scoreSpan = createEl("span", "vz-lb-score");
      scoreSpan.textContent = ` — ${item.wins || 0} W`;
      li.appendChild(scoreSpan);

      weeklyListEl.appendChild(li);
      loadLeaderboardAvatar(item.username, avatarImg, avatarInitials);
    });
  }

  if (weeklyYouEl) {
    if (payload?.you && payload.you.username) {
      weeklyYouEl.textContent = `Tava vieta: #${payload.you.rank} — ${payload.you.wins || 0} W`;
    } else {
      weeklyYouEl.textContent = "Tava vieta: —";
    }
  }
}

async function refreshWeekly() {
  if (!state.token) return;
  try {
    const data = await apiGet("/weekly");
    renderWeekly(data || {});
  } catch (err) {
    console.error("Weekly kļūda:", err);
  }
}

function updateOnlineList(payload) {
  const ul = onlineListEl;
  const countEl = onlineCountEl;
  if (!ul || !countEl) return;

  let players = [];
  let count = 0;

  if (Array.isArray(payload)) {
    players = payload;
    count = players.length;
  } else if (payload && typeof payload === "object") {
    const users = payload.users || payload.players || payload.list || payload.online;
    if (Array.isArray(users)) players = users;
    count = typeof payload.count === "number" ? payload.count : players.length;
  }

  ul.innerHTML = "";

  const myName = (state.username || "").trim();
  const visibleCount = players.length;
  const onlineSet = new Set();

  players.forEach((p) => {
    let username = "";
let supporter = false;
let avatarUrl = null;
let rankLevel = null;
let rankColor = null;
let region = "";

    if (typeof p === "string") username = p;
    else if (p && typeof p === "object") {
      username = p.username || p.name || "";
      supporter = !!(p.supporter || p.isSupporter);
      avatarUrl = p.avatarUrl || null;
    if (typeof p.rankLevel === "number") rankLevel = p.rankLevel;
    if (typeof p.rankColor === "string") rankColor = p.rankColor;
    if (typeof p.region === "string") region = p.region;
    }

    if (!username) return;
    onlineSet.add(String(username || "").trim().toLowerCase());

    const li = document.createElement("li");
    if (username === myName) li.classList.add("vz-online-self");
    if (supporter) li.classList.add("vz-online-supporter");

    const avatarWrap = document.createElement("div");
    avatarWrap.className = "vz-online-avatar";

    const img = document.createElement("img");
    img.className = "vz-online-avatar-img";
    const init = document.createElement("span");
    init.className = "vz-online-avatar-initials";

    avatarWrap.appendChild(img);
    avatarWrap.appendChild(init);
    li.appendChild(avatarWrap);

    if (avatarUrl) {
      img.src = avatarUrl;
      img.style.display = "block";
      init.style.display = "none";
    } else {
      applyMiniAvatar(username, img, init);
    }

    const span = document.createElement("span");
    span.textContent = username;
    span.className = "clickable-username";
    applyRankColor(span, rankColor);
    if (rankLevel != null) applyNameTierClass(span, rankLevel);
    span.addEventListener("click", () => openProfile(username));
    const badge = buildRegionBadge(region, "vz-region-badge-online");
    if (badge) li.appendChild(badge);
    li.appendChild(span);

    ul.appendChild(li);
  });

  const finalCount = typeof count === "number" && count > 0 ? count : visibleCount;
  countEl.textContent = String(finalCount);
  state.onlineUsers = onlineSet;
  renderFriends();
}

// ==================== HALL OF FAME ====================
function extractHofEntry(data) {
  if (!data) return null;

  let entry = null;

  if (Array.isArray(data)) entry = data[0] || null;
  else if (data.top) entry = data.top;
  else if (data.champion) entry = data.champion;
  else entry = data;

  if (!entry || typeof entry !== "object") return null;
  if (!entry.username) return null;
  return entry;
}

function renderHofEntry(entry) {
  if (!hofBoxEl || !hofSeason1El) return;

  const e = extractHofEntry(entry);
  if (!e) {
    hofBoxEl.classList.add("hidden");
    hofSeason1El.innerHTML = "";
    return;
  }

  hofBoxEl.classList.remove("hidden");
  hofSeason1El.innerHTML = "";

  const avatarWrap = createEl("span", "vz-lb-avatar");
  const avatarImg = createEl("img", "vz-lb-avatar-img");
  const avatarInitials = createEl("span", "vz-lb-avatar-initials");
  avatarWrap.appendChild(avatarImg);
  avatarWrap.appendChild(avatarInitials);

  const nameEl = createEl("span", "clickable-username");
  nameEl.textContent = e.username;
  nameEl.addEventListener("click", () => openProfile(e.username));
  if (typeof e.rankLevel === "number") applyNameTierClass(nameEl, e.rankLevel);

  const infoEl = createEl("span", "vz-hof-info");
  const score = typeof e.score === "number" ? e.score : e.score || "";
  const seasonId = e.seasonId != null ? e.seasonId : "";
  const when =
    e.finishedAt
      ? new Date(e.finishedAt).toLocaleString("lv-LV", { timeZone: "Europe/Riga" })
      : "";

  infoEl.textContent =
    `${seasonId ? ` — Sezona ${seasonId}` : ""}` +
    `${score !== "" ? ` — ${score} p.` : ""}` +
    `${when ? ` — ${when}` : ""}`;

  hofSeason1El.appendChild(avatarWrap);
  hofSeason1El.appendChild(nameEl);
  hofSeason1El.appendChild(infoEl);

  if (e.avatarUrl) setAvatar(avatarImg, avatarInitials, e.avatarUrl, e.username);
  else applyMiniAvatar(e.username, avatarImg, avatarInitials);
}

async function refreshHof() {
  if (!state.token) return;
  try {
    const data = await apiGet("/season/hof");
    renderHofEntry(data);
  } catch (err) {
    console.error("HoF /season/hof kļūda:", err);
  }
}

// ==================== ČATS: UNREAD + MENTION ====================
let chatUnread = 0;
let lastMention = null;
let mentionPopupTimer = null;

const MAX_CHAT_ROWS = 100;
const CHAT_DEDUPE_MAX = 500;
const chatSeen = new Map(); // key -> ts
const chatSeenOrder = []; // keys FIFO

function normalizeTs(ts) {
  const n = Number(ts) || 0;
  if (n > 0 && n < 1e12) return n * 1000; // seconds -> ms
  return n || Date.now();
}

function chatDedupeKey(msg) {
  const id = msg && (msg.id || msg._id);
  if (id != null) return "id:" + String(id);

  const ts = normalizeTs(msg && msg.ts);
  const u = String(msg && msg.username ? msg.username : "");
  const t = String(msg && msg.text ? msg.text : "");
  return `${ts}|${u}|${t}`;
}
function markChatSeen(key) {
  if (chatSeen.has(key)) return;
  chatSeen.set(key, Date.now());
  chatSeenOrder.push(key);
  while (chatSeenOrder.length > CHAT_DEDUPE_MAX) {
    const k = chatSeenOrder.shift();
    if (k) chatSeen.delete(k);
  }
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let _lastSystemText = "";
let _lastSystemAt = 0;

function isChatNearBottom() {
  if (!chatMessagesEl) return true;
  const threshold = 40;
  return chatMessagesEl.scrollHeight - chatMessagesEl.scrollTop - chatMessagesEl.clientHeight < threshold;
}

function trimChatRowsKeepScroll() {
  if (!chatMessagesEl) return;

  const wasNearBottom = isChatNearBottom();
  let removedPx = 0;

  while (chatMessagesEl.children.length > MAX_CHAT_ROWS) {
    const first = chatMessagesEl.firstElementChild;
    if (!first) break;

    const h = first.getBoundingClientRect().height || 24;
    removedPx += h;
    chatMessagesEl.removeChild(first);
  }

  if (!wasNearBottom && removedPx > 0) {
    chatMessagesEl.scrollTop = Math.max(0, chatMessagesEl.scrollTop - removedPx);
  }
}

function setUnreadBadge(on) {
  if (!chatUnreadBadgeEl) return;
  chatUnreadBadgeEl.classList.toggle("hidden", !on);
  chatUnreadBadgeEl.textContent = on ? String(Math.min(chatUnread, 99)) : "";
  chatUnreadBadgeEl.title = on ? `${chatUnread} nelasītas ziņas` : "";
}

function showMentionPopup(text) {
  if (!chatMentionPopupEl || !chatMentionPopupTextEl) return;

  chatMentionPopupTextEl.textContent = text || "";
  chatMentionPopupEl.classList.add("vz-mention-popup-show");

  if (mentionPopupTimer) clearTimeout(mentionPopupTimer);
  mentionPopupTimer = setTimeout(() => {
    chatMentionPopupEl.classList.remove("vz-mention-popup-show");
  }, 3500);
}

function buildChatRowElement(msg) {
  const row = createEl("div", "chat-row");
  const ts = normalizeTs(msg.ts);
  const time = new Date(ts);
  const timeStr = time.toLocaleTimeString("lv-LV", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Riga",
  });

  const timeSpan = createEl("span", "chat-time");
  timeSpan.textContent = `[${timeStr}] `;
  row.appendChild(timeSpan);

  if (msg.username === "SYSTEM") {
    const nameSpan = createEl("span", "chat-name-system");
    nameSpan.textContent = "SYSTEM: ";
    row.appendChild(nameSpan);
  } else {
    const avatarWrap = createEl("div", "vz-chat-avatar");
    const img = createEl("img", "vz-chat-avatar-img");
    const init = createEl("span", "vz-chat-avatar-initials");
    avatarWrap.appendChild(img);
    avatarWrap.appendChild(init);
    row.appendChild(avatarWrap);

    applyMiniAvatar(msg.username, img, init);

    const nameSpan = createEl("span", "chat-name");
    const clickable = createEl("span", "clickable-username");
    clickable.textContent = msg.username + ": ";
    if (typeof msg.rankLevel === "number") applyNameTierClass(clickable, msg.rankLevel);
    applyRankColor(clickable, msg.rankColor);
    clickable.addEventListener("click", () => openProfile(msg.username));
    const badge = buildRegionBadge(msg.region, "vz-region-badge-chat");
    if (badge) nameSpan.appendChild(badge);
    nameSpan.appendChild(clickable);
    row.appendChild(nameSpan);
  }

  const textSpan = createEl("span", "chat-text");
  textSpan.textContent = msg.text;
  row.appendChild(textSpan);

  return row;
}

function appendChatMessage(msg, opts = {}) {
  if (!chatMessagesEl || !msg) return;
  const uname = String(msg.username || "").trim();
  if (uname && uname !== "SYSTEM" && dmIsBlocked(uname)) return;

  const key = chatDedupeKey(msg);
  if (chatSeen.has(key)) return;
  markChatSeen(key);

  const isHistory = !!opts.isHistory;

  const wasNearBottom = isChatNearBottom();
  const row = buildChatRowElement(msg);

  chatMessagesEl.appendChild(row);

  if (wasNearBottom || isHistory) chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;

  if (!isHistory) {
    const tabHidden = !!document.hidden;
    const nowNearBottom = isChatNearBottom();
    if (tabHidden || !nowNearBottom) {
      chatUnread++;
      setUnreadBadge(true);
    }

    const my = (state.username || "").trim();
    if (my && msg.username && msg.username !== "SYSTEM") {
      const re = new RegExp("@" + escapeRegExp(my) + "(\\b|$)", "i");
      if (re.test(String(msg.text || ""))) {
        lastMention = { from: msg.username, text: msg.text, ts: normalizeTs(msg.ts) };
        if (chatMentionBadgeEl) chatMentionBadgeEl.classList.add("vz-mention-active");
        showMentionPopup(`🔔 ${msg.username}: ${msg.text}`);
      }
    }
  }

  trimChatRowsKeepScroll();
}

function appendChatMessagesBulk(list, opts = {}) {
  if (!chatMessagesEl || !Array.isArray(list) || !list.length) return;

  const isHistory = !!opts.isHistory;
  const wasNearBottom = isChatNearBottom();

  const frag = document.createDocumentFragment();
  for (const msg of list) {
    if (!msg) continue;
    const uname = String(msg.username || "").trim();
    if (uname && uname !== "SYSTEM" && dmIsBlocked(uname)) continue;

    const key = chatDedupeKey(msg);
    if (chatSeen.has(key)) continue;
    markChatSeen(key);

    frag.appendChild(buildChatRowElement(msg));
  }

  chatMessagesEl.appendChild(frag);

  if (wasNearBottom || isHistory) chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  trimChatRowsKeepScroll();
}

function appendSystemMessage(text) {
  const t = String(text ?? "");
  const now = Date.now();

  if (t === _lastSystemText && now - _lastSystemAt < 5000) return;

  _lastSystemText = t;
  _lastSystemAt = now;

  appendChatMessage({ username: "SYSTEM", text: t, ts: now });
}

function clearUnreadIfNeeded() {
  if (!chatMessagesEl) return;
  if (!document.hidden && isChatNearBottom()) {
    chatUnread = 0;
    setUnreadBadge(false);
  }
}
// ==================== DM (privāts čats) UI + loģika ====================
let dmTypingLastSent = 0;
let dmTypingStopTimer = null;
function ensureDmUi() {
  if (document.getElementById("vz-dm-fab")) return;
 
  // FAB poga
  const fab = document.createElement("button");
  fab.id = "vz-dm-fab";
  fab.type = "button";
  fab.textContent = "✉️";
  fab.title = "Privātais čats";
  fab.style.position = "fixed";
  fab.style.right = "14px";
fab.style.bottom = "";
fab.style.top = "74px";
  fab.style.zIndex = "99998";
  fab.style.width = "52px";
  fab.style.height = "52px";
  fab.style.borderRadius = "16px";
  fab.style.border = "1px solid rgba(255,255,255,0.18)";
  fab.style.background = "rgba(20,20,24,0.92)";
  fab.style.color = "#fff";
  fab.style.fontSize = "20px";
  fab.style.fontWeight = "900";
  fab.style.boxShadow = "0 10px 30px rgba(0,0,0,0.35)";
 
  const badge = document.createElement("div");
  badge.id = "vz-dm-badge";
  badge.style.position = "absolute";
  badge.style.top = "-6px";
  badge.style.right = "-6px";
  badge.style.minWidth = "20px";
  badge.style.height = "20px";
  badge.style.padding = "0 6px";
  badge.style.display = "none";
  badge.style.alignItems = "center";
  badge.style.justifyContent = "center";
  badge.style.borderRadius = "999px";
  badge.style.background = "#ef4444";
  badge.style.color = "#fff";
  badge.style.fontSize = "12px";
  badge.style.fontWeight = "900";
  badge.style.border = "2px solid rgba(20,20,24,0.92)";
  fab.appendChild(badge);
 
 fab.addEventListener("click", () => {
  if (fab.dataset.lpJustDid === "1") return;
 
  const u = String(state.dmLastFrom || "").trim();
  if (u) openDmWith(u);
  else dmShowInbox();
});
 
  // Drawer
  const drawer = document.createElement("div");
  drawer.id = "vz-dm-drawer";
  drawer.style.position = "fixed";
  drawer.style.right = "14px";
  drawer.style.bottom = "14px";
  drawer.style.zIndex = "99999";
  drawer.style.width = "340px";
  drawer.style.maxWidth = "calc(100vw - 28px)";
  drawer.style.height = "420px";
  drawer.style.maxHeight = "calc(100vh - 28px)";
  drawer.style.display = "none";
  drawer.style.flexDirection = "column";
  drawer.style.background = "rgba(20,20,24,0.96)";
  drawer.style.border = "1px solid rgba(255,255,255,0.12)";
  drawer.style.borderRadius = "14px";
  drawer.style.boxShadow = "0 10px 30px rgba(0,0,0,0.45)";
  drawer.style.overflow = "hidden";
  drawer.style.backdropFilter = "blur(8px)";
 
  const header = document.createElement("div");
  header.style.display = "flex";
  header.style.alignItems = "center";
  header.style.justifyContent = "space-between";
  header.style.padding = "10px 12px";
  header.style.borderBottom = "1px solid rgba(255,255,255,0.10)";
 
  const title = document.createElement("div");
  title.id = "vz-dm-title";
  title.style.fontWeight = "900";
  title.style.color = "#fff";
  title.textContent = "Privātais čats";
 
  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.alignItems = "center";
  actions.style.gap = "6px";

  const report = document.createElement("button");
  report.id = "vz-dm-report-user";
  report.type = "button";
  report.textContent = "⚠️";
  report.title = "Ziņot par lietotāju";
  report.style.width = "34px";
  report.style.height = "34px";
  report.style.borderRadius = "10px";
  report.style.border = "1px solid rgba(255,255,255,0.12)";
  report.style.background = "rgba(255,255,255,0.06)";
  report.style.color = "#fff";
  report.addEventListener("click", () => dmReportUser());

  const block = document.createElement("button");
  block.id = "vz-dm-block";
  block.type = "button";
  block.textContent = "🚫";
  block.title = "Bloķēt lietotāju";
  block.style.width = "34px";
  block.style.height = "34px";
  block.style.borderRadius = "10px";
  block.style.border = "1px solid rgba(255,255,255,0.12)";
  block.style.background = "rgba(255,255,255,0.06)";
  block.style.color = "#fff";
  block.addEventListener("click", () => {
    const u = String(state.dmOpenWith || "").trim();
    if (!u || !state.socket) return dmToast("Atver sarunu, lai bloķētu.");
    if (dmIsBlocked(u)) state.socket.emit("dm.unblock", { with: u });
    else state.socket.emit("dm.block", { with: u });
  });

  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "✕";
  close.style.width = "34px";
  close.style.height = "34px";
  close.style.borderRadius = "10px";
  close.style.border = "1px solid rgba(255,255,255,0.12)";
  close.style.background = "rgba(255,255,255,0.06)";
  close.style.color = "#fff";
  close.addEventListener("click", () => dmClose());
 const del = document.createElement("button");
  del.type = "button";
  del.textContent = "🗑️";
  del.title = "Dzēst šo sarunu (tikai man)";
  del.style.width = "34px";
  del.style.height = "34px";
  del.style.borderRadius = "10px";
  del.style.border = "1px solid rgba(255,255,255,0.12)";
  del.style.background = "rgba(255,255,255,0.06)";
  del.style.color = "#fff";
 
  let _armUntil = 0;
  let _armUser = "";
  del.addEventListener("click", () => {
    const u = String(state.dmOpenWith || "").trim();
    if (!u) return dmToast("Atver sarunu, ko dzēst.");
    const now = Date.now();
    if (_armUser === u && now < _armUntil) {
      // apstiprināts
      try { state.socket.emit("dm.clearThread", { with: u }); } catch {}
      state.dmThreads.delete(u);
      dmMarkReadLocal(u);
      state.dmOpenWith = null;
      dmShowInbox();
      return;
    }
    _armUser = u;
    _armUntil = now + 3000;
    dmToast("Spied vēlreiz 3s laikā, lai dzēstu sarunu.", "");
  });
  
  actions.appendChild(report);
  actions.appendChild(block);
  actions.appendChild(close);
  actions.appendChild(del);

  header.appendChild(title);
  header.appendChild(actions);
 
  const msgs = document.createElement("div");
  msgs.id = "vz-dm-messages";
  msgs.style.flex = "1";
  msgs.style.padding = "10px 12px";
  msgs.style.overflow = "auto";
  msgs.style.display = "flex";
  msgs.style.flexDirection = "column";
  msgs.style.gap = "8px";
 
  const contextBar = document.createElement("div");
  contextBar.id = "vz-dm-context";
  contextBar.style.display = "none";
  contextBar.style.alignItems = "center";
  contextBar.style.justifyContent = "space-between";
  contextBar.style.gap = "8px";
  contextBar.style.padding = "6px 12px";
  contextBar.style.borderTop = "1px solid rgba(255,255,255,0.08)";
  contextBar.style.background = "rgba(255,255,255,0.04)";

  const contextText = document.createElement("div");
  contextText.id = "vz-dm-context-text";
  contextText.style.fontSize = "12px";
  contextText.style.opacity = "0.85";
  contextText.style.whiteSpace = "nowrap";
  contextText.style.overflow = "hidden";
  contextText.style.textOverflow = "ellipsis";

  const contextClose = document.createElement("button");
  contextClose.type = "button";
  contextClose.textContent = "✕";
  contextClose.style.width = "26px";
  contextClose.style.height = "26px";
  contextClose.style.borderRadius = "8px";
  contextClose.style.border = "1px solid rgba(255,255,255,0.12)";
  contextClose.style.background = "rgba(255,255,255,0.06)";
  contextClose.style.color = "#fff";
  contextClose.addEventListener("click", () => dmClearContext());

  contextBar.appendChild(contextText);
  contextBar.appendChild(contextClose);

  const typingBar = document.createElement("div");
  typingBar.id = "vz-dm-typing";
  typingBar.style.display = "none";
  typingBar.style.padding = "0 12px 8px";
  typingBar.style.fontSize = "12px";
  typingBar.style.opacity = "0.8";

  const inputRow = document.createElement("div");
  inputRow.id = "vz-dm-input-row";
  inputRow.style.display = "flex";
  inputRow.style.gap = "8px";
  inputRow.style.padding = "10px 12px";
  inputRow.style.borderTop = "1px solid rgba(255,255,255,0.10)";
 
  const inp = document.createElement("input");
  inp.id = "vz-dm-input";
  inp.type = "text";
  inp.placeholder = "Raksti ziņu…";
  inp.maxLength = 400;
  inp.style.flex = "1";
  inp.style.padding = "10px 10px";
  inp.style.borderRadius = "12px";
  inp.style.border = "1px solid rgba(255,255,255,0.14)";
  inp.style.background = "rgba(255,255,255,0.06)";
  inp.style.color = "#fff";
  inp.addEventListener("input", () => dmHandleTypingInput());
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      dmSendCurrent();
    }
    if (e.key === "Escape") {
      dmClose();
    }
  });
  inp.addEventListener("blur", () => dmSendTyping(false));
 
  const send = document.createElement("button");
  send.id = "vz-dm-send";
  send.type = "button";
  send.textContent = "Sūtīt";
  send.style.padding = "10px 12px";
  send.style.borderRadius = "12px";
  send.style.border = "1px solid rgba(255,255,255,0.14)";
  send.style.background = "rgba(60,180,120,0.35)";
  send.style.color = "#fff";
  send.style.fontWeight = "800";
  send.addEventListener("click", () => dmSendCurrent());
 
  inputRow.appendChild(inp);
  inputRow.appendChild(send);
 
  drawer.appendChild(header);
  drawer.appendChild(msgs);
  drawer.appendChild(contextBar);
  drawer.appendChild(typingBar);
  drawer.appendChild(inputRow);
 
  // Toast
  const toast = document.createElement("div");
  toast.id = "vz-dm-toast";
  toast.style.position = "fixed";
  toast.style.right = "14px";
 toast.style.bottom = "";
toast.style.top = "74px";
  toast.style.zIndex = "99999";
  toast.style.display = "none";
  toast.style.maxWidth = "320px";
  toast.style.padding = "10px 12px";
  toast.style.borderRadius = "12px";
  toast.style.background = "rgba(20,20,24,0.92)";
  toast.style.border = "1px solid rgba(255,255,255,0.12)";
  toast.style.color = "#fff";
  toast.style.boxShadow = "0 10px 30px rgba(0,0,0,0.35)";
  toast.style.cursor = "pointer";
  toast.addEventListener("click", () => {
    if (toast.dataset.from) openDmWith(toast.dataset.from);
    toast.style.display = "none";
  });
 
  document.body.appendChild(fab);
  document.body.appendChild(drawer);
  document.body.appendChild(toast);
  // paceļam FAB/drawer virs mobilās klaviatūras (visualViewport)
try {
  const vv = window.visualViewport;
 
  const apply = () => {
  const keyboardH = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
 
  // FAB ir top-right: nekad neliekam bottom (lai nelēkā)
  fab.style.bottom = "";
  fab.style.top = (74 + (vv ? vv.offsetTop : 0)) + "px";
 
  // Drawer paliek apakšā, paceļam virs klaviatūras
  drawer.style.bottom = (14 + keyboardH) + "px";
 
  // Toast arī top (netraucē klaviatūrai)
  toast.style.bottom = "";
  toast.style.top = (74 + (vv ? vv.offsetTop : 0)) + "px";
};
 
  apply();
 
  // IMPORTANT: lai neliekas listeneri vairākkārt
  if (fab.dataset.vvBound !== "1") {
    fab.dataset.vvBound = "1";
    if (vv) {
      vv.addEventListener("resize", apply);
      vv.addEventListener("scroll", apply);
    }
    window.addEventListener("resize", apply);
  }
} catch {}

}

function dmClose() {
  const drawer = document.getElementById("vz-dm-drawer");
  if (drawer) drawer.style.display = "none";
  dmSendTyping(false);
  dmClearContext();
}

function dmStorageKey(username) {
  const u = String(username || "").trim() || "unknown";
  return "vz_dm_store_" + u;
}
function dmSanitizeMeta(meta) {
  if (!meta || typeof meta !== "object") return null;
  const out = { ...meta };
  if (out.avatarUrl && String(out.avatarUrl).startsWith("data:image/")) {
    if (String(out.avatarUrl).length > 120000) delete out.avatarUrl;
  }
  return out;
}
function dmNormalizeMessageForStore(msg) {
  if (!msg || typeof msg !== "object") return null;
  const out = {
    id: msg.id,
    from: msg.from,
    to: msg.to,
    text: msg.text || "",
    ts: Number(msg.ts) || 0,
  };
  if (msg.reply && typeof msg.reply === "object") {
    const r = {
      id: msg.reply.id,
      from: msg.reply.from,
      text: msg.reply.text,
    };
    if (r.id && r.from && r.text) out.reply = r;
  }
  if (msg.edited) out.edited = true;
  if (msg.editedAt) out.editedAt = Number(msg.editedAt) || 0;
  if (msg.deleted) out.deleted = true;
  if (msg.deletedAt) out.deletedAt = Number(msg.deletedAt) || 0;
  const meta = dmSanitizeMeta(msg.meta);
  if (meta) out.meta = meta;
  return out;
}
function dmThreadsToObject() {
  const out = {};
  for (const [k, arr] of state.dmThreads.entries()) {
    const key = String(k || "").trim();
    if (!key) continue;
    const list = Array.isArray(arr) ? arr.slice(-DM_THREAD_MAX_LOCAL) : [];
    const stored = list.map(dmNormalizeMessageForStore).filter(Boolean);
    out[key] = stored;
  }
  return out;
}
function dmObjectToThreads(obj) {
  const map = new Map();
  for (const [k, arr] of Object.entries(obj || {})) {
    if (!Array.isArray(arr)) continue;
    map.set(k, arr.map(dmNormalizeMessageForStore).filter(Boolean));
  }
  return map;
}
let _dmPersistTimer = null;
function dmPersistNow() {
  if (!state.username || state.dmStorageMode !== "client") return;
  try {
    const payload = {
      v: DM_LOCAL_STORAGE_VERSION,
      threads: dmThreadsToObject(),
      unread: state.dmUnreadByUser || {},
      peerRead: state.dmPeerRead || {},
      lastFrom: state.dmLastFrom || null,
      ts: Date.now(),
    };
    localStorage.setItem(dmStorageKey(state.username), JSON.stringify(payload));
  } catch {}
}
function dmSchedulePersist() {
  if (state.dmStorageMode !== "client") return;
  if (_dmPersistTimer) return;
  _dmPersistTimer = setTimeout(() => {
    _dmPersistTimer = null;
    dmPersistNow();
  }, DM_STORAGE_PERSIST_MS);
}
function dmLoadLocalState() {
  if (!state.username) return;
  try {
    const raw = localStorage.getItem(dmStorageKey(state.username));
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return;
    state.dmThreads = dmObjectToThreads(data.threads || {});
    state.dmUnreadByUser = data.unread && typeof data.unread === "object" ? data.unread : {};
    state.dmPeerRead = data.peerRead && typeof data.peerRead === "object" ? data.peerRead : {};
    state.dmLastFrom = data.lastFrom || null;
    let total = 0;
    for (const v of Object.values(state.dmUnreadByUser)) total += Math.max(0, Number(v) || 0);
    state.dmUnreadTotal = total;
    state.dmInboxPreview = [];
    dmSetBadge(total, state.dmUnreadByUser);
  } catch {}
}
function dmIncrementUnread(withUser) {
  const u = String(withUser || "").trim();
  if (!u) return;
  const by = state.dmUnreadByUser && typeof state.dmUnreadByUser === "object"
    ? { ...state.dmUnreadByUser }
    : {};
  const prev = Math.max(0, Number(by[u]) || 0);
  by[u] = prev + 1;
  let total = 0;
  for (const v of Object.values(by)) total += Math.max(0, Number(v) || 0);
  dmSetBadge(total, by);
}
 
function dmSetBadge(total, byUser) {
  state.dmUnreadTotal = Math.max(0, Number(total) || 0);
  state.dmUnreadByUser = byUser && typeof byUser === "object" ? byUser : {};
 
  const badge = document.getElementById("vz-dm-badge");
  if (!badge) return;
 
  if (state.dmUnreadTotal > 0) {
    badge.style.display = "flex";
    badge.textContent = String(Math.min(99, state.dmUnreadTotal));
  } else {
    badge.style.display = "none";
    badge.textContent = "";
  }
  dmSchedulePersist();
}
function dmMarkReadLocal(withUser) {
  const u = String(withUser || "").trim();
  if (!u) return;
 
  const by =
    state.dmUnreadByUser && typeof state.dmUnreadByUser === "object"
      ? { ...state.dmUnreadByUser }
      : {};
 
  for (const k of Object.keys(by)) {
    if (String(k).toLowerCase() === u.toLowerCase()) by[k] = 0;
  }
  by[u] = 0;
 
  let total = 0;
  for (const v of Object.values(by)) total += Math.max(0, Number(v) || 0);
 
  dmSetBadge(total, by);
  dmSchedulePersist();
} 
let _dmToastTimer = null;
function dmToast(text, fromUser) {
  if (state.dmNotifyOn === false) return;   // <- ŠO IELIEC
  const toast = document.getElementById("vz-dm-toast");
  if (!toast) return;
 
  toast.textContent = String(text || "");
  toast.dataset.from = fromUser ? String(fromUser) : "";
  toast.style.display = "block";
 
  if (_dmToastTimer) clearTimeout(_dmToastTimer);
  _dmToastTimer = setTimeout(() => {
    toast.style.display = "none";
  }, 3200);
}
 
function dmUpdateContextBar() {
  const bar = document.getElementById("vz-dm-context");
  const text = document.getElementById("vz-dm-context-text");
  if (!bar || !text) return;

  if (state.dmEdit) {
    const preview = String(state.dmEdit.text || "").slice(0, 80);
    text.textContent = `Rediģē: ${preview || "—"}`;
    bar.style.display = "flex";
    return;
  }

  if (state.dmReply) {
    const preview = String(state.dmReply.text || "").slice(0, 80);
    const who = String(state.dmReply.from || "");
    text.textContent = `Atbilde ${who}: ${preview || "—"}`;
    bar.style.display = "flex";
    return;
  }

  bar.style.display = "none";
  text.textContent = "";
}

function dmClearContext() {
  state.dmEdit = null;
  state.dmReply = null;
  dmUpdateContextBar();
}

function dmSetReply(msg) {
  if (!msg) return;
  state.dmEdit = null;
  state.dmReply = {
    id: String(msg.id || ""),
    from: String(msg.from || ""),
    text: msg.deleted ? "Ziņa dzēsta" : String(msg.text || ""),
  };
  dmUpdateContextBar();
}

function dmSetEdit(msg) {
  if (!msg) return;
  state.dmReply = null;
  state.dmEdit = {
    id: String(msg.id || ""),
    text: msg.deleted ? "" : String(msg.text || ""),
  };
  dmUpdateContextBar();
  const inp = document.getElementById("vz-dm-input");
  if (inp) {
    inp.value = state.dmEdit.text || "";
    try { inp.focus(); } catch {}
  }
}

function dmSendTyping(typing) {
  if (!state.socket || !state.dmOpenWith) return;
  state.socket.emit("dm.typing", { with: state.dmOpenWith, typing: !!typing });
}

function dmHandleTypingInput() {
  if (!state.socket || !state.dmOpenWith) return;
  const now = Date.now();
  if (now - dmTypingLastSent > 800) {
    dmSendTyping(true);
    dmTypingLastSent = now;
  }
  if (dmTypingStopTimer) clearTimeout(dmTypingStopTimer);
  dmTypingStopTimer = setTimeout(() => dmSendTyping(false), 1400);
}

function dmUpdateTypingIndicator() {
  const bar = document.getElementById("vz-dm-typing");
  if (!bar) return;
  const u = String(state.dmOpenWith || "").trim();
  const typing = !!(u && state.dmTypingByUser && state.dmTypingByUser[u]);
  if (!typing) {
    bar.style.display = "none";
    bar.textContent = "";
    return;
  }
  bar.textContent = `${u} raksta…`;
  bar.style.display = "block";
}

function dmSetBlockedUsers(list) {
  const arr = Array.isArray(list) ? list : [];
  state.dmBlockedUsers = arr.filter(Boolean);
  const set = new Set();
  for (const u of state.dmBlockedUsers) {
    const k = String(u || "").trim().toLowerCase();
    if (k) set.add(k);
  }
  state.dmBlockedSet = set;
  try {
    updateProfileBlockButtons();
  } catch {}
}

function dmIsBlocked(username) {
  const k = String(username || "").trim().toLowerCase();
  if (!k) return false;
  return state.dmBlockedSet && state.dmBlockedSet.has(k);
}

function dmUpdateBlockUi() {
  const u = String(state.dmOpenWith || "").trim();
  const btn = document.getElementById("vz-dm-block");
  const reportBtn = document.getElementById("vz-dm-report-user");
  const inp = document.getElementById("vz-dm-input");
  const send = document.getElementById("vz-dm-send");
  if (!btn) return;

  if (!u) {
    btn.disabled = true;
    btn.title = "Atver sarunu, lai bloķētu";
    btn.textContent = "🚫";
    if (reportBtn) {
      reportBtn.disabled = true;
      reportBtn.title = "Atver sarunu, lai ziņotu";
    }
    if (inp) inp.disabled = true;
    if (send) send.disabled = true;
    return;
  }

  const blocked = dmIsBlocked(u);
  btn.disabled = false;
  btn.textContent = blocked ? "🔓" : "🚫";
  btn.title = blocked ? "Atbloķēt lietotāju" : "Bloķēt lietotāju";
  if (reportBtn) {
    reportBtn.disabled = false;
    reportBtn.title = "Ziņot par lietotāju";
  }

  if (inp && send) {
    inp.disabled = blocked;
    send.disabled = blocked;
    inp.placeholder = blocked
      ? "Tu esi nobloķējis šo lietotāju"
      : "Raksti ziņu…";
  }
}

function dmReportUserWith(username) {
  const u = String(username || "").trim();
  if (!u || !state.socket) return;
  const reason = window.prompt("Kāpēc ziņo? (neobligāti)") || "";
  state.socket.emit("dm.report", { with: u, reason });
}

function dmReportUser() {
  dmReportUserWith(state.dmOpenWith);
}

function dmReportMessage(msg) {
  if (!msg || !state.socket) return;
  const u = String(state.dmOpenWith || msg.from || "").trim();
  if (!u || u === state.username) return;
  const reason = window.prompt("Kāpēc ziņo par šo ziņu? (neobligāti)") || "";
  state.socket.emit("dm.report", {
    with: u,
    id: msg.id,
    text: msg.text,
    reason,
  });
}

function dmGetThread(withUser) {
  const key = String(withUser || "").trim();
  if (!key) return [];
  if (!state.dmThreads.has(key)) state.dmThreads.set(key, []);
  return state.dmThreads.get(key);
}
 
function dmRenderThread(withUser) {
  const box = document.getElementById("vz-dm-messages");
  if (!box) return;
 
  box.innerHTML = "";
 
  // Sticky “atpakaļ” josla
  const topBar = document.createElement("div");
  topBar.style.position = "sticky";
  topBar.style.top = "0";
  topBar.style.zIndex = "5";
  topBar.style.padding = "0 0 8px 0";
  topBar.style.background = "rgba(20,20,24,0.96)";
  topBar.style.backdropFilter = "blur(8px)";
 
  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.textContent = "← Inbox";
  backBtn.style.padding = "8px 10px";
  backBtn.style.borderRadius = "10px";
  backBtn.style.border = "1px solid rgba(255,255,255,0.12)";
  backBtn.style.background = "rgba(255,255,255,0.06)";
  backBtn.style.color = "#fff";
  backBtn.style.fontWeight = "800";
  backBtn.addEventListener("click", () => dmShowInbox());
 
  topBar.appendChild(backBtn);
  box.appendChild(topBar);
 
  const thread = dmGetThread(withUser);
  const peerReadTs = Math.max(0, Number(state.dmPeerRead?.[withUser]) || 0);
  const lastMy = [...thread].reverse().find((m) => m && m.from === state.username && !m.deleted);
  const lastMyId = lastMy ? String(lastMy.id || "") : "";
  const blocked = dmIsBlocked(withUser);
 
  thread.forEach((m) => {
    if (!m) return;
    const isMe = m.from === state.username;

    const row = document.createElement("div");
    row.className = "dm-row " + (isMe ? "dm-row-me" : "dm-row-other");

    // Avatārs tikai otrai pusei (lai nav spam)
    if (!isMe) {
      const avatarWrap = document.createElement("div");
      avatarWrap.className = "dm-avatar";

      const img = document.createElement("img");
      img.className = "dm-avatar-img";
      img.style.display = "none";

      const init = document.createElement("div");
      init.className = "dm-avatar-init";

      avatarWrap.appendChild(img);
      avatarWrap.appendChild(init);

      applyMiniAvatar(m.from, img, init);
      row.appendChild(avatarWrap);
    }

    const col = document.createElement("div");
    col.className = "dm-col " + (isMe ? "dm-col-me" : "dm-col-other");

    const bubble = document.createElement("div");
    bubble.className = "dm-bubble " + (isMe ? "dm-bubble-me" : "dm-bubble-other");
    if (m.deleted) bubble.classList.add("dm-bubble-deleted");

    if (m.reply && m.reply.text) {
      const reply = document.createElement("div");
      reply.className = "dm-reply-preview";
      const rFrom = String(m.reply.from || "");
      const rText = String(m.reply.text || "");
      reply.textContent = `↩ ${rFrom}: ${rText}`;
      bubble.appendChild(reply);
    }

    const text = document.createElement("div");
    text.className = "dm-text";
    text.textContent = m.deleted ? "Ziņa dzēsta" : String(m.text || "");
    bubble.appendChild(text);

    const actions = document.createElement("div");
    actions.className = "dm-actions";

    if (!blocked) {
      const replyBtn = document.createElement("button");
      replyBtn.type = "button";
      replyBtn.className = "dm-action-btn";
      replyBtn.textContent = "↩️";
      replyBtn.title = "Atbildēt";
      replyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        dmSetReply(m);
      });
      actions.appendChild(replyBtn);
    }

    if (!isMe && !m.deleted) {
      const reportBtn = document.createElement("button");
      reportBtn.type = "button";
      reportBtn.className = "dm-action-btn";
      reportBtn.textContent = "⚠️";
      reportBtn.title = "Ziņot par ziņu";
      reportBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        dmReportMessage(m);
      });
      actions.appendChild(reportBtn);
    }

    if (isMe && !m.deleted) {
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "dm-action-btn";
      editBtn.textContent = "✏️";
      editBtn.title = "Rediģēt";
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        dmSetEdit(m);
      });
      actions.appendChild(editBtn);

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "dm-action-btn";
      delBtn.textContent = "🗑️";
      delBtn.title = "Dzēst sev";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!state.socket || !state.dmOpenWith) return;
        state.socket.emit("dm.delete", { with: state.dmOpenWith, id: m.id });
      });
      actions.appendChild(delBtn);
    }

    const meta = document.createElement("div");
    meta.className = "dm-meta";
    const t = new Date(Number(m.ts) || Date.now()).toLocaleTimeString("lv-LV", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Riga",
    });

    const nameSpan = document.createElement("span");
    nameSpan.className = "dm-name";
    nameSpan.textContent = isMe ? "Tu" : String(m.from || "");
    if (!isMe && m.meta) {
      if (typeof m.meta.rankLevel === "number") applyNameTierClass(nameSpan, m.meta.rankLevel);
      if (m.meta.rankColor) applyRankColor(nameSpan, m.meta.rankColor);
    }
    meta.appendChild(nameSpan);

    if (!isMe && typeof m.meta?.rankLevel === "number") {
      const rankBadge = document.createElement("span");
      rankBadge.className = "dm-rank-badge";
      rankBadge.textContent = `L${m.meta.rankLevel}`;
      meta.appendChild(rankBadge);
    }

    if (!isMe && m.meta?.region) {
      const badge = buildRegionBadge(m.meta.region, "vz-region-badge-chat");
      if (badge) meta.appendChild(badge);
    }

    const timeSpan = document.createElement("span");
    timeSpan.className = "dm-time";
    timeSpan.textContent = t;
    meta.appendChild(timeSpan);

    if (m.edited) {
      const edited = document.createElement("span");
      edited.className = "dm-edited";
      edited.textContent = "rediģēta";
      meta.appendChild(edited);
    }

    if (isMe && lastMyId && String(m.id || "") === lastMyId && peerReadTs >= (Number(m.ts) || 0)) {
      const seen = document.createElement("span");
      seen.className = "dm-seen";
      const seenStr = new Date(peerReadTs).toLocaleTimeString("lv-LV", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Europe/Riga",
      });
      seen.textContent = `lasīts ${seenStr}`;
      meta.appendChild(seen);
    }

    col.appendChild(bubble);
    col.appendChild(actions);
    col.appendChild(meta);

    row.appendChild(col);
    box.appendChild(row);
  });
 
  box.scrollTop = box.scrollHeight;
  dmUpdateTypingIndicator();
}

 function dmRenderInbox() {
  const box = document.getElementById("vz-dm-messages");
  const inputRow = document.getElementById("vz-dm-input-row");
  const title = document.getElementById("vz-dm-title");
  const contextBar = document.getElementById("vz-dm-context");
  const typingBar = document.getElementById("vz-dm-typing");
  if (!box) return;
 
  if (title) title.textContent = "Privātais čats";
  if (inputRow) inputRow.style.display = "none";
  if (contextBar) contextBar.style.display = "none";
  if (typingBar) typingBar.style.display = "none";
 
  box.innerHTML = "";
 
  const normName = (v) => String(v || "").trim();
  const keyOf = (name) => normName(name).toLowerCase();
 
  // dedupe/merge case-insensitive
  const byKey = new Map(); // lower -> { name, unread, lastTs, lastText }
 
  const upsert = (name, unread, lastTs, lastText) => {
    const n = normName(name);
    if (!n || n === "SYSTEM" || n === state.username) return;
 
    const k = keyOf(n);
    const u = Math.max(0, Number(unread) || 0);
    const ts = Math.max(0, Number(lastTs) || 0);
    const txt = String(lastText || "").slice(0, 60);
 
    const prev = byKey.get(k);
    if (!prev) {
      byKey.set(k, { name: n, unread: u, lastTs: ts, lastText: txt });
      return;
    }
 
    // prefer a "nice" casing (from preview / existing thread key)
    const bestName = prev.name && prev.name.length >= n.length ? prev.name : n;
 
    // merge unread (keep the max; server + local may differ briefly)
    const bestUnread = Math.max(prev.unread || 0, u);
 
    // keep newest lastTs/lastText
    if (ts > (prev.lastTs || 0)) {
      byKey.set(k, { name: bestName, unread: bestUnread, lastTs: ts, lastText: txt });
    } else {
      byKey.set(k, { name: bestName, unread: bestUnread, lastTs: prev.lastTs || 0, lastText: prev.lastText || "" });
    }
  };
 
  // 1) servera inbox preview (pēc refresh uzreiz ir saraksts)
  if (Array.isArray(state.dmInboxPreview)) {
    for (const t of state.dmInboxPreview) {
      if (!t) continue;
      upsert(t.with, t.unread, t.lastTs, t.lastText);
    }
  }
 
  // 2) fallback + merge: lokālie threadi/unread (ja preview nav vai nav pilns)
  const users = new Set([
    ...Object.keys(state.dmUnreadByUser || {}),
    ...Array.from(state.dmThreads.keys()),
  ]);
 
  for (const u of users) {
    const name = normName(u);
    if (!name || name === "SYSTEM" || name === state.username) continue;
 
    const unread = Math.max(0, Number(state.dmUnreadByUser?.[u]) || 0);
    const thread = state.dmThreads.get(name) || [];
    const last = thread.length ? thread[thread.length - 1] : null;
    const lastTs = last ? Number(last.ts) || 0 : 0;
    const lastText = last ? String(last.text || "") : "";
 
    upsert(name, unread, lastTs, lastText);
  }
 
  const items = Array.from(byKey.values());
  items.sort(
    (a, b) =>
      (b.unread - a.unread) ||
      (b.lastTs - a.lastTs) ||
      a.name.localeCompare(b.name)
  );
 
  if (!items.length) {
    const empty = document.createElement("div");
    empty.style.opacity = "0.8";
    empty.textContent = "Inbox tukšs. Atver profilu un spied “Rakstīt privāti”.";
    box.appendChild(empty);
    return;
  }
 
 items.forEach((it, idx) => {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "dm-inbox-row";
  row.style.display = "flex";
  row.style.alignItems = "center";
  row.style.justifyContent = "space-between";
  row.style.gap = "10px";
  row.style.width = "100%";
  row.style.textAlign = "left";
  row.style.padding = "10px 10px";
  row.style.borderRadius = "12px";
  row.style.border = "1px solid rgba(255,255,255,0.10)";
  row.style.background = "rgba(255,255,255,0.06)";
  row.style.color = "#fff";
  row.style.cursor = "pointer";
  if (it.unread > 0) row.classList.add("dm-inbox-row-unread");
  if (idx === 0) row.classList.add("dm-inbox-row-latest");
 
  // Left side: avatar + texts
  const leftWrap = document.createElement("div");
  leftWrap.style.display = "flex";
  leftWrap.style.alignItems = "center";
  leftWrap.style.gap = "10px";
  leftWrap.style.minWidth = "0";
 
  const avatarWrap = document.createElement("div");
  avatarWrap.style.width = "34px";
  avatarWrap.style.height = "34px";
  avatarWrap.style.borderRadius = "12px";
  avatarWrap.style.overflow = "hidden";
  avatarWrap.style.flex = "0 0 34px";
  avatarWrap.style.border = "1px solid rgba(255,255,255,0.10)";
  avatarWrap.style.background = "rgba(255,255,255,0.06)";
 
  const img = document.createElement("img");
  img.style.width = "100%";
  img.style.height = "100%";
  img.style.objectFit = "cover";
  img.style.display = "none";
 
  const init = document.createElement("div");
  init.style.width = "100%";
  init.style.height = "100%";
  init.style.display = "flex";
  init.style.alignItems = "center";
  init.style.justifyContent = "center";
  init.style.fontWeight = "900";
  init.style.color = "#fff";
  init.style.background = "rgba(255,255,255,0.06)";
 
  avatarWrap.appendChild(img);
  avatarWrap.appendChild(init);
 
  applyMiniAvatar(it.name, img, init);
 
  const textCol = document.createElement("div");
  textCol.style.display = "flex";
  textCol.style.flexDirection = "column";
  textCol.style.gap = "2px";
  textCol.style.minWidth = "0";
 
  const nameEl = document.createElement("div");
  nameEl.style.fontWeight = "900";
  nameEl.textContent = it.name;
 
  const sub = document.createElement("div");
  sub.style.fontSize = "12px";
  sub.style.opacity = "0.75";
  sub.style.whiteSpace = "nowrap";
  sub.style.overflow = "hidden";
  sub.style.textOverflow = "ellipsis";
  sub.textContent = it.lastText ? String(it.lastText).slice(0, 60) : "—";
  if (it.unread > 0) sub.classList.add("dm-inbox-sub-unread");
 
  textCol.appendChild(nameEl);
  textCol.appendChild(sub);
 
  leftWrap.appendChild(avatarWrap);
  leftWrap.appendChild(textCol);
 
  // Right side: unread badge
  const right = document.createElement("div");
  right.style.display = "flex";
  right.style.alignItems = "center";
  right.style.gap = "8px";
 
  if (it.unread > 0) {
    const b = document.createElement("div");
    b.style.minWidth = "22px";
    b.style.height = "22px";
    b.style.padding = "0 7px";
    b.style.display = "flex";
    b.style.alignItems = "center";
    b.style.justifyContent = "center";
    b.style.borderRadius = "999px";
    b.style.background = "#ef4444";
    b.style.color = "#fff";
    b.style.fontWeight = "900";
    b.style.fontSize = "12px";
    b.textContent = String(Math.min(99, it.unread));
    right.appendChild(b);
  }
 
  row.appendChild(leftWrap);
  row.appendChild(right);
 
  row.addEventListener("click", () => openDmWith(it.name));
  box.appendChild(row);
});
}
 
 
function dmShowInbox() {
  ensureDmUi();
  const drawer = document.getElementById("vz-dm-drawer");
  if (drawer) drawer.style.display = "flex";
  state.dmOpenWith = null;
  dmSendTyping(false);
  dmClearContext();
  dmUpdateTypingIndicator();
  dmUpdateBlockUi();
  dmRenderInbox();
}
function openDmWith(username) {
  const u = String(username || "").trim();
  if (!u || u === "SYSTEM") return;
  if (!state.socket) {
    appendSystemMessage("Privātais čats nav pieejams (nav socket).");
    return;
  }
  if (u === state.username) {
    dmToast("Nevari rakstīt sev.");
    return;
  }
 
 ensureDmUi();
 
  state.dmOpenWith = u;
  dmClearContext();
 
  const drawer = document.getElementById("vz-dm-drawer");
  const title = document.getElementById("vz-dm-title");
  if (title) title.textContent = "Privātais čats ar " + u;
  if (drawer) drawer.style.display = "flex";
 
  // ielādējam history + uzreiz notīram unread šai sarunai
  if (state.dmStorageMode !== "client") {
    state.socket.emit("dm.history", { with: u });
  }
  state.socket.emit("dm.read", { with: u });
  dmMarkReadLocal(u);
 const inputRow = document.getElementById("vz-dm-input-row");
if (inputRow) inputRow.style.display = "flex";

dmRenderThread(u);
dmUpdateBlockUi();
 
  const inp = document.getElementById("vz-dm-input");
  if (inp) {
    try { inp.focus(); } catch {}
  }
}
 
function dmUpsertMessages(withUser, messages) {
  const u = String(withUser || "").trim();
  if (!u) return;
 
  const thread = dmGetThread(u);
  const byId = new Map(thread.map((m, idx) => [String(m?.id || ""), idx]));
 
  (messages || []).forEach((m) => {
    const id = String(m && m.id ? m.id : "");
    if (id && byId.has(id)) {
      const idx = byId.get(id);
      thread[idx] = { ...thread[idx], ...m };
      return;
    }
    thread.push(m);
  });
 
  while (thread.length > DM_THREAD_MAX_LOCAL) thread.shift();
  dmSchedulePersist();
}
 
function dmSendCurrent() {
  const u = String(state.dmOpenWith || "").trim();
  if (!u || !state.socket) return;
  if (dmIsBlocked(u)) {
    dmToast("Tu esi nobloķējis šo lietotāju.");
    return;
  }
 
  const inp = document.getElementById("vz-dm-input");
  const text = inp ? String(inp.value || "").trim() : "";
  if (!text) return;
 
  if (state.dmEdit && state.dmEdit.id) {
    state.socket.emit("dm.edit", { with: u, id: state.dmEdit.id, text });
    dmClearContext();
  } else {
    const reply = state.dmReply
      ? { id: state.dmReply.id, from: state.dmReply.from, text: state.dmReply.text }
      : null;
    state.socket.emit("dm.send", { to: u, text, reply });
    dmClearContext();
  }
  if (inp) inp.value = "";
  dmSendTyping(false);
}
// ==================== WIN TICKER ====================
function updateWinTicker(info) {
  if (!winTickerEl) return;

  const username = info && info.username ? String(info.username) : "Kāds";
  const xpGain = Number(info && info.xpGain) || 0;
  const coinsGain = Number(info && info.coinsGain) || 0;
  const streak = Number(info && info.streak) || 0;
  const rankTitle = info && info.rankTitle ? String(info.rankTitle) : "";

  const txt =
    `🔥 ${username} atminēja vārdu! +${xpGain} XP, +${coinsGain} coins (streak: ${streak})` +
    (rankTitle ? ` — ${rankTitle}` : "");

  winTickerEl.textContent = txt;

  winTickerEl.classList.remove("vz-win-active");
  void winTickerEl.offsetWidth;
  winTickerEl.classList.add("vz-win-active");

  clearTimeout(updateWinTicker._t);
  updateWinTicker._t = setTimeout(() => {
    winTickerEl.classList.remove("vz-win-active");
  }, 2600);
}

// ==================== SEZONA ====================
function formatSeasonCountdown(diffMs) {
  if (diffMs <= 0) return "Sezona beigusies";

  const totalSec = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSec / (24 * 3600));
  const hours = Math.floor((totalSec % (24 * 3600)) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;

  const pad = (n) => (n < 10 ? "0" + n : "" + n);
  return `${days}d ${pad(hours)}:${pad(mins)}:${pad(secs)}`;
}

function updateSeasonCountdown() {
  if (!state.season || !seasonCountdownEl) return;

  const endTs = state.season.endAt || 0;
  if (!endTs) {
    seasonCountdownEl.textContent = "Beigu datums nav iestatīts";
    return;
  }

  const diff = endTs - Date.now();
  if (diff <= 0) {
    seasonCountdownEl.textContent = "Sezona beigusies";
    return;
  }

  seasonCountdownEl.textContent = formatSeasonCountdown(diff);
}

function applySeasonState(season) {
  state.season = season || null;
  if (!seasonBoxEl) return;

  if (!state.season) {
    seasonBoxEl.classList.add("hidden");
    return;
  }

  seasonBoxEl.classList.remove("hidden");

  if (seasonTitleEl) seasonTitleEl.textContent = state.season.name || "SEZONA";

  updateSeasonCountdown();

  if (seasonTimerId) {
    clearInterval(seasonTimerId);
    seasonTimerId = null;
  }
  if (state.season && state.season.endAt) {
    seasonTimerId = setInterval(updateSeasonCountdown, 1000);
  }

  if (seasonStartBtn) {
    const isAdmin = isAdminUsername(state.username);
    if (isAdmin && !state.season.active) {
      seasonStartBtn.style.display = "inline-block";
      seasonStartBtn.disabled = false;
    } else {
      seasonStartBtn.style.display = "none";
    }
  }
}

async function refreshSeasonHttp() {
  if (!state.token) return;
  try {
    const season = await apiGet("/season");
    applySeasonState(season);
  } catch (err) {
    console.error("Sezonas /season kļūda:", err);
  }
}
// ==================== DUEL COUNTDOWN UI ====================
let duelCountdownId = null;
 
function ensureDuelCountdownUI() {
  let wrap = document.getElementById("vz-duel-countdown");
  if (wrap) return wrap;
 
  wrap = document.createElement("div");
  wrap.id = "vz-duel-countdown";
  wrap.style.position = "fixed";
  wrap.style.inset = "0";
  wrap.style.display = "none";
  wrap.style.alignItems = "center";
  wrap.style.justifyContent = "center";
  wrap.style.zIndex = "999999";
  wrap.style.pointerEvents = "none";
  wrap.style.background = "rgba(0,0,0,0.35)";
  wrap.style.backdropFilter = "blur(2px)";
 
  const text = document.createElement("div");
  text.id = "vz-duel-countdown-text";
  text.style.fontSize = "64px";
  text.style.fontWeight = "1000";
  text.style.letterSpacing = "2px";
  text.style.color = "#fff";
  text.style.textShadow = "0 10px 40px rgba(0,0,0,0.55)";
  text.style.transform = "translateY(-10px)";
  text.style.opacity = "0";
  text.style.transition = "opacity 120ms ease, transform 120ms ease";
 
  wrap.appendChild(text);
  document.body.appendChild(wrap);
  return wrap;
}
 
function hideDuelStartCountdown() {
  const wrap = document.getElementById("vz-duel-countdown");
  if (wrap) wrap.style.display = "none";
  if (duelCountdownId) {
    clearInterval(duelCountdownId);
    duelCountdownId = null;
  }
}
 
function showDuelStartCountdown(playStartsAt, serverNow, countdownMs) {
  const wrap = ensureDuelCountdownUI();
  const textEl = document.getElementById("vz-duel-countdown-text");
  if (!wrap || !textEl) return;
 
  hideDuelStartCountdown();
 
  const sn = Number(serverNow);
  if (Number.isFinite(sn)) duelServerOffsetMs = sn - Date.now();
 
  const startsAt = Number(playStartsAt) || 0;
  if (!startsAt) return;
 
  const cdMs = Number(countdownMs) > 0 ? Number(countdownMs) : 5000;
 
  const tick = () => {
    const nowSrv = Date.now() + (duelServerOffsetMs || 0);
    const msLeft = startsAt - nowSrv;
 
    // ja countdown jau beidzies
    if (msLeft <= 0) {
      textEl.textContent = "AIZIET!";
      wrap.style.display = "flex";
      requestAnimationFrame(() => {
        textEl.style.opacity = "1";
        textEl.style.transform = "translateY(0)";
      });
      setTimeout(() => hideDuelStartCountdown(), 650);
      return true; // stop interval
    }
 
    // rādam tikai countdown logā (pēdējās cdMs milisekundēs)
    if (msLeft > cdMs) {
      wrap.style.display = "none";
      return false;
    }
 
    const sec = Math.max(1, Math.ceil(msLeft / 1000));
    textEl.textContent = String(sec);
 
    wrap.style.display = "flex";
    textEl.style.opacity = "0";
    textEl.style.transform = "translateY(-8px)";
    requestAnimationFrame(() => {
      textEl.style.opacity = "1";
      textEl.style.transform = "translateY(0)";
    });
 
    return false;
  };
 
  if (tick()) return;
  duelCountdownId = setInterval(() => {
    if (tick()) {
      clearInterval(duelCountdownId);
      duelCountdownId = null;
    }
  }, 120);
}
// ==================== SOCKET ====================
let duelTimerId = null;
let duelEndsAt = 0;
let duelServerOffsetMs = 0; // NEW: servera laika nobīde
function ensureDuelTimerUI() {
  if (document.getElementById("vz-duel-timer")) return;
  if (!gridEl) return;
 
  const el = document.createElement("div");
  el.id = "vz-duel-timer";
  el.style.display = "none";
  el.style.margin = "8px 0";
  el.style.padding = "10px 12px";
  el.style.borderRadius = "12px";
  el.style.background = "rgba(0,0,0,0.25)";
  el.style.border = "1px solid rgba(255,255,255,0.12)";
  el.style.color = "#fff";
  el.style.fontWeight = "800";
  el.style.textAlign = "center";
  el.style.letterSpacing = "0.5px";
 
  gridEl.insertAdjacentElement("beforebegin", el);
}
 
function startDuelTimer(expiresAt, serverNow) {
  ensureDuelTimerUI();
  const el = document.getElementById("vz-duel-timer");
  if (!el) return;
 
  const exp = Number(expiresAt) || 0;
  if (!exp) return;
 
  // NEW: sinhronizējam laiku pēc servera
  if (Number.isFinite(serverNow)) {
    duelServerOffsetMs = Number(serverNow) - Date.now();
  }
 
  duelEndsAt = exp;
  el.style.display = "block";
 
  if (duelTimerId) clearInterval(duelTimerId);
  duelTimerId = setInterval(() => {
    const now = Date.now() + (duelServerOffsetMs || 0);
    const msLeft = duelEndsAt - now;
 
    const s = Math.max(0, Math.floor(msLeft / 1000));
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    el.textContent = `⏱️ ${mm}:${ss}`;
 
    if (msLeft <= 0) {
      clearInterval(duelTimerId);
      duelTimerId = null;
      el.textContent = "⏱️ 00:00";
    }
  }, 250);
}
 
function stopDuelTimer() {
  const el = document.getElementById("vz-duel-timer");
  if (el) el.style.display = "none";
  if (duelTimerId) clearInterval(duelTimerId);
  duelTimerId = null;
  duelEndsAt = 0;
  duelServerOffsetMs = 0; // NEW
}
let duelInviteTimer = null;
let pendingDuelInvite = null; // { duelId, from, len }
 
function ensureDuelInviteUI() {
  if (document.getElementById("vz-duel-invite")) return;
 
  const box = document.createElement("div");
  box.id = "vz-duel-invite";
  box.style.position = "fixed";
  box.style.right = "14px";
  box.style.bottom = "14px";
  box.style.zIndex = "99999";
  box.style.background = "rgba(20,20,24,0.92)";
  box.style.border = "1px solid rgba(255,255,255,0.12)";
  box.style.borderRadius = "12px";
  box.style.padding = "12px";
  box.style.minWidth = "260px";
  box.style.maxWidth = "320px";
  box.style.color = "#fff";
  box.style.display = "none";
  box.style.boxShadow = "0 10px 30px rgba(0,0,0,0.35)";
 
  const title = document.createElement("div");
  title.style.fontWeight = "700";
  title.style.marginBottom = "6px";
  title.textContent = "⚔️ Duelis";
  box.appendChild(title);
 
  const text = document.createElement("div");
  text.id = "vz-duel-invite-text";
  text.style.fontSize = "14px";
  text.style.opacity = "0.95";
  text.style.marginBottom = "10px";
  box.appendChild(text);
 
  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.gap = "8px";
 
  const btnNo = document.createElement("button");
  btnNo.type = "button";
  btnNo.textContent = "Noraidīt";
  btnNo.style.flex = "1";
  btnNo.style.padding = "10px";
  btnNo.style.borderRadius = "10px";
  btnNo.style.border = "1px solid rgba(255,255,255,0.16)";
  btnNo.style.background = "rgba(255,255,255,0.06)";
  btnNo.style.color = "#fff";
  btnNo.addEventListener("click", () => declineDuelInvite(false));
 
  const btnYes = document.createElement("button");
  btnYes.type = "button";
  btnYes.textContent = "Pieņemt";
  btnYes.style.flex = "1";
  btnYes.style.padding = "10px";
  btnYes.style.borderRadius = "10px";
  btnYes.style.border = "1px solid rgba(255,255,255,0.16)";
  btnYes.style.background = "rgba(60,180,120,0.35)";
  btnYes.style.color = "#fff";
  btnYes.addEventListener("click", () => acceptDuelInvite());
 
  row.appendChild(btnNo);
  row.appendChild(btnYes);
  box.appendChild(row);
 
  document.body.appendChild(box);
}
 
function showDuelInvite(payload) {
  const duelId = payload?.duelId;
  if (!duelId) return;
 
  pendingDuelInvite = {
    duelId,
    from: payload?.from || "kāds spēlētājs",
    len: payload?.len || 5,
  };
 
  const box = document.getElementById("vz-duel-invite");
  const text = document.getElementById("vz-duel-invite-text");
  if (!box || !text) return;
 
  text.textContent = `${pendingDuelInvite.from} tevi izaicina (${pendingDuelInvite.len} burti).`;
  box.style.display = "block";
 
  if (duelInviteTimer) clearTimeout(duelInviteTimer);
  duelInviteTimer = setTimeout(() => declineDuelInvite(true), 12000);
}
 
function hideDuelInviteUI() {
  const box = document.getElementById("vz-duel-invite");
  if (box) box.style.display = "none";
  if (duelInviteTimer) clearTimeout(duelInviteTimer);
  duelInviteTimer = null;
  pendingDuelInvite = null;
}
 
function declineDuelInvite(isAuto) {
  const duelId = pendingDuelInvite?.duelId;
  if (duelId && state.socket) state.socket.emit("duel.decline", { duelId });
  if (!isAuto) appendSystemMessage("⚔️ Duelis noraidīts.");
  hideDuelInviteUI();
}
 
function acceptDuelInvite() {
  const duelId = pendingDuelInvite?.duelId;
  if (duelId && state.socket) state.socket.emit("duel.accept", { duelId });
  hideDuelInviteUI();
}

let _socketEverConnected = false;

function initSocket() {
  if (!state.token) return;
  if (typeof io === "undefined") {
    console.error("Socket.IO klients nav ielādēts");
    return;
  }

  if (state.socket) {
    try {
      state.socket.disconnect();
    } catch {}
    state.socket = null;
  }

  const socket = io(API_BASE, {
    auth: { token: state.token },
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelayMax: 5000,
  });

  state.socket = socket;
socket.on("duel.invite", (payload) => {
  const duelId = payload?.duelId;
  if (!duelId) return;
 
  // ja jau duelī, vai notiek animācija/lock, vai tu šobrīd raksti minējumu -> noraidām, lai netraucē
  const inActiveRound = !state.roundFinished && state.currentRow < state.rows;
  const isTypingNow = state.currentCol > 0;
 
  if (state.duelMode || state.isLocked || (inActiveRound && isTypingNow)) {
    socket.emit("duel.decline", { duelId });
    return;
  }
 
  ensureDuelInviteUI();
  showDuelInvite(payload);
});
  socket.on("connect", () => {
    if (_socketEverConnected) appendSystemMessage("Savienojums atjaunots.");
    else appendSystemMessage("Pieslēgts VĀRDU ZONAS serverim.");
    _socketEverConnected = true;
  });

  socket.on("connect_error", (err) => {
    console.error("Socket connect_error:", err && (err.message || err));
    appendSystemMessage("Neizdevās pieslēgties čatam.");
  });

  socket.on("disconnect", (reason) => {
    if (reason === "io client disconnect") return;
    appendSystemMessage("Atvienots no servera.");
  });

  socket.on("chatHistory", (payload) => {
    const arr = Array.isArray(payload)
      ? payload
      : payload && Array.isArray(payload.messages)
      ? payload.messages
      : [];
    if (!arr.length) return;

    const slice = arr.slice(-120);
    appendChatMessagesBulk(slice, { isHistory: true });
    clearUnreadIfNeeded();
  });
socket.on("chatMessage", (payload) => {
  // serveris parasti sūta objektu {username,text,ts,...}
  if (typeof payload === "string") {
    appendChatMessage({ username: "SYSTEM", text: payload, ts: Date.now() });
  } else if (payload && typeof payload === "object") {
    appendChatMessage(payload);
  }
  clearUnreadIfNeeded();
});
 socket.on("dm.unread", (payload) => {
  ensureDmUi();
  if (payload?.mode) state.dmStorageMode = payload.mode;
  if (state.dmStorageMode === "client") {
    dmSetBadge(state.dmUnreadTotal, state.dmUnreadByUser);
    state.dmInboxPreview = [];
    return;
  }
 
  const total = payload?.total ?? payload?.count ?? 0;
  const byUser = payload?.byUser || {};
  dmSetBadge(total, byUser);
 
  // NEW: servera inbox preview (lai pēc refresh ir saraksts)
  const threads = Array.isArray(payload?.threads) ? payload.threads : [];
  state.dmInboxPreview = threads;
 
  // izvēlamies “pēdējo” sarunu (prioritāte: unread, pēc tam lastTs)
  if (!state.dmLastFrom) {
    let best = null;
    for (const t of threads) {
      if (!t || !t.with) continue;
      const cand = {
        with: String(t.with || "").trim(),
        unread: Math.max(0, Number(t.unread) || 0),
        lastTs: Math.max(0, Number(t.lastTs) || 0),
      };
      if (!cand.with) continue;
 
      if (
        !best ||
        cand.unread > best.unread ||
        (cand.unread === best.unread && cand.lastTs > best.lastTs)
      ) {
        best = cand;
      }
    }
 
    if (best && best.with) state.dmLastFrom = best.with;
    else {
      // fallback uz veco byUser loģiku
      let bestU = "";
      let bestC = 0;
      for (const [k, v] of Object.entries(byUser)) {
        const c = Math.max(0, Number(v) || 0);
        if (c > bestC) {
          bestC = c;
          bestU = String(k || "").trim();
        }
      }
      if (bestU) state.dmLastFrom = bestU;
    }
  }
});

  socket.on("dm.blocked", (payload) => {
    const list = Array.isArray(payload?.list) ? payload.list : [];
    dmSetBlockedUsers(list);
    if (state.dmOpenWith) dmUpdateBlockUi();
  });

  socket.on("friends.update", (payload) => {
    applyFriendsPayload(payload);
  });
 
  socket.on("dm.history", (payload) => {
    const withUser = String(payload?.with || "").trim();
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    if (!withUser) return;

    const mode = payload?.mode || state.dmStorageMode;
    if (mode === "client") {
      if (state.dmOpenWith === withUser) dmRenderThread(withUser);
      return;
    }
 
    if (payload && Object.prototype.hasOwnProperty.call(payload, "peerLastRead")) {
      state.dmPeerRead[withUser] = Math.max(0, Number(payload.peerLastRead) || 0);
    }
    dmUpsertMessages(withUser, messages);
    if (state.dmOpenWith === withUser) dmRenderThread(withUser);
  });
 
  socket.on("dm.message", (payload) => {
    const msg = payload?.message;
    const from = String(msg?.from || "").trim();
    if (!from) return;
    if (dmIsBlocked(from)) return;
    if (payload?.mode) state.dmStorageMode = payload.mode;
    const isClientMode = state.dmStorageMode === "client";
    state.dmLastFrom = from;
    state.dmTypingByUser[from] = false;

    if (msg && !msg.meta && payload?.fromUser) {
      const fu = payload.fromUser;
      msg.meta = {
        rankLevel: fu.rankLevel,
        rankTitle: fu.rankTitle,
        rankColor: fu.rankColor,
        region: fu.region,
        avatarUrl: fu.avatarUrl,
        supporter: !!fu.supporter,
      };
    }
 
    dmUpsertMessages(from, [msg]);

    if (isClientMode && state.dmOpenWith !== from) {
      dmIncrementUnread(from);
    }
 
    // kluss paziņojums (netraucē spēlei)
    if (state.dmOpenWith !== from) dmToast(`✉️ Jauna ziņa no ${from}: ${String(msg?.text || "")}`, from);
 
    // ja saruna ir atvērta, uzreiz atzīmējam kā izlasītu
    if (state.dmOpenWith === from) {
      dmRenderThread(from);
      socket.emit("dm.read", { with: from });
      dmMarkReadLocal(from);
    }
  });
 
  socket.on("dm.sent", (payload) => {
    const msg = payload?.message;
    const withUser = String(payload?.with || msg?.to || "").trim();
    if (!withUser || !msg) return;
    if (payload?.mode) state.dmStorageMode = payload.mode;
 
    dmUpsertMessages(withUser, [msg]);
    if (state.dmOpenWith === withUser) dmRenderThread(withUser);
  });

  socket.on("dm.read", (payload) => {
    const withUser = String(payload?.with || "").trim();
    if (!withUser) return;
    if (payload?.mode) state.dmStorageMode = payload.mode;
    const ts = Math.max(0, Number(payload?.ts) || 0);
    if (ts) state.dmPeerRead[withUser] = ts;
    if (state.dmOpenWith === withUser) dmRenderThread(withUser);
    dmSchedulePersist();
  });

  socket.on("dm.typing", (payload) => {
    const from = String(payload?.from || "").trim();
    if (!from) return;
    state.dmTypingByUser[from] = !!payload?.typing;
    if (state.dmOpenWith === from) dmUpdateTypingIndicator();
  });

  socket.on("dm.edited", (payload) => {
    const withUser = String(payload?.with || "").trim();
    const msg = payload?.message;
    if (!withUser || !msg) return;
    if (payload?.mode) state.dmStorageMode = payload.mode;
    dmUpsertMessages(withUser, [msg]);
    if (state.dmOpenWith === withUser) dmRenderThread(withUser);
  });

  socket.on("dm.deleted", (payload) => {
    const withUser = String(payload?.with || "").trim();
    const id = String(payload?.id || "").trim();
    if (!withUser || !id) return;
    if (payload?.mode) state.dmStorageMode = payload.mode;
    dmUpsertMessages(withUser, [{ id, deleted: true, text: "" }]);
    if (state.dmOpenWith === withUser) dmRenderThread(withUser);
  });
 
  socket.on("dm.error", (payload) => {
    const m = payload?.message || "DM kļūda.";
    dmToast("❌ " + m);
  });
  socket.on("dm.reported", () => {
    dmToast("✅ Paldies! Ziņojums nosūtīts.");
  });
  socket.on("dm.cleared", (payload) => {
  const u = String(payload?.with || "").trim();
  if (!u) return;
  if (payload?.mode) state.dmStorageMode = payload.mode;
  state.dmThreads.delete(u);
  dmMarkReadLocal(u);
  dmSchedulePersist();
  if (state.dmOpenWith === u) {
    state.dmOpenWith = null;
    dmShowInbox();
  }
});
  socket.on("onlineList", (data) => {
    updateOnlineList(data);
  });

  socket.on("playerWin", (info) => {
    updateWinTicker(info);
    refreshLeaderboard();
    refreshWeekly();
    refreshRegionStats();
  });

  socket.on("tokenBuy", (info) => {
    const txt = `🎟️ ${info.username} nopirka žetonu! Tagad: ${info.tokens} žetoni.`;
    appendSystemMessage(txt);
    if (info.username === state.username) playSound(sToken);
  });

  socket.on("forceDisconnect", ({ reason }) => {
    appendSystemMessage("Tevi atvienoja: " + (reason || ""));
    socket.disconnect();
  });

  socket.on("seasonUpdate", (season) => {
    applySeasonState(season);
    refreshHof();
  });

  socket.on("seasonHofUpdate", (payload) => {
    const entry = payload && payload.top ? payload.top : payload;
    renderHofEntry(entry);
  });

  // ===== DUEĻI =====
 socket.on("duel.error", (payload) => {
  const msg = payload?.message || "Nezināma duēļa kļūda.";
  appendSystemMessage("❌ Duēlis: " + msg);
  if (!duelCountdownId) state.isLocked = false;
});
 
socket.on("duel.waiting", (payload) => {
  const opp = payload?.opponent || "pretinieks";
  appendSystemMessage(`⏳ Izaicinājums nosūtīts ${opp}. Gaidām atbildi...`);
});
 
socket.on("duel.start", (payload) => {
  hideDuelInviteUI();
  const { duelId, len, opponent } = payload || {};
  state.duelMode = true;
  state.duelId = duelId;
  state.duelOpponent = opponent || null;
 
  resetGrid(len || 5);
  if (gameMessageEl) {
    gameMessageEl.textContent = `⚔️ Duēlis pret ${opponent || "pretinieks"} — pirmais, kurš atmin, uzvar!`;
  }
  appendSystemMessage(`⚔️ Duēlis sākas pret ${opponent || "pretinieks"} (${len} burti).`);
 const sn = Number(payload?.serverNow);
const base = Number.isFinite(payload?.startedAt) ? Number(payload.startedAt) : (Number.isFinite(sn) ? sn : Date.now());
const exp = payload?.expiresAt || (base + 2 * 60 * 1000);
state.isLocked = true;
 
if (Number.isFinite(sn)) duelServerOffsetMs = sn - Date.now();
const playStartsAt = Number(payload?.startedAt) || (Date.now() + (duelServerOffsetMs || 0) + 5000);
 
showDuelStartCountdown(playStartsAt, sn, payload?.countdownMs);
const delayMs = Math.max(0, playStartsAt - (Date.now() + (duelServerOffsetMs || 0))); 
setTimeout(() => {
  state.isLocked = false;
  startDuelTimer(exp, sn);
}, delayMs)
});
 
// refresh/reconnect turpina dueli
socket.on("duel.resume", (payload) => {
  const { duelId, len, opponent, history } = payload || {};
  if (!duelId) return;
 
  state.duelMode = true;
  state.duelId = duelId;
  state.duelOpponent = opponent || null;
 
  resetGrid(len || 5);
 const sn = Number(payload?.serverNow);
const base = Number.isFinite(payload?.startedAt) ? Number(payload.startedAt) : (Number.isFinite(sn) ? sn : Date.now());
const exp = payload?.expiresAt || (base + 2 * 60 * 1000);
if (Number.isFinite(sn)) duelServerOffsetMs = sn - Date.now();
const nowSrv = Date.now() + (duelServerOffsetMs || 0);
const playStartsAt = Number(payload?.startedAt) || 0;
 
if (playStartsAt && nowSrv < playStartsAt) {
  state.isLocked = true;
  showDuelStartCountdown(playStartsAt, sn, payload?.countdownMs);
 
  const delayMs = Math.max(0, playStartsAt - nowSrv);
  setTimeout(() => {
    state.isLocked = false;
    startDuelTimer(exp, sn);
  }, delayMs);
} else {
  startDuelTimer(exp, sn);
}
 
  (history || []).forEach((h, r) => {
    const guess = String(h?.guess || "");
    for (let c = 0; c < guess.length; c++) {
      const tile = state.gridTiles?.[r]?.[c];
      if (!tile) continue;
      tile.dataset.letter = guess[c];
      tile.textContent = guess[c];
    }
    revealRow(r, h?.pattern || [], { animate: false });
  });
 state.currentRow = (history || []).length;
state.currentCol = 0;
skipHintLockedForward();
}); // <-- ŠIS AIZVER socket.on("duel.resume", ...)

const onDuelGuessResult = async (payload) => {
  const { duelId, pattern, win, finished } = payload || {};
  if (!state.duelMode || duelId !== state.duelId) return;
 
    revealRow(state.currentRow, pattern || []);
  const unlockAfter = revealDurationMs();
 
  if (win) {
    if (gameMessageEl) gameMessageEl.textContent = "Tu uzminēji dueli!";
    playSound(sWin);
    setTimeout(() => showWinEffects(), Math.min(120, unlockAfter));
    state.roundFinished = true;
    state.isLocked = true;
    setTimeout(recordWinAndMaybeShowRatePrompt, unlockAfter + 600);
    return;
  }
 
  if (finished) {
    if (gameMessageEl) gameMessageEl.textContent = "Tev beidzās mēģinājumi duelī.";
    setTimeout(() => playSound(sLose), Math.min(120, unlockAfter));
    state.roundFinished = true;
    state.isLocked = true;
    return;
  }
 
  setTimeout(() => {
    state.currentRow++;
    state.currentCol = 0;
    skipHintLockedForward();
    state.isLocked = false;
  }, unlockAfter);
 
  setTimeout(async () => {
    try {
      const me = await apiGet("/me");
      updatePlayerCard(me);
    } catch {}
  }, unlockAfter);
};
 
// klausāmies abus eventus (dažādiem servera variantiem)
socket.on("duel.guessResult", onDuelGuessResult);
 
socket.on("duel.end", async (payload) => {
    hideDuelStartCountdown(); 
    stopDuelTimer();
  const { duelId, winner, youWin, reason } = payload || {};
  const isDraw = !winner && (reason === "timeout" || reason === "no_attempts" || reason === "no_winner");
  const opponentName = payload?.opponent || state.duelOpponent || null;
 const ranked = payload?.ranked !== false; // default = ranked
  if (duelId && state.duelId && duelId !== state.duelId) return;
 
  state.duelMode = false;
  state.duelId = null;
  state.duelOpponent = null;
  state.isLocked = true;
  state.roundFinished = true;
 
  let msg = "";
  if (youWin) msg = "⚔️ Duēlis beidzies — tu uzvarēji!";
  else if (winner) msg = `⚔️ Duēlis beidzies — uzvarēja ${winner}.`;
  else if (reason === "declined") msg = "⚔️ Duēlis tika atteikts.";
  else if (isDraw) msg = "⚔️ Neizšķirts!";
  else msg = "⚔️ Duēlis beidzies.";
 
  appendSystemMessage(msg);
  if (gameMessageEl) gameMessageEl.textContent = msg;
 
  try {
    const me = await apiGet("/me");
    updatePlayerCard(me);
  } catch {}
 
  if (youWin || winner || isDraw) {
   showDuelResultOverlay({
  winner,
  youWin,
  opponent: opponentName,
  reason,
  scoreText: payload?.scoreText || "",
  ranked,
  yourElo: payload?.yourElo,
  opponentElo: payload?.opponentElo,
  eloDelta: payload?.eloDelta,
});
 const rematchBtn = ensureDuelRematchBtn();
if (rematchBtn) {
  rematchBtn.style.display = opponentName ? "inline-block" : "none";
 rematchBtn.onclick = (e) => {
  e.preventDefault();
  e.stopPropagation();
  hideDuelResultOverlay();
 
  // atbloķē un ļauj turpināt spēli gaidot revanšu
  state.isLocked = false;
  state.roundFinished = true;
  startNewRound();
 
  socket.emit("duel.challenge", { target: opponentName, ranked });
  appendSystemMessage(`🔁 Revanšs izaicinājums nosūtīts ${opponentName}.`);
};
}
    if (newRoundBtn) {
      newRoundBtn.style.display = "inline-block";
      newRoundBtn.disabled = false;
      setTimeout(scheduleFitGrid, 0);
    }
  } else {
    hideDuelResultOverlay();
 
    if (newRoundBtn) {
      newRoundBtn.style.display = "none";
      newRoundBtn.disabled = true;
    }
 
    setTimeout(() => startNewRound(), 1200);
  }
});
}
// ==================== ČATS: SŪTĪŠANA + SEZONAS KOMANDA ====================
let _lastChatSendAt = 0;
const CHAT_SEND_COOLDOWN_MS = 900;
const CHAT_MAX_LEN = 200;

async function sendChatMessage() {
  const text = chatInputEl ? chatInputEl.value.trim() : "";
  if (!text) return;
  if (!state.socket) return;

  const now = Date.now();
  if (now - _lastChatSendAt < CHAT_SEND_COOLDOWN_MS) {
    appendSystemMessage("Pārāk ātri. Pagaidi mirkli un sūti vēlreiz.");
    playSound(sError);
    return;
  }

  if (text.length > CHAT_MAX_LEN) {
    appendSystemMessage(`Ziņa par gara (${text.length}/${CHAT_MAX_LEN}). Saīsini un sūti vēlreiz.`);
    playSound(sError);
    return;
  }

  _lastChatSendAt = now;

  if (text === "!seasonstart" || text === "!seasononline") {
    if (!isAdminUsername(state.username)) {
      appendSystemMessage("Sezonu var startēt tikai admins.");
      if (chatInputEl) chatInputEl.value = "";
      return;
    }

    appendSystemMessage("⏳ Startēju sezonu...");

    try {
      const season = await apiPost("/season/start", {});
      applySeasonState(season);
      appendSystemMessage(`📢 ${(season && season.name) || "SEZONA"} ir startēta!`);
    } catch (err) {
      console.error("Sezonas start kļūda (čats):", err);
      appendSystemMessage(err.message || "Neizdevās startēt sezonu.");
    }

    if (chatInputEl) chatInputEl.value = "";
    return;
  }

  state.socket.emit("chatMessage", text);
  if (chatInputEl) chatInputEl.value = "";
}

// ==================== ŽETONU VEIKALS ====================
async function handleBuyToken() {
  if (!state.token) return;
  try {
    const data = await apiPost("/buy-token", {});
    if (playerCoinsEl) playerCoinsEl.textContent = data.coins;
    if (playerTokensEl) playerTokensEl.textContent = data.tokens;
    appendSystemMessage(`🎟️ Tu nopirki 1 žetonu! Tagad tev ir ${data.tokens} žetoni.`);
    playSound(sToken);

    // papildus sync, ja serveris maina vēl ko (rank/xp/mission progress utt.)
    try {
      const me = await apiGet("/me");
      updatePlayerCard(me);
      refreshMissions();
    } catch {}
  } catch (err) {
    console.error("buy-token kļūda:", err);
    appendSystemMessage(err.message || "Nepietiek coins žetonam.");
    playSound(sError);
  }
}

// ==================== DAILY CHEST (frontend) ====================
let _chestStatus = null;
let _chestTickTimer = null;
 
function formatMsShort(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
 
function ensureDailyChestUi() {
  if (document.getElementById("vz-daily-chest-wrap")) return;
 
  const wrap = document.createElement("div");
  wrap.id = "vz-daily-chest-wrap";
  wrap.style.marginTop = "10px";
  wrap.style.display = "flex";
  wrap.style.flexDirection = "column";
  wrap.style.gap = "6px";
 
  const btn = document.createElement("button");
  btn.id = "vz-daily-chest-btn";
  btn.type = "button";
  btn.className = "mission-claim-btn";
  btn.textContent = "🎁 Daily Chest";
  btn.addEventListener("click", () => handleDailyChestClick());
 
  const sub = document.createElement("div");
  sub.id = "vz-daily-chest-sub";
  sub.style.fontSize = "12px";
  sub.style.opacity = "0.85";
  sub.textContent = "";
 
  wrap.appendChild(btn);
  wrap.appendChild(sub);
 
  // mēģinam ielikt profila kartē (zem coins/tokens)
  const card =
    document.querySelector(".vz-player-card") ||
    (playerNameEl ? playerNameEl.closest(".vz-player-card") : null);
 
  if (card) card.appendChild(wrap);
  else document.body.appendChild(wrap);
}
 
function renderDailyChestUi(status) {
  const btn = document.getElementById("vz-daily-chest-btn");
  const sub = document.getElementById("vz-daily-chest-sub");
  if (!btn || !sub) return;
 
  const available = !!status?.available;
  const streak = Number(status?.streak) || 0;
  const nextAt = Number(status?.nextAt) || 0;
 
  if (available) {
    btn.disabled = false;
    btn.textContent = "🎁 Atvērt Daily Chest";
    sub.textContent = streak > 0 ? `Streak: ${streak}` : "Gatavs atvēršanai";
  } else {
    btn.disabled = false;
    const left = nextAt ? nextAt - Date.now() : 0;
    btn.textContent = "🎁 Daily Chest (šodien jau atvērts)";
    sub.textContent = nextAt ? `Nākamais pēc: ${formatMsShort(left)}` : "Nāc rīt!";
  }
}
 
async function refreshDailyChestStatus() {
  if (!state.token) return;
  try {
    const s = await apiGet("/chest/status");
    _chestStatus = s;
    ensureDailyChestUi();
    renderDailyChestUi(s);
  } catch (err) {
    console.warn("Daily Chest status kļūda:", err);
  }
}
 
async function openDailyChestNow() {
  if (!state.token) return;
 
  const btn = document.getElementById("vz-daily-chest-btn");
  if (btn) btn.disabled = true;
 
  try {
    const data = await apiPost("/chest/open", {});
    if (data?.me) updatePlayerCard(data.me);
 
    // UI sync
    refreshMissions();
    await refreshDailyChestStatus();
 
    const rw = data?.rewards || {};
    const parts = [];
    if (rw.coins) parts.push(`+${rw.coins} coins`);
    if (rw.xp) parts.push(`+${rw.xp} XP`);
    if (rw.tokens) parts.push(`+${rw.tokens} žetons`);
    const streak = Number(data?.streak) || 0;
 
    appendSystemMessage(`🎁 Daily Chest atvērts: ${parts.join(", ") || "balva"} (streak ${streak})`);
    playSound(sCoin);
    if (rw.tokens) playSound(sToken);
  } catch (err) {
    appendSystemMessage(err?.message || "Daily Chest kļūda.");
    await refreshDailyChestStatus();
  } finally {
    if (btn) btn.disabled = false;
  }
}
 
function handleDailyChestClick() {
  const s = _chestStatus;
  if (!s) {
    refreshDailyChestStatus();
    return;
  }
  if (s.available) {
    openDailyChestNow();
    return;
  }
  appendSystemMessage("🎁 Daily Chest šodien jau ir atvērts. Nāc rīt!");
}

// ==================== LATVIJAS LAIKS / LAIKAPSTĀKĻI / VĀRDA DIENA ====================
function updateLatviaClock() {
  if (!topTimeEl || !topDateEl) return;
  try {
    const now = new Date();
    topTimeEl.textContent = now.toLocaleTimeString("lv-LV", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Riga",
    });
    topDateEl.textContent = now.toLocaleDateString("lv-LV", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: "Europe/Riga",
    });
  } catch {
    const now = new Date();
    topTimeEl.textContent = now.toLocaleTimeString("lv-LV", { hour: "2-digit", minute: "2-digit" });
    topDateEl.textContent = now.toLocaleDateString("lv-LV");
  }
}

let _weatherInFlight = false;
async function loadLatviaWeatherOnce() {
  if (!topWeatherEl) return;
  if (_weatherInFlight) return;
  _weatherInFlight = true;

  try {
    topWeatherEl.textContent = "Ielādē...";
    const url =
      "https://api.open-meteo.com/v1/forecast?latitude=56.95&longitude=24.11&current_weather=true&timezone=Europe%2FRiga";
    const res = await fetchWithTimeout(url, {}, 10_000);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();

    const cw = data.current_weather;
    if (!cw) throw new Error("Nav current_weather");

    const temp = Math.round(cw.temperature);
    const wind = Math.round(cw.windspeed);
    const code = cw.weathercode;

    let icon = "☁️";
    if (code === 0) icon = "☀️";
    else if ([1, 2, 3].includes(code)) icon = "⛅";
    else if ([45, 48].includes(code)) icon = "🌫️";
    else if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) icon = "🌧️";
    else if ([71, 73, 75, 77, 85, 86].includes(code)) icon = "❄️";
    else if ([95, 96, 99].includes(code)) icon = "⛈️";

    topWeatherEl.textContent = `${icon} ${temp}°C, vējš ${wind} m/s`;
  } catch (err) {
    console.error("Laikapstākļu kļūda:", err);
    topWeatherEl.textContent = "Laikapstākļi nav pieejami";
  } finally {
    _weatherInFlight = false;
  }
}

let _namedayInFlight = false;
async function loadLatviaNamedayOnce() {
  if (!topNamedayEl) return;
  if (_namedayInFlight) return;
  _namedayInFlight = true;

  try {
    topNamedayEl.textContent = "Ielādē vārda dienu...";
    const url = "https://nameday.abalin.net/api/V1/today?country=lv&timezone=Europe/Riga";
    const res = await fetchWithTimeout(url, {}, 10_000);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();

    let names = "";
    if (data && data.nameday && (data.nameday.lv || data.nameday["lv"])) {
      names = data.nameday.lv || data.nameday["lv"];
    }

    topNamedayEl.textContent = names ? "Vārda diena: " + names : "Vārda diena: —";
  } catch (err) {
    console.warn("Vārda dienas API kļūda:", err);
    topNamedayEl.textContent = "Vārda diena: —";
  } finally {
    _namedayInFlight = false;
  }
}

// ==================== AVATĀRA AUGŠUPIELĀDE ====================
function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

async function compressAvatarDataUrl(dataUrl, maxDim = 320) {
  if (!dataUrl || typeof dataUrl !== "string") return dataUrl;

  const img = await loadImageFromDataUrl(dataUrl);
  const w = img.naturalWidth || img.width || 0;
  const h = img.naturalHeight || img.height || 0;
  if (!w || !h) return dataUrl;

  const maxSide = Math.max(w, h);
  if (maxSide <= maxDim && dataUrl.length < 900_000) return dataUrl;

  const scale = Math.min(1, maxDim / maxSide);
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement("canvas");
  canvas.width = tw;
  canvas.height = th;

  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;

  ctx.drawImage(img, 0, 0, tw, th);

  try {
    const out = canvas.toDataURL("image/webp", 0.85);
    if (out && out.startsWith("data:image/")) return out;
  } catch {}
  try {
    const out = canvas.toDataURL("image/jpeg", 0.88);
    if (out && out.startsWith("data:image/")) return out;
  } catch {}

  return dataUrl;
}

function clearAvatarFileInput() {
  try {
    if (playerAvatarFileEl) playerAvatarFileEl.value = "";
  } catch {}
}

async function handleAvatarUpload(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    appendSystemMessage("Lūdzu izvēlies bildi (JPG/PNG utt.).");
    clearAvatarFileInput();
    return;
  }

  const maxSize = 10 * 1024 * 1024; // 10MB
  if (file.size > maxSize) {
    appendSystemMessage("Bilde ir par lielu (max ~10MB).");
    clearAvatarFileInput();
    return;
  }

  const reader = new FileReader();
  reader.onload = async () => {
    let dataUrl = reader.result;

    try {
      dataUrl = await compressAvatarDataUrl(String(dataUrl), 320);
    } catch (err) {
      console.warn("Avatar compress kļūda:", err);
    }

    setLocalAvatar(state.username, dataUrl);

    setAvatar(playerAvatarImgEl, playerAvatarInitialsEl, dataUrl, state.username);
    setAvatar(ppAvatarImgEl, ppAvatarInitialsEl, dataUrl, state.username);

    if (state.token) {
      try {
        await apiPost("/avatar", { avatar: dataUrl });
        appendSystemMessage("Tavs avatārs atjaunots un saglabāts serverī (sync ar citām ierīcēm).");
      } catch (err) {
        console.error("Avatāra sync kļūda:", err);
        appendSystemMessage("Avatārs saglabāts šajā ierīcē, bet servera sync neizdevās: " + (err.message || ""));
      }
    } else {
      appendSystemMessage("Tavs avatārs atjaunots šajā ierīcē. (Nav tokena, servera sync izlaists.)");
    }

    // ļauj augšupielādēt to pašu failu atkārtoti
    clearAvatarFileInput();
  };

  reader.readAsDataURL(file);
}

// ==================== SHARE ====================
function openWhatsappShare(text) {
  const url = "https://wa.me/?text=" + encodeURIComponent(text || "");
  window.open(url, "_blank", "noopener,noreferrer");
}

async function openDiscordShare(text) {
  const payload = String(text || "").trim();
  if (!payload) return;
  try {
    await navigator.clipboard.writeText(payload);
    appendSystemMessage("✅ Teksts nokopēts. Atver Discord un ielīmē.");
  } catch {
    prompt("Nokopē tekstu Discord:", payload);
  }
  window.open("https://discord.com/channels/@me", "_blank", "noopener,noreferrer");
}

async function handleShare() {
  const url = window.location.href;
  const text = "VĀRDU ZONA – nāc uzspēlē latviešu Word battle!";

  if (navigator.share) {
    try {
      await navigator.share({ title: "VĀRDU ZONA", text, url });
      appendSystemMessage("✅ Links padalīts.");
      return;
    } catch {}
  }

  try {
    await navigator.clipboard.writeText(url);
    appendSystemMessage("✅ Links nokopēts (ielīmē TikTok/WhatsApp).");
  } catch {
    prompt("Nokopē šo linku:", url);
  }
}

function handleShareWhatsapp() {
  const url = window.location.href;
  const text = "VĀRDU ZONA – nāc uzspēlē latviešu Word battle!";
  openWhatsappShare(`${text} ${url}`);
}

function handleShareDiscord() {
  const url = window.location.href;
  const text = "VĀRDU ZONA – nāc uzspēlē latviešu Word battle!";
  openDiscordShare(`${text} ${url}`);
}

function setShareResultVisible(on) {
  if (shareResultBtn) shareResultBtn.style.display = on ? "block" : "none";
  if (shareResultWhatsappBtn)
    shareResultWhatsappBtn.style.display = on ? "block" : "none";
  if (shareResultDiscordBtn)
    shareResultDiscordBtn.style.display = on ? "block" : "none";
  if (shareResultNote) shareResultNote.style.display = on ? "block" : "none";
}

function buildShareMatrix(rowsUsed) {
  const out = [];
  const rows = Math.max(0, Math.min(state.rows, rowsUsed || 0));
  for (let r = 0; r < rows; r++) {
    const rowTiles = state.gridTiles?.[r] || [];
    const row = [];
    for (let c = 0; c < state.cols; c++) {
      const tile = rowTiles[c];
      if (!tile) {
        row.push("empty");
        continue;
      }
      if (tile.classList.contains("correct")) row.push("correct");
      else if (tile.classList.contains("present")) row.push("present");
      else if (tile.classList.contains("absent")) row.push("absent");
      else row.push("empty");
    }
    out.push(row);
  }
  return out;
}

function buildShareGridText(matrix) {
  const map = {
    correct: "🟩",
    present: "🟨",
    absent: "⬛",
    empty: "⬜",
  };
  return matrix
    .map((row) => row.map((c) => map[c] || "⬜").join(""))
    .join("\n");
}

function buildShareText(data) {
  const dateStr = new Date().toLocaleDateString("lv-LV");
  const result = data.win ? `${data.attempts}/${data.rows}` : `X/${data.rows}`;
  const gridText = data.gridText || "";
  return `VĀRDU ZONA ${dateStr} ${result}\n${gridText}\n${window.location.origin}`;
}

function drawRoundedRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

async function buildShareSticker(data) {
  const width = 1080;
  const height = 1350;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, "#050716");
  bg.addColorStop(0.5, "#0b1233");
  bg.addColorStop(1, "#0a0f2a");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#ffffff";
  ctx.shadowColor = "rgba(255, 0, 70, 0.75)";
  ctx.shadowBlur = 18;
  ctx.font = "italic 84px Cinzel, serif";
  ctx.fillText("VĀRDU ZONA", width / 2, 80);
  ctx.shadowBlur = 0;

  const result = data.win ? `${data.attempts}/${data.rows}` : `X/${data.rows}`;
  ctx.fillStyle = "#ff0046";
  ctx.font = "700 48px Arial, sans-serif";
  ctx.fillText(`Rezultāts: ${result}`, width / 2, 190);

  const matrix = data.matrix || [];
  const rows = matrix.length;
  const cols = state.cols || 5;
  const maxGridWidth = width - 200;
  const cell = Math.floor(Math.min(78, maxGridWidth / cols));
  const gap = Math.max(6, Math.floor(cell * 0.12));
  const gridW = cols * cell + (cols - 1) * gap;
  const gridH = rows * cell + (rows - 1) * gap;
  const startX = Math.floor((width - gridW) / 2);
  const startY = 300;

  const colors = {
    correct: "#00c853",
    present: "#ff9100",
    absent: "#1a1b2e",
    empty: "#2a2a2c",
  };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const val = matrix[r]?.[c] || "empty";
      const x = startX + c * (cell + gap);
      const y = startY + r * (cell + gap);
      ctx.fillStyle = colors[val] || colors.empty;
      drawRoundedRect(ctx, x, y, cell, cell, 10);
      ctx.fill();
    }
  }

  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = "600 26px Arial, sans-serif";
  ctx.fillText("Uzspēlē VĀRDU ZONU!", width / 2, height - 140);
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "500 22px Arial, sans-serif";
  ctx.fillText(window.location.origin, width / 2, height - 98);

  return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

function prepareShareResult(isWin, attemptsUsed) {
  if (state.duelMode) return;
  const rowsUsed = Math.max(1, Math.min(state.rows, attemptsUsed || state.rows));
  const matrix = buildShareMatrix(rowsUsed);
  const gridText = buildShareGridText(matrix);
  state.lastShareResult = {
    win: !!isWin,
    attempts: rowsUsed,
    rows: state.rows,
    matrix,
    gridText,
  };
  setShareResultVisible(true);
}

async function handleShareResult() {
  const data = state.lastShareResult;
  if (!data) return;
  const text = buildShareText(data);
  const blob = await buildShareSticker(data);

  if (blob && navigator.share && navigator.canShare) {
    const file = new File([blob], "vardu-zona.png", { type: "image/png" });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ title: "VĀRDU ZONA", text, files: [file] });
        appendSystemMessage("✅ Rezultāts padalīts.");
        return;
      } catch {}
    }
  }

  if (navigator.share) {
    try {
      await navigator.share({ title: "VĀRDU ZONA", text });
      appendSystemMessage("✅ Rezultāts padalīts.");
      return;
    } catch {}
  }

  try {
    await navigator.clipboard.writeText(text);
    appendSystemMessage("✅ Rezultāts nokopēts.");
  } catch {
    prompt("Nokopē rezultātu:", text);
  }

  if (blob) {
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

function handleShareResultWhatsapp() {
  const data = state.lastShareResult;
  if (!data) return;
  const text = buildShareText(data);
  openWhatsappShare(text);
}

function handleShareResultDiscord() {
  const data = state.lastShareResult;
  if (!data) return;
  const text = buildShareText(data);
  openDiscordShare(text);
}

// ==================== RADIO INIT (vienreiz) ====================
function initRadioUi() {
  const radioAudio = document.getElementById("vz-radio");
  const radioBtn = document.getElementById("radio-toggle-btn");
  const volumeInput = document.getElementById("radio-volume");
  const statusEl = document.getElementById("radio-status");

  if (!radioAudio || !radioBtn || !volumeInput || !statusEl) return;

  const RADIO_STREAM_URL = "https://stream.nightride.fm/nightride.mp3";
  let isPlaying = false;

  try {
    const v = localStorage.getItem("vz_radio_volume");
    if (v) volumeInput.value = v;
  } catch {}

  radioAudio.volume = parseFloat(volumeInput.value || "0.6") || 0.6;

  radioBtn.addEventListener("click", async () => {
    if (!isPlaying) {
      if (!radioAudio.src) radioAudio.src = RADIO_STREAM_URL;

      try {
        await radioAudio.play();
        isPlaying = true;
        radioBtn.textContent = "⏸ Pauze";
        statusEl.textContent = "Radio spēlē...";
      } catch (err) {
        console.error("Radio play error:", err);
        statusEl.textContent = "Neizdevās palaist radio (pārbaudi URL vai pārlūka atļaujas).";
      }
    } else {
      radioAudio.pause();
      isPlaying = false;
      radioBtn.textContent = "▶ Spēlēt";
      statusEl.textContent = "Radio izslēgts";
    }
  });

  volumeInput.addEventListener("input", () => {
    const v = parseFloat(volumeInput.value);
    if (!Number.isNaN(v)) radioAudio.volume = v;
    try {
      localStorage.setItem("vz_radio_volume", String(volumeInput.value));
    } catch {}
  });

  applySoundState();
}

// ==================== INIT ====================
let _fsBtnHomes = null;
 
function ensureFsBottomBar() {
  let bar = document.getElementById("vz-fs-bottom-bar");
  if (bar) return bar;
 
  bar = document.createElement("div");
  bar.id = "vz-fs-bottom-bar";
  bar.style.display = "none"; // default (ne pilnekrānā)
  document.body.appendChild(bar);
  return bar;
}
 
function setFullscreenBottomButtons(on) {
  if (!newRoundBtn) return;
 
  const bar = ensureFsBottomBar();
 
  if (on) {
    if (!_fsBtnHomes) {
      _fsBtnHomes = [
        { btn: newRoundBtn, parent: newRoundBtn.parentNode, next: newRoundBtn.nextSibling },
      ];
    }
 
    bar.style.display = "flex";
    bar.appendChild(newRoundBtn);
  } else {
    bar.style.display = "none";
    if (_fsBtnHomes) {
      for (const h of _fsBtnHomes) {
        if (!h.parent) continue;
        if (h.next) h.parent.insertBefore(h.btn, h.next);
        else h.parent.appendChild(h.btn);
      }
    }
  }
}let _logoutHome = null;
 
function keepActionButtonsTogether() {
  if (!newRoundBtn) return;
 
  const wrap = document.querySelector(".vz-bottom-buttons");
  if (!wrap) return;
 
  if (!wrap.contains(newRoundBtn)) wrap.appendChild(newRoundBtn);
}
 
function restoreLogoutButtonHome() {
  if (!_logoutHome || !logoutBtn) return;
  const { parent, next } = _logoutHome;
  if (!parent) return;
  if (next) parent.insertBefore(logoutBtn, next);
  else parent.appendChild(logoutBtn);
}
async function initGame() {
  const token = getStoredFirst(AUTH_KEYS.token);
  const username = getStoredFirst(AUTH_KEYS.username);

  if (!token || !username) {
    window.location.href = "index.html";
    return;
  }

  state.token = token;
  state.username = username;
  try { state.dmNotifyOn = localStorage.getItem("vz_dm_notify") !== "off"; } catch {}

  // kanonizējam
  setStoredAuth(token, username);

  // Migrācija: ja ir vecais “vz_avatar” un nav per-user, pārliekam
  try {
    const legacy = localStorage.getItem("vz_avatar");
    const perUser = localStorage.getItem(avatarStorageKey(state.username));
    if (legacy && !perUser) localStorage.setItem(avatarStorageKey(state.username), legacy);
  } catch {}

  dmLoadLocalState();
  window.addEventListener("beforeunload", () => dmPersistNow());

  try {
    const soundPref = localStorage.getItem("vz_sound");
    state.soundOn = soundPref === "off" ? false : true;
  } catch {
    state.soundOn = true;
  }
  applySoundState();

  setUnreadBadge(false);

  if (soundToggleBtn) {
    soundToggleBtn.addEventListener("click", () => {
      state.soundOn = !state.soundOn;
      try {
        localStorage.setItem("vz_sound", state.soundOn ? "on" : "off");
      } catch {}
      applySoundState();
    });
  }

  try {
    const saved = localStorage.getItem("vz_theme");
    if (saved && THEME_ORDER.includes(saved)) state.theme = saved;
  } catch {}
  applyTheme();
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", () => {
      const idx = THEME_ORDER.indexOf(state.theme);
      state.theme = THEME_ORDER[(idx + 1) % THEME_ORDER.length];
      try {
        localStorage.setItem("vz_theme", state.theme);
      } catch {}
      applyTheme();
    });
  }

  if (!navigator.onLine) setOfflineOverlay(true);
  window.addEventListener("offline", () => setOfflineOverlay(true));
  window.addEventListener("online", () => setOfflineOverlay(false));
  if (offlineRetryBtn) {
    offlineRetryBtn.addEventListener("click", () => {
      setOfflineOverlay(false);
      window.location.reload();
    });
  }
  if (rateLaterBtn) rateLaterBtn.addEventListener("click", hideRateOverlay);
  if (rateOpenBtn) rateOpenBtn.addEventListener("click", hideRateOverlay);

  if (shareBtn) shareBtn.addEventListener("click", handleShare);
  if (shareWhatsappBtn) shareWhatsappBtn.addEventListener("click", handleShareWhatsapp);
  if (shareDiscordBtn) shareDiscordBtn.addEventListener("click", handleShareDiscord);
  if (shareResultBtn) shareResultBtn.addEventListener("click", handleShareResult);
  if (shareResultWhatsappBtn)
    shareResultWhatsappBtn.addEventListener("click", handleShareResultWhatsapp);
  if (shareResultDiscordBtn)
    shareResultDiscordBtn.addEventListener("click", handleShareResultDiscord);

  if (friendAddBtnEl && friendAddInputEl) {
    friendAddBtnEl.addEventListener("click", () => {
      const name = String(friendAddInputEl.value || "").trim();
      if (!name) return;
      friendAddInputEl.value = "";
      friendRequest(name);
    });
    friendAddInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        friendAddBtnEl.click();
      }
    });
  }

  if (playerAvatarUploadBtnEl && playerAvatarFileEl) {
    playerAvatarUploadBtnEl.addEventListener("click", () => playerAvatarFileEl.click());
    playerAvatarFileEl.addEventListener("change", handleAvatarUpload);
  }

  buildKeyboard();
  initGridGlow();
  keepActionButtonsTogether();
  window.addEventListener("resize", scheduleFitGrid);
  // mobilajā pārlūkā "adreses joslas" lēkāšana maina viewport -> pārrēķinam režģi
try {
  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener("resize", scheduleFitGrid);
    vv.addEventListener("scroll", scheduleFitGrid);
  }
} catch {}
  initRadioUi();
ensureDmUi();
// DM FAB long-press: toggle paziņojumus (ieliekam 1x)
setTimeout(() => {
  const fab = document.getElementById("vz-dm-fab");
  const toast = document.getElementById("vz-dm-toast");
  if (!fab) return;
  if (fab.dataset.lpBound === "1") return;
  fab.dataset.lpBound = "1";
 
  let t = null;
 
  const clear = () => { if (t) clearTimeout(t); t = null; };
 
  const start = () => {
    clear();
    t = setTimeout(() => {
      // atzīmējam, lai click pēc long-press neatver DM
      fab.dataset.lpJustDid = "1";
      setTimeout(() => { fab.dataset.lpJustDid = "0"; }, 400);
 
      const next = !state.dmNotifyOn;
      state.dmNotifyOn = next;
      try { localStorage.setItem("vz_dm_notify", next ? "on" : "off"); } catch {}
 
      // parādam statusu pat tad, ja tikko izslēdzi (apejam dmToast “off” check)
      if (toast) {
        toast.textContent = next ? "DM paziņojumi: ON" : "DM paziņojumi: OFF";
        toast.dataset.from = "";
        toast.style.display = "block";
        setTimeout(() => { toast.style.display = "none"; }, 1500);
      }
    }, 650);
  };
 
  // touch
  fab.addEventListener("touchstart", start, { passive: true });
  fab.addEventListener("touchend", clear, { passive: true });
  fab.addEventListener("touchcancel", clear, { passive: true });
 
  // mouse (lai strādā arī desktop)
  fab.addEventListener("mousedown", start);
  window.addEventListener("mouseup", clear);
}, 0);

  updateLatviaClock();
  setInterval(updateLatviaClock, 30_000);

  loadLatviaWeatherOnce();
  setInterval(loadLatviaWeatherOnce, 10 * 60 * 1000);

  loadLatviaNamedayOnce();
  setInterval(loadLatviaNamedayOnce, 6 * 60 * 60 * 1000);

  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      if (state.socket) {
        state.socket.disconnect();
        state.socket = null;
      }
      clearStoredAuth();
      window.location.href = "index.html";
    });
  }

  if (newRoundBtn) {
    newRoundBtn.addEventListener("click", () => {
      if (!state.roundFinished) {
        if (gameMessageEl) gameMessageEl.textContent = "Pabeidz raundu līdz galam, tad var sākt jaunu.";
        return;
      }
      if (!state.duelMode) startNewRound();
    });
  }

  if (buyTokenBtn) buyTokenBtn.addEventListener("click", handleBuyToken);

  if (seasonStartBtn) {
    seasonStartBtn.addEventListener("click", async () => {
      if (!state.token) return;
      try {
        seasonStartBtn.disabled = true;
        const season = await apiPost("/season/start", {});
        applySeasonState(season);
        appendSystemMessage(`📢 ${season.name || "SEZONA"} ir startēta!`);
        refreshHof();
      } catch (err) {
        console.error("Sezonas start kļūda:", err);
        appendSystemMessage(err.message || "Neizdevās startēt sezonu.");
      } finally {
        seasonStartBtn.disabled = false;
      }
    });
  }

   if (mobileFsBtn) {
    mobileFsBtn.addEventListener("click", () => {
      const body = document.body;
      const rightArea = document.querySelector(".vz-right-area");
      const leftArea = document.querySelector(".vz-left-area");
      const container = document.querySelector(".vz-game-container");
 
      const isFullscreenOn = body.classList.contains("vz-mobile-game-only");
 
      if (!isFullscreenOn) {
        body.classList.add("vz-mobile-game-only", "vz-mobile-big-keys");
        mobileFsBtn.textContent = "🔙 Parastais režīms";
 
        if (rightArea) rightArea.style.display = "none";
        if (leftArea) {
          leftArea.style.maxWidth = "100%";
          leftArea.style.flex = "1 1 auto";
        }
        if (container) container.style.maxWidth = "100%";
      } else {
        body.classList.remove("vz-mobile-game-only", "vz-mobile-big-keys");
        mobileFsBtn.textContent = "📱 Pilnekrāna spēle";
 
        if (rightArea) rightArea.style.display = "";
        if (leftArea) {
          leftArea.style.maxWidth = "";
          leftArea.style.flex = "";
        }
        if (container) container.style.maxWidth = "";
      }
 
 setFullscreenBottomButtons(!isFullscreenOn);   // <-- ŠEIT
      // pēc režīma pārslēgšanas pārrēķinam režģi (DOM vēl pārkārtojas)
      try {
        document.activeElement && document.activeElement.blur && document.activeElement.blur();
      } catch {}
      setTimeout(scheduleFitGrid, 0);
      setTimeout(scheduleFitGrid, 250);
    });
  }

  if (chatSendBtn) chatSendBtn.addEventListener("click", sendChatMessage);
  initChatEmojiPicker();
  if (chatInputEl) {
    chatInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        sendChatMessage();
      }
    });
    chatInputEl.addEventListener("focus", () => clearUnreadIfNeeded());
  }

  if (chatMessagesEl) chatMessagesEl.addEventListener("scroll", () => clearUnreadIfNeeded());
  document.addEventListener("visibilitychange", () => clearUnreadIfNeeded());

  if (chatMentionBadgeEl) {
    chatMentionBadgeEl.addEventListener("click", () => {
      if (!lastMention) {
        showMentionPopup("Nav pieminējumu.");
        return;
      }
      const t = new Date(lastMention.ts || Date.now()).toLocaleTimeString("lv-LV", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Europe/Riga",
      });
      showMentionPopup(`🔔 [${t}] ${lastMention.from}: ${lastMention.text}`);
      chatMentionBadgeEl.classList.remove("vz-mention-active");
    });
  }

  if (chatUnreadBadgeEl) {
    chatUnreadBadgeEl.addEventListener("click", () => {
      if (!chatMessagesEl) return;
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
      chatUnread = 0;
      setUnreadBadge(false);
    });
  }

  if (profileCloseBtn) profileCloseBtn.addEventListener("click", hidePlayerProfile);
  if (profilePopupEl) {
    profilePopupEl.addEventListener("click", (e) => {
      if (e.target === profilePopupEl) hidePlayerProfile();
    });
  }

  if (ppMsgBtnEl) ppMsgBtnEl.addEventListener("click", handlePersonalMessageClick);
  if (ppEmailSaveBtn) ppEmailSaveBtn.addEventListener("click", handleProfileEmailSave);
  if (ppEmailRemoveBtn) ppEmailRemoveBtn.addEventListener("click", handleProfileEmailRemove);
  if (ppEmailInputEl) {
    ppEmailInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleProfileEmailSave();
    });
  }

  if (duelOkBtn) {
  duelOkBtn.type = "button";
  duelOkBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideDuelResultOverlay();
    startNewRound();
  });
}
  if (duelOverlayEl) {
    duelOverlayEl.addEventListener("click", (e) => {
      if (e.target === duelOverlayEl) {
        hideDuelResultOverlay();
        startNewRound();
      }
    });
  }

  window.addEventListener("unhandledrejection", (ev) => {
    const msg = ev && ev.reason && ev.reason.message ? ev.reason.message : "Nezināma kļūda (Promise).";
    console.error("unhandledrejection:", ev.reason);
    appendSystemMessage("⚠️ Kļūda: " + msg);
  });
  window.addEventListener("error", (ev) => {
    const msg = ev && ev.message ? ev.message : "Nezināma kļūda.";
    console.error("window.error:", ev);
    appendSystemMessage("⚠️ Kļūda: " + msg);
  });

  bindRegionModal();
  bindRegionActions();

  try {
    const me = await apiGet("/me");
    updatePlayerCard(me);

    // Avatar auto-sync (per-user)
    try {
      const localEntry = getLocalAvatarEntry(me.username);
      const localAvatar = localEntry?.url || null;
      const serverAvatar = me.avatarUrl || null;
      const serverExp = Number(me.avatarUrlExpiresAt) || 0;

      if (localAvatar && !serverAvatar && state.token) {
        await apiPost("/avatar", { avatar: localAvatar });
        appendSystemMessage("Tavs lokālais avatārs nosūtīts uz serveri (sync).");
      }

      if (!localAvatar && serverAvatar) {
        setLocalAvatar(me.username, serverAvatar, serverExp);
        setAvatar(playerAvatarImgEl, playerAvatarInitialsEl, serverAvatar, state.username);
        setAvatar(ppAvatarImgEl, ppAvatarInitialsEl, serverAvatar, state.username);
      }
    } catch (e) {
      console.warn("Avatāra auto-sync kļūda init laikā:", e);
    }

    if (isRegionMissing(me)) {
      showRegionModal();
      return;
    }

    await runPostLoginInit();
  } catch (err) {
    console.error("Init /me kļūda:", err);
    clearStoredAuth();
    window.location.href = "index.html";
  }
}

document.addEventListener("DOMContentLoaded", initGame);

// Rezerves flash (ja kaut kur gribi izsaukt manuāli)
function triggerWinFlash() {
  const flashElement = document.getElementById("screen-flash");
  if (!flashElement) return;

  flashElement.classList.add("vz-screen-flash-active");
  setTimeout(() => flashElement.classList.remove("vz-screen-flash-active"), 300);
}
