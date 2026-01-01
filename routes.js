import * as base from "./base.js";
const {
  ADMIN_USERNAMES, ADMIN_USERNAMES_LC, AFK_BREAK_MS, AVATAR_MAX_CHARS, BAD_LEN_BLOCK_MS, BAD_LEN_MAX,
  BAD_LEN_WINDOW_MS, BASE_TOKEN_PRICE, BODY_JSON_LIMIT, BODY_URLENC_LIMIT, CHAT_DUP_WINDOW_MS, CHAT_MAX_LEN,
  CHAT_RATE_MS, COINS_PER_LETTER_BONUS, COINS_PER_WIN_BASE, COINS_STREAK_MAX_BONUS, CORS_ORIGINS, CORS_ORIGINS_RAW,
  DAILY_MISSIONS_CONFIG, DUEL_MAX_ATTEMPTS, DUEL_MAX_DURATION_MS, DUEL_REWARD_COINS, DUEL_REWARD_XP, GUESS_ALLOWED_RE,
  GUESS_RATE_MS, JWT_SECRET, MAX_ATTEMPTS, MAX_WORD_LEN, MIN_WORD_LEN, PASSIVE_COINS_PER_TICK,
  PASSIVE_INTERVAL_MS, PORT, RESET_COINS_TOKENS_ON_ROLLOVER, REVEAL_LETTER_COST_COINS, SCORE_PER_WIN, SEASON1_END_AT,
  SEASON2_END_AT_DEFAULT, SEASONS_FILE, SEASON_DAYS, TZ, USERS, USERS_FILE,
  WHEEL_ANNOUNCE_TO_CHAT, WHEEL_DEFAULT_SPIN_MS, WHEEL_FILE, WHEEL_MAX_SLOTS, WORDS, WORDS_FILE,
  XP_PER_LETTER_BONUS, XP_PER_STREAK_STEP, XP_PER_WIN_BASE, XP_STREAK_MAX_STEPS, __dirname, __filename,
  addSpecialMedalOnce, app, authMiddleware, broadcastOnlineList, buildInitialSeasonStore, buildInitialWheelStore,
  buildMePayload, calcRankFromXp, championMedalCode, championMedalLabel, computeMedalsForUser, computeNextSeasonEndAt,
  corsOptions, defaultSeasonFinishedAt, duels, ensureDailyChest, ensureDailyMissions, ensureRankFields,
  ensureSpecialMedals, finalizeSeasonIfNeeded, findUserKeyCaseInsensitive, getMiniUserPayload, getPublicMissions, getTokenPrice,
  getTop1UserByScore, getTzOffsetMinutes, httpServer, io, isAdminName, isAdminUser,
  lastOnlineSig, loadJsonSafe, loadUsers, markActivity, mergeMedals, nextMidnightRigaTs,
  normalizeWheelStore, onlineBySocket, publicWheelState, removeSpecialMedalFromAllUsers, resetCoinsAndTokensForAllUsers, resetWinsTodayIfNeeded,
  saveJsonAtomic, saveUsers, saveWheelStore, seasonState, seasonStore, startSeasonFlow,
  todayKey, updateMissionsOnGuess, upsertHallOfFameWinner, userToDuel, wheelAdd, wheelApplySettings,
  wheelBlockIfSpinning, wheelComputeTokenSlots, wheelEmitError, wheelEmitUpdate, wheelFinishSpin, wheelGetCombinedSlots,
  wheelIsSpinningNow, wheelNsp, wheelRemoveAllByName, wheelRemoveOneByIndex, wheelRequireAdmin, wheelShuffle,
  wheelStartSpin, wheelStore, wheelSyncTokenSlots, wheelTokenMeta, wheelTokenSig, wheelTokenSlots,
  setWheelNsp
} = base;

// ======== LEADERBOARD (TOP10) ========
function computeTop10Leaderboard() {
  const arr = Object.values(USERS || {})
    .filter((u) => u && u.username && !u.isBanned)
    .slice();

  arr.forEach((u) => ensureRankFields(u));

  arr.sort((a, b) => {
    const ds = (b.score || 0) - (a.score || 0);
    if (ds !== 0) return ds;
    const dx = (b.xp || 0) - (a.xp || 0);
    if (dx !== 0) return dx;
    return String(a.username).localeCompare(String(b.username));
  });

  return arr.slice(0, 10).map((u, idx) => ({
    place: idx + 1,
    username: u.username,
    score: u.score || 0,
    xp: u.xp || 0,
    rankTitle: u.rankTitle || "—",
    rankLevel: u.rankLevel || 1,
    avatarUrl: u.avatarUrl || null,
    supporter: !!u.supporter,
  }));
}

let lastLbSig = "";
function broadcastLeaderboard(force = false) {
  const top = computeTop10Leaderboard();
  const sig = top
    .map(
      (u) =>
        `${u.place}|${u.username}|${u.score}|${u.xp}|${u.rankLevel}|${
          u.avatarUrl || ""
        }|${u.supporter ? 1 : 0}`
    )
    .join(";");

  if (!force && sig === lastLbSig) return;
  lastLbSig = sig;

  io.emit("leaderboard:update", top);
}
setInterval(() => broadcastLeaderboard(false), 45 * 1000);

// === Admin & čata helperi ===
function broadcastSystemMessage(text) {
  io.emit("chatMessage", { username: "SYSTEM", text, ts: Date.now() });
}

