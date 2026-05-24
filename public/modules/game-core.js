(function (global) {
  "use strict";

  const ADMIN_USERNAMES = ["Bugats", "BugatsLV"];
  const ADMIN_SET = new Set(
    ADMIN_USERNAMES.map((u) => String(u).trim().toLowerCase())
  );

  function isAdminUsername(username) {
    return ADMIN_SET.has(
      String(username || "")
        .trim()
        .toLowerCase()
    );
  }

  const REGION_META = {
    Zemgale: { code: "Z", cls: "vz-region-zemgale", label: "Zemgale" },
    Latgale: { code: "L", cls: "vz-region-latgale", label: "Latgale" },
    Vidzeme: { code: "V", cls: "vz-region-vidzeme", label: "Vidzeme" },
    Kurzeme: { code: "K", cls: "vz-region-kurzeme", label: "Kurzeme" },
  };

  const REGION_TOTAL_CAP = 500000;
  const DISALLOWED_KEYS = new Set(["Q", "W", "X", "Y"]);

  const AUTH_KEYS = {
    token: ["vz_token", "vzToken", "token"],
    username: ["vz_username", "vzUsername", "username", "nick"],
    refreshToken: ["vz_refresh_token", "vzRefreshToken", "refreshToken"],
    accessExpiresAt: ["vz_access_expires_at"],
    refreshExpiresAt: ["vz_refresh_expires_at"],
  };

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
    0, 40, 90, 160, 250, 360, 490, 640, 810, 1000, 1200, 1450, 1750, 2100,
    2500, 2950, 3450, 4000, 4600, 5250, 5950, 6700, 7500, 8350, 9250, 10200,
    11200, 12300, 13500, 14800, 16200, 17700, 19300, 21000, 22800, 24700,
    26700, 28800, 31000, 33300,
  ];

  function rankMinXpByLevel(level) {
    const lvl = Math.max(1, Math.min(40, Number(level) || 1));
    return RANK_MIN_XP[lvl - 1] ?? 0;
  }

  function createInitialState() {
    return {
      token: null,
      refreshToken: null,
      accessTokenExpiresAt: 0,
      refreshTokenExpiresAt: 0,
      username: null,
      email: "",
      betaTester: false,
      betaOptInRequestedAt: 0,
      giveawayNhlTeam: "",
      giveawayNhlAbbr: "",
      region: "",
      regionPoints: 0,
      regionBoost: 0,
      regionAttackTarget: "",
      regionAttackRegion: "",
      regionAttackLimit: null,
      regionBonusStatus: null,
      regionRules: [],
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
      onlineMiniByUser: new Map(),
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

      // coins / XP / level / streak animāciju helperi
      lastCoins: null,
      lastXp: null,
      lastRankLevel: null,
      lastStreak: null,

      // 1v1 duelis
      duelMode: false,
      duelId: null,
      duelOpponent: null,

      // Sezona
      season: null,

      // Turniri
      tournaments: [],
      recentTournaments: [],
      tournamentActiveId: null,
      tournamentReportCtx: null,
      tournamentDisputeCtx: null,
      tournamentDisputes: [],
      tournamentLiveMatchKey: "",
      tournamentLiveMatchStatus: null,
      tournamentUiPrimed: false,
      tournamentSocketMatchHint: false,
      tournamentHintTournamentId: null,
      tournamentSchedule: null,
      vipRooms: [],
      vipRoomDraftInvites: [],
      vipActive: false,
      vipUntil: 0,
      vipTier: "none",
      canCreateTournament: false,
      isAdmin: false,
      pendingDuelInvites: [],
      seenOfflineDuelInviteKeys: new Set(),

      /** Draugu kopsavilkums no servera (online + galds + klana tags) */
      friendSummaries: [],
      /** Meklēšanas teksts draugu sarakstā (klienta filtrs) */
      friendListFilter: "",
      /** Pēdējais /me objekts sociālajam pulsam */
      lastMeForSocial: null,

      // Globālā skaņa
      soundOn: true,

      // Tēma: dark | light | contrast
      theme: "dark",

      // Izaicinājums draugam (viens vārds, mazāk mēģinājumu = uzvara)
      challengeId: null,
      challengeOpponent: null,
      challengeLen: null,
      challengeFinished: false,

      // UI loop cache (lai spēlētājs nepaliek strupceļā)
      missions: [],
      missionBonus: null,
      loopPrimaryAction: null,
      loopPrimaryActionKey: "",

      stripeCoinsEnabled: false,
      stripeCoinPacks: [],
    };
  }

  global.VZGameCore = Object.freeze({
    ADMIN_USERNAMES,
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
  });
})(window);
