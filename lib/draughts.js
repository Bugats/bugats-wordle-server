/**
 * Dambrete (English checkers 8x8) – spēles loģika
 * Board: 8x8, tikai tumšie lauciņi (row+col)%2 === 1
 * White (1) augšā, Black (-1) apakšā
 * 1,2 = white man, king; -1,-2 = black man, king
 */
const ROWS = 8;
const COLS = 8;
const WHITE = 1;
const BLACK = -1;
const WHITE_KING = 2;
const BLACK_KING = -2;

function isDark(r, c) {
  return (r + c) % 2 === 1;
}

function createInitialBoard() {
  const board = Array(ROWS)
    .fill(null)
    .map(() => Array(COLS).fill(0));
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!isDark(r, c)) continue;
      if (r < 3) board[r][c] = WHITE;
      else if (r > 4) board[r][c] = BLACK;
    }
  }
  return board;
}

function getPieceColor(piece) {
  if (piece > 0) return WHITE;
  if (piece < 0) return BLACK;
  return 0;
}

function isKing(piece) {
  return Math.abs(piece) === 2;
}

function getMoveDirs(piece, isWhiteTurn) {
  const color = getPieceColor(piece);
  const dirs = [];
  if (isKing(piece)) {
    dirs.push([-1, -1], [-1, 1], [1, -1], [1, 1]);
  } else {
    if (color === WHITE) dirs.push([1, -1], [1, 1]);
    else dirs.push([-1, -1], [-1, 1]);
  }
  return dirs;
}

function inBounds(r, c) {
  return r >= 0 && r < ROWS && c >= 0 && c < COLS;
}

function findJumps(board, r, c, piece, isWhiteTurn, jumped) {
  const jumps = [];
  const dirs = getMoveDirs(piece, isWhiteTurn);
  const enemy = piece > 0 ? BLACK : WHITE;

  for (const [dr, dc] of dirs) {
    const mr = r + dr;
    const mc = c + dc;
    const lr = r + 2 * dr;
    const lc = c + 2 * dc;
    if (!inBounds(mr, mc) || !inBounds(lr, lc)) continue;
    if (!isDark(mr, mc) || !isDark(lr, lc)) continue;
    const mid = board[mr][mc];
    const land = board[lr][lc];
    const midKey = `${mr},${mc}`;
    if (getPieceColor(mid) === enemy && land === 0 && !jumped.has(midKey)) {
      const newBoard = board.map((row) => row.slice());
      newBoard[r][c] = 0;
      newBoard[mr][mc] = 0;
      let newPiece = piece;
      if (isKing(piece)) {
        newPiece = piece;
      } else if (piece > 0 && lr === ROWS - 1) {
        newPiece = WHITE_KING;
      } else if (piece < 0 && lr === 0) {
        newPiece = BLACK_KING;
      }
      newBoard[lr][lc] = newPiece;
      const newJumped = new Set(jumped);
      newJumped.add(midKey);
      const more = findJumps(newBoard, lr, lc, newPiece, isWhiteTurn, newJumped);
      const cap = [[mr, mc]];
      if (more.length) {
        for (const seq of more) jumps.push([{ from: [r, c], to: [lr, lc], captured: cap }, ...seq]);
      } else {
        jumps.push([{ from: [r, c], to: [lr, lc], captured: cap }]);
      }
    }
  }
  return jumps;
}

function findMoves(board, r, c, piece, isWhiteTurn) {
  const moves = [];
  const dirs = getMoveDirs(piece, isWhiteTurn);
  for (const [dr, dc] of dirs) {
    const nr = r + dr;
    const nc = c + dc;
    if (!inBounds(nr, nc) || !isDark(nr, nc)) continue;
    if (board[nr][nc] !== 0) continue;
    let newPiece = piece;
    if (!isKing(piece)) {
      if (piece > 0 && nr === ROWS - 1) newPiece = WHITE_KING;
      else if (piece < 0 && nr === 0) newPiece = BLACK_KING;
    }
    moves.push({ from: [r, c], to: [nr, nc], captured: [] });
  }
  return moves;
}

