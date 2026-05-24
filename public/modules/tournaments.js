(function (global) {
  "use strict";

  function tournamentTypeLabel(type) {
    const key = String(type || "")
      .trim()
      .toLowerCase();
    if (key === "single_elimination") return "Izslēgšanas turnīrs";
    if (key === "double_elimination") return "Dubultā izslēgšana";
    if (key === "round_robin") return "Apļa turnīrs";
    return "Turnīrs";
  }

  function tournamentPlayModeText(mode) {
    const key = String(mode || "")
      .trim()
      .toLowerCase();
    if (key === "classic") return "Classic";
    if (key === "speed") return "Speed";
    if (key === "accuracy") return "Accuracy";
    if (key === "survival") return "Survival";
    if (key === "dambrete") return "♟️ Dambrete";
    if (key === "chess") return "♔ Šahs";
    if (key === "zole") return "🃏 Zole";
    return "";
  }

  function tournamentMatchStatusLabel(status) {
    const code = Number(status);
    if (code === 0) return "Vēl nav pieejams";
    if (code === 1) return "Gaida pretinieku";
    if (code === 2) return "Var spēlēt";
    if (code === 3) return "Notiek";
    if (code === 4) return "Pabeigts";
    if (code === 5) return "Arhivēts";
    return "Nezināms";
  }

  function normalizeTournamentList(payload) {
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.tournaments)
        ? payload.tournaments
        : [];
    return list.filter((t) => t && Number.isFinite(Number(t.id)));
  }

  function normalizeTournamentSchedule(raw) {
    if (!raw || typeof raw !== "object") return null;
    const startAt = Math.max(0, Number(raw.startAt) || 0);
    const slots = Math.max(2, Math.floor(Number(raw.slots) || 0));
    const joinedCount = Math.max(0, Math.floor(Number(raw.joinedCount) || 0));
    const participants = Array.isArray(raw.participants)
      ? raw.participants
          .map((u) => String(u || "").trim())
          .filter(Boolean)
          .slice(0, slots || 32)
      : [];
    const rules = Array.isArray(raw.rules)
      ? raw.rules
          .map((r) => String(r || "").trim())
          .filter(Boolean)
          .slice(0, 8)
      : [];
    return {
      enabled: !!raw.enabled,
      title: String(raw.title || "Nedēļas turnīrs"),
      mode: String(raw.mode || "").trim(),
      modeLabel: String(raw.modeLabel || "").trim(),
      playMode: String(raw.playMode || "").trim(),
      playModeLabel: String(raw.playModeLabel || "").trim(),
      startAt,
      slots,
      joinedCount,
      participants,
      isJoined: !!raw.isJoined,
      canJoin: !!raw.canJoin,
      startsOnlyWhenFull: !!raw.startsOnlyWhenFull,
      waitForAllSlots: !!raw.waitForAllSlots,
      joinBlockedReason: String(raw.joinBlockedReason || ""),
      rules,
      lastCycle:
        raw.lastCycle && typeof raw.lastCycle === "object" ? raw.lastCycle : null,
    };
  }

  global.VZTournaments = Object.freeze({
    normalizeTournamentList,
    normalizeTournamentSchedule,
    tournamentMatchStatusLabel,
    tournamentPlayModeText,
    tournamentTypeLabel,
  });
})(window);
