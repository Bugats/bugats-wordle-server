/**
 * Zole UI — no jauna: funkcionāls skelets (JSON stāvoklis + pogas), bez vecā vizuālā slāņa.
 */
(function (global) {
  "use strict";

  const ZOLE_TRICK_HOLD_MS = 2600;
  let zoleTrickHoldTimer = null;
  let zoleTrickHoldSig = null;
  let zoleTrickHoldUntil = 0;
  let zoleTrickHoldCleared = false;
  let zoleTrickHoldTricksPlayed = null;

  function zoleCompletedTrickSignature(zole) {
    const lc = zole && zole.lastCompletedTrick;
    if (!lc || !lc.cards || lc.cards.length !== 3) return null;
    const parts = lc.cards.map(
      (t) => `${t.playerIdx}:${t.card.s}:${t.card.r}`
    );
    return `${parts.join("|")}::w${lc.winnerIdx}::e${lc.trickEyes ?? 0}`;
  }

  function clearZoleTrickHoldTimer() {
    if (zoleTrickHoldTimer != null) {
      global.clearTimeout(zoleTrickHoldTimer);
      zoleTrickHoldTimer = null;
    }
  }

  function resetZoleTrickHold() {
    clearZoleTrickHoldTimer();
    zoleTrickHoldSig = null;
    zoleTrickHoldUntil = 0;
    zoleTrickHoldCleared = false;
    zoleTrickHoldTricksPlayed = null;
  }

  function scheduleZoleTrickHoldClear(scheduleRedraw) {
    if (typeof scheduleRedraw !== "function") return;
    zoleTrickHoldTimer = global.setTimeout(() => {
      zoleTrickHoldTimer = null;
      zoleTrickHoldCleared = true;
      scheduleRedraw();
      global.requestAnimationFrame(() => {
        global.requestAnimationFrame(() => scheduleRedraw());
      });
    }, ZOLE_TRICK_HOLD_MS);
  }

  global.VZZoleBoardTrickHold = Object.freeze({
    reset: resetZoleTrickHold,
    onZoleSnapshot(zole, scheduleRedraw) {
      if (!zole || zole.phase !== "play") {
        resetZoleTrickHold();
        return;
      }
      const trick = zole.trick || [];
      if (trick.length > 0) {
        resetZoleTrickHold();
        return;
      }
      if (
        zoleTrickHoldUntil > 0 &&
        Date.now() >= zoleTrickHoldUntil &&
        !zoleTrickHoldCleared
      ) {
        zoleTrickHoldCleared = true;
        clearZoleTrickHoldTimer();
      }
      const sig = zoleCompletedTrickSignature(zole);
      if (!sig) {
        resetZoleTrickHold();
        return;
      }
      const tp =
        typeof zole.tricksPlayed === "number" ? zole.tricksPlayed : null;
      if (
        zoleTrickHoldTricksPlayed != null &&
        tp != null &&
        tp !== zoleTrickHoldTricksPlayed
      ) {
        resetZoleTrickHold();
        zoleTrickHoldSig = sig;
        zoleTrickHoldTricksPlayed = tp;
        zoleTrickHoldUntil = Date.now() + ZOLE_TRICK_HOLD_MS;
        zoleTrickHoldCleared = false;
        scheduleZoleTrickHoldClear(scheduleRedraw);
        return;
      }
      if (sig !== zoleTrickHoldSig) {
        resetZoleTrickHold();
        zoleTrickHoldSig = sig;
        zoleTrickHoldTricksPlayed = tp;
        zoleTrickHoldUntil = Date.now() + ZOLE_TRICK_HOLD_MS;
        zoleTrickHoldCleared = false;
        scheduleZoleTrickHoldClear(scheduleRedraw);
      }
    },
  });

  const ZOLE_SUIT_KARAVS = 1;
  const RANK_LABELS = {
    7: "7",
    8: "8",
    9: "9",
    10: "10",
    11: "J",
    12: "D",
    13: "K",
    14: "A",
  };

  function isZoleTrumpCard(card) {
    if (!card || typeof card.r !== "number") return false;
    if (card.r === 12 || card.r === 11) return true;
    if (card.s === ZOLE_SUIT_KARAVS && card.r !== 12 && card.r !== 11)
      return true;
    return false;
  }

  function cardLabel(card) {
    if (!card) return "?";
    const suits = ["♣", "♦", "♥", "♠"];
    const s = suits[card.s] || "?";
    const r = RANK_LABELS[card.r] || String(card.r);
    return s + r;
  }

  function cardKey(c) {
    return `${c.s}:${c.r}`;
  }

  function sortHand(hand) {
    return (hand || []).slice().sort((a, b) => a.s - b.s || a.r - b.r);
  }

  function zoleStatePre(zole, myIdx) {
    const trickCards = (zole.trick || [])
      .map((t) =>
        t && t.card
          ? `${zole.players?.[t.playerIdx] || "?"}: ${cardLabel(t.card)}`
          : null
      )
      .filter(Boolean);
    const lc = zole.lastCompletedTrick;
    let lastTrickLine = "—";
    if (lc && lc.cards && lc.cards.length === 3) {
      const bits = lc.cards.map(
        (t) => `${zole.players?.[t.playerIdx] || "?"}:${cardLabel(t.card)}`
      );
      lastTrickLine = `${bits.join(" · ")} → ${zole.players?.[lc.winnerIdx] || "?"} (${lc.trickEyes ?? 0} acis)`;
    }
    const lines = [
      `Fāze: ${zole.phase || "?"}`,
      `Spēlētāji: ${(zole.players || []).join(", ") || "—"}`,
      `Tu: indekss ${myIdx} (${zole.players?.[myIdx] || "?"})`,
      `Likšana: kārta #${zole.bidTurn ?? "?"} · raunds ${zole.bidRound === 2 ? 2 : 1}`,
      `Līgums: ${zole.contract || "—"}${zole.contractorIdx != null ? ` · līgumslēdzējs: ${zole.players?.[zole.contractorIdx]}` : ""}`,
      `Gājiens (kārtis): ${zole.players?.[zole.turn] ?? zole.turn ?? "—"}`,
      `Stiķis uz galda: ${trickCards.length ? trickCards.join(" | ") : "—"}`,
      `Pēdējais noslēgtais stiķis: ${lastTrickLine}`,
      `Lācis: ${zole.trumpLabel || "—"}`,
      `Acis: ${(zole.eyePoints || []).join(" · ") || "—"}`,
      `Stiķi: ${(zole.tricksWon || []).join(" · ") || "—"}`,
      `Stiķī tagad (acis): ${zole.currentTrickEyes ?? "—"}`,
      `Roka (${(zole.myHand || []).length}): ${sortHand(zole.myHand).map(cardLabel).join(" ")}`,
    ];
    if (zole.trumpNote) lines.push(`Sekšana: ${zole.trumpNote}`);
    if (zole.tableDelta) lines.push(`Partijas delta: ${zole.tableDelta.join(" · ")}`);
    if (zole.cumulativeTableDelta)
      lines.push(`Kopā: ${zole.cumulativeTableDelta.join(" · ")}`);
    if (zole.matchHandsPlayed != null)
      lines.push(`Partijas (mačā): ${zole.matchHandsPlayed}`);
    return lines.join("\n");
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function renderZoleBoard(zole, isMyTurn, onPlayCard, opts) {
    const container = document.getElementById("board-zole-container");
    if (!container) return;
    container.classList.remove("hidden");

    const myIdx =
      opts && typeof opts.myIdx === "number" && opts.myIdx >= 0
        ? opts.myIdx
        : 0;
    const onBid = opts && typeof opts.onBid === "function" ? opts.onBid : null;
    const onDiscard =
      opts && typeof opts.onDiscard === "function" ? opts.onDiscard : null;

    container.innerHTML = "";
    const root = el("div", "vz-zole-ui");
    const title = el("h3", "vz-zole-ui__title", "Zole");
    root.appendChild(title);

    const pre = el("pre", "vz-zole-ui__pre", zoleStatePre(zole, myIdx));
    pre.setAttribute("aria-label", "Spēles stāvoklis");
    root.appendChild(pre);

    const phase = zole.phase || "";

    if (phase === "bid") {
      const row = el("div", "vz-zole-ui__row");
      const isMyBid = (zole.bidTurn ?? 0) === myIdx;
      if (isMyBid && onBid) {
        const bids = [
          { key: "pass", label: "Garām" },
          { key: "big", label: "Lielais" },
          { key: "zole", label: "Zole" },
          { key: "maza_zole", label: "Mazā zole" },
        ];
        for (const b of bids) {
          const btn = el("button", "vz-zole-ui__btn", b.label);
          btn.type = "button";
          btn.addEventListener("click", () => onBid(b.key));
          row.appendChild(btn);
        }
      } else {
        const p = el("p", null, isMyBid ? "Likšana nav pieejama." : "Gaida citu likšanu…");
        p.style.margin = "0";
        p.style.opacity = "0.8";
        row.appendChild(p);
      }
      root.appendChild(row);
    }

    if (phase === "discard" && zole.contract === "big") {
      const isContractor = myIdx === zole.contractorIdx;
      const box = el("div", null);
      const h = el("div", "vz-zole-ui__title", "Norakšana");
      h.style.fontSize = "13px";
      box.appendChild(h);
      const hint = el(
        "p",
        null,
        isContractor
          ? "Izvēlies divas kārtis, tad spied «Norakt»."
          : "Gaida, kamēr lielais norok…"
      );
      hint.style.margin = "0 0 8px";
      hint.style.fontSize = "12px";
      hint.style.opacity = "0.85";
      box.appendChild(hint);

      const handWrap = el("div", "vz-zole-ui__hand");
      const selected = [];
      const hand = sortHand(zole.myHand || []);

      function syncDiscardBtn() {
        confirmBtn.disabled = selected.length !== 2 || !onDiscard;
      }

      const confirmBtn = el("button", "vz-zole-ui__btn vz-zole-ui__btn--primary", "Norakt");
      confirmBtn.type = "button";
      confirmBtn.disabled = true;

      for (const card of hand) {
        const btn = el("button", "vz-zole-ui__card", cardLabel(card));
        btn.type = "button";
        if (isZoleTrumpCard(card)) btn.classList.add("vz-zole-ui__card--trump");
        if (!isContractor || !onDiscard) {
          btn.disabled = true;
        } else {
          btn.addEventListener("click", () => {
            const k = cardKey(card);
            const ix = selected.findIndex((c) => cardKey(c) === k);
            if (ix >= 0) {
              selected.splice(ix, 1);
              btn.classList.remove("vz-zole-ui__card--sel");
            } else if (selected.length < 2) {
              selected.push(card);
              btn.classList.add("vz-zole-ui__card--sel");
            }
            syncDiscardBtn();
          });
        }
        handWrap.appendChild(btn);
      }
      box.appendChild(handWrap);

      const row = el("div", "vz-zole-ui__row");
      row.appendChild(confirmBtn);
      if (isContractor && onDiscard) {
        confirmBtn.addEventListener("click", () => {
          if (selected.length !== 2) return;
          onDiscard(selected.slice());
        });
      }
      box.appendChild(row);
      root.appendChild(box);
    }

    if (phase === "play") {
      let legalSet = null;
      if (isMyTurn) {
        if (global.VZZoleLegal) {
          const legal = global.VZZoleLegal.zoleLegalPlays(
            zole.myHand || [],
            zole.trick || []
          );
          legalSet = new Set(legal.map((c) => global.VZZoleLegal.zoleCardKey(c)));
        } else if (zole.legalCardKeys && zole.legalCardKeys.length) {
          legalSet = new Set(zole.legalCardKeys);
        }
      }
      const sub = el("div", null);
      const ht = el("div", "vz-zole-ui__title", "Tavas kārtis");
      ht.style.fontSize = "13px";
      sub.appendChild(ht);
      const handWrap = el("div", "vz-zole-ui__hand");
      for (const card of sortHand(zole.myHand || [])) {
        const k = cardKey(card);
        const can =
          isMyTurn && (!legalSet || legalSet.has(k));
        const btn = el("button", "vz-zole-ui__card", cardLabel(card));
        btn.type = "button";
        if (isZoleTrumpCard(card)) btn.classList.add("vz-zole-ui__card--trump");
        btn.disabled = !can;
        if (can) btn.addEventListener("click", () => onPlayCard(card));
        handWrap.appendChild(btn);
      }
      sub.appendChild(handWrap);
      root.appendChild(sub);
    }

    if (phase === "end" && zole.tableDelta) {
      const box = el("div", null);
      box.style.marginTop = "10px";
      const t = el("div", "vz-zole-ui__title", "Partijas rezultāts");
      t.style.fontSize = "13px";
      box.appendChild(t);
      const parts = [];
      for (let i = 0; i < 3; i++) {
        const n = zole.tableDelta[i];
        if (!n) continue;
        const sign = n > 0 ? "+" : "";
        parts.push(`${zole.players?.[i] || "?"}: ${sign}${n}`);
      }
      const p = el("p", null, parts.join(" · ") || "—");
      p.style.margin = "6px 0 0";
      p.style.fontSize = "13px";
      box.appendChild(p);
      if (zole.lastResult && zole.lastResult.kind) {
        const d = el("p", null, JSON.stringify(zole.lastResult));
        d.style.margin = "8px 0 0";
        d.style.fontSize = "11px";
        d.style.opacity = "0.85";
        d.style.wordBreak = "break-word";
        box.appendChild(d);
      }
      root.appendChild(box);
    }

    container.appendChild(root);
  }

  global.VZZoleBoard = Object.freeze({
    renderZoleBoard,
    cardLabel,
    cardKey,
    isZoleTrumpCard,
  });
})(window);
