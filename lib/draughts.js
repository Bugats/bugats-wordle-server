/**
 * Krievijas šaškas 8×8 (Russian draughts / shashki)
 * Laukums: tikai tumšie lauciņi (row+col)%2 === 1
 * Baltie (1) augšā, melnie (-1) apakšā; 1,2 = bārdiņa, dāma; -1,-2 = melnais, dāma
 *
 * Atšķirības no angļu dambretes:
 * - Bārdiņa ķer uz priekšu un atpakaļ (4 diagonāles)
 * - Dāma brīvi kustas pa diagonāli jebkuru tukšu lauciņu skaitu
 * - Dāma ķer pāri vienam pretiniekam uz jebkuru tukšu lauciņu aiz tā pašā diagonālē
 * - Ja ķeršanas laikā bārdiņa sasniedz dāmu rindu un var turpināt ķert — kļūst par dāmu un turpina
 * - Obligāta ķeršana, bet nav „garākās ķeršanas” obligātuma (var izvēlēties secību)
 */
const ROWS = 8;
const COLS = 8;
const WHITE = 1;
const BLACK = -1;
const WHITE_KING = 2;
const BLACK_KING = -2;

const DIAG_DIRS = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

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

function promoteIfOnBackRow(piece, r) {
  if (isKing(piece)) return piece;
  if (piece > 0 && r === ROWS - 1) return WHITE_KING;
  if (piece < 0 && r === 0) return BLACK_KING;
  return piece;
}

function inBounds(r, c) {
  return r >= 0 && r < ROWS && c >= 0 && c < COLS;
}

/** Bārdiņa: tikai uz priekšu pa vienu lauciņu */
function findManMoves(board, r, c, piece) {
  const moves = [];
  const dirs =
    piece > 0
      ? [
          [1, -1],
          [1, 1],
        ]
      : [
          [-1, -1],
          [-1, 1],
        ];
  for (const [dr, dc] of dirs) {
    const nr = r + dr;
    const nc = c + dc;
    if (!inBounds(nr, nc) || !isDark(nr, nc)) continue;
    if (board[nr][nc] !== 0) continue;
    moves.push({ from: [r, c], to: [nr, nc], captured: [] });
  }
  return moves;
}

/** Dāma: jebkurš tukšs lauciņš pa diagonāli */
function findKingMoves(board, r, c, _piece) {
  const moves = [];
  for (const [dr, dc] of DIAG_DIRS) {
    let nr = r + dr;
    let nc = c + dc;
    while (inBounds(nr, nc) && isDark(nr, nc) && board[nr][nc] === 0) {
      moves.push({ from: [r, c], to: [nr, nc], captured: [] });
      nr += dr;
      nc += dc;
    }
  }
  return moves;
}

/** Bārdiņa ķer: viens lēciens 4 virzienos */
function findManJumps(board, r, c, piece, isWhiteTurn, jumped) {
  const jumps = [];
  const enemy = piece > 0 ? BLACK : WHITE;

  for (const [dr, dc] of DIAG_DIRS) {
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
      if (!isKing(piece)) {
        newPiece = promoteIfOnBackRow(piece, lr);
      }
      newBoard[lr][lc] = newPiece;
      const newJumped = new Set(jumped);
      newJumped.add(midKey);
      const more = findJumps(newBoard, lr, lc, newPiece, isWhiteTurn, newJumped);
      const cap = [[mr, mc]];
      if (more.length) {
        for (const seq of more)
          jumps.push([{ from: [r, c], to: [lr, lc], captured: cap }, ...seq]);
      } else {
        jumps.push([{ from: [r, c], to: [lr, lc], captured: cap }]);
      }
    }
  }
  return jumps;
}

/** Dāmas ķeršana: pāri vienam pretiniekam uz jebkuru tukšu lauciņu tālāk pa diagonāli */
function findKingJumps(board, r, c, piece, isWhiteTurn, jumped) {
  const jumps = [];
  const enemy = piece > 0 ? BLACK : WHITE;

  for (const [dr, dc] of DIAG_DIRS) {
    let tr = r + dr;
    let tc = c + dc;
    while (inBounds(tr, tc) && isDark(tr, tc) && board[tr][tc] === 0) {
      tr += dr;
      tc += dc;
    }
    if (!inBounds(tr, tc) || !isDark(tr, tc)) continue;
    if (getPieceColor(board[tr][tc]) !== enemy) continue;
    const midKey = `${tr},${tc}`;
    if (jumped.has(midKey)) continue;

    let lr = tr + dr;
    let lc = tc + dc;
    while (inBounds(lr, lc) && isDark(lr, lc) && board[lr][lc] === 0) {
      const newBoard = board.map((row) => row.slice());
      newBoard[r][c] = 0;
      newBoard[tr][tc] = 0;
      const newPiece = piece;
      newBoard[lr][lc] = newPiece;
      const newJumped = new Set(jumped);
      newJumped.add(midKey);
      const more = findJumps(newBoard, lr, lc, newPiece, isWhiteTurn, newJumped);
      const cap = [[tr, tc]];
      if (more.length) {
        for (const seq of more)
          jumps.push([{ from: [r, c], to: [lr, lc], captured: cap }, ...seq]);
      } else {
        jumps.push([{ from: [r, c], to: [lr, lc], captured: cap }]);
      }
      lr += dr;
      lc += dc;
    }
  }
  return jumps;
}

function findJumps(board, r, c, piece, isWhiteTurn, jumped) {
  if (isKing(piece)) {
    return findKingJumps(board, r, c, piece, isWhiteTurn, jumped);
  }
  return findManJumps(board, r, c, piece, isWhiteTurn, jumped);
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
        const m = isKing(piece)
          ? findKingMoves(board, r, c, piece)
          : findManMoves(board, r, c, piece);
        moves.push(...m);
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
        piece = promoteIfOnBackRow(piece, tr);
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

  if (isKing(piece)) {
    const dr = Math.sign(tr - fr);
    const dc = Math.sign(tc - fc);
    if (dr === 0 || dc === 0 || Math.abs(tr - fr) !== Math.abs(tc - fc)) return null;
    let rr = fr + dr;
    let cc = fc + dc;
    while (rr !== tr || cc !== tc) {
      if (newBoard[rr][cc] !== 0) return null;
      rr += dr;
      cc += dc;
    }
  }

  newBoard[fr][fc] = 0;
  let newPiece = promoteIfOnBackRow(piece, tr);
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
    (m) =>
      m.from[0] === move.from[0] &&
      m.from[1] === move.from[1] &&
      m.to[0] === move.to[0] &&
      m.to[1] === move.to[1]
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
