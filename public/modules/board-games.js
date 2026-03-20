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

  function isValidDestination(r, c, selectedCell, legalMoves) {
    if (!selectedCell || !legalMoves) return false;
    const [fr, fc] = selectedCell;
    const moves = legalMoves.moves || [];
    const jumps = legalMoves.jumps || [];
    for (const m of moves) {
      if (m.from[0] === fr && m.from[1] === fc && m.to[0] === r && m.to[1] === c) return true;
    }
    for (const j of jumps) {
      const seq = j.jumps || [];
      const first = seq[0];
      const last = seq[seq.length - 1];
      if (first && last && first.from[0] === fr && first.from[1] === fc && last.to[0] === r && last.to[1] === c) return true;
    }
    return false;
  }

  function renderDambreteBoard(board, turnIdx, isMyTurn, myPlayerIdx, onCellClick, selectedCell, legalMoves) {
    const container = document.getElementById("board-dambrete-container");
    if (!container) return;
    container.innerHTML = "";
    container.classList.remove("hidden");
    const table = document.createElement("table");
    table.className = "vz-dambrete-board";
    table.setAttribute("role", "grid");
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
          else if (piece === WHITE_KING) span.classList.add("vz-dambrete-white", "vz-dambrete-king");
          else if (piece === BLACK) span.classList.add("vz-dambrete-black");
          else if (piece === BLACK_KING) span.classList.add("vz-dambrete-black", "vz-dambrete-king");
          span.textContent = Math.abs(piece) === 2 ? "K" : "●";
          td.appendChild(span);
        }
        const canMove = isMyTurn && myPlayerIdx === turnIdx;
        const isSelected = selectedCell && selectedCell[0] === r && selectedCell[1] === c;
        const isValidDest = piece === 0 && isValidDestination(r, c, selectedCell, legalMoves);
        if (isSelected) td.classList.add("vz-dambrete-selected");
        if (isValidDest) td.classList.add("vz-dambrete-valid");
        if (canMove && (piece === 0 ? isValidDest : !selectedCell)) {
          td.tabIndex = 0;
          if (piece === 0 && isValidDest) {
            td.addEventListener("click", () => onCellClick(r, c, false));
          } else if (piece !== 0) {
            const myColor = myPlayerIdx === 0 ? WHITE : BLACK;
            if ((piece > 0 && myColor === WHITE) || (piece < 0 && myColor === BLACK)) {
              td.addEventListener("click", () => onCellClick(r, c, true));
            }
          }
        } else if (canMove && piece === 0 && isValidDest) {
          td.addEventListener("click", () => onCellClick(r, c, false));
        }
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    container.appendChild(table);
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
  });
})(window);