function kickUserByName(username, reason) {
  const ids = [];
  for (const [sid, uname] of onlineBySocket.entries()) {
    if (uname === username) ids.push(sid);
  }

  for (const sid of ids) {
    const s = io.sockets.sockets.get(sid);
    if (s) {
      try {
        s.emit("forceDisconnect", { reason: reason || "kick" });
      } catch {}
      s.disconnect(true);
    }
    onlineBySocket.delete(sid);
  }

  broadcastOnlineList(true);
}

function handleAdminCommand(raw, adminUser, adminSocket) {
  const parts = raw.slice(1).trim().split(/\s+/);
  const cmd = (parts[0] || "").toLowerCase();
  const targetName = parts[1];
  const arg = parts[2];

  if (!cmd) {
    adminSocket.emit("chatMessage", {
      username: "SYSTEM",
      text: "Komanda nav norādīta.",
      ts: Date.now(),
    });
    return;
  }

  if (["ban", "unban", "kick", "mute", "unmute"].includes(cmd) && !targetName) {
    adminSocket.emit("chatMessage", {
      username: "SYSTEM",
      text: "Norādi lietotājvārdu. Piem.: /kick Nick",
      ts: Date.now(),
    });
    return;
  }

  const key = targetName ? findUserKeyCaseInsensitive(targetName) : null;
  const target = key ? USERS[key] : null;

  switch (cmd) {
    case "kick":
      if (!target) {
        adminSocket.emit("chatMessage", {
          username: "SYSTEM",
          text: `Lietotājs '${targetName}' nav atrasts.`,
          ts: Date.now(),
        });
        return;
      }
      kickUserByName(target.username, "kick");
      broadcastSystemMessage(
        `Admin ${adminUser.username} izmeta lietotāju ${target.username}.`
      );
      break;

    case "ban":
      if (!target) {
        adminSocket.emit("chatMessage", {
          username: "SYSTEM",
          text: `Lietotājs '${targetName}' nav atrasts.`,
          ts: Date.now(),
        });
        return;
      }
      target.isBanned = true;
      saveUsers(USERS);
      kickUserByName(target.username, "ban");
      broadcastSystemMessage(
        `Admin ${adminUser.username} nobanoja lietotāju ${target.username}.`
      );
      wheelSyncTokenSlots(true);
      wheelEmitUpdate(true);
      break;

    case "unban":
      if (!target) {
        adminSocket.emit("chatMessage", {
          username: "SYSTEM",
          text: `Lietotājs '${targetName}' nav atrasts.`,
          ts: Date.now(),
        });
        return;
      }
      target.isBanned = false;
      saveUsers(USERS);
      broadcastSystemMessage(
        `Admin ${adminUser.username} atbanoja lietotāju ${target.username}.`
      );
      wheelSyncTokenSlots(true);
      wheelEmitUpdate(true);
      break;

    case "mute": {
      if (!target) {
        adminSocket.emit("chatMessage", {
          username: "SYSTEM",
          text: `Lietotājs '${targetName}' nav atrasts.`,
          ts: Date.now(),
        });
        return;
      }
      const minutesRaw = parseInt(arg || "5", 10);
      const mins = Number.isNaN(minutesRaw)
        ? 5
        : Math.max(1, Math.min(1440, minutesRaw));
      target.mutedUntil = Date.now() + mins * 60 * 1000;
      saveUsers(USERS);
      broadcastSystemMessage(
        `Admin ${adminUser.username} uzlika mute lietotājam ${target.username} uz ${mins} min.`
      );
      break;
    }

    case "unmute":
      if (!target) {
        adminSocket.emit("chatMessage", {
          username: "SYSTEM",
          text: `Lietotājs '${targetName}' nav atrasts.`,
          ts: Date.now(),
        });
        return;
      }
      target.mutedUntil = 0;
      saveUsers(USERS);
      broadcastSystemMessage(
        `Admin ${adminUser.username} noņēma mute lietotājam ${target.username}.`
      );
      break;

    case "seasonstart": {
      if (!isAdminUser(adminUser)) {
        adminSocket.emit("chatMessage", {
          username: "SYSTEM",
          text: "Tikai admins var startēt sezonu.",
          ts: Date.now(),
        });
        return;
      }

      const result = startSeasonFlow({ byAdminUsername: adminUser.username });

      if (result.mode === "already_active") {
        adminSocket.emit("chatMessage", {
          username: "SYSTEM",
          text: `${result.season.name} jau ir aktīva.`,
          ts: Date.now(),
        });
        return;
      }

      const endStr = result.season.endAt
        ? new Date(result.season.endAt).toLocaleString("lv-LV", { timeZone: TZ })
        : "—";

      if (result.mode === "rolled_next") {
        if (result.hofEntry) {
          broadcastSystemMessage(
            `🏆 Sezona ${result.hofEntry.seasonId} čempions: ${result.hofEntry.username} (score ${result.hofEntry.score}). Ierakstīts Hall of Fame!`
          );
          io.emit("seasonHofUpdate", { top: seasonStore.hallOfFame[0] || null });
        }

        broadcastSystemMessage(
          `📢 ${result.season.name} ir sākusies! (beigsies: ${endStr})${
            result.didReset ? " Coins + žetoni visiem ir resetoti." : ""
          }`
        );
      } else {
        broadcastSystemMessage(
          `📢 ${result.season.name} ir sākusies! (beigsies: ${endStr})`
        );
      }

      io.emit("seasonUpdate", result.season);

      adminSocket.emit("chatMessage", {
        username: "SYSTEM",
        text: `${result.season.name} ir aktīva.`,
        ts: Date.now(),
      });
      break;
    }

    case "seasononline": {
      const now = Date.now();
      const endTs = seasonState?.endAt || 0;
      let text;

      if (!seasonState?.active) {
        if (!endTs) {
          text = `${
            seasonState?.name || "SEZONA"
          } vēl nav sākusies. Beigu datums nav iestatīts.`;
        } else {
          const endStr = new Date(endTs).toLocaleString("lv-LV", {
            timeZone: TZ,
          });
          text = `${seasonState.name} nav aktīva. Plānotās beigas: ${endStr}.`;
        }
      } else if (!endTs) {
        text = `${seasonState.name} ir aktīva, bet beigu datums nav iestatīts.`;
      } else if (now >= endTs) {
        const endStr = new Date(endTs).toLocaleString("lv-LV", {
          timeZone: TZ,
        });
        text = `${seasonState.name} jau ir beigusies (beidzās ${endStr}).`;
      } else {
        const diffMs = endTs - now;
        const totalSec = Math.floor(diffMs / 1000);
        const days = Math.floor(totalSec / (24 * 3600));
        const hours = Math.floor((totalSec % (24 * 3600)) / 3600);
        const minsInt = Math.floor((totalSec % 3600) / 60);
        const secs = totalSec % 60;

        const endStr = new Date(endTs).toLocaleString("lv-LV", {
          timeZone: TZ,
        });

        text = `${seasonState.name} ir aktīva. Līdz sezonas beigām: ${days}d ${hours}h ${minsInt}m ${secs}s (līdz ${endStr}).`;
      }

      adminSocket.emit("chatMessage", {
        username: "SYSTEM",
        text,
        ts: Date.now(),
      });
      break;
    }

    case "hofset": {
      // /hofset <seasonId> <username> [score]
      const sid = parseInt(parts[1] || "", 10);
      const uname = String(parts[2] || "").trim();
      const scoreOverride = parts[3];

      if (!Number.isFinite(sid) || sid <= 0 || !uname) {
        adminSocket.emit("chatMessage", {
          username: "SYSTEM",
          text: "Lietošana: /hofset <seasonId> <username> [score]",
          ts: Date.now(),
        });
        return;
      }

      const r = upsertHallOfFameWinner(sid, uname, scoreOverride, null);
      if (!r.ok) {
        adminSocket.emit("chatMessage", {
          username: "SYSTEM",
          text: `HOF error: ${r.message}`,
          ts: Date.now(),
        });
        return;
      }

      io.emit("seasonHofUpdate", { top: seasonStore.hallOfFame[0] || null });

      adminSocket.emit("chatMessage", {
        username: "SYSTEM",
        text: `OK: Sezona ${sid} čempions = ${r.hofEntry.username} (score ${r.hofEntry.score}).`,
        ts: Date.now(),
      });
      break;
    }

    default:
      adminSocket.emit("chatMessage", {
        username: "SYSTEM",
        text:
          "Nezināma komanda. Pieejams: /kick, /ban, /unban, /mute <min>, /unmute, /seasonstart, /seasononline, /hofset <sid> <username> [score].",
        ts: Date.now(),
      });
  }
}

