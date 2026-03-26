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
    const hand = !!o.hand;
    const meta = SUIT_META[card.s] || SUIT_META[0];
    const rank = RANK_LABELS[card.r] || String(card.r);
    const trump = isZoleTrumpCard(card);

    const root = el("div", "vz-zole-card");
    if (small) root.classList.add("vz-zole-card--sm");
    else if (hand) root.classList.add("vz-zole-card--hand");
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
    const ph = zole.phase || "";
    const showPart = ph === "end";
    const table = el("table", "vz-zole-pt__table");
    const thead = el("thead");
    const hr = el("tr");
    const heads = showPart
      ? ["", "P.", "K.", "A", "S"]
      : ["", "K.", "A", "S"];
    for (const h of heads) {
      hr.appendChild(el("th", null, h));
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el("tbody");
    const eyes = zole.eyePoints || [0, 0, 0];
    const tricks = zole.tricksWon || [0, 0, 0];
    const tdArr = zole.tableDelta || [0, 0, 0];
    const cum = zole.cumulativeTableDelta || [0, 0, 0];
    const activePi = zoleActiveTurnPlayerIndex(zole);

    for (let i = 0; i < 3; i++) {
      const tr = el("tr");
      if (i === myIdx) tr.classList.add("vz-zole-pt__me");
      if (activePi === i) tr.classList.add("vz-zole-pt__active");
      const nameCell = el("td", "vz-zole-pt__name");
      const nm = el("span", "vz-zole-pt__player", zole.players?.[i] || "?");
      nameCell.appendChild(nm);
      tr.appendChild(nameCell);
      if (showPart) {
        tr.appendChild(
          el("td", "vz-zole-pt__num", formatPts(tdArr[i]))
        );
      }
      tr.appendChild(el("td", "vz-zole-pt__num", formatPts(cum[i])));
      tr.appendChild(el("td", "vz-zole-pt__num", String(eyes[i] ?? 0)));
      tr.appendChild(el("td", "vz-zole-pt__num", String(tricks[i] ?? 0)));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function createDeckBackMini() {
    const d = el("div", "vz-zole-deck-mini");
    d.setAttribute("aria-hidden", "true");
    return d;
  }

  function buildOpponentCorner(zole, pi, activePi) {
    const corner = el("div", "vz-zole-opp");
    if (activePi === pi) corner.classList.add("vz-zole-opp--turn");
    const nm = el("div", "vz-zole-opp__name", zole.players?.[pi] || "?");
    corner.appendChild(nm);
    corner.appendChild(createDeckBackMini());
    const av = el("div", "vz-zole-opp__avatar");
    const un = String(zole.players?.[pi] || "?").trim();
    av.textContent = un ? un.charAt(0).toUpperCase() : "?";
    corner.appendChild(av);
    return corner;
  }

  function buildOpponentsRow(zole, myIdx) {
    const row = el("div", "vz-zole-classic__opps");
    const active = zoleActiveTurnPlayerIndex(zole);
    const leftPi = (myIdx + 1) % 3;
    const rightPi = (myIdx + 2) % 3;
    row.appendChild(buildOpponentCorner(zole, leftPi, active));
    row.appendChild(buildOpponentCorner(zole, rightPi, active));
    return row;
  }

  function buildTrickCenter(zole) {
    const phase = zole.phase || "";
    const wrap = el("div", "vz-zole-classic__trickWrap");
    if (phase !== "play") {
      wrap.appendChild(el("div", "vz-zole-classic__trickSpacer"));
      return wrap;
    }

    wrap.appendChild(el("div", "vz-zole-felt__title", "Galds"));

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
          !frozen && turnSeat === seat ? "…" : frozen ? "" : "…";
        cardSlot.appendChild(ph);
      }
      col.appendChild(cardSlot);
      row.appendChild(col);
    }
    wrap.appendChild(row);

    const sub = el("div", "vz-zole-felt__sub");
    if (trick.length > 0) {
      sub.textContent = `${zole.currentTrickEyes ?? 0} acis`;
    } else if (frozen && lc) {
      const wn = zole.players?.[lc.winnerIdx] || "?";
      sub.textContent = `${wn} · ${lc.trickEyes ?? 0}`;
    } else {
      sub.textContent = "\u00a0";
    }
    wrap.appendChild(sub);
    return wrap;
  }

  function buildBidCenter(zole, myIdx, onBid, zm) {
    const center = el("div", "vz-zole-classic__bidCenter");
    const isMyBid = (zole.bidTurn ?? 0) === myIdx;
    const stack = el("div", "vz-zole-bid-stack");
    if (isMyBid && onBid) {
      const bids = [
        { key: "maza_zole", label: "Mazā zole" },
        { key: "zole", label: "Zole" },
        { key: "big", label: "Lielais" },
        { key: "pass", label: "Garām" },
      ];
      for (const b of bids) {
        const btn = el("button", "vz-zole-bid-tile", b.label);
        btn.type = "button";
        btn.addEventListener("click", () => onBid(b.key));
        stack.appendChild(btn);
      }
    } else {
      const wait = el("div", "vz-zole-bid-wait", zm === "vs_bot" ? "Gaida…" : "Gaida…");
      stack.appendChild(wait);
    }
    center.appendChild(stack);
    return center;
  }

  function buildDiscardCenter(isContractor) {
    const c = el("div", "vz-zole-classic__msg");
    c.textContent = isContractor
      ? "Norok 2 kārtas"
      : "Gaida norakšanu…";
    return c;
  }

  function buildEndCenter(zole, zm) {
    const c = el("div", "vz-zole-classic__msg");
    const mh = zole.matchHandsPlayed ?? 0;
    c.textContent =
      zm === "vs_bot" ? `Beigas · #${mh}` : "Beigas";
    return c;
  }

  function fitZoleHandOverlap(dock) {
    const row = dock.querySelector(".vz-zole-hand--overlap");
    if (!row) return;
    const cards = row.querySelectorAll(".vz-zole-hand__card");
    const n = cards.length;
    if (n <= 1) return;
    const measure = () => {
      const rect0 = cards[0].getBoundingClientRect();
      const cardW = rect0.width > 4 ? rect0.width : 62;
      const felt = dock.closest(".vz-zole-classic__felt");
      const raw =
        (felt && felt.clientWidth) ||
        dock.clientWidth ||
        row.clientWidth ||
        320;
      const budget = Math.max(130, raw - 24);
      const natural = n * cardW;
      let pull = 0;
      if (natural > budget) {
        pull = Math.ceil((natural - budget) / (n - 1));
      } else if (n >= 8) {
        pull = Math.round(cardW * 0.18);
      }
      const maxPull = Math.max(12, cardW - 20);
      pull = Math.min(Math.max(0, pull), maxPull);
      for (let i = 1; i < n; i++) {
        cards[i].style.marginLeft = pull > 0 ? `-${pull}px` : "";
      }
    };
    measure();
    global.requestAnimationFrame(() => {
      measure();
      global.requestAnimationFrame(measure);
    });
    const felt = dock.closest(".vz-zole-classic__felt");
    if (felt && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => measure());
      ro.observe(felt);
    }
  }

  function buildHandDock(zole, opts) {
    const o = opts || {};
    const hand = sortHand(zole.myHand || []);
    if (!hand.length) return null;
    const dock = el("div", "vz-zole-classic__dock");
    const row = el("div", "vz-zole-hand vz-zole-hand--overlap");
    const mode = o.mode || "readonly";

    for (let hi = 0; hi < hand.length; hi++) {
      const card = hand[hi];
      const k = cardKey(card);
      let wrap;
      if (mode === "readonly") {
        wrap = el("div", "vz-zole-hand__card vz-zole-hand__card--static");
        wrap.appendChild(createCardFace(card, { hand: true }));
      } else {
        wrap = el("button", "vz-zole-hand__card");
        wrap.type = "button";
        wrap.appendChild(createCardFace(card, { hand: true }));
        if (mode === "play") {
          const can =
            o.isMyTurn && (!o.legalSet || o.legalSet.has(k));
          wrap.disabled = !can;
          if (can) wrap.addEventListener("click", () => o.onPlayCard(card));
        } else if (mode === "discard") {
          if (!o.isContractor || !o.onToggle) {
            wrap.disabled = true;
          } else {
            wrap.addEventListener("click", () => o.onToggle(card, wrap));
          }
        }
      }
      if (isZoleTrumpCard(card)) wrap.classList.add("vz-zole-hand__card--trump");
      wrap.style.zIndex = String(10 + hi);
      row.appendChild(wrap);
    }
    dock.appendChild(row);
    fitZoleHandOverlap(dock);
    return dock;
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
    const root = el("div", "vz-zole vz-zole--classic");

    const phase = zole.phase || "";

    const woodTop = el("div", "vz-zole-wood vz-zole-wood--top");
    woodTop.appendChild(el("span", "vz-zole-wood__brand", "ZOLE"));
    const metaTop = el("span", "vz-zole-wood__meta");
    if (phase === "play" || phase === "discard" || phase === "end") {
      metaTop.textContent = `${zole.trumpLabel || "—"}`;
      if (zole.contract && phase !== "bid") {
        let c = contractLabel(zole.contract);
        if (zole.contractorIdx != null && zole.players) {
          c += ` · ${zole.players[zole.contractorIdx] || "?"}`;
        }
        metaTop.textContent += ` · ${c}`;
      }
    } else {
      metaTop.textContent = "Likšana";
    }
    woodTop.appendChild(metaTop);
    root.appendChild(woodTop);

    const felt = el("div", "vz-zole-classic__felt");
    felt.appendChild(buildOpponentsRow(zole, myIdx));

    if (phase === "bid") {
      felt.appendChild(buildBidCenter(zole, myIdx, onBid, zm));
    } else if (phase === "discard" && zole.contract === "big") {
      felt.appendChild(
        buildDiscardCenter(myIdx === zole.contractorIdx)
      );
    } else if (phase === "end") {
      const endBox = el("div", "vz-zole-classic__end");
      endBox.appendChild(buildEndCenter(zole, zm));
      if (zole.tableDelta) {
        const parts = [];
        for (let i = 0; i < 3; i++) {
          const n = zole.tableDelta[i];
          if (!n) continue;
          parts.push(`${zole.players?.[i] || "?"}: ${formatPts(n)}`);
        }
        endBox.appendChild(
          el("div", "vz-zole-end__delta", parts.join(" · ") || "—")
        );
      }
      const story = lastResultText(zole);
      if (story) endBox.appendChild(el("div", "vz-zole-end__story", story));
      felt.appendChild(endBox);
    } else {
      felt.appendChild(buildTrickCenter(zole));
    }

    let dock = null;
    if (phase === "bid") {
      dock = buildHandDock(zole, { mode: "readonly" });
    } else if (phase === "discard" && zole.contract === "big") {
      const isContractor = myIdx === zole.contractorIdx;
      const selected = [];
      const confirmBtn = el(
        "button",
        "vz-zole-bid-tile vz-zole-bid-tile--narrow",
        "Norakt"
      );
      confirmBtn.type = "button";
      confirmBtn.disabled = true;
      function syncDiscardBtn() {
        confirmBtn.disabled = selected.length !== 2 || !onDiscard;
      }
      dock = buildHandDock(zole, {
        mode: "discard",
        isContractor,
        onToggle: (card, wrap) => {
          if (!onDiscard || !isContractor) return;
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
        },
      });
      if (dock && isContractor && onDiscard) {
        confirmBtn.addEventListener("click", () => {
          if (selected.length !== 2) return;
          onDiscard(selected.slice());
        });
        const bar = el("div", "vz-zole-classic__discardBar");
        bar.appendChild(confirmBtn);
        dock.appendChild(bar);
      }
    } else if (phase === "play") {
      let legalSet = null;
      if (isMyTurn) {
        if (global.VZZoleLegal) {
          const legal = global.VZZoleLegal.zoleLegalPlays(
            zole.myHand || [],
            zole.trick || []
          );
          legalSet = new Set(
            legal.map((c) => global.VZZoleLegal.zoleCardKey(c))
          );
        } else if (zole.legalCardKeys && zole.legalCardKeys.length) {
          legalSet = new Set(zole.legalCardKeys);
        }
      }
      dock = buildHandDock(zole, {
        mode: "play",
        isMyTurn,
        legalSet,
        onPlayCard,
      });
    }
    if (dock) felt.appendChild(dock);

    root.appendChild(felt);

    const woodBot = el("div", "vz-zole-wood vz-zole-wood--bot");
    const detFoot = el("details", "vz-zole-foot-details");
    const sumFoot = el("summary", "vz-zole-foot-details__sum", "Punkti · noteikumi");
    const innerFoot = el("div", "vz-zole-foot-details__body");
    innerFoot.appendChild(buildPointsTable(zole, myIdx));
    if (zole.trumpNote) {
      const p = el("p", "vz-zole-foot-note");
      p.textContent = zole.trumpNote;
      innerFoot.appendChild(p);
    }
    detFoot.appendChild(sumFoot);
    detFoot.appendChild(innerFoot);
    woodBot.appendChild(detFoot);
    root.appendChild(woodBot);

    container.appendChild(root);
  }

  global.VZZoleBoard = Object.freeze({
    renderZoleBoard,
    cardLabel,
    cardKey,
    isZoleTrumpCard,
  });
})(window);
