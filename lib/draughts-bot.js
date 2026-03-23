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
  normalizeDambreteVariant,
} from "./draughts.js";

function evaluate(board, isWhitePerspective) {
  let score = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r]?.[c] || 0;
      if (p === 0) continue;
      const mult = p > 0 ? 1 : -1;
      const pieceVal = Math.abs(p) === 2 ? 3 : 1;
      const advance = p > 0 ? r : 7 - r;
      score += mult * (pieceVal * 10 + advance * 0.5);
    }
  }
  return isWhitePerspective ? score : -score;
}

function getAllMovesFlat(board, isWhiteTurn, variant) {
  const v = normalizeDambreteVariant(variant);
  const { jumps, moves } = getAllMoves(board, isWhiteTurn, v);
  const list = [];
  if (jumps.length) {
    for (const obj of jumps) list.push(obj);
  } else {
    for (const m of moves) list.push({ from: m.from, to: m.to, captured: [] });
  }
  return list;
}

function minimax(board, depth, isWhiteTurn, alpha, beta, isMaximizing, variant) {
  const v = normalizeDambreteVariant(variant);
  const result = checkGameOver(board, isWhiteTurn, v);
  if (result.over) {
    if (result.winner === WHITE) return { score: 10000 - depth };
    if (result.winner === BLACK) return { score: -10000 + depth };
    return { score: 0 };
  }
  if (depth <= 0) return { score: evaluate(board, isMaximizing) };

  const moves = getAllMovesFlat(board, isWhiteTurn, v);
  if (moves.length === 0) return { score: evaluate(board, isMaximizing) };

  let bestMove = moves[0];
  let bestScore = isMaximizing ? -Infinity : Infinity;

  for (const move of moves) {
    const newBoard = applyMove(board, move, v);
    if (!newBoard) continue;
    const nextWhite = !isWhiteTurn;
    const { score } = minimax(
      newBoard,
      depth - 1,
      nextWhite,
      alpha,
      beta,
      !isMaximizing,
      variant
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
 * @param {string} [variant] – russian | english
 */
export function getBestDambreteMove(board, isWhiteTurn, depth = 5, variant) {
  const v = normalizeDambreteVariant(variant);
  const moves = getAllMovesFlat(board, isWhiteTurn, v);
  if (moves.length === 0) return null;
  if (moves.length === 1) return moves[0];

  const isMaximizing = isWhiteTurn;
  const { move } = minimax(
    board,
    depth,
    isWhiteTurn,
    -Infinity,
    Infinity,
    isMaximizing,
    v
  );
  return move || moves[0];
}