// ======== AUTH ENDPOINTI ========
async function signupHandler(req, res) {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res
      .status(400)
      .json({ message: "Nepieciešams username un password" });
  }

  const name = String(username).trim();
  if (!/^[a-zA-Z0-9_\-]{3,20}$/.test(name)) {
    return res.status(400).json({
      message: "Nickname: 3-20 simboli, tikai burti/cipari/ - _",
    });
  }
  if (USERS[name]) {
    return res.status(400).json({ message: "Šāds lietotājs jau eksistē" });
  }

  const hash = await bcrypt.hash(password, 10);
  const now = Date.now();

  const user = {
    username: name,
    passwordHash: hash,
    xp: 0,
    score: 0,
    coins: 0,
    tokens: 0,
    streak: 0,
    bestStreak: 0,
    currentRound: null,
    lastActionAt: now,
    lastPassiveTickAt: now,
    isBanned: false,
    mutedUntil: 0,
    missionsDate: "",
    missions: [],
    totalGuesses: 0,
    bestWinTimeMs: 0,
    winsToday: 0,
    winsTodayDate: "",
    dailyLoginDate: "",
    duelsWon: 0,
    duelsLost: 0,
    avatarUrl: null,
    supporter: false,
    dailyChest: { lastDate: "", streak: 0, totalOpens: 0 },
    specialMedals: [],
    lastChatAt: 0,
    lastChatText: "",
    lastChatTextAt: 0,
    lastGuessAt: 0,
    badLenCount: 0,
    badLenWindowStart: 0,
    guessBlockedUntil: 0,
  };

  ensureRankFields(user);
  ensureDailyMissions(user);
  ensureDailyChest(user);
  ensureSpecialMedals(user);

  USERS[name] = user;
  saveUsers(USERS);

  broadcastLeaderboard(false);

  const token = jwt.sign({ username: name }, JWT_SECRET, { expiresIn: "30d" });
  return res.json({ ...buildMePayload(user), token });
}

app.post("/signup", signupHandler);

