import * as base from "./base.js";
import * as routes from "./routes.js";

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
  wheelIsSpinningNow, wheelRemoveAllByName, wheelRemoveOneByIndex, wheelRequireAdmin, wheelShuffle, wheelStartSpin,
  wheelStore, wheelSyncTokenSlots, wheelTokenMeta, wheelTokenSig, wheelTokenSlots, setWheelNsp
} = base;
const {
  DAILY_LOGIN_COINS, broadcastLeaderboard, broadcastSystemMessage, buildPattern, buildPublicProfilePayload, computeTop10Leaderboard,
  enforceGuessRate, extractSocketToken, finishDuel, getSocketByUsername, grantDailyLoginBonus, handleAdminCommand,
  kickUserByName, lastLbSig, pickRandomWord, seasonEndedBroadcasted, startNewRoundForUser, trackBadLength
} = routes;

let wheelNsp = base.wheelNsp;

    socket.data.user = user;
    return next();
  } catch {
    return next(new Error("Nederīgs token"));
  }
});

// ======== WHEEL namespace (/wheel) ========
wheelNsp = io.of("/wheel");
setWheelNsp(wheelNsp);
wheelNsp.use((socket, next) => {
  const token = extractSocketToken(socket);
  if (!token) return next();
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = USERS[payload.username];
    if (user && !user.isBanned) socket.data.user = user;
  } catch {}
  return next();
});

// initial token sync
wheelSyncTokenSlots(true);

