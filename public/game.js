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

// ================== MODUĻI / KONFIGS ==================
const VZGameCore = window.VZGameCore || {};
const VZServices = window.VZServices || {};
const VZUI = window.VZUI || {};
const VZChat = window.VZChat || {};
const VZDuel = window.VZDuel || {};
const VZTournaments = window.VZTournaments || {};

const {
  ADMIN_SET,
  AUTH_KEYS,
  DISALLOWED_KEYS,
  REGION_META,
  REGION_TOTAL_CAP,
  createInitialState,
  getAuraRankFromLevel,
  getCosmeticTierFromLevel,
  isAdminUsername,
  rankMinXpByLevel,
} = VZGameCore;

const { createApiBase, fetchWithTimeout, readJsonOrThrow } = VZServices;
const { $, createEl, safeText, applyRankColor } = VZUI;

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Vienots mīksts tukšā stāvokļa bloks (īss virsraksts + 1 rindiņa). */
function fillVzEmptyState(el, options = {}) {
  if (!el) return;
  const glyph = String(options.glyph ?? "✦").trim() || "✦";
  const title = String(options.title || "").trim();
  const text = String(options.text || "").trim();
  const compact = !!options.compact;
  const extra = String(options.extraClass || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  el.className = [
    "vz-empty-state",
    compact ? "vz-empty-state--compact" : "",
    ...extra,
  ]
    .filter(Boolean)
    .join(" ");
  const g = escapeHtml(glyph);
  const t = title ? `<p class="vz-empty-state__title">${escapeHtml(title)}</p>` : "";
  const x = text ? `<p class="vz-empty-state__text">${escapeHtml(text)}</p>` : "";
  el.innerHTML = `<div class="vz-empty-state__glyph" aria-hidden="true">${g}</div>${t}${x}`;
}
const {
  dmNormalizeMessageForStore,
  dmObjectToThreads,
  dmSanitizeMeta,
  dmStorageKey,
  dmThreadsToObject,
} = VZChat;
const { buildDuelExtraText, isDuelDrawReason } = VZDuel;
const {
  normalizeTournamentList,
  normalizeTournamentSchedule,
  tournamentMatchStatusLabel,
  tournamentPlayModeText,
  tournamentTypeLabel,
} = VZTournaments;

const API_BASE =
  typeof createApiBase === "function"
    ? createApiBase()
    : "https://bugats-wordle-server.onrender.com";
const ONESIGNAL_SDK_SRC =
  "https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js";
const ONESIGNAL_PROMPT_LS_KEY = "vz_onesignal_prompt_v1";
let oneSignalInitPromise = null;
let oneSignalInitialized = false;
let oneSignalLoggedInAs = "";

function getRuntimeConfig() {
  const cfg =
    window &&
    window.VZ_RUNTIME_CONFIG &&
    typeof window.VZ_RUNTIME_CONFIG === "object"
      ? window.VZ_RUNTIME_CONFIG
      : {};
  return cfg;
}

function getOneSignalConfig() {
  const cfg = getRuntimeConfig();
  let appId = String(cfg.oneSignalAppId || "").trim();
  let safariWebId = String(cfg.oneSignalSafariWebId || "").trim();
  let promptDelaySeconds = Number(cfg.oneSignalPromptDelaySeconds || 0);

  try {
    const overrideAppId = String(
      localStorage.getItem("vz_onesignal_app_id") || ""
    ).trim();
    if (overrideAppId) appId = overrideAppId;
    const overrideSafariWebId = String(
      localStorage.getItem("vz_onesignal_safari_web_id") || ""
    ).trim();
    if (overrideSafariWebId) safariWebId = overrideSafariWebId;
    const overrideDelay = parseInt(
      localStorage.getItem("vz_onesignal_prompt_delay") || "",
      10
    );
    if (Number.isFinite(overrideDelay)) promptDelaySeconds = overrideDelay;
  } catch {}

  if (!Number.isFinite(promptDelaySeconds) || promptDelaySeconds < 0) {
    promptDelaySeconds = 0;
  }

  return {
    appId,
    safariWebId,
    promptDelaySeconds: Math.min(300, Math.floor(promptDelaySeconds)),
  };
}

function loadOneSignalSdk() {
  if (window.OneSignal && typeof window.OneSignal.init === "function") {
    return Promise.resolve();
  }
  const existing = document.getElementById("onesignal-sdk");
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("OneSignal SDK load failed")),
        {
          once: true,
        }
      );
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.id = "onesignal-sdk";
    script.src = ONESIGNAL_SDK_SRC;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("OneSignal SDK load failed"));
    document.head.appendChild(script);
  });
}

function shouldPromptOneSignal() {
  try {
    return localStorage.getItem(ONESIGNAL_PROMPT_LS_KEY) !== "1";
  } catch {
    return true;
  }
}

function markOneSignalPrompted() {
  try {
    localStorage.setItem(ONESIGNAL_PROMPT_LS_KEY, "1");
  } catch {}
}

async function initOneSignalPush(username = "") {
  const cfg = getOneSignalConfig();
  if (!cfg.appId) return;
  if (!("Notification" in window) || !("serviceWorker" in navigator)) return;

  if (!oneSignalInitPromise) {
    oneSignalInitPromise = (async () => {
      const initAndLink = async (OneSignal) => {
        if (!oneSignalInitialized) {
          await OneSignal.init({
            appId: cfg.appId,
            safari_web_id: cfg.safariWebId || undefined,
            serviceWorkerPath: "sw.js",
            serviceWorkerUpdaterPath: "sw.js",
            notifyButton: { enable: false },
            autoResubscribe: true,
            allowLocalhostAsSecureOrigin:
              window.location.hostname === "localhost" ||
              window.location.hostname === "127.0.0.1",
          });
          oneSignalInitialized = true;

          if (
            cfg.promptDelaySeconds >= 0 &&
            Notification.permission === "default" &&
            shouldPromptOneSignal()
          ) {
            markOneSignalPrompted();
            setTimeout(() => {
              try {
                if (
                  OneSignal.Notifications &&
                  typeof OneSignal.Notifications.requestPermission ===
                    "function"
                ) {
                  OneSignal.Notifications.requestPermission().catch(() => {});
                }
              } catch {}
            }, cfg.promptDelaySeconds * 1000);
          }
        }

        const externalId = String(username || state.username || "").trim();
        if (
          externalId &&
          externalId !== oneSignalLoggedInAs &&
          typeof OneSignal.login === "function"
        ) {
          await OneSignal.login(externalId);
          oneSignalLoggedInAs = externalId;
        }
      };

      if (window.OneSignal && typeof window.OneSignal.init === "function") {
        await initAndLink(window.OneSignal);
        return;
      }

      const queued = new Promise((resolve) => {
        window.OneSignalDeferred = window.OneSignalDeferred || [];
        window.OneSignalDeferred.push(async (OneSignal) => {
          try {
            await initAndLink(OneSignal);
          } catch (err) {
            console.warn("OneSignal init kļūda:", err);
          } finally {
            resolve();
          }
        });
      });
      await loadOneSignalSdk();
      await queued;
    })().catch((err) => {
      console.warn("OneSignal SDK ielādes kļūda:", err);
    });
  } else {
    await oneSignalInitPromise;
    if (
      window.OneSignal &&
      typeof window.OneSignal.login === "function" &&
      username &&
      username !== oneSignalLoggedInAs
    ) {
      try {
        await window.OneSignal.login(String(username).trim());
        oneSignalLoggedInAs = String(username).trim();
      } catch {}
    }
  }
}

async function clearOneSignalIdentity() {
  oneSignalLoggedInAs = "";
  try {
    if (window.OneSignal && typeof window.OneSignal.logout === "function") {
      await window.OneSignal.logout();
      return;
    }
    if (Array.isArray(window.OneSignalDeferred)) {
      window.OneSignalDeferred.push(async (OneSignal) => {
        if (OneSignal && typeof OneSignal.logout === "function") {
          try {
            await OneSignal.logout();
          } catch {}
        }
      });
    }
  } catch {}
}

// Fetch timeout (lai UI neiestrēgst pie “karājošiem” requestiem)
const FLIP_DELAY_MS = 160;
const FLIP_DURATION_MS = 800;
const PREFERS_REDUCED_MOTION =
  typeof window !== "undefined" &&
  window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ================== AUTH STORAGE (kompatibilitāte) ==================
function getStoredFirst(keys) {
  for (const k of keys) {
    try {
      const v = localStorage.getItem(k);
      if (v && String(v).trim()) return String(v).trim();
    } catch {}
  }
  return "";
}

function setStoredAuth(token, username, session = null) {
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

  if (session && typeof session === "object") {
    const rt = String(session.refreshToken || "").trim();
    if (rt) {
      try {
        localStorage.setItem("vz_refresh_token", rt);
        localStorage.setItem("vzRefreshToken", rt);
        localStorage.setItem("refreshToken", rt);
      } catch {}
    }
    const accessExp = Number(session.accessTokenExpiresAt);
    if (Number.isFinite(accessExp) && accessExp > 0) {
      try {
        localStorage.setItem(
          "vz_access_expires_at",
          String(Math.floor(accessExp))
        );
      } catch {}
    }
    const refreshExp = Number(session.refreshTokenExpiresAt);
    if (Number.isFinite(refreshExp) && refreshExp > 0) {
      try {
        localStorage.setItem(
          "vz_refresh_expires_at",
          String(Math.floor(refreshExp))
        );
      } catch {}
    }
  }
}

function clearStoredAuth() {
  const all = new Set([
    ...AUTH_KEYS.token,
    ...AUTH_KEYS.username,
    ...AUTH_KEYS.refreshToken,
    ...AUTH_KEYS.accessExpiresAt,
    ...AUTH_KEYS.refreshExpiresAt,
    "vz_token",
    "vz_username",
    "vz_refresh_token",
    "vz_access_expires_at",
    "vz_refresh_expires_at",
  ]);
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
      if (
        !k ||
        (!k.startsWith(prefix1) && !k.startsWith(prefix2)) ||
        protect.has(k)
      )
        continue;
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

// ===== Klienta stāvoklis =====
const state = createInitialState();

const DM_THREAD_MAX_LOCAL = 200;
const DM_LOCAL_STORAGE_VERSION = 2;
const DM_STORAGE_PERSIST_MS = 800;

const AVATAR_CACHE_MAX_SIZE = 80;
const AVATAR_STORAGE_MAX_KEYS = 50;

let seasonTimerId = null;
let tournamentRefreshTimer = null;
let tournamentCountdownTimer = null;
let tournamentSocketRefreshTimer = null;
let engagementLoopTimer = null;
let engagementLoopBusy = false;
let currentProfileName = null; // popupā atvērtais profila vārds

/** Fokusa atgriešanai pēc galda modāļa / rezultāta overlay */
let _boardModalFocusReturn = null;
let _boardResultFocusReturn = null;

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
const buyVipBtn = $("#buy-vip-btn");
const vipStatusEl = $("#vip-status");
const vipBuyStatusEl = $("#vip-buy-status");
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
const stripeCoinsBuyEl = document.getElementById("vz-stripe-coins-buy");
const stripeCoinsPackListEl = document.getElementById(
  "vz-stripe-coins-pack-list"
);
const ppStripeCoinsBuyEl = document.getElementById("pp-stripe-coins-buy");
const ppStripeCoinsPackListEl = document.getElementById(
  "pp-stripe-coins-pack-list"
);
const playerTokensEl = $("#player-tokens");
const playerMedalsStripEl = $("#player-medals");

// XP josla
const playerXpBarEl = $("#player-xp-bar");
const playerXpLabelEl = $("#player-xp-label");

// AVATĀRS (profila kartē)
const playerAvatarImgEl = document.getElementById("player-avatar-img");
const playerAvatarInitialsEl = document.getElementById(
  "player-avatar-initials"
);
const playerAvatarUploadBtnEl = document.getElementById(
  "player-avatar-upload-btn"
);
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
const offlineLoginBtn = document.getElementById("vz-offline-login-btn");
const offlineTitleEl = document.getElementById("vz-offline-title");
const offlineTextEl = document.getElementById("vz-offline-text");
const offlineHintEl = document.getElementById("vz-offline-hint");

let _vzConnIssueOverlayTimer = null;
let _vzConnIssueLastKey = "";

const rateOverlayEl = document.getElementById("vz-rate-overlay");
const tutorialOverlayEl = document.getElementById("vz-tutorial-overlay");
const tutorialContentEl = document.getElementById("vz-tutorial-content");
const tutorialDotsEl = document.getElementById("vz-tutorial-dots");
const tutorialSkipBtn = document.getElementById("vz-tutorial-skip");
const tutorialNextBtn = document.getElementById("vz-tutorial-next");
const tutorialReopenBtn = document.getElementById("vz-tutorial-reopen-btn");
const rateLaterBtn = document.getElementById("vz-rate-later-btn");
const rateFeedbackBtn = document.getElementById("vz-rate-feedback-btn");
const rateOpenBtn = document.getElementById("vz-rate-open-btn");

const challengeFriendBtn = document.getElementById("challenge-friend-btn");
const challengeCreateModal = document.getElementById("challenge-create-modal");
const challengeShareUrlInput = document.getElementById("challenge-share-url");
const challengeCopyBtn = document.getElementById("challenge-copy-btn");
const challengeCopyStatus = document.getElementById("challenge-copy-status");
const challengeCreateClose = document.getElementById("challenge-create-close");
const challengeJoinModal = document.getElementById("challenge-join-modal");
const challengeJoinText = document.getElementById("challenge-join-text");
const challengeJoinAccept = document.getElementById("challenge-join-accept");
const challengeJoinDecline = document.getElementById("challenge-join-decline");
const challengeResultOverlay = document.getElementById(
  "challenge-result-overlay"
);
const challengeResultTitle = document.getElementById("challenge-result-title");
const challengeResultDetail = document.getElementById(
  "challenge-result-detail"
);
const challengeResultClose = document.getElementById("challenge-result-close");

const appDownloadLink = document.getElementById("app-download-link");
const appInstallModal = document.getElementById("app-install-modal");
const appInstallPwaBtn = document.getElementById("app-install-pwa-btn");
const appInstallPwaRow = document.getElementById("app-install-pwa-row");
const appInstallClose = document.getElementById("app-install-close");

// DUELA OVERLAY DOM REF
const duelOverlayEl = document.getElementById("duel-result-overlay");
const duelWinnerNameEl = document.getElementById("duel-winner-name");
const duelScoreLineEl = document.getElementById("duel-result-rewards");
const duelExtraMsgEl = document.getElementById("duel-result-reason");
const duelOkBtn = document.getElementById("duel-result-close");

// GALDA SPĒLES (dambrete, šahs)
function boardGamePlayerIndex(players, username) {
  if (!username || !Array.isArray(players)) return -1;
  const want = String(username).trim().toLowerCase();
  for (let i = 0; i < players.length; i++) {
    if (String(players[i] || "").trim().toLowerCase() === want) return i;
  }
  return -1;
}

/**
 * Dambrete/šahs: `turn` ir 0 vai 1. Dažreiz no servera/JSON nāk kā virkne (`"0"`) —
 * tad `myIdx === turn` un `myPlayerIdx === turnIdx` kļūst par false un lauki nav klikšķināmi.
 */
function normalizeTwoPlayerTurn(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return n === 1 ? 1 : 0;
}

function normalizeBoardTurnFromPayload(raw, gameType) {
  if (gameType === "zole") {
    const n = Math.floor(Number(raw));
    if (Number.isFinite(n) && n >= 0 && n <= 2) return n;
    return 0;
  }
  return normalizeTwoPlayerTurn(raw);
}

/** Zole: `boardState.turn` nav vienīgais indikators (likšana / norakšana / spēle). */
function boardZoleIsHumanTurn(myIdx, zole) {
  if (myIdx < 0 || !zole) return false;
  const ph = zole.phase;
  if (ph === "bid") return myIdx === (zole.bidTurn ?? 0);
  if (ph === "discard" && zole.contract === "big")
    return myIdx === zole.contractorIdx;
  if (ph === "play") return myIdx === (zole.turn ?? 0);
  return false;
}

/** Atslēga, lai «Tava kārta» čatā nerādītos atkārtoti vienā un tajā pašā gājienā (Zole: fāze + stiķis). */
function galdaTurnNotifyDedupeKey(gameType, gameId, partial) {
  const id = gameId != null ? String(gameId) : "";
  const z = partial?.zole;
  if (gameType === "zole" && z && typeof z === "object") {
    const ph = String(z.phase || "");
    if (ph === "bid") return `${id}:bid:${z.bidTurn ?? 0}`;
    if (ph === "discard")
      return `${id}:disc:${z.contractorIdx ?? 0}:${String(z.contract || "")}`;
    if (ph === "play")
      return `${id}:play:tp${z.tricksPlayed ?? 0}:tl${z.trickLeader ?? ""}:tr${z.turn ?? 0}`;
    return `${id}:z:${ph}`;
  }
  const turn = normalizeBoardTurnFromPayload(
    partial?.turn,
    gameType || "dambrete"
  );
  let mv = "";
  if (gameType === "chess") {
    mv = String(partial?.move ?? partial?.san ?? "").trim();
  } else if (gameType === "dambrete" && partial?.move != null) {
    try {
      mv = JSON.stringify(partial.move);
    } catch (_) {
      mv = "";
    }
  }
  return `${id}:t${turn}${mv ? ":" + mv : ""}`;
}

/** Rinda: ātri nomainot izvēli pirms pirmās /moves atbildes, pieprasījumi nedrīkst pārklāties. */
function queueBoardLegalMovesFetch(clickedCell, gameType) {
  const gid = boardState.gameId;
  if (!gid) return;
  boardMovesFetchChain = boardMovesFetchChain
    .then(async () => {
      if (!boardState.gameId || boardState.gameId !== gid) return;
      if (
        !boardState.selectedCell ||
        boardState.selectedCell[0] !== clickedCell[0] ||
        boardState.selectedCell[1] !== clickedCell[1]
      ) {
        return;
      }
      const fetchId = ++boardLegalMovesFetchId;
      try {
        const data = await apiGet(`/board/${boardState.gameId}/moves`);
        if (fetchId !== boardLegalMovesFetchId) return;
        if (
          boardState.selectedCell &&
          boardState.selectedCell[0] === clickedCell[0] &&
          boardState.selectedCell[1] === clickedCell[1]
        ) {
          if (gameType === "chess") {
            const base = data && typeof data === "object" ? data : {};
            boardState.legalMoves = {
              moves: Array.isArray(base.moves) ? base.moves : [],
              promotionGroups:
                base.promotionGroups && typeof base.promotionGroups === "object"
                  ? base.promotionGroups
                  : {},
            };
            if (base.chessDrawState) {
              boardState.chessDrawState = base.chessDrawState;
            }
          } else {
            boardState.legalMoves = data || { jumps: [], moves: [] };
          }
          renderBoardGame();
        }
      } catch {}
    })
    .catch(() => {});
}

let boardLegalMovesFetchId = 0;
let boardMovesFetchChain = Promise.resolve();
let boardState = {
  gameId: null,
  type: null,
  players: [],
  turn: 0,
  board: null,
  fen: null,
  zole: null,
  zoleMode: null,
  /** Zole pret botiem: pēc partijas gaida izvēli — nākamā partija vai pēdējā (atcelt auto). */
  zoleVsBotNextHandPending: false,
  vsBot: false,
  dambreteVariant: null,
  selectedCell: null,
  legalMoves: { jumps: [], moves: [] },
  /** Zole 3P: coins par vienu tabulas punktu (0 = fiksēta uzvara). */
  zole3pCoinsPerPoint: 0,
  /** Šahs: servera pulksteņa momentuzņēmums + lokāla ekstrapolācija */
  chessClock: null,
  /** Šahs: neizšķirta piedāvājums / pieteikumu indikatori no servera */
  chessDrawState: null,
  /** Šahs: gaida promocijas SAN izvēli (vairāki derīgi uz vienu lauku) */
  chessPromotionPick: null,
};

const BOARD_BOT_DISPLAY_NAME = "VZBot";
const ZOLE_BOT_USERNAMES = new Set(["ZoleBot1", "ZoleBot2"]);

/** Pēdējais galda rezultāts — revānša pogai */
let lastBoardResultSnapshot = null;
/** Lai «[Galda spēles] Tava kārta» nerādītos atkārtoti katram board.move (piem., šaha pulkstenis). */
let _lastGaldaTurnNotifyKey = null;

let boardInviteOutgoingInterval = null;
let boardInviteIncomingInterval = null;
let boardResultAutoCloseTimer = null;
const BOARD_RESULT_OVERLAY_AUTO_MS = 45 * 1000;

let _chessClockRaf = null;

function clearBoardInviteOutgoingInterval() {
  if (boardInviteOutgoingInterval != null) {
    clearInterval(boardInviteOutgoingInterval);
    boardInviteOutgoingInterval = null;
  }
}

function clearBoardInviteIncomingInterval() {
  if (boardInviteIncomingInterval != null) {
    clearInterval(boardInviteIncomingInterval);
    boardInviteIncomingInterval = null;
  }
}

function clearBoardResultAutoCloseTimer() {
  if (boardResultAutoCloseTimer != null) {
    clearTimeout(boardResultAutoCloseTimer);
    boardResultAutoCloseTimer = null;
  }
}

function syncBoardInvitePendingUi() {
  const pending = document.getElementById("board-invite-pending");
  const text = document.getElementById("board-invite-pending-text");
  const cancelBtn = document.getElementById("board-invite-pending-cancel");
  if (!pending || !text) return;
  const exp = Number(pending.dataset.expiresAt) || 0;
  const target = String(pending.dataset.waitTarget || "").trim();
  const toHost = pending.dataset.waitMode === "to_host";
  const left = Math.max(0, Math.ceil((exp - Date.now()) / 1000));
  if (left > 0 && target) {
    text.textContent = toHost
      ? `Gaidām, kad ${target} pieņems pievienošanos… (${left}s)`
      : `Gaidām atbildi no ${target}… (${left}s)`;
    if (cancelBtn) cancelBtn.classList.remove("hidden");
  } else if (target) {
    text.textContent = "Termiņš beidzies.";
    if (cancelBtn) cancelBtn.classList.add("hidden");
  }
}

function startBoardInviteOutgoingWait(expiresAt, targetUsername, opts = {}) {
  clearBoardInviteOutgoingInterval();
  const pending = document.getElementById("board-invite-pending");
  if (!pending) return;
  pending.dataset.expiresAt = String(Number(expiresAt) || 0);
  pending.dataset.waitTarget = String(targetUsername || "").trim();
  pending.dataset.waitMode = opts.toHost ? "to_host" : "";
  pending.classList.remove("hidden");
  syncBoardInvitePendingUi();
  boardInviteOutgoingInterval = setInterval(() => {
    syncBoardInvitePendingUi();
    const left =
      Math.ceil(
        ((Number(pending.dataset.expiresAt) || 0) - Date.now()) / 1000
      ) || 0;
    if (left <= 0) clearBoardInviteOutgoingInterval();
  }, 1000);
}

function stopBoardInviteOutgoingWait() {
  clearBoardInviteOutgoingInterval();
  const pending = document.getElementById("board-invite-pending");
  const cancelBtn = document.getElementById("board-invite-pending-cancel");
  if (pending) {
    pending.classList.add("hidden");
    pending.dataset.expiresAt = "";
    pending.dataset.waitTarget = "";
    pending.dataset.waitMode = "";
  }
  if (cancelBtn) cancelBtn.classList.add("hidden");
}

function syncBoardInviteIncomingExpiryUi() {
  const invite = document.getElementById("board-games-invite");
  const expEl = document.getElementById("board-invite-expires");
  if (!invite || !expEl) return;
  const exp = Number(invite.dataset.inviteExpiresAt) || 0;
  if (!exp || invite.classList.contains("hidden")) {
    expEl.textContent = "";
    expEl.classList.add("hidden");
    return;
  }
  const left = Math.max(0, Math.ceil((exp - Date.now()) / 1000));
  if (left <= 0) {
    expEl.textContent = "Termiņš beidzies.";
    expEl.classList.remove("hidden");
    return;
  }
  expEl.textContent = `Atlikušas ${left}s`;
  expEl.classList.remove("hidden");
}

function startBoardInviteIncomingExpiry() {
  clearBoardInviteIncomingInterval();
  syncBoardInviteIncomingExpiryUi();
  boardInviteIncomingInterval = setInterval(() => {
    syncBoardInviteIncomingExpiryUi();
    const invite = document.getElementById("board-games-invite");
    const exp = Number(invite?.dataset?.inviteExpiresAt) || 0;
    if (
      !invite ||
      invite.classList.contains("hidden") ||
      Math.ceil((exp - Date.now()) / 1000) <= 0
    ) {
      clearBoardInviteIncomingInterval();
    }
  }, 1000);
}

function stopChessClockTick() {
  if (_chessClockRaf != null) {
    cancelAnimationFrame(_chessClockRaf);
    _chessClockRaf = null;
  }
}

function scheduleChessClockTick() {
  if (_chessClockRaf != null) return;
  _chessClockRaf = requestAnimationFrame(function tick() {
    _chessClockRaf = null;
    if (
      boardState.type !== "chess" ||
      !boardState.gameId ||
      !boardState.chessClock
    ) {
      return;
    }
    syncChessClockDomCore();
    _chessClockRaf = requestAnimationFrame(tick);
  });
}

function ingestChessClockPayload(payload) {
  const c = payload?.chessClock;
  if (!c || !Array.isArray(c.remainingMs) || c.remainingMs.length < 2) {
    boardState.chessClock = null;
    return;
  }
  const now = Date.now();
  boardState.chessClock = {
    remainingMs: [
      Math.max(0, Math.floor(Number(c.remainingMs[0]) || 0)),
      Math.max(0, Math.floor(Number(c.remainingMs[1]) || 0)),
    ],
    incrementMs: Math.max(0, Math.floor(Number(c.incrementMs) || 0)),
    initialMsPerSide: Math.max(
      0,
      Math.floor(Number(c.initialMsPerSide) || 0)
    ),
    lastServerNow: Number(c.serverNow) || now,
    clientReceivedAt: now,
  };
}

function ingestChessDrawStatePayload(s) {
  if (!s || typeof s !== "object") {
    boardState.chessDrawState = null;
    return;
  }
  boardState.chessDrawState = {
    drawOfferFrom: s.drawOfferFrom || null,
    claimFifty: !!s.claimFifty,
    claimThreefold: !!s.claimThreefold,
    halfMoveClock:
      typeof s.halfMoveClock === "number"
        ? s.halfMoveClock
        : Math.max(0, Math.floor(Number(s.halfMoveClock) || 0)),
  };
}

function syncChessDrawControls() {
  const wrap = document.getElementById("board-chess-draw-ui");
  const hint = document.getElementById("board-chess-draw-hint");
  const offerBtn = document.getElementById("board-chess-draw-offer");
  const acceptBtn = document.getElementById("board-chess-draw-accept");
  const claimBtn = document.getElementById("board-chess-claim-draw");
  if (!wrap || !offerBtn || !acceptBtn || !claimBtn) return;

  const ingame =
    boardState.gameId &&
    boardState.type === "chess" &&
    boardState.fen &&
    !boardState.vsBot;
  wrap.classList.toggle("hidden", !ingame);
  if (!ingame) {
    if (hint) hint.classList.add("hidden");
    return;
  }

  const ds = boardState.chessDrawState;
  const myIdx = boardGamePlayerIndex(boardState.players, state.username);
  const myTurn = myIdx === boardState.turn;
  const offerFrom = ds?.drawOfferFrom
    ? String(ds.drawOfferFrom).trim()
    : "";
  const me = String(state.username || "").trim();
  const offeredToMe =
    offerFrom &&
    me &&
    offerFrom.toLowerCase() !== me.toLowerCase();

  offerBtn.classList.toggle("hidden", !myTurn);
  acceptBtn.classList.toggle("hidden", !(myTurn && offeredToMe));
  const canClaim =
    myTurn &&
    !!(ds?.claimFifty || ds?.claimThreefold);
  claimBtn.classList.toggle("hidden", !canClaim);

  if (hint) {
    const parts = [];
    if (offerFrom) {
      parts.push(
        offeredToMe && myTurn
          ? `${offerFrom} piedāvā neizšķirtu — vari pieņemt.`
          : offerFrom.toLowerCase() === me.toLowerCase()
            ? "Tu piedāvāji neizšķirtu — gaida pretinieka atbildi."
            : `${offerFrom} piedāvā neizšķirtu.`
      );
    }
    if (typeof ds?.halfMoveClock === "number") {
      parts.push(`Pusgājienu skaitītājs (50 gāj. likums): ${ds.halfMoveClock}/100.`);
    }
    if (ds?.claimThreefold && myTurn) {
      parts.push("Ir trīskāršs atkārtojums — savā gājienā vari pieteikt neizšķirtu.");
    }
    if (ds?.claimFifty && myTurn) {
      parts.push("Ir izpildīts 50 gājienu likums — savā gājienā vari pieteikt neizšķirtu.");
    }
    hint.textContent = parts.join(" ");
    hint.classList.toggle("hidden", parts.length === 0);
  }
}

function formatChessClockMs(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function syncChessClockDomCore() {
  const wrap = document.getElementById("board-chess-clocks");
  const t0 = document.getElementById("board-chess-clock-0");
  const t1 = document.getElementById("board-chess-clock-1");
  const l0 = document.getElementById("board-chess-clock-0-label");
  const l1 = document.getElementById("board-chess-clock-1-label");
  const clk = boardState.chessClock;
  const cells = wrap?.querySelectorAll(".vz-board-chess-clock");
  if (!wrap || !t0 || !t1 || !clk) return;
  const skew = clk.clientReceivedAt - clk.lastServerNow;
  const serverNowEst = Date.now() - skew;
  const sinceSnap = Math.max(0, serverNowEst - clk.lastServerNow);
  const turn = boardState.turn;
  let w = clk.remainingMs[0] - (turn === 0 ? sinceSnap : 0);
  let b = clk.remainingMs[1] - (turn === 1 ? sinceSnap : 0);
  w = Math.max(0, w);
  b = Math.max(0, b);
  const p0 = boardState.players[0] || "?";
  const p1 = boardState.players[1] || "?";
  const bot0 = String(p0).trim() === BOARD_BOT_DISPLAY_NAME;
  const bot1 = String(p1).trim() === BOARD_BOT_DISPLAY_NAME;
  if (l0) l0.textContent = bot0 ? "Bots (baltais)" : `${p0} (baltais)`;
  if (l1) l1.textContent = bot1 ? "Bots (melnais)" : `${p1} (melnais)`;
  t0.textContent = bot0 && boardState.vsBot ? "∞" : formatChessClockMs(w);
  t1.textContent = bot1 && boardState.vsBot ? "∞" : formatChessClockMs(b);
  if (cells && cells.length >= 2) {
    cells[0].classList.toggle("vz-board-chess-clock--active", turn === 0);
    cells[1].classList.toggle("vz-board-chess-clock--active", turn === 1);
    cells[0].classList.toggle("vz-board-chess-clock--low", w > 0 && w <= 30_000);
    cells[1].classList.toggle("vz-board-chess-clock--low", b > 0 && b <= 30_000);
  }
}

function syncChessClockDom() {
  const wrap = document.getElementById("board-chess-clocks");
  const cells = wrap?.querySelectorAll(".vz-board-chess-clock");
  if (
    !wrap ||
    boardState.type !== "chess" ||
    !boardState.gameId ||
    !boardState.chessClock
  ) {
    stopChessClockTick();
    if (wrap) wrap.classList.add("hidden");
    if (cells) {
      cells[0]?.classList.remove("vz-board-chess-clock--active", "vz-board-chess-clock--low");
      cells[1]?.classList.remove("vz-board-chess-clock--active", "vz-board-chess-clock--low");
    }
    return;
  }
  wrap.classList.remove("hidden");
  syncChessClockDomCore();
  scheduleChessClockTick();
}

/** Atvērtā 3 spēlētāju zoles istaba (līdz spēles sākumam vai atcelšanai) */
let zole3pLobbySnapshot = null;
let zole3pThirdInviteInterval = null;

function stopZole3pThirdInviteTicker() {
  if (zole3pThirdInviteInterval != null) {
    clearInterval(zole3pThirdInviteInterval);
    zole3pThirdInviteInterval = null;
  }
}

function clearZole3pThirdInviteCountdown() {
  stopZole3pThirdInviteTicker();
  const cd = document.getElementById("board-zole-3p-invite-countdown");
  if (cd) {
    cd.textContent = "";
    cd.classList.add("hidden");
  }
}

function syncZole3pThirdInviteCountdownFromSnapshot() {
  const snap = zole3pLobbySnapshot;
  const cd = document.getElementById("board-zole-3p-invite-countdown");
  if (!snap?.zoleLobby || !cd) {
    clearZole3pThirdInviteCountdown();
    return;
  }
  const exp = Number(snap.thirdInviteExpiresAt) || 0;
  const invited = snap.invitedThird;
  if (!invited || !exp) {
    clearZole3pThirdInviteCountdown();
    return;
  }
  stopZole3pThirdInviteTicker();
  const tick = () => {
    const left = Math.max(0, Math.ceil((exp - Date.now()) / 1000));
    if (left <= 0) {
      stopZole3pThirdInviteTicker();
      cd.textContent =
        " Termiņš beidzies — vari uzaicināt citu vai atkārtoti sūtīt.";
      cd.classList.remove("hidden");
      return;
    }
    cd.textContent = ` Trešā atbilde: atlikušas ${left}s.`;
    cd.classList.remove("hidden");
  };
  tick();
  zole3pThirdInviteInterval = setInterval(tick, 1000);
}

/** Servera saraksts ar brīvajām 3P zoles istabām (globāls broadcast) */
let zole3pOpenLobbiesCache = { rooms: [], serverNow: 0 };
let zole3pOpenLobbyPollTimer = null;

/** Publiskās PvP vietas šaham / dambretēm */
let boardOpenSeatsCache = { chess: [], dambrete: [], serverNow: 0 };
let boardOpenSeatsPollTimer = null;

function clearBoardOpenSeatsPoll() {
  if (boardOpenSeatsPollTimer != null) {
    clearInterval(boardOpenSeatsPollTimer);
    boardOpenSeatsPollTimer = null;
  }
}

function scheduleBoardOpenSeatsPoll() {
  clearBoardOpenSeatsPoll();
  if (!state.socket || typeof state.socket.emit !== "function") return;
  boardOpenSeatsPollTimer = setInterval(() => {
    try {
      state.socket.emit("board.requestOpenSeats");
    } catch (_) {}
  }, 15000);
}

function dambreteVariantLabelClient(v) {
  const x = String(v || "russian").toLowerCase();
  return x === "english" ? "Angļu dambrete" : "Krievijas šaškas";
}

function renderBoardOpenSeatsTable(kind) {
  const wrapId =
    kind === "chess"
      ? "board-chess-open-seats"
      : "board-dambrete-open-seats";
  const tbodyId =
    kind === "chess"
      ? "board-chess-open-seats-body"
      : "board-dambrete-open-seats-body";
  const emptyId =
    kind === "chess"
      ? "board-chess-open-seats-empty"
      : "board-dambrete-open-seats-empty";
  const wrap = document.getElementById(wrapId);
  const tbody = document.getElementById(tbodyId);
  const emptyEl = document.getElementById(emptyId);
  if (!wrap || !tbody) return;
  const rows =
    kind === "chess"
      ? Array.isArray(boardOpenSeatsCache?.chess)
        ? boardOpenSeatsCache.chess
        : []
      : Array.isArray(boardOpenSeatsCache?.dambrete)
        ? boardOpenSeatsCache.dambrete
        : [];
  const me = String(state.username || "").trim().toLowerCase();
  const inGame = !!boardState.gameId;
  if (emptyEl) {
    if (rows.length === 0) {
      fillVzEmptyState(emptyEl, {
        glyph: kind === "chess" ? "♔" : "♟️",
        title: "Neviens negaida pretinieku",
        text: "Publicē savu vietu zemāk vai uzaicini draugu.",
        compact: true,
        extraClass: "vz-board-zole-open-lobbies__empty-inner",
      });
      emptyEl.classList.remove("hidden");
    } else {
      emptyEl.classList.add("hidden");
      emptyEl.innerHTML = "";
    }
  }
  if (rows.length === 0) {
    tbody.innerHTML = "";
    syncMyBoardOpenSeatButtons();
    return;
  }
  const html = rows.map((r) => {
    const host = String(r?.host || "—");
    const hostLc = host.trim().toLowerCase();
    const detail =
      kind === "chess"
        ? String(r?.chessClockPreset || "—").trim() || "—"
        : dambreteVariantLabelClient(r?.dambreteVariant);
    let btnLabel = "Pievienoties";
    let disabled = false;
    let title = "";
    if (hostLc && me && hostLc === me) {
      btnLabel = "Tu";
      disabled = true;
      title = "Tava publicētā vieta.";
    } else if (inGame) {
      disabled = true;
      title = "Vispirms beidz pašreizējo spēli.";
    }
    const dataType = kind === "chess" ? "chess" : "dambrete";
    return `<tr data-open-seat-host="${escapeHtml(host)}" data-open-seat-type="${dataType}">
      <td>${escapeHtml(host)}</td>
      <td>${escapeHtml(detail)}</td>
      <td><button type="button" class="vz-board-zole-open-lobbies__join js-board-open-seat-join" data-open-seat-host="${escapeHtml(host)}" data-open-seat-type="${dataType}" ${disabled ? "disabled" : ""} title="${escapeHtml(title)}">${escapeHtml(btnLabel)}</button></td>
    </tr>`;
  });
  tbody.innerHTML = html.join("");
  syncMyBoardOpenSeatButtons();
}

function syncMyBoardOpenSeatButtons() {
  const me = String(state.username || "").trim().toLowerCase();
  const chessList = Array.isArray(boardOpenSeatsCache?.chess)
    ? boardOpenSeatsCache.chess
    : [];
  const dList = Array.isArray(boardOpenSeatsCache?.dambrete)
    ? boardOpenSeatsCache.dambrete
    : [];
  const inChess = chessList.some(
    (r) => String(r?.host || "").trim().toLowerCase() === me
  );
  const inDamb = dList.some(
    (r) => String(r?.host || "").trim().toLowerCase() === me
  );
  document
    .getElementById("board-chess-open-seat-publish")
    ?.classList.toggle("hidden", inChess);
  document
    .getElementById("board-chess-open-seat-cancel")
    ?.classList.toggle("hidden", !inChess);
  document
    .getElementById("board-dambrete-open-seat-publish")
    ?.classList.toggle("hidden", inDamb);
  document
    .getElementById("board-dambrete-open-seat-cancel")
    ?.classList.toggle("hidden", !inDamb);
}

function syncBoardOpenSeatsPanelVisibility() {
  const chessWrap = document.getElementById("board-chess-open-seats");
  const dambWrap = document.getElementById("board-dambrete-open-seats");
  const lobbyEl = document.getElementById("board-games-lobby");
  const lobbyVisible = lobbyEl && !lobbyEl.classList.contains("hidden");
  const inInvite = (() => {
    const invite = document.getElementById("board-games-invite");
    return invite && !invite.classList.contains("hidden");
  })();
  const show = lobbyVisible && !inInvite && !boardState.gameId;
  if (chessWrap) {
    chessWrap.classList.toggle("hidden", !show);
    if (show) {
      renderBoardOpenSeatsTable("chess");
      scheduleBoardOpenSeatsPoll();
    }
  }
  if (dambWrap) {
    dambWrap.classList.toggle("hidden", !show);
    if (show) {
      renderBoardOpenSeatsTable("dambrete");
      scheduleBoardOpenSeatsPoll();
    }
  }
  if (!show) {
    clearBoardOpenSeatsPoll();
    return;
  }
  try {
    state.socket?.emit("board.requestOpenSeats");
  } catch (_) {}
}

function clearZole3pOpenLobbyPoll() {
  if (zole3pOpenLobbyPollTimer != null) {
    clearInterval(zole3pOpenLobbyPollTimer);
    zole3pOpenLobbyPollTimer = null;
  }
}

function scheduleZole3pOpenLobbyPoll() {
  clearZole3pOpenLobbyPoll();
  if (!state.socket || typeof state.socket.emit !== "function") return;
  zole3pOpenLobbyPollTimer = setInterval(() => {
    try {
      state.socket.emit("board.zoleRequestOpenLobbies");
    } catch (_) {}
  }, 12000);
}

function renderZole3pOpenLobbyTable() {
  const wrap = document.getElementById("board-zole-3p-open-lobbies");
  const tbody = document.getElementById("board-zole-3p-open-lobbies-body");
  const emptyEl = document.getElementById("board-zole-3p-open-lobbies-empty");
  if (!wrap || !tbody) return;
  const me = String(state.username || "").trim().toLowerCase();
  const inGame = !!boardState.gameId;
  const inLobby = !!zole3pLobbySnapshot?.zoleLobby;
  const myLobbyId = inLobby
    ? String(zole3pLobbySnapshot?.lobbyId || "").trim()
    : "";
  const rooms = Array.isArray(zole3pOpenLobbiesCache?.rooms)
    ? zole3pOpenLobbiesCache.rooms
    : [];
  if (emptyEl) {
    if (rooms.length === 0) {
      fillVzEmptyState(emptyEl, {
        glyph: "🃏",
        title: "Vēl neviena atvērta istaba",
        text: "Izveido savu zemāk vai atgriezies pēc brīža.",
        compact: true,
        extraClass: "vz-board-zole-open-lobbies__empty-inner",
      });
      emptyEl.classList.remove("hidden");
    } else {
      emptyEl.classList.add("hidden");
      emptyEl.innerHTML = "";
    }
  }
  if (rooms.length === 0) {
    tbody.innerHTML = "";
    return;
  }
  const rows = rooms.map((r) => {
    const lid = String(r?.lobbyId || "").trim();
    const host = String(r?.host || "—");
    const n = Math.max(0, Math.floor(Number(r?.playerCount) || 0));
    const open = Math.max(0, Math.floor(Number(r?.openSeats) || 0));
    const stake = String(r?.stakeLabel || "—");
    const pending = !!r?.hasPendingInvite;
    const inThis =
      me &&
      Array.isArray(r?.players) &&
      r.players.some((p) => String(p || "").toLowerCase() === me);
    let btnLabel = "Pievienoties";
    let disabled = false;
    let title = "";
    if (inGame) {
      disabled = true;
      title = "Vispirms beidz pašreizējo spēli.";
    } else if (inLobby && !inThis) {
      disabled = true;
      title = "Vispirms pamet savu istabu.";
    } else if (pending) {
      disabled = true;
      title = "Saimnieks gaida uzaicināta spēlētāja atbildi.";
    } else if (inThis) {
      btnLabel = myLobbyId === lid ? "Atvērt" : "Jau istabā";
      disabled = myLobbyId === lid ? false : true;
      title =
        myLobbyId === lid
          ? "Atver lobby skatu."
          : "Tu jau esi šīs istabas dalībnieks.";
    }
    const oc = open > 0 && !pending ? `${n}/3` : `${n}/3 · gaida`;
    return `<tr data-zole-lobby-id="${escapeHtml(lid)}">
      <td>${escapeHtml(host)}</td>
      <td>${escapeHtml(oc)}</td>
      <td>${escapeHtml(stake)}</td>
      <td><button type="button" class="vz-board-zole-open-lobbies__join js-zole-open-lobby-join" data-zole-lobby-id="${escapeHtml(lid)}" ${disabled ? "disabled" : ""} title="${escapeHtml(title)}">${escapeHtml(btnLabel)}</button></td>
    </tr>`;
  });
  tbody.innerHTML = rows.join("");
}

function syncZole3pOpenLobbyPanelVisibility() {
  const wrap = document.getElementById("board-zole-3p-open-lobbies");
  if (!wrap) return;
  const lobbyEl = document.getElementById("board-games-lobby");
  const lobbyVisible = lobbyEl && !lobbyEl.classList.contains("hidden");
  const inInvite = (() => {
    const invite = document.getElementById("board-games-invite");
    return invite && !invite.classList.contains("hidden");
  })();
  const inZoleRoomFlow =
    getSelectedBoardZoleMode() === "online_3p" ||
    !!zole3pLobbySnapshot?.zoleLobby;
  const show =
    lobbyVisible && !inInvite && inZoleRoomFlow && !boardState.gameId;
  wrap.classList.toggle("hidden", !show);
  if (show) {
    renderZole3pOpenLobbyTable();
    scheduleZole3pOpenLobbyPoll();
  } else {
    clearZole3pOpenLobbyPoll();
  }
  syncBoardOpenSeatsPanelVisibility();
}

function syncZole3pStakeSelectFromLobby() {
  const sel = document.getElementById("board-zole-3p-stake");
  if (!sel) return;
  if (!zole3pLobbySnapshot?.zoleLobby) {
    sel.disabled = false;
    return;
  }
  const cpp = Math.max(
    0,
    Math.min(5, Math.floor(Number(zole3pLobbySnapshot?.zole3pCoinsPerPoint) || 0))
  );
  sel.value = String(cpp);
  const host = String(zole3pLobbySnapshot?.host || "").trim();
  const me = String(state.username || "").trim();
  const isHost =
    host && me && host.toLowerCase() === me.toLowerCase();
  const n = (zole3pLobbySnapshot?.players || []).length;
  sel.disabled = !isHost || n >= 3;
}

function syncZoleStakeBannerInGameArea() {
  const el = document.getElementById("board-zole-stake-banner");
  if (!el) return;
  const cpp = Math.max(
    0,
    Math.min(5, Math.floor(Number(boardState.zole3pCoinsPerPoint) || 0))
  );
  const is3p =
    boardState.type === "zole" &&
    boardState.zoleMode === "online_3p" &&
    !boardState.vsBot;
  if (!is3p || cpp <= 0) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.classList.remove("hidden");
  el.textContent = `Likme šajā spēlē: ${cpp} coins par katru tabulas punktu (+/− pēc partijas tabulas).`;
}

function updateZole3pLobbyUI(payload) {
  const box = document.getElementById("board-zole-3p-lobby");
  const textEl = document.getElementById("board-zole-3p-lobby-text");
  const hostAct = document.getElementById("board-zole-3p-host-actions");
  const guestHint = document.getElementById("board-zole-3p-guest-hint");
  const guestLeave = document.getElementById("board-zole-3p-guest-actions");
  const lobby = document.getElementById("board-games-lobby");
  const pending = document.getElementById("board-invite-pending");
  if (!payload?.zoleLobby) {
    zole3pLobbySnapshot = null;
    clearZole3pThirdInviteCountdown();
    if (box) box.classList.add("hidden");
    if (pending) pending.classList.add("hidden");
    if (payload?.cancelled)
      appendGaldaSystemMessage("Zoles istaba atcelta.");
    syncZole3pStakeSelectFromLobby();
    syncBoardDambreteModePanelVisibility();
    syncZole3pOpenLobbyPanelVisibility();
    syncBoardOpenSeatsPanelVisibility();
    return;
  }
  zole3pLobbySnapshot = payload;
  syncZole3pStakeSelectFromLobby();
  const host = payload.host || "";
  const players = payload.players || [];
  const me = String(state.username || "").trim();
  const isHost =
    host && me && host.trim().toLowerCase() === me.toLowerCase();
  const inLobby = players.some(
    (p) => me && String(p).trim().toLowerCase() === me.toLowerCase()
  );
  if (box) box.classList.remove("hidden");
  if (lobby) lobby.classList.remove("hidden");
  const gameArea = document.getElementById("board-game-area");
  const inviteEl = document.getElementById("board-games-invite");
  if (gameArea) gameArea.classList.add("hidden");
  if (inviteEl) inviteEl.classList.add("hidden");
  if (pending) pending.classList.add("hidden");
  const invited = payload.invitedThird;
  const n = players.length;
  const cpp = Math.max(
    0,
    Math.min(5, Math.floor(Number(payload.zole3pCoinsPerPoint) || 0))
  );
  const stakeTxt =
    cpp > 0
      ? ` Likme: ${cpp} coins/tabulas punkts.`
      : " Likme: kā parasti (+10 uzvara, −4 zaudējums).";
  const coreEl = document.getElementById("board-zole-3p-lobby-core");
  if (coreEl) {
    if (n >= 3) {
      coreEl.textContent = `Istabā 3 spēlētāji — spēle sākas… (${players.join(", ")})`;
    } else {
      const wait =
        invited != null && invited !== ""
          ? ` Gaidām atbildi no: ${invited}.`
          : "";
      coreEl.textContent = `Zoles istaba · saimnieks: ${host}. Spēlētāji (${n}/3): ${players.join(", ") || "—"}.${wait}${stakeTxt} Kad būs 3, spēle sākas automātiski.`;
    }
  } else if (textEl) {
    if (n >= 3) {
      textEl.textContent = `Istabā 3 spēlētāji — spēle sākas… (${players.join(", ")})`;
    } else {
      const wait =
        invited != null && invited !== ""
          ? ` Gaidām atbildi no: ${invited}.`
          : "";
      textEl.textContent = `Zoles istaba · saimnieks: ${host}. Spēlētāji (${n}/3): ${players.join(", ") || "—"}.${wait}${stakeTxt} Kad būs 3, spēle sākas automātiski.`;
    }
  }
  syncZole3pThirdInviteCountdownFromSnapshot();
  if (hostAct) hostAct.classList.toggle("hidden", !isHost);
  if (guestHint)
    guestHint.classList.toggle("hidden", isHost || !inLobby || n >= 3);
  if (guestLeave)
    guestLeave.classList.toggle("hidden", !inLobby || isHost || n >= 3);
  syncBoardDambreteModePanelVisibility();
  syncZole3pOpenLobbyPanelVisibility();
  syncBoardOpenSeatsPanelVisibility();
}

function normalizeDambreteVariantClient(v) {
  return String(v || "russian").toLowerCase() === "english"
    ? "english"
    : "russian";
}

function boardDambreteModeLabel(variant) {
  return normalizeDambreteVariantClient(variant) === "english"
    ? "Angļu dambrete"
    : "Krievijas šaškas";
}

function getSelectedBoardDambreteVariant() {
  const el = document.querySelector(
    'input[name="board-dambrete-variant"]:checked'
  );
  return normalizeDambreteVariantClient(el?.value);
}

function getSelectedBoardZoleMode() {
  const el = document.querySelector('input[name="board-zole-mode"]:checked');
  const v = String(el?.value || "online_3p").toLowerCase();
  if (v === "vs_bot") return "vs_bot";
  if (v === "online_2p") return "online_2p";
  return "online_3p";
}

function getChessClockPresetForPvp() {
  const sel = document.getElementById("board-chess-time-preset");
  return String(sel?.value || "10+0").trim() || "10+0";
}

function getChessClockPresetForVsBot() {
  const sel = document.getElementById("board-chess-time-preset-vsbot");
  return String(sel?.value || "10+0").trim() || "10+0";
}

function syncBoardChessTimeRowVisibility() {
  const rowPvp = document.getElementById("board-chess-time-row");
  const rowBot = document.getElementById("board-chess-time-row-vsbot");
  const zm = getSelectedBoardZoleMode();
  const in3p = zm === "online_3p" || !!zole3pLobbySnapshot?.zoleLobby;
  if (rowPvp) rowPvp.classList.toggle("hidden", in3p);
  if (rowBot) rowBot.classList.remove("hidden");
}

function boardZoleModeLabel(mode) {
  if (mode === "vs_bot") return "pret botiem";
  if (mode === "online_2p") return "2 cilvēki + bots";
  if (mode === "online_3p") return "3 cilvēki (istaba)";
  return String(mode || "");
}

function hideBoardResultOverlay() {
  clearBoardResultAutoCloseTimer();
  document
    .getElementById("board-result-play-again-vsbot")
    ?.classList.add("hidden");
  document.getElementById("board-result-overlay")?.classList.add("hidden");
  document.getElementById("board-result-rematch")?.classList.add("hidden");
  document.getElementById("board-result-rematch-status")?.classList.add("hidden");
  const modal = document.getElementById("board-games-modal");
  const inner = document.getElementById("board-modal-inner");
  if (modal && !modal.classList.contains("hidden") && inner) {
    inner.focus({ preventScroll: true });
  } else if (_boardResultFocusReturn && typeof _boardResultFocusReturn.focus === "function") {
    try {
      _boardResultFocusReturn.focus({ preventScroll: true });
    } catch (_) {}
  }
  _boardResultFocusReturn = null;
}

function boardGameOpponentName(players, vsBot) {
  const arr = players || [];
  const me = state.username;
  const idx = boardGamePlayerIndex(arr, me);
  if (arr.length === 3 && boardState.type === "zole" && boardState.zoleMode === "online_3p") {
    const others = arr.filter(
      (_, i) => i !== idx
    );
    return others.length ? others.join(", ") : "pretinieki";
  }
  const opp = idx === 0 ? arr[1] : arr[0];
  if (!opp) return "pretinieks";
  if (vsBot && String(opp) === BOARD_BOT_DISPLAY_NAME) return "botu (VZBot)";
  return String(opp);
}

function boardResultHumanOpponentUsername(players) {
  const arr = players || [];
  const meLc = String(state.username || "").trim().toLowerCase();
  const humans = arr.filter((p) => {
    const s = String(p || "").trim();
    if (!s) return false;
    if (s === BOARD_BOT_DISPLAY_NAME) return false;
    if (ZOLE_BOT_USERNAMES.has(s)) return false;
    return true;
  });
  const others = humans.filter(
    (p) => String(p || "").trim().toLowerCase() !== meLc
  );
  if (others.length !== 1) return "";
  return String(others[0] || "").trim();
}

function isBoardResultRematchEligible(snap) {
  if (!snap || snap.vsBot) return false;
  const t = snap.gameType;
  if (t !== "dambrete" && t !== "chess" && t !== "zole") return false;
  if (t === "zole" && snap.zoleMode !== "online_2p") return false;
  return !!snap.opponentUsername;
}

function syncBoardResultRematchUi() {
  const btn = document.getElementById("board-result-rematch");
  const st = document.getElementById("board-result-rematch-status");
  const overlay = document.getElementById("board-result-overlay");
  if (st) {
    st.textContent = "";
    st.classList.add("hidden");
  }
  if (!btn) return;
  const show =
    overlay &&
    !overlay.classList.contains("hidden") &&
    isBoardResultRematchEligible(lastBoardResultSnapshot);
  btn.classList.toggle("hidden", !show);
  btn.disabled = false;
  if (show) clearBoardResultAutoCloseTimer();
}

function sendBoardRematchInvite() {
  const snap = lastBoardResultSnapshot;
  if (!isBoardResultRematchEligible(snap)) return;
  if (!boardGamesEnsureSocketConnected()) return;
  const opp = snap.opponentUsername;
  const type = snap.gameType;
  const payload = { type, opponentUsername: opp };
  if (type === "dambrete")
    payload.dambreteVariant = snap.dambreteVariant || "russian";
  if (type === "zole") payload.zoleMode = "online_2p";
  if (type === "chess")
    payload.chessClockPreset =
      snap.chessClockPreset || getChessClockPresetForPvp();
  state.socket.emit("board.rematchRequest", payload);
  const st = document.getElementById("board-result-rematch-status");
  if (st) {
    st.textContent = `Revānša uzaicinājums nosūtīts: ${opp}. Gaidām atbildi…`;
    st.classList.remove("hidden");
  }
  const btn = document.getElementById("board-result-rematch");
  if (btn) btn.disabled = true;
  hideBoardResultOverlay();
  showBoardModal();
  appendGaldaSystemMessage(`Revānšs: uzaicinājums nosūtīts ${opp}.`);
}

function zoleResultExtraLine(snap) {
  const lr = snap?.lastResult;
  if (!lr || !lr.kind) return "";
  if (lr.kind === "galdins" && !lr.tie && lr.loserNoTricks)
    return " Galdiņš: zaudētājam bezstiķis.";
  if (lr.kind === "galds" && lr.loserNoTricks)
    return " Galds: zaudētājam bezstiķis.";
  if (lr.kind === "big" && lr.win && lr.opponentsNoTricks)
    return " Mazajiem bezstiķis.";
  if (lr.kind === "big" && !lr.win && lr.contractorNoTricks)
    return " Lielajam bezstiķis.";
  if (lr.kind === "zole" && lr.win && lr.allTricks) return " Visi stiķi.";
  if (lr.kind === "zole" && !lr.win && lr.contractorNoTricks)
    return " Lielajam bezstiķis.";
  return "";
}

function showBoardGameResult(payload) {
  const overlay = document.getElementById("board-result-overlay");
  const eyebrow = document.getElementById("board-result-eyebrow");
  const titleEl = document.getElementById("board-result-title");
  const detailEl = document.getElementById("board-result-detail");
  const coinsEl = document.getElementById("board-result-coins");
  if (!overlay || !titleEl || !detailEl) return;

  const gameType = payload?.type || boardState.type || "dambrete";
  const vsBot = !!payload?.vsBot;
  const players = payload?.players || boardState.players || [];
  const winner = payload?.winner ?? null;
  const reason = String(payload?.reason || "finished");
  const resignedBy = payload?.resignedBy;
  const coinsGain = Number(payload?.coinsGain) || 0;
  const coinsLoss = Number(payload?.coinsLoss) || 0;
  const me = state.username;
  const oppName = boardGameOpponentName(players, vsBot);
  const oppPhrase =
    vsBot && oppName.startsWith("botu")
      ? oppName
      : `pret ${oppName}`;
  const dVar =
    gameType === "dambrete"
      ? normalizeDambreteVariantClient(
          payload?.dambreteVariant ?? boardState.dambreteVariant
        )
      : null;
  const gameLabel =
    gameType === "chess"
      ? "Šahs"
      : gameType === "zole"
        ? "Zole"
        : `Dambrete (${boardDambreteModeLabel(dVar)})`;

  let chessPresetSnap = "";
  if (gameType === "chess" && boardState.chessClock) {
    const ck = boardState.chessClock;
    chessPresetSnap = `${Math.max(
      1,
      Math.round((Number(ck.initialMsPerSide) || 600000) / 60000)
    )}+${Math.max(0, Math.round((Number(ck.incrementMs) || 0) / 1000))}`;
  }
  lastBoardResultSnapshot = {
    gameType,
    vsBot,
    zoleMode: gameType === "zole" ? boardState.zoleMode : null,
    dambreteVariant: gameType === "dambrete" ? dVar : null,
    opponentUsername: boardResultHumanOpponentUsername(players),
    chessClockPreset: gameType === "chess" ? chessPresetSnap : undefined,
  };

  overlay.classList.remove(
    "vz-board-result--win",
    "vz-board-result--loss",
    "vz-board-result--draw"
  );

  let title = "";
  let detail = "";
  let eyebrowText =
    gameType === "chess"
      ? "ŠAHS · SPĒLES REZULTĀTS"
      : gameType === "zole"
        ? "ZOLE · SPĒLES REZULTĀTS"
        : `DAMBRETE · ${boardDambreteModeLabel(dVar).toUpperCase()} · REZULTĀTS`;

  const iWon =
    winner && me && String(winner).trim().toLowerCase() === String(me).trim().toLowerCase();
  const iLost = winner && me && !iWon;

  if (!winner) {
    if (gameType === "chess" && reason === "timeout") {
      title = "Laiks beidzies";
      const to = payload?.timedOutPlayer;
      detail = to
        ? `${to} neizdarīja gājienu laikā — neizšķirts tabulā (nav mata).`
        : "Kādam beidzās laiks — spēle beigusies bez uzvarētāja.";
      overlay.classList.add("vz-board-result--draw");
    } else if (
      gameType === "zole" &&
      vsBot &&
      reason === "zole_vs_bot_last_hand_done"
    ) {
      title = "Mačs beidzies";
      detail =
        "Pēdējā partija pret botiem ir izspēlēta. Vari turpināt vārdu spēli vai atvērt «Galda spēles» jaunai spēlei.";
      overlay.classList.add("vz-board-result--draw");
    } else {
      title = "Neizšķirts";
      if (gameType === "chess" && reason === "draw_agreement") {
        const by = payload?.agreedBy;
        const from = payload?.offeredBy;
        detail =
          by && from
            ? `Abas puses vienojās par neizšķirtu (${from} piedāvāja, ${by} pieņēma).`
            : "Abas puses vienojās par neizšķirtu.";
      } else if (gameType === "chess" && reason === "draw_claim_fifty") {
        detail = `${payload?.claimedBy || "Spēlētājs"} pieteica neizšķirtu pēc 50 gājienu likuma.`;
      } else if (gameType === "chess" && reason === "draw_claim_threefold") {
        detail = `${payload?.claimedBy || "Spēlētājs"} pieteica neizšķirtu pēc trīskārša atkārtojuma.`;
      } else if (gameType === "chess" && reason === "draw_claim_both") {
        detail = `${payload?.claimedBy || "Spēlētājs"} pieteica neizšķirtu (50 gājienu likums un trīskāršs atkārtojums).`;
      } else {
        detail =
          reason === "draw"
            ? "Partija beidzās neizšķirti."
            : "Spēle beigusies bez uzvarētāja.";
      }
      overlay.classList.add("vz-board-result--draw");
    }
  } else if (iWon) {
    title = "Uzvara";
    if (reason === "timeout") {
      detail = vsBot
        ? "Tu uzvarēji — botam beidzās laiks."
        : `Tu uzvarēji — pretiniekam beidzās laiks${oppName ? ` (${oppName})` : ""}.`;
    } else if (reason === "resign") {
      detail =
        resignedBy && String(resignedBy).trim().toLowerCase() !== String(me).trim().toLowerCase()
          ? vsBot
            ? "Bots padodas — uzvara tev."
            : `Tu uzvarēji — ${oppName} padodas.`
          : `Tu uzvarēji ${oppPhrase}.`;
    } else if (reason === "checkmate") {
      detail = `Tu uzvarēji ar matu ${oppPhrase}.`;
    } else if (gameType === "zole") {
      const snap = payload?.zole || boardState.zole;
      const td = snap?.tableDelta;
      const myI = boardGamePlayerIndex(players, me);
      const tab =
        td &&
        myI >= 0 &&
        typeof td[myI] === "number" &&
        td[myI] !== 0
          ? ` Tabulā šai partijai: ${td[myI] > 0 ? "+" : ""}${td[myI]} p.`
          : "";
      detail =
        (boardState.zoleMode === "online_3p"
          ? "Labākais tabulas rezultāts (3 cilvēki, bez bota)."
          : boardState.zoleMode === "online_2p"
            ? "Labākais tabulas rezultāts (2 cilvēki + bots)."
            : "Labākais tabulas rezultāts (pret botiem).") +
        tab +
        zoleResultExtraLine(snap);
    } else {
      detail = `Tu uzvarēji ${oppPhrase}.`;
    }
    overlay.classList.add("vz-board-result--win");
  } else {
    title = "Zaudējums";
    if (reason === "timeout") {
      detail = "Tev beidzās laiks — zaudēji uz laiku.";
    } else if (reason === "resign") {
      detail =
        resignedBy &&
        String(resignedBy).trim().toLowerCase() === String(me).trim().toLowerCase()
          ? "Tu padodies — spēle zaudēta."
          : vsBot
            ? `Tu zaudēji — uzvarēja ${oppName}.`
            : `Tu zaudēji pret ${String(winner)}.`;
    } else if (reason === "checkmate") {
      detail = vsBot
        ? `Tu zaudēji — ${oppName} uzvarēja ar matu.`
        : `Tu zaudēji — ${String(winner)} uzvarēja ar matu.`;
    } else if (gameType === "zole") {
      const snap = payload?.zole || boardState.zole;
      const td = snap?.tableDelta;
      const myI = boardGamePlayerIndex(players, me);
      const tab =
        td &&
        myI >= 0 &&
        typeof td[myI] === "number" &&
        td[myI] !== 0
          ? ` Tabulā: ${td[myI] > 0 ? "+" : ""}${td[myI]} p.`
          : "";
      detail =
        `Uz tabulas uzvarēja ${String(winner)}.${tab}` +
        zoleResultExtraLine(snap);
    } else {
      detail = vsBot
        ? `Tu zaudēji — uzvarēja ${oppName}.`
        : `Tu zaudēji — uzvarēja ${String(winner)}.`;
    }
    overlay.classList.add("vz-board-result--loss");
  }

  if (eyebrow) eyebrow.textContent = eyebrowText;
  titleEl.textContent = title;
  detailEl.textContent = detail;

  if (coinsEl) {
    if (vsBot) {
      coinsEl.textContent = "Pret botu coins nemainās.";
      coinsEl.classList.remove("hidden");
    } else if (iWon && coinsGain > 0) {
      coinsEl.textContent = `+${coinsGain} coins`;
      coinsEl.classList.remove("hidden");
    } else if (iLost && coinsLoss > 0) {
      coinsEl.textContent = `−${coinsLoss} coins`;
      coinsEl.classList.remove("hidden");
    } else {
      coinsEl.textContent = "";
      coinsEl.classList.add("hidden");
    }
  }

  const againBtn = document.getElementById("board-result-play-again-vsbot");
  if (againBtn) {
    const showAgain = !!vsBot && !!gameType && gameType !== "zole";
    againBtn.classList.toggle("hidden", !showAgain);
    againBtn.dataset.gameType = showAgain ? gameType : "";
  }

  overlay.classList.remove("hidden");
  syncBoardResultRematchUi();
  _boardResultFocusReturn = document.activeElement;
  document.getElementById("board-result-close")?.focus({ preventScroll: true });

  const remBtn = document.getElementById("board-result-rematch");
  const showRematch = remBtn && !remBtn.classList.contains("hidden");
  clearBoardResultAutoCloseTimer();
  if (!showRematch) {
    boardResultAutoCloseTimer = setTimeout(() => {
      const ov = document.getElementById("board-result-overlay");
      if (ov && !ov.classList.contains("hidden")) hideBoardResultOverlay();
    }, BOARD_RESULT_OVERLAY_AUTO_MS);
  }
}

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
const engagementLoopCardEl = $("#engagement-loop-card");
const engagementLoopSummaryEl = $("#engagement-loop-summary");
const engagementLoopPrimaryBtnEl = $("#engagement-loop-primary-btn");
const engagementLoopPrimaryNoteEl = $("#engagement-loop-primary-note");
const engagementLoopSecondaryActionsEl = $(
  "#engagement-loop-secondary-actions"
);
const weeklyListEl = $("#weekly-list");
const weeklySubEl = $("#weekly-sub");
const weeklyYouEl = $("#weekly-you");
const tournamentCardEl = $("#tournament-card");
const tournamentStatusEl = $("#tournament-status");
const tournamentMetaEl = $("#tournament-meta");
const tournamentMatchListEl = $("#tournament-match-list");
const tournamentEmptyEl = $("#tournament-empty");
const tournamentMyMatchEl = $("#tournament-my-match");
const tournamentMyMatchTextEl = $("#tournament-my-match-text");
const tournamentReportFormEl = $("#tournament-report-form");
const tournamentScore1LabelEl = $("#tournament-score1-label");
const tournamentScore2LabelEl = $("#tournament-score2-label");
const tournamentScore1InputEl = $("#tournament-score1");
const tournamentScore2InputEl = $("#tournament-score2");
const tournamentScore1FieldEl = tournamentScore1InputEl
  ? tournamentScore1InputEl.closest(".vz-tournament-score-field")
  : null;
const tournamentScore2FieldEl = tournamentScore2InputEl
  ? tournamentScore2InputEl.closest(".vz-tournament-score-field")
  : null;
const tournamentReportBtnEl = $("#tournament-report-btn");
const tournamentReportStatusEl = $("#tournament-report-status");
const tournamentDisputeBtnEl = $("#tournament-dispute-btn");
const tournamentDisputeStatusEl = $("#tournament-dispute-status");
const tournamentRefreshBtnEl = $("#tournament-refresh-btn");
const tournamentScheduleLineEl = $("#tournament-schedule-line");
const tournamentScheduleModeEl = $("#tournament-schedule-mode");
const tournamentScheduleSlotsEl = $("#tournament-schedule-slots");
const tournamentWeeklyJoinBtnEl = $("#tournament-weekly-join-btn");
const tournamentWeeklyJoinStatusEl = $("#tournament-weekly-join-status");
const tournamentRulesListEl = $("#tournament-rules-list");
const vipQuickTournamentPanelEl = $("#vip-quick-tournament-panel");
const vipQuickTournamentHelpEl = $("#vip-quick-tournament-help");
const vipQuickTournamentNameEl = $("#vip-quick-tournament-name");
const vipQuickTournamentTypeEl = $("#vip-quick-tournament-type");
const vipQuickTournamentPlayModeEl = $("#vip-quick-tournament-play-mode");
const vipQuickTournamentSeedingEl = $("#vip-quick-tournament-seeding");
const vipQuickTournamentCreateBtnEl = $("#vip-quick-tournament-create-btn");
const vipQuickTournamentCreateStatusEl = $("#vip-quick-tournament-create-status");
const vipRoomPanelEl = $("#vip-room-panel");
const vipRoomHelpEl = $("#vip-room-help");
const vipRoomNameEl = $("#vip-room-name");
const vipRoomTypeEl = $("#vip-room-type");
const vipRoomPlayModeEl = $("#vip-room-play-mode");
const vipRoomSlotsEl = $("#vip-room-slots");
const vipRoomFriendsEl = $("#vip-room-friends");
const vipRoomCreateBtnEl = $("#vip-room-create-btn");
const vipRoomCreateStatusEl = $("#vip-room-create-status");
const vipRoomListEl = $("#vip-room-list");

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
  "😀",
  "😁",
  "😂",
  "🤣",
  "🙂",
  "😉",
  "😍",
  "😘",
  "😎",
  "🤔",
  "😅",
  "😭",
  "😡",
  "🤯",
  "😴",
  "🤝",
  "🔥",
  "⚡",
  "🏆",
  "🎯",
  "🎉",
  "💪",
  "✅",
  "❌",
  "❤️",
  "💀",
  "👀",
  "🙏",
  "💸",
  "🧠",
  "🫡",
  "🐸",
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
const chatMentionPopupTextEl = document.getElementById(
  "chat-mention-popup-text"
);

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
const regionBonusWindowEl = document.getElementById("region-bonus-window");
const regionAttackCapEl = document.getElementById("region-attack-cap");
const regionRulesEl = document.getElementById("region-rules");

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
  "E",
  "R",
  "T",
  "U",
  "I",
  "O",
  "P",
  "A",
  "S",
  "D",
  "F",
  "G",
  "H",
  "J",
  "K",
  "L",
  "Z",
  "C",
  "V",
  "B",
  "N",
  "M",
  "Ā",
  "Č",
  "Ē",
  "Ģ",
  "Ī",
  "Ķ",
  "Ļ",
  "Ņ",
  "Š",
  "Ū",
  "Ž",
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
let authRefreshInFlight = null;
let authRedirectTriggered = false;

function applyAuthSessionFromPayload(payload, fallbackUsername = "") {
  if (!payload || typeof payload !== "object") return false;
  const token = String(payload.token || "").trim();
  const refreshToken = String(payload.refreshToken || "").trim();
  const username = String(
    payload.username || fallbackUsername || state.username || ""
  ).trim();
  if (!token || !username) return false;
  state.token = token;
  state.username = username;
  if (refreshToken) state.refreshToken = refreshToken;
  const accessExp = Number(payload.accessTokenExpiresAt);
  const refreshExp = Number(payload.refreshTokenExpiresAt);
  state.accessTokenExpiresAt =
    Number.isFinite(accessExp) && accessExp > 0 ? Math.floor(accessExp) : 0;
  state.refreshTokenExpiresAt =
    Number.isFinite(refreshExp) && refreshExp > 0 ? Math.floor(refreshExp) : 0;
  setStoredAuth(token, username, {
    refreshToken: state.refreshToken,
    accessTokenExpiresAt: state.accessTokenExpiresAt,
    refreshTokenExpiresAt: state.refreshTokenExpiresAt,
  });
  if (state.socket) {
    try {
      state.socket.auth = { token: state.token };
    } catch {}
  }
  return true;
}

function handleAuthExpiredRedirect() {
  if (authRedirectTriggered) return;
  authRedirectTriggered = true;
  try {
    sessionStorage.setItem(
      "vz_auth_notice",
      "Sesija beigusies. Ielogojies vēlreiz."
    );
  } catch {}
  clearStoredAuth();
  try {
    clearOneSignalIdentity();
  } catch {}
  window.location.href = "index.html#session";
}

async function tryRefreshAccessToken() {
  const refreshToken = String(state.refreshToken || "").trim();
  if (!refreshToken) return false;
  if (authRefreshInFlight) return authRefreshInFlight;
  authRefreshInFlight = (async () => {
    try {
      const res = await fetchWithTimeout(API_BASE + "/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      const payload = await readJsonOrThrow(res);
      return applyAuthSessionFromPayload(payload, state.username);
    } catch (err) {
      console.warn("Auth refresh failed:", err);
      return false;
    } finally {
      authRefreshInFlight = null;
    }
  })();
  return authRefreshInFlight;
}

async function apiRequest(path, options = {}, canRetryAuth = true) {
  const baseHeaders =
    options.headers && typeof options.headers === "object"
      ? options.headers
      : {};
  const headers = { ...baseHeaders };
  if (state.token && !headers.Authorization) {
    headers.Authorization = "Bearer " + state.token;
  }
  const requestOptions = { ...options, headers };
  let res;
  try {
    res = await fetchWithTimeout(API_BASE + path, requestOptions);
  } catch (err) {
    showConnectionIssueOverlay(classifyApiFailure(err));
    throw err;
  }
  try {
    return await readJsonOrThrow(res);
  } catch (err) {
    const shouldRetry =
      canRetryAuth &&
      Number(err?.status) === 401 &&
      path !== "/auth/refresh" &&
      !!state.refreshToken;
    if (!shouldRetry) {
      const info = classifyApiFailure(err);
      const st = Number(err?.status);
      if (
        info.key === "client" &&
        st >= 400 &&
        st < 500 &&
        st !== 401 &&
        st !== 403
      ) {
        appendSystemMessage(info.text);
        if (gameMessageEl) gameMessageEl.textContent = info.text;
      } else {
        showConnectionIssueOverlay(info);
      }
      throw err;
    }
    const refreshed = await tryRefreshAccessToken();
    if (!refreshed) {
      handleAuthExpiredRedirect();
      throw err;
    }
    return apiRequest(path, options, false);
  }
}

async function apiPost(path, body) {
  return apiRequest(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
}

async function startStripeCoinCheckout(packId) {
  const id = String(packId || "").trim();
  if (!id) return;
  const data = await apiPost("/api/stripe/create-checkout-session", {
    packId: id,
  });
  const url = data && data.url;
  if (url && typeof url === "string") {
    window.location.href = url;
  }
}

function fillStripeCoinPackList(container) {
  if (!container) return;
  const packs = state.stripeCoinPacks || [];
  container.innerHTML = "";
  for (const p of packs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "vz-stripe-coins__btn";
    btn.textContent = p.label || `${p.coins} coins`;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await startStripeCoinCheckout(p.id);
      } catch (e) {
        appendSystemMessage(
          (e && e.message) || "Neizdevās atvērt maksājumu. Pamēģini vēlāk."
        );
        btn.disabled = false;
      }
    });
    container.appendChild(btn);
  }
}

function syncStripeCoinsBuyUi() {
  const on = !!state.stripeCoinsEnabled && (state.stripeCoinPacks || []).length;
  if (stripeCoinsBuyEl) {
    stripeCoinsBuyEl.classList.toggle("hidden", !on);
    if (on) fillStripeCoinPackList(stripeCoinsPackListEl);
  }
  if (ppStripeCoinsBuyEl) {
    ppStripeCoinsBuyEl.classList.toggle("hidden", !on);
    if (on) fillStripeCoinPackList(ppStripeCoinsPackListEl);
  }
}


async function apiGet(path) {
  return apiRequest(path, {});
}

async function apiDelete(path, body = null) {
  const options = { method: "DELETE", headers: {} };
  if (body && typeof body === "object") {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  return apiRequest(path, options);
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
        playPromise.catch(() => {
          playFallbackSound(kind);
        });
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
  if (!gridEl || !tile || typeof tile.getBoundingClientRect !== "function")
    return null;
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
const THEME_LABELS = {
  dark: "🌙 Tumšs",
  light: "☀️ Gaišs",
  contrast: "◐ Augsta kontrasta",
};

function applyTheme() {
  document.body.classList.remove("vz-theme-light", "vz-theme-contrast");
  if (state.theme === "light") document.body.classList.add("vz-theme-light");
  else if (state.theme === "contrast")
    document.body.classList.add("vz-theme-contrast");
  if (themeToggleBtn)
    themeToggleBtn.textContent = THEME_LABELS[state.theme] || THEME_LABELS.dark;
}

// ==================== BEZ INTERNETA + PLAY STORE VĒRTĒJUMS ====================
function setOfflineOverlay(show) {
  if (!offlineOverlayEl) return;
  if (show) offlineOverlayEl.classList.remove("hidden");
  else offlineOverlayEl.classList.add("hidden");
}

function classifyApiFailure(err) {
  const status = Number(err?.status);
  const msg = String(err?.message || "").toLowerCase();
  if (status === 401 || status === 403)
    return {
      key: "auth",
      title: "Piekļuve beigusies",
      text:
        "Tava sesija vairs nav derīga vai nav tiesību šai darbībai. Ielogojies vēlreiz.",
      hint: "",
      showLogin: true,
    };
  if (status >= 500 && status < 600)
    return {
      key: "server",
      title: "Servera kļūda",
      text:
        "Serveris atbild ar kļūdu. Tas parasti ir īslaicīgi — pamēģini vēlreiz pēc brīža.",
      hint: status ? `Kods: ${status}` : "",
      showLogin: false,
    };
  if (status === 429)
    return {
      key: "rate",
      title: "Pārāk daudz pieprasījumu",
      text:
        "Uz brīdi esi nosūtījis pārāk daudz pieprasījumu. Pagaidi un mēģini vēlreiz.",
      hint: "",
      showLogin: false,
    };
  if (status === 408 || status === 504)
    return {
      key: "timeout",
      title: "Noildze",
      text:
        "Serveris neatbildēja laikā. Pārbaudi savienojumu un mēģini vēlreiz.",
      hint: "",
      showLogin: false,
    };
  if (
    msg.includes("tīkls neatbildēja") ||
    msg.includes("pieslēgties serverim") ||
    msg.includes("failed to fetch") ||
    msg.includes("networkerror") ||
    msg.includes("load failed")
  )
    return {
      key: "network",
      title: "Savienojuma problēma",
      text:
        "Neizdevās sasniegt serveri. Pārbaudi internetu vai mēģini vēlāk.",
      hint: "",
      showLogin: false,
    };
  if (status >= 400)
    return {
      key: "client",
      title: "Pieprasījums neizdevās",
      text:
        String(err?.message || "").trim() ||
        "Neizdevās izpildīt pieprasījumu.",
      hint: status ? `Kods: ${status}` : "",
      showLogin: false,
    };
  return {
    key: "unknown",
    title: "Kaut kas nogāja greizi",
    text:
      String(err?.message || "").trim() ||
      "Nezināma kļūda. Pamēģini vēlreiz.",
    hint: "",
    showLogin: false,
  };
}

function showConnectionIssueOverlay(info, opts = {}) {
  const silent = !!opts.silent;
  const title = info?.title || "Savienojuma problēma";
  const text = info?.text || "Mēģini vēlreiz.";
  const hint = info?.hint || "";
  const showLogin = !!info?.showLogin;
  const key = String(info?.key || "");

  if (offlineTitleEl) offlineTitleEl.textContent = title;
  if (offlineTextEl) offlineTextEl.textContent = text;
  if (offlineHintEl) {
    offlineHintEl.textContent = hint;
    offlineHintEl.classList.toggle("hidden", !hint);
  }
  if (offlineLoginBtn) offlineLoginBtn.classList.toggle("hidden", !showLogin);
  if (offlineRetryBtn) {
    offlineRetryBtn.textContent = showLogin ? "Atjaunot lapu" : "Mēģināt vēlreiz";
  }
  setOfflineOverlay(true);

  if (!silent && key && key !== _vzConnIssueLastKey) {
    _vzConnIssueLastKey = key;
    const galLine = `${title}: ${text}${hint ? ` — ${hint}` : ""}`;
    appendGaldaSystemMessage(galLine);
  }
  if (_vzConnIssueOverlayTimer != null) {
    clearTimeout(_vzConnIssueOverlayTimer);
    _vzConnIssueOverlayTimer = null;
  }
  if (opts.autoHideMs && opts.autoHideMs > 0) {
    _vzConnIssueOverlayTimer = setTimeout(() => {
      setOfflineOverlay(false);
      _vzConnIssueOverlayTimer = null;
    }, opts.autoHideMs);
  }
}

/** Īsts PWA / «pievienots sākumekrānam» — ne jau parasts pārlūks fullscreen režīmā. */
function isTwa() {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia("(display-mode: standalone)").matches) return true;
    if (navigator.standalone === true) return true;
    return false;
  } catch {
    return false;
  }
}

const RATE_PROMPT_INITIAL_WINS = 5;
const RATE_PROMPT_REMIND_WINS = 5;
const RATE_PROMPT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const RATE_PROMPT_MIN_SESSION_MS = 8 * 60 * 1000;
const RATE_STORAGE_KEY_PREFIX = "vz_rate_prompt_state_v2";
const PAGE_SESSION_STARTED_AT = Date.now();

// Legacy keys (migrācijai no vecās "parādi 1x un viss" loģikas).
const RATE_STORAGE_KEY = "vz_rate_prompt_shown";
const WINS_STORAGE_KEY = "vz_total_wins";

function getRateStateStorageKey() {
  const who = String(state.username || "")
    .trim()
    .toLowerCase();
  return `${RATE_STORAGE_KEY_PREFIX}:${who || "anon"}`;
}

function getDefaultRateState() {
  return {
    totalWins: 0,
    nextPromptWins: RATE_PROMPT_INITIAL_WINS,
    accepted: false,
    snoozedUntil: 0,
    lastShownAt: 0,
    lastAction: "",
  };
}

function normalizeRateState(input) {
  const base = getDefaultRateState();
  if (!input || typeof input !== "object") return base;

  const totalWins = Number(input.totalWins);
  const nextPromptWins = Number(input.nextPromptWins);
  const snoozedUntil = Number(input.snoozedUntil);
  const lastShownAt = Number(input.lastShownAt);

  base.totalWins = Number.isFinite(totalWins) && totalWins > 0 ? totalWins : 0;
  base.nextPromptWins =
    Number.isFinite(nextPromptWins) &&
    nextPromptWins >= RATE_PROMPT_INITIAL_WINS
      ? nextPromptWins
      : RATE_PROMPT_INITIAL_WINS;
  base.accepted = input.accepted === true;
  base.snoozedUntil =
    Number.isFinite(snoozedUntil) && snoozedUntil > 0 ? snoozedUntil : 0;
  base.lastShownAt =
    Number.isFinite(lastShownAt) && lastShownAt > 0 ? lastShownAt : 0;
  base.lastAction =
    typeof input.lastAction === "string" ? input.lastAction.slice(0, 32) : "";

  return base;
}

function loadRateState() {
  try {
    const raw = localStorage.getItem(getRateStateStorageKey());
    if (raw) return normalizeRateState(JSON.parse(raw));
  } catch {}

  // Legacy fallback: pārnesam veco progresu uz jauno formātu.
  const migrated = getDefaultRateState();
  try {
    const wins = parseInt(localStorage.getItem(WINS_STORAGE_KEY) || "0", 10);
    migrated.totalWins = Number.isFinite(wins) && wins > 0 ? wins : 0;
    migrated.accepted = localStorage.getItem(RATE_STORAGE_KEY) === "1";
    if (migrated.accepted) migrated.nextPromptWins = migrated.totalWins + 9999;
  } catch {}
  return migrated;
}

function saveRateState(input) {
  try {
    localStorage.setItem(
      getRateStateStorageKey(),
      JSON.stringify(normalizeRateState(input))
    );
  } catch {}
}

function shouldShowRatePrompt(rateState, now) {
  if (!isTwa() || !rateOverlayEl) return false;
  if (!rateState || rateState.accepted) return false;
  if ((rateState.totalWins || 0) < (rateState.nextPromptWins || 0))
    return false;
  if ((rateState.snoozedUntil || 0) > now) return false;
  if (now - PAGE_SESSION_STARTED_AT < RATE_PROMPT_MIN_SESSION_MS) return false;
  return true;
}

function recordWinAndMaybeShowRatePrompt() {
  try {
    const now = Date.now();
    const rateState = loadRateState();

    rateState.totalWins = Math.max(0, Number(rateState.totalWins || 0)) + 1;
    if (
      !Number.isFinite(rateState.nextPromptWins) ||
      rateState.nextPromptWins < RATE_PROMPT_INITIAL_WINS
    ) {
      rateState.nextPromptWins = RATE_PROMPT_INITIAL_WINS;
    }

    if (!shouldShowRatePrompt(rateState, now)) {
      saveRateState(rateState);
      return;
    }

    rateState.lastShownAt = now;
    // Aizsardzība pret atkārtotu popup vienā sesijā.
    rateState.snoozedUntil = now + 5 * 60 * 1000;
    saveRateState(rateState);
    rateOverlayEl.classList.remove("hidden");
  } catch {}
}

function hideRateOverlay() {
  if (rateOverlayEl) rateOverlayEl.classList.add("hidden");
}

function handleRatePromptLater() {
  const now = Date.now();
  const rateState = loadRateState();
  rateState.nextPromptWins = Math.max(
    Number(rateState.nextPromptWins || RATE_PROMPT_INITIAL_WINS),
    Number(rateState.totalWins || 0) + RATE_PROMPT_REMIND_WINS
  );
  rateState.snoozedUntil = now + RATE_PROMPT_COOLDOWN_MS;
  rateState.lastAction = "later";
  saveRateState(rateState);
  hideRateOverlay();
}

function handleRatePromptAccepted() {
  const now = Date.now();
  const rateState = loadRateState();
  rateState.accepted = true;
  rateState.lastAction = "rated";
  rateState.lastShownAt = now;
  rateState.snoozedUntil = now + 365 * 24 * 60 * 60 * 1000;
  rateState.nextPromptWins = Number(rateState.totalWins || 0) + 9999;
  saveRateState(rateState);
  hideRateOverlay();
}

function handleRatePromptFeedback() {
  const now = Date.now();
  const rateState = loadRateState();
  rateState.nextPromptWins = Math.max(
    Number(rateState.nextPromptWins || RATE_PROMPT_INITIAL_WINS),
    Number(rateState.totalWins || 0) + RATE_PROMPT_REMIND_WINS + 3
  );
  rateState.snoozedUntil = now + 3 * RATE_PROMPT_COOLDOWN_MS;
  rateState.lastAction = "feedback";
  saveRateState(rateState);
  hideRateOverlay();
}

// ==================== TUTORIAL ====================
const TUTORIAL_STORAGE_KEY = "vz_tutorial_seen_v3";
const LV_KEYBOARD_HINT_STORAGE = "vz_lv_keyboard_hint_shown";
const TUTORIAL_STEPS = [
  {
    title: "Laipni lūdzam VĀRDU ZONĀ!",
    body: "Uzmini vārdu ierobežotā skaitā mēģinājumu. Zem režģa ir tastatūra — vari arī rakstīt uz datora.",
  },
  {
    title: "Pirmie soļi",
    body: "1) Spēle ir zem logo un sezonas joslas. 2) Pēc ievada spied «Jauns raunds» (ja redzams). 3) Lejā atver «Sacensības un rangi», lai redzētu TOP, misijas un turnīrus.",
  },
  {
    title: "Latviešu tastatūra (QWERTY)",
    body: "Burti kā uz latviešu QWERTY, tikai bez Q, W, X un Y — latviešu vārdos tie parasti nav. Nospied SHIFT (oranžs), lai iegūtu Ā, Č, Ē, Ģ, Ī, Ķ, Ļ, Ņ, Š, Ū, Ž. Atkārtoti SHIFT — atpakaļ uz parastajiem burtiem.",
  },
  {
    title: "Kā minēt",
    body: "Izvēlies burtus, saliec vārdu un nospied ENTER (vai taustiņu Enter). Garums atkarīgs no raunda (bieži 5 vai 6 burti).",
  },
  {
    title: "Sarkans = pareizā vieta",
    body: "Burts ir vārdā un pareizajā vietā (sarkanā rūtiņā).",
    example: ["A", "B", "C", "D", "E", "F"],
    exampleStatus: [
      "correct",
      "absent",
      "absent",
      "absent",
      "absent",
      "absent",
    ],
  },
  {
    title: "Dzeltens = pareizs burts, nepareiza vieta",
    body: "Burts ir vārdā, bet citā ailē. Izmanto to nākamajā minējumā.",
    example: ["A", "B", "C", "D", "E", "F"],
    exampleStatus: [
      "absent",
      "present",
      "absent",
      "absent",
      "absent",
      "absent",
    ],
  },
  {
    title: "Pelēks = burta nav vārdā",
    body: "Šo burtu vairs neizmanto.",
    example: ["A", "B", "C", "D", "E", "F"],
    exampleStatus: ["absent", "absent", "absent", "absent", "absent", "absent"],
  },
];

function showFirstSessionHintAfterTutorial() {
  try {
    if (localStorage.getItem(LV_KEYBOARD_HINT_STORAGE) === "1") return;
    localStorage.setItem(LV_KEYBOARD_HINT_STORAGE, "pending");
  } catch {}
}

function showTutorialIfNeeded() {
  try {
    if (localStorage.getItem(TUTORIAL_STORAGE_KEY) === "1") return;
    showTutorial();
  } catch {}
}

function showTutorial() {
  if (!tutorialOverlayEl || !tutorialContentEl || !tutorialDotsEl) return;
  let step = 0;

  function render() {
    const s = TUTORIAL_STEPS[step];
    if (!s) return;
    tutorialContentEl.innerHTML = "";
    const h3 = document.createElement("h3");
    h3.id = "vz-tutorial-title";
    h3.textContent = s.title;
    tutorialContentEl.appendChild(h3);
    const p = document.createElement("p");
    p.textContent = s.body;
    tutorialContentEl.appendChild(p);
    if (s.example && s.exampleStatus) {
      const div = document.createElement("div");
      div.className = "vz-tutorial-example";
      s.example.forEach((letter, i) => {
        const span = document.createElement("span");
        span.className = "tile-ex " + (s.exampleStatus[i] || "absent");
        span.textContent = letter;
        div.appendChild(span);
      });
      tutorialContentEl.appendChild(div);
    }
    tutorialDotsEl.innerHTML = "";
    TUTORIAL_STEPS.forEach((_, i) => {
      const dot = document.createElement("span");
      if (i === step) dot.classList.add("active");
      dot.setAttribute("aria-hidden", "true");
      tutorialDotsEl.appendChild(dot);
    });
    if (tutorialNextBtn) {
      tutorialNextBtn.textContent =
        step === TUTORIAL_STEPS.length - 1 ? "Sākt!" : "Tālāk";
    }
  }

  function close() {
    try {
      localStorage.setItem(TUTORIAL_STORAGE_KEY, "1");
    } catch {}
    tutorialOverlayEl.classList.add("hidden");
    showFirstSessionHintAfterTutorial();
  }

  if (tutorialSkipBtn) {
    tutorialSkipBtn.onclick = close;
  }
  if (tutorialNextBtn) {
    tutorialNextBtn.onclick = () => {
      if (step < TUTORIAL_STEPS.length - 1) {
        step++;
        render();
      } else {
        close();
      }
    };
  }
  render();
  tutorialOverlayEl.classList.remove("hidden");
}

// ==================== PWA INSTALL ====================
let deferredInstallPrompt = null;

// ==================== IZAICINĀJUMS DRAUGAM ====================
let pendingChallengeId = null;

function getChallengeIdFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("challenge") || null;
  } catch {
    return null;
  }
}

function clearChallengeFromUrl() {
  try {
    const u = new URL(window.location.href);
    u.searchParams.delete("challenge");
    const newUrl = u.pathname + (u.search || "") + (u.hash || "");
    window.history.replaceState({}, "", newUrl);
  } catch {}
}

async function startChallengeRound(challengeId) {
  if (!challengeId || !state.token) return;
  try {
    const c = await apiGet("/challenge/" + challengeId);
    if (!c || c.status === "waiting") return;
    const len = c.len || 5;
    state.challengeId = challengeId;
    state.challengeOpponent =
      c.player1 === state.username ? c.player2 : c.player1;
    state.challengeLen = len;
    state.challengeFinished = c.status === "finished";

    const histRes = await apiGet("/challenge/" + challengeId + "/history");
    const history = Array.isArray(histRes?.history) ? histRes.history : [];

    resetGrid(len);
    state.currentRow = 0;
    state.currentCol = 0;
    state.roundFinished = false;
    state.isLocked = false;
    if (history.length) {
      history.forEach((h, r) => {
        const guess = String(h?.guess || "");
        for (let c = 0; c < guess.length && c < len; c++) {
          const tile = state.gridTiles?.[r]?.[c];
          if (!tile) continue;
          tile.dataset.letter = guess[c];
          tile.textContent = guess[c];
        }
        revealRow(r, h?.pattern || [], { animate: false });
      });
      state.currentRow = history.length;
      state.currentCol = 0;
    }
    applyCorrectLocksFromHistory(history);
    if (gameMessageEl)
      gameMessageEl.textContent = state.challengeFinished
        ? "Izaicinājums beidzies. Rezultāts augstāk."
        : "Izaicinājums pret " +
          (state.challengeOpponent || "?") +
          ". Mazāk mēģinājumu = uzvara.";
    if (newRoundBtn) {
      newRoundBtn.style.display = "inline-block";
      newRoundBtn.disabled = false;
      newRoundBtn.textContent = "Atpakaļ uz spēli";
    }
    if (c.status === "finished") {
      showChallengeResult(c.winner, c.attempts1, c.attempts2, c.player1);
    }
  } catch (err) {
    console.error("startChallengeRound:", err);
    if (gameMessageEl)
      gameMessageEl.textContent = "Neizdevās ielādēt izaicinājumu.";
  }
}

function applyCorrectLocksFromHistory(history) {
  if (!Array.isArray(history)) return;
  const pattern = { correct: 3, present: 2, absent: 1 };
  history.forEach((h, rowIndex) => {
    const p = h?.pattern || [];
    p.forEach((status, colIndex) => {
      const tile = state.gridTiles?.[rowIndex]?.[colIndex];
      if (!tile) return;
      if (status === "correct") tile.dataset.locked = "1";
      const btn = state.keyboardButtons.get(
        (tile.dataset?.letter || "").toLowerCase()
      );
      if (
        btn &&
        !btn.classList.contains("correct") &&
        !btn.classList.contains("present") &&
        !btn.classList.contains("absent")
      ) {
        if (status === "correct") btn.classList.add("correct");
        else if (status === "present") btn.classList.add("present");
        else if (status === "absent") btn.classList.add("absent");
      }
    });
  });
}

function showChallengeResult(winner, attempts1, attempts2, player1) {
  if (
    !challengeResultOverlay ||
    !challengeResultTitle ||
    !challengeResultDetail
  )
    return;
  const me = state.username;
  const myAttempts =
    player1 && me === player1
      ? attempts1 != null
        ? attempts1
        : "—"
      : attempts2 != null
        ? attempts2
        : "—";
  const oppAttempts =
    player1 && me === player1
      ? attempts2 != null
        ? attempts2
        : "—"
      : attempts1 != null
        ? attempts1
        : "—";
  if (winner === me) {
    challengeResultTitle.textContent = "Tu uzvarēji!";
    challengeResultDetail.textContent = `Tavi mēģinājumi: ${myAttempts}. Pretinieka: ${oppAttempts}.`;
  } else if (winner) {
    challengeResultTitle.textContent = "Zaudēji šajā izaicinājumā";
    challengeResultDetail.textContent = `Tavi mēģinājumi: ${myAttempts}. Uzvarētājs: ${oppAttempts} mēģinājumi.`;
  } else {
    challengeResultTitle.textContent = "Neizšķirts!";
    challengeResultDetail.textContent = `Abi: ${myAttempts} vs ${oppAttempts} mēģinājumi.`;
  }
  challengeResultOverlay.classList.remove("hidden");
}

function exitChallengeMode() {
  state.challengeId = null;
  state.challengeOpponent = null;
  state.challengeLen = null;
  state.challengeFinished = false;
  pendingChallengeId = null;
  clearChallengeFromUrl();
  if (challengeResultOverlay) challengeResultOverlay.classList.add("hidden");
  if (challengeCreateModal) challengeCreateModal.classList.add("hidden");
  if (challengeJoinModal) challengeJoinModal.classList.add("hidden");
}

// ==================== AVATĀRA PALĪGFUNKCIJAS ====================
function setAvatar(imgEl, initialsEl, dataUrl, username) {
  const initial =
    (username && username.charAt(0).toUpperCase()) ||
    (initialsEl && initialsEl.textContent.trim()) ||
    "B";

  function showInitials() {
    if (imgEl) {
      imgEl.src = "";
      imgEl.style.display = "none";
      imgEl.onerror = null;
    }
    if (initialsEl) {
      initialsEl.textContent = initial;
      initialsEl.style.display = "flex";
    }
  }

  if (dataUrl && imgEl) {
    const triedUrl = dataUrl;
    imgEl.onerror = () => {
      // Fallback: ja Supabase URL neielādējas, mēģini base64 no localStorage
      if (
        username &&
        triedUrl.startsWith("http") &&
        state.username &&
        username === state.username
      ) {
        const local = getLocalAvatarEntry(username);
        if (local?.url?.startsWith?.("data:image/") && local.url !== triedUrl) {
          imgEl.onerror = () => showInitials();
          imgEl.src = local.url;
          return;
        }
      }
      showInitials();
    };
    imgEl.src = dataUrl;
    imgEl.style.display = "block";
    if (initialsEl) initialsEl.style.display = "none";
  } else {
    showInitials();
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

  const initial = username.charAt(0).toUpperCase();
  initialsEl.textContent = initial;

  function showInitials() {
    if (imgEl) {
      imgEl.src = "";
      imgEl.style.display = "none";
      imgEl.onerror = null;
    }
    initialsEl.style.display = "flex";
  }

  if (username === state.username) {
    const localEntry = getLocalAvatarEntry(state.username);
    if (localEntry?.url && imgEl) {
      imgEl.onerror = showInitials;
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
    imgEl.onerror = showInitials;
    imgEl.src = cachedEntry.url;
    imgEl.style.display = "block";
    initialsEl.style.display = "none";
    return;
  }

  if (avatarPending.has(username)) {
    avatarPending
      .get(username)
      .then(() => {
        if (document.body.contains(initialsEl))
          applyMiniAvatar(username, imgEl, initialsEl);
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
        imgEl.onerror = () => {
          imgEl.src = "";
          imgEl.style.display = "none";
          imgEl.onerror = null;
          if (initialsEl && document.body.contains(initialsEl)) {
            initialsEl.style.display = "flex";
          }
        };
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

function normalizeRegionBonusStatus(raw) {
  const enabled = !!raw?.enabled;
  return {
    enabled,
    active: enabled && !!raw?.active,
    multiplier: Math.max(1, Math.floor(Number(raw?.multiplier) || 1)),
    windowsLabel: String(raw?.windowsLabel || "").trim(),
    currentWindowLabel: String(raw?.currentWindowLabel || "").trim(),
    nextWindowLabel: String(raw?.nextWindowLabel || "").trim(),
    windowEndsAt: Number(raw?.windowEndsAt || 0),
    nextStartsAt: Number(raw?.nextStartsAt || 0),
    countdownTargetAt: Number(raw?.countdownTargetAt || 0),
  };
}

function normalizeRegionAttackLimit(raw) {
  const enabled = !!raw?.enabled;
  const cap = Math.max(0, Math.floor(Number(raw?.cap) || 0));
  const used = Math.max(0, Math.floor(Number(raw?.used) || 0));
  const remaining = enabled
    ? Math.max(0, Math.floor(Number(raw?.remaining) || 0))
    : null;
  return {
    enabled,
    cap,
    used,
    remaining,
    resetsAt: Number(raw?.resetsAt || 0),
  };
}

function formatRegionCountdown(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  return `${mins}m ${secs}s`;
}

function renderRegionRules(rules) {
  if (!regionRulesEl) return;
  const list = Array.isArray(rules)
    ? rules.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  const fallback = [
    "Par uzvarām iegūsti novada punktus.",
    "Duelis un galda spēles pret cilvēkiem arī stiprina novadu tabulā.",
    "Ar +1 palīdzi savam novadam.",
    "Ar -1 samazini izvēlēto pretinieku.",
  ];
  const rows = list.length ? list : fallback;
  regionRulesEl.innerHTML = "";
  rows.forEach((row) => {
    const li = document.createElement("li");
    li.textContent = row;
    regionRulesEl.appendChild(li);
  });
}

function renderRegionStatusUi() {
  const now = Date.now();
  const bonus = state.regionBonusStatus;
  const attackLimit = state.regionAttackLimit;

  if (regionBonusWindowEl) {
    let text = "Bonusa logs: nav pieejams.";
    if (bonus && bonus.enabled) {
      if (bonus.active) {
        const left = bonus.windowEndsAt > now ? bonus.windowEndsAt - now : 0;
        text = `Bonuss x${bonus.multiplier} aktīvs vēl ${formatRegionCountdown(
          left
        )} (${bonus.currentWindowLabel || bonus.windowsLabel || "logs"}).`;
      } else if (bonus.nextStartsAt > now) {
        const until = bonus.nextStartsAt - now;
        text = `Nākamais bonuss x${bonus.multiplier} pēc ${formatRegionCountdown(
          until
        )} (${bonus.nextWindowLabel || bonus.windowsLabel || "logs"}).`;
      } else if (bonus.windowsLabel) {
        text = `Bonusa logi: ${bonus.windowsLabel}.`;
      }
    }
    regionBonusWindowEl.textContent = text;
  }

  if (regionAttackCapEl) {
    let text = "Uzbrukumu limits: nav iestatīts.";
    let isWarning = false;
    if (attackLimit && attackLimit.enabled) {
      const rem = Math.max(0, Number(attackLimit.remaining) || 0);
      const resetLeft =
        attackLimit.resetsAt > now ? attackLimit.resetsAt - now : 0;
      text = `Uzbrukumi šodien: ${attackLimit.used}/${attackLimit.cap} · Atlikušais: ${rem} · Resets pēc ${formatRegionCountdown(
        resetLeft
      )}.`;
      isWarning = rem <= 0;
    }
    regionAttackCapEl.textContent = text;
    regionAttackCapEl.classList.toggle("vz-region-status-warning", isWarning);
  }
}

function canUseRegionAttack() {
  const limit = state.regionAttackLimit;
  if (!limit || !limit.enabled) return true;
  return Number(limit.remaining) > 0;
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
    regionAttackBtn.disabled = !canSpend || !target || !canUseRegionAttack();
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
  if (!canUseRegionAttack()) {
    appendSystemMessage("Sasniegts dienas uzbrukumu limits.");
    return;
  }
  const target = regionAttackSelect ? regionAttackSelect.value : "";
  if (!target) return;
  if (regionAttackBtn) regionAttackBtn.disabled = true;
  try {
    const data = await apiPost("/region/attack", { region: target, amount: 1 });
    if (data?.me) updatePlayerCard(data.me);
    await refreshRegionStats();
  } catch (err) {
    appendSystemMessage(err.message || "Neizdevās noņemt pretiniekam.");
    await refreshRegionStats();
  } finally {
    if (regionAttackBtn) regionAttackBtn.disabled = false;
  }
}

function formatVipUntil(ts) {
  const v = Number(ts) || 0;
  if (!v) return "—";
  try {
    return new Date(v).toLocaleDateString("lv-LV", {
      timeZone: "Europe/Riga",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return "—";
  }
}

function setVipBuyStatus(message, kind = "") {
  if (!vipBuyStatusEl) return;
  vipBuyStatusEl.textContent = String(message || "");
  vipBuyStatusEl.classList.remove("vz-ok", "vz-error");
  if (kind === "ok") vipBuyStatusEl.classList.add("vz-ok");
  if (kind === "error") vipBuyStatusEl.classList.add("vz-error");
}

function updateVipUi(me) {
  if (!me) return;
  const vip = me.vip && typeof me.vip === "object" ? me.vip : {};
  const active = !!vip.active;
  const until = Number(vip.until || 0);
  const tier = String(vip.tier || "none");
  const purchaseEnabled = !!vip.purchaseEnabled;
  const canCreateTournament = !!me.canCreateTournament;
  const isAdmin = !!me.isAdmin;

  state.vipActive = active;
  state.vipUntil = until;
  state.vipTier = tier;
  state.canCreateTournament = canCreateTournament;
  state.isAdmin = isAdmin;

  if (vipStatusEl) {
    if (isAdmin) {
      vipStatusEl.textContent = "Admins: turnīru pārvaldība pieejama bez VIP.";
    } else if (active) {
      vipStatusEl.textContent = `VIP aktīvs līdz ${formatVipUntil(
        until
      )} · sadaļā «Turnīri» vari veidot ātru turnīru vai VIP istabu.`;
    } else {
      vipStatusEl.textContent = "VIP nav aktīvs.";
    }
  }

  if (buyVipBtn) {
    buyVipBtn.textContent = "VIP iegāde drīzumā";
    buyVipBtn.disabled = isAdmin || !purchaseEnabled;
    buyVipBtn.style.display = isAdmin ? "none" : "";
  }
  if (!isAdmin && !active && !purchaseEnabled) {
    setVipBuyStatus("VIP pirkšana ar žetoniem nav pieejama.", "");
  }
  renderVipRoomPanel();
}

function syncPendingOfflineDuelInvites(me, showPopup = false) {
  const invites = Array.isArray(me?.pendingDuelInvites)
    ? me.pendingDuelInvites
        .map((x) => ({
          from: String(x?.from || "").trim(),
          ranked: x?.ranked !== false,
          len: Math.max(4, Math.min(8, Math.floor(Number(x?.len) || 5))),
          createdAt: Math.max(0, Number(x?.createdAt) || 0),
          expiresAt: Math.max(0, Number(x?.expiresAt) || 0),
        }))
        .filter((x) => x.from)
    : [];
  state.pendingDuelInvites = invites;
  if (!invites.length) return;
  for (const invite of invites) {
    const key = `${invite.from.toLowerCase()}:${invite.createdAt}`;
    if (state.seenOfflineDuelInviteKeys.has(key)) continue;
    state.seenOfflineDuelInviteKeys.add(key);
    appendSystemMessage(
      `⚔️ Offline dueļa ielūgums no ${invite.from}. Vari pieņemt uzaicinājumu.`
    );
    if (showPopup) {
      ensureDuelInviteUI();
      showDuelInvite({
        from: invite.from,
        len: invite.len,
        ranked: invite.ranked,
        offline: true,
      });
      showPopup = false;
    }
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
  state.regionBoost = Math.max(0, Math.floor(me.regionBoost || 0));
  updateRegionPointsUi(me.regionPoints || 0, me.region || "");
  if (Array.isArray(me.blockedUsers)) {
    dmSetBlockedUsers(me.blockedUsers);
    dmUpdateBlockUi();
  }

  if (playerRankEl)
    playerRankEl.textContent = `${me.rankTitle} (L${me.rankLevel})`;
  applyRankColor(playerNameEl, me.rankColor);
  if (playerXpEl) playerXpEl.textContent = me.xp;
  if (playerScoreEl) playerScoreEl.textContent = me.score;
  if (playerStreakEl) playerStreakEl.textContent = me.streak;
  if (playerBestStreakEl) playerBestStreakEl.textContent = me.bestStreak;

  // Līmeņa pacēluma animācija
  const level = Math.max(1, me.rankLevel || 1);
  if (state.lastRankLevel !== null && level > state.lastRankLevel) {
    showLevelUpAnimation(level, me.rankTitle || "");
  }
  state.lastRankLevel = level;

  // Streak milestone animācija (3, 5, 10, 15, 20...)
  const streak = Number(me.streak) || 0;
  const streakMilestones = [3, 5, 10, 15, 20, 25, 30];
  const hitMilestone =
    state.lastStreak !== null &&
    streak > state.lastStreak &&
    streakMilestones.includes(streak);
  if (hitMilestone && playerStreakEl) {
    playerStreakEl.classList.add("vz-streak-milestone");
    setTimeout(
      () => playerStreakEl.classList.remove("vz-streak-milestone"),
      600
    );
    appendSystemMessage(`🔥 Streak ${streak}! Turpini tā!`);
  }
  state.lastStreak = streak;

  let avatarUrl = me.avatarUrl || null;
  const avatarExp = Number(me.avatarUrlExpiresAt) || 0;
  const storedEntry = getLocalAvatarEntry(me.username);

  if (avatarUrl) {
    const isSupabaseUrl =
      avatarUrl.startsWith("http") &&
      (avatarUrl.includes("supabase") || avatarUrl.includes("/storage/"));
    const hasBase64Fallback = storedEntry?.url?.startsWith?.("data:image/");
    // Nerakstām pār base64 ar Supabase URL – saglabājam base64 kā fallback, ja Supabase neielādējas
    const shouldStore =
      !storedEntry ||
      storedEntry.url !== avatarUrl ||
      (avatarExp && storedEntry.exp !== avatarExp);
    if (shouldStore && !(isSupabaseUrl && hasBase64Fallback)) {
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

  state.stripeCoinsEnabled = !!me.stripeCoinsEnabled;
  state.stripeCoinPacks = Array.isArray(me.stripeCoinPacks)
    ? me.stripeCoinPacks
    : [];
  syncStripeCoinsBuyUi();

  if (playerTokensEl) playerTokensEl.textContent = me.tokens;
  updateVipUi(me);
  syncPendingOfflineDuelInvites(me, true);
  if (playerMedalsStripEl)
    renderPlayerMedals(me.medals, playerMedalsStripEl, false);

  if (playerXpBarEl && playerXpLabelEl) {
    let minXp = Number.isFinite(me.rankMinXp) ? me.rankMinXp : null;
    let nextMinXp = Number.isFinite(me.rankNextMinXp) ? me.rankNextMinXp : null;

    // fallback, ja backend vēl nesūta sliekšņus
    if (minXp === null) minXp = rankMinXpByLevel(level);
    if (nextMinXp === null && level < 40)
      nextMinXp = rankMinXpByLevel(level + 1);

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

  renderClanCard(me);
}

function renderClanCard(me) {
  const cardEl = document.getElementById("vz-clan-card");
  const contentEl = document.getElementById("vz-clan-content");
  const invitesEl = document.getElementById("vz-clan-invites");
  const chatEl = document.getElementById("vz-clan-chat");
  if (!cardEl || !contentEl) return;

  const clan = me.clan || null;
  const invites = me.clanInvitesIn || [];

  if (invites.length > 0 && invitesEl) {
    invitesEl.classList.remove("hidden");
    invitesEl.innerHTML = invites
      .map(
        (inv) =>
          `<div class="vz-clan-invite-row">
            <span>[${escapeHtml(inv.clanTag || "")}] ${escapeHtml(inv.clanName || "")}</span>
            <span class="vz-clan-invite-from">no ${escapeHtml(inv.from || "")}</span>
            <button type="button" class="vz-clan-invite-accept" data-clan-id="${escapeHtml(inv.clanId || "")}">Pieņemt</button>
            <button type="button" class="vz-clan-invite-decline" data-clan-id="${escapeHtml(inv.clanId || "")}">Noraidīt</button>
          </div>`
      )
      .join("");
    invitesEl.querySelectorAll(".vz-clan-invite-accept").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const data = await apiPost("/clan/invite/accept", {
            clanId: btn.dataset.clanId,
          });
          if (data?.me) updatePlayerCard(data.me);
        } catch (err) {
          appendSystemMessage(err?.message || "Kļūda");
        }
      });
    });
    invitesEl.querySelectorAll(".vz-clan-invite-decline").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await apiPost("/clan/invite/decline", { clanId: btn.dataset.clanId });
          const me2 = await apiGet("/me");
          updatePlayerCard(me2);
        } catch (_) {}
      });
    });
  } else if (invitesEl) {
    invitesEl.classList.add("hidden");
  }

  if (clan) {
    const wg = clan.weeklyGoal;
    const weeklyBlock =
      wg && typeof wg === "object"
        ? `<div class="vz-clan-weekly-goal" role="status" aria-live="polite">
        <div class="vz-clan-weekly-goal__head">
          <span class="vz-clan-weekly-goal__label">${escapeHtml(wg.label || "Nedēļas mērķis")}</span>
          ${
            clan.canManage
              ? `<span class="vz-clan-weekly-goal__edit">
            <label class="vz-sr-only" for="vz-clan-weekly-goal-target">Mērķa skaits (5–500)</label>
            <input id="vz-clan-weekly-goal-target" type="number" min="5" max="500" step="1" value="${escapeHtml(String(Math.max(5, Math.min(500, Number(wg.target) || 10))))}" />
            <button type="button" id="vz-clan-weekly-goal-save">Saglabāt mērķi</button>
          </span>`
              : ""
          }
        </div>
        <div class="vz-clan-weekly-goal__bar-wrap" aria-hidden="true">
          <div class="vz-clan-weekly-goal__bar" style="width:${Math.min(100, Math.max(0, Number(wg.pct) || 0))}%"></div>
        </div>
        <div class="vz-clan-weekly-goal__nums">${escapeHtml(String(Math.max(0, Math.floor(Number(wg.progress) || 0))))} / ${escapeHtml(String(Math.max(1, Math.floor(Number(wg.target) || 1))))}${wg.done ? " · ✓" : ""}</div>
        <p class="vz-clan-weekly-goal__hint">Skaita tikai PvP uzvaras šahā, dambretē un zolē (ne pret botu).</p>
      </div>`
        : "";
    contentEl.innerHTML = `
      <div class="vz-clan-info">
        <strong>[${escapeHtml(clan.tag || "")}] ${escapeHtml(clan.name || "")}</strong>
        <span>${clan.memberCount || 0} dalībnieki · ${clan.totalXp || 0} XP</span>
      </div>
      ${weeklyBlock}
      <div class="vz-clan-members">
        ${(clan.members || [])
          .map(
            (m) =>
              `<div class="vz-clan-member">
                <span class="vz-clan-member-name">${escapeHtml(m.username || "")}</span>
                <span class="vz-clan-member-role">${m.role === "leader" ? "Vadītājs" : m.role === "admin" ? "Admin" : "Dalībnieks"}</span>
                ${clan.canManage ? `<button type="button" class="vz-clan-kick-btn" data-username="${escapeHtml(m.username || "")}" ${m.role === "leader" ? "disabled" : ""}>Izmest</button>` : ""}
              </div>`
          )
          .join("")}
      </div>
      ${
        clan.canManage
          ? `
        <div class="vz-clan-invite-form">
          <input id="vz-clan-invite-input" type="text" placeholder="Lietotājvārds" />
          <button id="vz-clan-invite-btn" type="button">Uzaicināt</button>
        </div>
      `
          : ""
      }
      <div class="vz-clan-actions">
        <span class="vz-clan-invite-code">Kods: ${escapeHtml(clan.inviteCode || "—")}</span>
        <button id="vz-clan-leave-btn" type="button" class="vz-clan-leave">Iziet no klana</button>
      </div>
      <div class="vz-clan-chat-wrap">
        <div id="vz-clan-chat-messages" class="vz-clan-chat-msgs"></div>
        <div class="vz-clan-chat-input-wrap">
          <input id="vz-clan-chat-input" type="text" placeholder="Raksti klana čatā…" maxlength="500" />
          <button id="vz-clan-chat-send" type="button">Sūtīt</button>
        </div>
      </div>
    `;
    if (chatEl) {
      chatEl.classList.remove("hidden");
      const msgsEl = contentEl.querySelector("#vz-clan-chat-messages");
      if (msgsEl && Array.isArray(clan.chat)) {
        msgsEl.innerHTML = clan.chat
          .map(
            (m) =>
              `<div class="vz-clan-msg"><span class="vz-clan-msg-user">${escapeHtml(m.username || "")}</span>: ${escapeHtml(m.text || "")}</div>`
          )
          .join("");
        msgsEl.scrollTop = msgsEl.scrollHeight;
      }
    }
    bindClanActions(contentEl, clan);
  } else {
    contentEl.innerHTML = `
      <p class="vz-clan-no-clan">Pievienojies klanam vai izveido savu.</p>
      <details class="vz-clan-create-details">
        <summary>Izveidot klanu</summary>
        <div class="vz-clan-create-form">
          <label>Nosaukums <input id="vz-clan-create-name" type="text" placeholder="Mans klans" maxlength="24" /></label>
          <label>Tags (2–6 burti) <input id="vz-clan-create-tag" type="text" placeholder="MK" maxlength="6" /></label>
          <button id="vz-clan-create-btn" type="button">Izveidot</button>
        </div>
      </details>
      <details class="vz-clan-join-details">
        <summary>Pievienoties ar kodu</summary>
        <div class="vz-clan-join-form">
          <input id="vz-clan-join-code" type="text" placeholder="Ielūguma kods" />
          <button id="vz-clan-join-btn" type="button">Pievienoties</button>
        </div>
      </details>
    `;
    const createBtn = contentEl.querySelector("#vz-clan-create-btn");
    const joinBtn = contentEl.querySelector("#vz-clan-join-btn");
    if (createBtn) {
      createBtn.addEventListener("click", async () => {
        const name = document
          .getElementById("vz-clan-create-name")
          ?.value?.trim();
        const tag = document
          .getElementById("vz-clan-create-tag")
          ?.value?.trim();
        if (!name || !tag) {
          appendSystemMessage("Aizpildi nosaukumu un tagu.");
          return;
        }
        try {
          const data = await apiPost("/clan/create", { name, tag });
          if (data?.me) updatePlayerCard(data.me);
        } catch (err) {
          appendSystemMessage(err?.message || "Neizdevās izveidot klanu.");
        }
      });
    }
    if (joinBtn) {
      joinBtn.addEventListener("click", async () => {
        const code = document
          .getElementById("vz-clan-join-code")
          ?.value?.trim();
        if (!code) {
          appendSystemMessage("Ievadi ielūguma kodu.");
          return;
        }
        try {
          const data = await apiPost("/clan/join", { inviteCode: code });
          if (data?.me) updatePlayerCard(data.me);
        } catch (err) {
          appendSystemMessage(err?.message || "Neizdevās pievienoties.");
        }
      });
    }
  }
}

function bindClanActions(container, clan) {
  if (!container) return;
  const inviteBtn = container.querySelector("#vz-clan-invite-btn");
  const inviteInput = container.querySelector("#vz-clan-invite-input");
  const leaveBtn = container.querySelector("#vz-clan-leave-btn");
  const chatInput = container.querySelector("#vz-clan-chat-input");
  const chatSend = container.querySelector("#vz-clan-chat-send");
  const wgSave = container.querySelector("#vz-clan-weekly-goal-save");
  const wgTarget = container.querySelector("#vz-clan-weekly-goal-target");

  if (wgSave && wgTarget && clan?.canManage) {
    wgSave.addEventListener("click", async () => {
      const n = Math.floor(Number(wgTarget.value));
      if (!Number.isFinite(n) || n < 5 || n > 500) {
        appendSystemMessage("Nedēļas mērķim jābūt no 5 līdz 500.");
        return;
      }
      try {
        const data = await apiPost("/clan/weekly-goal", { target: n });
        if (data?.me) updatePlayerCard(data.me);
        else if (data?.clan && state.me) {
          state.me.clan = data.clan;
          renderClanCard(state.me);
        }
        appendSystemMessage("Klana nedēļas mērķis atjaunināts.");
      } catch (err) {
        appendSystemMessage(err?.message || "Neizdevās saglabāt mērķi.");
      }
    });
  }

  if (inviteBtn && inviteInput) {
    inviteBtn.addEventListener("click", async () => {
      const name = inviteInput.value.trim();
      if (!name) return;
      try {
        await apiPost("/clan/invite", { username: name });
        appendSystemMessage(`Ielūgums nosūtīts ${name}.`);
      } catch (err) {
        appendSystemMessage(err?.message || "Kļūda");
      }
    });
  }
  if (leaveBtn) {
    leaveBtn.addEventListener("click", async () => {
      if (!confirm("Vai tiešām iziet no klana?")) return;
      try {
        const data = await apiPost("/clan/leave", {});
        if (data?.me) updatePlayerCard(data.me);
      } catch (err) {
        appendSystemMessage(err?.message || "Kļūda");
      }
    });
  }
  container.querySelectorAll(".vz-clan-kick-btn").forEach((btn) => {
    if (btn.disabled) return;
    btn.addEventListener("click", async () => {
      const username = btn.dataset.username;
      if (!username || !confirm(`Izmest ${username}?`)) return;
      try {
        const data = await apiPost("/clan/kick", { username });
        if (data?.me) updatePlayerCard(data.me);
      } catch (err) {
        appendSystemMessage(err?.message || "Kļūda");
      }
    });
  });
  if (chatSend && chatInput && state.socket) {
    const send = () => {
      const text = chatInput.value.trim();
      if (!text) return;
      state.socket.emit("clan.chat", text);
      chatInput.value = "";
    };
    chatSend.addEventListener("click", send);
    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") send();
    });
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
  if (regionBoostBtn)
    regionBoostBtn.addEventListener("click", handleRegionBoost);
  if (regionAttackBtn)
    regionAttackBtn.addEventListener("click", handleRegionAttack);
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
    state.regionBonusStatus = normalizeRegionBonusStatus(raw?.bonus || {});
    state.regionAttackLimit = normalizeRegionAttackLimit(
      raw?.attackLimit || {}
    );
    state.regionRules = Array.isArray(raw?.rules) ? raw.rules : [];
    renderRegionRules(state.regionRules);
    renderRegionStatusUi();
    updateRegionPointsUi(state.regionPoints, state.region);

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
        ? Math.max(
            0,
            Math.min(100, (Number(item.score || 0) / REGION_TOTAL_CAP) * 100)
          )
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

  const challengeIdFromUrl = getChallengeIdFromUrl();
  if (challengeIdFromUrl) {
    try {
      const c = await apiGet("/challenge/" + challengeIdFromUrl);
      if (c && c.status === "finished") {
        showChallengeResult(c.winner, c.attempts1, c.attempts2, c.player1);
      } else if (
        c &&
        c.status === "active" &&
        (c.player1 === state.username || c.player2 === state.username)
      ) {
        await startChallengeRound(challengeIdFromUrl);
        await refreshLeaderboard();
        await refreshWeekly();
        await refreshStreakLeaderboard();
        await refreshDailyLeaderboard();
        await refreshMissions();
        await refreshFriends();
        await refreshRegionStats();
        await refreshTournamentCard(true);
        ensureDailyChestUi();
        await refreshDailyChestStatus();
        if (_chestTickTimer) clearInterval(_chestTickTimer);
        _chestTickTimer = setInterval(refreshDailyChestStatus, 60_000);
        setInterval(() => {
          if (_chestStatus) renderDailyChestUi(_chestStatus);
          renderRegionStatusUi();
        }, 1000);
        setInterval(refreshRegionStats, 60_000);
        setInterval(refreshStreakLeaderboard, 90_000);
        setInterval(refreshDailyLeaderboard, 90_000);
        startTournamentRefreshTimer();
        startTournamentCountdownTimer();
        startEngagementLoopTimer();
        renderEngagementLoopCard();
        bindBoardGames();
        initSocket();
        return;
      } else if (c && c.status === "waiting" && c.player1 !== state.username) {
        pendingChallengeId = challengeIdFromUrl;
        if (challengeJoinText)
          challengeJoinText.textContent =
            "Izaicinājums no " +
            (c.player1 || "?") +
            ". Abi minēsiet to pašu vārdu – uzvar tas, kam mazāk mēģinājumu. Pievienoties?";
        if (challengeJoinModal) challengeJoinModal.classList.remove("hidden");
      }
    } catch {}
  }

  await startNewRound();
  await refreshLeaderboard();
  await refreshWeekly();
  await refreshStreakLeaderboard();
  await refreshDailyLeaderboard();
  await refreshMissions();
  await refreshFriends();
  await refreshRegionStats();
  await refreshTournamentCard(true);
  ensureDailyChestUi();
  await refreshDailyChestStatus();
  if (_chestTickTimer) clearInterval(_chestTickTimer);
  _chestTickTimer = setInterval(refreshDailyChestStatus, 60_000);
  setInterval(() => {
    if (_chestStatus) renderDailyChestUi(_chestStatus);
    renderRegionStatusUi();
  }, 1000);
  setInterval(refreshRegionStats, 60_000);
  setInterval(refreshStreakLeaderboard, 90_000);
  setInterval(refreshDailyLeaderboard, 90_000);
  startTournamentRefreshTimer();
  startTournamentCountdownTimer();
  startEngagementLoopTimer();
  renderEngagementLoopCard();
  bindBoardGames();
  initSocket();
  setTimeout(showTutorialIfNeeded, 600);
}

// ==================== PROFILA POPUP + DM ====================
function handlePersonalMessageClick() {
  const u =
    (ppMsgBtnEl && ppMsgBtnEl.dataset.username
      ? ppMsgBtnEl.dataset.username
      : "") ||
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
    setProfileEmailStatus(
      saved ? "Saglabāts." : "E-pasts noņemts.",
      saved ? "ok" : ""
    );
  } catch (err) {
    setProfileEmailStatus(
      err.message || "Neizdevās saglabāt e-pastu.",
      "error"
    );
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
    profilePopupEl.classList.remove(
      "vz-rank-low",
      "vz-rank-mid",
      "vz-rank-high"
    );
    for (let i = 1; i <= 10; i++)
      profilePopupEl.classList.remove("vz-rank-" + i);
    for (let i = 1; i <= 5; i++)
      profilePopupEl.classList.remove("vz-cos-tier-" + i);
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
  const inner =
    profilePopupEl.querySelector(".vz-profile-popup-inner") || profilePopupEl;

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
      state.username && data.username === state.username
        ? "none"
        : "inline-block";
  }
  const boardActions = document.querySelector(".vz-profile-board-actions");
  if (boardActions) {
    boardActions.style.display =
      state.username && data.username === state.username ? "none" : "flex";
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

  // Referrāla sadaļa (tikai savam profilam)
  let referralBox = document.getElementById("vz-profile-referral");
  const isOwnProfile = state.username && data.username === state.username;
  if (isOwnProfile && data.referralLink && inner) {
    if (!referralBox) {
      referralBox = document.createElement("div");
      referralBox.id = "vz-profile-referral";
      referralBox.className = "vz-profile-referral-box";
      inner.appendChild(referralBox);
    }
    const count = Math.max(0, Number(data.referredCount) || 0);
    referralBox.innerHTML = `
      <div class="vz-referral-label">🎁 Uzaicini draugus</div>
      <p class="vz-referral-desc">Kopīgo savu linku. Kad kāds reģistrējas, abi saņemat bonusu (+50 un +25 coins).</p>
      <div class="vz-referral-stats">${count} uzaicināti</div>
      <div class="vz-referral-row">
        <input type="text" id="vz-referral-link-input" readonly />
        <button type="button" class="mission-claim-btn vz-referral-copy">Kopēt</button>
      </div>
    `;
    referralBox.style.display = "block";
    const copyBtn = referralBox.querySelector(".vz-referral-copy");
    const linkInput = document.getElementById("vz-referral-link-input");
    if (linkInput) linkInput.value = data.referralLink || "";
    if (copyBtn && linkInput) {
      copyBtn.addEventListener("click", () => {
        linkInput.select();
        navigator.clipboard
          ?.writeText?.(data.referralLink)
          .then(() => {
            appendSystemMessage("Links nokopēts!");
          })
          .catch(() => {});
      });
    }
  } else if (referralBox) {
    referralBox.style.display = "none";
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
  appendSystemMessage(
    `Tu izaicināji ${currentProfileName} uz dueli. Gaidām atbildi...`
  );
  hidePlayerProfile();
}

// ==================== DIENAS MISIJAS ====================
function renderMissions(missions, bonus) {
  if (!missionsListEl) return;
  state.missions = Array.isArray(missions) ? missions : [];
  state.missionBonus = bonus && typeof bonus === "object" ? bonus : null;
  missionsListEl.innerHTML = "";

  if (!missions || !missions.length) {
    const li = createEl("li", "mission-item");
    const status = createEl("div", "mission-status");
    status.textContent = "Šodien nav pieejamu misiju.";
    li.appendChild(status);
    missionsListEl.appendChild(li);
    renderEngagementLoopCard();
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
    else if (m.isCompleted && !m.isClaimed)
      statusSpan.textContent = "Gatavs saņemšanai";
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
    else if (bonus.isCompleted && !bonus.isClaimed)
      statusSpan.textContent = "Gatavs saņemšanai";
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
  renderEngagementLoopCard();
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

function getGsap() {
  return window && typeof window.gsap === "object" ? window.gsap : null;
}

function animateLoopCardTransition(primaryChanged) {
  const gsap = getGsap();
  if (!gsap || !engagementLoopCardEl) return;
  if (primaryChanged) {
    gsap.fromTo(
      engagementLoopCardEl,
      { opacity: 0.84, y: 4 },
      { opacity: 1, y: 0, duration: 0.28, ease: "power2.out" }
    );
  }
  if (engagementLoopPrimaryBtnEl && !engagementLoopPrimaryBtnEl.disabled) {
    gsap.fromTo(
      engagementLoopPrimaryBtnEl,
      { scale: 0.98 },
      { scale: 1, duration: 0.22, ease: "power2.out" }
    );
  }
}

function animateDailyChestReward() {
  const gsap = getGsap();
  if (!gsap) return;
  const chestWrap = document.getElementById("vz-daily-chest-wrap");
  if (chestWrap) {
    gsap.fromTo(
      chestWrap,
      { opacity: 0.85, y: 3 },
      { opacity: 1, y: 0, duration: 0.3, ease: "power2.out" }
    );
  }
  if (playerCoinsEl) {
    gsap.fromTo(
      playerCoinsEl,
      { scale: 1.18, color: "#ffe082" },
      {
        scale: 1,
        color: "",
        duration: 0.45,
        ease: "back.out(1.4)",
      }
    );
  }
}

function animateTournamentJoinSuccess() {
  const gsap = getGsap();
  if (!gsap || !tournamentCardEl) return;
  gsap.fromTo(
    tournamentCardEl,
    { opacity: 0.88, y: 4 },
    { opacity: 1, y: 0, duration: 0.3, ease: "power2.out" }
  );
  if (tournamentWeeklyJoinBtnEl) {
    gsap.fromTo(
      tournamentWeeklyJoinBtnEl,
      { scale: 0.98 },
      { scale: 1, duration: 0.24, ease: "power2.out" }
    );
  }
}

function startEngagementLoopTimer() {
  if (engagementLoopTimer) clearInterval(engagementLoopTimer);
  engagementLoopTimer = setInterval(() => {
    renderEngagementLoopCard();
  }, 15_000);
}

function getClaimableMissionForLoop() {
  const missions = Array.isArray(state.missions) ? state.missions : [];
  return missions.find((m) => m && m.isCompleted && !m.isClaimed) || null;
}

function getClaimableBonusForLoop() {
  const b = state.missionBonus;
  if (!b || typeof b !== "object") return null;
  return b.isCompleted && !b.isClaimed ? b : null;
}

function buildEngagementLoopActions() {
  const actions = [];

  const claimableMission = getClaimableMissionForLoop();
  if (claimableMission && claimableMission.id != null) {
    actions.push({
      key: `claim_mission:${claimableMission.id}`,
      type: "claim_mission",
      missionId: claimableMission.id,
      label: "Saņemt misijas balvu",
      note: `${String(claimableMission.title || "Misija")} ir gatava saņemšanai.`,
    });
  }

  const claimableBonus = getClaimableBonusForLoop();
  if (claimableBonus) {
    actions.push({
      key: "claim_bonus",
      type: "claim_bonus",
      label: "Saņemt dienas bonusu",
      note: "Dienas bonus balva ir gatava saņemšanai.",
    });
  }

  if (_chestStatus?.available) {
    actions.push({
      key: "open_daily_chest",
      type: "open_daily_chest",
      label: "Atvērt Daily Chest",
      note: "Atver lādi uzreiz, lai nezaudētu dienas loop tempu.",
    });
  }

  if (!state.roundFinished && !state.challengeId && !state.duelMode) {
    actions.push({
      key: "continue_round",
      type: "continue_round",
      label: "Turpināt šo raundu",
      note: "Ievadi nākamo minējumu, lai progress neapstājas.",
    });
  }

  if (state.roundFinished && !state.duelMode) {
    actions.push({
      key: "new_round",
      type: "new_round",
      label: "Sākt jaunu raundu",
      note: "Raunds ir pabeigts, vari uzreiz turpināt spēli.",
    });
  }

  if (state.tournamentReportCtx?.matchId) {
    actions.push({
      key: "focus_tournament_report",
      type: "focus_tournament_report",
      label: "Iesniegt turnīra rezultātu",
      note: "Tavs turnīra mačs gaida rezultāta iesniegšanu.",
    });
  }

  if (state.tournamentSchedule?.canJoin) {
    actions.push({
      key: "join_weekly_tournament",
      type: "join_weekly_tournament",
      label: "Pieteikties nedēļas turnīram",
      note: "Aizņem slotu turnīrā un turpini sacensību loopu.",
    });
  }

  if (Array.isArray(state.friendInvitesIn) && state.friendInvitesIn.length) {
    const fromName = String(state.friendInvitesIn[0]?.name || "").trim();
    if (fromName) {
      actions.push({
        key: `accept_friend:${fromName.toLowerCase()}`,
        type: "accept_friend",
        from: fromName,
        label: `Pieņemt draugu: ${fromName}`,
        note: "Draugu loks atslēdz vairāk duelus un lielāku iesaisti.",
      });
    }
  }

  if (!state.challengeId && challengeFriendBtn) {
    actions.push({
      key: "challenge_friend",
      type: "challenge_friend",
      label: "Izaicināt draugu",
      note: "Izaicinājums dod skaidru mērķi abiem spēlētājiem.",
    });
  }

  if (state.lastShareResult) {
    actions.push({
      key: "share_result",
      type: "share_result",
      label: "Dalīties ar rezultātu",
      note: "Padalies ar rezultātu, lai atgriežas vairāk spēlētāju.",
    });
  }

  actions.push({
    key: "share_game",
    type: "share_game",
    label: "Dalīties ar spēli",
    note: "Ja nav citu darbību, uzaicini jaunus spēlētājus.",
  });

  const out = [];
  const seen = new Set();
  for (const action of actions) {
    const key = String(action?.key || "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(action);
  }
  return out;
}

async function runEngagementLoopAction(action) {
  if (!action || engagementLoopBusy) return;
  engagementLoopBusy = true;
  try {
    switch (action.type) {
      case "claim_mission":
        await claimMission(action.missionId);
        break;
      case "claim_bonus":
        await claimMissionBonus();
        break;
      case "open_daily_chest":
        handleDailyChestClick();
        break;
      case "new_round":
        if (newRoundBtn) newRoundBtn.click();
        else if (!state.duelMode) await startNewRound();
        break;
      case "continue_round":
        if (gridEl)
          gridEl.scrollIntoView({ behavior: "smooth", block: "center" });
        if (gameMessageEl && !state.roundFinished) {
          gameMessageEl.textContent =
            "Turpini minēt — nākamais solis ir tavs gājiens.";
        }
        break;
      case "focus_tournament_report":
        if (tournamentCardEl) {
          tournamentCardEl.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
        }
        if (tournamentScore1InputEl) tournamentScore1InputEl.focus();
        setTournamentReportStatus(
          "Ievadi rezultātu un pabeidz maču, lai loop turpinās."
        );
        break;
      case "join_weekly_tournament":
        await handleTournamentWeeklyJoin();
        break;
      case "accept_friend":
        if (action.from) await friendAccept(action.from);
        break;
      case "challenge_friend":
        if (challengeFriendBtn) challengeFriendBtn.click();
        break;
      case "share_result":
        handleShareResult();
        break;
      case "share_game":
        handleShare();
        break;
      default:
        break;
    }
  } finally {
    engagementLoopBusy = false;
    setTimeout(renderEngagementLoopCard, 120);
  }
}

function renderEngagementLoopCard() {
  if (!engagementLoopCardEl) return;
  const actions = buildEngagementLoopActions();
  const primary = actions[0] || null;
  const nextKey = String(primary?.key || "");
  const primaryChanged = nextKey !== String(state.loopPrimaryActionKey || "");
  state.loopPrimaryAction = primary;
  state.loopPrimaryActionKey = nextKey;

  if (engagementLoopSummaryEl) {
    engagementLoopSummaryEl.textContent = primary
      ? `Nākamais solis: ${primary.label}`
      : "Turpini aktuālo raundu un krāj progresu.";
  }

  if (engagementLoopPrimaryBtnEl) {
    if (!primary) {
      engagementLoopPrimaryBtnEl.textContent = "Turpināt spēli";
      engagementLoopPrimaryBtnEl.disabled = true;
    } else {
      engagementLoopPrimaryBtnEl.textContent = primary.label;
      engagementLoopPrimaryBtnEl.disabled = false;
    }
  }

  if (engagementLoopPrimaryNoteEl) {
    if (!primary) {
      engagementLoopPrimaryNoteEl.textContent =
        "Loop panelis automātiski atjaunojas pēc katras darbības.";
    } else {
      const nextLabels = actions
        .slice(1, 3)
        .map((x) => x.label)
        .join(" · ");
      const chain = nextLabels ? ` Pēc tam: ${nextLabels}.` : "";
      engagementLoopPrimaryNoteEl.textContent =
        `${primary.note || ""}${chain}`.trim();
    }
  }

  if (engagementLoopSecondaryActionsEl) {
    engagementLoopSecondaryActionsEl.innerHTML = "";
    actions.slice(1, 4).forEach((action) => {
      const btn = createEl("button", "mission-claim-btn vz-loop-secondary-btn");
      btn.type = "button";
      btn.textContent = action.label;
      btn.addEventListener("click", () => runEngagementLoopAction(action));
      engagementLoopSecondaryActionsEl.appendChild(btn);
    });
  }
  animateLoopCardTransition(primaryChanged);
}

async function refreshMissions() {
  if (!state.token) return;
  try {
    const missionsRaw = await apiGet("/missions");
    renderMissions(
      extractMissions(missionsRaw),
      extractMissionBonus(missionsRaw)
    );
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
function formatSocialPresenceFromPayload(p) {
  if (!p || typeof p !== "object") return null;
  const inGame = !!p.inBoardGame;
  const lobby = !!p.zole3pLobby;
  const invite = p.pendingBoardInvite;
  const lastHand = !!p.zoleVsBotLastHand;
  const parts = [];
  const titleBits = [];
  if (inGame) {
    parts.push("galds");
    titleBits.push("Spēlē galda spēli");
  }
  if (lobby) {
    parts.push("Zole 3P");
    titleBits.push("Atvērta Zoles 3 cilvēku istaba");
  }
  if (invite && invite.from) {
    if (invite.rematch) {
      parts.push("revānšs");
      titleBits.push(`Gaida revānšu no ${invite.from}`);
    } else {
      parts.push("aicinājums");
      titleBits.push(`Gaida galda uzaicinājumu no ${invite.from}`);
    }
  }
  if (lastHand) {
    parts.push("pēdējā partija");
    titleBits.push("Zole pret botiem — pēdējā partija šajā mačā");
  }
  if (!parts.length) return null;
  return { text: parts.join(" · "), title: titleBits.join(" · ") };
}

function applyFriendsPayload(payload) {
  if (!payload || typeof payload !== "object") return;
  state.friends = Array.isArray(payload.friends) ? payload.friends : [];
  state.friendInvitesIn = Array.isArray(payload.incoming)
    ? payload.incoming
    : [];
  state.friendInvitesOut = Array.isArray(payload.outgoing)
    ? payload.outgoing
    : [];
  renderFriends();
  updateProfileFriendButton();
  renderVipRoomPanel();
  renderEngagementLoopCard();
}

function friendRelation(name) {
  const uname = String(name || "").trim();
  const key = uname.toLowerCase();
  const isFriend = state.friends.some(
    (n) => String(n || "").toLowerCase() === key
  );
  const incoming = state.friendInvitesIn.some(
    (x) => String(x?.name || "").toLowerCase() === key
  );
  const outgoing = state.friendInvitesOut.some(
    (x) => String(x?.name || "").toLowerCase() === key
  );
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

  if (
    !state.friends.length &&
    !state.friendInvitesIn.length &&
    !state.friendInvitesOut.length
  ) {
    const empty = createEl("div");
    fillVzEmptyState(empty, {
      glyph: "🤝",
      title: "Draugu saraksts ir tukšs",
      text: "Augšā ievadi vārdu un spied «Pievienot».",
    });
    friendsInvitesEl.appendChild(empty);
    return;
  }

  state.friends.forEach((name) => {
    const row = createEl("li", "vz-friend-row");
    const left = createEl("div", "vz-friend-left");
    const top = createEl("div", "vz-friend-top");
    const dot = createEl("span", "vz-friend-status");
    const online = state.onlineUsers.has(
      String(name || "")
        .trim()
        .toLowerCase()
    );
    if (online) dot.classList.add("vz-friend-online");
    top.appendChild(dot);

    const nick = createEl("span", "vz-friend-name clickable-username");
    nick.textContent = name;
    nick.addEventListener("click", () => openProfile(name));
    top.appendChild(nick);
    left.appendChild(top);
    const mini = state.onlineMiniByUser?.get(
      String(name || "")
        .trim()
        .toLowerCase()
    );
    const pres = formatSocialPresenceFromPayload(mini);
    if (pres) {
      const pr = createEl("span", "vz-friend-presence");
      pr.textContent = pres.text;
      pr.title = pres.title;
      left.appendChild(pr);
    }
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
  if (Number.isFinite(alpha))
    gridEl.style.setProperty("--glow-alpha", String(alpha));
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

  gridEl.addEventListener("pointermove", (e) =>
    updateGridGlowFromPoint(e.clientX, e.clientY, 0.32)
  );
  gridEl.addEventListener("pointerdown", (e) =>
    updateGridGlowFromPoint(e.clientX, e.clientY, 0.45)
  );
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
  const safe =
    window.visualViewport && window.visualViewport.height
      ? Math.max(
          0,
          window.innerHeight -
            window.visualViewport.height -
            window.visualViewport.offsetTop
        )
      : 0;

  const bottomReserve = Math.max(84, Math.ceil(actionsH) + 12 + safe);

  const keyboardH = keyboardEl ? keyboardEl.getBoundingClientRect().height : 0;
  const gridTop = gridEl.getBoundingClientRect().top || 0;
  const keyboardTop = keyboardEl ? keyboardEl.getBoundingClientRect().top : 0;

  const vw = Math.min(
    window.innerWidth,
    document.documentElement.clientWidth || window.innerWidth
  );
  const vh = window.innerHeight;

  const availW = vw - 24;
  const availHViewport = vh - keyboardH - bottomReserve - gridTop - 12;
  const availHBetween =
    keyboardTop > gridTop ? keyboardTop - gridTop - 12 : availHViewport;
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

  renderEngagementLoopCard();
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
    if (
      data &&
      data.revealUsed &&
      data.reveal &&
      Number.isInteger(data.reveal.pos) &&
      data.reveal.letter
    ) {
      state.revealUsed = true;
      state.revealHint = {
        pos: data.reveal.pos,
        letter: data.reveal.letter,
        cost: state.revealCostCoins,
      };
      applyRevealHintFromRow(
        data.reveal.pos,
        data.reveal.letter,
        state.currentRow
      );
      updateRevealAbilityUI();
    }
    // atjauno solo raundu pēc refresh/disconnect (ja serveris atdod history)
    if (Array.isArray(data.history) && data.history.length) {
      data.history.forEach((h, r) => {
        const guess = String(h?.guess || "").split("");
        for (let c = 0; c < guess.length; c++) {
          const tile = state.gridTiles?.[r]?.[c];
          if (!tile) continue;
          tile.dataset.letter = guess[c];
          tile.textContent = guess[c];
        }
        revealRow(r, h?.pattern || [], { animate: false });
        applyCorrectLocksFromPattern(r - 1, guess, h?.pattern || []);
      });

      state.currentRow = data.history.length;
      state.currentCol = 0;
      skipHintLockedForward();
    }
    if (gameMessageEl) {
      let msg = `Jauns raunds (${len} burti).`;
      try {
        if (localStorage.getItem(LV_KEYBOARD_HINT_STORAGE) === "pending") {
          localStorage.setItem(LV_KEYBOARD_HINT_STORAGE, "1");
          msg +=
            " Pareizā vieta = sarkana rūtiņa; dzeltens = burts ir, bet citā vietā. Tastatūra: latviešu QWERTY (bez Q, W, X, Y); SHIFT = Ā, Č, Ē… Palīdzība: 📖 Tutorial augšā.";
        }
      } catch {}
      gameMessageEl.textContent = msg;
    }
    state.roundFinished = false;
    renderEngagementLoopCard();
  } catch (err) {
    console.error("start-round kļūda:", err);
    if (gameMessageEl)
      gameMessageEl.textContent = err.message || "Neizdevās sākt raundu.";
    renderEngagementLoopCard();
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
    keyboardEl && keyboardEl.parentElement
      ? keyboardEl.parentElement
      : gridEl.parentElement;

  if (parent && keyboardEl && keyboardEl.parentElement === parent) {
    parent.insertBefore(wrap, keyboardEl);
  } else if (gridEl) {
    gridEl.insertAdjacentElement("afterend", wrap);
  }
}

function updateRevealAbilityUI() {
  const btn = document.getElementById("vz-btn-reveal-letter");
  if (!btn) return;

  const disabled =
    !!state.duelMode ||
    !!state.isLocked ||
    !!state.roundFinished ||
    !!state.revealUsed;
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
  while (
    state.currentCol < state.cols &&
    tileIsHintLocked(state.currentRow, state.currentCol)
  ) {
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
    tile.classList.remove("present", "absent");
    tile.classList.add("hint-locked", "correct");
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
      tile.classList.remove("present", "absent", "flip", "shake");
      tile.classList.add("hint-locked", "correct");
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
  if (!PREFERS_REDUCED_MOTION) {
    tile.classList.add("vz-tile-pop");
    setTimeout(() => tile.classList.remove("vz-tile-pop"), 140);
  }

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
  const btn =
    state.keyboardButtons.get(base) || state.keyboardButtons.get(letter);

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

function showWinEffects(winRowIndex) {
  if (gridEl) {
    gridEl.classList.add("win-glow");
    setTimeout(() => gridEl.classList.remove("win-glow"), 1200);
  }
  if (
    !PREFERS_REDUCED_MOTION &&
    Number.isInteger(winRowIndex) &&
    state.gridTiles?.[winRowIndex]
  ) {
    const row = state.gridTiles[winRowIndex];
    row.forEach((tile, i) => {
      if (tile?.classList?.contains?.("correct")) {
        setTimeout(
          () => {
            tile.classList.add("vz-tile-win-bounce");
            setTimeout(() => tile.classList.remove("vz-tile-win-bounce"), 400);
          },
          100 + i * 50
        );
      }
    });
  }
  if (screenFlashEl) {
    screenFlashEl.classList.add("vz-screen-flash-active");
    setTimeout(
      () => screenFlashEl.classList.remove("vz-screen-flash-active"),
      200
    );
  }
  if (typeof confetti === "function") {
    confetti({ particleCount: 80, spread: 70, origin: { y: 0.3 } });
  }
}

// ====== Solo minējums (HTTP /guess) ======
async function submitChallengeGuess() {
  if (!state.challengeId || state.isLocked) return;
  const letters = [];
  for (let c = 0; c < state.cols; c++) {
    letters.push(state.gridTiles[state.currentRow]?.[c]?.dataset.letter || "");
  }
  const guess = letters.join("");
  if (!guess || guess.length !== state.cols) return;
  if (state.currentRow > 0) {
    const check = validateHardModeGuess(guess);
    if (!check.valid) {
      flashRow(state.currentRow);
      if (gameMessageEl)
        gameMessageEl.textContent = formatYellowLetterError(check.missing);
      return;
    }
  }
  state.isLocked = true;
  try {
    const data = await apiPost("/challenge/" + state.challengeId + "/guess", {
      guess,
    });
    const pattern = data.pattern || [];
    const rowIndex = state.currentRow;
    revealRow(rowIndex, pattern);
    const guessLetters = letters.slice();
    applyCorrectLocksFromPattern(rowIndex - 1, guessLetters, pattern);
    pattern.forEach((status, i) =>
      updateKeyboardColor(guessLetters[i], status)
    );
    state.currentRow++;
    state.currentCol = 0;
    skipHintLockedForward();
    if (data.win) playSound(sWin);
    if (data.finished) state.challengeFinished = true;
    if (data.bothDone) {
      showChallengeResult(
        data.winner,
        data.attempts1,
        data.attempts2,
        data.player1
      );
    } else if (data.finished && gameMessageEl) {
      gameMessageEl.textContent = "Tu pabeidzi. Gaidi pretinieku.";
    }
  } catch (err) {
    if (gameMessageEl)
      gameMessageEl.textContent = err.message || "Kļūda minējumā.";
    if (err.message && err.message.includes("mēģinājumus"))
      flashRow(state.currentRow);
  } finally {
    state.isLocked = false;
  }
}

function getHardModeConstraints() {
  const wrongPositionsByLetter = new Map();
  const yellowCountPerRow = new Map();
  const greenByLetter = new Map();
  for (let r = 0; r < state.currentRow; r++) {
    const rowYellowCount = new Map();
    for (let c = 0; c < state.cols; c++) {
      const tile = state.gridTiles?.[r]?.[c];
      if (!tile) continue;
      const raw = String(tile.dataset.letter || "").trim();
      if (!raw) continue;
      const letter = raw.toUpperCase();
      if (!letter) continue;
      if (tile.classList.contains("present")) {
        if (!wrongPositionsByLetter.has(letter))
          wrongPositionsByLetter.set(letter, new Set());
        wrongPositionsByLetter.get(letter).add(c);
        rowYellowCount.set(letter, (rowYellowCount.get(letter) || 0) + 1);
      } else if (tile.classList.contains("correct")) {
        greenByLetter.set(letter, (greenByLetter.get(letter) || 0) + 1);
      }
    }
    for (const [letter, count] of rowYellowCount) {
      const prev = yellowCountPerRow.get(letter) || 0;
      yellowCountPerRow.set(letter, Math.max(prev, count));
    }
  }
  const required = new Map();
  for (const [letter, wrongPositions] of wrongPositionsByLetter) {
    const yellowCount = yellowCountPerRow.get(letter) || 0;
    const greenCount = greenByLetter.get(letter) || 0;
    const needCount = Math.max(0, yellowCount - greenCount);
    if (needCount > 0)
      required.set(letter, { wrongPositions, requiredCount: needCount });
  }
  return required;
}

function validateHardModeGuess(guess) {
  const constraints = getHardModeConstraints();
  const gArr = guess.split("");
  const missing = [];
  for (const [letter, { wrongPositions, requiredCount }] of constraints) {
    let validCount = 0;
    for (let i = 0; i < gArr.length; i++) {
      const g = String(gArr[i] || "").toUpperCase();
      if (g === letter && !wrongPositions.has(i)) validCount++;
    }
    if (validCount < requiredCount) {
      for (let k = 0; k < requiredCount - validCount; k++) missing.push(letter);
    }
  }
  return { valid: missing.length === 0, missing };
}

function formatYellowLetterError(missing) {
  const uniq = [...new Set(missing)];
  return uniq.length > 0
    ? `Izmanto dzeltenos burtus: ${uniq.join(", ")} (citā ailē)`
    : "Dzeltenie burti jāizmanto citā pozīcijā.";
}

async function submitGuess() {
  if (state.duelMode) {
    submitDuelGuess();
    return;
  }
  if (state.challengeId) {
    await submitChallengeGuess();
    return;
  }

  if (state.isLocked) return;
  if (state.currentCol !== state.cols) {
    flashRow(state.currentRow);
    if (gameMessageEl)
      gameMessageEl.textContent = `Vārdam jābūt ${state.cols} burtiem.`;
    return;
  }

  const letters = [];
  for (let c = 0; c < state.cols; c++) {
    letters.push(state.gridTiles[state.currentRow]?.[c]?.dataset.letter || "");
  }
  const guess = letters.join("");
  if (!guess || guess.length !== state.cols) return;

  if (state.currentRow > 0) {
    const check = validateHardModeGuess(guess);
    if (!check.valid) {
      flashRow(state.currentRow);
      if (gameMessageEl)
        gameMessageEl.textContent = formatYellowLetterError(check.missing);
      return;
    }
  }

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
      if (gameMessageEl)
        gameMessageEl.textContent = "Precīzi! Tu atminēji vārdu!";
      playSound(sWin);
      setTimeout(() => showWinEffects(rowIndex), Math.min(120, unlockAfter));
      state.roundFinished = true;
      renderEngagementLoopCard();
      setTimeout(
        () => prepareShareResult(true, rowIndex + 1),
        unlockAfter + 50
      );

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
      renderEngagementLoopCard();
      setTimeout(
        () => prepareShareResult(false, rowIndex + 1),
        unlockAfter + 50
      );

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
      if (
        state.revealHint &&
        Number.isInteger(state.revealHint.pos) &&
        state.revealHint.letter
      ) {
        applyRevealHintFromRow(
          state.revealHint.pos,
          state.revealHint.letter,
          state.currentRow
        );
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
    if (gameMessageEl)
      gameMessageEl.textContent = err.message || "Kļūda minējumā.";
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
    if (gameMessageEl)
      gameMessageEl.textContent = `Vārdam jābūt ${state.cols} burtiem duelī.`;
    return;
  }

  const letters = [];
  for (let c = 0; c < state.cols; c++) {
    letters.push(state.gridTiles[state.currentRow]?.[c]?.dataset.letter || "");
  }
  const guess = letters.join("");
  if (!guess || guess.length !== state.cols) return;

  if (state.currentRow > 0) {
    const check = validateHardModeGuess(guess);
    if (!check.valid) {
      flashRow(state.currentRow);
      if (gameMessageEl)
        gameMessageEl.textContent = formatYellowLetterError(check.missing);
      return;
    }
  }

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
    duelExtraMsgEl.textContent = buildDuelExtraText({
      youWin,
      winner,
      reason,
      opponent,
    });
  }
  // winner avatar
  const winName = winnerText === "TU" ? state.username : winner || "";
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
    try {
      duelOkBtn.focus();
    } catch {}
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
// Latviešu QWERTY apakškopa: bez Q, W, X, Y (latviešu vārdos reti / nav vajadzīgi)
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
    const rowEl = createEl(
      "div",
      "kb-row" + (isEnterRow ? " kb-row-enter" : "")
    );

    row.forEach((key) => {
      const btn = createEl("button", "kb-key");
      btn.textContent = key;

      if (key === "SHIFT") {
        btn.classList.add("kb-shift");
        btn.setAttribute(
          "title",
          "Latviešu diakritiķi: Ā Č Ē Ģ Ī Ķ Ļ Ņ Š Ū Ž. Nospied vēlreiz, lai atgrieztos pie A–Z."
        );
        btn.setAttribute("aria-label", "Pārslēgt latviešu burtus ar strīpiņu");
      }
      if (key === "ENTER") btn.classList.add("kb-enter");
      if (key === "⌫") btn.classList.add("kb-backspace");

      if (key.length === 1 && /[A-Z]/.test(key)) btn.dataset.baseKey = key;

      btn.addEventListener("click", () => {
        if (!PREFERS_REDUCED_MOTION) {
          btn.classList.add("kb-key-press");
          setTimeout(() => btn.classList.remove("kb-key-press"), 120);
        }
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

      if (key.length === 1 || key === "SHIFT")
        state.keyboardButtons.set(key, btn);
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

  keyboardEl
    .querySelectorAll(".kb-shift")
    .forEach((btn) => btn.classList.toggle("kb-shift-on", on));

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
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA"))
    return;

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
  const layoutKey =
    Object.entries(LATVIAN_MAP).find(([, v]) => v === ch)?.[0] || ch;
  const kbBtn = state.keyboardButtons.get(layoutKey);
  if (kbBtn && !PREFERS_REDUCED_MOTION) {
    kbBtn.classList.add("kb-key-press");
    setTimeout(() => kbBtn.classList.remove("kb-key-press"), 120);
  }
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
        lbTargetEl.textContent =
          "Tavs mērķis: pārspēj " + (list[myIdx - 1].username || "");
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
    renderLeaderboardList(
      streakListEl,
      list,
      (item) => ` — ${item.bestStreak || 0} 🔥`
    );
  } catch (err) {
    console.warn("Streak leaderboard kļūda:", err);
  }
}

async function refreshDailyLeaderboard() {
  try {
    const raw = await apiGet("/leaderboard/daily");
    const list = extractLeaderboard(raw);
    renderLeaderboardList(
      dailyListEl,
      list,
      (item) => ` — ${item.winsToday || 0} W`
    );
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

function normalizeVipRoomList(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((room) => {
      if (!room || typeof room !== "object") return null;
      const id = String(room.id || "").trim();
      const owner = String(room.owner || "").trim();
      const name = String(room.name || "").trim();
      if (!id || !owner || !name) return null;
      const slots = Math.max(2, Math.floor(Number(room.slots) || 2));
      const participants = Array.isArray(room.participants)
        ? room.participants
            .map((x) => String(x || "").trim())
            .filter(Boolean)
            .slice(0, slots)
        : [];
      const participantSet = new Set(
        participants.map((x) => String(x || "").toLowerCase())
      );
      const invited = Array.isArray(room.invited)
        ? room.invited
            .map((x) => String(x || "").trim())
            .filter((x) => x && !participantSet.has(String(x).toLowerCase()))
            .slice(0, Math.max(0, slots - participants.length))
        : [];
      const used = participants.length + invited.length;
      const statusRaw = String(room.status || "open")
        .trim()
        .toLowerCase();
      const status =
        statusRaw === "started" ||
        statusRaw === "cancelled" ||
        statusRaw === "completed"
          ? statusRaw
          : "open";
      return {
        id,
        owner,
        name,
        type: String(room.type || "single_elimination"),
        playMode: String(room.playMode || "classic"),
        autoReportOnly: room.autoReportOnly !== false,
        slots,
        participants,
        invited,
        status,
        createdAt: Math.max(0, Number(room.createdAt) || 0),
        startedAt: Math.max(0, Number(room.startedAt) || 0),
        tournamentId: Number.isFinite(Number(room.tournamentId))
          ? Number(room.tournamentId)
          : null,
        closedAt: Math.max(0, Number(room.closedAt) || 0),
        closeReason: String(room.closeReason || "")
          .trim()
          .toLowerCase(),
        statusText: String(room.statusText || "").trim(),
        nextActionText: String(room.nextActionText || "").trim(),
        emptySlots: Math.max(0, Number(room.emptySlots) || slots - used),
        isOwner: !!room.isOwner,
        isParticipant: !!room.isParticipant,
        isInvited: !!room.isInvited,
        canInvite: !!room.canInvite,
        canJoin: !!room.canJoin,
        canCancel: !!room.canCancel,
        canDelete: !!room.canDelete,
      };
    })
    .filter(Boolean);
}

function setVipRoomCreateStatus(message, kind = "") {
  if (!vipRoomCreateStatusEl) return;
  vipRoomCreateStatusEl.textContent = String(message || "");
  vipRoomCreateStatusEl.classList.remove("vz-ok", "vz-error");
  if (kind === "ok") vipRoomCreateStatusEl.classList.add("vz-ok");
  if (kind === "error") vipRoomCreateStatusEl.classList.add("vz-error");
}

function currentVipRoomSlots() {
  const slots = Math.floor(Number(vipRoomSlotsEl?.value) || 4);
  return Math.max(2, slots);
}

function allowedVipRoomSlotsByType(typeRaw) {
  const type = String(typeRaw || "single_elimination")
    .trim()
    .toLowerCase();
  if (type === "single_elimination") return new Set([2, 4, 8, 16]);
  return new Set([2, 3, 4, 5, 6, 7, 8, 16]);
}

function syncVipRoomSlotOptions() {
  if (!vipRoomTypeEl || !vipRoomSlotsEl) return;
  const allowed = allowedVipRoomSlotsByType(vipRoomTypeEl.value);
  let hasSelectedAllowed = false;
  Array.from(vipRoomSlotsEl.options).forEach((opt) => {
    const v = Math.max(2, Math.floor(Number(opt.value) || 0));
    const ok = allowed.has(v);
    opt.disabled = !ok;
    opt.hidden = !ok;
    if (ok && String(v) === String(vipRoomSlotsEl.value))
      hasSelectedAllowed = true;
  });
  if (!hasSelectedAllowed) {
    const firstAllowed = Array.from(vipRoomSlotsEl.options).find(
      (opt) => !opt.disabled
    );
    if (firstAllowed) vipRoomSlotsEl.value = firstAllowed.value;
  }
}

function normalizeVipRoomDraftInvites(invites, slots = currentVipRoomSlots()) {
  const maxInvites = Math.max(0, slots - 1);
  const friendSet = new Set(
    (Array.isArray(state.friends) ? state.friends : []).map((name) =>
      String(name || "").toLowerCase()
    )
  );
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(invites) ? invites : []) {
    const name = String(raw || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!friendSet.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= maxInvites) break;
  }
  return out;
}

function toggleVipRoomDraftInvite(nameRaw) {
  const name = String(nameRaw || "").trim();
  if (!name) return;
  const key = name.toLowerCase();
  const current = normalizeVipRoomDraftInvites(state.vipRoomDraftInvites);
  const exists = current.some((x) => String(x || "").toLowerCase() === key);
  const next = exists
    ? current.filter((x) => String(x || "").toLowerCase() !== key)
    : [...current, name];
  state.vipRoomDraftInvites = normalizeVipRoomDraftInvites(next);
  renderVipRoomPanel();
}

async function handleVipRoomInvite(roomId, friendName) {
  const roomKey = String(roomId || "").trim();
  const friend = String(friendName || "").trim();
  if (!roomKey || !friend) return;
  try {
    await apiPost(`/tournaments/vip-rooms/${roomKey}/invite`, { friend });
    setVipRoomCreateStatus(`Ielūgums nosūtīts: ${friend}.`, "ok");
    await refreshTournamentCard(true);
  } catch (err) {
    setVipRoomCreateStatus(
      err.message || "Neizdevās uzaicināt draugu uz VIP istabu.",
      "error"
    );
  }
}

async function handleVipRoomJoin(roomId) {
  const roomKey = String(roomId || "").trim();
  if (!roomKey) return;
  try {
    const resp = await apiPost(`/tournaments/vip-rooms/${roomKey}/join`, {});
    if (resp?.started) {
      appendSystemMessage(
        "🏟️ VIP istaba ir pilna — turnīrs startēts automātiski."
      );
    } else {
      appendSystemMessage("✅ Pievienojies VIP istabai.");
    }
    await refreshTournamentCard(true);
  } catch (err) {
    setVipRoomCreateStatus(
      err.message || "Neizdevās pievienoties VIP istabai.",
      "error"
    );
  }
}

async function handleVipRoomCancel(roomId) {
  const roomKey = String(roomId || "").trim();
  if (!roomKey) return;
  if (!window.confirm("Atcelt šo VIP istabu?")) return;
  try {
    const resp = await apiPost(`/tournaments/vip-rooms/${roomKey}/cancel`, {});
    setVipRoomCreateStatus(resp?.message || "VIP istaba atcelta.", "ok");
    await refreshTournamentCard(true);
  } catch (err) {
    setVipRoomCreateStatus(
      err.message || "Neizdevās atcelt VIP istabu.",
      "error"
    );
  }
}

async function handleVipRoomDelete(roomId) {
  const roomKey = String(roomId || "").trim();
  if (!roomKey) return;
  if (!window.confirm("Dzēst šo VIP istabu no saraksta?")) return;
  try {
    const resp = await apiDelete(`/tournaments/vip-rooms/${roomKey}`);
    setVipRoomCreateStatus(resp?.message || "VIP istaba izdzēsta.", "ok");
    await refreshTournamentCard(true);
  } catch (err) {
    setVipRoomCreateStatus(
      err.message || "Neizdevās izdzēst VIP istabu.",
      "error"
    );
  }
}

function openTournamentFromVipRoom(tournamentIdRaw) {
  const tournamentId = Number(tournamentIdRaw);
  if (!Number.isFinite(tournamentId) || tournamentId < 1) return;
  state.tournamentActiveId = tournamentId;
  refreshTournamentCard(false).catch(() => {});
}

function renderVipRoomFriendPicker(canCreate) {
  if (!vipRoomFriendsEl) return;
  vipRoomFriendsEl.innerHTML = "";
  if (!canCreate) return;

  state.vipRoomDraftInvites = normalizeVipRoomDraftInvites(
    state.vipRoomDraftInvites
  );
  const slots = currentVipRoomSlots();
  const maxInvites = Math.max(0, slots - 1);
  const selectedSet = new Set(
    state.vipRoomDraftInvites.map((name) => String(name || "").toLowerCase())
  );

  const summary = createEl("div", "vz-vip-room-friends-empty");
  summary.textContent = `Sloti: ${slots} · izvēlēti draugi: ${state.vipRoomDraftInvites.length}/${maxInvites}`;
  vipRoomFriendsEl.appendChild(summary);

  if (!state.friends.length) {
    const empty = createEl("div");
    fillVzEmptyState(empty, {
      glyph: "👥",
      title: "Nav draugu sarakstā",
      text: "Pievieno draugus profilā, tad izvēlies tos slotos.",
      compact: true,
      extraClass: "vz-vip-room-friends-empty",
    });
    vipRoomFriendsEl.appendChild(empty);
    return;
  }

  state.friends.forEach((friendName) => {
    const row = createEl("div", "vz-vip-room-friend-row");
    const label = createEl("span");
    label.textContent = String(friendName || "");
    row.appendChild(label);
    const key = String(friendName || "").toLowerCase();
    const selected = selectedSet.has(key);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = selected ? "Noņemt" : "Uzaicināt slotā";
    btn.disabled = !selected && state.vipRoomDraftInvites.length >= maxInvites;
    btn.addEventListener("click", () => toggleVipRoomDraftInvite(friendName));
    row.appendChild(btn);
    vipRoomFriendsEl.appendChild(row);
  });
}

function renderVipRoomList() {
  if (!vipRoomListEl) return;
  vipRoomListEl.innerHTML = "";
  const rooms = Array.isArray(state.vipRooms) ? state.vipRooms : [];
  if (!rooms.length) {
    const empty = createEl("div");
    fillVzEmptyState(empty, {
      glyph: "🏆",
      title: "Nav VIP istabu",
      text: "Izveido istabu, kad tev ir tiesības.",
      compact: true,
      extraClass: "mission-status",
    });
    vipRoomListEl.appendChild(empty);
    return;
  }

  rooms.forEach((room) => {
    const item = createEl("div", "vz-vip-room-item");
    const head = createEl("div", "vz-vip-room-item-head");
    const title = createEl("div", "vz-vip-room-item-title");
    title.textContent = room.name;
    head.appendChild(title);
    const meta = createEl("div", "vz-vip-room-item-meta");
    const modeLabel = tournamentTypeLabel(room.type);
    const playLabel = tournamentPlayModeText(room.playMode) || "Classic";
    const resultModeLabel = room.autoReportOnly
      ? "Auto rezultāti"
      : "Manuāli rezultāti";
    meta.textContent = `${modeLabel} · ${playLabel} · ${resultModeLabel} · ${room.participants.length}/${room.slots}`;
    head.appendChild(meta);
    item.appendChild(head);

    const users = createEl("div", "vz-vip-room-item-users");
    const invitedText = room.invited.length
      ? ` | Uzaicināti: ${room.invited.join(", ")}`
      : "";
    users.textContent = `Spēlētāji: ${room.participants.join(", ") || "—"}${invitedText}`;
    item.appendChild(users);

    const status = createEl(
      "div",
      room.status === "cancelled" ? "mission-status vz-error" : "mission-status"
    );
    status.textContent =
      room.statusText ||
      (room.status === "started"
        ? `Turnīrs startēts (#${room.tournamentId || "?"}).`
        : room.status === "completed"
          ? "Spēle pabeigta."
          : room.status === "cancelled"
            ? "Istaba atcelta."
            : room.emptySlots > 0
              ? `Brīvi sloti: ${room.emptySlots}.`
              : "Sloti pilni, starts notiek automātiski.");
    if (room.status === "started" || room.status === "completed")
      status.classList.add("vz-ok");
    item.appendChild(status);

    if (room.nextActionText) {
      const next = createEl("div", "vz-vip-room-next-action");
      next.textContent = `Tālāk: ${room.nextActionText}`;
      item.appendChild(next);
    }

    const actions = createEl("div", "vz-vip-room-actions");

    if (room.canJoin) {
      const joinBtn = document.createElement("button");
      joinBtn.type = "button";
      joinBtn.className = "mission-claim-btn";
      joinBtn.textContent = "Pievienoties istabai";
      joinBtn.addEventListener("click", () => handleVipRoomJoin(room.id));
      actions.appendChild(joinBtn);
    }

    if (room.canInvite && room.status === "open") {
      const inviteWrap = createEl("div", "vz-vip-room-invite-row");
      const select = document.createElement("select");
      select.className = "vz-vip-room-inline-select";
      const base = document.createElement("option");
      base.value = "";
      base.textContent = "Izvēlies draugu";
      select.appendChild(base);
      const participantSet = new Set(
        [...room.participants, ...room.invited].map((x) =>
          String(x || "").toLowerCase()
        )
      );
      state.friends.forEach((friend) => {
        const key = String(friend || "").toLowerCase();
        if (!key || participantSet.has(key)) return;
        const opt = document.createElement("option");
        opt.value = friend;
        opt.textContent = friend;
        select.appendChild(opt);
      });
      inviteWrap.appendChild(select);

      const inviteBtn = document.createElement("button");
      inviteBtn.type = "button";
      inviteBtn.className = "mission-claim-btn";
      inviteBtn.textContent = "Uzaicināt draugu";
      inviteBtn.disabled = select.options.length <= 1;
      inviteBtn.addEventListener("click", () =>
        handleVipRoomInvite(room.id, select.value)
      );
      inviteWrap.appendChild(inviteBtn);
      item.appendChild(inviteWrap);
    }

    if (room.canCancel) {
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "mission-claim-btn vz-vip-room-danger-btn";
      cancelBtn.textContent = "Atcelt istabu";
      cancelBtn.addEventListener("click", () => handleVipRoomCancel(room.id));
      actions.appendChild(cancelBtn);
    }

    if (
      (room.status === "started" || room.status === "completed") &&
      Number.isFinite(Number(room.tournamentId))
    ) {
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "mission-claim-btn";
      openBtn.textContent = `Atvērt turnīru #${room.tournamentId}`;
      openBtn.addEventListener("click", () =>
        openTournamentFromVipRoom(room.tournamentId)
      );
      actions.appendChild(openBtn);
    }

    if (room.canDelete) {
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "mission-claim-btn vz-vip-room-secondary-btn";
      delBtn.textContent = "Dzēst no saraksta";
      delBtn.addEventListener("click", () => handleVipRoomDelete(room.id));
      actions.appendChild(delBtn);
    }

    if (actions.children.length) {
      item.appendChild(actions);
    }

    vipRoomListEl.appendChild(item);
  });
}

const VIP_TOURNAMENT_SEEDING_MAX = 16;

function parseVipQuickTournamentSeeding(raw) {
  const text = String(raw || "");
  const parts = text
    .split(/[\n,;]+/)
    .map((s) => String(s || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const slice = p.slice(0, 30);
    const key = slice.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(slice);
    if (out.length >= VIP_TOURNAMENT_SEEDING_MAX) break;
  }
  const me = String(state.username || "")
    .replace(/\s+/g, " ")
    .trim();
  if (me) {
    const mk = me.toLowerCase();
    if (!out.some((n) => String(n).toLowerCase() === mk)) {
      out.unshift(me.slice(0, 30));
    }
  }
  return out;
}

function isPowerOfTwo(n) {
  const v = Math.floor(Number(n) || 0);
  return v > 0 && (v & (v - 1)) === 0;
}

function setVipQuickTournamentCreateStatus(message, kind = "") {
  if (!vipQuickTournamentCreateStatusEl) return;
  vipQuickTournamentCreateStatusEl.textContent = String(message || "");
  vipQuickTournamentCreateStatusEl.classList.remove("vz-ok", "vz-error");
  if (kind === "ok") vipQuickTournamentCreateStatusEl.classList.add("vz-ok");
  if (kind === "error") vipQuickTournamentCreateStatusEl.classList.add("vz-error");
}

function renderVipQuickTournamentPanel() {
  if (!vipQuickTournamentPanelEl) return;
  const canCreate = !!state.canCreateTournament;
  vipQuickTournamentPanelEl.classList.toggle("hidden", !canCreate);
  if (vipQuickTournamentHelpEl)
    vipQuickTournamentHelpEl.classList.toggle("hidden", !canCreate);
  const toggleField = (el, hidden) => {
    if (!el) return;
    const field = el.closest(".vz-tournament-score-field");
    if (field) field.classList.toggle("hidden", hidden);
    else el.classList.toggle("hidden", hidden);
  };
  toggleField(vipQuickTournamentNameEl, !canCreate);
  toggleField(vipQuickTournamentTypeEl, !canCreate);
  toggleField(vipQuickTournamentPlayModeEl, !canCreate);
  toggleField(vipQuickTournamentSeedingEl, !canCreate);
  if (vipQuickTournamentCreateBtnEl)
    vipQuickTournamentCreateBtnEl.classList.toggle("hidden", !canCreate);
  if (vipQuickTournamentCreateStatusEl)
    vipQuickTournamentCreateStatusEl.classList.toggle("hidden", !canCreate);
  if (!canCreate) setVipQuickTournamentCreateStatus("");
}

async function handleVipQuickTournamentCreate() {
  if (!state.token || !state.canCreateTournament) return;
  const name = String(vipQuickTournamentNameEl?.value || "").trim();
  if (!name) {
    setVipQuickTournamentCreateStatus("Norādi turnīra nosaukumu.", "error");
    return;
  }
  const type = String(vipQuickTournamentTypeEl?.value || "single_elimination");
  const playMode = String(vipQuickTournamentPlayModeEl?.value || "classic");
  const seeding = parseVipQuickTournamentSeeding(
    vipQuickTournamentSeedingEl?.value || ""
  );
  if (seeding.length < 2) {
    setVipQuickTournamentCreateStatus(
      "Vajag vismaz 2 dalībniekus (vārdi tekstā vai tu tiksi pievienots automātiski).",
      "error"
    );
    return;
  }
  if (type === "single_elimination" && !isPowerOfTwo(seeding.length)) {
    setVipQuickTournamentCreateStatus(
      "Izslēgšanas turnīram jābūt 2, 4, 8 vai 16 dalībniekiem.",
      "error"
    );
    return;
  }
  try {
    if (vipQuickTournamentCreateBtnEl) vipQuickTournamentCreateBtnEl.disabled = true;
    const autoReportOnly =
      playMode === "dambrete" || playMode === "chess" || playMode === "zole"
        ? false
        : true;
    const resp = await apiPost("/tournaments", {
      name,
      type,
      playMode,
      seeding,
      autoReportOnly,
    });
    const tid = resp?.tournament?.id;
    setVipQuickTournamentCreateStatus(
      tid != null
        ? `Turnīrs #${tid} izveidots.`
        : "Turnīrs izveidots.",
      "ok"
    );
    if (vipQuickTournamentNameEl) vipQuickTournamentNameEl.value = "";
    if (vipQuickTournamentSeedingEl) vipQuickTournamentSeedingEl.value = "";
    await refreshTournamentCard(true);
  } catch (err) {
    setVipQuickTournamentCreateStatus(
      err.message || "Neizdevās izveidot turnīru.",
      "error"
    );
  } finally {
    if (vipQuickTournamentCreateBtnEl)
      vipQuickTournamentCreateBtnEl.disabled = false;
  }
}

function renderVipRoomPanel() {
  if (!vipRoomPanelEl) return;
  const hasRooms = Array.isArray(state.vipRooms) && state.vipRooms.length > 0;
  const canCreate = !!state.canCreateTournament;
  renderVipQuickTournamentPanel();
  vipRoomPanelEl.classList.toggle("hidden", !canCreate && !hasRooms);
  if (!canCreate && !hasRooms) return;

  const toggleField = (el, hidden) => {
    if (!el) return;
    const field = el.closest(".vz-tournament-score-field");
    if (field) field.classList.toggle("hidden", hidden);
    else el.classList.toggle("hidden", hidden);
  };
  if (vipRoomHelpEl) vipRoomHelpEl.classList.toggle("hidden", !canCreate);
  toggleField(vipRoomNameEl, !canCreate);
  toggleField(vipRoomTypeEl, !canCreate);
  toggleField(vipRoomPlayModeEl, !canCreate);
  toggleField(vipRoomSlotsEl, !canCreate);
  if (vipRoomFriendsEl) vipRoomFriendsEl.classList.toggle("hidden", !canCreate);
  if (vipRoomCreateBtnEl)
    vipRoomCreateBtnEl.classList.toggle("hidden", !canCreate);
  if (vipRoomCreateStatusEl)
    vipRoomCreateStatusEl.classList.toggle("hidden", !canCreate);
  if (!canCreate) setVipRoomCreateStatus("");

  syncVipRoomSlotOptions();
  renderVipRoomFriendPicker(canCreate);
  renderVipRoomList();
}

function formatTournamentCountdown(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days}d ${hours}h ${mins}m ${secs}s`;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  return `${mins}m ${secs}s`;
}

function setTournamentWeeklyJoinStatus(message, kind = "") {
  if (!tournamentWeeklyJoinStatusEl) return;
  tournamentWeeklyJoinStatusEl.textContent = String(message || "");
  tournamentWeeklyJoinStatusEl.classList.remove("vz-ok", "vz-error");
  if (kind === "ok") tournamentWeeklyJoinStatusEl.classList.add("vz-ok");
  if (kind === "error") tournamentWeeklyJoinStatusEl.classList.add("vz-error");
}

function renderTournamentSchedule() {
  const s = state.tournamentSchedule;
  if (tournamentScheduleModeEl) {
    if (!s || !s.enabled) {
      tournamentScheduleModeEl.textContent = "Turnīra režīms: —";
    } else {
      const label = String(s.modeLabel || s.mode || "Turnīrs");
      const playLabel = String(s.playModeLabel || s.playMode || "").trim();
      tournamentScheduleModeEl.textContent = playLabel
        ? `Turnīra režīms: ${label} · Spēles mods: ${playLabel}`
        : `Turnīra režīms: ${label} (rotē katru nedēļu)`;
    }
  }

  if (tournamentScheduleLineEl) {
    if (!s || !s.enabled || !s.startAt) {
      tournamentScheduleLineEl.textContent =
        "Fiksētais turnīrs šobrīd nav pieejams.";
    } else {
      const now = Date.now();
      const left = s.startAt - now;
      const localStart = new Date(s.startAt).toLocaleString("lv-LV", {
        timeZone: "Europe/Riga",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        day: "2-digit",
        month: "2-digit",
      });
      if (left > 0) {
        tournamentScheduleLineEl.textContent = `${s.title}: starts ${localStart} · līdz startam ${formatTournamentCountdown(
          left
        )}`;
      } else {
        tournamentScheduleLineEl.textContent = `${s.title}: starts tiek apstrādāts. Ja nav pilni sloti, turnīrs netiek startēts.`;
      }
    }
  }

  if (tournamentScheduleSlotsEl) {
    if (!s || !s.enabled) {
      tournamentScheduleSlotsEl.textContent = "Sloti: —";
    } else {
      let txt = `Sloti: ${s.joinedCount}/${s.slots}. Ja trūkst sloti, aicini draugu.`;
      if (s.lastCycle?.kind === "not_full") {
        txt += " Iepriekšējais starts nenotika, jo nebija pilni sloti.";
      }
      tournamentScheduleSlotsEl.textContent = txt;
    }
  }

  if (tournamentRulesListEl) {
    tournamentRulesListEl.innerHTML = "";
    const list = s && Array.isArray(s.rules) ? s.rules : [];
    for (const rule of list) {
      const li = createEl("li");
      const text = createEl("span", "mission-title");
      text.textContent = rule;
      li.appendChild(text);
      tournamentRulesListEl.appendChild(li);
    }
  }

  if (tournamentWeeklyJoinBtnEl) {
    if (!s || !s.enabled) {
      tournamentWeeklyJoinBtnEl.disabled = true;
      tournamentWeeklyJoinBtnEl.textContent = "Nedēļas turnīrs nav pieejams";
      return;
    }

    if (s.isJoined) {
      tournamentWeeklyJoinBtnEl.disabled = true;
      tournamentWeeklyJoinBtnEl.textContent = "Tu jau esi pieteicies";
    } else if (s.canJoin) {
      tournamentWeeklyJoinBtnEl.disabled = false;
      tournamentWeeklyJoinBtnEl.textContent =
        "Pieteikties piektdienas turnīram";
    } else if (s.joinedCount >= s.slots) {
      tournamentWeeklyJoinBtnEl.disabled = true;
      tournamentWeeklyJoinBtnEl.textContent = "Visi sloti aizņemti";
    } else {
      tournamentWeeklyJoinBtnEl.disabled = true;
      tournamentWeeklyJoinBtnEl.textContent = "Pieteikšanās nav pieejama";
    }
  }

  if (s && !s.isJoined && !s.canJoin && s.joinBlockedReason) {
    setTournamentWeeklyJoinStatus(s.joinBlockedReason, "error");
  } else if (s && s.canJoin && tournamentWeeklyJoinStatusEl) {
    const msg = String(tournamentWeeklyJoinStatusEl.textContent || "").trim();
    if (!msg || msg === String(s.joinBlockedReason || "").trim()) {
      setTournamentWeeklyJoinStatus("");
    }
  }
}

async function handleTournamentWeeklyJoin() {
  if (!state.token) return;
  if (!tournamentWeeklyJoinBtnEl) return;
  try {
    tournamentWeeklyJoinBtnEl.disabled = true;
    const data = await apiPost("/tournaments/weekly/join", {});
    if (data?.schedule) {
      state.tournamentSchedule = normalizeTournamentSchedule(data.schedule);
    }
    renderTournamentSchedule();
    setTournamentWeeklyJoinStatus(
      data?.message || "Pieteikšanās saglabāta.",
      "ok"
    );
    animateTournamentJoinSuccess();
    await refreshTournamentCard(true);
  } catch (err) {
    setTournamentWeeklyJoinStatus(
      err.message || "Neizdevās pieteikties turnīram.",
      "error"
    );
    await refreshTournamentCard(true);
  } finally {
    renderTournamentSchedule();
    renderEngagementLoopCard();
  }
}

async function handleVipRoomCreate() {
  if (!state.token || !state.canCreateTournament) return;
  try {
    if (vipRoomCreateBtnEl) vipRoomCreateBtnEl.disabled = true;
    const slots = currentVipRoomSlots();
    state.vipRoomDraftInvites = normalizeVipRoomDraftInvites(
      state.vipRoomDraftInvites,
      slots
    );
    const clanOnly = !!document.getElementById("vip-room-clan-only")?.checked;
    const playMode = String(vipRoomPlayModeEl?.value || "classic");
    const payload = {
      name: String(vipRoomNameEl?.value || "").trim(),
      type: String(vipRoomTypeEl?.value || "single_elimination"),
      playMode,
      slots,
      invitedFriends: state.vipRoomDraftInvites,
      autoReportOnly:
        playMode === "dambrete" || playMode === "chess" ? false : true,
      clanOnly,
    };
    const resp = await apiPost("/tournaments/vip-rooms", payload);
    setVipRoomCreateStatus(
      resp?.message ||
        "VIP istaba izveidota. Aicini draugus uz tukšajiem slotiem.",
      "ok"
    );
    state.vipRoomDraftInvites = [];
    if (vipRoomNameEl) vipRoomNameEl.value = "";
    await refreshTournamentCard(true);
  } catch (err) {
    setVipRoomCreateStatus(
      err.message || "Neizdevās izveidot VIP istabu.",
      "error"
    );
  } finally {
    if (vipRoomCreateBtnEl) vipRoomCreateBtnEl.disabled = false;
  }
}

function setTournamentReportStatus(message, kind = "") {
  if (!tournamentReportStatusEl) return;
  tournamentReportStatusEl.textContent = String(message || "");
  tournamentReportStatusEl.classList.remove("vz-ok", "vz-error");
  if (kind === "ok") tournamentReportStatusEl.classList.add("vz-ok");
  if (kind === "error") tournamentReportStatusEl.classList.add("vz-error");
}

function setTournamentDisputeStatus(message, kind = "") {
  if (!tournamentDisputeStatusEl) return;
  tournamentDisputeStatusEl.textContent = String(message || "");
  tournamentDisputeStatusEl.classList.remove("vz-ok", "vz-error");
  if (kind === "ok") tournamentDisputeStatusEl.classList.add("vz-ok");
  if (kind === "error") tournamentDisputeStatusEl.classList.add("vz-error");
}

function ensureTournamentMatchStartModal() {
  let overlay = document.getElementById("tournament-match-start-modal");
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.id = "tournament-match-start-modal";
  overlay.className = "vz-modal-overlay hidden";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Turnīra mačs gatavs");
  overlay.innerHTML =
    '<div class="vz-modal-inner vz-challenge-modal"><h3>🏟️ Mačs gatavs</h3><p id="tournament-match-start-text">Tavs turnīra mačs ir gatavs.</p><div class="challenge-actions"><button id="tournament-match-start-open" type="button" class="mission-claim-btn">Atvērt maču</button></div></div>';
  document.body.appendChild(overlay);
  const openBtn = document.getElementById("tournament-match-start-open");
  if (openBtn) {
    openBtn.addEventListener("click", () => {
      overlay.classList.add("hidden");
      try {
        tournamentCardEl?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      } catch {}
      const target =
        (tournamentReportBtnEl && !tournamentReportBtnEl.disabled
          ? tournamentReportBtnEl
          : null) ||
        tournamentMyMatchEl ||
        tournamentCardEl;
      try {
        target?.focus?.({ preventScroll: true });
      } catch {}
    });
  }
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.classList.add("hidden");
  });
  return overlay;
}

function showTournamentMatchStartModal(message) {
  const overlay = ensureTournamentMatchStartModal();
  const textEl = document.getElementById("tournament-match-start-text");
  if (textEl) {
    textEl.textContent = String(
      message || "Tavs turnīra mačs ir gatavs. Atver un iesniedz rezultātu."
    );
  }
  overlay.classList.remove("hidden");
}

function clearTournamentCardUi() {
  if (tournamentMetaEl) {
    tournamentMetaEl.textContent = "";
    tournamentMetaEl.classList.add("hidden");
  }
  if (tournamentMatchListEl) {
    tournamentMatchListEl.innerHTML = "";
    tournamentMatchListEl.classList.add("hidden");
  }
  if (tournamentEmptyEl) {
    tournamentEmptyEl.textContent = "";
    tournamentEmptyEl.className = "hidden";
  }
  if (tournamentMyMatchEl) tournamentMyMatchEl.classList.add("hidden");
  if (tournamentMyMatchTextEl) tournamentMyMatchTextEl.textContent = "—";
  if (tournamentReportFormEl) tournamentReportFormEl.classList.add("hidden");
  if (tournamentScore1InputEl) tournamentScore1InputEl.value = "";
  if (tournamentScore2InputEl) tournamentScore2InputEl.value = "";
  if (tournamentScore1LabelEl)
    tournamentScore1LabelEl.textContent = "Spēlētājs 1";
  if (tournamentScore2LabelEl)
    tournamentScore2LabelEl.textContent = "Spēlētājs 2";
  if (tournamentScore1FieldEl)
    tournamentScore1FieldEl.classList.remove("hidden");
  if (tournamentScore2FieldEl)
    tournamentScore2FieldEl.classList.remove("hidden");
  if (tournamentDisputeBtnEl) tournamentDisputeBtnEl.classList.add("hidden");
  setTournamentDisputeStatus("");
  state.tournamentDisputeCtx = null;
  state.tournamentDisputes = [];
  if (tournamentReportBtnEl)
    tournamentReportBtnEl.textContent = "Iesniegt rezultātu";
  setTournamentReportStatus("");
  state.tournamentReportCtx = null;
}

function renderTournamentCardEmpty(message) {
  if (!tournamentCardEl || !tournamentStatusEl) return;
  clearTournamentCardUi();
  tournamentStatusEl.textContent = String(message || "Turnīri nav pieejami.");
}

function getTournamentParticipantMap(data) {
  const out = new Map();
  const participants = Array.isArray(data?.participant) ? data.participant : [];
  for (const p of participants) {
    if (!p || p.id == null) continue;
    out.set(Number(p.id), String(p.name || "").trim());
  }
  return out;
}

function tournamentParticipantNameById(map, id) {
  if (id == null) return "";
  const byNum = map.get(Number(id));
  if (byNum) return byNum;
  return map.get(id) || "";
}

function matchContainsParticipant(match, participantId) {
  const p1 = Number(match?.opponent1?.id);
  const p2 = Number(match?.opponent2?.id);
  return p1 === Number(participantId) || p2 === Number(participantId);
}

function isTournamentMatchPlayable(match) {
  const status = Number(match?.status);
  return status === 1 || status === 2 || status === 3;
}

function isTournamentMatchReadyForPlay(status) {
  const code = Number(status);
  return code === 2 || code === 3;
}

function findMyTournamentMatch(matches, participantId) {
  const mine = (Array.isArray(matches) ? matches : []).filter((m) =>
    matchContainsParticipant(m, participantId)
  );
  if (!mine.length) return null;
  mine.sort((a, b) => {
    const aPlayable = isTournamentMatchPlayable(a) ? 0 : 1;
    const bPlayable = isTournamentMatchPlayable(b) ? 0 : 1;
    if (aPlayable !== bPlayable) return aPlayable - bPlayable;
    return Number(a?.id || 0) - Number(b?.id || 0);
  });
  return mine[0];
}

function startTournamentRefreshTimer() {
  if (tournamentRefreshTimer) clearInterval(tournamentRefreshTimer);
  tournamentRefreshTimer = setInterval(() => {
    refreshTournamentCard(false);
  }, 60_000);
}

function startTournamentCountdownTimer() {
  if (tournamentCountdownTimer) clearInterval(tournamentCountdownTimer);
  tournamentCountdownTimer = setInterval(() => {
    if (state.tournamentSchedule) renderTournamentSchedule();
  }, 1000);
}

function scheduleTournamentSocketRefresh(options = null) {
  if (options && typeof options === "object") {
    const hintId = Number(options.tournamentId);
    if (Number.isFinite(hintId) && hintId > 0) {
      state.tournamentHintTournamentId = hintId;
    }
    if (options.matchStartHint) {
      state.tournamentSocketMatchHint = true;
    }
  }
  if (tournamentSocketRefreshTimer) return;
  tournamentSocketRefreshTimer = setTimeout(async () => {
    tournamentSocketRefreshTimer = null;
    try {
      await refreshTournamentCard(true);
    } catch {}
  }, 350);
}

function renderTournamentCard(meta, details) {
  if (!tournamentCardEl || !tournamentStatusEl) return;
  clearTournamentCardUi();

  const data = details && typeof details === "object" ? details.data || {} : {};
  const participants = Array.isArray(data.participant) ? data.participant : [];
  const allMatches = Array.isArray(data.match) ? data.match : [];
  const currentMatches = Array.isArray(details?.currentMatches)
    ? details.currentMatches
    : [];
  const participantMap = getTournamentParticipantMap(data);

  let statusLine = String(meta?.name || "Turnīrs");
  if (details?.currentRound?.number) {
    statusLine += ` · Kārta ${details.currentRound.number}`;
  } else if (!details?.currentStage) {
    statusLine += " · Pabeigts";
  }
  tournamentStatusEl.textContent = statusLine;

  if (tournamentMetaEl) {
    const participantCount = Math.max(
      0,
      Number(meta?.participantCount || 0) || participants.length
    );
    const playMode = tournamentPlayModeText(meta?.playMode);
    const playModePart = playMode ? ` · ${playMode}` : "";
    tournamentMetaEl.textContent = `${tournamentTypeLabel(meta?.type)}${playModePart} · ${participantCount} spēlētāji`;
    tournamentMetaEl.classList.remove("hidden");
  }

  const championName = Array.isArray(details?.finalStandings)
    ? String(details.finalStandings?.[0]?.name || "").trim()
    : "";
  if (championName && tournamentEmptyEl) {
    fillVzEmptyState(tournamentEmptyEl, {
      glyph: "🏆",
      title: "Turnīrs noslēgts",
      text: `Uzvarētājs: ${championName}`,
      compact: true,
      extraClass: "mission-status",
    });
    tournamentEmptyEl.classList.remove("hidden");
  }

  const list = (
    currentMatches.length
      ? currentMatches
      : allMatches.filter(isTournamentMatchPlayable)
  ).slice(0, 6);
  if (tournamentMatchListEl) {
    if (list.length) {
      list.forEach((match) => {
        const p1 =
          tournamentParticipantNameById(participantMap, match?.opponent1?.id) ||
          "TBD";
        const p2 =
          tournamentParticipantNameById(participantMap, match?.opponent2?.id) ||
          "TBD";
        const li = createEl("li");
        li.textContent = `${p1} vs ${p2} · ${tournamentMatchStatusLabel(match?.status)}`;
        tournamentMatchListEl.appendChild(li);
      });
      tournamentMatchListEl.classList.remove("hidden");
    } else if (!championName && tournamentEmptyEl) {
      fillVzEmptyState(tournamentEmptyEl, {
        glyph: "📋",
        title: "Nav aktīvu maču",
        text: "Gaidām nākamo kārtu vai atjauninājumu.",
        compact: true,
        extraClass: "mission-status",
      });
      tournamentEmptyEl.classList.remove("hidden");
    }
  }

  if (!tournamentMyMatchEl || !tournamentMyMatchTextEl) return;
  tournamentMyMatchEl.classList.remove("hidden");

  const myName = String(state.username || "")
    .trim()
    .toLowerCase();
  const myParticipant = participants.find(
    (p) =>
      String(p?.name || "")
        .trim()
        .toLowerCase() === myName
  );

  if (!myParticipant || myParticipant.id == null) {
    tournamentMyMatchTextEl.textContent = "Tu neesi šī turnīra dalībnieks.";
    return;
  }

  const myMatch =
    findMyTournamentMatch(
      allMatches.filter(isTournamentMatchPlayable),
      myParticipant.id
    ) || findMyTournamentMatch(allMatches, myParticipant.id);

  if (!myMatch) {
    tournamentMyMatchTextEl.textContent = "Pašlaik tev nav aktīva mača.";
    return;
  }

  const p1Name =
    tournamentParticipantNameById(participantMap, myMatch?.opponent1?.id) ||
    "Spēlētājs 1";
  const p2Name =
    tournamentParticipantNameById(participantMap, myMatch?.opponent2?.id) ||
    "Spēlētājs 2";
  tournamentMyMatchTextEl.textContent = `${p1Name} vs ${p2Name} · ${tournamentMatchStatusLabel(
    myMatch?.status
  )}`;
  state.tournamentDisputes = Array.isArray(details?.disputes)
    ? details.disputes
    : [];
  const openDispute = state.tournamentDisputes.find(
    (d) =>
      Number(d?.matchId) === Number(myMatch?.id) &&
      String(d?.status || "").toLowerCase() === "open"
  );
  state.tournamentDisputeCtx = {
    tournamentId: Number(meta?.id),
    matchId: Number(myMatch?.id),
    hasOpenDispute: !!openDispute,
  };
  if (openDispute) {
    setTournamentDisputeStatus("Šim mačam jau ir atvērts strīds.", "ok");
  } else {
    setTournamentDisputeStatus("");
  }
  if (tournamentDisputeBtnEl) {
    const canOpenDispute =
      Number.isFinite(Number(meta?.id)) &&
      Number.isFinite(Number(myMatch?.id)) &&
      !openDispute;
    tournamentDisputeBtnEl.classList.toggle("hidden", !canOpenDispute);
  }

  const canReportFromUi =
    isTournamentMatchPlayable(myMatch) &&
    myMatch?.id != null &&
    myMatch?.opponent1?.id != null &&
    myMatch?.opponent2?.id != null;
  if (!canReportFromUi) return;
  const autoReportOnly = !!meta?.autoReportOnly;
  const playModeLabel = tournamentPlayModeText(meta?.playMode) || "Classic";

  if (tournamentScore1LabelEl) tournamentScore1LabelEl.textContent = p1Name;
  if (tournamentScore2LabelEl) tournamentScore2LabelEl.textContent = p2Name;

  if (tournamentScore1InputEl) {
    const v1 = Number(myMatch?.opponent1?.score);
    tournamentScore1InputEl.value = Number.isFinite(v1)
      ? String(Math.max(0, Math.floor(v1)))
      : "";
  }
  if (tournamentScore2InputEl) {
    const v2 = Number(myMatch?.opponent2?.score);
    tournamentScore2InputEl.value = Number.isFinite(v2)
      ? String(Math.max(0, Math.floor(v2)))
      : "";
  }
  if (tournamentScore1FieldEl)
    tournamentScore1FieldEl.classList.toggle("hidden", autoReportOnly);
  if (tournamentScore2FieldEl)
    tournamentScore2FieldEl.classList.toggle("hidden", autoReportOnly);

  if (tournamentReportFormEl) tournamentReportFormEl.classList.remove("hidden");
  if (tournamentReportBtnEl) {
    tournamentReportBtnEl.textContent = autoReportOnly
      ? "Automātiski izrēķināt rezultātu"
      : "Iesniegt rezultātu";
  }
  setTournamentReportStatus(
    autoReportOnly
      ? `Auto režīms (${playModeLabel}): rezultāts tiks aprēķināts automātiski.`
      : "Ievadi rezultātu un nospied “Iesniegt rezultātu”."
  );
  state.tournamentReportCtx = {
    tournamentId: Number(meta?.id),
    matchId: Number(myMatch.id),
    p1Name,
    p2Name,
    matchStatus: Number(myMatch?.status),
    autoReportOnly,
    playMode: playModeLabel,
  };
}

async function refreshTournamentCard(force = false) {
  if (!state.token || !tournamentCardEl || !tournamentStatusEl) return;
  if (tournamentRefreshBtnEl) tournamentRefreshBtnEl.disabled = true;
  try {
    const listPayload = await apiGet("/tournaments");
    state.tournamentSchedule = normalizeTournamentSchedule(
      listPayload?.schedule
    );
    state.vipRooms = normalizeVipRoomList(listPayload?.vipRooms);
    renderTournamentSchedule();
    renderVipRoomPanel();
    const list = normalizeTournamentList(listPayload);
    state.tournaments = list;

    if (!list.length) {
      renderTournamentCardEmpty("Šobrīd nav aktīvu turnīru.");
      state.tournamentActiveId = null;
      return;
    }

    let selected = null;
    const hintedId = Number(state.tournamentHintTournamentId);
    if (Number.isFinite(hintedId) && hintedId > 0) {
      selected = list.find((t) => Number(t?.id) === hintedId) || null;
    }
    if (!selected && !force && state.tournamentActiveId != null) {
      selected =
        list.find((t) => Number(t?.id) === Number(state.tournamentActiveId)) ||
        null;
    }
    if (!selected) {
      selected =
        list.find(
          (t) => String(t?.status || "").toLowerCase() !== "completed"
        ) || list[0];
    }
    if (!selected) {
      renderTournamentCardEmpty("Šobrīd nav aktīvu turnīru.");
      state.tournamentActiveId = null;
      return;
    }

    state.tournamentActiveId = Number(selected.id);
    const details = await apiGet(`/tournaments/${selected.id}`);
    renderTournamentCard(selected, details);
    const currentMatchKey =
      state.tournamentReportCtx &&
      Number.isFinite(Number(state.tournamentReportCtx?.tournamentId)) &&
      Number.isFinite(Number(state.tournamentReportCtx?.matchId))
        ? `${Number(state.tournamentReportCtx.tournamentId)}:${Number(
            state.tournamentReportCtx.matchId
          )}`
        : "";
    const currentMatchStatus = Number.isFinite(
      Number(state.tournamentReportCtx?.matchStatus)
    )
      ? Number(state.tournamentReportCtx?.matchStatus)
      : null;
    const previousMatchStatus = Number.isFinite(
      Number(state.tournamentLiveMatchStatus)
    )
      ? Number(state.tournamentLiveMatchStatus)
      : null;
    const currentMatchIsReady =
      isTournamentMatchReadyForPlay(currentMatchStatus);
    const previousMatchWasReady =
      isTournamentMatchReadyForPlay(previousMatchStatus);
    const hasNewActiveMatch =
      !!currentMatchKey &&
      state.tournamentUiPrimed &&
      currentMatchIsReady &&
      (currentMatchKey !== state.tournamentLiveMatchKey ||
        (currentMatchKey === state.tournamentLiveMatchKey &&
          !previousMatchWasReady));
    if (hasNewActiveMatch) {
      try {
        tournamentMyMatchEl?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      } catch {}
      showTournamentMatchStartModal(
        `${state.tournamentReportCtx?.p1Name || "Spēlētājs 1"} vs ${
          state.tournamentReportCtx?.p2Name || "Spēlētājs 2"
        } ir gatavs.`
      );
    }
    state.tournamentLiveMatchKey = currentMatchKey;
    state.tournamentLiveMatchStatus = currentMatchStatus;
    state.tournamentUiPrimed = true;
    state.tournamentSocketMatchHint = false;
    state.tournamentHintTournamentId = null;
    renderTournamentSchedule();
  } catch (err) {
    console.error("Turnīru ielādes kļūda:", err);
    renderTournamentCardEmpty(err.message || "Neizdevās ielādēt turnīrus.");
  } finally {
    renderEngagementLoopCard();
    state.tournamentSocketMatchHint = false;
    state.tournamentHintTournamentId = null;
    if (tournamentRefreshBtnEl) tournamentRefreshBtnEl.disabled = false;
  }
}

async function handleTournamentReportSubmit() {
  if (!state.token) return;
  const ctx = state.tournamentReportCtx;
  if (
    !ctx ||
    !Number.isFinite(Number(ctx.tournamentId)) ||
    !Number.isFinite(Number(ctx.matchId))
  ) {
    setTournamentReportStatus(
      "Šobrīd nav mača, kam iesniegt rezultātu.",
      "error"
    );
    return;
  }
  const autoMode = !!ctx.autoReportOnly;
  if (autoMode) {
    if (tournamentReportBtnEl) tournamentReportBtnEl.disabled = true;
    try {
      const resp = await apiPost(
        `/tournaments/${ctx.tournamentId}/matches/${ctx.matchId}/report/auto`,
        {}
      );
      const label = String(resp?.auto?.modeLabel || ctx.playMode || "auto");
      setTournamentReportStatus(`Auto rezultāts iesniegts (${label}).`, "ok");
      appendSystemMessage(
        `🏟️ Turnīra mača rezultāts aprēķināts automātiski (${label}).`
      );
      await refreshTournamentCard(true);
    } catch (err) {
      setTournamentReportStatus(
        err.message || "Neizdevās automātiski iesniegt rezultātu.",
        "error"
      );
    } finally {
      if (tournamentReportBtnEl) tournamentReportBtnEl.disabled = false;
    }
    return;
  }
  const score1 = parseInt(tournamentScore1InputEl?.value || "", 10);
  const score2 = parseInt(tournamentScore2InputEl?.value || "", 10);
  if (
    !Number.isFinite(score1) ||
    !Number.isFinite(score2) ||
    score1 < 0 ||
    score2 < 0
  ) {
    setTournamentReportStatus("Ievadi abus rezultātus (>= 0).", "error");
    return;
  }
  if (score1 === score2) {
    setTournamentReportStatus("Neizšķirts šobrīd nav atbalstīts.", "error");
    return;
  }

  if (tournamentReportBtnEl) tournamentReportBtnEl.disabled = true;
  try {
    await apiPost(
      `/tournaments/${ctx.tournamentId}/matches/${ctx.matchId}/report`,
      { score1, score2 }
    );
    setTournamentReportStatus("Rezultāts iesniegts.", "ok");
    appendSystemMessage("🏟️ Turnīra mača rezultāts iesniegts.");
    await refreshTournamentCard(true);
  } catch (err) {
    setTournamentReportStatus(
      err.message || "Neizdevās iesniegt rezultātu.",
      "error"
    );
  } finally {
    if (tournamentReportBtnEl) tournamentReportBtnEl.disabled = false;
  }
}

async function handleTournamentDisputeSubmit() {
  if (!state.token) return;
  const ctx = state.tournamentDisputeCtx;
  if (
    !ctx ||
    !Number.isFinite(Number(ctx.tournamentId)) ||
    !Number.isFinite(Number(ctx.matchId))
  ) {
    setTournamentDisputeStatus(
      "Nav pieejams mačs strīda pieteikšanai.",
      "error"
    );
    return;
  }
  if (ctx.hasOpenDispute) {
    setTournamentDisputeStatus("Šim mačam jau ir atvērts strīds.", "ok");
    return;
  }
  const reason = String(
    window.prompt("Īsi apraksti strīda iemeslu:", "Rezultāts nav korekts.")
  ).trim();
  if (!reason || reason.length < 6) {
    setTournamentDisputeStatus("Iemeslam jābūt vismaz 6 simboliem.", "error");
    return;
  }
  if (tournamentDisputeBtnEl) tournamentDisputeBtnEl.disabled = true;
  try {
    await apiPost(
      `/tournaments/${ctx.tournamentId}/matches/${ctx.matchId}/dispute`,
      { reason }
    );
    setTournamentDisputeStatus(
      "Strīds pieteikts. Komanda pārskatīs pieteikumu.",
      "ok"
    );
    appendSystemMessage("🛡️ Turnīra strīds ir pieteikts.");
    await refreshTournamentCard(true);
  } catch (err) {
    setTournamentDisputeStatus(
      err.message || "Neizdevās pieteikt strīdu.",
      "error"
    );
  } finally {
    if (tournamentDisputeBtnEl) tournamentDisputeBtnEl.disabled = false;
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
    const users =
      payload.users || payload.players || payload.list || payload.online;
    if (Array.isArray(users)) players = users;
    count = typeof payload.count === "number" ? payload.count : players.length;
  }

  ul.innerHTML = "";

  const myName = (state.username || "").trim();
  const visibleCount = players.length;
  const onlineSet = new Set();
  const miniMap = new Map();

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
    const uKey = String(username || "")
      .trim()
      .toLowerCase();
    onlineSet.add(uKey);
    if (p && typeof p === "object") miniMap.set(uKey, p);

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
    const pres = formatSocialPresenceFromPayload(p);
    if (pres) {
      const pr = document.createElement("span");
      pr.className = "vz-online-presence";
      pr.textContent = pres.text;
      pr.title = pres.title;
      li.appendChild(pr);
    }

    ul.appendChild(li);
  });

  const finalCount =
    typeof count === "number" && count > 0 ? count : visibleCount;
  countEl.textContent = String(finalCount);
  state.onlineUsers = onlineSet;
  state.onlineMiniByUser = miniMap;
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
  const when = e.finishedAt
    ? new Date(e.finishedAt).toLocaleString("lv-LV", {
        timeZone: "Europe/Riga",
      })
    : "";

  infoEl.textContent =
    `${seasonId ? ` — Sezona ${seasonId}` : ""}` +
    `${score !== "" ? ` — ${score} p.` : ""}` +
    `${when ? ` — ${when}` : ""}`;

  hofSeason1El.appendChild(avatarWrap);
  hofSeason1El.appendChild(nameEl);
  hofSeason1El.appendChild(infoEl);

  if (e.avatarUrl)
    setAvatar(avatarImg, avatarInitials, e.avatarUrl, e.username);
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
  return (
    chatMessagesEl.scrollHeight -
      chatMessagesEl.scrollTop -
      chatMessagesEl.clientHeight <
    threshold
  );
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
    chatMessagesEl.scrollTop = Math.max(
      0,
      chatMessagesEl.scrollTop - removedPx
    );
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
    if (typeof msg.rankLevel === "number")
      applyNameTierClass(clickable, msg.rankLevel);
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

  if (wasNearBottom || isHistory)
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;

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
        lastMention = {
          from: msg.username,
          text: msg.text,
          ts: normalizeTs(msg.ts),
        };
        if (chatMentionBadgeEl)
          chatMentionBadgeEl.classList.add("vz-mention-active");
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

  if (wasNearBottom || isHistory)
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
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

/** Publiskā čata sistēmas ziņas par galda spēlēm — ar [Galda spēles], lai atšķirtu no vārdu spēles. */
function appendGaldaSystemMessage(text) {
  const s = String(text ?? "").trim();
  if (!s) return;
  const line = `[Galda spēles] ${s}`;
  appendSystemMessage(line);
  if (gameMessageEl) gameMessageEl.textContent = line;
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
      try {
        state.socket.emit("dm.clearThread", { with: u });
      } catch {}
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
      const keyboardH = vv
        ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
        : 0;

      // FAB ir top-right: nekad neliekam bottom (lai nelēkā)
      fab.style.bottom = "";
      fab.style.top = 74 + (vv ? vv.offsetTop : 0) + "px";

      // Drawer paliek apakšā, paceļam virs klaviatūras
      drawer.style.bottom = 14 + keyboardH + "px";

      // Toast arī top (netraucē klaviatūrai)
      toast.style.bottom = "";
      toast.style.top = 74 + (vv ? vv.offsetTop : 0) + "px";
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

let _dmPersistTimer = null;
function dmPersistNow() {
  if (!state.username || state.dmStorageMode !== "client") return;
  try {
    const payload = {
      v: DM_LOCAL_STORAGE_VERSION,
      threads: dmThreadsToObject(state.dmThreads, DM_THREAD_MAX_LOCAL),
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
    state.dmUnreadByUser =
      data.unread && typeof data.unread === "object" ? data.unread : {};
    state.dmPeerRead =
      data.peerRead && typeof data.peerRead === "object" ? data.peerRead : {};
    state.dmLastFrom = data.lastFrom || null;
    let total = 0;
    for (const v of Object.values(state.dmUnreadByUser))
      total += Math.max(0, Number(v) || 0);
    state.dmUnreadTotal = total;
    state.dmInboxPreview = [];
    dmSetBadge(total, state.dmUnreadByUser);
  } catch {}
}
function dmIncrementUnread(withUser) {
  const u = String(withUser || "").trim();
  if (!u) return;
  const by =
    state.dmUnreadByUser && typeof state.dmUnreadByUser === "object"
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
  if (state.dmNotifyOn === false) return; // <- ŠO IELIEC
  const toast = document.getElementById("vz-dm-toast");
  if (!toast) return;

  toast.textContent = String(text || "");
  toast.dataset.from = fromUser ? String(fromUser) : "";
  toast.style.display = "block";

  if (_dmToastTimer) clearTimeout(_dmToastTimer);
  _dmToastTimer = setTimeout(() => {
    toast.style.display = "none";
  }, 5000);
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
    try {
      inp.focus();
    } catch {}
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
    const k = String(u || "")
      .trim()
      .toLowerCase();
    if (k) set.add(k);
  }
  state.dmBlockedSet = set;
  try {
    updateProfileBlockButtons();
  } catch {}
}

function dmIsBlocked(username) {
  const k = String(username || "")
    .trim()
    .toLowerCase();
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
  const lastMy = [...thread]
    .reverse()
    .find((m) => m && m.from === state.username && !m.deleted);
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
    bubble.className =
      "dm-bubble " + (isMe ? "dm-bubble-me" : "dm-bubble-other");
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
      if (typeof m.meta.rankLevel === "number")
        applyNameTierClass(nameSpan, m.meta.rankLevel);
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

    if (
      isMe &&
      lastMyId &&
      String(m.id || "") === lastMyId &&
      peerReadTs >= (Number(m.ts) || 0)
    ) {
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
      byKey.set(k, {
        name: bestName,
        unread: bestUnread,
        lastTs: ts,
        lastText: txt,
      });
    } else {
      byKey.set(k, {
        name: bestName,
        unread: bestUnread,
        lastTs: prev.lastTs || 0,
        lastText: prev.lastText || "",
      });
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
      b.unread - a.unread || b.lastTs - a.lastTs || a.name.localeCompare(b.name)
  );

  if (!items.length) {
    const empty = document.createElement("div");
    fillVzEmptyState(empty, {
      glyph: "✉️",
      title: "Vēl nav sarunu",
      text: "Profilā spied «Rakstīt privāti».",
      compact: true,
    });
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
    try {
      inp.focus();
    } catch {}
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
      ? {
          id: state.dmReply.id,
          from: state.dmReply.from,
          text: state.dmReply.text,
        }
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
  }, 4500);
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
let pendingDuelInvite = null; // { duelId, from, len, ranked, offline }

async function consumeOfflineDuelInvite(fromUsername) {
  const from = String(fromUsername || "").trim();
  if (!from) return;
  try {
    await apiPost(
      `/duel/offline-invites/${encodeURIComponent(from)}/consume`,
      {}
    );
  } catch {}
}

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
  btnNo.id = "vz-duel-invite-no";
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
  btnYes.id = "vz-duel-invite-yes";
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
  const isOffline = payload?.offline === true;
  const duelId = payload?.duelId;
  if (!isOffline && !duelId) return;

  pendingDuelInvite = {
    duelId: duelId || "",
    from: payload?.from || "kāds spēlētājs",
    len: payload?.len || 5,
    ranked: payload?.ranked !== false,
    offline: isOffline,
  };

  const box = document.getElementById("vz-duel-invite");
  const text = document.getElementById("vz-duel-invite-text");
  const yesBtn = document.getElementById("vz-duel-invite-yes");
  if (!box || !text) return;
  text.textContent = isOffline
    ? `${pendingDuelInvite.from} tevi izaicināja, kamēr biji offline (${pendingDuelInvite.len} burti).`
    : `${pendingDuelInvite.from} tevi izaicina (${pendingDuelInvite.len} burti).`;
  if (yesBtn) {
    yesBtn.textContent = isOffline ? "Izaicināt atpakaļ" : "Pieņemt";
  }
  box.style.display = "block";

  if (duelInviteTimer) clearTimeout(duelInviteTimer);
  const timeoutMs = isOffline ? 16000 : 12000;
  duelInviteTimer = setTimeout(() => declineDuelInvite(true), timeoutMs);
}

function hideDuelInviteUI() {
  const box = document.getElementById("vz-duel-invite");
  if (box) box.style.display = "none";
  if (duelInviteTimer) clearTimeout(duelInviteTimer);
  duelInviteTimer = null;
  pendingDuelInvite = null;
}

function declineDuelInvite(isAuto) {
  if (pendingDuelInvite?.offline) {
    consumeOfflineDuelInvite(pendingDuelInvite?.from);
  }
  const duelId = pendingDuelInvite?.duelId;
  if (duelId && state.socket && !pendingDuelInvite?.offline) {
    state.socket.emit("duel.decline", { duelId });
  }
  if (!isAuto) appendSystemMessage("⚔️ Duelis noraidīts.");
  hideDuelInviteUI();
}

function acceptDuelInvite() {
  if (pendingDuelInvite?.offline) {
    const from = String(pendingDuelInvite?.from || "").trim();
    if (from && state.socket) {
      state.socket.emit("duel.challenge", {
        target: from,
        ranked: pendingDuelInvite?.ranked !== false,
        len: pendingDuelInvite?.len || 5,
      });
    }
    consumeOfflineDuelInvite(from);
    hideDuelInviteUI();
    return;
  }
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
    if (navigator.onLine) {
      if (_vzConnIssueOverlayTimer != null) {
        clearTimeout(_vzConnIssueOverlayTimer);
        _vzConnIssueOverlayTimer = null;
      }
      setOfflineOverlay(false);
      _vzConnIssueLastKey = "";
    }
  });

  socket.on("coins:purchased", async (payload) => {
    const added = Math.max(0, Number(payload?.added) || 0);
    if (added) {
      appendSystemMessage(`💰 +${added} coins — pateicamies par pirkumu!`);
    }
    try {
      const me2 = await apiGet("/me");
      updatePlayerCard(me2);
    } catch {}
  });

  socket.on("connect_error", (err) => {
    console.error("Socket connect_error:", err && (err.message || err));
    const msg = String(err?.message || "").toLowerCase();
    const jwt =
      msg.includes("jwt") ||
      msg.includes("token") ||
      msg.includes("unauthorized") ||
      msg.includes("forbidden");
    if (jwt) {
      showConnectionIssueOverlay(
        {
          key: "socket_auth",
          title: "Piekļuve čatam un galdam",
          text:
            "Savienojums noraidīts — iespējams, beidzies sesijas tokens. Ielogojies vēlreiz vai atjauno lapu.",
          hint: "",
          showLogin: true,
        },
        { silent: true }
      );
      appendGaldaSystemMessage(
        "Sesija nav derīga čatam un galdam — ielogojies vēlreiz."
      );
    } else {
      showConnectionIssueOverlay(
        {
          key: "socket_net",
          title: "Nav tiešsaistes savienojuma",
          text:
            "Neizdevās pieslēgties reāllaika serverim. Pārbaudi internetu; pēc atjaunošanās viss sinhronizēsies.",
          hint: "",
          showLogin: false,
        },
        { autoHideMs: 7000, silent: true }
      );
      appendGaldaSystemMessage(
        "Reāllaika serveris nav pieejams — mēģina atkārtoti pieslēgties…"
      );
    }
  });

  socket.on("disconnect", (reason) => {
    if (reason === "io client disconnect") return;
    appendSystemMessage("Atvienots no servera.");
    if (boardState?.gameId || zole3pLobbySnapshot?.zoleLobby) {
      appendGaldaSystemMessage(
        "Īslaicīgs atvienojums — pēc atkārtotas pieslēgšanās galds un istaba sinhronizēsies automātiski."
      );
    }
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

  socket.on("clan.chat", (payload) => {
    const msgsEl = document.getElementById("vz-clan-chat-messages");
    if (!msgsEl || !payload) return;
    const div = document.createElement("div");
    div.className = "vz-clan-msg";
    div.innerHTML = `<span class="vz-clan-msg-user">${escapeHtml(payload.username || "")}</span>: ${escapeHtml(payload.text || "")}`;
    msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  });

  socket.on("clan:update", async () => {
    try {
      const me = await apiGet("/me");
      updatePlayerCard(me);
    } catch (_) {}
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

    if (
      payload &&
      Object.prototype.hasOwnProperty.call(payload, "peerLastRead")
    ) {
      state.dmPeerRead[withUser] = Math.max(
        0,
        Number(payload.peerLastRead) || 0
      );
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
    if (state.dmOpenWith !== from)
      dmToast(`✉️ Jauna ziņa no ${from}: ${String(msg?.text || "")}`, from);

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

  socket.on("tournament:update", (payload) => {
    const eventName = String(payload?.event || "").toLowerCase();
    const isMatchStartHint =
      eventName === "match_reported" ||
      eventName === "created" ||
      eventName === "vip_room_started";
    scheduleTournamentSocketRefresh({
      tournamentId: payload?.tournamentId,
      matchStartHint: isMatchStartHint,
    });
  });

  socket.on("vip:updated", async (payload) => {
    const who = String(payload?.username || "")
      .trim()
      .toLowerCase();
    const me = String(state.username || "")
      .trim()
      .toLowerCase();
    if (who && me && who === me) {
      try {
        const myPayload = await apiGet("/me");
        updatePlayerCard(myPayload);
      } catch {}
    }
    scheduleTournamentSocketRefresh();
  });

  // ===== DUEĻI =====
  socket.on("duel.error", (payload) => {
    const msg = payload?.message || "Nezināma duēļa kļūda.";
    appendSystemMessage("❌ Duēlis: " + msg);
    if (gameMessageEl) gameMessageEl.textContent = msg;
    if (!duelCountdownId) state.isLocked = false;
  });

  socket.on("duel.waiting", (payload) => {
    const opp = payload?.opponent || "pretinieks";
    if (payload?.offline) {
      appendSystemMessage(
        `📨 ${opp} nav online. Ielūgums saglabāts un nosūtīts kā push.`
      );
      return;
    }
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
    appendSystemMessage(
      `⚔️ Duēlis sākas pret ${opponent || "pretinieks"} (${len} burti).`
    );
    const sn = Number(payload?.serverNow);
    const base = Number.isFinite(payload?.startedAt)
      ? Number(payload.startedAt)
      : Number.isFinite(sn)
        ? sn
        : Date.now();
    const exp = payload?.expiresAt || base + 2 * 60 * 1000;
    state.isLocked = true;

    if (Number.isFinite(sn)) duelServerOffsetMs = sn - Date.now();
    const playStartsAt =
      Number(payload?.startedAt) ||
      Date.now() + (duelServerOffsetMs || 0) + 5000;

    showDuelStartCountdown(playStartsAt, sn, payload?.countdownMs);
    const delayMs = Math.max(
      0,
      playStartsAt - (Date.now() + (duelServerOffsetMs || 0))
    );
    setTimeout(() => {
      state.isLocked = false;
      startDuelTimer(exp, sn);
    }, delayMs);
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
    const base = Number.isFinite(payload?.startedAt)
      ? Number(payload.startedAt)
      : Number.isFinite(sn)
        ? sn
        : Date.now();
    const exp = payload?.expiresAt || base + 2 * 60 * 1000;
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
      const winRow = state.currentRow;
      setTimeout(() => showWinEffects(winRow), Math.min(120, unlockAfter));
      state.roundFinished = true;
      state.isLocked = true;
      renderEngagementLoopCard();
      setTimeout(recordWinAndMaybeShowRatePrompt, unlockAfter + 600);
      return;
    }

    if (finished) {
      if (gameMessageEl)
        gameMessageEl.textContent = "Tev beidzās mēģinājumi duelī.";
      setTimeout(() => playSound(sLose), Math.min(120, unlockAfter));
      state.roundFinished = true;
      state.isLocked = true;
      renderEngagementLoopCard();
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
    const isDraw = !winner && isDuelDrawReason(reason);
    const opponentName = payload?.opponent || state.duelOpponent || null;
    const ranked = payload?.ranked !== false; // default = ranked
    if (duelId && state.duelId && duelId !== state.duelId) return;

    state.duelMode = false;
    state.duelId = null;
    state.duelOpponent = null;
    state.isLocked = true;
    state.roundFinished = true;
    renderEngagementLoopCard();

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
      await refreshRegionStats();
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
          appendSystemMessage(
            `🔁 Revanšs izaicinājums nosūtīts ${opponentName}.`
          );
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

  // ========== GALDA SPĒLES (dambrete, šahs) ==========
  socket.on("board.invite", (payload) => {
    const from = payload?.from || "?";
    const type = payload?.type || "dambrete";
    showBoardInviteModal(from, type, payload);
    const typeLv =
      type === "chess" ? "šahu" : type === "zole" ? "zoli" : "dambreti";
    const rem = !!payload?.rematch;
    appendGaldaSystemMessage(
      rem
        ? `${from} piedāvā revānšu (${typeLv}). Atver «Galda spēles», lai pieņemtu vai noraidītu.`
        : `${from} uzaicina uz ${typeLv}. Atver «Galda spēles», lai pieņemtu vai noraidītu.`
    );
  });
  socket.on("board.inviteSent", (payload) => {
    const target = String(payload?.target || "").trim();
    const exp = Number(payload?.expiresAt) || Date.now() + 60 * 1000;
    if (target)
      startBoardInviteOutgoingWait(exp, target, {
        toHost: !!payload?.toHost,
      });
    appendGaldaSystemMessage(
      payload?.rematch
        ? "Revānša uzaicinājums nosūtīts."
        : payload?.toHost
          ? "Pieprasījums nosūtīts saimniekam — gaidi atbildi."
          : "Uzaicinājums nosūtīts."
    );
  });
  socket.on("board.inviteDeclined", (payload) => {
    stopBoardInviteOutgoingWait();
    const by = String(payload?.by || "").trim();
    appendGaldaSystemMessage(
      by ? `${by} noraidīja galda uzaicinājumu.` : "Uzaicinājums noraidīts."
    );
  });
  socket.on("board.inviteCancelled", (payload) => {
    clearBoardInviteIncomingInterval();
    const by = String(payload?.by || "").trim();
    hideBoardInviteModal();
    appendGaldaSystemMessage(
      by
        ? `${by} atsauca galda uzaicinājumu.`
        : "Uzaicinājums atcelts."
    );
  });
  socket.on("board.inviteDeclineOk", () => {
    hideBoardInviteModal();
    appendGaldaSystemMessage("Tu noraidīji uzaicinājumu.");
  });
  socket.on("board.inviteCancelOk", () => {
    stopBoardInviteOutgoingWait();
    appendGaldaSystemMessage("Uzaicinājums atcelts.");
  });
  socket.on("board.inviteTimedOut", (payload) => {
    stopBoardInviteOutgoingWait();
    const from = String(payload?.from || "").trim();
    const target = String(payload?.target || "").trim();
    const rem = !!payload?.rematch;
    const me = String(state.username || "").trim().toLowerCase();
    if (from && me === from.toLowerCase()) {
      appendGaldaSystemMessage(
        rem
          ? `${target || "Pretinieks"} neatbildēja uz revānšu (60s).`
          : `${target || "Pretinieks"} neatbildēja uz uzaicinājumu (60s).`
      );
    } else if (target && me === target.toLowerCase()) {
      appendGaldaSystemMessage(
        "Uzaicinājuma termiņš beidzies — vari sūtīt jaunu vai gaidīt citu."
      );
    }
  });
  socket.on("board.zoleThirdInviteTimedOut", (payload) => {
    const t = String(payload?.target || "").trim();
    appendGaldaSystemMessage(
      t
        ? `Trešā vieta (${t}) neatbildēja 90s — vari uzaicināt citu.`
        : "Trešā vieta neatbildēja 90s — vari uzaicināt citu."
    );
  });
  socket.on("board.zoleThirdInviteSent", () => {
    appendGaldaSystemMessage("Zoles uzaicinājums trešajam spēlētājam nosūtīts.");
  });
  socket.on("board.zoleLobby", (payload) => {
    updateZole3pLobbyUI(payload);
  });
  socket.on("board.zoleOpenLobbies", (payload) => {
    zole3pOpenLobbiesCache = {
      rooms: Array.isArray(payload?.rooms) ? payload.rooms : [],
      serverNow: Number(payload?.serverNow) || Date.now(),
    };
    syncZole3pOpenLobbyPanelVisibility();
  });
  socket.on("board.openSeats", (payload) => {
    boardOpenSeatsCache = {
      chess: Array.isArray(payload?.chess) ? payload.chess : [],
      dambrete: Array.isArray(payload?.dambrete) ? payload.dambrete : [],
      serverNow: Number(payload?.serverNow) || Date.now(),
    };
    syncBoardOpenSeatsPanelVisibility();
  });
  socket.on("board.error", (payload) => {
    appendGaldaSystemMessage(payload?.message || "Galda spēles kļūda.");
  });
  socket.on("board.chessDrawState", (payload) => {
    if (payload?.gameId !== boardState.gameId) return;
    if (boardState.type !== "chess") return;
    ingestChessDrawStatePayload(payload?.chessDrawState);
    syncChessDrawControls();
  });
  socket.on("board.start", (payload) => {
    stopBoardInviteOutgoingWait();
    lastBoardResultSnapshot = null;
    zole3pLobbySnapshot = null;
    document.getElementById("board-zole-3p-lobby")?.classList.add("hidden");
    syncBoardDambreteModePanelVisibility();
    /* Neaizvērt modāli — startBoardGame atver spēles zonu; citādi Zole paliek aiz hidden. */
    startBoardGame(payload);
    const t = payload?.type || "dambrete";
    const label =
      t === "chess" ? "Šahs" : t === "zole" ? "Zole" : "Dambrete";
    appendGaldaSystemMessage(`${label} — spēle sākusies.`);
    const myIdx = boardGamePlayerIndex(payload?.players || [], state.username);
    const isMyTurn =
      myIdx === normalizeBoardTurnFromPayload(payload?.turn ?? 0, t);
    updateBoardGameBadge(isMyTurn);
    const gid = payload?.gameId ?? boardState.gameId;
    if (isMyTurn && gid != null) {
      _lastGaldaTurnNotifyKey = galdaTurnNotifyDedupeKey(t, gid, {
        turn: payload?.turn,
        zole: t === "zole" ? payload?.zole : undefined,
      });
      appendGaldaSystemMessage("Tava kārta galda spēlē.");
    }
  });
  socket.on("board.resume", (payload) => {
    startBoardGame(payload);
    appendGaldaSystemMessage(
      "Atjaunoju galda spēli — stāvoklis ielādēts no servera. Vari turpināt."
    );
    const myIdx = boardGamePlayerIndex(payload?.players || [], state.username);
    const t = payload?.type || "dambrete";
    const isMyTurn =
      myIdx === normalizeBoardTurnFromPayload(payload?.turn ?? 0, t);
    updateBoardGameBadge(isMyTurn);
    const gid = payload?.gameId ?? boardState.gameId;
    if (isMyTurn && gid != null) {
      _lastGaldaTurnNotifyKey = galdaTurnNotifyDedupeKey(t, gid, {
        turn: payload?.turn,
        zole: t === "zole" ? payload?.zole : undefined,
      });
      appendGaldaSystemMessage("Tava kārta galda spēlē.");
    }
  });
  socket.on("board.move", (payload) => {
    if (payload?.gameId !== boardState.gameId) return;
    boardLegalMovesFetchId++;
    boardMovesFetchChain = Promise.resolve();
    boardState.board = payload?.board || boardState.board;
    boardState.fen = payload?.fen || boardState.fen;
    boardState.turn = normalizeBoardTurnFromPayload(
      payload?.turn != null ? payload.turn : boardState.turn,
      boardState.type || "dambrete"
    );
    if (boardState.type === "zole" && payload?.zole) {
      boardState.zole = payload.zole;
    }
    if (boardState.type === "zole" && boardState.vsBot) {
      if (payload?.zoleSeriesNewHand) {
        boardState.zoleVsBotNextHandPending = false;
      }
      if (payload?.zoleVsBotNextHandCancelled) {
        boardState.zoleVsBotNextHandPending = false;
      }
    }
    if (
      boardState.type === "zole" &&
      boardState.zoleMode === "vs_bot" &&
      payload?.zoleSeriesHandEnd
    ) {
      boardState.zoleVsBotNextHandPending = true;
      appendGaldaSystemMessage(
        "Partija beigusies — tabula atjaunināta. Izvēlies «Nākamā partija» vai «Pēdējā partija»."
      );
    }
    if (
      boardState.type === "zole" &&
      boardState.zoleMode === "vs_bot" &&
      payload?.zoleVsBotNextHandCancelled
    ) {
      appendGaldaSystemMessage(
        "Izvēlējies pēdējo partiju — citi tiešsaistē redz atzīmi «pēdējā partija»; pēc tās mačs beigsies."
      );
    }
    if (boardState.type === "zole" && payload?.zoleMode != null) {
      const m = String(payload.zoleMode).toLowerCase();
      if (m === "vs_bot") boardState.zoleMode = "vs_bot";
      else if (m === "online_3p") boardState.zoleMode = "online_3p";
      else boardState.zoleMode = "online_2p";
    }
    if (
      boardState.type === "dambrete" &&
      payload?.dambreteVariant != null
    ) {
      boardState.dambreteVariant = normalizeDambreteVariantClient(
        payload.dambreteVariant
      );
    }
    if (boardState.type === "chess" && payload?.chessClock) {
      ingestChessClockPayload(payload);
    }
    if (boardState.type === "chess" && payload?.chessDrawState) {
      ingestChessDrawStatePayload(payload.chessDrawState);
    }
    boardState.selectedCell = null;
    boardState.chessPromotionPick = null;
    // Obligāti notīrīt — pretējā gadījumā paliek iepriekšējās kārtas jumps/moves
    // pret jauno laukumu (piem. pēc bota gājiena) un neviens kauliņš nav klikšķināms līdz refresh.
    boardState.legalMoves = { jumps: [], moves: [] };
    renderBoardGame();
    const myIdx = boardGamePlayerIndex(boardState.players, state.username);
    const isMyTurn =
      boardState.type === "zole" && boardState.zole
        ? boardZoleIsHumanTurn(myIdx, boardState.zole)
        : myIdx === boardState.turn;
    if (isMyTurn) {
      const turnKey = galdaTurnNotifyDedupeKey(
        boardState.type,
        boardState.gameId,
        boardState.type === "zole"
          ? { zole: boardState.zole, turn: boardState.turn }
          : payload
      );
      if (turnKey !== _lastGaldaTurnNotifyKey) {
        _lastGaldaTurnNotifyKey = turnKey;
        appendGaldaSystemMessage("Tava kārta galda spēlē.");
      }
      const modal = document.getElementById("board-games-modal");
      if (modal && modal.classList.contains("hidden")) {
        const gameArea = document.getElementById("board-game-area");
        const lobby = document.getElementById("board-games-lobby");
        if (modal) modal.classList.remove("hidden");
        if (gameArea) gameArea.classList.remove("hidden");
        if (lobby) lobby.classList.add("hidden");
      }
      updateBoardGameBadge(true);
    } else {
      _lastGaldaTurnNotifyKey = null;
      updateBoardGameBadge(false);
    }
    syncBoardModalFullscreen();
  });
  socket.on("board.end", (payload) => {
    if (payload?.gameId !== boardState.gameId) return;
    if (payload?.type === "zole" && payload?.zoleMode != null) {
      const m = String(payload.zoleMode).toLowerCase();
      if (m === "vs_bot") boardState.zoleMode = "vs_bot";
      else if (m === "online_3p") boardState.zoleMode = "online_3p";
      else boardState.zoleMode = "online_2p";
    }
    const winner = payload?.winner;
    const coinsGain = payload?.coinsGain || 0;
    const coinsLoss = payload?.coinsLoss || 0;
    boardState.gameId = null;
    _lastGaldaTurnNotifyKey = null;
    const won =
      winner &&
      String(winner).trim().toLowerCase() ===
        String(state.username || "").trim().toLowerCase();
    let msg = "";
    if (won) {
      msg = coinsGain
        ? `♟️ Tu uzvarēji! +${coinsGain} coins`
        : "♟️ Tu uzvarēji!";
    } else if (winner) {
      msg = coinsLoss ? `♟️ Zaudēji. -${coinsLoss} coins` : "♟️ Zaudēji.";
    } else {
      msg = "♟️ Spēle beidzās (neizšķirts).";
    }
    appendGaldaSystemMessage(msg.replace(/^♟️\s*/, ""));
    showBoardGameResult(payload);
    hideBoardGameArea();
    updateBoardGameBadge(false);
    apiGet("/me")
      .then((me) => {
        updatePlayerCard(me);
        return refreshRegionStats();
      })
      .catch(() => {});
  });
  socket.on("board:leaderboard", () => {
    const modal = document.getElementById("board-games-modal");
    if (modal && !modal.classList.contains("hidden") && !boardState.gameId) {
      loadBoardLeaderboards();
    }
  });
}

function syncBoardModalContext() {
  const el = document.getElementById("board-modal-context");
  if (!el) return;
  const modal = document.getElementById("board-games-modal");
  if (!modal || modal.classList.contains("hidden")) {
    el.textContent = "";
    return;
  }
  const invite = document.getElementById("board-games-invite");
  const gameArea = document.getElementById("board-game-area");
  const inInvite = invite && !invite.classList.contains("hidden");
  const inGame = gameArea && !gameArea.classList.contains("hidden");
  if (inInvite) {
    const from = invite?.dataset?.from || "?";
    const type = invite?.dataset?.type || "dambrete";
    const typeLv =
      type === "chess" ? "šahu" : type === "zole" ? "zoli" : "dambreti";
    el.textContent = `Uzaicinājums: ${from} → ${typeLv}`;
    return;
  }
  if (inGame && boardState.gameId) {
    const t = boardState.type || "dambrete";
    const label =
      t === "chess" ? "Šahs" : t === "zole" ? "Zole" : "Dambrete";
    const ph = boardState.type === "zole" && boardState.zole?.phase;
    const phaseLv =
      ph === "bid"
        ? "likšana"
        : ph === "discard"
          ? "norakšana"
          : ph === "play"
            ? "spēle"
            : ph === "end"
              ? "beigas"
              : "";
    el.textContent = phaseLv ? `${label} · ${phaseLv}` : `${label} · spēle`;
    return;
  }
  if (zole3pLobbySnapshot?.zoleLobby && !boardState.gameId) {
    const h = zole3pLobbySnapshot.host || "?";
    const n = (zole3pLobbySnapshot.players || []).length;
    el.textContent = `Zoles istaba · ${n}/3 · saimnieks: ${h}`;
    return;
  }
  el.textContent = "Izvēlies spēli vai uzaicini draugu.";
}

function syncBoardDambreteModePanelVisibility() {
  const wrap = document.getElementById("board-dambrete-mode-wrap");
  const zoleWrap = document.getElementById("board-zole-mode-wrap");
  const zoleRoomZone = document.getElementById("board-zole-room-zone");
  const zoleRoomEntry = document.getElementById("board-zole-3p-lobby-entry");
  const invite = document.getElementById("board-games-invite");
  const inInvite = invite && !invite.classList.contains("hidden");
  if (wrap) wrap.classList.toggle("hidden", !!inInvite);
  if (zoleWrap) zoleWrap.classList.toggle("hidden", !!inInvite);
  const inZoleRoomFlow =
    getSelectedBoardZoleMode() === "online_3p" ||
    !!zole3pLobbySnapshot?.zoleLobby;
  const showRoomZone = !inInvite && inZoleRoomFlow;
  if (zoleRoomZone) zoleRoomZone.classList.toggle("hidden", !showRoomZone);
  const show3pEntry =
    !inInvite &&
    getSelectedBoardZoleMode() === "online_3p" &&
    !zole3pLobbySnapshot?.zoleLobby;
  if (zoleRoomEntry) zoleRoomEntry.classList.toggle("hidden", !show3pEntry);
  syncBoardChessTimeRowVisibility();
  syncBoardModalContext();
  syncZole3pOpenLobbyPanelVisibility();
  syncBoardOpenSeatsPanelVisibility();
}

function showBoardModal() {
  hideBoardResultOverlay();
  const modal = document.getElementById("board-games-modal");
  const lobby = document.getElementById("board-games-lobby");
  const invite = document.getElementById("board-games-invite");
  const gameArea = document.getElementById("board-game-area");
  const inner = document.getElementById("board-modal-inner");
  const overlay = document.getElementById("board-result-overlay");
  if (modal && modal.classList.contains("hidden")) {
    _boardModalFocusReturn = document.activeElement;
  }
  if (modal) modal.classList.remove("hidden");
  if (boardState.gameId) {
    if (lobby) lobby.classList.add("hidden");
    if (invite) invite.classList.add("hidden");
    if (gameArea) gameArea.classList.remove("hidden");
    renderBoardGame();
    syncBoardModalFullscreen();
    syncZole3pOpenLobbyPanelVisibility();
  } else {
    if (lobby) lobby.classList.remove("hidden");
    if (invite) invite.classList.add("hidden");
    if (gameArea) gameArea.classList.add("hidden");
    if (zole3pLobbySnapshot && !boardState.gameId)
      updateZole3pLobbyUI(zole3pLobbySnapshot);
    loadBoardLeaderboards();
    syncBoardModalFullscreen();
  }
  syncBoardDambreteModePanelVisibility();
  syncBoardModalContext();
  syncZole3pOpenLobbyPanelVisibility();
  syncBoardOpenSeatsPanelVisibility();
  if (inner && (!overlay || overlay.classList.contains("hidden"))) {
    requestAnimationFrame(() => {
      try {
        inner.focus({ preventScroll: true });
      } catch (_) {}
    });
  }
}

async function loadBoardLeaderboards() {
  try {
    const [d, c, z] = await Promise.all([
      apiGet("/board/leaderboard/dambrete"),
      apiGet("/board/leaderboard/chess"),
      apiGet("/board/leaderboard/zole"),
    ]);
    const dEl = document.getElementById("board-lb-dambrete");
    const cEl = document.getElementById("board-lb-chess");
    const zEl = document.getElementById("board-lb-zole");
    if (dEl && d?.list) {
      dEl.innerHTML =
        d.list
          .map(
            (r) =>
              `<div class="vz-board-lb-row"><span class="vz-board-lb-place">${r.place}.</span><span>${escapeHtml(r.username)}</span><span class="vz-board-lb-elo">${r.elo} ELO</span></div>`
          )
          .join("") || "<p>Vēl nav spēlētāju</p>";
    }
    if (cEl && c?.list) {
      cEl.innerHTML =
        c.list
          .map(
            (r) =>
              `<div class="vz-board-lb-row"><span class="vz-board-lb-place">${r.place}.</span><span>${escapeHtml(r.username)}</span><span class="vz-board-lb-elo">${r.elo} ELO</span></div>`
          )
          .join("") || "<p>Vēl nav spēlētāju</p>";
    }
    if (zEl && z?.list) {
      zEl.innerHTML =
        z.list
          .map(
            (r) =>
              `<div class="vz-board-lb-row"><span class="vz-board-lb-place">${r.place}.</span><span>${escapeHtml(r.username)}</span><span class="vz-board-lb-elo">${r.wins} uzvaras</span></div>`
          )
          .join("") || "<p>Vēl nav spēlētāju</p>";
    }
  } catch {}
}

async function exitBoardBrowserFullscreenIfActive() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
  } catch {}
}

function syncBoardBrowserFullscreenUi() {
  const btn = document.getElementById("board-browser-fs-btn");
  const modal = document.getElementById("board-games-modal");
  if (!btn || !modal) return;
  const zoleOn =
    !!boardState.gameId &&
    boardState.type === "zole" &&
    modal.classList.contains("vz-board-modal--fullscreen") &&
    !modal.classList.contains("hidden");
  const inFs = document.fullscreenElement === modal;
  const hideForPwa = isTwa();
  btn.classList.toggle("hidden", !zoleOn || hideForPwa);
  btn.setAttribute("aria-pressed", inFs ? "true" : "false");
  btn.textContent = inFs ? "Pārlūks" : "Pilnekrāns";
  btn.title = hideForPwa
    ? ""
    : inFs
      ? "Atgriezties pie parastā pārlūka skata (adrese redzama)."
      : "Paslēpt pārlūka adreses joslu un izmantot visu ekrānu. Ja nedarbojas — iPhone: pievieno spēli sākumekrānam; Android: «Pilnekrāna spēle» galvenajā izvēlnē.";
}

function syncBoardModalFullscreen() {
  const modal = document.getElementById("board-games-modal");
  if (!modal) return;
  if (modal.classList.contains("hidden")) {
    modal.classList.remove("vz-board-modal--fullscreen");
    syncBoardBrowserFullscreenUi();
    return;
  }
  const zoleFs =
    boardState.gameId && boardState.type === "zole";
  modal.classList.toggle("vz-board-modal--fullscreen", !!zoleFs);
  syncBoardBrowserFullscreenUi();
}

function hideBoardModal() {
  clearZole3pOpenLobbyPoll();
  hideBoardResultOverlay();
  void exitBoardBrowserFullscreenIfActive();
  const modal = document.getElementById("board-games-modal");
  if (modal) {
    modal.classList.add("hidden");
    modal.classList.remove("vz-board-modal--fullscreen");
  }
  syncBoardBrowserFullscreenUi();
  syncBoardDambreteModePanelVisibility();
  syncBoardModalContext();
  if (_boardModalFocusReturn && typeof _boardModalFocusReturn.focus === "function") {
    try {
      _boardModalFocusReturn.focus({ preventScroll: true });
    } catch (_) {}
  }
  _boardModalFocusReturn = null;
}

function showBoardInviteModal(from, type, payload) {
  hideBoardResultOverlay();
  const modal = document.getElementById("board-games-modal");
  const lobby = document.getElementById("board-games-lobby");
  const invite = document.getElementById("board-games-invite");
  const inner = document.getElementById("board-modal-inner");
  if (modal && modal.classList.contains("hidden")) {
    _boardModalFocusReturn = document.activeElement;
  }
  if (modal) modal.classList.remove("hidden");
  if (lobby) lobby.classList.add("hidden");
  if (invite) {
    invite.classList.remove("hidden");
    const fromEl = document.getElementById("board-invite-from");
    const typeEl = document.getElementById("board-invite-type");
    const varEl = document.getElementById("board-invite-dambrete-variant");
    if (fromEl) fromEl.textContent = from;
    const rem = !!payload?.rematch;
    if (typeEl) {
      let base = rem
        ? type === "chess"
          ? "šahu (revānšs)"
          : type === "zole"
            ? "zoli (revānšs)"
            : "dambreti (revānšs)"
        : type === "chess"
          ? "šahu"
          : type === "zole"
            ? "zoli"
            : "dambreti";
      if (!rem && payload?.fromOpenSeatList)
        base += " — pievienošanās no saraksta";
      typeEl.textContent = base;
    }
    invite.dataset.from = from;
    invite.dataset.type = type || "dambrete";
    invite.dataset.inviteId = String(payload?.inviteId || "").trim();
    const invExp = Number(payload?.expiresAt) || 0;
    invite.dataset.inviteExpiresAt = invExp > 0 ? String(invExp) : "";
    const dv =
      type === "dambrete"
        ? normalizeDambreteVariantClient(payload?.dambreteVariant)
        : "russian";
    invite.dataset.dambreteVariant = dv;
    let zm = "";
    if (type === "zole") {
      const raw = String(payload?.zoleMode || "").toLowerCase();
      if (raw === "vs_bot") zm = "vs_bot";
      else if (raw === "online_2p") zm = "online_2p";
      else if (raw === "online_3p") zm = "online_3p";
      else zm = "online_2p";
    }
    invite.dataset.zoleMode = zm;
    const z3 = !!(payload && payload.zoleThirdSeat);
    invite.dataset.zoleThirdSeat = z3 ? "1" : "";
    invite.dataset.zoleLobbyId = z3
      ? String(payload?.zoleLobbyId || "").trim()
      : "";
    const stakeEl = document.getElementById("board-invite-zole-stake");
    const chessTimeEl = document.getElementById("board-invite-chess-time");
    if (stakeEl) {
      if (type === "zole" && z3) {
        const cpp = Math.max(
          0,
          Math.min(5, Math.floor(Number(payload?.zole3pCoinsPerPoint) || 0))
        );
        if (cpp > 0) {
          stakeEl.textContent = `Likme istabā: ${cpp} coins par katru tabulas punktu (+/− pēc partijas).`;
          stakeEl.classList.remove("hidden");
        } else {
          stakeEl.textContent = "";
          stakeEl.classList.add("hidden");
        }
      } else {
        stakeEl.textContent = "";
        stakeEl.classList.add("hidden");
      }
    }
    if (chessTimeEl) {
      if (type === "chess") {
        const pr =
          String(payload?.chessClockPreset || "").trim() ||
          (payload?.chessInitialMs != null
            ? `${Math.round(Number(payload.chessInitialMs) / 60000)}+${Math.round(
                Number(payload.chessIncrementMs || 0) / 1000
              )}`
            : "");
        if (pr) {
          const [a, b] = pr.split("+");
          const inc = String(b ?? "0").trim();
          chessTimeEl.textContent =
            inc !== "0" && inc !== ""
              ? `Šaha laiks: ${a} min katram + ${inc} s pēc gājiena.`
              : `Šaha laiks: ${a} min katram (bez pielikuma).`;
          chessTimeEl.classList.remove("hidden");
        } else {
          chessTimeEl.textContent = "";
          chessTimeEl.classList.add("hidden");
        }
      } else {
        chessTimeEl.textContent = "";
        chessTimeEl.classList.add("hidden");
      }
    }
    if (varEl) {
      if (type === "chess") {
        varEl.textContent = "";
        varEl.classList.add("hidden");
      } else if (type === "zole") {
        varEl.textContent = z3
          ? "Zole: 3 cilvēki (trešā vieta)"
          : `Režīms: ${boardZoleModeLabel(zm)}`;
        varEl.classList.remove("hidden");
      } else {
        varEl.textContent = `Režīms: ${boardDambreteModeLabel(dv)}`;
        varEl.classList.remove("hidden");
      }
    }
  }
  syncBoardModalFullscreen();
  syncBoardDambreteModePanelVisibility();
  syncBoardModalContext();
  syncZole3pOpenLobbyPanelVisibility();
  syncBoardOpenSeatsPanelVisibility();
  startBoardInviteIncomingExpiry();
  if (inner) {
    requestAnimationFrame(() => {
      try {
        inner.focus({ preventScroll: true });
      } catch (_) {}
    });
  }
}

function hideBoardInviteModal() {
  clearBoardInviteIncomingInterval();
  const invite = document.getElementById("board-games-invite");
  if (invite) {
    invite.classList.add("hidden");
    invite.dataset.inviteExpiresAt = "";
  }
  document.getElementById("board-invite-zole-stake")?.classList.add("hidden");
  document.getElementById("board-invite-chess-time")?.classList.add("hidden");
  document.getElementById("board-invite-expires")?.classList.add("hidden");
  showBoardModal();
  syncBoardDambreteModePanelVisibility();
  syncBoardOpenSeatsPanelVisibility();
}

function startBoardGame(payload) {
  _lastGaldaTurnNotifyKey = null;
  hideBoardResultOverlay();
  boardLegalMovesFetchId++;
  boardMovesFetchChain = Promise.resolve();
  if (window.VZZoleBoardTrickHold?.reset) {
    window.VZZoleBoardTrickHold.reset();
  }
  boardState = {
    gameId: payload?.gameId,
    type: payload?.type || "dambrete",
    players: payload?.players || [],
    turn: normalizeBoardTurnFromPayload(
      payload?.turn ?? 0,
      payload?.type || "dambrete"
    ),
    board: payload?.board ? payload.board.map((r) => r.slice()) : null,
    fen: payload?.fen || null,
    zole: payload?.type === "zole" ? payload?.zole || null : null,
    zoleMode:
      payload?.type === "zole"
        ? (() => {
            const m = String(payload?.zoleMode || "").toLowerCase();
            if (m === "vs_bot") return "vs_bot";
            if (m === "online_2p") return "online_2p";
            if (m === "online_3p") return "online_3p";
            return payload?.vsBot ? "vs_bot" : "online_2p";
          })()
        : null,
    vsBot: !!payload?.vsBot,
    zoleVsBotNextHandPending:
      payload?.type === "zole" && !!payload?.vsBot,
    dambreteVariant:
      payload?.type === "dambrete"
        ? normalizeDambreteVariantClient(payload?.dambreteVariant)
        : null,
    selectedCell: null,
    legalMoves: { jumps: [], moves: [] },
    zole3pCoinsPerPoint: (() => {
      if (payload?.type !== "zole") return 0;
      const m = String(payload?.zoleMode || "").toLowerCase();
      if (m !== "online_3p") return 0;
      const c = Math.floor(Number(payload?.zole3pCoinsPerPoint) || 0);
      return Math.max(0, Math.min(5, c));
    })(),
    chessClock: null,
    chessDrawState: null,
    chessPromotionPick: null,
  };
  ingestChessClockPayload(payload);
  ingestChessDrawStatePayload(payload?.chessDrawState);
  const gameArea = document.getElementById("board-game-area");
  const lobby = document.getElementById("board-games-lobby");
  const modal = document.getElementById("board-games-modal");
  if (gameArea) gameArea.classList.remove("hidden");
  if (lobby) lobby.classList.add("hidden");
  if (modal) modal.classList.remove("hidden");
  renderBoardGame();
  syncZoleStakeBannerInGameArea();
  syncBoardModalFullscreen();
  syncBoardDambreteModePanelVisibility();
  syncBoardModalContext();
  syncZole3pOpenLobbyPanelVisibility();
}

function hideBoardGameArea() {
  stopChessClockTick();
  if (window.VZZoleBoardTrickHold?.reset) {
    window.VZZoleBoardTrickHold.reset();
  }
  if (window.VZBoardGames?.resetDambreteTable) {
    window.VZBoardGames.resetDambreteTable();
  }
  void exitBoardBrowserFullscreenIfActive();
  const gameArea = document.getElementById("board-game-area");
  const modal = document.getElementById("board-games-modal");
  if (gameArea) {
    gameArea.classList.add("hidden");
    gameArea.classList.remove(
      "vz-board-zole-play",
      "vz-board-zole-fs",
      "vz-board-zole-compact-top",
      "vz-board-zole-header-meta--hide"
    );
  }
  document.getElementById("board-modal-topbar")?.classList.remove("hidden");
  document.getElementById("board-compact-back-words-btn")?.classList.add("hidden");
  if (modal) modal.classList.add("hidden");
  if (modal) modal.classList.remove("vz-board-modal--fullscreen");
  syncBoardBrowserFullscreenUi();
  updateBoardGameBadge(false);
  document.getElementById("board-zole-stake-banner")?.classList.add("hidden");
  syncBoardModalContext();
  clearZole3pOpenLobbyPoll();
  clearBoardOpenSeatsPoll();
}

function updateBoardGameBadge(show) {
  const badge = document.getElementById("board-games-badge");
  if (!badge) return;
  if (show && boardState.gameId) {
    badge.textContent = "!";
    badge.classList.remove("hidden");
    badge.title = "Tava kārta – nospied, lai atvērtu";
  } else {
    badge.classList.add("hidden");
  }
}

function dambreteSelectedIsValidJumpOrigin() {
  const jumps = boardState.legalMoves?.jumps || [];
  if (!jumps.length || !boardState.selectedCell) return true;
  const [r, c] = boardState.selectedCell;
  for (let i = 0; i < jumps.length; i++) {
    const first = jumps[i].jumps && jumps[i].jumps[0];
    if (first && first.from[0] === r && first.from[1] === c) return true;
  }
  return false;
}

/** Viena šūnas apzīmējums kā šahā (a1–h8), der arī dambretes galdiņam. */
function boardCellAlgebraic(r, c) {
  if (typeof r !== "number" || typeof c !== "number") return "";
  if (r < 0 || r > 7 || c < 0 || c > 7) return "";
  return String.fromCharCode(97 + c) + (8 - r);
}

/** Dambrete: baltais redz apgrieztu galdu — hintā rādam to pašu lauka vārdu kā uz ekrāna. */
function dambreteHintSquare(r, c) {
  const myIdx = boardGamePlayerIndex(boardState.players, state.username);
  if (boardState.type !== "dambrete" || myIdx !== 0) {
    return boardCellAlgebraic(r, c);
  }
  return boardCellAlgebraic(7 - r, 7 - c);
}

function countDambreteValidDestinations(fromR, fromC, legalMoves) {
  if (!legalMoves) return 0;
  const set = new Set();
  for (const m of legalMoves.moves || []) {
    if (
      m.from[0] === fromR &&
      m.from[1] === fromC &&
      m.to &&
      m.to.length >= 2
    )
      set.add(`${m.to[0]},${m.to[1]}`);
  }
  for (const j of legalMoves.jumps || []) {
    const seq = j.jumps || [];
    const first = seq[0];
    const last = seq[seq.length - 1];
    if (
      first &&
      last &&
      first.from[0] === fromR &&
      first.from[1] === fromC &&
      last.to &&
      last.to.length >= 2
    )
      set.add(`${last.to[0]},${last.to[1]}`);
  }
  return set.size;
}

function countChessValidDestinations(fromR, fromC, legalMoves) {
  if (!legalMoves?.moves?.length) return 0;
  const fromSq = boardCellAlgebraic(fromR, fromC);
  let n = 0;
  for (const m of legalMoves.moves) {
    if (m.from === fromSq) n++;
  }
  return n;
}

function renderBoardGame() {
  if (
    boardState.type === "zole" &&
    boardState.zole &&
    window.VZZoleBoardTrickHold?.onZoleSnapshot
  ) {
    window.VZZoleBoardTrickHold.onZoleSnapshot(boardState.zole, () => {
      renderBoardGame();
    });
  }
  const typeEl = document.getElementById("board-game-type");
  const turnEl = document.getElementById("board-game-turn");
  const dambreteContainer = document.getElementById("board-dambrete-container");
  const chessContainer = document.getElementById("board-chess-container");
  const zoleContainer = document.getElementById("board-zole-container");
  const gameAreaEl = document.getElementById("board-game-area");
  if (gameAreaEl) {
    const ingame = !!boardState.gameId;
    gameAreaEl.classList.toggle(
      "vz-board-game-area--chess",
      ingame && boardState.type === "chess"
    );
    gameAreaEl.classList.toggle(
      "vz-board-game-area--dambrete",
      ingame && boardState.type === "dambrete"
    );
  }
  const modalTopbar = document.getElementById("board-modal-topbar");
  const compactBackBtn = document.getElementById("board-compact-back-words-btn");
  const zoleCompactTop =
    boardState.gameId &&
    boardState.type === "zole" &&
    boardState.zole &&
    boardState.zole.phase !== "end";
  if (modalTopbar) {
    modalTopbar.classList.toggle("hidden", !!zoleCompactTop);
  }
  if (compactBackBtn) {
    compactBackBtn.classList.toggle("hidden", !zoleCompactTop);
  }
  if (gameAreaEl) {
    const zPlay =
      boardState.type === "zole" && boardState.zole?.phase === "play";
    const zoleGameOn =
      boardState.gameId &&
      boardState.type === "zole" &&
      !!boardState.zole;
    gameAreaEl.classList.toggle("vz-board-zole-play", zPlay);
    gameAreaEl.classList.toggle("vz-board-zole-fs", zoleGameOn);
    gameAreaEl.classList.toggle("vz-board-zole-compact-top", !!zoleCompactTop);
  }
  if (typeEl) {
    if (boardState.type === "chess") typeEl.textContent = "♔ Šahs";
    else if (boardState.type === "zole") typeEl.textContent = "";
    else
      typeEl.textContent = `♟️ Dambrete (${boardDambreteModeLabel(boardState.dambreteVariant)})`;
  }
  const myIdx = boardGamePlayerIndex(boardState.players, state.username);
  const zoleBidTurn =
    boardState.type === "zole" && boardState.zole?.phase === "bid"
      ? boardState.zole.bidTurn
      : null;
  const isMyTurn =
    zoleBidTurn != null
      ? myIdx === zoleBidTurn
      : boardState.type === "zole" &&
          boardState.zole?.phase === "discard" &&
          boardState.zole?.contract === "big"
        ? myIdx === boardState.zole.contractorIdx
        : myIdx === boardState.turn;
  if (
    boardState.type === "dambrete" &&
    isMyTurn &&
    boardState.selectedCell &&
    !dambreteSelectedIsValidJumpOrigin()
  ) {
    boardState.selectedCell = null;
  }
  const turnName =
    zoleBidTurn != null
      ? boardState.players[zoleBidTurn] || "?"
      : boardState.players[boardState.turn] || "?";
  if (turnEl) {
    if (boardState.type === "zole" && boardState.zole?.phase === "bid") {
      turnEl.textContent = isMyTurn ? "Tava likšanas kārta" : `${turnName} likšanā`;
    } else if (
      boardState.type === "zole" &&
      boardState.zole?.phase === "discard"
    ) {
      turnEl.textContent = isMyTurn ? "Tava kārta" : "Lielais norok…";
    } else if (boardState.type === "zole" && boardState.zole?.phase === "end") {
      turnEl.textContent = "Partija beigusies";
    } else if (
      boardState.type === "zole" &&
      boardState.zole?.phase === "play"
    ) {
      /* Spēles laikā gājienu rāda zilā josla + zaļais apakšteksts; šeit tikai pretinieka vārds. */
      turnEl.textContent = isMyTurn ? "" : turnName;
    } else {
      turnEl.textContent = isMyTurn ? "Tava kārta" : `${turnName} gājienā`;
    }
    turnEl.classList.toggle(
      "vz-board-game-turn--active",
      isMyTurn &&
        (boardState.type === "dambrete" || boardState.type === "chess")
    );
  }
  if (gameAreaEl && boardState.type === "zole" && zoleCompactTop) {
    const hideMetaRow =
      boardState.zole?.phase === "play" && isMyTurn;
    gameAreaEl.classList.toggle("vz-board-zole-header-meta--hide", hideMetaRow);
  } else if (gameAreaEl) {
    gameAreaEl.classList.remove("vz-board-zole-header-meta--hide");
  }
  const hintEl = document.getElementById("board-game-hint");
  const hintWrap = document.getElementById("board-game-hint-wrap");
  const hintSum = document.getElementById("board-game-hint-summary");
  if (hintWrap && hintSum) {
    if (boardState.type === "chess" || boardState.type === "dambrete") {
      hintSum.textContent = "Īsi par gājienu";
      hintWrap.removeAttribute("open");
    } else if (boardState.type === "zole") {
      hintSum.textContent = "Palīdzība";
      hintWrap.setAttribute("open", "");
    } else {
      hintSum.textContent = "Palīdzība";
      hintWrap.removeAttribute("open");
    }
  }
  if (hintEl) {
    if (boardState.type === "zole") {
      if (boardState.zole?.phase === "bid") {
        const br = boardState.zole.bidRound === 2 ? 2 : 1;
        hintEl.textContent = isMyTurn
          ? br === 1
            ? "1. kārta: Lielais, Zole vai Mazā zole — vai garām. Galdiņš nesākas ar pogu; ja 1. un 2. kārtā visi iet garām, tas ieslēdzas pats (visi pa sevi, zaudē ar visvairāk acu)."
            : "2. kārta: tās pašas iespējas (bez atsevišķa «Galdiņš»). Ja atkal visi iet garām — automātiski Galdiņš. Pret botiem pēc partijas nākamā (~2,5 s), tabula uzkrājas."
          : boardState.zoleMode === "vs_bot"
            ? "Gaidām bota likšanu…"
            : "Gaidām citu spēlētāju likšanu…";
      } else if (
        boardState.zole?.phase === "discard" &&
        boardState.zole?.contract === "big"
      ) {
        hintEl.textContent = isMyTurn
          ? "Pēc norakšanas tās 2 kārtu acis pieskaitās tev."
          : "Gaida lielais.";
      } else if (boardState.zole?.phase === "end") {
        hintEl.textContent =
          boardState.zoleMode === "vs_bot"
            ? boardState.zoleVsBotNextHandPending
              ? "Spied «Nākamā partija» vai «Pēdējā partija» (tiešsaistē redzama atzīme; pēc pēdējās partijas mačs beidzas un atgriežies pie vārdu spēles). Atkāpties — pamest uzreiz."
              : "Šī bija pēdējā partija šajā mačā. Vari sākt jaunu spēli no lobija vai aizvērt modāli."
            : "Skaties tabulas punktus zemāk. Uzvarētājs pēc spēles — labākais +/− šajā partijā.";
      } else if (boardState.zole?.phase === "play") {
        hintEl.textContent =
          "Sekšana — labajā apakšā kompakta tabula; pilna tabula un noteikumi — «Punkti · noteikumi» zemāk. Trumpji — «Sekšana un trumpji».";
      } else {
        const c = boardState.zole?.contract;
        let galHint = " Uzvara ar 61+ acīm, ja esi lielais / zole.";
        if (c === "galdins")
          galHint = " Galdiņš: zaudē tas, kam visvairāk acu stiķos.";
        else if (c === "galds")
          galHint =
            " Galds: zaudē tas, kam visvairāk stiķu; ja vienādi — kam vairāk acu.";
        hintEl.textContent = isMyTurn
          ? `Spied uz kārtas (sekšana: parastā vada → vispirms parastā tā mastā; ja parastās nav — atmesties vai trumpis; trumpis vada → trumpis, ja nav — parastā).${galHint}`
          : boardState.zoleMode === "vs_bot"
            ? "Gaidām Zole botu gājienu…"
            : boardState.zoleMode === "online_2p"
              ? "Gaidām otra spēlētāja vai bota gājienu…"
              : "Gaidām otra spēlētāja gājienu…";
      }
    } else if (!isMyTurn) {
      hintEl.textContent =
        boardState.type === "chess" && boardState.chessClock
          ? "Gaidām pretinieka gājienu. Laiks tērējas tikai viņa pusē."
          : "Gaidām pretinieka gājienu.";
    } else if (boardState.type === "dambrete") {
      const jumpsOn = (boardState.legalMoves?.jumps || []).length > 0;
      const sel = boardState.selectedCell;
      if (jumpsOn && !sel) {
        hintEl.innerHTML =
          "<strong>Jālēkt.</strong> Spied uz sava kauliņa ar <strong class=\"vz-hint-mark vz-hint-mark--gold\">zelta aplīti</strong> — tad parādīsies <strong class=\"vz-hint-mark vz-hint-mark--move\">atļauto</strong> mērķa lauki. Citus savus kauliņus šajā brīdī nevar izvēlēties.";
      } else if (jumpsOn && sel) {
        const sq = dambreteHintSquare(sel[0], sel[1]);
        const n = countDambreteValidDestinations(sel[0], sel[1], boardState.legalMoves);
        hintEl.innerHTML =
          n > 0
            ? `Izvēlēts <strong class="vz-hint-mark vz-hint-mark--cyan">${sq}</strong>. Tagad spied <strong class="vz-hint-mark vz-hint-mark--move">atļauto</strong> lauciņu (${n} ${n === 1 ? "iespēja" : "iespējas"}) — lēciena beigas. Citur — citu sākuma kauliņu.`
            : `Izvēlēts <strong class="vz-hint-mark vz-hint-mark--cyan">${sq}</strong>. Spied citu kauliņu ar <strong class="vz-hint-mark vz-hint-mark--gold">zelta aplīti</strong> vai atļauto mērķi.`;
      } else if (sel) {
        const sq = dambreteHintSquare(sel[0], sel[1]);
        const n = countDambreteValidDestinations(sel[0], sel[1], boardState.legalMoves);
        hintEl.innerHTML =
          n > 0
            ? `Izvēlēts <strong class="vz-hint-mark vz-hint-mark--cyan">${sq}</strong>. Spied <strong class="vz-hint-mark vz-hint-mark--move">atļauto</strong> lauciņu (${n} ${n === 1 ? "gājiens" : "gājieni"}). Citur — maini figūru.`
            : `Izvēlēts <strong class="vz-hint-mark vz-hint-mark--cyan">${sq}</strong>. Nav derīgu lauku — izvēlies citu savu kauliņu.`;
      } else {
        hintEl.innerHTML =
          "Spied savu kauliņu, tad <strong class=\"vz-hint-mark vz-hint-mark--move\">atļauto</strong> lauciņu. Mainīt izvēli — spied citu savu kauliņu.";
      }
    } else if (boardState.type === "chess") {
      const clockNote = (() => {
        const ck = boardState.chessClock;
        if (!ck) return "";
        const iniMin = Math.max(
          1,
          Math.round(
            (ck.initialMsPerSide || 10 * 60 * 1000) / 60000
          )
        );
        const incS = Math.max(0, Math.round((ck.incrementMs || 0) / 1000));
        const base =
          incS > 0
            ? ` Laiks: ${iniMin} min + ${incS} s pēc gājiena.`
            : ` Laiks: ${iniMin} min bez pielikuma.`;
        return boardState.vsBot
          ? `${base} (pret botu tavs laiks; botam «bezgalīgi».)`
          : `${base} Laiks tērējas tikai aktīvā gājiena pusē.`;
      })();
      const sel = boardState.selectedCell;
      if (sel) {
        const sq = boardCellAlgebraic(sel[0], sel[1]);
        const n = countChessValidDestinations(sel[0], sel[1], boardState.legalMoves);
        hintEl.innerHTML =
          n > 0
            ? `Izvēlēta figūra <strong class="vz-hint-mark vz-hint-mark--cyan">${sq}</strong>. Spied <strong class="vz-hint-mark vz-hint-mark--move">atļauto</strong> lauciņu (${n} ${n === 1 ? "gājiens" : "gājieni"}). Citur — atcelt vai citu figūru.${clockNote}`
            : `Izvēlēta <strong class="vz-hint-mark vz-hint-mark--cyan">${sq}</strong>. Nav derīgu lauku — izvēlies citu savu figūru.${clockNote}`;
      } else {
        hintEl.innerHTML =
          `Spied savu figūru, tad <strong class="vz-hint-mark vz-hint-mark--move">atļauto</strong> lauciņu (uz dēļa iezīmēts zaļi). Mainīt — spied citu savu figūru.${clockNote}`;
      }
    } else {
      hintEl.textContent =
        "Izvēlies savu figūru, pēc tam lauciņu, kur gribi gājienu veikt. Lai mainītu figūru — pieskaries citam savam kauliņam.";
    }
  }

  if (boardState.type === "zole" && boardState.zole) {
    if (chessContainer) chessContainer.classList.add("hidden");
    if (dambreteContainer) dambreteContainer.classList.add("hidden");
    if (window.VZBoardGames?.resetDambreteTable) {
      window.VZBoardGames.resetDambreteTable();
    }
    if (window.VZZoleBoard && zoleContainer) {
      window.VZZoleBoard.renderZoleBoard(
        boardState.zole,
        isMyTurn,
        (card) => {
          if (!state.socket || !boardState.gameId) return;
          state.socket.emit("board.move", {
            gameId: boardState.gameId,
            card,
          });
        },
        {
          zoleMode: boardState.zoleMode,
          myIdx,
          vsBotEndPending:
            boardState.zoleMode === "vs_bot" &&
            boardState.zole?.phase === "end" &&
            boardState.zoleVsBotNextHandPending,
          onZoleVsBotLastHand: () => {
            if (!state.socket || !boardState.gameId) return;
            state.socket.emit("board.zoleVsBotCancelNextHand", {
              gameId: boardState.gameId,
            });
          },
          onZoleVsBotNextHand: () => {
            if (!state.socket || !boardState.gameId) return;
            state.socket.emit("board.zoleVsBotNextHand", {
              gameId: boardState.gameId,
            });
          },
          onBid: (bid) => {
            if (!state.socket || !boardState.gameId) return;
            state.socket.emit("board.move", {
              gameId: boardState.gameId,
              bid,
            });
          },
          onDiscard: (pair) => {
            if (!state.socket || !boardState.gameId || pair.length !== 2) return;
            state.socket.emit("board.move", {
              gameId: boardState.gameId,
              discard: pair,
            });
          },
        }
      );
      if (window.VZZoleBoard?.syncOpponentAvatars && zoleContainer) {
        window.VZZoleBoard.syncOpponentAvatars(zoleContainer, applyMiniAvatar);
      }
    }
  } else if (boardState.type === "dambrete" && boardState.board) {
    if (zoleContainer) {
      zoleContainer.classList.add("hidden");
      zoleContainer.innerHTML = "";
    }
    if (chessContainer) chessContainer.classList.add("hidden");
    if (window.VZBoardGames && dambreteContainer) {
      window.VZBoardGames.renderDambreteBoard(
        boardState.board,
        boardState.turn,
        isMyTurn,
        myIdx,
        (r, c, isPiece) => handleDambreteCellClick(r, c, isPiece),
        boardState.selectedCell,
        boardState.legalMoves
      );
    }
  } else if (boardState.type === "chess" && boardState.fen) {
    if (zoleContainer) {
      zoleContainer.classList.add("hidden");
      zoleContainer.innerHTML = "";
    }
    if (window.VZBoardGames?.resetDambreteTable) {
      window.VZBoardGames.resetDambreteTable();
    }
    if (dambreteContainer) dambreteContainer.classList.add("hidden");
    if (chessContainer && window.VZBoardGames) {
      let promoPick = null;
      const pp = boardState.chessPromotionPick;
      if (
        pp &&
        boardState.selectedCell &&
        pp.fromR === boardState.selectedCell[0] &&
        pp.fromC === boardState.selectedCell[1] &&
        Array.isArray(pp.sans) &&
        pp.sans.length > 1
      ) {
        promoPick = { sans: pp.sans };
      }
      window.VZBoardGames.renderChessBoard(
        boardState.fen,
        boardState.turn,
        isMyTurn,
        myIdx,
        (r, c, isPiece) => handleChessCellClick(r, c, isPiece),
        boardState.selectedCell,
        boardState.legalMoves,
        promoPick,
        emitChessPromotionSan
      );
    }
  }
  const resignEl = document.getElementById("board-resign-btn");
  if (resignEl) {
    const zoleHandOver =
      boardState.type === "zole" && boardState.zole?.phase === "end";
    resignEl.classList.toggle("hidden", !boardState.gameId || zoleHandOver);
  }

  syncZoleStakeBannerInGameArea();
  syncBoardModalFullscreen();
  syncBoardBrowserFullscreenUi();
  syncBoardModalContext();
  syncChessClockDom();
  syncChessDrawControls();
}

async function handleChessCellClick(r, c, isPiece) {
  if (!state.socket || !boardState.gameId) return;
  const myIdx = boardGamePlayerIndex(boardState.players, state.username);
  if (myIdx !== boardState.turn) return;

  const chBoard = window.VZBoardGames?.parseFenToBoard?.(boardState.fen);
  const ch = chBoard?.[r]?.[c];
  if (
    ch &&
    ((myIdx === 0 && /[PNBRQK]/.test(ch)) ||
      (myIdx === 1 && /[pnbrqk]/.test(ch)))
  ) {
    isPiece = true;
  }

  if (isPiece) {
    if (
      boardState.selectedCell &&
      boardState.selectedCell[0] === r &&
      boardState.selectedCell[1] === c
    ) {
      boardState.selectedCell = null;
      boardState.chessPromotionPick = null;
      renderBoardGame();
      return;
    }
    const clickedCell = [r, c];
    boardState.selectedCell = clickedCell;
    boardState.chessPromotionPick = null;
    renderBoardGame();
    const hasServerMoves = (boardState.legalMoves?.moves || []).length > 0;
    if (!hasServerMoves) {
      queueBoardLegalMovesFetch(clickedCell, "chess");
    }
    return;
  }

  if (!boardState.selectedCell) return;
  const multi = window.VZBoardGames?.findChessMovesFromTo?.(
    boardState.selectedCell,
    r,
    c,
    boardState.legalMoves
  );
  const list = Array.isArray(multi) ? multi : [];
  if (list.length === 0) {
    boardState.selectedCell = null;
    boardState.chessPromotionPick = null;
    renderBoardGame();
    return;
  }
  if (list.length === 1) {
    state.socket.emit("board.move", {
      gameId: boardState.gameId,
      san: list[0].san,
    });
    boardState.selectedCell = null;
    boardState.chessPromotionPick = null;
    return;
  }
  const uniq = [...new Set(list.map((m) => m.san).filter(Boolean))];
  const promoOrder = { q: 0, r: 1, b: 2, n: 3 };
  uniq.sort((a, b) => {
    const ca = String(a).slice(-1).toLowerCase();
    const cb = String(b).slice(-1).toLowerCase();
    return (promoOrder[ca] ?? 99) - (promoOrder[cb] ?? 99);
  });
  const sans = uniq;
  boardState.chessPromotionPick = {
    fromR: boardState.selectedCell[0],
    fromC: boardState.selectedCell[1],
    toR: r,
    toC: c,
    sans,
  };
  renderBoardGame();
}

function emitChessPromotionSan(san) {
  if (!state.socket || !boardState.gameId || !san) return;
  state.socket.emit("board.move", { gameId: boardState.gameId, san });
  boardState.selectedCell = null;
  boardState.chessPromotionPick = null;
  renderBoardGame();
}

async function handleDambreteCellClick(r, c, isPiece) {
  if (!state.socket || !boardState.gameId) return;
  const myIdx = boardGamePlayerIndex(boardState.players, state.username);
  if (myIdx !== boardState.turn) return;

  const cellPiece = boardState.board?.[r]?.[c] ?? 0;
  const absP = Math.abs(cellPiece);
  if (
    (absP === 1 || absP === 2) &&
    ((myIdx === 0 && cellPiece > 0) || (myIdx === 1 && cellPiece < 0))
  ) {
    isPiece = true;
  }

  if (isPiece) {
    if (
      boardState.selectedCell &&
      boardState.selectedCell[0] === r &&
      boardState.selectedCell[1] === c
    ) {
      boardState.selectedCell = null;
      renderBoardGame();
      return;
    }
    const jumps = boardState.legalMoves?.jumps || [];
    if (jumps.length > 0) {
      let canStartJumpHere = false;
      for (let i = 0; i < jumps.length; i++) {
        const first = jumps[i].jumps && jumps[i].jumps[0];
        if (first && first.from[0] === r && first.from[1] === c) {
          canStartJumpHere = true;
          break;
        }
      }
      if (!canStartJumpHere) return;
    }
    const clickedCell = [r, c];
    boardState.selectedCell = clickedCell;
    renderBoardGame();
    const hasServerMoves =
      (boardState.legalMoves?.jumps || []).length > 0 ||
      (boardState.legalMoves?.moves || []).length > 0;
    if (!hasServerMoves) {
      queueBoardLegalMovesFetch(clickedCell, "dambrete");
    }
    return;
  }

  if (!boardState.selectedCell) return;
  const [fr, fc] = boardState.selectedCell;
  const moves = boardState.legalMoves?.moves || [];
  const jumps = boardState.legalMoves?.jumps || [];
  let move = null;
  if (jumps.length) {
    move = jumps.find((j) => {
      const seq = j.jumps || [];
      const first = seq[0];
      const last = seq[seq.length - 1];
      return (
        first &&
        last &&
        first.from[0] === fr &&
        first.from[1] === fc &&
        last.to[0] === r &&
        last.to[1] === c
      );
    });
    if (move) move = { jumps: move.jumps };
  } else {
    move = moves.find(
      (m) =>
        m.from[0] === fr && m.from[1] === fc && m.to[0] === r && m.to[1] === c
    );
  }
  if (!move) {
    boardState.selectedCell = null;
    renderBoardGame();
    return;
  }
  state.socket.emit("board.move", { gameId: boardState.gameId, move });
  boardState.selectedCell = null;
}

function boardGamesEnsureSocketConnected() {
  if (!state.token) {
    appendGaldaSystemMessage(
      "Lai spēlētu, vispirms pieslēdzies (izraksties un ieej vēlreiz)."
    );
    return false;
  }
  if (!state.socket) {
    appendGaldaSystemMessage(
      "Nav servera savienojuma. Gaidi ziņu «Pieslēgts…» vai atsvaidzini lapu."
    );
    return false;
  }
  if (!state.socket.connected) {
    appendGaldaSystemMessage(
      "Savienojums vēl nav gatavs. Pagaidi brīdi vai atsvaidzini lapu."
    );
    return false;
  }
  return true;
}

function bindBoardGames() {
  const btn = document.getElementById("board-games-btn");
  const closeBtn = document.getElementById("board-modal-close");
  const inviteDambrete = document.getElementById("board-invite-dambrete");
  const inviteChess = document.getElementById("board-invite-chess");
  const inviteUsername = document.getElementById("board-invite-username");
  const acceptBtn = document.getElementById("board-invite-accept");
  const declineBtn = document.getElementById("board-invite-decline");
  const resignBtn = document.getElementById("board-resign-btn");
  const ppInviteDambrete = document.getElementById("pp-invite-dambrete");
  const ppInviteChess = document.getElementById("pp-invite-chess");
  const ppInviteZole = document.getElementById("pp-invite-zole");

  if (btn) btn.addEventListener("click", showBoardModal);
  if (closeBtn) closeBtn.addEventListener("click", hideBoardModal);
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || ev.defaultPrevented) return;
    const modal = document.getElementById("board-games-modal");
    const res = document.getElementById("board-result-overlay");
    if (!modal || modal.classList.contains("hidden")) return;
    if (res && !res.classList.contains("hidden")) return;
    ev.preventDefault();
    hideBoardModal();
  });
  const backToWords = () => {
    hideBoardModal();
    document
      .getElementById("vz-section-game")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  document.getElementById("board-back-words-btn")?.addEventListener("click", backToWords);
  document.getElementById("board-compact-back-words-btn")?.addEventListener("click", backToWords);
  const boardResultClose = document.getElementById("board-result-close");
  const boardResultOverlay = document.getElementById("board-result-overlay");
  if (boardResultClose)
    boardResultClose.addEventListener("click", hideBoardResultOverlay);
  document
    .getElementById("board-result-play-again-vsbot")
    ?.addEventListener("click", () => {
      const btn = document.getElementById("board-result-play-again-vsbot");
      const t = String(btn?.dataset?.gameType || "").toLowerCase();
      if (!t || (t !== "dambrete" && t !== "chess")) return;
      hideBoardResultOverlay();
      showBoardModal();
      const diffEl = document.querySelector(
        'input[name="board-bot-diff"]:checked'
      );
      const difficulty = diffEl?.value || "medium";
      const payload = { type: t, difficulty };
      if (t === "dambrete")
        payload.dambreteVariant = getSelectedBoardDambreteVariant();
      if (t === "chess")
        payload.chessClockPreset = getChessClockPresetForVsBot();
      if (!boardGamesEnsureSocketConnected()) return;
      const gameArea = document.getElementById("board-game-area");
      const lobby = document.getElementById("board-games-lobby");
      if (gameArea) gameArea.classList.remove("hidden");
      if (lobby) lobby.classList.add("hidden");
      state.socket.emit("board.startVsBot", payload);
      stopBoardInviteOutgoingWait();
    });
  document
    .getElementById("board-result-rematch")
    ?.addEventListener("click", sendBoardRematchInvite);
  if (boardResultOverlay) {
    boardResultOverlay.addEventListener("click", (e) => {
      if (e.target === boardResultOverlay) hideBoardResultOverlay();
    });
  }
  const doInvite = (type) => {
    const target = inviteUsername?.value?.trim() || currentProfileName?.trim();
    if (!target) {
      appendGaldaSystemMessage("Ievadi spēlētāja lietotājvārdu.");
      return;
    }
    if (!boardGamesEnsureSocketConnected()) return;
    const payload = { target, type };
    if (type === "dambrete")
      payload.dambreteVariant = getSelectedBoardDambreteVariant();
    if (type === "chess")
      payload.chessClockPreset = getChessClockPresetForPvp();
    if (type === "zole") {
      const zm = getSelectedBoardZoleMode();
      if (zm !== "online_2p" && zm !== "online_3p") {
        appendGaldaSystemMessage(
          "Drauga zolei izvēlies «3 cilvēki» vai «2 cilvēki + bots»."
        );
        return;
      }
      if (zm === "online_3p") {
        const snap = zole3pLobbySnapshot;
        const me = String(state.username || "").trim().toLowerCase();
        const hostLc = String(snap?.host || "").trim().toLowerCase();
        const inRoom = (snap?.players || []).some(
          (p) => String(p).trim().toLowerCase() === me
        );
        if (!snap?.zoleLobby || hostLc !== me || !inRoom) {
          appendGaldaSystemMessage(
            "Zolei ar 3 cilvēkiem vispirms spied «Izveidot zoles istabu», tad uzaicini draugus."
          );
          return;
        }
      }
      payload.zoleMode = zm;
    }
    state.socket.emit("board.invite", payload);
  };
  if (inviteDambrete)
    inviteDambrete.addEventListener("click", () => doInvite("dambrete"));
  if (inviteChess)
    inviteChess.addEventListener("click", () => doInvite("chess"));
  const inviteZole = document.getElementById("board-invite-zole");
  if (inviteZole) inviteZole.addEventListener("click", () => doInvite("zole"));
  const vsBotDambrete = document.getElementById("board-vsbot-dambrete");
  const vsBotChess = document.getElementById("board-vsbot-chess");
  const doVsBot = (type) => {
    if (!boardGamesEnsureSocketConnected()) return;
    const diffEl = document.querySelector(
      'input[name="board-bot-diff"]:checked'
    );
    const difficulty = diffEl?.value || "medium";
    const payload = { type, difficulty };
    if (type === "dambrete")
      payload.dambreteVariant = getSelectedBoardDambreteVariant();
    if (type === "zole") payload.zoleMode = "vs_bot";
    if (type === "chess")
      payload.chessClockPreset = getChessClockPresetForVsBot();
    showBoardModal();
    const gameArea = document.getElementById("board-game-area");
    const lobby = document.getElementById("board-games-lobby");
    if (gameArea) gameArea.classList.remove("hidden");
    if (lobby) lobby.classList.add("hidden");
    state.socket.emit("board.startVsBot", payload);
    stopBoardInviteOutgoingWait();
  };
  if (vsBotDambrete)
    vsBotDambrete.addEventListener("click", () => doVsBot("dambrete"));
  if (vsBotChess) vsBotChess.addEventListener("click", () => doVsBot("chess"));
  const vsBotZole = document.getElementById("board-vsbot-zole");
  if (vsBotZole) vsBotZole.addEventListener("click", () => doVsBot("zole"));
  if (acceptBtn)
    acceptBtn.addEventListener("click", () => {
      const invite = document.getElementById("board-games-invite");
      const from = invite?.dataset?.from || "";
      const type = invite?.dataset?.type || "dambrete";
      const isZoleThird = invite?.dataset?.zoleThirdSeat === "1";
      if (isZoleThird && type === "zole" && state.socket) {
        state.socket.emit("board.zoleAcceptThird", {
          inviteId: String(invite?.dataset?.inviteId || "").trim(),
          from,
          lobbyId: String(invite?.dataset?.zoleLobbyId || "").trim(),
        });
        hideBoardInviteModal();
        return;
      }
      const acc = {
        inviteId: String(invite?.dataset?.inviteId || "").trim(),
        from,
        type,
      };
      if (type === "dambrete" && invite?.dataset?.dambreteVariant)
        acc.dambreteVariant = invite.dataset.dambreteVariant;
      if (type === "zole" && invite?.dataset?.zoleMode)
        acc.zoleMode = invite.dataset.zoleMode;
      if (state.socket) state.socket.emit("board.accept", acc);
      hideBoardInviteModal();
    });
  if (declineBtn)
    declineBtn.addEventListener("click", () => {
      const invite = document.getElementById("board-games-invite");
      const isZoleThird =
        invite?.dataset?.zoleThirdSeat === "1" &&
        (invite?.dataset?.type || "") === "zole";
      if (isZoleThird && state.socket) {
        state.socket.emit("board.zoleDeclineThird", {
          inviteId: String(invite?.dataset?.inviteId || "").trim(),
        });
        hideBoardInviteModal();
        return;
      }
      const from = String(invite?.dataset?.from || "").trim();
      const type = invite?.dataset?.type || "dambrete";
      if (from && state.socket) {
        state.socket.emit("board.inviteDecline", { from, type });
      } else {
        hideBoardInviteModal();
      }
    });
  document
    .getElementById("board-invite-pending-cancel")
    ?.addEventListener("click", () => {
      const pending = document.getElementById("board-invite-pending");
      const target = String(pending?.dataset?.waitTarget || "").trim();
      if (!target || !state.socket) return;
      state.socket.emit("board.inviteCancel", { target });
    });
  const zole3pInviteThird = document.getElementById("board-zole-3p-invite-third");
  const zole3pCancel = document.getElementById("board-zole-3p-cancel-lobby");
  const zole3pThirdInput = document.getElementById("board-zole-3p-third");
  if (zole3pInviteThird)
    zole3pInviteThird.addEventListener("click", () => {
      const t = zole3pThirdInput?.value?.trim();
      if (!t) {
        appendGaldaSystemMessage("Ievadi trešā spēlētāja vārdu.");
        return;
      }
      if (!state.socket) return;
      state.socket.emit("board.zoleInviteThird", { target: t });
    });
  if (zole3pCancel)
    zole3pCancel.addEventListener("click", () => {
      if (state.socket) state.socket.emit("board.zoleCancelLobby");
      zole3pLobbySnapshot = null;
      document.getElementById("board-zole-3p-lobby")?.classList.add("hidden");
      syncBoardDambreteModePanelVisibility();
    });
  if (resignBtn)
    resignBtn.addEventListener("click", () => {
      if (!boardState.gameId || !state.socket) return;
      state.socket.emit("board.resign", { gameId: boardState.gameId });
    });
  document.getElementById("board-chess-draw-offer")?.addEventListener("click", () => {
    if (!boardState.gameId || !state.socket || boardState.type !== "chess") return;
    state.socket.emit("board.chessDrawOffer", { gameId: boardState.gameId });
  });
  document.getElementById("board-chess-draw-accept")?.addEventListener("click", () => {
    if (!boardState.gameId || !state.socket || boardState.type !== "chess") return;
    state.socket.emit("board.chessDrawAccept", { gameId: boardState.gameId });
  });
  document.getElementById("board-chess-claim-draw")?.addEventListener("click", () => {
    if (!boardState.gameId || !state.socket || boardState.type !== "chess") return;
    state.socket.emit("board.chessClaimDraw", { gameId: boardState.gameId });
  });
  const boardFsBtn = document.getElementById("board-browser-fs-btn");
  if (boardFsBtn) {
    boardFsBtn.addEventListener("click", async () => {
      const modal = document.getElementById("board-games-modal");
      if (!modal || modal.classList.contains("hidden")) return;
      try {
        if (document.fullscreenElement === modal) {
          await document.exitFullscreen();
        } else if (modal.requestFullscreen) {
          await modal.requestFullscreen();
        } else {
          appendGaldaSystemMessage(
            "Šis pārlūks neatbalsta pilnekrānu. iPhone: pievieno spēli sākumekrānam. Android: izmanto «Pilnekrāna spēle» galvenajā izvēlnē."
          );
        }
      } catch {
        appendGaldaSystemMessage(
          "Pilnekrānu nevarēja ieslēgt. Mēģini citu pārlūku vai pievieno spēli sākumekrānam."
        );
      }
    });
  }
  document.addEventListener("fullscreenchange", () => {
    syncBoardBrowserFullscreenUi();
  });
  if (ppInviteDambrete)
    ppInviteDambrete.addEventListener("click", () => {
      const target = currentProfileName?.trim();
      if (target && state.socket) {
        showBoardModal();
        if (inviteUsername) inviteUsername.value = target;
        state.socket.emit("board.invite", {
          target,
          type: "dambrete",
          dambreteVariant: getSelectedBoardDambreteVariant(),
        });
      }
    });
  if (ppInviteChess)
    ppInviteChess.addEventListener("click", () => {
      const target = currentProfileName?.trim();
      if (target && state.socket) {
        showBoardModal();
        if (inviteUsername) inviteUsername.value = target;
        state.socket.emit("board.invite", { target, type: "chess" });
      }
    });
  if (ppInviteZole)
    ppInviteZole.addEventListener("click", () => {
      const target = currentProfileName?.trim();
      if (target && state.socket) {
        showBoardModal();
        if (inviteUsername) inviteUsername.value = target;
        appendGaldaSystemMessage(
          "Zolei ar 3 cilvēkiem: spied «Izveidot zoles istabu», tad «Zole» ar šo vārdu formā."
        );
      }
    });
  document.querySelectorAll(".js-zole-create-lobby").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!state.socket) return;
      const stakeEl = document.getElementById("board-zole-3p-stake");
      const cpp = Math.max(
        0,
        Math.min(5, Math.floor(Number(stakeEl?.value) || 0))
      );
      state.socket.emit("board.zoleCreateLobby", { zole3pCoinsPerPoint: cpp });
    });
  });
  document.getElementById("board-zole-3p-stake")?.addEventListener("change", () => {
    if (!state.socket) return;
    const snap = zole3pLobbySnapshot;
    if (!snap?.zoleLobby) return;
    const me = String(state.username || "").trim();
    const host = String(snap.host || "").trim();
    if (!me || !host || me.toLowerCase() !== host.toLowerCase()) return;
    if ((snap.players || []).length >= 3) return;
    const cpp = Math.max(
      0,
      Math.min(5, Math.floor(Number(document.getElementById("board-zole-3p-stake")?.value) || 0))
    );
    state.socket.emit("board.zoleSetLobbyStake", { zole3pCoinsPerPoint: cpp });
  });
  document
    .getElementById("board-zole-3p-leave-lobby")
    ?.addEventListener("click", () => {
      if (state.socket) state.socket.emit("board.zoleLeaveLobby");
    });
  document.querySelectorAll('input[name="board-zole-mode"]').forEach((el) => {
    el.addEventListener("change", () => syncBoardDambreteModePanelVisibility());
  });
  syncBoardChessTimeRowVisibility();
  document
    .getElementById("board-zole-3p-open-lobbies")
    ?.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".js-zole-open-lobby-join");
      if (!btn || btn.disabled) return;
      const lid = String(btn.dataset.zoleLobbyId || "").trim();
      if (!lid) return;
      const label = String(btn.textContent || "").trim();
      if (label === "Atvērt") {
        showBoardModal();
        const snap = zole3pLobbySnapshot;
        if (String(snap?.lobbyId || "").trim() === lid) {
          updateZole3pLobbyUI(snap);
        }
        return;
      }
      if (!boardGamesEnsureSocketConnected()) return;
      state.socket.emit("board.zoleJoinOpenLobby", { lobbyId: lid });
    });
  document
    .getElementById("board-dambrete-open-seat-publish")
    ?.addEventListener("click", () => {
      if (!boardGamesEnsureSocketConnected()) return;
      state.socket.emit("board.openSeatPublish", {
        type: "dambrete",
        dambreteVariant: getSelectedBoardDambreteVariant(),
      });
    });
  document
    .getElementById("board-chess-open-seat-publish")
    ?.addEventListener("click", () => {
      if (!boardGamesEnsureSocketConnected()) return;
      state.socket.emit("board.openSeatPublish", {
        type: "chess",
        chessClockPreset: getChessClockPresetForPvp(),
      });
    });
  document
    .getElementById("board-dambrete-open-seat-cancel")
    ?.addEventListener("click", () => {
      if (!boardGamesEnsureSocketConnected()) return;
      state.socket.emit("board.openSeatCancel");
    });
  document
    .getElementById("board-chess-open-seat-cancel")
    ?.addEventListener("click", () => {
      if (!boardGamesEnsureSocketConnected()) return;
      state.socket.emit("board.openSeatCancel");
    });
  document
    .getElementById("board-dambrete-open-seats")
    ?.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".js-board-open-seat-join");
      if (!btn || btn.disabled) return;
      const host = String(btn.dataset.openSeatHost || "").trim();
      if (!host) return;
      if (!boardGamesEnsureSocketConnected()) return;
      state.socket.emit("board.requestOpenSeatInvite", {
        host,
        type: "dambrete",
      });
    });
  document
    .getElementById("board-chess-open-seats")
    ?.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".js-board-open-seat-join");
      if (!btn || btn.disabled) return;
      const host = String(btn.dataset.openSeatHost || "").trim();
      if (!host) return;
      if (!boardGamesEnsureSocketConnected()) return;
      state.socket.emit("board.requestOpenSeatInvite", {
        host,
        type: "chess",
      });
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
    appendSystemMessage(
      `Ziņa par gara (${text.length}/${CHAT_MAX_LEN}). Saīsini un sūti vēlreiz.`
    );
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
      appendSystemMessage(
        `📢 ${(season && season.name) || "SEZONA"} ir startēta!`
      );
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
    appendSystemMessage(
      `🎟️ Tu nopirki 1 žetonu! Tagad tev ir ${data.tokens} žetoni.`
    );
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

async function handleBuyVip() {
  if (!state.token || !buyVipBtn) return;
  setVipBuyStatus("VIP pirkšana ar žetoniem nav pieejama.", "error");
  appendSystemMessage(
    "👑 VIP pirkšana ar žetoniem ir izslēgta. Žetoni ir paredzēti laimes ratam."
  );
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
    sub.textContent = nextAt
      ? `Nākamais pēc: ${formatMsShort(left)}`
      : "Nāc rīt!";
  }
}

async function refreshDailyChestStatus() {
  if (!state.token) return;
  try {
    const s = await apiGet("/chest/status");
    _chestStatus = s;
    ensureDailyChestUi();
    renderDailyChestUi(s);
    renderEngagementLoopCard();
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

    appendSystemMessage(
      `🎁 Daily Chest atvērts: ${parts.join(", ") || "balva"} (streak ${streak})`
    );
    animateDailyChestReward();
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
    topTimeEl.textContent = now.toLocaleTimeString("lv-LV", {
      hour: "2-digit",
      minute: "2-digit",
    });
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
    const url = API_BASE + "/meta/weather";
    const res = await fetchWithTimeout(url, {}, 10_000);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();

    const cw = data.current_weather;
    if (!cw || data.unavailable === true) {
      topWeatherEl.textContent = "Laikapstākļi nav pieejami";
      return;
    }

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
    const url = API_BASE + "/meta/nameday";
    const res = await fetchWithTimeout(url, {}, 10_000);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();

    let names = "";
    if (data && data.nameday && (data.nameday.lv || data.nameday["lv"])) {
      names = data.nameday.lv || data.nameday["lv"];
    }

    topNamedayEl.textContent = names
      ? "Vārda diena: " + names
      : "Vārda diena: —";
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

// Bez Supabase avatāri glabājas inline; serveris izgriež > AVATAR_INLINE_MAX_CHARS.
// Saspiemam līdz 95KB, lai vienmēr saglabātos (arī sarežģītas bildes).
const AVATAR_COMPRESS_MAX_CHARS = 95 * 1024;

async function compressAvatarDataUrl(dataUrl, maxDim = 512) {
  if (!dataUrl || typeof dataUrl !== "string") return dataUrl;

  const img = await loadImageFromDataUrl(dataUrl);
  const w = img.naturalWidth || img.width || 0;
  const h = img.naturalHeight || img.height || 0;
  if (!w || !h) return dataUrl;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;

  const formats = [
    { type: "image/webp", quality: 0.8 },
    { type: "image/webp", quality: 0.65 },
    { type: "image/webp", quality: 0.5 },
    { type: "image/jpeg", quality: 0.8 },
    { type: "image/jpeg", quality: 0.65 },
    { type: "image/jpeg", quality: 0.5 },
    { type: "image/jpeg", quality: 0.4 },
    { type: "image/jpeg", quality: 0.3 },
  ];

  const dims = [maxDim, 384, 320, 256, 192, 128, 96, 80, 64, 48];
  for (const dim of dims) {
    const maxSide = Math.max(w, h);
    const scale = Math.min(1, dim / maxSide);
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    canvas.width = tw;
    canvas.height = th;
    ctx.drawImage(img, 0, 0, tw, th);

    for (const fmt of formats) {
      try {
        const out = canvas.toDataURL(fmt.type, fmt.quality);
        if (
          out &&
          out.startsWith("data:image/") &&
          out.length <= AVATAR_COMPRESS_MAX_CHARS
        ) {
          return out;
        }
      } catch {}
    }
  }

  for (let q = 0.35; q >= 0.15; q -= 0.05) {
    try {
      const out = canvas.toDataURL("image/jpeg", q);
      if (out && out.length <= AVATAR_COMPRESS_MAX_CHARS) return out;
    } catch {}
  }

  canvas.width = 48;
  canvas.height = 48;
  ctx.drawImage(img, 0, 0, 48, 48);
  for (let q = 0.5; q >= 0.2; q -= 0.1) {
    try {
      const out = canvas.toDataURL("image/jpeg", q);
      if (out && out.length <= AVATAR_COMPRESS_MAX_CHARS) return out;
    } catch {}
  }
  return canvas.toDataURL("image/jpeg", 0.2);
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

  const reader = new FileReader();
  reader.onload = async () => {
    let dataUrl = reader.result;

    try {
      dataUrl = await compressAvatarDataUrl(String(dataUrl), 512);
    } catch (err) {
      console.warn("Avatar compress kļūda:", err);
    }

    setLocalAvatar(state.username, dataUrl);

    setAvatar(
      playerAvatarImgEl,
      playerAvatarInitialsEl,
      dataUrl,
      state.username
    );
    setAvatar(ppAvatarImgEl, ppAvatarInitialsEl, dataUrl, state.username);

    if (state.token) {
      try {
        await apiPost("/avatar", { avatar: dataUrl });
        appendSystemMessage(
          "Tavs avatārs atjaunots un saglabāts serverī (sync ar citām ierīcēm)."
        );
      } catch (err) {
        console.error("Avatāra sync kļūda:", err);
        appendSystemMessage(
          "Avatārs saglabāts šajā ierīcē, bet servera sync neizdevās: " +
            (err.message || "")
        );
      }
    } else {
      appendSystemMessage(
        "Tavs avatārs atjaunots šajā ierīcē. (Nav tokena, servera sync izlaists.)"
      );
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
  window.open(
    "https://discord.com/channels/@me",
    "_blank",
    "noopener,noreferrer"
  );
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
    correct: "🟥",
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
    correct: "#9d2235",
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
  const rowsUsed = Math.max(
    1,
    Math.min(state.rows, attemptsUsed || state.rows)
  );
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
  renderEngagementLoopCard();
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
        statusEl.textContent =
          "Neizdevās palaist radio (pārbaudi URL vai pārlūka atļaujas).";
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
  const bar = ensureFsBottomBar();
  const fsBtn = document.getElementById("mobile-fullscreen-btn");
  const revealBtn = document.getElementById("vz-btn-reveal-letter");
  const wrap = document.getElementById("vz-reveal-letter-wrap");

  if (on) {
    if (!_fsBtnHomes) {
      _fsBtnHomes = [];
      if (newRoundBtn) {
        _fsBtnHomes.push({
          btn: newRoundBtn,
          parent: newRoundBtn.parentNode,
          next: newRoundBtn.nextSibling,
        });
      }
      if (fsBtn) {
        _fsBtnHomes.push({
          btn: fsBtn,
          parent: fsBtn.parentNode,
          next: fsBtn.nextSibling,
        });
      }
      if (revealBtn && wrap) {
        _fsBtnHomes.push({
          btn: wrap,
          parent: wrap.parentNode,
          next: wrap.nextSibling,
        });
      }
    }

    bar.style.display = "flex";
    bar.style.flexWrap = "wrap";
    bar.style.gap = "10px";
    bar.style.justifyContent = "center";
    bar.style.alignItems = "center";
    if (fsBtn) bar.appendChild(fsBtn);
    if (revealBtn && wrap) bar.appendChild(wrap);
    if (newRoundBtn) bar.appendChild(newRoundBtn);
  } else {
    bar.style.display = "none";
    bar.innerHTML = "";
    if (_fsBtnHomes) {
      for (const h of _fsBtnHomes) {
        if (!h.parent || !h.btn) continue;
        if (h.next) h.parent.insertBefore(h.btn, h.next);
        else h.parent.appendChild(h.btn);
      }
    }
  }
}
let _logoutHome = null;

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
  const refreshToken = getStoredFirst(AUTH_KEYS.refreshToken);
  const accessExp = Number(getStoredFirst(AUTH_KEYS.accessExpiresAt) || 0);
  const refreshExp = Number(getStoredFirst(AUTH_KEYS.refreshExpiresAt) || 0);

  if (!token || !username) {
    window.location.href = "index.html";
    return;
  }

  state.token = token;
  state.refreshToken = refreshToken || null;
  state.accessTokenExpiresAt =
    Number.isFinite(accessExp) && accessExp > 0 ? Math.floor(accessExp) : 0;
  state.refreshTokenExpiresAt =
    Number.isFinite(refreshExp) && refreshExp > 0 ? Math.floor(refreshExp) : 0;
  state.username = username;
  try {
    state.dmNotifyOn = localStorage.getItem("vz_dm_notify") !== "off";
  } catch {}

  // kanonizējam
  setStoredAuth(token, username, {
    refreshToken: state.refreshToken,
    accessTokenExpiresAt: state.accessTokenExpiresAt,
    refreshTokenExpiresAt: state.refreshTokenExpiresAt,
  });

  // Migrācija: ja ir vecais “vz_avatar” un nav per-user, pārliekam
  try {
    const legacy = localStorage.getItem("vz_avatar");
    const perUser = localStorage.getItem(avatarStorageKey(state.username));
    if (legacy && !perUser)
      localStorage.setItem(avatarStorageKey(state.username), legacy);
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

  function resetOfflineOverlayToBrowserDefault() {
    if (offlineTitleEl) offlineTitleEl.textContent = "Nav interneta";
    if (offlineTextEl)
      offlineTextEl.textContent =
        "Pārbaudi savienojumu un mēģini vēlreiz.";
    if (offlineHintEl) {
      offlineHintEl.textContent = "";
      offlineHintEl.classList.add("hidden");
    }
    if (offlineLoginBtn) offlineLoginBtn.classList.add("hidden");
    if (offlineRetryBtn) offlineRetryBtn.textContent = "Mēģināt vēlreiz";
  }

  if (!navigator.onLine) {
    resetOfflineOverlayToBrowserDefault();
    setOfflineOverlay(true);
  }
  window.addEventListener("offline", () => {
    resetOfflineOverlayToBrowserDefault();
    setOfflineOverlay(true);
  });
  window.addEventListener("online", () => {
    setOfflineOverlay(false);
    _vzConnIssueLastKey = "";
  });
  if (offlineRetryBtn) {
    offlineRetryBtn.addEventListener("click", () => {
      setOfflineOverlay(false);
      window.location.reload();
    });
  }
  if (offlineLoginBtn) {
    offlineLoginBtn.addEventListener("click", () => {
      setOfflineOverlay(false);
      window.location.href = "index.html#session";
    });
  }
  if (rateLaterBtn) {
    rateLaterBtn.addEventListener("click", (e) => {
      e.preventDefault();
      handleRatePromptLater();
    });
  }
  if (rateFeedbackBtn) {
    rateFeedbackBtn.addEventListener("click", () => {
      handleRatePromptFeedback();
    });
  }
  if (rateOpenBtn) {
    rateOpenBtn.addEventListener("click", () => {
      handleRatePromptAccepted();
    });
  }
  if (tutorialReopenBtn) {
    tutorialReopenBtn.addEventListener("click", () => {
      showTutorial();
      const details = tutorialReopenBtn.closest("details");
      if (details) details.open = false;
    });
  }

  if (challengeFriendBtn) {
    challengeFriendBtn.addEventListener("click", async () => {
      if (!state.token) return;
      try {
        const data = await apiPost("/challenge/create", {});
        if (challengeShareUrlInput)
          challengeShareUrlInput.value = data.shareUrl || "";
        if (challengeCopyStatus) challengeCopyStatus.textContent = "";
        if (challengeCreateModal)
          challengeCreateModal.classList.remove("hidden");
      } catch (err) {
        appendSystemMessage(err.message || "Neizdevās izveidot izaicinājumu.");
      }
    });
  }
  if (challengeCopyBtn && challengeShareUrlInput) {
    challengeCopyBtn.addEventListener("click", () => {
      challengeShareUrlInput.select();
      try {
        navigator.clipboard.writeText(challengeShareUrlInput.value);
        if (challengeCopyStatus) challengeCopyStatus.textContent = "Nokopēts!";
      } catch {
        if (challengeCopyStatus)
          challengeCopyStatus.textContent = "Nokopē ar Ctrl+C";
      }
    });
  }
  if (challengeCreateClose && challengeCreateModal) {
    challengeCreateClose.addEventListener("click", () =>
      challengeCreateModal.classList.add("hidden")
    );
  }
  if (challengeJoinAccept) {
    challengeJoinAccept.addEventListener("click", async () => {
      const id = pendingChallengeId;
      if (!id) return;
      try {
        await apiPost("/challenge/" + id + "/join", {});
        if (challengeJoinModal) challengeJoinModal.classList.add("hidden");
        pendingChallengeId = null;
        clearChallengeFromUrl();
        await startChallengeRound(id);
      } catch (err) {
        appendSystemMessage(err.message || "Neizdevās pievienoties.");
      }
    });
  }
  if (challengeJoinDecline) {
    challengeJoinDecline.addEventListener("click", () => {
      if (challengeJoinModal) challengeJoinModal.classList.add("hidden");
      pendingChallengeId = null;
      clearChallengeFromUrl();
    });
  }
  if (challengeResultClose) {
    challengeResultClose.addEventListener("click", () => {
      exitChallengeMode();
      startNewRound();
    });
  }

  if (appDownloadLink) {
    appDownloadLink.addEventListener("click", (e) => {
      if (appInstallModal) {
        e.preventDefault();
        if (appInstallPwaRow && deferredInstallPrompt)
          appInstallPwaRow.style.display = "flex";
        else if (appInstallPwaRow) appInstallPwaRow.style.display = "none";
        appInstallModal.classList.remove("hidden");
      }
    });
  }
  if (appInstallPwaBtn) {
    appInstallPwaBtn.addEventListener("click", async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      if (appInstallPwaRow) appInstallPwaRow.style.display = "none";
      if (appInstallModal) appInstallModal.classList.add("hidden");
    });
  }
  if (appInstallClose && appInstallModal) {
    appInstallClose.addEventListener("click", () =>
      appInstallModal.classList.add("hidden")
    );
  }
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (appInstallPwaRow) appInstallPwaRow.style.display = "flex";
  });

  if (shareBtn) shareBtn.addEventListener("click", handleShare);
  if (shareWhatsappBtn)
    shareWhatsappBtn.addEventListener("click", handleShareWhatsapp);
  if (shareDiscordBtn)
    shareDiscordBtn.addEventListener("click", handleShareDiscord);
  if (shareResultBtn)
    shareResultBtn.addEventListener("click", handleShareResult);
  if (shareResultWhatsappBtn)
    shareResultWhatsappBtn.addEventListener("click", handleShareResultWhatsapp);
  if (shareResultDiscordBtn)
    shareResultDiscordBtn.addEventListener("click", handleShareResultDiscord);

  const bottomNav = document.getElementById("vz-bottom-nav");
  if (bottomNav) {
    bottomNav.querySelectorAll(".vz-bottom-nav-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.scroll;
        if (!id) return;
        const el = document.getElementById(id);
        if (el) {
          const details = el.closest("details");
          if (details && !details.open) details.open = true;
          el.scrollIntoView({ behavior: "smooth", block: "start" });
          bottomNav.querySelectorAll(".vz-bottom-nav-btn").forEach((b) => {
            b.classList.remove("vz-bottom-nav-active");
            b.removeAttribute("aria-current");
          });
          btn.classList.add("vz-bottom-nav-active");
          btn.setAttribute("aria-current", "page");
        }
      });
    });
  }

  if (engagementLoopPrimaryBtnEl) {
    engagementLoopPrimaryBtnEl.addEventListener("click", () =>
      runEngagementLoopAction(state.loopPrimaryAction)
    );
  }
  if (tournamentRefreshBtnEl) {
    tournamentRefreshBtnEl.addEventListener("click", () =>
      refreshTournamentCard(true)
    );
  }
  if (tournamentReportBtnEl) {
    tournamentReportBtnEl.addEventListener(
      "click",
      handleTournamentReportSubmit
    );
  }
  if (tournamentDisputeBtnEl) {
    tournamentDisputeBtnEl.addEventListener(
      "click",
      handleTournamentDisputeSubmit
    );
  }
  if (tournamentWeeklyJoinBtnEl) {
    tournamentWeeklyJoinBtnEl.addEventListener(
      "click",
      handleTournamentWeeklyJoin
    );
  }
  if (vipRoomSlotsEl) {
    vipRoomSlotsEl.addEventListener("change", () => {
      state.vipRoomDraftInvites = normalizeVipRoomDraftInvites(
        state.vipRoomDraftInvites,
        currentVipRoomSlots()
      );
      renderVipRoomPanel();
    });
  }
  if (vipRoomTypeEl) {
    vipRoomTypeEl.addEventListener("change", () => {
      syncVipRoomSlotOptions();
      state.vipRoomDraftInvites = normalizeVipRoomDraftInvites(
        state.vipRoomDraftInvites,
        currentVipRoomSlots()
      );
      renderVipRoomPanel();
    });
  }
  if (vipRoomCreateBtnEl) {
    vipRoomCreateBtnEl.addEventListener("click", handleVipRoomCreate);
  }
  if (vipQuickTournamentCreateBtnEl) {
    vipQuickTournamentCreateBtnEl.addEventListener(
      "click",
      handleVipQuickTournamentCreate
    );
  }
  if (tournamentScore1InputEl) {
    tournamentScore1InputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleTournamentReportSubmit();
      }
    });
  }
  if (tournamentScore2InputEl) {
    tournamentScore2InputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleTournamentReportSubmit();
      }
    });
  }

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
    playerAvatarUploadBtnEl.addEventListener("click", () =>
      playerAvatarFileEl.click()
    );
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

    const clear = () => {
      if (t) clearTimeout(t);
      t = null;
    };

    const start = () => {
      clear();
      t = setTimeout(() => {
        // atzīmējam, lai click pēc long-press neatver DM
        fab.dataset.lpJustDid = "1";
        setTimeout(() => {
          fab.dataset.lpJustDid = "0";
        }, 400);

        const next = !state.dmNotifyOn;
        state.dmNotifyOn = next;
        try {
          localStorage.setItem("vz_dm_notify", next ? "on" : "off");
        } catch {}

        // parādam statusu pat tad, ja tikko izslēdzi (apejam dmToast “off” check)
        if (toast) {
          toast.textContent = next ? "DM paziņojumi: ON" : "DM paziņojumi: OFF";
          toast.dataset.from = "";
          toast.style.display = "block";
          setTimeout(() => {
            toast.style.display = "none";
          }, 1500);
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
      const refreshToken = String(state.refreshToken || "").trim();
      const accessToken = String(state.token || "").trim();
      try {
        fetch(API_BASE + "/logout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(accessToken ? { Authorization: "Bearer " + accessToken } : {}),
          },
          body: JSON.stringify({
            refreshToken,
            allDevices: false,
          }),
          keepalive: true,
        });
      } catch {}
      clearOneSignalIdentity();
      if (state.socket) {
        state.socket.disconnect();
        state.socket = null;
      }
      if (tournamentRefreshTimer) {
        clearInterval(tournamentRefreshTimer);
        tournamentRefreshTimer = null;
      }
      if (tournamentCountdownTimer) {
        clearInterval(tournamentCountdownTimer);
        tournamentCountdownTimer = null;
      }
      if (engagementLoopTimer) {
        clearInterval(engagementLoopTimer);
        engagementLoopTimer = null;
      }
      state.refreshToken = null;
      state.accessTokenExpiresAt = 0;
      state.refreshTokenExpiresAt = 0;
      clearStoredAuth();
      window.location.href = "index.html";
    });
  }

  if (newRoundBtn) {
    newRoundBtn.addEventListener("click", () => {
      if (state.challengeId) {
        exitChallengeMode();
        startNewRound();
        return;
      }
      if (!state.roundFinished) {
        if (gameMessageEl)
          gameMessageEl.textContent =
            "Pabeidz raundu līdz galam, tad var sākt jaunu.";
        return;
      }
      if (!state.duelMode) startNewRound();
    });
  }

  if (buyTokenBtn) buyTokenBtn.addEventListener("click", handleBuyToken);
  if (buyVipBtn) buyVipBtn.addEventListener("click", handleBuyVip);

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

      setFullscreenBottomButtons(!isFullscreenOn); // <-- ŠEIT
      // pēc režīma pārslēgšanas pārrēķinam režģi (DOM vēl pārkārtojas)
      try {
        document.activeElement &&
          document.activeElement.blur &&
          document.activeElement.blur();
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

  if (chatMessagesEl)
    chatMessagesEl.addEventListener("scroll", () => clearUnreadIfNeeded());
  document.addEventListener("visibilitychange", () => clearUnreadIfNeeded());

  if (chatMentionBadgeEl) {
    chatMentionBadgeEl.addEventListener("click", () => {
      if (!lastMention) {
        showMentionPopup("Nav pieminējumu.");
        return;
      }
      const t = new Date(lastMention.ts || Date.now()).toLocaleTimeString(
        "lv-LV",
        {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Europe/Riga",
        }
      );
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

  if (profileCloseBtn)
    profileCloseBtn.addEventListener("click", hidePlayerProfile);
  if (profilePopupEl) {
    profilePopupEl.addEventListener("click", (e) => {
      if (e.target === profilePopupEl) hidePlayerProfile();
    });
  }

  if (ppMsgBtnEl)
    ppMsgBtnEl.addEventListener("click", handlePersonalMessageClick);
  if (ppEmailSaveBtn)
    ppEmailSaveBtn.addEventListener("click", handleProfileEmailSave);
  if (ppEmailRemoveBtn)
    ppEmailRemoveBtn.addEventListener("click", handleProfileEmailRemove);
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
    const msg =
      ev && ev.reason && ev.reason.message
        ? ev.reason.message
        : "Nezināma kļūda (Promise).";
    if (/ResizeObserver loop/i.test(String(msg))) {
      console.warn("unhandledrejection (benign, ignored for chat):", ev.reason);
      return;
    }
    console.error("unhandledrejection:", ev.reason);
    appendSystemMessage("⚠️ Kļūda: " + msg);
  });
  window.addEventListener("error", (ev) => {
    const msg = ev && ev.message ? ev.message : "Nezināma kļūda.";
    if (/ResizeObserver loop/i.test(String(msg))) {
      console.warn("window.error (benign, ignored for chat):", msg);
      return;
    }
    console.error("window.error:", ev);
    appendSystemMessage("⚠️ Kļūda: " + msg);
  });

  bindRegionModal();
  bindRegionActions();

  try {
    const me = await apiGet("/me");
    updatePlayerCard(me);
    initOneSignalPush(me.username || state.username);

    // Avatar auto-sync (per-user)
    try {
      const localEntry = getLocalAvatarEntry(me.username);
      const localAvatar = localEntry?.url || null;
      const serverAvatar = me.avatarUrl || null;
      const serverExp = Number(me.avatarUrlExpiresAt) || 0;

      if (localAvatar && !serverAvatar && state.token) {
        await apiPost("/avatar", { avatar: localAvatar });
        appendSystemMessage(
          "Tavs lokālais avatārs nosūtīts uz serveri (sync)."
        );
      }

      if (!localAvatar && serverAvatar) {
        setLocalAvatar(me.username, serverAvatar, serverExp);
        setAvatar(
          playerAvatarImgEl,
          playerAvatarInitialsEl,
          serverAvatar,
          state.username
        );
        setAvatar(
          ppAvatarImgEl,
          ppAvatarInitialsEl,
          serverAvatar,
          state.username
        );
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
    try {
      sessionStorage.setItem(
        "vz_auth_notice",
        "Neizdevās ielādēt kontu no servera. Ielogojies vēlreiz."
      );
    } catch {}
    clearStoredAuth();
    window.location.href = "index.html#session";
  }
}

document.addEventListener("DOMContentLoaded", initGame);

// Līmeņa pacēluma animācija
let _levelUpDismissTimer = null;
function showLevelUpAnimation(level, rankTitle) {
  if (typeof document === "undefined" || PREFERS_REDUCED_MOTION) return;
  const overlay = document.getElementById("vz-level-up-overlay");
  const subtitle = document.getElementById("vz-level-up-num");
  const titleEl = document.getElementById("vz-level-up-title");
  if (!overlay || !subtitle || !titleEl) return;
  if (_levelUpDismissTimer) clearTimeout(_levelUpDismissTimer);
  subtitle.textContent = String(level);
  titleEl.textContent = rankTitle || "";
  overlay.classList.remove("hidden");
  overlay.style.pointerEvents = "auto";
  const dismiss = () => {
    overlay.classList.add("hidden");
    overlay.style.pointerEvents = "none";
    overlay.onclick = null;
    if (_levelUpDismissTimer) clearTimeout(_levelUpDismissTimer);
    _levelUpDismissTimer = null;
  };
  overlay.onclick = dismiss;
  if (typeof confetti === "function") {
    confetti({
      particleCount: 100,
      spread: 100,
      origin: { y: 0.5 },
      colors: ["#ffd700", "#ff8c00", "#9d2235"],
    });
  }
  _levelUpDismissTimer = setTimeout(dismiss, 4000);
}

// Rezerves flash (ja kaut kur gribi izsaukt manuāli)
function triggerWinFlash() {
  const flashElement = document.getElementById("screen-flash");
  if (!flashElement) return;

  flashElement.classList.add("vz-screen-flash-active");
  setTimeout(
    () => flashElement.classList.remove("vz-screen-flash-active"),
    300
  );
}