async function loginHandler(req, res) {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res
      .status(400)
      .json({ message: "Nepieciešams username un password" });
  }

  const name = String(username).trim();
  const user = USERS[name];
  if (!user) return res.status(400).json({ message: "Lietotājs nav atrasts" });

  if (user.isBanned) {
    return res.status(403).json({
      message:
        "Šis lietotājs ir nobanots no VĀRDU ZONAS. Sazinies ar Bugats.",
    });
  }

  const ok = await bcrypt.compare(password, user.passwordHash || "");
  if (!ok) return res.status(400).json({ message: "Nepareiza parole" });

  markActivity(user);
  ensureDailyMissions(user);
  resetWinsTodayIfNeeded(user);
  ensureDailyChest(user);
  ensureSpecialMedals(user);
  ensureRankFields(user);

  if (typeof user.supporter !== "boolean") user.supporter = false;

  saveUsers(USERS);

  const token = jwt.sign({ username: name }, JWT_SECRET, { expiresIn: "30d" });
  return res.json({ ...buildMePayload(user), token });
}

app.post("/login", loginHandler);
app.post("/signin", loginHandler);

// ======== /me ========
app.get("/me", authMiddleware, (req, res) => {
  const u = req.user;
  markActivity(u);
  ensureDailyMissions(u);
  resetWinsTodayIfNeeded(u);
  ensureDailyChest(u);
  ensureSpecialMedals(u);
  ensureRankFields(u);
  if (typeof u.supporter !== "boolean") u.supporter = false;
  saveUsers(USERS);
  res.json(buildMePayload(u));
});

// ======== AVATĀRA ENDPOINTS ========
app.post("/avatar", authMiddleware, (req, res) => {
  try {
    const user = req.user;
    const { avatar } = req.body || {};

    markActivity(user);

    if (!avatar || typeof avatar !== "string") {
      return res.status(400).json({ message: "Nav avatāra dati." });
    }
    if (!avatar.startsWith("data:image/")) {
      return res.status(400).json({ message: "Nekorekts avatāra formāts." });
    }

    if (avatar.length > AVATAR_MAX_CHARS) {
      return res.status(400).json({
        message: `Avatārs ir par lielu. Max: ~${Math.round(
          AVATAR_MAX_CHARS / (1024 * 1024)
        )}MB base64. Ieteikums: samazini bildi (piem. 512x512) un saglabā WEBP/JPG.`,
      });
    }

    user.avatarUrl = avatar;
    saveUsers(USERS);

    broadcastOnlineList(true);
    broadcastLeaderboard(false);

    return res.json({ ok: true, avatarUrl: user.avatarUrl });
  } catch (err) {
    console.error("POST /avatar kļūda:", err);
    return res
      .status(500)
      .json({ message: "Servera kļūda avatāra saglabāšanā." });
  }
});

// ======== Publiska profila API ========
function buildPublicProfilePayload(targetUser, requester) {
  const rankInfo = ensureRankFields(targetUser);
  const isAdmin = requester && isAdminUser(requester);

  const dynamicMedals = computeMedalsForUser(targetUser);
  const medals = mergeMedals(dynamicMedals, targetUser.specialMedals);

  const payload = {
    username: targetUser.username,
    xp: targetUser.xp || 0,
    score: targetUser.score || 0,
    coins: targetUser.coins || 0,
    tokens: targetUser.tokens || 0,
    streak: targetUser.streak || 0,
    bestStreak: targetUser.bestStreak || 0,
    rankTitle: targetUser.rankTitle || rankInfo.title,
    rankLevel: targetUser.rankLevel || rankInfo.level,
    medals,
    duelsWon: targetUser.duelsWon || 0,
    duelsLost: targetUser.duelsLost || 0,
    avatarUrl: targetUser.avatarUrl || null,
    supporter: !!targetUser.supporter,
  };

  if (isAdmin) {
    payload.isBanned = !!targetUser.isBanned;
    payload.mutedUntil = targetUser.mutedUntil || 0;
  }
  return payload;
}

app.get("/player/:username", authMiddleware, (req, res) => {
  const requester = req.user;
  const name = String(req.params.username || "").trim();
  const key = findUserKeyCaseInsensitive(name);
  const user = key ? USERS[key] : null;
  if (!user) return res.status(404).json({ message: "Lietotājs nav atrasts" });
  res.json(buildPublicProfilePayload(user, requester));
});
app.get("/profile/:username", authMiddleware, (req, res) => {
  const requester = req.user;
  const name = String(req.params.username || "").trim();
  const key = findUserKeyCaseInsensitive(name);
  const user = key ? USERS[key] : null;
  if (!user) return res.status(404).json({ message: "Lietotājs nav atrasts" });
  res.json(buildPublicProfilePayload(user, requester));
});

// ======== MISIJU ENDPOINTI ========
app.get("/missions", authMiddleware, (req, res) => {
  const user = req.user;
  markActivity(user);
  ensureDailyMissions(user);
  resetWinsTodayIfNeeded(user);
  ensureDailyChest(user);
  ensureSpecialMedals(user);
  ensureRankFields(user);
  saveUsers(USERS);
  res.json(getPublicMissions(user));
});

app.post("/missions/claim", authMiddleware, (req, res) => {
  const user = req.user;
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ message: "Nav norādīts misijas ID" });

  markActivity(user);
  ensureDailyMissions(user);
  ensureDailyChest(user);
  ensureSpecialMedals(user);

  const mission = (user.missions || []).find((m) => m.id === id);
  if (!mission) return res.status(404).json({ message: "Misija nav atrasta" });
  if (!mission.isCompleted)
    return res.status(400).json({ message: "Misija vēl nav pabeigta" });
  if (mission.isClaimed)
    return res.status(400).json({ message: "Balva jau saņemta" });

  const rw = mission.rewards || {};
  const addXp = rw.xp || 0;
  const addCoins = rw.coins || 0;
  const addTokens = rw.tokens || 0;

  user.xp = (user.xp || 0) + addXp;
  user.coins = (user.coins || 0) + addCoins;
  user.tokens = (user.tokens || 0) + addTokens;

  mission.isClaimed = true;
  ensureRankFields(user);

  saveUsers(USERS);
  broadcastLeaderboard(false);

  if (addTokens > 0) {
    wheelSyncTokenSlots(true);
    wheelEmitUpdate(true);
  }

  res.json({ me: buildMePayload(user), missions: getPublicMissions(user) });
});