wheelNsp.on("connection", (socket) => {
  const getMe = () => {
    const u = socket.data.user || null;
    return {
      username: u?.username || null,
      isAdmin: u ? isAdminUser(u) : false,
    };
  };

  socket.emit("wheel:me", getMe());
  socket.emit("wheel:update", publicWheelState());
  socket.emit("update", publicWheelState());

  const bind = (action, fn) => {
    socket.on(`wheel:${action}`, fn);
    socket.on(action, fn);
  };

  bind("auth", (payload = {}) => {
    const t = String(payload?.token || "").trim();
    if (!t) return wheelEmitError(socket, "Nav token.");
    try {
      const p = jwt.verify(t, JWT_SECRET);
      const user = USERS[p?.username];
      if (user && !user.isBanned) {
        socket.data.user = user;
      } else {
        socket.data.user = null;
      }
      socket.emit("wheel:me", getMe());
      socket.emit("wheel:update", publicWheelState());
      socket.emit("update", publicWheelState());
    } catch {
      wheelEmitError(socket, "Nederīgs token.");
    }
  });

  bind("join", () => {
    socket.emit("wheel:update", publicWheelState());
    socket.emit("update", publicWheelState());
  });

  bind("syncTokens", () => {
    const admin = wheelRequireAdmin(socket);
    if (!admin) return;
    if (wheelBlockIfSpinning(socket)) return;
    wheelSyncTokenSlots(true);
    wheelEmitUpdate(true);
  });

  function applyTokenChange(payload = {}, mode = "auto") {
    const admin = wheelRequireAdmin(socket);
    if (!admin) return;
    if (wheelBlockIfSpinning(socket)) return;

    const username = String(
      payload.username ?? payload.user ?? payload.name ?? payload.nick ?? ""
    )
      .trim()
      .slice(0, 30);

    if (!username) return wheelEmitError(socket, "Nav username.");

    const key = findUserKeyCaseInsensitive(username);
    const target = key ? USERS[key] : null;
    if (!target) return wheelEmitError(socket, "Lietotājs nav atrasts.");

    let nextTokens = Math.max(0, Math.floor(target.tokens || 0));

    if (mode === "set") {
      const v = parseInt(payload.set ?? payload.value ?? payload.tokens, 10);
      if (!Number.isFinite(v) || v < 0) return wheelEmitError(socket, "Nederīgs set.");
      nextTokens = v;
    } else if (mode === "delta") {
      const d = parseInt(payload.delta ?? payload.d ?? payload.change, 10);
      if (!Number.isFinite(d) || d === 0) return wheelEmitError(socket, "Nederīgs delta.");
      nextTokens = Math.max(0, nextTokens + d);
    } else {
      const hasSet =
        payload.set !== undefined && payload.set !== null && payload.set !== "";
      const hasDelta =
        payload.delta !== undefined && payload.delta !== null && payload.delta !== "";
      if (!hasSet && !hasDelta) return wheelEmitError(socket, "Norādi set vai delta.");

      if (hasSet) {
        const v = parseInt(payload.set, 10);
        if (!Number.isFinite(v) || v < 0) return wheelEmitError(socket, "Nederīgs set.");
        nextTokens = v;
      } else {
        const d = parseInt(payload.delta, 10);
        if (!Number.isFinite(d) || d === 0) return wheelEmitError(socket, "Nederīgs delta.");
        nextTokens = Math.max(0, nextTokens + d);
      }
    }

    target.tokens = nextTokens;
    saveUsers(USERS);

    wheelSyncTokenSlots(true);
    wheelEmitUpdate(true);

    socket.emit("wheel:tokensUpdated", {
      username: target.username,
      tokens: nextTokens,
    });
  }

  bind("adjustTokens", (payload = {}) => applyTokenChange(payload, "auto"));
  bind("tokenAdjust", (payload = {}) => applyTokenChange(payload, "delta"));
  bind("tokenSet", (payload = {}) => applyTokenChange(payload, "set"));

  bind("add", (payload = {}) => {
    const admin = wheelRequireAdmin(socket);
    if (!admin) return;
    if (wheelBlockIfSpinning(socket)) return;

    const name =
      payload.name ?? payload.username ?? payload.nick ?? payload.player ?? "";
    const count =
      payload.count ?? payload.tickets ?? payload.qty ?? payload.amount ?? 1;

    const r = wheelAdd(name, count);
    if (!r.ok) return wheelEmitError(socket, r.message);
    wheelEmitUpdate(true);
  });

  bind("remove", (payload = {}) => {
    const admin = wheelRequireAdmin(socket);
    if (!admin) return;
    if (wheelBlockIfSpinning(socket)) return;

    if (payload && (payload.index || payload.index === 0)) {
      const r = wheelRemoveOneByIndex(payload.index);
      if (!r.ok) return wheelEmitError(socket, r.message);
      wheelEmitUpdate(true);
      return;
    }

    const name = payload.name ?? payload.username ?? payload.nick ?? "";
    const r = wheelRemoveAllByName(name);
    if (!r.ok) return wheelEmitError(socket, r.message);
    wheelEmitUpdate(true);
  });

  bind("settings", (payload = {}) => {
    const admin = wheelRequireAdmin(socket);
    if (!admin) return;
    if (wheelBlockIfSpinning(socket)) return;

    wheelApplySettings({
      spinMs: payload.spinMs ?? payload.spin_ms ?? payload.ms ?? payload.durationMs,
      removeOnWin:
        typeof payload.removeOnWin === "boolean"
          ? payload.removeOnWin
          : typeof payload.remove_on_win === "boolean"
          ? payload.remove_on_win
          : undefined,
    });

    wheelEmitUpdate(true);
  });

  bind("shuffle", () => {
    const admin = wheelRequireAdmin(socket);
    if (!admin) return;
    if (wheelBlockIfSpinning(socket)) return;

    wheelShuffle();
    wheelEmitUpdate(true);
  });

  bind("spin", () => {
    const admin = wheelRequireAdmin(socket);
    if (!admin) return;

    const r = wheelStartSpin(admin.username, io);
    if (!r.ok) return wheelEmitError(socket, r.message);
  });
});

