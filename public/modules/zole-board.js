/**
 * Zole UI — pārskatāms galds, spēlētāji, stiķis, tabula, roka.
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
  const SUIT_META = [
    { sym: "♣", red: false },
    { sym: "♦", red: true },
    { sym: "♥", red: true },
    { sym: "♠", red: false },
  ];

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

  function esc(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function contractLabel(c) {
    if (c === "big") return "Lielais";
    if (c === "zole") return "Zole";
    if (c === "maza_zole") return "Mazā zole";
    if (c === "galdins") return "Galdiņš";
    if (c === "galds") return "Galds";
    return c ? String(c) : "—";
  }

  function zoleActiveTurnPlayerIndex(zole) {
    if (!zole) return null;
    const ph = zole.phase || "";
    if (ph === "bid") {
      const bt = zole.bidTurn;
      return typeof bt === "number" && bt >= 0 && bt < 3 ? bt : null;
    }
    if (ph === "discard" && zole.contract === "big") {
      const c = zole.contractorIdx;
      return typeof c === "number" && c >= 0 && c < 3 ? c : null;
    }
    if (ph === "play") {
      const t = zole.turn;
      return typeof t === "number" && t >= 0 && t < 3 ? t : null;
    }
    return null;
  }

  function zolePlayerRoleLine(zole, playerIdx) {
    const ph = zole.phase || "";
    const c = zole.contract;
    if (ph === "bid" || !c) return "—";
    if (c === "galdins") return "Galdiņš";
    if (c === "galds") return "Galds";
    const ci = zole.contractorIdx;
    if (ci == null || ci < 0) return "—";
    const isContractor = playerIdx === ci;
    if (c === "big") return isContractor ? "Lielais" : "Mazais";
    if (c === "zole")
      return isContractor ? "Zole · lielais" : "Zole · mazais";
    if (c === "maza_zole")
      return isContractor ? "Mazā zole · lielais" : "Mazā zole · mazais";
    return "—";
  }

  function formatPts(n) {
    if (n == null || n === "") return "—";
    const v = Number(n);
    if (!Number.isFinite(v)) return String(n);
    if (v > 0) return `+${v}`;
    return String(v);
  }

  function trickPlayOrderSeats(zole) {
    const trick = zole.trick || [];
    let leader =
      typeof zole.trickLeader === "number" ? zole.trickLeader : 0;
    if (trick.length === 0 && zole.lastCompletedTrick) {
      const li = zole.lastCompletedTrick.leaderIdx;
      if (typeof li === "number") leader = li;
    }
    leader = ((leader % 3) + 3) % 3;
    return [leader, (leader + 1) % 3, (leader + 2) % 3];
  }

  function trickCardByPlayer(zole) {
    const map = {};
    const trick = zole.trick || [];
    if (trick.length > 0) {
      for (const t of trick) {
        if (t && t.card) map[t.playerIdx] = t.card;
      }
      return map;
    }
    const lc = zole.lastCompletedTrick;
    if (lc && lc.cards) {
      for (const t of lc.cards) {
        if (t && t.card) map[t.playerIdx] = t.card;
      }
    }
    return map;
  }

  function createCardFace(card, opts) {
    const o = opts || {};
    const small = !!o.small;
    const meta = SUIT_META[card.s] || SUIT_META[0];
    const rank = RANK_LABELS[card.r] || String(card.r);
    const trump = isZoleTrumpCard(card);

    const root = el("div", "vz-zole-card");
    if (small) root.classList.add("vz-zole-card--sm");
    if (meta.red) root.classList.add("vz-zole-card--red");
    else root.classList.add("vz-zole-card--black");
    if (trump) root.classList.add("vz-zole-card--trump");

    const tl = el("span", "vz-zole-card__corner vz-zole-card__corner--tl");
    tl.innerHTML = esc(rank) + "<br>" + esc(meta.sym);
    const c = el("span", "vz-zole-card__center");
    c.textContent = meta.sym;
    const br = el("span", "vz-zole-card__corner vz-zole-card__corner--br");
    br.innerHTML = esc(rank) + "<br>" + esc(meta.sym);
    root.appendChild(tl);
    root.appendChild(c);
    root.appendChild(br);
    return root;
  }

  function buildPointsTable(zole, myIdx) {
    const wrap = el("div", "vz-zole-pt");
    const cap = el("div", "vz-zole-pt__cap", "Punkti");
    wrap.appendChild(cap);
    const table = el("table", "vz-zole-pt__table");
    const thead = el("thead");
    const hr = el("tr");
    for (const h of ["", "Partija", "Kopā", "Acis", "Stiķi"]) {
      const th = el("th", null, h);
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el("tbody");
    const eyes = zole.eyePoints || [0, 0, 0];
    const tricks = zole.tricksWon || [0, 0, 0];
    const tdArr = zole.tableDelta || [0, 0, 0];
    const cum = zole.cumulativeTableDelta || [0, 0, 0];
    const showHand = (zole.phase || "") === "end";
    const activePi = zoleActiveTurnPlayerIndex(zole);

    for (let i = 0; i < 3; i++) {
      const tr = el("tr");
      if (i === myIdx) tr.classList.add("vz-zole-pt__me");
      if (activePi === i) tr.classList.add("vz-zole-pt__active");
      const nameCell = el("td", "vz-zole-pt__name");
      const nm = el("span", "vz-zole-pt__player", zole.players?.[i] || "?");
      nameCell.appendChild(nm);
      const role = el("span", "vz-zole-pt__role", zolePlayerRoleLine(zole, i));
      nameCell.appendChild(role);
      tr.appendChild(nameCell);
      const p1 = el("td", "vz-zole-pt__num", showHand ? formatPts(tdArr[i]) : "—");
      const p2 = el("td", "vz-zole-pt__num", formatPts(cum[i]));
      const p3 = el("td", "vz-zole-pt__num", String(eyes[i] ?? 0));
      const p4 = el("td", "vz-zole-pt__num", String(tricks[i] ?? 0));
      tr.appendChild(p1);
      tr.appendChild(p2);
      tr.appendChild(p3);
      tr.appendChild(p4);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function buildTableFelt(zole) {
    const phase = zole.phase || "";
    const outer = el("div", "vz-zole-felt");
    const cap = el("div", "vz-zole-felt__title", "Galds");
    outer.appendChild(cap);

    if (phase !== "play") {
      const hint = el("div", "vz-zole-felt__idle");
      if (phase === "bid") hint.textContent = "Pēc likšanas šeit būs stiķa kārtis.";
      else if (phase === "discard")
        hint.textContent = "Gaida norakšanu… tad sāksies izspēle.";
      else if (phase === "end") hint.textContent = "Partijas beigas.";
      else hint.textContent = "—";
      outer.appendChild(hint);
      return outer;
    }

    const trick = zole.trick || [];
    const lc = zole.lastCompletedTrick;
    const frozen = trick.length === 0 && lc && lc.cards?.length === 3;
    const byP = trickCardByPlayer(zole);
    const order = trickPlayOrderSeats(zole);
    const turnSeat =
      !frozen && typeof zole.turn === "number" ? zole.turn : null;

    const row = el("div", "vz-zole-felt__trick");
    for (const seat of order) {
      const col = el("div", "vz-zole-felt__seat");
      if (turnSeat === seat) col.classList.add("vz-zole-felt__seat--turn");
      if (frozen) col.classList.add("vz-zole-felt__seat--frozen");

      const head = el("div", "vz-zole-felt__who");
      head.textContent = zole.players?.[seat] || "?";
      col.appendChild(head);

      const cardSlot = el("div", "vz-zole-felt__cardSlot");
      const c = byP[seat];
      if (c) {
        cardSlot.appendChild(createCardFace(c, { small: false }));
      } else {
        const ph = el("div", "vz-zole-felt__placeholder");
        ph.textContent =
          !frozen && turnSeat === seat ? "Domā…" : frozen ? "" : "Gaida…";
        cardSlot.appendChild(ph);
      }
      col.appendChild(cardSlot);
      row.appendChild(col);
    }
    outer.appendChild(row);

    const sub = el("div", "vz-zole-felt__sub");
    if (trick.length > 0) {
      sub.textContent = `Stiķī: ${zole.currentTrickEyes ?? 0} acis`;
    } else if (frozen && lc) {
      const wn = zole.players?.[lc.winnerIdx] || "?";
      sub.textContent = `Stiķis · uzvar ${wn} · ${lc.trickEyes ?? 0} acis`;
    } else {
      sub.textContent = "\u00a0";
    }
    outer.appendChild(sub);

    return outer;
  }

  function buildRivalsRow(zole, myIdx) {
    const row = el("div", "vz-zole-rivals");
    const active = zoleActiveTurnPlayerIndex(zole);
    for (let k = 1; k <= 2; k++) {
      const pi = (myIdx + k) % 3;
      const chip = el("div", "vz-zole-rival");
      if (active === pi) chip.classList.add("vz-zole-rival--active");
      const name = el("div", "vz-zole-rival__name", zole.players?.[pi] || "?");
      const meta = el("div", "vz-zole-rival__meta");
      const eyes = zole.eyePoints?.[pi] ?? 0;
      const tr = zole.tricksWon?.[pi] ?? 0;
      meta.textContent = `${eyes} acis · ${tr} stiķi`;
      chip.appendChild(name);
      chip.appendChild(meta);
      const role = el("div", "vz-zole-rival__role", zolePlayerRoleLine(zole, pi));
      chip.appendChild(role);
      row.appendChild(chip);
    }
    return row;
  }

  function lastResultText(zole) {
    const lr = zole.lastResult;
    if (!lr || !lr.kind) return "";
    if (lr.kind === "galdins") {
      if (lr.tie) return "Galdiņš: trīs vienādi — bez izmaksām.";
      const bs =
        lr.loserNoTricks === true ? " Bezstiķis — maksā pa 3 p." : "";
      return `Galdiņš: zaudē ${zole.players?.[lr.loserIdx] || "?"}, maksā katram uzvarētājam ${lr.payEach} p.${bs}`;
    }
    if (lr.kind === "galds") {
      const bs =
        lr.loserNoTricks === true ? " Bezstiķis — maksā pa 3 p." : "";
      return `Galds: zaudē ${zole.players?.[lr.loserIdx] || "?"}, maksā katram ${lr.payEach} p.${bs}`;
    }
    if (lr.kind === "big") {
      if (lr.win) {
        const bs = lr.opponentsNoTricks === true ? " Mazajiem bezstiķis." : "";
        return `Lielais uzvarēja (${lr.tier} p. no katra mazā).${bs}`;
      }
      const bs =
        lr.contractorNoTricks === true ? " Lielajam bezstiķis." : "";
      return `Lielais zaudēja (${lr.tier} p. katram mazajam).${bs}`;
    }
    if (lr.kind === "zole") {
      if (lr.win) {
        const vs = lr.allTricks === true ? " Visi stiķi." : "";
        return `Zole uzvarēta (${lr.tier} p. no katra).${vs}`;
      }
      const bs =
        lr.contractorNoTricks === true ? " Lielajam bezstiķis." : "";
      return `Zole zaudēta (${lr.tier} p. katram pretiniekam).${bs}`;
    }
    if (lr.kind === "maza_zole") {
      return lr.win
        ? "Mazā zole uzvarēta (+12 · −6 katram mazajam)."
        : "Mazā zole zaudēta (−14 · +7 katram mazajam).";
    }
    return "";
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
    const zm = opts && String(opts.zoleMode || "").toLowerCase();

    container.innerHTML = "";
    const root = el("div", "vz-zole");

    /* Augšējā josla */
    const top = el("div", "vz-zole__top");
    const phase = zole.phase || "";
    const phaseLab =
      phase === "bid"
        ? "Likšana"
        : phase === "discard"
          ? "Norakšana"
          : phase === "play"
            ? "Izspēle"
            : phase === "end"
              ? "Beigas"
              : phase;
    top.appendChild(el("span", "vz-zole__phase", phaseLab));
    if (zole.contract) {
      let contractTxt = contractLabel(zole.contract);
      if (zole.contractorIdx != null && zole.players) {
        contractTxt += ` · ${zole.players[zole.contractorIdx] || "?"}`;
      }
      top.appendChild(el("span", "vz-zole__contract", contractTxt));
    }
    top.appendChild(
      el("span", "vz-zole__trump", `Lācis: ${zole.trumpLabel || "—"}`)
    );
    root.appendChild(top);

    /* Tu */
    const meBar = el("div", "vz-zole-me");
    const meName = el("div", "vz-zole-me__name", zole.players?.[myIdx] || "Tu");
    if (zoleActiveTurnPlayerIndex(zole) === myIdx)
      meName.classList.add("vz-zole-me__name--turn");
    meBar.appendChild(meName);
    const meSub = el("div", "vz-zole-me__sub");
    const e0 = zole.eyePoints?.[myIdx] ?? 0;
    const t0 = zole.tricksWon?.[myIdx] ?? 0;
    meSub.textContent = `${e0} acis · ${t0} stiķi · ${zolePlayerRoleLine(zole, myIdx)}`;
    meBar.appendChild(meSub);
    root.appendChild(meBar);

    root.appendChild(buildRivalsRow(zole, myIdx));
    root.appendChild(buildTableFelt(zole));

    /* Tabula + sekšana */
    const mid = el("div", "vz-zole__mid");
    mid.appendChild(buildPointsTable(zole, myIdx));
    if (zole.trumpNote) {
      const det = el("details", "vz-zole-sek");
      const sum = el("summary", "vz-zole-sek__sum", "Sekšana un trumpji");
      const body = el("div", "vz-zole-sek__body");
      body.textContent = zole.trumpNote;
      det.appendChild(sum);
      det.appendChild(body);
      mid.appendChild(det);
    }
    root.appendChild(mid);

    /* Likšana */
    if (phase === "bid") {
      const panel = el("div", "vz-zole-panel");
      const h = el("div", "vz-zole-panel__h", "Likšana");
      panel.appendChild(h);
      const br = zole.bidRound === 2 ? 2 : 1;
      const hint = el(
        "div",
        "vz-zole-panel__hint",
        br === 1
          ? "1. kārta — Lielais, Zole, Mazā zole vai garām."
          : "2. kārta — tās pašas iespējas. Ja visi garām → Galdiņš."
      );
      panel.appendChild(hint);
      const row = el("div", "vz-zole-actions");
      const isMyBid = (zole.bidTurn ?? 0) === myIdx;
      if (isMyBid && onBid) {
        const bids = [
          { key: "pass", label: "Garām", primary: false },
          { key: "big", label: "Lielais", primary: true },
          { key: "zole", label: "Zole", primary: true },
          { key: "maza_zole", label: "Mazā zole", primary: true },
        ];
        for (const b of bids) {
          const btn = el("button", "vz-zole-btn", b.label);
          btn.type = "button";
          if (b.primary) btn.classList.add("vz-zole-btn--primary");
          btn.addEventListener("click", () => onBid(b.key));
          row.appendChild(btn);
        }
      } else {
        const wait = el(
          "div",
          "vz-zole-panel__wait",
          zm === "vs_bot" && !isMyBid
            ? "Gaida bota likšanu…"
            : "Gaida citu spēlētāju likšanu…"
        );
        panel.appendChild(wait);
      }
      if (row.childNodes.length) panel.appendChild(row);
      root.appendChild(panel);
    }

    /* Norakšana */
    if (phase === "discard" && zole.contract === "big") {
      const isContractor = myIdx === zole.contractorIdx;
      const panel = el("div", "vz-zole-panel");
      panel.appendChild(el("div", "vz-zole-panel__h", "Norakšana"));
      panel.appendChild(
        el(
          "div",
          "vz-zole-panel__hint",
          isContractor
            ? "Izvēlies divas kārtas zemāk, tad spied «Norakt»."
            : "Lielais izvēlas 2 kārtas, ko norakt."
        )
      );
      const selected = [];
      const hand = sortHand(zole.myHand || []);
      const confirmBtn = el("button", "vz-zole-btn vz-zole-btn--accent", "Norakt");
      confirmBtn.type = "button";
      confirmBtn.disabled = true;

      function syncDiscardBtn() {
        confirmBtn.disabled = selected.length !== 2 || !onDiscard;
      }

      const handRow = el("div", "vz-zole-hand");
      for (const card of hand) {
        const wrap = el("button", "vz-zole-hand__card");
        wrap.type = "button";
        wrap.appendChild(createCardFace(card, { small: true }));
        if (isZoleTrumpCard(card)) wrap.classList.add("vz-zole-hand__card--trump");
        if (!isContractor || !onDiscard) {
          wrap.disabled = true;
        } else {
          wrap.addEventListener("click", () => {
            const k = cardKey(card);
            const ix = selected.findIndex((c) => cardKey(c) === k);
            if (ix >= 0) {
              selected.splice(ix, 1);
              wrap.classList.remove("vz-zole-hand__card--sel");
            } else if (selected.length < 2) {
              selected.push(card);
              wrap.classList.add("vz-zole-hand__card--sel");
            }
            syncDiscardBtn();
          });
        }
        handRow.appendChild(wrap);
      }
      panel.appendChild(handRow);
      const ar = el("div", "vz-zole-actions");
      if (isContractor && onDiscard) {
        confirmBtn.addEventListener("click", () => {
          if (selected.length !== 2) return;
          onDiscard(selected.slice());
        });
      }
      ar.appendChild(confirmBtn);
      panel.appendChild(ar);
      root.appendChild(panel);
    }

    /* Roka — izspēle */
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
      const panel = el("div", "vz-zole-panel vz-zole-panel--hand");
      panel.appendChild(
        el(
          "div",
          "vz-zole-panel__h",
          isMyTurn ? "Tava kārta — izvēlies kārti" : "Tava roka"
        )
      );
      if (!isMyTurn) {
        panel.appendChild(
          el(
            "div",
            "vz-zole-panel__hint",
            zm === "vs_bot"
              ? "Gaida bota vai citu spēlētāju gājienu…"
              : "Gaida citu spēlētāju gājienu…"
          )
        );
      } else {
        panel.appendChild(
          el(
            "div",
            "vz-zole-panel__hint",
            "Pelēkās kārtis šajā brīdī nav atļautas (sekšana). Zelta rāmītis = trumpis."
          )
        );
      }
      const handRow = el("div", "vz-zole-hand vz-zole-hand--fan");
      for (const card of sortHand(zole.myHand || [])) {
        const k = cardKey(card);
        const can = isMyTurn && (!legalSet || legalSet.has(k));
        const wrap = el("button", "vz-zole-hand__card");
        wrap.type = "button";
        wrap.appendChild(createCardFace(card, { small: true }));
        if (isZoleTrumpCard(card)) wrap.classList.add("vz-zole-hand__card--trump");
        wrap.disabled = !can;
        if (can) wrap.addEventListener("click", () => onPlayCard(card));
        handRow.appendChild(wrap);
      }
      panel.appendChild(handRow);
      root.appendChild(panel);
    }

    /* Beigas */
    if (phase === "end") {
      const panel = el("div", "vz-zole-panel vz-zole-panel--end");
      const mh = zole.matchHandsPlayed ?? 0;
      panel.appendChild(
        el(
          "div",
          "vz-zole-panel__h",
          zm === "vs_bot"
            ? `Partija beigusies (${mh})`
            : "Partija beigusies"
        )
      );
      if (zole.tableDelta) {
        const parts = [];
        for (let i = 0; i < 3; i++) {
          const n = zole.tableDelta[i];
          if (!n) continue;
          parts.push(`${zole.players?.[i] || "?"}: ${formatPts(n)}`);
        }
        panel.appendChild(
          el("div", "vz-zole-end__delta", parts.join(" · ") || "—")
        );
      }
      const story = lastResultText(zole);
      if (story) panel.appendChild(el("div", "vz-zole-end__story", story));
      if (zm === "vs_bot") {
        panel.appendChild(
          el(
            "div",
            "vz-zole-panel__hint",
            "Drīz sāksies nākamā partija; tabula uzkrājas."
          )
        );
      }
      root.appendChild(panel);
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
