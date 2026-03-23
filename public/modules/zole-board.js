/**
 * Zole UI (3 spēlētāji, vienkāršots MVP)
 */
(function (global) {
  "use strict";

  function esc(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const RANK_LABELS = {
    7: "7",
    8: "8",
    9: "9",
    10: "10",
    11: "J",
    12: "Q",
    13: "K",
    14: "A",
  };

  function cardLabel(card) {
    if (!card) return "?";
    const suits = ["♥", "♦", "♣"];
    const s = suits[card.s] || "?";
    const r = RANK_LABELS[card.r] || String(card.r);
    return s + r;
  }

  function cardKey(c) {
    return c.s + ":" + c.r;
  }

  function renderZoleBoard(zole, isMyTurn, onPlayCard, opts) {
    const container = document.getElementById("board-zole-container");
    if (!container) return;
    container.classList.remove("hidden");
    container.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.className = "vz-zole-wrap";

    const meta = document.createElement("div");
    meta.className = "vz-zole-meta";
    meta.innerHTML = `<div class="vz-zole-trump">Lācis: <strong>${esc(zole.trumpLabel)}</strong></div>`;
    const scoreLine = document.createElement("div");
    scoreLine.className = "vz-zole-scores";
    scoreLine.textContent = `Stiķi: ${(zole.scores || []).join(" · ")}`;
    meta.appendChild(scoreLine);
    const turnLine = document.createElement("div");
    turnLine.className = "vz-zole-turn";
    const tName = zole.players[zole.turn] || "?";
    turnLine.textContent = `Kārta: ${tName}`;
    meta.appendChild(turnLine);
    wrap.appendChild(meta);

    const trickEl = document.createElement("div");
    trickEl.className = "vz-zole-trick";
    trickEl.innerHTML = "<span class=\"vz-zole-trick-title\">Uz galda</span>";
    const row = document.createElement("div");
    row.className = "vz-zole-trick-row";
    const trick = zole.trick || [];
    for (let i = 0; i < 3; i++) {
      const slot = document.createElement("div");
      slot.className = "vz-zole-trick-slot";
      const t = trick[i];
      if (t) {
        const who = zole.players[t.playerIdx] || "?";
        slot.innerHTML = `<span class="vz-zole-trick-who">${esc(who)}</span><span class="vz-zole-card vz-zole-card--sm">${esc(cardLabel(t.card))}</span>`;
      } else {
        slot.textContent = "—";
      }
      row.appendChild(slot);
    }
    trickEl.appendChild(row);
    wrap.appendChild(trickEl);

    const handEl = document.createElement("div");
    handEl.className = "vz-zole-hand";
    const title = document.createElement("div");
    title.className = "vz-zole-hand-title";
    title.textContent = "Tavas kārtis";
    handEl.appendChild(title);

    const btnRow = document.createElement("div");
    btnRow.className = "vz-zole-hand-btns";

    const hand = zole.myHand || [];
    hand.sort((a, b) => a.s - b.s || a.r - b.r);
    const legalSet = zole.legalCardKeys
      ? new Set(zole.legalCardKeys)
      : null;

    for (const card of hand) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "vz-zole-card-btn";
      btn.textContent = cardLabel(card);
      btn.dataset.s = String(card.s);
      btn.dataset.r = String(card.r);
      const can =
        isMyTurn &&
        zole.phase === "play" &&
        (!legalSet || legalSet.has(cardKey(card)));
      btn.disabled = !can;
      if (can) {
        btn.addEventListener("click", () => onPlayCard(card));
      }
      btnRow.appendChild(btn);
    }
    handEl.appendChild(btnRow);

    const note = document.createElement("p");
    note.className = "vz-zole-note";
    const online =
      opts && String(opts.zoleMode || "").toLowerCase() === "online_2p";
    note.textContent = online
      ? "MVP: 3 krāsas × 8 kārtis, 8 stiķi. Tiešsaiste: tu + draugs + trešais ir bots."
      : "MVP: 3 krāsas × 8 kārtis, 8 stiķi. Pret diviem botiem.";
    handEl.appendChild(note);

    wrap.appendChild(handEl);
    container.appendChild(wrap);
  }

  global.VZZoleBoard = Object.freeze({
    renderZoleBoard,
    cardLabel,
    cardKey,
  });
})(window);