// ======== DAILY CHEST ENDPOINTI ========
app.get("/chest/status", authMiddleware, (req, res) => {
  const user = req.user;
  markActivity(user);
  ensureDailyChest(user);
  saveUsers(USERS);

  const today = todayKey();
  const available = user.dailyChest.lastDate !== today;

  res.json({
    available,
    today,
    lastDate: user.dailyChest.lastDate || null,
    streak: user.dailyChest.streak || 0,
    nextAt: nextMidnightRigaTs(),
  });
});

app.post("/chest/open", authMiddleware, (req, res) => {
  const user = req.user;
  markActivity(user);
  ensureDailyChest(user);

  const today = todayKey();
  const available = user.dailyChest.lastDate !== today;

  if (!available) {
    return res.status(409).json({
      message: "Daily Chest jau ir atvērts šodien. Nāc rīt!",
      nextAt: nextMidnightRigaTs(),
    });
  }

  const yesterdayKey = todayKey(new Date(Date.now() - 24 * 3600 * 1000));
  if (user.dailyChest.lastDate === yesterdayKey) user.dailyChest.streak += 1;
  else user.dailyChest.streak = 1;

  user.dailyChest.lastDate = today;
  user.dailyChest.totalOpens = (user.dailyChest.totalOpens || 0) + 1;

  const streak = user.dailyChest.streak;

  const coinsBase = 40 + crypto.randomInt(0, 81); // 40..120
  const xpBase = 10 + crypto.randomInt(0, 21); // 10..30

  const streakBonusCoins = Math.min(90, (streak - 1) * 12);
  const streakBonusXp = Math.min(35, (streak - 1) * 4);

  const coinsGain = coinsBase + streakBonusCoins;
  const xpGain = xpBase + streakBonusXp;

  const tokenChance = Math.min(0.25, 0.06 + streak * 0.01);
  const tokensGain = Math.random() < tokenChance ? 1 : 0;

  user.coins = (user.coins || 0) + coinsGain;
  user.xp = (user.xp || 0) + xpGain;
  user.tokens = (user.tokens || 0) + tokensGain;

  ensureRankFields(user);
  saveUsers(USERS);
  broadcastLeaderboard(false);

  if (tokensGain > 0) {
    wheelSyncTokenSlots(true);
    wheelEmitUpdate(true);
  }

  io.emit("chatMessage", {
    username: "SYSTEM",
    text: `🎁 ${user.username} atvēra Daily Chest: +${coinsGain} coins, +${xpGain} XP${
      tokensGain ? `, +${tokensGain} žetons` : ""
    } (streak ${user.dailyChest.streak})`,
    ts: Date.now(),
  });

  return res.json({
    ok: true,
    rewards: { coins: coinsGain, xp: xpGain, tokens: tokensGain },
    streak: user.dailyChest.streak,
    nextAt: nextMidnightRigaTs(),
    me: buildMePayload(user),
  });
});

// ======== SEZONA API ========
app.get("/season", authMiddleware, (_req, res) => {
  res.json({ ...seasonState, hallOfFameTop: seasonStore.hallOfFame[0] || null });
});
app.get("/season/state", (_req, res) => {
  res.json({ ...seasonState, hallOfFameTop: seasonStore.hallOfFame[0] || null });
});
app.get("/season/hof", authMiddleware, (_req, res) => {
  res.json(seasonStore.hallOfFame || []);
});
app.post("/season/hof/override", authMiddleware, (req, res) => {
  const admin = req.user;
  if (!isAdminUser(admin)) {
    return res.status(403).json({ message: "Tikai admins." });
  }

  const { seasonId, username, score, finishedAt } = req.body || {};
  const r = upsertHallOfFameWinner(seasonId, username, score, finishedAt);

  if (!r.ok) return res.status(400).json({ message: r.message });

  io.emit("seasonHofUpdate", { top: seasonStore.hallOfFame[0] || null });

  broadcastSystemMessage(
    `🏆 Hall of Fame labots: Sezona ${r.hofEntry.seasonId} čempions = ${r.hofEntry.username} (score ${r.hofEntry.score}).`
  );

  return res.json({
    ok: true,
    top: seasonStore.hallOfFame[0] || null,
    entry: r.hofEntry,
    hallOfFame: seasonStore.hallOfFame || [],
  });
});
app.post("/season/start", authMiddleware, (req, res) => {
  const user = req.user;
  if (!isAdminUser(user)) {
    return res.status(403).json({ message: "Tikai admins var startēt sezonu." });
  }

  const result = startSeasonFlow({ byAdminUsername: user.username });

  io.emit("seasonUpdate", result.season);
  if (result.mode === "rolled_next" && result.hofEntry) {
    io.emit("seasonHofUpdate", { top: seasonStore.hallOfFame[0] || null });
  }

  res.json({
    ...result.season,
    mode: result.mode,
    hofEntry: result.hofEntry || null,
    didReset: !!result.didReset,
  });
});

// ======== Spēles loģika ========
function pickRandomWord() {
  if (!WORDS.length) return { word: "BUGAT", len: 5 };
  const idx = crypto.randomInt(0, WORDS.length);
  const w = WORDS[idx] || "BUGAT";
  return { word: String(w).toUpperCase(), len: String(w).length };
}

