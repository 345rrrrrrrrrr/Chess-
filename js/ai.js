/*
 * ai.js — minimax + alpha-beta search with an adjustable "strength" dial.
 *
 * The engine exposes Engine.search(chess, options) returning the best move
 * plus a scored, ranked list of candidate moves (used by the coach / vision
 * trainer). Strength is controlled by:
 *   - depth: how many plies it looks ahead
 *   - blunderRate: probability of deliberately not picking the best move
 *
 * Scores are in centipawns from White's perspective inside evaluate(), but
 * search() always returns scores from the side-to-move's perspective.
 */
(function (global) {
  'use strict';

  var typeOf = Chess.typeOf, colorOf = Chess.colorOf, file = Chess.file, rank = Chess.rank;

  var VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };
  var MATE = 1000000;

  // Piece-square tables (from White's view, a1 = index 0 of the flat list
  // below where rank 1 is the FIRST row). We index by rank*8+file.
  var PST = {
    p: [
      0, 0, 0, 0, 0, 0, 0, 0,
      5, 10, 10, -20, -20, 10, 10, 5,
      5, -5, -10, 0, 0, -10, -5, 5,
      0, 0, 0, 20, 20, 0, 0, 0,
      5, 5, 10, 25, 25, 10, 5, 5,
      10, 10, 20, 30, 30, 20, 10, 10,
      50, 50, 50, 50, 50, 50, 50, 50,
      0, 0, 0, 0, 0, 0, 0, 0
    ],
    n: [
      -50, -40, -30, -30, -30, -30, -40, -50,
      -40, -20, 0, 5, 5, 0, -20, -40,
      -30, 5, 10, 15, 15, 10, 5, -30,
      -30, 0, 15, 20, 20, 15, 0, -30,
      -30, 5, 15, 20, 20, 15, 5, -30,
      -30, 0, 10, 15, 15, 10, 0, -30,
      -40, -20, 0, 0, 0, 0, -20, -40,
      -50, -40, -30, -30, -30, -30, -40, -50
    ],
    b: [
      -20, -10, -10, -10, -10, -10, -10, -20,
      -10, 5, 0, 0, 0, 0, 5, -10,
      -10, 10, 10, 10, 10, 10, 10, -10,
      -10, 0, 10, 10, 10, 10, 0, -10,
      -10, 5, 5, 10, 10, 5, 5, -10,
      -10, 0, 5, 10, 10, 5, 0, -10,
      -10, 0, 0, 0, 0, 0, 0, -10,
      -20, -10, -10, -10, -10, -10, -10, -20
    ],
    r: [
      0, 0, 0, 5, 5, 0, 0, 0,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      5, 10, 10, 10, 10, 10, 10, 5,
      0, 0, 0, 0, 0, 0, 0, 0
    ],
    q: [
      -20, -10, -10, -5, -5, -10, -10, -20,
      -10, 0, 0, 0, 0, 5, 0, -10,
      -10, 0, 5, 5, 5, 5, 5, -10,
      -5, 0, 5, 5, 5, 5, 0, -5,
      -5, 0, 5, 5, 5, 5, 0, -5,
      -10, 0, 5, 5, 5, 5, 0, -10,
      -10, 0, 0, 0, 0, 0, 0, -10,
      -20, -10, -10, -5, -5, -10, -10, -20
    ],
    k: [
      20, 30, 10, 0, 0, 10, 30, 20,
      20, 20, 0, 0, 0, 0, 20, 20,
      -10, -20, -20, -20, -20, -20, -20, -10,
      -20, -30, -30, -40, -40, -30, -30, -20,
      -30, -40, -40, -50, -50, -40, -40, -30,
      -30, -40, -40, -50, -50, -40, -40, -30,
      -30, -40, -40, -50, -50, -40, -40, -30,
      -30, -40, -40, -50, -50, -40, -40, -30
    ]
  };

  function pstValue(type, sq0x88, white) {
    var f = file(sq0x88), r = rank(sq0x88);
    var idx = white ? (r * 8 + f) : ((7 - r) * 8 + f);
    return PST[type][idx];
  }

  // Static evaluation in centipawns, positive = good for White.
  function evaluate(chess) {
    var score = 0;
    for (var i = 0; i < 128; i++) {
      if (i & 0x88) { i += 7; continue; }
      var p = chess.board[i];
      if (!p) continue;
      var t = typeOf(p);
      var white = colorOf(p) === Chess.WHITE;
      var v = VALUES[t] + pstValue(t, i, white);
      score += white ? v : -v;
    }
    return score;
  }

  // Order moves so captures (and promotions) are searched first — this makes
  // alpha-beta pruning dramatically more effective.
  function orderMoves(chess, moves) {
    return moves.map(function (m) {
      var s = 0;
      var victim = chess.board[m.to];
      if (victim) s += 10 * VALUES[typeOf(victim)] - VALUES[typeOf(chess.board[m.from])];
      if (m.promotion) s += VALUES[m.promotion];
      return { m: m, s: s };
    }).sort(function (a, b) { return b.s - a.s; }).map(function (x) { return x.m; });
  }

  // Quiescence search: only explore captures so the eval isn't fooled by an
  // imminent recapture (the "horizon effect").
  function quiesce(chess, alpha, beta, sideSign) {
    var standPat = sideSign * evaluate(chess);
    if (standPat >= beta) return beta;
    if (standPat > alpha) alpha = standPat;

    var caps = orderMoves(chess, chess.moves().filter(function (m) {
      return m.flags.indexOf('c') >= 0 || m.flags.indexOf('e') >= 0 || m.promotion;
    }));
    for (var i = 0; i < caps.length; i++) {
      chess.makeMove(caps[i]);
      var score = -quiesce(chess, -beta, -alpha, -sideSign);
      chess.undoMove();
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  // Negamax with alpha-beta. Returns score from the side-to-move perspective.
  function negamax(chess, depth, alpha, beta, sideSign, deadline) {
    if (Date.now() > deadline) return sideSign * evaluate(chess);

    var moves = chess.moves();
    if (moves.length === 0) {
      if (chess.inCheck()) return -MATE - depth; // prefer faster mates
      return 0; // stalemate
    }
    if (chess.halfmoves >= 100) return 0;
    if (depth === 0) return quiesce(chess, alpha, beta, sideSign);

    moves = orderMoves(chess, moves);
    var best = -Infinity;
    for (var i = 0; i < moves.length; i++) {
      chess.makeMove(moves[i]);
      var score = -negamax(chess, depth - 1, -beta, -alpha, -sideSign, deadline);
      chess.undoMove();
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  // Root search: scores every legal move so callers can rank candidates.
  // options: { depth, blunderRate, timeMs }
  function search(chess, options) {
    options = options || {};
    var depth = Math.max(1, options.depth || 2);
    var timeMs = options.timeMs || 1500;
    var deadline = Date.now() + timeMs;
    var sideSign = chess.turn === Chess.WHITE ? 1 : -1;

    var moves = orderMoves(chess, chess.moves());
    var scored = [];
    var alpha = -Infinity, beta = Infinity;
    for (var i = 0; i < moves.length; i++) {
      chess.makeMove(moves[i]);
      var score = -negamax(chess, depth - 1, -beta, -alpha, -sideSign, deadline);
      chess.undoMove();
      scored.push({ move: moves[i], score: score, san: chess.toSan(moves[i]) });
    }
    scored.sort(function (a, b) { return b.score - a.score; });

    // Pick a move according to the blunder rate. A "blunder" means choosing a
    // weaker (but still legal) move on purpose so weaker players can win.
    var chosen = scored[0];
    var blunderRate = options.blunderRate || 0;
    if (blunderRate > 0 && scored.length > 1 && Math.random() < blunderRate) {
      // Bias toward near-best moves: weight by rank so it rarely throws the game.
      var pool = scored.slice(1, Math.min(scored.length, 1 + Math.ceil(blunderRate * 6)));
      chosen = pool[Math.floor(Math.random() * pool.length)] || scored[0];
    }

    return {
      best: scored[0],          // objectively best move found
      chosen: chosen,           // move the AI will actually play
      candidates: scored,       // all moves, ranked best-first
      depth: depth
    };
  }

  global.Engine = {
    evaluate: evaluate,
    search: search,
    quiesce: quiesce,
    VALUES: VALUES,
    MATE: MATE
  };
})(typeof window !== 'undefined' ? window : this);
