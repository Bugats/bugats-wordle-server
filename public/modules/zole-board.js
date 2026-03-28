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
  const RANK_7 = 7;
  const RANK_8 = 8;
  const RANK_9 = 9;
  const RANK_10 = 10;
  const RANK_J = 11;
  const RANK_Q = 12;
  const RANK_K = 13;
  const RANK_A = 14;
  /** Kā lib/zole.js — D/J stipruma secība pēc masta */
  const TRUMP_FACE_ORDER = [0, 3, 2, 1];
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
    if (card.r === RANK_Q || card.r === RANK_J) return true;
    if (card.s === ZOLE_SUIT_KARAVS) return true;
    return false;
  }

  function trumpFaceStrength(suit) {
    const idx = TRUMP_FACE_ORDER.indexOf(suit);
    return idx >= 0 ? idx : 9;
  }

  /** Kā lib/zole.js zoleCardTrickStrength — kārtošanai */
  function zoleCardTrickStrength(card) {
    if (!card) return -1;
    if (card.r === RANK_Q) {
      return 4000 - trumpFaceStrength(card.s);
    }
    if (card.r === RANK_J) {
      return 3000 - trumpFaceStrength(card.s);
    }
    if (card.s === ZOLE_SUIT_KARAVS) {
      const karRank = [RANK_7, RANK_8, RANK_9, RANK_K, RANK_10, RANK_A].indexOf(
        card.r
      );
      return 2000 + (karRank >= 0 ? karRank : 0);
    }
    const plain = [RANK_9, RANK_K, RANK_10, RANK_A].indexOf(card.r);
    return plain >= 0 ? plain : 0;
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

  /**
   * Kā lib/zole.js sortZoleHand: ♣ ♠ ♥ parastās stiprākās pa kreisi (A→10→K→9), trumpji dilstoši.
   */
  function sortHand(hand) {
    if (!hand || !hand.length) return [];
    const PLAIN_SUIT_ORDER = [0, 3, 2];
    function plainSuitKey(s) {
      const i = PLAIN_SUIT_ORDER.indexOf(s);
      return i >= 0 ? i : 99;
    }
    function plainRankKeyStrongLeft(r) {
      const order = [RANK_A, RANK_10, RANK_K, RANK_9];
      const i = order.indexOf(r);
      return i >= 0 ? i : 99;
    }
    return hand.slice().sort((a, b) => {
      const ta = isZoleTrumpCard(a);
      const tb = isZoleTrumpCard(b);
      if (ta !== tb) return ta ? 1 : -1;
      if (!ta) {
        const ds = plainSuitKey(a.s) - plainSuitKey(b.s);
        if (ds !== 0) return ds;
        return plainRankKeyStrongLeft(a.r) - plainRankKeyStrongLeft(b.r);
      }
      return zoleCardTrickStrength(b) - zoleCardTrickStrength(a);
    });
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

  /** Īss spēlētāja lomas teksts visām UI vietām. */
  function zolePlayerRoleLine(zole, pi) {
    const ph = zole.phase || "";
    const c = zole.contract;
    const ci = zole.contractorIdx;
    if (ph === "bid") return "";
    function roleAfterBid() {
      if (c === "galdins" || c === "galds") return contractLabel(c);
      if (typeof ci !== "number" || ci < 0 || c == null)
        return c ? contractLabel(c) : "";
      if (pi === ci) {
        if (c === "big") return "Lielais";
        if (c === "zole") return "Zole";
        if (c === "maza_zole") return "Mazā zole";
        return contractLabel(c);
      }
      return "Mazais";
    }
    if (ph === "discard" && c === "big" && typeof ci === "number") {
      return pi === ci ? "Lielais · norok" : "Mazais · gaida";
    }
    if (ph === "end" || ph === "play") return roleAfterBid();
    if (ph === "discard") return roleAfterBid();
    return "";
  }

  function zoleTrickLeadHint(zole, myIdx) {
    const ph = zole.phase || "";
    if (ph !== "play") return "";
    const tl = zole.trickLeader;
    if (typeof tl !== "number" || tl < 0 || tl > 2) return "";
    const nm = zole.players?.[tl] || "?";
    return tl === myIdx ? "Tu vadi šo stiķi." : `Stiķi vada ${nm}.`;
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

  /** Skaidra rindiņa: kurš gājiens / kas notiek. */
  function zoleTurnBannerText(zole, myIdx) {
    const ph = zole.phase || "";
    const names = zole.players || ["?", "?", "?"];
    if (ph === "bid") {
      const bt = zole.bidTurn;
      if (typeof bt !== "number" || bt < 0 || bt > 2) return "";
      if (bt === myIdx) {
        return "Tava likšana — izvēlies spēli vai «Garām».";
      }
      return `Gaida: ${names[bt] || "?"} likā.`;
    }
    if (ph === "discard" && zole.contract === "big") {
      const c = zole.contractorIdx;
      if (typeof c !== "number" || c < 0 || c > 2) return "";
      if (c === myIdx) {
        return "Tavs gājiens — norok 2 kārtas un spied «Norakt».";
      }
      return `Gaida: ${names[c] || "?"} norok kārtas.`;
    }
    if (ph === "play") {
      const t = zole.turn;
      if (typeof t !== "number" || t < 0 || t > 2) return "";
      const lead = zoleTrickLeadHint(zole, myIdx);
      const leadS = lead ? ` ${lead}` : "";
      if (t === myIdx) {
        return `Izvēlies kārtu no rokas.${leadS}`;
      }
      return `Gaida: ${names[t] || "?"} met kārti.${leadS}`;
    }
    if (ph === "end" && zole.zoleLastMatchHand) {
      return "Pēdējā partija šajā mačā — pēc tās atgriežamies pie vārdu spēles.";
    }
    return "";
  }

  function buildTurnBanner(zole, myIdx) {
    const text = zoleTurnBannerText(zole, myIdx);
    if (!text) return null;
    const bar = el("div", "vz-zole-turn-banner");
    bar.setAttribute("role", "status");
    bar.setAttribute("aria-live", "polite");
    bar.textContent = text;
    return bar;
  }

  function formatPts(n) {
    if (n == null || n === "") return "—";
    const v = Number(n);
    if (!Number.isFinite(v)) return String(n);
    if (v > 0) return `+${v}`;
    return String(v);
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
    const noTrumpGlow = !!o.noTrumpGlow;
    const meta = SUIT_META[card.s] || SUIT_META[0];
    const rank = RANK_LABELS[card.r] || String(card.r);
    const trump = isZoleTrumpCard(card);

    const root = el("div", "vz-zole-card");
    if (small) root.classList.add("vz-zole-card--sm");
    else if (hand) root.classList.add("vz-zole-card--hand");
    else if (o.trick) root.classList.add("vz-zole-card--trick");
    if (meta.red) root.classList.add("vz-zole-card--red");
    else root.classList.add("vz-zole-card--black");
    if (trump && !noTrumpGlow) root.classList.add("vz-zole-card--trump");

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
    const showEyes = showPart;
    const table = el("table", "vz-zole-pt__table");
    const thead = el("thead");
    const hr = el("tr");
    const heads = showPart
      ? ["", "P.", "K.", "A", "S"]
      : ["", "K.", "S"];
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
      if (showEyes) {
        tr.appendChild(el("td", "vz-zole-pt__num", String(eyes[i] ?? 0)));
      }
      tr.appendChild(el("td", "vz-zole-pt__num", String(tricks[i] ?? 0)));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  /**
   * Pretinieku «profila» stūri — absolūti pret filcu; img+initials sinhronizē game.js (applyMiniAvatar).
   */
  function buildOpponentCorner(zole, pi, activePi, cornerCls) {
    const corner = el("div", `vz-zole-opp-corner ${cornerCls || ""}`);
    if (activePi === pi) corner.classList.add("vz-zole-opp-corner--turn");
    const un = String(zole.players?.[pi] || "?").trim();
    corner.dataset.zolePlayer = un;
    const avWrap = el("div", "vz-zole-opp__avatar-wrap");
    const img = document.createElement("img");
    img.className = "vz-zole-opp__avatar-img";
    img.alt = "";
    img.decoding = "async";
    const initials = el("span", "vz-zole-opp__avatar-initials");
    initials.textContent = un ? un.charAt(0).toUpperCase() : "?";
    avWrap.appendChild(img);
    avWrap.appendChild(initials);
    corner.appendChild(avWrap);
    const nm = el("div", "vz-zole-opp__tag", un || "?");
    corner.appendChild(nm);
    const rl = zolePlayerRoleLine(zole, pi);
    if (rl) corner.appendChild(el("div", "vz-zole-opp__role", rl));
    if (activePi === pi) {
      corner.appendChild(el("div", "vz-zole-opp__badge vz-zole-opp__badge--corner", "Kārta"));
    }
    return corner;
  }

  function buildOpponentsLayer(zole, myIdx) {
    const layer = el("div", "vz-zole-classic__opps-layer");
    layer.setAttribute("aria-hidden", "true");
    const active = zoleActiveTurnPlayerIndex(zole);
    const leftPi = (myIdx + 1) % 3;
    const rightPi = (myIdx + 2) % 3;
    layer.appendChild(
      buildOpponentCorner(zole, leftPi, active, "vz-zole-opp-corner--tl")
    );
    layer.appendChild(
      buildOpponentCorner(zole, rightPi, active, "vz-zole-opp-corner--tr")
    );
    return layer;
  }

  /** Kopējie mača punkti (tabula) — kompakti pa vidu zem pretiniekiem. */
  function buildMatchScoreStrip(zole, myIdx) {
    const wrap = el("div", "vz-zole-classic__match");
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", "Mača rezultāts");
    wrap.appendChild(el("div", "vz-zole-match__title", "Mača rezultāts"));
    const row = el("div", "vz-zole-match__row");
    const cum = zole.cumulativeTableDelta || [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const cell = el("div", "vz-zole-match__cell");
      if (i === myIdx) cell.classList.add("vz-zole-match__cell--me");
      const nm = el(
        "span",
        "vz-zole-match__name",
        zole.players?.[i] || "?"
      );
      const pts = el(
        "span",
        "vz-zole-match__pts",
        formatPts(cum[i] ?? 0)
      );
      cell.appendChild(nm);
      cell.appendChild(pts);
      row.appendChild(cell);
    }
    wrap.appendChild(row);
    return wrap;
  }

  function buildTrickCenter(zole, myIdx) {
    const phase = zole.phase || "";
    const wrap = el("div", "vz-zole-classic__trickWrap");
    if (phase !== "play") {
      const sp = el("div", "vz-zole-classic__trickSpacer");
      sp.classList.add("vz-zole-classic__trickSpacer--tight");
      wrap.appendChild(sp);
      return wrap;
    }

    wrap.appendChild(el("div", "vz-zole-felt__title", "Galds"));

    const trick = zole.trick || [];
    const lc = zole.lastCompletedTrick;
    const frozen = trick.length === 0 && lc && lc.cards?.length === 3;
    const byP = trickCardByPlayer(zole);
    const turnSeat =
      !frozen && typeof zole.turn === "number" ? zole.turn : null;

    /* Vietas uz ekrāna kā pretinieku rinda: kreisais → tu → labais */
    const leftPi = (myIdx + 1) % 3;
    const rightPi = (myIdx + 2) % 3;
    const visualOrder = [leftPi, myIdx, rightPi];

    const row = el("div", "vz-zole-felt__trick");
    for (const seat of visualOrder) {
      const col = el("div", "vz-zole-felt__seat");
      if (seat === leftPi) col.classList.add("vz-zole-felt__seat--left");
      if (seat === rightPi) col.classList.add("vz-zole-felt__seat--right");
      if (seat === myIdx) col.classList.add("vz-zole-felt__seat--me");
      if (turnSeat === seat) col.classList.add("vz-zole-felt__seat--turn");
      if (frozen) col.classList.add("vz-zole-felt__seat--frozen");

      const head = el("div", "vz-zole-felt__who");
      head.textContent = zole.players?.[seat] || "?";
      col.appendChild(head);
      const rl = zolePlayerRoleLine(zole, seat);
      if (rl) col.appendChild(el("div", "vz-zole-felt__role", rl));

      const cardSlot = el("div", "vz-zole-felt__cardSlot");
      const c = byP[seat];
      if (c) {
        cardSlot.appendChild(createCardFace(c, { trick: true }));
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
      const t = typeof zole.turn === "number" ? zole.turn : null;
      if (t != null) {
        const nm = zole.players?.[t] || "?";
        sub.textContent = t === myIdx ? "" : `Gaida: ${nm}.`;
      } else {
        sub.textContent = "\u00a0";
      }
    } else if (frozen && lc) {
      const wn = zole.players?.[lc.winnerIdx] || "?";
      const nextL =
        typeof zole.trickLeader === "number" ? zole.trickLeader : null;
      const nextN =
        nextL != null ? zole.players?.[nextL] || "?" : "";
      sub.textContent =
        nextN && nextL === myIdx
          ? `${wn} ņēma stiķi. Tu vadi — met pirmo kārti.`
          : nextN
            ? `${wn} ņēma stiķi. Nākamais stiķis — vada ${nextN}.`
            : `${wn} ņēma stiķi.`;
    } else {
      const tl =
        typeof zole.trickLeader === "number" ? zole.trickLeader : null;
      if (tl != null) {
        const nm = zole.players?.[tl] || "?";
        sub.textContent =
          tl === myIdx
            ? "Tu vadi šo stiķi — met pirmo kārti."
            : `Vada ${nm} — gaida pirmo kārti.`;
      } else {
        sub.textContent = "\u00a0";
      }
    }
    wrap.appendChild(sub);
    return wrap;
  }

  function buildBidCenter(zole, myIdx, onBid, _zm) {
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
      const bt = zole.bidTurn;
      const nm =
        typeof bt === "number" ? zole.players?.[bt] || "?" : "?";
      const wait = el(
        "div",
        "vz-zole-bid-wait",
        `Gaida: ${nm} likā`
      );
      stack.appendChild(wait);
    }
    center.appendChild(stack);
    return center;
  }

  /**
   * Norakšana: pilna instrukcija ir zilajā joslā — centrā tikai gaidīšanas teksts.
   */
  function buildDiscardCenter(isContractor, waitingName) {
    if (isContractor) return null;
    const c = el("div", "vz-zole-classic__msg");
    c.textContent = `Gaida: ${waitingName || "?"} norok kārtas.`;
    return c;
  }

  function buildEndCenter(zole, zm) {
    const c = el("div", "vz-zole-classic__msg");
    const mh = zole.matchHandsPlayed ?? 0;
    c.textContent =
      zm === "vs_bot" ? `Beigas · #${mh}` : "Beigas";
    return c;
  }

  const ZOLE_HAND_DESIGN_W = 108;
  const ZOLE_HAND_DESIGN_H = 168;
  const ZOLE_HAND_MIN_SCALE = 0.28;

  function fitZoleHandOverlap(dock) {
    const row = dock.querySelector(".vz-zole-hand--overlap");
    if (!row) return;
    const cards = row.querySelectorAll(".vz-zole-hand__card");
    const n = cards.length;
    if (n <= 1) {
      dock.style.setProperty("--vz-hand-scale", "1");
      return;
    }

    /**
     * Platums = n*cardW − (n−1)*pull. Maks. pārklājums: maxPull = cardW − minVisible.
     * Mērogam s der, ja ar kādu pull ∈ [0, maxPull] var sasniegt platums ≤ bdg:
     * tas ir tad, ja pullNeed = ceil((natural−bdg)/(n−1)) ≤ maxPull.
     */
    function fitsAtScale(s, bdg) {
      const cardW = ZOLE_HAND_DESIGN_W * s;
      const minVisible = Math.max(12, Math.round(cardW * 0.16));
      const maxPull = Math.max(0, cardW - minVisible);
      const natural = n * cardW;
      const pullNeed =
        natural > bdg + 0.5
          ? Math.ceil((natural - bdg) / (n - 1))
          : 0;
      return pullNeed <= maxPull + 0.01;
    }

    function pullForScale(s, bdg) {
      const cardW = ZOLE_HAND_DESIGN_W * s;
      const minVisible = Math.max(12, Math.round(cardW * 0.16));
      const maxPull = Math.max(0, cardW - minVisible);
      const natural = n * cardW;
      const pullNeed =
        natural > bdg + 0.5
          ? Math.ceil((natural - bdg) / (n - 1))
          : 0;
      let pullDecor = 0;
      if (n >= 4 && natural <= bdg + 0.5) {
        pullDecor = Math.round(cardW * (n >= 8 ? 0.5 : 0.4));
      }
      return Math.min(maxPull, Math.max(pullNeed, pullDecor));
    }

    function applyLayout(s, pull) {
      dock.style.setProperty("--vz-hand-scale", String(s));
      for (let i = 1; i < n; i++) {
        cards[i].style.marginLeft = pull > 0 ? `-${pull}px` : "";
      }
    }

    const measure = () => {
      const felt = dock.closest(".vz-zole-classic__felt");
      const classic = dock.closest(".vz-zole--classic");
      const rowEl = row;
      const raw =
        (dock.clientWidth > 48 ? dock.clientWidth : 0) ||
        (felt && felt.clientWidth) ||
        320;
      const budget = Math.max(120, raw - 24);

      let lo = ZOLE_HAND_MIN_SCALE;
      let hi = 1;
      for (let iter = 0; iter < 22; iter++) {
        const mid = (lo + hi) / 2;
        if (fitsAtScale(mid, budget)) lo = mid;
        else hi = mid;
      }
      let s = lo;
      let pull = pullForScale(s, budget);
      applyLayout(s, pull);

      /* Flex «gap» bija pievienojis platumu ārpus JS modeļa — tagad gap:0; šis noķer noapaļošanu */
      for (let fix = 0; fix < 20 && rowEl.scrollWidth > dock.clientWidth + 2; fix++) {
        s = Math.max(ZOLE_HAND_MIN_SCALE, s * 0.965);
        pull = pullForScale(s, budget);
        applyLayout(s, pull);
      }

      /* .vz-zole--classic ir overflow:hidden — ja doka apakša iziet ārpus, samazinām mērogu */
      if (classic) {
        for (let v = 0; v < 18; v++) {
          const cr = classic.getBoundingClientRect();
          const dr = dock.getBoundingClientRect();
          if (dr.bottom <= cr.bottom - 1) break;
          const next = Math.max(ZOLE_HAND_MIN_SCALE, s * 0.94);
          if (next >= s - 1e-6) break;
          s = next;
          pull = pullForScale(s, budget);
          applyLayout(s, pull);
        }
      }
    };

    measure();
    global.requestAnimationFrame(() => {
      measure();
      global.requestAnimationFrame(measure);
    });
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => measure());
      ro.observe(dock);
      const felt = dock.closest(".vz-zole-classic__felt");
      if (felt) ro.observe(felt);
    }
  }

  function buildHandDock(zole, opts) {
    const o = opts || {};
    const hand = sortHand(zole.myHand || []);
    if (!hand.length) return null;
    const dock = el("div", "vz-zole-classic__dock");
    const row = el("div", "vz-zole-hand vz-zole-hand--overlap");
    const mode = o.mode || "readonly";

    if (typeof o.myIdx === "number") {
      const dr = zolePlayerRoleLine(zole, o.myIdx);
      if (dr) dock.appendChild(el("div", "vz-zole-dock__role", dr));
    }

    for (let hi = 0; hi < hand.length; hi++) {
      const card = hand[hi];
      const k = cardKey(card);
      let wrap;
      const faceOpts = {
        hand: true,
        noTrumpGlow: mode === "discard",
      };
      if (mode === "readonly") {
        wrap = el("div", "vz-zole-hand__card vz-zole-hand__card--static");
        wrap.appendChild(createCardFace(card, faceOpts));
      } else {
        wrap = el("button", "vz-zole-hand__card");
        wrap.type = "button";
        wrap.appendChild(createCardFace(card, faceOpts));
        if (mode === "play") {
          const can =
            o.isMyTurn && (!o.legalSet || o.legalSet.has(k));
          wrap.disabled = !can;
          if (!can && o.isMyTurn) {
            wrap.classList.add("vz-zole-hand__card--illegal");
          }
          if (can) wrap.addEventListener("click", () => o.onPlayCard(card));
        } else if (mode === "discard") {
          if (!o.isContractor || !o.onToggle) {
            wrap.disabled = true;
          } else {
            wrap.addEventListener("click", () => o.onToggle(card, wrap));
          }
        }
      }
      if (mode !== "discard" && isZoleTrumpCard(card)) {
        wrap.classList.add("vz-zole-hand__card--trump");
      }
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
      const li = lr.loserIdx;
      const le =
        Array.isArray(lr.eyes) && li != null ? lr.eyes[li] : null;
      const ac = le != null ? ` (${le} acis)` : "";
      return `Galdiņš: zaudē ${zole.players?.[li] || "?"}${ac}, maksā katram uzvarētājam ${lr.payEach} p.${bs}`;
    }
    if (lr.kind === "galds") {
      const bs =
        lr.loserNoTricks === true ? " Bezstiķis — maksā pa 3 p." : "";
      const li = lr.loserIdx;
      const le =
        Array.isArray(lr.eyes) && li != null ? lr.eyes[li] : null;
      const ac = le != null ? ` (${le} acis)` : "";
      return `Galds: zaudē ${zole.players?.[li] || "?"}${ac}, maksā katram ${lr.payEach} p.${bs}`;
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

  /** Partijas beigās: kurš savācis visvairāk acu (pēc stiķiem). */
  function endEyesWinnerLine(zole) {
    const eyes = zole.eyePoints;
    if (!eyes || eyes.length !== 3) return "";
    let best = 0;
    for (let i = 1; i < 3; i++) {
      if ((eyes[i] ?? 0) > (eyes[best] ?? 0)) best = i;
    }
    const e = eyes[best] ?? 0;
    const nm = zole.players?.[best] || "?";
    return `${nm} visvairāk acu šajā izspēlē: ${e}`;
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
    const turnBanner = buildTurnBanner(zole, myIdx);
    if (turnBanner) root.appendChild(turnBanner);

    const felt = el("div", "vz-zole-classic__felt vz-zole-classic__felt--table");
    felt.appendChild(buildOpponentsLayer(zole, myIdx));

    const feltCenter = el("div", "vz-zole-classic__felt-center");
    if (phase === "end") {
      feltCenter.classList.add("vz-zole-classic__felt-center--end");
    }

    if (phase === "bid") {
      feltCenter.appendChild(buildBidCenter(zole, myIdx, onBid, zm));
    } else if (phase === "discard" && zole.contract === "big") {
      const cidx = zole.contractorIdx;
      const waitNm =
        typeof cidx === "number" ? zole.players?.[cidx] || "?" : "?";
      const discardMsg = buildDiscardCenter(
        myIdx === zole.contractorIdx,
        waitNm
      );
      if (discardMsg) feltCenter.appendChild(discardMsg);
    } else if (phase === "end") {
      const endBox = el("div", "vz-zole-classic__end");
      const endMain = el("div", "vz-zole-end__main");
      endMain.appendChild(buildMatchScoreStrip(zole, myIdx));
      endMain.appendChild(buildEndCenter(zole, zm));
      if (zole.tableDelta) {
        const parts = [];
        for (let i = 0; i < 3; i++) {
          const n = zole.tableDelta[i];
          if (!n) continue;
          parts.push(`${zole.players?.[i] || "?"}: ${formatPts(n)}`);
        }
        endMain.appendChild(
          el("div", "vz-zole-end__delta", parts.join(" · ") || "—")
        );
      }
      const story = lastResultText(zole);
      if (story) endMain.appendChild(el("div", "vz-zole-end__story", story));
      const eyesLine = endEyesWinnerLine(zole);
      if (eyesLine) {
        endMain.appendChild(el("div", "vz-zole-end__eyes", eyesLine));
      }
      endBox.appendChild(endMain);
      const vsEnd =
        opts &&
        zm === "vs_bot" &&
        opts.vsBotEndPending &&
        typeof opts.onZoleVsBotLastHand === "function" &&
        typeof opts.onZoleVsBotNextHand === "function";
      if (vsEnd) {
        const row = el("div", "vz-zole-end__vs-actions");
        const lastBtn = el(
          "button",
          "vz-zole-end-btn vz-zole-end-btn--secondary",
          "Pēdējā partija"
        );
        lastBtn.type = "button";
        lastBtn.title =
          "Pēdējā partija: citi redzēs atzīmi tiešsaistē; pēc partijas mačs beigsies un atgriezīsies pie vārdu spēles.";
        lastBtn.addEventListener("click", () => opts.onZoleVsBotLastHand());
        const nextBtn = el(
          "button",
          "vz-zole-end-btn vz-zole-end-btn--primary",
          "Nākamā partija"
        );
        nextBtn.type = "button";
        nextBtn.addEventListener("click", () => opts.onZoleVsBotNextHand());
        row.appendChild(lastBtn);
        row.appendChild(nextBtn);
        endBox.appendChild(row);
      }
      feltCenter.appendChild(endBox);
    } else {
      feltCenter.appendChild(buildTrickCenter(zole, myIdx));
    }
    felt.appendChild(feltCenter);

    let dock = null;
    if (phase === "bid") {
      dock = buildHandDock(zole, { mode: "readonly", myIdx });
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
        myIdx,
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
        myIdx,
        isMyTurn,
        legalSet,
        onPlayCard,
      });
    }
    if (dock) {
      if (phase === "play" && isMyTurn) {
        dock.classList.add("vz-zole-classic__dock--my-turn");
      }
      felt.appendChild(dock);
    }

    root.appendChild(felt);

    const woodBot = el("div", "vz-zole-wood vz-zole-wood--bot");
    const detFoot = el("details", "vz-zole-foot-details");
    const sumFoot = el("summary", "vz-zole-foot-details__sum", "Punkti · noteikumi");
    const innerFoot = el("div", "vz-zole-foot-details__body");
    innerFoot.appendChild(buildPointsTable(zole, myIdx));
    const noteShort = zole.trumpNoteShort;
    const noteDetail = zole.trumpNoteDetail || zole.trumpNote;
    if (noteShort || noteDetail) {
      const wrap = el("div", "vz-zole-foot-trump");
      if (noteShort) {
        wrap.appendChild(
          el("p", "vz-zole-foot-note vz-zole-foot-note--short", noteShort)
        );
      }
      if (noteDetail && noteDetail !== noteShort) {
        const more = el("details", "vz-zole-foot-trump__more");
        const sumMore = el(
          "summary",
          "vz-zole-foot-trump__sum",
          noteShort
            ? "Pilnāka instrukcija (sekšana, komanda…)"
            : "Trumpji un sekšana (pilni)"
        );
        const bodyMore = el("div", "vz-zole-foot-trump__body");
        bodyMore.appendChild(
          el("p", "vz-zole-foot-note vz-zole-foot-note--detail", noteDetail)
        );
        more.appendChild(sumMore);
        more.appendChild(bodyMore);
        wrap.appendChild(more);
      }
      innerFoot.appendChild(wrap);
    }
    detFoot.appendChild(sumFoot);
    detFoot.appendChild(innerFoot);
    woodBot.appendChild(detFoot);
    root.appendChild(woodBot);

    container.appendChild(root);
  }

  function syncOpponentAvatars(container, applyMiniAvatar) {
    if (!container || typeof applyMiniAvatar !== "function") return;
    const nodes = container.querySelectorAll(
      ".vz-zole-opp-corner[data-zole-player]"
    );
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const u = n.getAttribute("data-zole-player");
      if (!u) continue;
      const img = n.querySelector(".vz-zole-opp__avatar-img");
      const ini = n.querySelector(".vz-zole-opp__avatar-initials");
      if (img && ini) applyMiniAvatar(u, img, ini);
    }
  }

  global.VZZoleBoard = Object.freeze({
    renderZoleBoard,
    syncOpponentAvatars,
    cardLabel,
    cardKey,
    isZoleTrumpCard,
  });
})(window);
