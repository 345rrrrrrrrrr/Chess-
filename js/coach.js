/*
 * coach.js — turns raw engine output into human coaching.
 *
 * After each of the player's moves it answers: how good was that? What was the
 * best move? How much did it cost? And it produces the ranked "vision" lines
 * (your candidate endings) so you can train your prediction.
 */
(function (global) {
  'use strict';

  function Coach() {}

  // Analyse a position BEFORE the player moves, returning candidates ranked by
  // the engine. Reused for both the coach and the vision trainer.
  Coach.prototype.analyse = function (chess, options) {
    return Engine.search(chess, options);
  };

  // Given the analysis of the position the player faced and the move they
  // actually made, grade it.
  //   analysis: result of Engine.search() on the pre-move position
  //   playedMove: the move object the player chose
  Coach.prototype.grade = function (analysis, playedMove) {
    var best = analysis.best;
    var played = null;
    for (var i = 0; i < analysis.candidates.length; i++) {
      var c = analysis.candidates[i];
      if (c.move.from === playedMove.from && c.move.to === playedMove.to &&
        (c.move.promotion || 'q') === (playedMove.promotion || 'q')) {
        played = c;
        break;
      }
    }
    // Scores are from the side-to-move (the player) perspective, higher better.
    var bestScore = best ? best.score : 0;
    var playedScore = played ? played.score : bestScore;
    var cpLoss = Math.max(0, bestScore - playedScore);

    var wasBest = played && best && played.move.from === best.move.from &&
      played.move.to === best.move.to;
    var hadChoice = analysis.candidates.length > 1 &&
      (analysis.candidates[0].score - analysis.candidates[analysis.candidates.length - 1].score) > 40;

    return {
      cpLoss: cpLoss,
      wasBest: wasBest,
      hadChoice: hadChoice,
      best: best,
      played: played,
      label: this.label(cpLoss, wasBest, hadChoice),
      grade: this.gradeClass(cpLoss, wasBest, hadChoice)
    };
  };

  Coach.prototype.gradeClass = function (cpLoss, wasBest, hadChoice) {
    if (wasBest && hadChoice) return 'brilliant';
    if (cpLoss <= 20) return 'best';
    if (cpLoss <= 50) return 'good';
    if (cpLoss <= 100) return 'inaccuracy';
    if (cpLoss <= 200) return 'mistake';
    return 'blunder';
  };

  Coach.prototype.label = function (cpLoss, wasBest, hadChoice) {
    var g = this.gradeClass(cpLoss, wasBest, hadChoice);
    return {
      brilliant: 'Brilliant! You found the best move.',
      best: 'Best move — flawless.',
      good: 'Good move.',
      inaccuracy: 'Inaccuracy — there was something a little better.',
      mistake: 'Mistake — that gave away real ground.',
      blunder: 'Blunder — that was costly. See the better line below.'
    }[g];
  };

  // Build a short principal-variation string by letting the engine reply a few
  // plies deep from a given move. This is the "what could have happened" line.
  Coach.prototype.line = function (chess, firstMove, plies, options) {
    options = options || {};
    var depth = Math.min(options.depth || 2, 3);
    var timeMs = options.timeMs || 250;
    var sans = [];
    var line = [];
    chess.makeMove(firstMove);
    line.push(firstMove);
    sans.push(this.sanBefore(chess, firstMove, true));
    for (var i = 0; i < plies; i++) {
      if (chess.isGameOver()) break;
      var r = Engine.search(chess, { depth: depth, timeMs: timeMs });
      if (!r.best) break;
      var mv = r.best.move;
      var san = r.best.san;
      chess.makeMove(mv);
      line.push(mv);
      sans.push(san);
    }
    // unwind
    for (var j = line.length - 1; j >= 0; j--) chess.undoMove();
    return sans;
  };

  // SAN of a move that was just made (we already pushed it); recompute by
  // unmaking, generating SAN, remaking.
  Coach.prototype.sanBefore = function (chess, move) {
    chess.undoMove();
    var san = chess.toSan(move);
    chess.makeMove(move);
    return san;
  };

  // Produce the vision-trainer payload: top-K candidate moves with their
  // evaluations and a one-line follow-up, formatted for display.
  Coach.prototype.vision = function (chess, analysis, k, options) {
    var out = [];
    var top = analysis.candidates.slice(0, k);
    for (var i = 0; i < top.length; i++) {
      var c = top[i];
      out.push({
        san: c.san,
        move: c.move,
        score: c.score,
        eval: this.evalText(c.score),
        line: this.line(chess, c.move, 2, options)
      });
    }
    return out;
  };

  Coach.prototype.evalText = function (score) {
    if (score > Engine.MATE - 1000) return '#+';
    if (score < -(Engine.MATE - 1000)) return '#-';
    var pawns = score / 100;
    return (pawns >= 0 ? '+' : '') + pawns.toFixed(2);
  };

  global.Coach = Coach;
})(typeof window !== 'undefined' ? window : this);