function startNewRoundForUser(user) {
  const { word, len } = pickRandomWord();
  user.currentRound = {
    word,
    len,
    attemptsLeft: MAX_ATTEMPTS,
    finished: false,
    startedAt: Date.now(),

    // Ability: reveal 1 letter
    revealUsed: false,
    reveal: null,
  };
  return user.currentRound;
}

// ======== START ROUND ========
app.get("/start-round", authMiddleware, (req, res) => {
  const user = req.user;
  markActivity(user);
  ensureDailyMissions(user);
  ensureDailyChest(user);

  // ja ir aktīvs raunds — atgriežam to, plus reveal info
  if (user.currentRound && !user.currentRound.finished) {
    // migrācija drošībai
    if (typeof user.currentRound.revealUsed !== "boolean")
      user.currentRound.revealUsed = false;
    if (!user.currentRound.reveal || typeof user.currentRound.reveal !== "object")
      user.currentRound.reveal = null;

    saveUsers(USERS);

    const revealUsed = !!user.currentRound.revealUsed;
    const reveal =
      revealUsed && user.currentRound.reveal
        ? {
            pos: user.currentRound.reveal.pos,
            letter: user.currentRound.reveal.letter,
          }
        : null;

    return res.json({
      len: user.currentRound.len,
      revealUsed,
      reveal,
    });
  }

  // citādi sākam jaunu
  const round = startNewRoundForUser(user);
  saveUsers(USERS);
  return res.json({ len: round.len, revealUsed: false, reveal: null });
});

// ======== Ability: Atvērt 1 burtu (1x katrā raundā) ========
// POST /ability/reveal-letter
// Body: { avoid?: number[] }  // pozīcijas, ko klients grib izvairīties (piem. jau aizpildītās ailes)
app.post("/ability/reveal-letter", authMiddleware, (req, res) => {
  const user = req.user;
  markActivity(user);

  // ja nav raunda vai ir beidzies — sākam jaunu
  if (!user.currentRound || user.currentRound.finished) {
    startNewRoundForUser(user);
  }
  const round = user.currentRound;

  if (!round || round.finished || round.attemptsLeft <= 0) {
    saveUsers(USERS);
    return res
      .status(400)
      .json({ message: "Raunds ir beidzies.", code: "ROUND_FINISHED" });
  }

  if (round.revealUsed) {
    return res.status(400).json({
      message: "Šajā raundā burts jau tika atvērts.",
      code: "ALREADY_USED",
    });
  }

  const cost = REVEAL_LETTER_COST_COINS;
  if (!Number.isFinite(cost) || cost <= 0) {
    return res.status(500).json({
      message: "Servera konfigurācijas kļūda (REVEAL_LETTER_COST_COINS).",
      code: "CONFIG_ERROR",
    });
  }

  if ((user.coins || 0) < cost) {
    return res.status(400).json({
      message: "Nepietiek coins šai spējai.",
      code: "INSUFFICIENT_COINS",
      need: cost,
      have: user.coins || 0,
    });
  }

  const avoidRaw = req.body && Array.isArray(req.body.avoid) ? req.body.avoid : [];
  const avoid = new Set(
    avoidRaw
      .map((x) => Number(x))
      .filter((n) => Number.isInteger(n) && n >= 0 && n < round.len)
  );

  const allPos = [];
  for (let i = 0; i < round.len; i++) allPos.push(i);

  let pool = allPos.filter((i) => !avoid.has(i));
  if (!pool.length) pool = allPos;

  const pos = pool[crypto.randomInt(0, pool.length)];
  const letter = String(round.word[pos] || "").toUpperCase();

  user.coins = (user.coins || 0) - cost;

  round.revealUsed = true;
  round.reveal = { pos, letter, cost, ts: Date.now() };

  saveUsers(USERS);

  return res.json({
    ok: true,
    len: round.len,
    pos,
    letter,
    cost,
    coins: user.coins || 0,
    tokens: user.tokens || 0,
  });
});

// ======== Guess / pattern ========
function buildPattern(secret, guess) {
  const sArr = secret.split("");
  const gArr = guess.split("");
  const result = new Array(gArr.length).fill("absent");

  const counts = {};
  for (const ch of sArr) counts[ch] = (counts[ch] || 0) + 1;

  for (let i = 0; i < gArr.length; i++) {
    if (gArr[i] === sArr[i]) {
      result[i] = "correct";
      counts[gArr[i]] -= 1;
    }
  }
  for (let i = 0; i < gArr.length; i++) {
    if (result[i] === "correct") continue;
    const ch = gArr[i];
    if (counts[ch] > 0) {
      result[i] = "present";
      counts[ch] -= 1;
    }
  }
  return result;
}

function enforceGuessRate(user) {
  const now = Date.now();

  if (user.guessBlockedUntil && now < user.guessBlockedUntil) {
    return {
      ok: false,
      status: 429,
      message: "Tu min pārāk haotiski. Pamēģini pēc dažām sekundēm.",
    };
  }

  if (user.lastGuessAt && now - user.lastGuessAt < GUESS_RATE_MS) {
    return {
      ok: false,
      status: 429,
      message: "Pārāk ātri. Mēģini vēlreiz pēc ~1s.",
    };
  }

  user.lastGuessAt = now;
  return { ok: true };
}

