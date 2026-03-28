/**
 * Galda spēles (dambrete: Krievijas šaškas vai angļu — servera noteikumi, šahs) – klienta loģika
 */
(function (global) {
  "use strict";

  const ROWS = 8;
  const COLS = 8;
  const WHITE = 1;
  const BLACK = -1;
  const WHITE_KING = 2;
  const BLACK_KING = -2;

  function isDark(r, c) {
    return (r + c) % 2 === 1;
  }

  function cellFromPointerLikeEvent(e) {
    const t = e.changedTouches && e.changedTouches[0];
    if (t) {
      const el = document.elementFromPoint(t.clientX, t.clientY);
      return el && el.closest ? el.closest("td[data-row][data-col]") : null;
    }
    return e.target && e.target.closest
      ? e.target.closest("td[data-row][data-col]")
      : null;
  }

  /**
   * Pele/pen: pointerdown. Skārienam: touchend + elementFromPoint — dažos mobilajos
   * WebKit pēc pirmā pieskāriena otrais pointerdown uz šūnas netiek uzticami piegādāts.
   * passive: false, lai preventDefault() darbotos.
   */
  function bindBoardCellInput(table, handleCell) {
    table.addEventListener(
      "pointerdown",
      function boardPointerDown(e) {
        if (e.button != null && e.button !== 0) return;
        if (e.pointerType === "touch") {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        handleCell(e);
      },
      { capture: true, passive: false }
    );
    table.addEventListener(
      "touchend",
      function boardTouchEnd(e) {
        const td = cellFromPointerLikeEvent(e);
        if (!td || !table.contains(td)) return;
        if (td.dataset.clickable !== "true") return;
        e.preventDefault();
        handleCell({ target: td, preventDefault: function () {} });
      },
      { capture: true, passive: false }
    );
  }

  function isJumpOrigin(r, c, legalMoves) {
    const jumps = legalMoves?.jumps || [];
    for (let i = 0; i < jumps.length; i++) {
      const first = jumps[i].jumps && jumps[i].jumps[0];
      if (
        first &&
        first.from &&
        first.from[0] === r &&
        first.from[1] === c
      )
        return true;
    }
    return false;
  }

  function isValidDestination(r, c, selectedCell, legalMoves) {
    if (!selectedCell || !legalMoves) return false;
    const [fr, fc] = selectedCell;
    const moves = legalMoves.moves || [];
    const jumps = legalMoves.jumps || [];
    for (const m of moves) {
      if (
        m.from[0] === fr &&
        m.from[1] === fc &&
        m.to[0] === r &&
        m.to[1] === c
      )
        return true;
    }
    for (const j of jumps) {
      const seq = j.jumps || [];
      const first = seq[0];
      const last = seq[seq.length - 1];
      if (
        first &&
        last &&
        first.from[0] === fr &&
        first.from[1] === fc &&
        last.to[0] === r &&
        last.to[1] === c
      )
        return true;
    }
    return false;
  }

  let dambreteTable = null;
  let dambreteState = {
    board: null,
    selectedCell: null,
    legalMoves: null,
    myPlayerIdx: 0,
    onCellClick: null,
  };

  function renderDambreteBoard(
    board,
    turnIdx,
    isMyTurn,
    myPlayerIdx,
    onCellClick,
    selectedCell,
    legalMoves
  ) {
    const container = document.getElementById("board-dambrete-container");
    if (!container) return;
    container.classList.remove("hidden");

    const canMove = isMyTurn && myPlayerIdx === turnIdx;

    if (dambreteTable && container.contains(dambreteTable)) {
      dambreteState.board = board;
      dambreteState.selectedCell = selectedCell;
      dambreteState.legalMoves = legalMoves;
      dambreteState.myPlayerIdx = myPlayerIdx;
      dambreteState.onCellClick = onCellClick;
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const td = dambreteTable.querySelector(
            `td[data-row="${r}"][data-col="${c}"]`
          );
          if (!td || !isDark(r, c)) continue;
          const piece = board[r][c];
          const isSelected =
            selectedCell && selectedCell[0] === r && selectedCell[1] === c;
          const isValidDest =
            piece === 0 && isValidDestination(r, c, selectedCell, legalMoves);
          const isMyPiece =
            piece !== 0 &&
            ((myPlayerIdx === 0 && (piece === WHITE || piece === WHITE_KING)) ||
              (myPlayerIdx === 1 && (piece === BLACK || piece === BLACK_KING)));
          const jumpsMandatory = (legalMoves?.jumps || []).length > 0;
          const isMyPieceSelectable =
            isMyPiece &&
            (!jumpsMandatory || isJumpOrigin(r, c, legalMoves));
          const clickable =
            canMove &&
            (isMyPieceSelectable ||
              (piece === 0 && isValidDest) ||
              (selectedCell && !isValidDest));
          td.dataset.clickable = String(!!clickable);
          td.classList.toggle("vz-dambrete-selected", !!isSelected);
          td.classList.toggle("vz-dambrete-valid", !!isValidDest);
          td.classList.toggle(
            "vz-dambrete-jump-origin",
            jumpsMandatory && isMyPiece && isJumpOrigin(r, c, legalMoves)
          );
          let span = td.querySelector(".vz-dambrete-piece");
          if (piece !== 0) {
            if (!span) {
              span = document.createElement("span");
              td.appendChild(span);
            }
            span.className = "vz-dambrete-piece";
            span.classList.remove(
              "vz-dambrete-white",
              "vz-dambrete-king",
              "vz-dambrete-black"
            );
            if (piece === WHITE) span.classList.add("vz-dambrete-white");
            else if (piece === WHITE_KING)
              span.classList.add("vz-dambrete-white", "vz-dambrete-king");
            else if (piece === BLACK) span.classList.add("vz-dambrete-black");
            else if (piece === BLACK_KING)
              span.classList.add("vz-dambrete-black", "vz-dambrete-king");
            const isKing = Math.abs(piece) === 2;
            span.textContent = isKing ? "★" : "";
            const colorLv =
              piece === WHITE || piece === WHITE_KING ? "Balts" : "Melns";
            span.setAttribute(
              "aria-label",
              isKing ? `${colorLv} dāma` : `${colorLv} kauliņš`
            );
            span.setAttribute("role", "img");
          } else if (span) span.remove();
        }
      }
      return;
    }

    container.innerHTML = "";
    const table = document.createElement("table");
    table.className = "vz-dambrete-board";
    table.setAttribute("role", "grid");
    dambreteTable = table;
    dambreteState.board = board;
    dambreteState.selectedCell = selectedCell;
    dambreteState.legalMoves = legalMoves;
    dambreteState.myPlayerIdx = myPlayerIdx;
    dambreteState.onCellClick = onCellClick;

    for (let r = 0; r < ROWS; r++) {
      const tr = document.createElement("tr");
      for (let c = 0; c < COLS; c++) {
        const td = document.createElement("td");
        td.dataset.row = String(r);
        td.dataset.col = String(c);
        if (!isDark(r, c)) {
          td.className = "vz-dambrete-light";
          tr.appendChild(td);
          continue;
        }
        td.className = "vz-dambrete-dark";
        const piece = board[r][c];
        if (piece !== 0) {
          const span = document.createElement("span");
          span.className = "vz-dambrete-piece";
          if (piece === WHITE) span.classList.add("vz-dambrete-white");
          else if (piece === WHITE_KING)
            span.classList.add("vz-dambrete-white", "vz-dambrete-king");
          else if (piece === BLACK) span.classList.add("vz-dambrete-black");
          else if (piece === BLACK_KING)
            span.classList.add("vz-dambrete-black", "vz-dambrete-king");
          const isKingInit = Math.abs(piece) === 2;
          span.textContent = isKingInit ? "★" : "";
          const colorLvInit =
            piece === WHITE || piece === WHITE_KING ? "Balts" : "Melns";
          span.setAttribute(
            "aria-label",
            isKingInit ? `${colorLvInit} dāma` : `${colorLvInit} kauliņš`
          );
          span.setAttribute("role", "img");
          td.appendChild(span);
        }
        const isSelected =
          selectedCell && selectedCell[0] === r && selectedCell[1] === c;
        const isValidDest =
          piece === 0 && isValidDestination(r, c, selectedCell, legalMoves);
        const isMyPiece =
          piece !== 0 &&
          ((myPlayerIdx === 0 && (piece === WHITE || piece === WHITE_KING)) ||
            (myPlayerIdx === 1 && (piece === BLACK || piece === BLACK_KING)));
        const jumpsMandatory = (legalMoves?.jumps || []).length > 0;
        const isMyPieceSelectable =
          isMyPiece &&
          (!jumpsMandatory || isJumpOrigin(r, c, legalMoves));
        if (isSelected) td.classList.add("vz-dambrete-selected");
        if (isValidDest) td.classList.add("vz-dambrete-valid");
        td.classList.toggle(
          "vz-dambrete-jump-origin",
          jumpsMandatory && isMyPiece && isJumpOrigin(r, c, legalMoves)
        );
        if (canMove) td.tabIndex = 0;
        const clickable =
          canMove &&
          (isMyPieceSelectable ||
            (piece === 0 && isValidDest) ||
            (selectedCell && !isValidDest));
        td.dataset.clickable = String(!!clickable);
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }

    function handleCellEvent(e) {
      const td =
        e.target && e.target.closest
          ? e.target.closest("td[data-row][data-col]")
          : null;
      if (!td || td.dataset.clickable !== "true") return;
      const r = parseInt(td.dataset.row, 10);
      const c = parseInt(td.dataset.col, 10);
      if (isNaN(r) || isNaN(c)) return;
      if (typeof e.preventDefault === "function") e.preventDefault();
      const st = dambreteState;
      const piece = (st.board && st.board[r]?.[c]) ?? 0;
      const isMyPiece =
        piece !== 0 &&
        ((st.myPlayerIdx === 0 && (piece === WHITE || piece === WHITE_KING)) ||
          (st.myPlayerIdx === 1 && (piece === BLACK || piece === BLACK_KING)));
      const jumpsMandatory = (st.legalMoves?.jumps || []).length > 0;
      const isMyPieceSelectable =
        isMyPiece &&
        (!jumpsMandatory || isJumpOrigin(r, c, st.legalMoves));
      const isValidDest =
        piece === 0 && isValidDestination(r, c, st.selectedCell, st.legalMoves);
      const cb = st.onCellClick;
      if (!cb) return;
      if (
        st.selectedCell &&
        st.selectedCell[0] === r &&
        st.selectedCell[1] === c &&
        isMyPiece
      ) {
        cb(r, c, true);
        return;
      }
      if (isMyPieceSelectable) cb(r, c, true);
      else if (piece === 0 && isValidDest) cb(r, c, false);
      else if (st.selectedCell) cb(r, c, false);
    }

    bindBoardCellInput(table, handleCellEvent);
    container.appendChild(table);
  }

  // Šahs: FEN parse un galda attēlojums
  const CHESS_PIECES = {
    p: { symbol: "♟", color: "black" },
    n: { symbol: "♞", color: "black" },
    b: { symbol: "♝", color: "black" },
    r: { symbol: "♜", color: "black" },
    q: { symbol: "♛", color: "black" },
    k: { symbol: "♚", color: "black" },
    P: { symbol: "♙", color: "white" },
    N: { symbol: "♘", color: "white" },
    B: { symbol: "♗", color: "white" },
    R: { symbol: "♖", color: "white" },
    Q: { symbol: "♕", color: "white" },
    K: { symbol: "♔", color: "white" },
  };

  function parseFenToBoard(fen) {
    const board = Array(8)
      .fill(null)
      .map(() => Array(8).fill(null));
    const parts = String(fen || "")
      .trim()
      .split(/\s+/);
    const placement = parts[0] || "";
    const ranks = placement.split("/");
    for (let r = 0; r < 8 && r < ranks.length; r++) {
      let c = 0;
      for (const ch of ranks[r]) {
        if (c >= 8) break;
        const n = parseInt(ch, 10);
        if (!isNaN(n)) {
          c += n;
        } else if (CHESS_PIECES[ch]) {
          board[r][c] = ch;
          c++;
        }
      }
    }
    return board;
  }

  function squareToRowCol(sq) {
    if (!sq || sq.length < 2) return null;
    const file = sq.charCodeAt(0) - 97;
    const rank = parseInt(sq[1], 10);
    if (isNaN(rank) || file < 0 || file > 7 || rank < 1 || rank > 8)
      return null;
    return [8 - rank, file];
  }

  function rowColToSquare(r, c) {
    const file = String.fromCharCode(97 + c);
    const rank = 8 - r;
    return file + rank;
  }

  function isChessValidDest(r, c, selectedCell, legalMoves) {
    if (!selectedCell || !legalMoves) return false;
    const [fr, fc] = selectedCell;
    const fromSq = rowColToSquare(fr, fc);
    const toSq = rowColToSquare(r, c);
    const moves = legalMoves.moves || [];
    return moves.some((m) => m.from === fromSq && m.to === toSq);
  }

  function findChessMove(selectedCell, toRow, toCol, legalMoves) {
    if (!selectedCell || !legalMoves) return null;
    const [fr, fc] = selectedCell;
    const fromSq = rowColToSquare(fr, fc);
    const toSq = rowColToSquare(toRow, toCol);
    const moves = legalMoves.moves || [];
    return moves.find((m) => m.from === fromSq && m.to === toSq);
  }

  function chessPieceLabel(ch) {
    const p = CHESS_PIECES[ch];
    if (!p) return "";
    const isW = p.color === "white";
    const names = {
      p: "bandinieks",
      n: "zirgs",
      b: "laidnis",
      r: "tornis",
      q: "dāma",
      k: "karalis",
    };
    const key = String(ch).toLowerCase();
    const n = names[key] || "figūra";
    return (isW ? "Balts " : "Melns ") + n;
  }

  function renderChessBoard(
    fen,
    turnIdx,
    isMyTurn,
    myPlayerIdx,
    onCellClick,
    selectedCell,
    legalMoves
  ) {
    const container = document.getElementById("board-chess-container");
    if (!container) return;
    container.innerHTML = "";
    container.classList.remove("hidden");
    const board = parseFenToBoard(fen);
    const flipped = myPlayerIdx === 1;
    const wrap = document.createElement("div");
    wrap.className = "vz-chess-board-wrap";
    const table = document.createElement("table");
    table.className = "vz-chess-board";
    table.setAttribute("role", "grid");
    const canMove = isMyTurn && myPlayerIdx === turnIdx;

    function dataRC(viewR, viewC) {
      if (!flipped) return [viewR, viewC];
      return [7 - viewR, 7 - viewC];
    }

    function fileCharForViewCol(viewC) {
      const dc = flipped ? 7 - viewC : viewC;
      return String.fromCharCode(97 + dc);
    }

    function rankDigitForViewRow(viewR) {
      const dr = flipped ? 7 - viewR : viewR;
      return String(8 - dr);
    }

    function appendFileRow(tr) {
      const cornerL = document.createElement("td");
      cornerL.className = "vz-chess-co vz-chess-co--corner";
      cornerL.setAttribute("aria-hidden", "true");
      tr.appendChild(cornerL);
      for (let vc = 0; vc < 8; vc++) {
        const td = document.createElement("td");
        td.className = "vz-chess-co vz-chess-co--file";
        td.textContent = fileCharForViewCol(vc);
        tr.appendChild(td);
      }
      const cornerR = document.createElement("td");
      cornerR.className = "vz-chess-co vz-chess-co--corner";
      cornerR.setAttribute("aria-hidden", "true");
      tr.appendChild(cornerR);
    }

    const topTr = document.createElement("tr");
    appendFileRow(topTr);
    table.appendChild(topTr);

    for (let vr = 0; vr < 8; vr++) {
      const tr = document.createElement("tr");
      const rankTd = document.createElement("td");
      rankTd.className = "vz-chess-co vz-chess-co--rank";
      rankTd.textContent = rankDigitForViewRow(vr);
      tr.appendChild(rankTd);

      for (let vc = 0; vc < 8; vc++) {
        const [r, c] = dataRC(vr, vc);
        const td = document.createElement("td");
        td.dataset.row = String(r);
        td.dataset.col = String(c);
        td.className = (r + c) % 2 === 0 ? "vz-chess-light" : "vz-chess-dark";
        const piece = board[r][c];
        if (piece && CHESS_PIECES[piece]) {
          const span = document.createElement("span");
          span.className =
            "vz-chess-piece vz-chess-" + CHESS_PIECES[piece].color;
          span.textContent = CHESS_PIECES[piece].symbol;
          span.setAttribute("role", "img");
          span.setAttribute("aria-label", chessPieceLabel(piece));
          td.appendChild(span);
        }
        const isSelected =
          selectedCell && selectedCell[0] === r && selectedCell[1] === c;
        const isValidDest = isChessValidDest(r, c, selectedCell, legalMoves);
        const hasPiece = !!piece;
        const isMyPiece =
          hasPiece &&
          ((myPlayerIdx === 0 && /[PNBRQK]/.test(piece)) ||
            (myPlayerIdx === 1 && /[pnbrqk]/.test(piece)));
        if (isSelected) td.classList.add("vz-chess-selected");
        if (isValidDest) td.classList.add("vz-chess-valid");
        if (canMove) td.tabIndex = 0;
        td.dataset.clickable = String(
          canMove &&
            ((hasPiece && isMyPiece) ||
              isValidDest ||
              (selectedCell && !isValidDest))
        );
        tr.appendChild(td);
      }

      const rankTdR = document.createElement("td");
      rankTdR.className = "vz-chess-co vz-chess-co--rank";
      rankTdR.textContent = rankDigitForViewRow(vr);
      tr.appendChild(rankTdR);
      table.appendChild(tr);
    }

    const botTr = document.createElement("tr");
    appendFileRow(botTr);
    table.appendChild(botTr);

    function handleChessCellEvent(e) {
      const td =
        e.target && e.target.closest
          ? e.target.closest("td[data-row][data-col]")
          : null;
      if (!td || td.dataset.clickable !== "true") return;
      const r = parseInt(td.dataset.row, 10);
      const c = parseInt(td.dataset.col, 10);
      if (isNaN(r) || isNaN(c)) return;
      if (typeof e.preventDefault === "function") e.preventDefault();
      const piece = board[r]?.[c];
      const isMyPiece =
        piece &&
        ((myPlayerIdx === 0 && /[PNBRQK]/.test(piece)) ||
          (myPlayerIdx === 1 && /[pnbrqk]/.test(piece)));
      const isValidDest = isChessValidDest(r, c, selectedCell, legalMoves);
      if (piece && isMyPiece) onCellClick(r, c, true);
      else if (isValidDest) onCellClick(r, c, false);
      else if (selectedCell) onCellClick(r, c, false);
    }
    bindBoardCellInput(table, handleChessCellEvent);
    wrap.appendChild(table);
    container.appendChild(wrap);
  }

  function resetDambreteTable() {
    dambreteTable = null;
  }

  global.VZBoardGames = Object.freeze({
    ROWS,
    COLS,
    WHITE,
    BLACK,
    WHITE_KING,
    BLACK_KING,
    isDark,
    renderDambreteBoard,
    resetDambreteTable,
    renderChessBoard,
    parseFenToBoard,
    squareToRowCol,
    rowColToSquare,
    findChessMove,
  });
})(window);