function getAllMoves(board, isWhiteTurn) {
  const jumps = [];
  const moves = [];
  const color = isWhiteTurn ? WHITE : BLACK;

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!isDark(r, c)) continue;
      const piece = board[r][c];
      if (getPieceColor(piece) !== color) continue;
      const j = findJumps(board, r, c, piece, isWhiteTurn, new Set());
      if (j.length) jumps.push(...j.map((seq) => ({ jumps: seq })));
      else if (jumps.length === 0) {
        moves.push(...findMoves(board, r, c, piece, isWhiteTurn));
      }
    }
  }

  if (jumps.length) return { jumps, moves: [] };
  return { jumps: [], moves };
}

function applyMove(board, move) {
  const newBoard = board.map((row) => row.slice());
  const jumps = move.jumps;
  if (jumps && jumps.length > 0) {
    let piece = newBoard[jumps[0].from[0]][jumps[0].from[1]];
    if (!piece) return null;
    for (const j of jumps) {
      const [fr, fc] = j.from;
      const [tr, tc] = j.to;
      newBoard[fr][fc] = 0;
      for (const [cr, cc] of j.captured || []) newBoard[cr][cc] = 0;
      if (!isKing(piece)) {
        if (piece > 0 && tr === ROWS - 1) piece = WHITE_KING;
        else if (piece < 0 && tr === 0) piece = BLACK_KING;
      }
      newBoard[tr][tc] = piece;
    }
    return newBoard;
  }
  const from = move.from;
  const to = move.to;
  if (!from || !to) return null;
  const [fr, fc] = Array.isArray(from) ? from : [from.r ?? from.row, from.c ?? from.col];
  const [tr, tc] = Array.isArray(to) ? to : [to.r ?? to.row, to.c ?? to.col];
  const piece = newBoard[fr][fc];
  if (!piece) return null;
  newBoard[fr][fc] = 0;
  let newPiece = piece;
  if (!isKing(piece)) {
    if (piece > 0 && tr === ROWS - 1) newPiece = WHITE_KING;
    else if (piece < 0 && tr === 0) newPiece = BLACK_KING;
  }
  newBoard[tr][tc] = newPiece;
  return newBoard;
}

function countPieces(board, color) {
  let n = 0;
  const want = color === WHITE ? 1 : -1;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (getPieceColor(board[r][c]) === want) n++;
    }
  }
  return n;
}

function checkGameOver(board, isWhiteTurn) {
  const { jumps, moves } = getAllMoves(board, isWhiteTurn);
  const whiteCount = countPieces(board, WHITE);
  const blackCount = countPieces(board, BLACK);
  if (whiteCount === 0) return { over: true, winner: BLACK };
  if (blackCount === 0) return { over: true, winner: WHITE };
  const hasMove = jumps.length > 0 || moves.length > 0;
  if (!hasMove) return { over: true, winner: isWhiteTurn ? BLACK : WHITE };
  return { over: false };
}

function moveMatches(move, from, to) {
  const f = move.from || move.jumps?.[0]?.from;
  const t = move.to || move.jumps?.[move.jumps.length - 1]?.to;
  const [fr, fc] = Array.isArray(f) ? f : [f?.r ?? f?.row, f?.c ?? f?.col];
  const [tr, tc] = Array.isArray(t) ? t : [t?.r ?? t?.row, t?.c ?? t?.col];
  return fr === from[0] && fc === from[1] && tr === to[0] && tc === to[1];
}

function findLegalMove(allMoves, move) {
  if (move.jumps && move.jumps.length > 0) {
    const seq = move.jumps;
    const firstFrom = seq[0].from;
    const lastTo = seq[seq.length - 1].to;
    return allMoves.jumps.find((j) => {
      const jseq = j.jumps;
      if (!jseq || jseq.length !== seq.length) return false;
      for (let i = 0; i < seq.length; i++) {
        if (jseq[i].from[0] !== seq[i].from[0] || jseq[i].from[1] !== seq[i].from[1]) return false;
        if (jseq[i].to[0] !== seq[i].to[0] || jseq[i].to[1] !== seq[i].to[1]) return false;
      }
      return true;
    });
  }
  return allMoves.moves.find(
    (m) => m.from[0] === move.from[0] && m.from[1] === move.from[1] && m.to[0] === move.to[0] && m.to[1] === move.to[1]
  );
}

export {
  ROWS,
  COLS,
  WHITE,
  BLACK,
  WHITE_KING,
  BLACK_KING,
  createInitialBoard,
  getAllMoves,
  applyMove,
  checkGameOver,
  moveMatches,
  findLegalMove,
  isDark,
};
