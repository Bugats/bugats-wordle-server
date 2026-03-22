/**
 * Šaha AI – minimax ar alpha-beta, izmanto chess.js
 * depth: 2 = vājš, 3 = vidējs, 4 = spēcīgs
 */
import { Chess } from "chess.js";

function evaluatePosition(chess) {
  if (chess.isCheckmate()) return chess.turn() === "w" ? -10000 : 10000;
  if (chess.isDraw()) return 0;
  const pieceValues = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  let score = 0;
  const board = chess.board();
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r]?.[c];
      if (!piece) continue;
      const val = pieceValues[piece.type] || 0;
      const mult = piece.color === "w" ? 1 : -1;
      score += mult * val;
    }
  }
  return score;
}

function minimax(chess, depth, alpha, beta, isMaximizing) {
  if (depth <= 0) return { score: evaluatePosition(chess) };
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) return { score: evaluatePosition(chess) };

  let bestMove = moves[0];
  let bestScore = isMaximizing ? -Infinity : Infinity;

  for (const m of moves) {
    const copy = new Chess(chess.fen());
    copy.move(m);
    const { score } = minimax(copy, depth - 1, alpha, beta, !isMaximizing);
    if (isMaximizing) {
      if (score > bestScore) {
        bestScore = score;
        bestMove = m;
      }
      alpha = Math.max(alpha, bestScore);
    } else {
      if (score < bestScore) {
        bestScore = score;
        bestMove = m;
      }
      beta = Math.min(beta, bestScore);
    }
    if (beta <= alpha) break;
  }
  return { score: bestScore, move: bestMove };
}

/**
 * Atgriež labāko gājienu (SAN string). depth: 2 vājš, 3 vidējs, 4 spēcīgs.
 */
export function getBestChessMove(fen, depth = 3) {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) return null;
  if (moves.length === 1) return moves[0].san;

  const isMaximizing = chess.turn() === "w";
  const { move } = minimax(chess, depth, -Infinity, Infinity, isMaximizing);
  return move?.san || moves[0].san;
}
