/**
 * Zole UI — acis, likšana (lielais / zole / mazā zole / galdiņš), tabulas punkti
 */
(function (global) {
  "use strict";

  /** Pēc pabeigta stiķa kārtis paliek uz galda, tad pazūd (ms). */
  const ZOLE_TRICK_HOLD_MS = 2400;
  let zoleTrickHoldTimer = null;
  let zoleTrickHoldSig = null;
  let zoleTrickHoldUntil = 0;
  let zoleTrickHoldCleared = false;

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
  }

  function scheduleZoleTrickHoldClear(scheduleRedraw) {
    if (typeof scheduleRedraw !== "function") return;
    zoleTrickHoldTimer = global.setTimeout(() => {
      zoleTrickHoldTimer = null;
      zoleTrickHoldCleared = true;
      scheduleRedraw();
    }, ZOLE_TRICK_HOLD_MS);
  }

  global.VZZoleBoardTrickHold = Object.freeze({
    reset: resetZoleTrickHold,
    /** Izsauc katru reizi, kad nāk jauns zole snapshot (pirms render). */
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
      const sig = zoleCompletedTrickSignature(zole);
      if (!sig) {
        resetZoleTrickHold();
        return;
      }
      if (sig !== zoleTrickHoldSig) {
        resetZoleTrickHold();
        zoleTrickHoldSig = sig;
        zoleTrickHoldUntil = Date.now() + ZOLE_TRICK_HOLD_MS;
        zoleTrickHoldCleared = false;
        scheduleZoleTrickHoldClear(scheduleRedraw);
      }
    },
  });

  function esc(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** ♦ kāravas — garš masts (atbilst lib/zole.js ZOLE_SUIT_KARAVS) */
  const ZOLE_SUIT_KARAVS = 1;

  /** Indeksi: 0 ♣ kreicis, 1 ♦ kāravs, 2 ♥ ercens, 3 ♠ pīķis */
  const SUIT_META = [
    { sym: "♣", red: false },
    { sym: "♦", red: true },
    { sym: "♥", red: true },
    { sym: "♠", red: false },
  ];

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
    if (
      card.s === ZOLE_SUIT_KARAVS &&
      card.r !== 12 &&
      card.r !== 11
    )
      return true;
    return false;
  }

  const RANK_A = 14;
  const RANK_10 = 10;
  const RANK_K = 13;
  const RANK_Q = 12;
  const RANK_J = 11;
  const RANK_9 = 9;
  const RANK_8 = 8;
  const RANK_7 = 7;

  /** Dāmu/kalpu stiprums mastā (kā lib/zole.js) */
  const TRUMP_FACE_ORDER = [0, 3, 2, 1];

  function trumpFaceStrengthSort(suit) {
    const idx = TRUMP_FACE_ORDER.indexOf(suit);
    return idx >= 0 ? idx : 9;
  }

  /** Stiprums stiķim; rokas kārtošanai: augošā secībā = mazāka vērtība pa kreisi */
  function zoleCardTrickStrengthSort(card) {
    if (!card) return -1;
    if (card.r === RANK_Q) {
      return 4000 - trumpFaceStrengthSort(card.s);
    }
    if (card.r === RANK_J) {
      return 3000 - trumpFaceStrengthSort(card.s);
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

  /** Parastie masti kopā: ♣, ♠, ♥; tad trumpji augošā secībā */
  function sortZoleHandClient(hand) {
    if (!hand || !hand.length) return [];
    const PLAIN_SUIT_ORDER = [0, 3, 2];
    function plainSuitKey(s) {
      const i = PLAIN_SUIT_ORDER.indexOf(s);
      return i >= 0 ? i : 99;
    }
    function plainRankKey(r) {
      const order = [RANK_9, RANK_K, RANK_10, RANK_A];
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
        return plainRankKey(a.r) - plainRankKey(b.r);
      }
      return zoleCardTrickStrengthSort(a) - zoleCardTrickStrengthSort(b);
    });
  }

  function cardLabel(card) {
    if (!card) return "?";
    const suits = ["♣", "♦", "♥", "♠"];
    const s = suits[card.s] || "?";
    const r = RANK_LABELS[card.r] || String(card.r);
    return s + r;
  }

  /**
   * Klasiska spēļu kārta (CSS), nevis tikai teksts.
   */
  function createPlayingCardEl(card, opts) {
    const o = opts || {};
    const small = !!o.small;
    const table = !!o.table;
    const inHand = !!o.inHand;
    const meta = SUIT_META[card.s] || SUIT_META[0];
    const rank = RANK_LABELS[card.r] || String(card.r);
    const trump = isZoleTrumpCard(card);

    const el = document.createElement("div");
    el.className =
      "vz-zole-playing-card" +
      (small ? " vz-zole-playing-card--sm" : "") +
      (table ? " vz-zole-playing-card--table" : "") +
      (inHand ? " vz-zole-playing-card--hand" : "") +
      (meta.red
        ? " vz-zole-playing-card--red"
        : " vz-zole-playing-card--black");
    if (trump) el.classList.add("vz-zole-playing-card--trump");
    el.setAttribute("aria-hidden", "true");

    const tl = document.createElement("span");
    tl.className = "vz-zole-pc-corner vz-zole-pc-corner--tl";
    tl.innerHTML = esc(rank) + "<br>" + meta.sym;

    const center = document.createElement("span");
    center.className = "vz-zole-pc-center";
    center.textContent = meta.sym;

    const br = document.createElement("span");
    br.className = "vz-zole-pc-corner vz-zole-pc-corner--br";
    br.innerHTML = esc(rank) + "<br>" + meta.sym;

    el.appendChild(tl);
    el.appendChild(center);
    el.appendChild(br);

    return el;
  }

  function cardKey(c) {
    return c.s + ":" + c.r;
  }

  function contractLabel(c) {
    if (c === "big") return "Lielais";
    if (c === "zole") return "Zole";
    if (c === "maza_zole") return "Mazā zole";
    if (c === "galdins") return "Galdiņš";
    if (c === "galds") return "Galds";
    return String(c || "—");
  }

  /** Lomu teksts blakus vārdam: Galdiņš / Galds / Lielais / Mazais + līgums. */
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

  /** Kārtis stiķa kolonnās: aktīvais stiķis; pēc pabeigšanas ~2.4 s pēdējais, tad tukšs. */
  function zoleTrickDisplayRows(zole) {
    const trick = zole.trick || [];
    if (trick.length > 0) {
      return { rows: trick, leader: zole.trickLeader ?? 0, frozen: false };
    }
    const lc = zole.lastCompletedTrick;
    if (!lc || !lc.cards || lc.cards.length !== 3 || zoleTrickHoldCleared) {
      return { rows: [], leader: zole.trickLeader ?? 0, frozen: false };
    }
    if (zoleTrickHoldUntil > 0 && Date.now() >= zoleTrickHoldUntil) {
      zoleTrickHoldCleared = true;
      clearZoleTrickHoldTimer();
      return { rows: [], leader: zole.trickLeader ?? 0, frozen: false };
    }
    const leader =
      typeof lc.leaderIdx === "number"
        ? lc.leaderIdx
        : lc.cards[0] && typeof lc.cards[0].playerIdx === "number"
          ? lc.cards[0].playerIdx
          : zole.trickLeader ?? 0;
    return { rows: lc.cards, leader, frozen: true };
  }

  function formatTableDelta(zole, players) {
    const d = zole.tableDelta;
    if (!d || d.length !== 3) return "";
    const parts = [];
    for (let i = 0; i < 3; i++) {
      const n = d[i];
      if (!n) continue;
      const sign = n > 0 ? "+" : "";
      parts.push(`${esc(players[i] || "?")}: ${sign}${n}`);
    }
    return parts.join(" · ");
  }

  function buildZoleOpponentCorner(zole, playerIdx, mountPlayerAvatar, eyes) {
    const cell = document.createElement("div");
    cell.className = "vz-zole-duel-opp";
    const deck = document.createElement("div");
    deck.className = "vz-zole-deck-back";
    deck.setAttribute("aria-hidden", "true");
    cell.appendChild(deck);
    const un = (zole.players || [])[playerIdx] || "?";
    const nameEl = document.createElement("div");
    nameEl.className = "vz-zole-duel-name";
    nameEl.textContent = un;
    cell.appendChild(nameEl);
    if (mountPlayerAvatar && un && un !== "?") {
      try {
        cell.appendChild(mountPlayerAvatar(un));
      } catch {
        /* ignore */
      }
    }
    const roleLab = document.createElement("div");
    roleLab.className = "vz-zole-duel-role";
    roleLab.dataset.zoleRole = String(playerIdx);
    roleLab.textContent = zolePlayerRoleLine(zole, playerIdx);
    cell.appendChild(roleLab);
    const eyeLab = document.createElement("div");
    eyeLab.className = "vz-zole-duel-eyes";
    eyeLab.dataset.zoleEye = String(playerIdx);
    eyeLab.textContent = `${eyes[playerIdx] ?? 0} acis`;
    cell.appendChild(eyeLab);
    return cell;
  }

  function appendZoleArena(wrap, zole, myIdx, mountPlayerAvatar) {
    const eyes = zole.eyePoints || [0, 0, 0];
    const arena = document.createElement("div");
    arena.className = "vz-zole-arena";
    const duel = document.createElement("div");
    duel.className = "vz-zole-duel-row";
    const leftIdx = (myIdx + 1) % 3;
    const rightIdx = (myIdx + 2) % 3;
    const left = buildZoleOpponentCorner(
      zole,
      leftIdx,
      mountPlayerAvatar,
      eyes
    );
    left.classList.add("vz-zole-duel-opp--left");
    const right = buildZoleOpponentCorner(
      zole,
      rightIdx,
      mountPlayerAvatar,
      eyes
    );
    right.classList.add("vz-zole-duel-opp--right");
    duel.appendChild(left);
    duel.appendChild(right);
    arena.appendChild(duel);
    arena.appendChild(
      renderZoleTableFelt(zole, null, { showTrickSeatAvatars: false })
    );
    wrap.appendChild(arena);
  }

  function renderZoleTableFelt(zole, mountPlayerAvatar, tableOpts) {
    const showTrickSeatAvatars =
      !tableOpts || tableOpts.showTrickSeatAvatars !== false;
    const felt = document.createElement("div");
    felt.className = "vz-zole-table-felt";
    const cap = document.createElement("div");
    cap.className = "vz-zole-table-caption";
    cap.textContent = "Galds";
    felt.appendChild(cap);

    const phase = zole.phase || "bid";
    if (phase === "bid") {
      const p = document.createElement("p");
      p.className = "vz-zole-table-hint";
      p.textContent = "Šeit — stiķa kārtis.";
      felt.appendChild(p);
      return felt;
    }
    if (phase === "discard") {
      const p = document.createElement("p");
      p.className = "vz-zole-table-hint";
      p.textContent = "Gaida norakšanu…";
      felt.appendChild(p);
      return felt;
    }
    if (phase === "end") {
      const p = document.createElement("p");
      p.className = "vz-zole-table-hint";
      p.textContent = "Beigas.";
      felt.appendChild(p);
      return felt;
    }

    const { rows: trickRows, leader, frozen } = zoleTrickDisplayRows(zole);
    const fan = document.createElement("div");
    fan.className = "vz-zole-trick-fan";
    const mountAv =
      mountPlayerAvatar && typeof mountPlayerAvatar === "function"
        ? mountPlayerAvatar
        : null;
    for (let i = 0; i < 3; i++) {
      const seat = (leader + i) % 3;
      const col = document.createElement("div");
      col.className =
        "vz-zole-trick-seat" + (frozen ? " vz-zole-trick-seat--frozen" : "");
      col.dataset.zoleSeat = String(seat);
      col.style.setProperty("--seat-tilt", `${(i - 1) * 7}deg`);
      const t = trickRows[i];
      const head = document.createElement("div");
      head.className = "vz-zole-trick-seat-head";
      const pname = zole.players[seat] || "?";
      if (
        showTrickSeatAvatars &&
        mountAv &&
        pname &&
        pname !== "?"
      ) {
        try {
          head.appendChild(mountAv(pname));
        } catch {
          /* ignore */
        }
      }
      const who = document.createElement("div");
      who.className = "vz-zole-trick-seat-name";
      who.textContent = pname;
      head.appendChild(who);
      col.appendChild(head);
      const cardArea = document.createElement("div");
      cardArea.className = "vz-zole-trick-card-area";
      col.appendChild(cardArea);
      if (t && t.card) {
        cardArea.appendChild(createPlayingCardEl(t.card, { table: true }));
      }
      const ph = document.createElement("div");
      ph.className = "vz-zole-trick-placeholder";
      ph.textContent = zole.turn === seat ? "Domā…" : "Gaida…";
      if (t && t.card) ph.style.display = "none";
      else if (frozen) {
        ph.style.display = "none";
      }
      col.appendChild(ph);
      fan.appendChild(col);
    }
    felt.appendChild(fan);
    const freezeLine = document.createElement("div");
    freezeLine.className = "vz-zole-trick-freeze-line";
    felt.appendChild(freezeLine);
    syncZoleTrickFreezeLine(freezeLine, zole);

    return felt;
  }

  function syncZoleTrickFreezeLine(el, zole) {
    if (!el) return;
    const { frozen } = zoleTrickDisplayRows(zole);
    const lc = zole.lastCompletedTrick;
    const players = zole.players || [];
    if (frozen && lc && typeof lc.winnerIdx === "number") {
      el.textContent = `Stiķis noslēgts · ${players[lc.winnerIdx] || "?"} · ${lc.trickEyes ?? 0} acis`;
      el.style.display = "block";
    } else {
      el.textContent = "";
      el.style.display = "none";
    }
  }

  function updateZoleTrickColumns(felt, zole) {
    const { rows: trickRows, leader, frozen } = zoleTrickDisplayRows(zole);
    for (let i = 0; i < 3; i++) {
      const seat = (leader + i) % 3;
      const col = felt.querySelector(`[data-zole-seat="${seat}"]`);
      if (!col) continue;
      col.classList.toggle("vz-zole-trick-seat--frozen", frozen);
      const t = trickRows[i];
      const cardArea = col.querySelector(".vz-zole-trick-card-area");
      const ph = col.querySelector(".vz-zole-trick-placeholder");
      if (cardArea) cardArea.innerHTML = "";
      if (ph) {
        ph.textContent = zole.turn === seat ? "Domā…" : "Gaida…";
        if (t && t.card) ph.style.display = "none";
        else if (frozen) ph.style.display = "none";
        else ph.style.display = "flex";
      }
      if (t && t.card && cardArea) {
        cardArea.appendChild(createPlayingCardEl(t.card, { table: true }));
      }
    }
    syncZoleTrickFreezeLine(
      felt.querySelector(".vz-zole-trick-freeze-line"),
      zole
    );
  }

  function buildZoleHandBlock(
    zole,
    isMyTurn,
    onPlayCard,
    opts,
    onDiscard,
    discardConfirmBtnRef
  ) {
    const myIdx =
      opts && typeof opts.myIdx === "number" && opts.myIdx >= 0
        ? opts.myIdx
        : 0;
    const handEl = document.createElement("div");
    handEl.className = "vz-zole-hand";
    const title = document.createElement("div");
    title.className = "vz-zole-hand-title";
    title.textContent = "Tavas kārtis";
    handEl.appendChild(title);

    const btnRow = document.createElement("div");
    btnRow.className = "vz-zole-hand-btns vz-zole-hand-overlap";

    const hand = sortZoleHandClient(zole.myHand || []);
    let legalSet = null;
    if (zole.phase === "play" && isMyTurn) {
      if (global.VZZoleLegal) {
        const legal = global.VZZoleLegal.zoleLegalPlays(
          zole.myHand || [],
          zole.trick || []
        );
        legalSet = new Set(legal.map((c) => global.VZZoleLegal.zoleCardKey(c)));
      } else if (zole.legalCardKeys && zole.legalCardKeys.length) {
        legalSet = new Set(zole.legalCardKeys);
      } else {
        legalSet = new Set();
      }
    }

    const discardSel = [];
    const isDiscardMe =
      zole.phase === "discard" &&
      zole.contract === "big" &&
      myIdx === zole.contractorIdx;

    let discardConfirmBtn = discardConfirmBtnRef || null;

    for (let hi = 0; hi < hand.length; hi++) {
      const card = hand[hi];
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "vz-zole-card-btn";
      btn.setAttribute("aria-label", cardLabel(card));
      btn.title = cardLabel(card);
      btn.style.zIndex = String(10 + hi);
      btn.appendChild(createPlayingCardEl(card, { inHand: true }));
      btn.dataset.s = String(card.s);
      btn.dataset.r = String(card.r);
      const k = cardKey(card);
      let can = false;
      if (isDiscardMe && onDiscard) {
        can = true;
        btn.addEventListener("click", () => {
          const ix = discardSel.findIndex((c) => cardKey(c) === k);
          if (ix >= 0) {
            discardSel.splice(ix, 1);
            btn.classList.remove("vz-zole-card--selected");
          } else if (discardSel.length < 2) {
            discardSel.push(card);
            btn.classList.add("vz-zole-card--selected");
          }
          if (discardConfirmBtn)
            discardConfirmBtn.disabled = discardSel.length !== 2;
        });
      } else {
        can =
          isMyTurn &&
          zole.phase === "play" &&
          (!legalSet || legalSet.has(k));
        if (can) {
          btn.addEventListener("click", () => onPlayCard(card));
        }
      }
      btn.disabled = !can && !isDiscardMe;
      if (isDiscardMe && !onDiscard) btn.disabled = true;
      btnRow.appendChild(btn);
    }

    if (isDiscardMe && onDiscard && discardConfirmBtn) {
      discardConfirmBtn.onclick = () => {
        const row = discardConfirmBtn.closest(".vz-zole-wrap")?.querySelector(
          ".vz-zole-hand-btns"
        );
        if (!row) return;
        const picked = [];
        for (const b of row.querySelectorAll("button.vz-zole-card--selected")) {
          const s = Number(b.dataset.s);
          const r = Number(b.dataset.r);
          if (Number.isFinite(s) && Number.isFinite(r)) picked.push({ s, r });
        }
        if (picked.length !== 2) return;
        onDiscard(picked);
      };
    }
    handEl.appendChild(btnRow);

    function fitZoleHandOverlap() {
      const buttons = btnRow.querySelectorAll(".vz-zole-card-btn");
      const n = buttons.length;
      if (n <= 1) {
        btnRow.style.setProperty("--vz-hand-pull", "0px");
        return;
      }
      const w = buttons[0].getBoundingClientRect().width;
      if (!(w > 0)) return;
      const wrap = handEl.closest(".vz-zole-wrap");
      const avail = Math.max(
        160,
        (wrap && wrap.clientWidth) || handEl.clientWidth || 320
      );
      const rowPad = 16;
      const budget = avail - rowPad;
      const natural = n * w;
      let pull = 0;
      if (natural > budget) {
        pull = (natural - budget) / (n - 1);
        pull = Math.max(14, Math.min(w - 4, pull));
      } else {
        pull = Math.min(22, Math.max(10, w * 0.34));
      }
      btnRow.style.setProperty(
        "--vz-hand-pull",
        `${Math.round(pull * 100) / 100}px`
      );
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(fitZoleHandOverlap);
    });
    global.setTimeout(fitZoleHandOverlap, 0);
    global.setTimeout(fitZoleHandOverlap, 120);
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => fitZoleHandOverlap());
      ro.observe(handEl);
      const wrap = handEl.closest(".vz-zole-wrap");
      if (wrap) ro.observe(wrap);
      const host = handEl.closest("#board-zole-container");
      if (host) ro.observe(host);
    } else {
      global.addEventListener("resize", fitZoleHandOverlap, { passive: true });
    }

    const note = document.createElement("p");
    note.className = "vz-zole-note";
    const zm = opts && String(opts.zoleMode || "").toLowerCase();
    const noteTail =
      zm === "online_3p"
        ? "Tiešsaiste: 3 cilvēki."
        : zm === "online_2p"
          ? "Tiešsaiste: 2 cilvēki + bots."
          : "Pret diviem botiem.";
    const playGreyHint =
      zole.phase === "play" && isMyTurn
        ? " Pelēkās = šajā brīdī nevar izspēlēt (sekšana / likšana)."
        : "";
    note.textContent =
      "Zelta rāmītis = trumpis. Pilni noteikumi — augšā «Īsi noteikumi». " +
      noteTail +
      playGreyHint;
    handEl.appendChild(note);
    return handEl;
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
    const mountPlayerAvatar =
      opts && typeof opts.mountPlayerAvatar === "function"
        ? opts.mountPlayerAvatar
        : null;

    const zm = opts && String(opts.zoleMode || "").toLowerCase();
    const stableSig = [
      (zole.players || []).join("|"),
      myIdx,
      zm,
      zole.contract || "",
      zole.contractorIdx ?? "",
    ].join("::");
    const existingWrap = container.querySelector(".vz-zole-wrap");
    const partialDiscard =
      zole.phase === "discard" && zole.contract === "big";
    const canPartialUpdate =
      existingWrap &&
      (zole.phase === "play" || partialDiscard) &&
      existingWrap.dataset.zolePhase === zole.phase &&
      existingWrap.dataset.zoleStableSig === stableSig;
    if (canPartialUpdate) {
      const eyes = zole.eyePoints || [0, 0, 0];
      const tricks = zole.tricksWon || [0, 0, 0];
      const cte = zole.currentTrickEyes != null ? zole.currentTrickEyes : 0;
      const scoresLine = existingWrap.querySelector(".vz-zole-compact-scores");
      if (scoresLine) {
        scoresLine.innerHTML =
          `<strong>Lācis</strong> ${esc(zole.trumpLabel)} · <strong>Stiķī tagad</strong> ${esc(String(cte))} acis · <strong>Kopā</strong> ${eyes.map((e) => esc(String(e))).join(" · ")} · <strong>Stiķi</strong> ${tricks.map((t) => esc(String(t))).join(" · ")}`;
      }
      for (let pi = 0; pi < 3; pi++) {
        const el = existingWrap.querySelector(`[data-zole-eye="${pi}"]`);
        if (el) el.textContent = `${eyes[pi] ?? 0} acis`;
        const roleEl = existingWrap.querySelector(
          `.vz-zole-players-av-role[data-zole-role="${pi}"], .vz-zole-duel-role[data-zole-role="${pi}"]`
        );
        if (roleEl) roleEl.textContent = zolePlayerRoleLine(zole, pi);
      }
      const turnLine = existingWrap.querySelector(".vz-zole-turn");
      if (turnLine) {
        if (zole.phase === "discard") {
          const isBig = zole.contract === "big";
          turnLine.textContent =
            isBig && myIdx === zole.contractorIdx
              ? "Tu esi lielais — norok 2 kārtas (tās pieskaitās tavām acīm)"
              : "Lielais norok 2 kārtas…";
        } else {
          const tName = zole.players[zole.turn] || "?";
          turnLine.textContent = isMyTurn
            ? "Tava kārta (kārtis)"
            : `Kārta: ${esc(tName)}`;
        }
      }
      const felt = existingWrap.querySelector(".vz-zole-table-felt");
      if (felt && zole.phase === "play") updateZoleTrickColumns(felt, zole);
      const oldHand = existingWrap.querySelector(".vz-zole-hand");
      if (oldHand) oldHand.remove();
      const discardBtn = partialDiscard
        ? existingWrap.querySelector(".vz-zole-discard-confirm")
        : null;
      existingWrap.appendChild(
        buildZoleHandBlock(
          zole,
          isMyTurn,
          onPlayCard,
          opts,
          onDiscard,
          discardBtn
        )
      );
      return;
    }

    container.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.className = "vz-zole-wrap";
    wrap.dataset.zolePhase = zole.phase || "";
    if (zole.phase === "play" || partialDiscard) {
      wrap.dataset.zoleStableSig = stableSig;
    }

    const meta = document.createElement("div");
    meta.className = "vz-zole-meta";
    const eyes = zole.eyePoints || [0, 0, 0];
    const tricks = zole.tricksWon || [0, 0, 0];
    const cte =
      zole.currentTrickEyes != null ? zole.currentTrickEyes : 0;
    const bar = document.createElement("div");
    bar.className = "vz-zole-compact-bar";
    const scoresLine = document.createElement("div");
    scoresLine.className = "vz-zole-compact-scores";
    scoresLine.innerHTML =
      `<strong>Lācis</strong> ${esc(zole.trumpLabel)} · <strong>Stiķī tagad</strong> ${esc(String(cte))} acis · <strong>Kopā</strong> ${eyes.map((e) => esc(String(e))).join(" · ")} · <strong>Stiķi</strong> ${tricks.map((t) => esc(String(t))).join(" · ")}`;
    bar.appendChild(scoresLine);
    if (zole.trumpNote) {
      const det = document.createElement("details");
      det.className = "vz-zole-sek-details";
      const sum = document.createElement("summary");
      sum.className = "vz-zole-sek-summary";
      sum.textContent = "Sekšana · trumpji";
      const body = document.createElement("div");
      body.className = "vz-zole-sek-body";
      body.textContent = zole.trumpNote;
      det.appendChild(sum);
      det.appendChild(body);
      bar.appendChild(det);
    }
    meta.appendChild(bar);

    const showClassicAvRow =
      mountPlayerAvatar &&
      zole.players &&
      zole.players.length === 3 &&
      (zole.phase === "bid" ||
        zole.phase === "discard" ||
        zole.phase === "end");
    if (showClassicAvRow) {
      const avRow = document.createElement("div");
      avRow.className = "vz-zole-players-av";
      for (let pi = 0; pi < 3; pi++) {
        const cell = document.createElement("div");
        cell.className = "vz-zole-players-av-cell";
        const un = zole.players[pi];
        if (un) {
          try {
            cell.appendChild(mountPlayerAvatar(un));
          } catch {
            /* ignore */
          }
        }
        const lab = document.createElement("div");
        lab.className = "vz-zole-players-av-name";
        lab.textContent = un || "?";
        cell.appendChild(lab);
        const roleLab = document.createElement("div");
        roleLab.className = "vz-zole-players-av-role";
        roleLab.dataset.zoleRole = String(pi);
        roleLab.textContent = zolePlayerRoleLine(zole, pi);
        cell.appendChild(roleLab);
        const eyeLab = document.createElement("div");
        eyeLab.className = "vz-zole-players-av-eyes";
        eyeLab.dataset.zoleEye = String(pi);
        eyeLab.textContent = `${eyes[pi] ?? 0} acis`;
        cell.appendChild(eyeLab);
        avRow.appendChild(cell);
      }
      meta.appendChild(avRow);
    }

    if (zole.phase === "play" && zole.contract) {
      const cEl = document.createElement("div");
      cEl.className = "vz-zole-contract";
      const c = zole.contract;
      if (c === "galdins") {
        cEl.textContent =
          "Režīms: Galdiņš — zaudē tas, kam visvairāk acu stiķos.";
      } else if (c === "galds") {
        cEl.textContent =
          "Režīms: Galds — zaudē tas, kam visvairāk stiķu; ja vienādi — pēc acīm.";
      } else {
        const who =
          zole.contractorIdx != null && zole.players
            ? zole.players[zole.contractorIdx]
            : "—";
        cEl.textContent = `Līgums: ${contractLabel(c)} — ${esc(who)}`;
      }
      meta.appendChild(cEl);
    }

    const turnLine = document.createElement("div");
    turnLine.className = "vz-zole-turn";
    if (zole.phase === "bid") {
      const bt = zole.bidTurn ?? 0;
      const rnd = zole.bidRound === 2 ? 2 : 1;
      const rndTxt = rnd === 1 ? "1. kārta" : "2. kārta (bez galdiņa)";
      turnLine.textContent =
        bt === myIdx
          ? `Tava likšanas kārta (${rndTxt})`
          : `Likšana (${rndTxt}): ${esc(zole.players[bt] || "?")}`;
    } else if (zole.phase === "discard") {
      const isBig = zole.contract === "big";
      turnLine.textContent = isBig && myIdx === zole.contractorIdx
        ? "Tu esi lielais — norok 2 kārtas (tās pieskaitās tavām acīm)"
        : "Lielais norok 2 kārtas…";
    } else if (zole.phase === "end") {
      turnLine.textContent = "Partija beigusies";
    } else {
      const tName = zole.players[zole.turn] || "?";
      turnLine.textContent = isMyTurn ? "Tava kārta (kārtis)" : `Kārta: ${esc(tName)}`;
    }
    meta.appendChild(turnLine);
    wrap.appendChild(meta);

    if (zole.players && zole.players.length === 3 && zole.phase === "play") {
      appendZoleArena(wrap, zole, myIdx, mountPlayerAvatar);
    } else {
      wrap.appendChild(renderZoleTableFelt(zole, mountPlayerAvatar));
    }

    if (zole.phase === "bid") {
      const bidBox = document.createElement("div");
      bidBox.className = "vz-zole-bid";
      const bidTitle = document.createElement("div");
      bidTitle.className = "vz-zole-bid-title";
      bidTitle.textContent = "Likšana";
      bidBox.appendChild(bidTitle);
      const isMyBid = (zole.bidTurn ?? 0) === myIdx;
      if (isMyBid && onBid) {
        const row = document.createElement("div");
        row.className = "vz-zole-bid-btns";
        const br = zole.bidRound === 2 ? 2 : 1;
        const bids =
          br === 1
            ? [
                { key: "pass", label: "Pasēt" },
                { key: "galdins", label: "Galdiņš" },
                { key: "big", label: "Lielais" },
                { key: "zole", label: "Zole" },
                { key: "maza_zole", label: "Mazā zole" },
              ]
            : [
                { key: "pass", label: "Pasēt" },
                { key: "big", label: "Lielais" },
                { key: "zole", label: "Zole" },
                { key: "maza_zole", label: "Mazā zole" },
              ];
        for (const b of bids) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "vz-zole-bid-btn";
          btn.textContent = b.label;
          btn.addEventListener("click", () => onBid(b.key));
          row.appendChild(btn);
        }
        bidBox.appendChild(row);
      } else if (!isMyBid) {
        const wait = document.createElement("p");
        wait.className = "vz-zole-bid-wait";
        wait.textContent = "Gaidām citu spēlētāju likšanu…";
        bidBox.appendChild(wait);
      }
      wrap.appendChild(bidBox);
    }

    let discardConfirmBtn = null;
    if (zole.phase === "discard" && zole.contract === "big") {
      const dBox = document.createElement("div");
      dBox.className = "vz-zole-discard";
      const dt = document.createElement("div");
      dt.className = "vz-zole-bid-title";
      dt.textContent = "Norakšana";
      dBox.appendChild(dt);
      const dh = document.createElement("p");
      dh.className = "vz-zole-discard-hint";
      dh.textContent =
        "Izvēlies divas kārtas rokā un spied «Norakt».";
      dBox.appendChild(dh);
      const confirmRow = document.createElement("div");
      confirmRow.className = "vz-zole-discard-actions";
      discardConfirmBtn = document.createElement("button");
      discardConfirmBtn.type = "button";
      discardConfirmBtn.className = "vz-zole-bid-btn vz-zole-discard-confirm";
      discardConfirmBtn.textContent = "Norakt";
      discardConfirmBtn.disabled = true;
      confirmRow.appendChild(discardConfirmBtn);
      dBox.appendChild(confirmRow);
      wrap.appendChild(dBox);
    }

    if (zole.phase === "end" && zole.tableDelta) {
      const resBox = document.createElement("div");
      resBox.className = "vz-zole-result";
      const h = document.createElement("div");
      h.className = "vz-zole-result-title";
      h.textContent = "Tabula (punkti šai partijai)";
      resBox.appendChild(h);
      const deltaLine = document.createElement("div");
      deltaLine.className = "vz-zole-result-delta";
      deltaLine.textContent = formatTableDelta(zole, zole.players || []);
      resBox.appendChild(deltaLine);
      const lr = zole.lastResult;
      if (lr && lr.kind) {
        const det = document.createElement("div");
        det.className = "vz-zole-result-detail";
        let txt = "";
        if (lr.kind === "galdins") {
          if (lr.tie) txt = "Galdiņš: trīs vienādi — bez izmaksām.";
          else {
            const bs =
              lr.loserNoTricks === true
                ? " Zaudētājam bezstiķis — maksā pa 3 p."
                : "";
            txt = `Galdiņš: zaudētājs ${esc(zole.players[lr.loserIdx])}, maksā katram uzvarētājam ${lr.payEach} p.${bs}`;
          }
        } else if (lr.kind === "galds") {
          const bs =
            lr.loserNoTricks === true
              ? " Bezstiķis — maksā pa 3 p."
              : "";
          txt = `Galds: zaudē ${esc(zole.players[lr.loserIdx])} (vairāk stiķu vai, ja vienādi — vairāk acu), maksā katram ${lr.payEach} p.${bs}`;
        } else if (lr.kind === "big") {
          if (lr.win) {
            const bs =
              lr.opponentsNoTricks === true
                ? " Mazajiem bezstiķis."
                : "";
            txt = `Lielais uzvarēja (${lr.tier} p. no katra mazā).${bs}`;
          } else {
            const bs =
              lr.contractorNoTricks === true
                ? " Lielajam bezstiķis."
                : "";
            txt = `Lielais zaudēja (${lr.tier} p. katram mazajam).${bs}`;
          }
        } else if (lr.kind === "zole") {
          if (lr.win) {
            const vs = lr.allTricks === true ? " Visi stiķi." : "";
            txt = `Zole uzvarēta (${lr.tier} p. no katra).${vs}`;
          } else {
            const bs =
              lr.contractorNoTricks === true
                ? " Lielajam bezstiķis."
                : "";
            txt = `Zole zaudēta (${lr.tier} p. katram pretiniekam).${bs}`;
          }
        } else if (lr.kind === "maza_zole") {
          txt = lr.win
            ? "Mazā zole uzvarēta (+12 · −6 katram mazajam)."
            : "Mazā zole zaudēta (−14 · +7 katram mazajam).";
        }
        det.textContent = txt;
        resBox.appendChild(det);
      }
      wrap.appendChild(resBox);
    }

    wrap.appendChild(
      buildZoleHandBlock(
        zole,
        isMyTurn,
        onPlayCard,
        opts,
        onDiscard,
        discardConfirmBtn
      )
    );
    container.appendChild(wrap);
  }

  global.VZZoleBoard = Object.freeze({
    renderZoleBoard,
    cardLabel,
    cardKey,
    isZoleTrumpCard,
  });
})(window);
