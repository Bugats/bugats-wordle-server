(function (global) {
  "use strict";

  function isDuelDrawReason(reason) {
    return reason === "timeout" || reason === "no_attempts" || reason === "no_winner";
  }

  function buildDuelExtraText({ youWin, winner, reason, opponent }) {
    if (youWin) return `Tu uzvarēji dueli pret ${opponent || "pretinieku"}!`;
    if (winner) return `${winner} uzvarēja dueli.`;
    if (reason === "declined") return "Izaicinājums tika noraidīts.";
    if (isDuelDrawReason(reason)) return "Neizšķirts.";
    return "Duelis beidzies.";
  }

  global.VZDuel = Object.freeze({
    buildDuelExtraText,
    isDuelDrawReason,
  });
})(window);
