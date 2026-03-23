/**
 * Galda spēles (dambrete, šahs) – klienta loģika
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

  /**
   * pointerdown (touch + pele). passive: false — citādi mobilajos pārlūkos
   * preventDefault() neaptur 300ms/gesture kavēšanu un pieskāriens „nedarbojas”.
   */
  function bindBoardCellInput(table, handleCell) {
    table.addEventListener(
      "pointerdown",
      function boardPointerDown(e) {
        if (e.button != null && e.button !== 0) return;
        e.preventDefault();
        handleCell(e);
      },
      { capture: true, passive: false }
    );
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
          const clickable =
            canMove &&
            (isMyPiece ||
              (piece === 0 && isValidDest) ||
              (selectedCell && !isValidDest));
          td.dataset.clickable = String(!!clickable);
          td.classList.toggle("vz-dambrete-selected", !!isSelected);
          td.classList.toggle("vz-dambrete-valid", !!isValidDest);
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
            span.textContent = Math.abs(piece) === 2 ? "K" : "●";
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
          span.textContent = Math.abs(piece) === 2 ? "K" : "●";
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
        if (isSelected) td.classList.add("vz-dambrete-selected");
        if (isValidDest) td.classList.add("vz-dambrete-valid");
        if (canMove) td.tabIndex = 0;
        const clickable =
          canMove &&
          (isMyPiece ||
            (piece === 0 && isValidDest) ||
            (selectedCell && !isValidDest));
        td.dataset.clickable = String(!!clickable);
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }

    function handleCellEvent(e) {
      const td = e.target.closest("td[data-row][data-col]");
      if (!td || td.dataset.clickable !== "true") return;
      const r = parseInt(td.dataset.row, 10);
      const c = parseInt(td.dataset.col, 10);
      if (isNaN(r) || isNaN(c)) return;
      e.preventDefault();
      const st = dambreteState;
      const piece = (st.board && st.board[r]?.[c]) ?? 0;
      const isMyPiece =
        piece !== 0 &&
        ((st.myPlayerIdx === 0 && (piece === WHITE || piece === WHITE_KING)) ||
          (st.myPlayerIdx === 1 && (piece === BLACK || piece === BLACK_KING)));
      const isValidDest =
        piece === 0 && isValidDestination(r, c, st.selectedCell, st.legalMoves);
      const cb = st.onCellClick;
      if (!cb) return;
      if (isMyPiece) cb(r, c, true);
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
    const table = document.createElement("table");
    table.className = "vz-chess-board";
    table.setAttribute("role", "grid");
    const canMove = isMyTurn && myPlayerIdx === turnIdx;
    for (let r = 0; r < 8; r++) {
      const tr = document.createElement("tr");
      for (let c = 0; c < 8; c++) {
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
      table.appendChild(tr);
    }
    function handleChessCellEvent(e) {
      const td = e.target.closest("td[data-row][data-col]");
      if (!td || td.dataset.clickable !== "true") return;
      const r = parseInt(td.dataset.row, 10);
      const c = parseInt(td.dataset.col, 10);
      if (isNaN(r) || isNaN(c)) return;
      e.preventDefault();
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
    container.appendChild(table);
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
