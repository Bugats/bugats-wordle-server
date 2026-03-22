/**
 * Dambrete AI – minimax ar alpha-beta
 * depth: 3 = vājš, 5 = vidējs, 7 = spēcīgs
 */
import {
  getAllMoves,
  applyMove,
  checkGameOver,
  WHITE,
  BLACK,
} from "./draughts.js";

function evaluate(board, isWhitePerspective) {
  let score = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r]?.[c] || 0;
      if (p === 0) continue;
      const mult = p > 0 ? 1 : -1;
      const pieceVal = Math.abs(p) === 2 ? 3 : 1; // dāma vērtīgāka
      const advance = p > 0 ? r : 7 - r; // virzība uz promociju
      score += mult * (pieceVal * 10 + advance * 0.5);
    }
  }
  return isWhitePerspective ? score : -score;
}

function getAllMovesFlat(board, isWhiteTurn) {
  const { jumps, moves } = getAllMoves(board, isWhiteTurn);
  const list = [];
  if (jumps.length) {
    for (const obj of jumps) list.push(obj); // { jumps: seq } - each has .jumps array
  } else {
    for (const m of moves) list.push({ from: m.from, to: m.to, captured: [] });
  }
  return list;
}

function minimax(board, depth, isWhiteTurn, alpha, beta, isMaximizing) {
  const result = checkGameOver(board, isWhiteTurn);
  if (result.over) {
    if (result.winner === WHITE) return { score: 10000 - depth };
    if (result.winner === BLACK) return { score: -10000 + depth };
    return { score: 0 };
  }
  if (depth <= 0) return { score: evaluate(board, isMaximizing) };

  const moves = getAllMovesFlat(board, isWhiteTurn);
  if (moves.length === 0) return { score: evaluate(board, isMaximizing) };

  let bestMove = moves[0];
  let bestScore = isMaximizing ? -Infinity : Infinity;

  for (const move of moves) {
    const newBoard = applyMove(board, move);
    if (!newBoard) continue;
    const nextWhite = !isWhiteTurn;
    const { score } = minimax(
      newBoard,
      depth - 1,
      nextWhite,
      alpha,
      beta,
      !isMaximizing
    );
    if (isMaximizing) {
      if (score > bestScore) {
        bestScore = score;
        bestMove = move;
      }
      alpha = Math.max(alpha, bestScore);
    } else {
      if (score < bestScore) {
        bestScore = score;
        bestMove = move;
      }
      beta = Math.min(beta, bestScore);
    }
    if (beta <= alpha) break;
  }

  return { score: bestScore, move: bestMove };
}

/**
 * Atgriež labāko gājienu botam. Bot spēlē par black (index 1) vai white (index 0).
 * @param {number[][]} board
 * @param {boolean} isWhiteTurn – vai tagad baltā gājiens
 * @param {number} depth – 3 vājš, 5 vidējs, 7 spēcīgs
 */
export function getBestDambreteMove(board, isWhiteTurn, depth = 5) {
  const moves = getAllMovesFlat(board, isWhiteTurn);
  if (moves.length === 0) return null;
  if (moves.length === 1) return moves[0];

  const isMaximizing = isWhiteTurn; // white maksimizē
  const { move } = minimax(
    board,
    depth,
    isWhiteTurn,
    -Infinity,
    Infinity,
    isMaximizing
  );
  return move || moves[0];
}