function trackBadLength(user) {
  const now = Date.now();
  if (
    !user.badLenWindowStart ||
    now - user.badLenWindowStart > BAD_LEN_WINDOW_MS
  ) {
    user.badLenWindowStart = now;
    user.badLenCount = 0;
  }
  user.badLenCount = (user.badLenCount || 0) + 1;
  if (user.badLenCount >= BAD_LEN_MAX) {
    user.guessBlockedUntil = now + BAD_LEN_BLOCK_MS;
    return true;
  }
  return false;
}

app.post("/guess", authMiddleware, (req, res) => {
  const user = req.user;
  markActivity(user);
  ensureDailyMissions(user);
  ensureDailyChest(user);

  const gate = enforceGuessRate(user);
  if (!gate.ok) {
    saveUsers(USERS);
    return res.status(gate.status).json({ message: gate.message });
  }

  const guessRaw = (req.body?.guess || "").toString().trim().toUpperCase();
  if (!user.currentRound || user.currentRound.finished) {
    saveUsers(USERS);
    return res.status(400).json({ message: "Nav aktīva raunda" });
  }

  const round = user.currentRound;

  if (guessRaw.length !== round.len) {
    const blocked = trackBadLength(user);
    saveUsers(USERS);
    return res.status(400).json({
      message: blocked
        ? `Vārdam jābūt ${round.len} burtiem. Tu pārāk bieži kļūdījies — īss locks.`
        : `Vārdam jābūt ${round.len} burtiem`,
    });
  }

  if (!GUESS_ALLOWED_RE.test(guessRaw)) {
    saveUsers(USERS);
    return res.status(400).json({
      message: "Minējumā drīkst būt tikai burti (A-Z + latviešu burti).",
    });
  }

  if (round.attemptsLeft <= 0) {
    round.finished = true;
    saveUsers(USERS);
    return res.json({
      pattern: buildPattern(round.word, guessRaw),
      win: false,
      finished: true,
      attemptsLeft: 0,
    });
  }

  user.totalGuesses = (user.totalGuesses || 0) + 1;

  const pattern = buildPattern(round.word, guessRaw);
  round.attemptsLeft -= 1;

  const len = round.len;
  const isWin = guessRaw === round.word;
  const finished = isWin || round.attemptsLeft <= 0;

  let xpGain = 0;
  let coinsGain = 0;

  if (isWin) {
    const prevStreak = user.streak || 0;
    user.streak = prevStreak + 1;

    resetWinsTodayIfNeeded(user);
    user.winsToday = (user.winsToday || 0) + 1;

    if (round.startedAt) {
      const winTime = Date.now() - round.startedAt;
      if (!user.bestWinTimeMs || winTime < user.bestWinTimeMs) {
        user.bestWinTimeMs = winTime;
      }
    }

    xpGain = XP_PER_WIN_BASE;
    const extraLetters = Math.max(0, len - MIN_WORD_LEN);
    xpGain += XP_PER_LETTER_BONUS * extraLetters;

    const streakSteps = Math.min(user.streak - 1, XP_STREAK_MAX_STEPS);
    if (streakSteps > 0) xpGain += XP_PER_STREAK_STEP * streakSteps;

    coinsGain = COINS_PER_WIN_BASE;
    coinsGain += COINS_PER_LETTER_BONUS * extraLetters;

    const coinStreakBonus = Math.min(user.streak - 1, COINS_STREAK_MAX_BONUS);
    if (coinStreakBonus > 0) coinsGain += coinStreakBonus;

    user.xp = (user.xp || 0) + xpGain;
    user.score = (user.score || 0) + SCORE_PER_WIN;
    user.coins = (user.coins || 0) + coinsGain;

    user.bestStreak = Math.max(user.bestStreak || 0, user.streak || 0);

    ensureRankFields(user);

    io.emit("playerWin", {
      username: user.username,
      xpGain,
      coinsGain,
      rankTitle: user.rankTitle,
      rankLevel: user.rankLevel,
      avatarUrl: user.avatarUrl || null,
      streak: user.streak || 0,
    });
  } else {
    if (finished) user.streak = 0;
  }

  round.finished = finished;

  updateMissionsOnGuess(user, { isWin, xpGain });

  saveUsers(USERS);

  if (isWin) broadcastLeaderboard(false);

  res.json({
    pattern,
    win: isWin,
    finished,
    attemptsLeft: round.attemptsLeft,
    rewards: isWin ? { xpGain, coinsGain } : null,
  });
});

// ======== Token buy ========
app.post("/buy-token", authMiddleware, (req, res) => {
  const user = req.user;
  markActivity(user);
  ensureDailyMissions(user);
  ensureDailyChest(user);

  const price = getTokenPrice(user);
  if ((user.coins || 0) < price) {
    saveUsers(USERS);
    return res.status(400).json({ message: "Nepietiek coins" });
  }

  user.coins = (user.coins || 0) - price;
  user.tokens = (user.tokens || 0) + 1;

  saveUsers(USERS);
  broadcastLeaderboard(false);

  wheelSyncTokenSlots(true);
  wheelEmitUpdate(true);

  io.emit("tokenBuy", { username: user.username, tokens: user.tokens || 0 });

  res.json({
    coins: user.coins,
    tokens: user.tokens,
    tokenPriceCoins: getTokenPrice(user),
  });
});

// ===== Leaderboard =====
app.get("/leaderboard", (_req, res) => {
  res.json(computeTop10Leaderboard());
});

// ===== DUEĻU HELPERI (Socket.IO pusē) =====
function getSocketByUsername(username) {
  for (const [sid, uname] of onlineBySocket.entries()) {
    if (uname === username) {
      const s = io.sockets.sockets.get(sid);
      if (s) return s;
    }
  }
  return null;
}

