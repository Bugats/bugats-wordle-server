/**
 * Zole UI — acis, likšana (lielais / zole / mazā zole / galdiņš), tabulas punkti
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

  const ZOLE_SUIT_CLUBS = 2;

  const SUIT_META = [
    { sym: "♥", red: true },
    { sym: "♦", red: true },
    { sym: "♣", red: false },
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
      card.s === ZOLE_SUIT_CLUBS &&
      card.r !== 12 &&
      card.r !== 11
    )
      return true;
    return false;
  }

  function cardLabel(card) {
    if (!card) return "?";
    const suits = ["♥", "♦", "♣", "♠"];
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
    const meta = SUIT_META[card.s] || SUIT_META[0];
    const rank = RANK_LABELS[card.r] || String(card.r);
    const trump = isZoleTrumpCard(card);

    const el = document.createElement("div");
    el.className =
      "vz-zole-playing-card" +
      (small ? " vz-zole-playing-card--sm" : "") +
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
    return String(c || "—");
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

  function renderZoleBoard(zole, isMyTurn, onPlayCard, opts) {
    const container = document.getElementById("board-zole-container");
    if (!container) return;
    container.classList.remove("hidden");
    container.innerHTML = "";

    const myIdx =
      opts && typeof opts.myIdx === "number" && opts.myIdx >= 0
        ? opts.myIdx
        : 0;
    const onBid = opts && typeof opts.onBid === "function" ? opts.onBid : null;
    const onDiscard =
      opts && typeof opts.onDiscard === "function" ? opts.onDiscard : null;

    const wrap = document.createElement("div");
    wrap.className = "vz-zole-wrap";

    const meta = document.createElement("div");
    meta.className = "vz-zole-meta";
    const trumpNote = zole.trumpNote
      ? `<div class="vz-zole-trump-note">${esc(zole.trumpNote)}</div>`
      : "";
    meta.innerHTML = `<div class="vz-zole-trump">Galda lācis (pēc pirkuma): <strong>${esc(zole.trumpLabel)}</strong></div>${trumpNote}`;

    const eyes = zole.eyePoints || [0, 0, 0];
    const tricks = zole.tricksWon || [0, 0, 0];
    const scoreLine = document.createElement("div");
    scoreLine.className = "vz-zole-scores";
    scoreLine.innerHTML = `<div>Acis: ${eyes.map((e) => esc(String(e))).join(" · ")}</div><div class="vz-zole-tricks-sub">Stiķi: ${tricks.map((t) => esc(String(t))).join(" · ")}</div>`;
    meta.appendChild(scoreLine);

    if (zole.phase === "play" && zole.contract) {
      const cEl = document.createElement("div");
      cEl.className = "vz-zole-contract";
      const who =
        zole.contractorIdx != null && zole.players
          ? zole.players[zole.contractorIdx]
          : "—";
      cEl.textContent = `Līgums: ${contractLabel(zole.contract)} — ${esc(who)}`;
      meta.appendChild(cEl);
    }

    const turnLine = document.createElement("div");
    turnLine.className = "vz-zole-turn";
    if (zole.phase === "bid") {
      const bt = zole.bidTurn ?? 0;
      turnLine.textContent =
        bt === myIdx ? "Tava likšanas kārta" : `Likšana: ${esc(zole.players[bt] || "?")}`;
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
        const bids = [
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
          else
            txt = `Galdiņš: zaudētājs ${esc(zole.players[lr.loserIdx])}, maksā katram uzvarētājam ${lr.payEach} p.`;
        } else if (lr.kind === "big") {
          txt = lr.win
            ? `Lielais uzvarēja (${lr.tier} p. no katra mazā).`
            : `Lielais zaudēja (${lr.tier} p. katram mazajam).`;
        } else if (lr.kind === "zole") {
          txt = lr.win
            ? `Zole uzvarēta (${lr.tier} p. no katra).`
            : `Zole zaudēta (${lr.tier} p. katram pretiniekam).`;
        } else if (lr.kind === "maza_zole") {
          txt = lr.win
            ? "Mazā zole uzvarēta (6 p. no katra)."
            : "Mazā zole zaudēta (6 p. katram).";
        }
        det.textContent = txt;
        resBox.appendChild(det);
      }
      wrap.appendChild(resBox);
    }

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
        const whoEl = document.createElement("span");
        whoEl.className = "vz-zole-trick-who";
        whoEl.textContent = who;
        slot.appendChild(whoEl);
        slot.appendChild(createPlayingCardEl(t.card, { small: true }));
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

    const discardSel = [];
    const isDiscardMe =
      zole.phase === "discard" &&
      zole.contract === "big" &&
      myIdx === zole.contractorIdx;

    for (const card of hand) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "vz-zole-card-btn";
      btn.setAttribute("aria-label", cardLabel(card));
      btn.title = cardLabel(card);
      btn.appendChild(createPlayingCardEl(card, {}));
      btn.dataset.s = String(card.s);
      btn.dataset.r = String(card.r);
      const k = cardKey(card);
      let can = false;
      if (isDiscardMe && onDiscard) {
        can = true;
        btn.addEventListener("click", () => {
          const ix = discardSel.findIndex(
            (c) => cardKey(c) === k
          );
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
      discardConfirmBtn.addEventListener("click", () => {
        if (discardSel.length !== 2) return;
        onDiscard(discardSel.slice());
      });
    }
    handEl.appendChild(btnRow);

    const note = document.createElement("p");
    note.className = "vz-zole-note";
    const zm = opts && String(opts.zoleMode || "").toLowerCase();
    const noteTail =
      zm === "online_3p"
        ? "Tiešsaiste: 3 cilvēki."
        : zm === "online_2p"
          ? "Tiešsaiste: 2 cilvēki + bots."
          : "Pret diviem botiem.";
    note.innerHTML =
      "Kārtis kā uz galda (baltas, sarkans/melns). <strong>Zelta rāmītis</strong> = trumpis (D, J, ♣ kāravas). 26 kārtis. Acis: A=11, 10=10, K=4, D=3, J=2. Lielais: pirkums + norok 2. Uzvara <strong>61+</strong>. " +
      noteTail;
    handEl.appendChild(note);

    wrap.appendChild(handEl);
    container.appendChild(wrap);
  }

  global.VZZoleBoard = Object.freeze({
    renderZoleBoard,
    cardLabel,
    cardKey,
    isZoleTrumpCard,
  });
})(window);