// ======== Socket.IO pamat-connection (spēle) ========
io.on("connection", (socket) => {
  const user = socket.data.user;
  if (!user) {
    socket.disconnect();
    return;
  }

  const passiveChanged = markActivity(user);
  ensureDailyMissions(user);
  ensureDailyChest(user);
  ensureSpecialMedals(user);
  ensureRankFields(user);
  if (typeof user.supporter !== "boolean") user.supporter = false;

  const bonus = grantDailyLoginBonus(user);
  if (bonus > 0) {
    socket.emit("chatMessage", {
      username: "SYSTEM",
      text: `Dienas ienākšanas bonuss: +${bonus} coins!`,
      ts: Date.now(),
    });
  }

  if (passiveChanged) saveUsers(USERS);

  onlineBySocket.set(socket.id, user.username);
  broadcastOnlineList(true);
  broadcastLeaderboard(false);

  socket.emit("seasonUpdate", seasonState);
  socket.emit("seasonHofUpdate", { top: seasonStore.hallOfFame[0] || null });

  socket.on("leaderboard:top10", () => {
    socket.emit("leaderboard:update", computeTop10Leaderboard());
  });

  // ========== ČATS ==========
  socket.on("chatMessage", (text) => {
    if (typeof text !== "string") return;
    let msg = text.trim();
    if (!msg) return;
    if (msg.length > CHAT_MAX_LEN) msg = msg.slice(0, CHAT_MAX_LEN);

    const u = USERS[user.username] || user;

    const passiveChanged2 = markActivity(u);
    ensureRankFields(u);

    const now = Date.now();

    if (u.isBanned) {
      socket.emit("chatMessage", {
        username: "SYSTEM",
        text: "Tu esi nobanots no VĀRDU ZONAS.",
        ts: Date.now(),
      });
      if (passiveChanged2) saveUsers(USERS);
      return;
    }

    if (u.mutedUntil && u.mutedUntil > now) {
      const until = new Date(u.mutedUntil).toLocaleTimeString("lv-LV", {
        hour: "2-digit",
        minute: "2-digit",
      });
      socket.emit("chatMessage", {
        username: "SYSTEM",
        text: `Tev ir mute līdz ${until}.`,
        ts: Date.now(),
      });
      if (passiveChanged2) saveUsers(USERS);
      return;
    }

    if (u.lastChatAt && now - u.lastChatAt < CHAT_RATE_MS) {
      if (passiveChanged2) saveUsers(USERS);
      return;
    }
    u.lastChatAt = now;

    if (
      u.lastChatText &&
      u.lastChatText === msg &&
      u.lastChatTextAt &&
      now - u.lastChatTextAt < CHAT_DUP_WINDOW_MS
    ) {
      if (passiveChanged2) saveUsers(USERS);
      return;
    }
    u.lastChatText = msg;
    u.lastChatTextAt = now;

    const isAdmin = isAdminUser(u);
    if (isAdmin && (msg.startsWith("/") || msg.startsWith("!"))) {
      handleAdminCommand(msg, u, socket);
      if (passiveChanged2) saveUsers(USERS);
      return;
    }

    if (passiveChanged2) saveUsers(USERS);

    io.emit("chatMessage", {
      username: u.username,
      text: msg,
      ts: Date.now(),
      avatarUrl: u.avatarUrl || null,
      rankTitle: u.rankTitle || "—",
      rankLevel: u.rankLevel || 1,
      supporter: !!u.supporter,
    });
  });

  // ========== DUEĻI ==========
  socket.on("duel.challenge", (targetNameRaw) => {
    const challenger = socket.data.user;
    const challengerName = challenger.username;
    const targetName = String(targetNameRaw || "").trim();

    if (!targetName)
      return socket.emit("duel.error", { message: "Nav norādīts pretinieks." });
    if (targetName === challengerName)
      return socket.emit("duel.error", { message: "Nevari izaicināt sevi." });

    const key = findUserKeyCaseInsensitive(targetName);
    const targetUser = key ? USERS[key] : null;
    if (!targetUser)
      return socket.emit("duel.error", { message: "Lietotājs nav atrasts." });

    if (userToDuel.has(challengerName))
      return socket.emit("duel.error", { message: "Tu jau esi citā duelī." });
    if (userToDuel.has(targetUser.username))
      return socket.emit("duel.error", {
        message: "Pretinieks jau ir citā duelī.",
      });

    const targetSocket = getSocketByUsername(targetUser.username);
    if (!targetSocket)
      return socket.emit("duel.error", {
        message: "Pretinieks nav tiešsaistē.",
      });

    const { word, len } = pickRandomWord();
    const duelId = crypto.randomBytes(8).toString("hex");

    const duel = {
      id: duelId,
      players: [challengerName, targetUser.username],
      word,
      len,
      status: "pending",
      createdAt: Date.now(),
      startedAt: null,
      expiresAt: null,
      attemptsLeft: {
        [challengerName]: DUEL_MAX_ATTEMPTS,
        [targetUser.username]: DUEL_MAX_ATTEMPTS,
      },
      rowsUsed: { [challengerName]: 0, [targetUser.username]: 0 },
      winner: null,
      finishedReason: null,
    };

    duels.set(duelId, duel);
    userToDuel.set(challengerName, duelId);
    userToDuel.set(targetUser.username, duelId);

    socket.emit("duel.waiting", {
      duelId,
      opponent: targetUser.username,
      len,
    });
    targetSocket.emit("duel.invite", {
      duelId,
      from: challengerName,
      len,
    });
  });

  socket.on("duel.decline", (payload) => {
    const u = socket.data.user;
    const duelId = typeof payload === "string" ? payload : payload?.duelId;
    const duel = duelId ? duels.get(duelId) : null;
    if (!duel) return;

    if (duel.status !== "pending") return;
    const [p1, p2] = duel.players;

    if (u.username !== p1 && u.username !== p2) return;

    const other = u.username === p1 ? p2 : p1;
    const otherSock = getSocketByUsername(other);
    if (otherSock) otherSock.emit("duel.declined", { duelId, by: u.username });

    userToDuel.delete(p1);
    userToDuel.delete(p2);
    duels.delete(duelId);
  });

  socket.on("duel.accept", (payload) => {
    const u = socket.data.user;
    const duelId = typeof payload === "string" ? payload : payload?.duelId;
    const duel = duelId ? duels.get(duelId) : null;
    if (!duel) return;

    if (duel.status !== "pending") return;

    const [p1, p2] = duel.players;
    if (u.username !== p1 && u.username !== p2) return;

    duel.status = "active";
    duel.startedAt = Date.now();
    duel.expiresAt = duel.startedAt + DUEL_MAX_DURATION_MS;

    const s1 = getSocketByUsername(p1);
    const s2 = getSocketByUsername(p2);

    if (s1) s1.emit("duel.start", { duelId, opponent: p2, len: duel.len });
    if (s2) s2.emit("duel.start", { duelId, opponent: p1, len: duel.len });
  });

  socket.on("duel.guess", (payload) => {
    const u = socket.data.user;
    const duelId = payload?.duelId;
    const guess = String(payload?.guess || "").trim().toUpperCase();
    const duel = duelId ? duels.get(duelId) : null;
    if (!duel) return;

    if (duel.status !== "active") return;
    if (!duel.players.includes(u.username)) return;

    if (!guess || guess.length !== duel.len) {
      return socket.emit("duel.error", { message: `Vārdam jābūt ${duel.len} burtiem.` });
    }
    if (!GUESS_ALLOWED_RE.test(guess)) {
      return socket.emit("duel.error", { message: "Minējumā drīkst būt tikai burti (A-Z + LV)." });
    }

    const left = duel.attemptsLeft[u.username] ?? 0;
    if (left <= 0) return;

    duel.attemptsLeft[u.username] = left - 1;
    duel.rowsUsed[u.username] = (duel.rowsUsed[u.username] || 0) + 1;

    const pattern = buildPattern(duel.word, guess);
    const win = guess === duel.word;

    socket.emit("duel.result", {
      duelId,
      pattern,
      win,
      attemptsLeft: duel.attemptsLeft[u.username],
    });

    if (win) {
      finishDuel(duel, u.username, "win");
      return;
    }

    // ja abi iztērējuši mēģinājumus -> neizšķirts (timeout/none)
    const [p1, p2] = duel.players;
    const l1 = duel.attemptsLeft[p1] ?? 0;
    const l2 = duel.attemptsLeft[p2] ?? 0;
    if (l1 <= 0 && l2 <= 0) finishDuel(duel, null, "no_attempts");
  });

  socket.on("disconnect", () => {
    onlineBySocket.delete(socket.id);
    broadcastOnlineList(true);
  });
});

// ======== WHEEL server init ========
