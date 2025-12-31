// abilities.js (ESM) — piesprauž abilities pie katra socket
import crypto from "crypto";

export function attachAbilities(ctx) {
  const {
    io,
    socket,
    // tev jāiedod šīs 4 funkcijas no server.js (skat. zemāk “Server.js ielikšana”)
    getUserBySocket,      // (socket) => userObj vai null
    getRoundByUser,       // (username) => currentRoundObj vai null
    saveUser,             // async (userObj) => void
    persistUsers,         // async () => void  (var būt undefined)
    config = {},
  } = ctx;

  const REVEAL_COST_TOKENS = Number(config.revealCostTokens ?? 2);
  const REVEAL_ONCE_PER_ROUND = config.revealOncePerRound !== false;

  function emitErr(code, extra) {
    socket.emit("ability:error", { code, ...(extra || {}) });
  }

  function pickHiddenIndex(word, revealedMask) {
    const hidden = [];
    for (let i = 0; i < word.length; i++) {
      if (!revealedMask[i]) hidden.push(i);
    }
    if (!hidden.length) return -1;
    return hidden[crypto.randomInt(0, hidden.length)];
  }

  // ===== Ability: Reveal Letter =====
  socket.on("ability:revealLetter", async () => {
    try {
      const user = getUserBySocket(socket);
      if (!user) return emitErr("NO_AUTH");

      const username = String(user.username || user.nick || user.name || "");
      if (!username) return emitErr("NO_USER");

      const round = getRoundByUser(username);
      if (!round || !round.word) return emitErr("NO_ROUND");

      round.abilitiesUsed = round.abilitiesUsed || {};
      if (REVEAL_ONCE_PER_ROUND && round.abilitiesUsed.revealLetter) {
        return emitErr("ALREADY_USED");
      }

      const word = String(round.word);
      if (!word.length) return emitErr("BAD_WORD");

      // Mask, kur glabājam atvērtos burtus (hint rindai)
      if (!Array.isArray(round.revealedMask) || round.revealedMask.length !== word.length) {
        round.revealedMask = Array(word.length).fill(false);
      }

      const tokens = Number(user.tokens || 0);
      if (tokens < REVEAL_COST_TOKENS) {
        return emitErr("NO_TOKENS", { need: REVEAL_COST_TOKENS, have: tokens });
      }

      const idx = pickHiddenIndex(word, round.revealedMask);
      if (idx === -1) {
        round.abilitiesUsed.revealLetter = true;
        return emitErr("NOTHING_TO_REVEAL");
      }

      // Apmaksa + atvēršana
      user.tokens = tokens - REVEAL_COST_TOKENS;
      round.revealedMask[idx] = true;
      round.abilitiesUsed.revealLetter = true;

      await saveUser(user);
      if (persistUsers) await persistUsers();

      socket.emit("ability:revealLetterResult", {
        index: idx,
        letter: word[idx],
        costTokens: REVEAL_COST_TOKENS,
        tokensLeft: Number(user.tokens || 0),
      });

    } catch (e) {
      emitErr("SERVER_ERROR");
    }
  });
}