function finishDuel(duel, winnerName, reason) {
  if (!duel || duel.status === "finished") return;

  duel.status = "finished";
  duel.finishedReason = reason || "finished";
  duel.winner = winnerName || null;

  const [p1, p2] = duel.players;
  const s1 = getSocketByUsername(p1);
  const s2 = getSocketByUsername(p2);

  const u1 = USERS[p1];
  const u2 = USERS[p2];

  if (winnerName && u1 && u2) {
    const winner = USERS[winnerName];
    const loser = winnerName === p1 ? u2 : u1;

    if (winner) {
      winner.duelsWon = (winner.duelsWon || 0) + 1;
      winner.xp = (winner.xp || 0) + DUEL_REWARD_XP;
      winner.coins = (winner.coins || 0) + DUEL_REWARD_COINS;
      ensureRankFields(winner);
    }
    if (loser) {
      loser.duelsLost = (loser.duelsLost || 0) + 1;
    }

    saveUsers(USERS);
    broadcastLeaderboard(false);

    if (s1)
      s1.emit("duel.end", {
        duelId: duel.id,
        winner: winnerName,
        youWin: winnerName === p1,
        reason,
      });
    if (s2)
      s2.emit("duel.end", {
        duelId: duel.id,
        winner: winnerName,
        youWin: winnerName === p2,
        reason,
      });

    const other = winnerName === p1 ? p2 : p1;
    broadcastSystemMessage(`⚔️ ${winnerName} uzvarēja dueli pret ${other}!`);
  } else {
    if (s1)
      s1.emit("duel.end", {
        duelId: duel.id,
        winner: null,
        youWin: false,
        reason,
      });
    if (s2)
      s2.emit("duel.end", {
        duelId: duel.id,
        winner: null,
        youWin: false,
        reason,
      });
  }

  userToDuel.delete(p1);
  userToDuel.delete(p2);
  duels.delete(duel.id);
}

// Duēļu timeout watchdog
setInterval(() => {
  const now = Date.now();
  for (const duel of duels.values()) {
    if (duel.status === "active" && duel.expiresAt && now >= duel.expiresAt) {
      finishDuel(duel, null, "timeout");
    }
  }
}, 1000);

// ===== DIENAS LOGIN BONUSS =====
const DAILY_LOGIN_COINS = 10;
function grantDailyLoginBonus(user) {
  if (!user) return 0;
  const today = todayKey();
  if (user.dailyLoginDate === today) return 0;
  user.dailyLoginDate = today;
  user.coins = (user.coins || 0) + DAILY_LOGIN_COINS;
  saveUsers(USERS);
  return DAILY_LOGIN_COINS;
}

// ===== SEZONAS AUTO-BEIGAS + AUTO-HOF =====
let seasonEndedBroadcasted = false;
setInterval(() => {
  const now = Date.now();
  if (!(seasonState?.endAt && now >= seasonState.endAt)) return;

  if (seasonState.active) {
    seasonState.active = false;
    seasonStore.current = seasonState;
    saveJsonAtomic(SEASONS_FILE, seasonStore);
    io.emit("seasonUpdate", seasonState);
    seasonEndedBroadcasted = false;
  }

  const hofEntry = finalizeSeasonIfNeeded(seasonState.id);
  if (hofEntry) {
    io.emit("seasonHofUpdate", { top: seasonStore.hallOfFame[0] || null });
    broadcastSystemMessage(
      `🏆 ${seasonState.name} čempions: ${hofEntry.username} (score ${hofEntry.score}). Ierakstīts Hall of Fame!`
    );
  }

  if (!seasonEndedBroadcasted) {
    const endStr = new Date(seasonState.endAt).toLocaleString("lv-LV", {
      timeZone: TZ,
    });
    broadcastSystemMessage(`⏳ ${seasonState.name} ir beigusies (${endStr}).`);
    io.emit("seasonUpdate", seasonState);
    seasonEndedBroadcasted = true;
  }
}, 1500);

// ======== Socket.IO auth middleware ========
function extractSocketToken(socket) {
  const fromAuth = socket?.handshake?.auth?.token;
  const fromQuery = socket?.handshake?.query?.token;

  const hdr = socket?.handshake?.headers?.authorization;
  const fromHeader =
    typeof hdr === "string" ? hdr.replace(/^Bearer\s+/i, "").trim() : "";

  const t = fromAuth || fromQuery || fromHeader;
  return t ? String(t).trim() : "";
}

io.use((socket, next) => {
  const nsp = socket.nsp?.name || "/";
  const token = extractSocketToken(socket);

  // /wheel: atļaujam arī bez token (read-only)
  if (nsp === "/wheel") {
    if (!token) return next();
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = USERS[payload.username];
      if (user && !user.isBanned) socket.data.user = user;
      return next();
    } catch {
      return next();
    }
  }

  if (!token) return next(new Error("Nav token"));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = USERS[payload.username];
    if (!user) return next(new Error("Lietotājs nav atrasts"));
    if (user.isBanned) return next(new Error("Lietotājs ir nobanots"));

// ======== MODULAR: exports for other modules ========
export {
  DAILY_LOGIN_COINS, broadcastLeaderboard, broadcastSystemMessage, buildPattern, buildPublicProfilePayload, computeTop10Leaderboard,
  enforceGuessRate, extractSocketToken, finishDuel, getSocketByUsername, grantDailyLoginBonus, handleAdminCommand,
  kickUserByName, lastLbSig, pickRandomWord, seasonEndedBroadcasted, startNewRoundForUser, trackBadLength
};
