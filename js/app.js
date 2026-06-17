/*
 * app.js — the controller. Owns the game state and orchestrates the engine,
 * the adaptive brain, the coach and the UI.
 *
 * Flow per player move:
 *   1. analyse the pre-move position (fixed reference strength) for grading
 *   2. apply the move, grade it, feed the adaptive brain
 *   3. update coach + stats + strength meter
 *   4. let the opponent reply at its *adaptive* strength
 *   5. refresh the vision panel for the new position
 */
(function () {
  'use strict';

  var PLAYER = Chess.WHITE;
  var AI = Chess.BLACK;
  // Reference strength used to grade the player's moves (kept constant so your
  // accuracy numbers mean the same thing as you improve).
  var REF = { depth: 3, timeMs: 700, blunderRate: 0 };
  // Lighter settings for drawing follow-up lines so the UI never freezes.
  var LINE = { depth: 2, timeMs: 200 };
  var VIS = { depth: 2, timeMs: 110 };
  var VISION_K = 4;

  var game, adaptive, coach, ui;
  var thinking = false;
  var lastAnalysis = null;   // analysis of the position the player currently faces
  var threatsOn = false;     // is the threat overlay currently shown?

  function el(id) { return document.getElementById(id); }

  function init() {
    game = new Chess();
    adaptive = new Adaptive();
    coach = new Coach();
    ui = new UI({
      getLegalTargets: legalTargets,
      onMove: onPlayerMove,
      isPlayerPiece: isPlayerPiece
    });
    wireControls();
    refreshAll();
    updateOpponentUI();
    updateProfileUI();
    // Pre-compute the opening vision so the panel isn't empty.
    scheduleVision();
  }

  function isPlayerPiece(alg) {
    if (game.turn !== PLAYER) return false;
    var p = game.board[Chess.fromAlgebraic(alg)];
    return p && Chess.colorOf(p) === PLAYER;
  }

  function legalTargets(fromAlg) {
    var from = Chess.fromAlgebraic(fromAlg);
    var moves = game.moves().filter(function (m) { return m.from === from; });
    return moves.map(function (m) {
      return {
        to: Chess.algebraic(m.to),
        capture: m.flags.indexOf('c') >= 0 || m.flags.indexOf('e') >= 0,
        promotion: !!m.promotion,
        color: PLAYER
      };
    });
  }

  function onPlayerMove(fromAlg, toAlg, promotion) {
    if (thinking || game.turn !== PLAYER) return;
    var move = game.findMove(fromAlg, toAlg, promotion);
    if (!move) return;

    setThinking(true, 'Analysing your move…');
    // Defer so the status text paints before the (blocking) search runs.
    setTimeout(function () {
      var analysis = lastAnalysis || coach.analyse(game, REF);
      var grade = coach.grade(analysis, move);

      // Build the "what flawless looked like" line from the pre-move position.
      var bestLineSans = grade.best ? coach.line(game, grade.best.move, 3, LINE) : [];

      // Apply the player's move.
      game.makeMove(move);
      ui.clearHint();
      clearMarks();
      render({ from: fromAlg, to: toAlg });

      // Feed the adaptive brain and refresh coaching panels.
      var acc = adaptive.recordMove(grade.cpLoss, grade.wasBest, grade.hadChoice);
      showFeedback(grade, bestLineSans, acc);
      updateOpponentUI();
      updateProfileUI();

      if (checkGameOver()) { setThinking(false); return; }

      // Opponent replies at adaptive strength.
      setThinking(true, adaptive.levelInfo().name + ' is thinking…');
      setTimeout(opponentMove, 30);
    }, 20);
  }

  function opponentMove() {
    var opts = adaptive.engineOptions();
    var result = Engine.search(game, opts);
    if (!result.chosen) { setThinking(false); return; }
    var mv = result.chosen.move;
    var fromAlg = Chess.algebraic(mv.from), toAlg = Chess.algebraic(mv.to);
    game.makeMove(mv);
    clearMarks();
    render({ from: fromAlg, to: toAlg });

    if (checkGameOver()) { setThinking(false); return; }

    setThinking(false);
    setStatus('Your move. ' + (game.inCheck() ? 'You are in check!' : ''));
    // Pre-analyse the new position for instant grading + vision.
    scheduleAnalysisAndVision();
  }

  // Analyse the position the player now faces (used for next-move grading and
  // the vision panel). Done in the background so the UI stays responsive.
  function scheduleAnalysisAndVision() {
    setTimeout(function () {
      lastAnalysis = coach.analyse(game, REF);
      renderVision(lastAnalysis);
    }, 20);
  }

  function scheduleVision() {
    setTimeout(function () {
      lastAnalysis = coach.analyse(game, REF);
      renderVision(lastAnalysis);
    }, 20);
  }

  function renderVision(analysis) {
    var list = el('visionList');
    list.innerHTML = '';
    if (!el('visionToggle').checked || game.turn !== PLAYER) {
      list.innerHTML = '<li class="hint-text">Vision hidden — toggle it on to see possible futures.</li>';
      return;
    }
    var vision = coach.vision(game, analysis, VISION_K, VIS);
    vision.forEach(function (v, i) {
      var li = document.createElement('li');
      li.className = 'vision-item';
      li.innerHTML =
        '<span class="vision-rank">' + (i + 1) + '</span>' +
        '<span class="vision-move">' + v.san + '</span>' +
        '<span class="vision-eval">' + v.eval + '</span>' +
        '<span class="vision-line">' + v.line.slice(1).join(' ') + '</span>';
      li.addEventListener('click', function () {
        ui.showHint(Chess.algebraic(v.move.from), Chess.algebraic(v.move.to));
      });
      list.appendChild(li);
    });
  }

  function showFeedback(grade, bestLineSans, acc) {
    el('feedbackCard').className = 'card move-feedback';
    var badge = el('gradeBadge');
    badge.className = 'grade ' + grade.grade;
    badge.textContent = grade.grade.toUpperCase();

    var text = grade.label + ' (accuracy ' + acc + '%';
    if (grade.cpLoss > 0) text += ', −' + grade.cpLoss + 'cp';
    text += ').';
    el('feedbackText').textContent = text;

    var lineEl = el('bestLine');
    if (grade.wasBest) {
      lineEl.innerHTML = '<span class="arrow">✓ best line:</span> ' + bestLineSans.join(' ');
    } else if (grade.best) {
      lineEl.innerHTML = '<span class="arrow">Flawless was:</span> ' + bestLineSans.join(' ');
      // Draw an arrow showing the move you could have played.
      ui.showHint(Chess.algebraic(grade.best.move.from), Chess.algebraic(grade.best.move.to));
    } else {
      lineEl.textContent = '';
    }
  }

  function checkGameOver() {
    if (!game.isGameOver()) return false;
    var result, msg;
    if (game.isCheckmate()) {
      if (game.turn === PLAYER) { result = 'loss'; msg = 'Checkmate — you lost this one. Study the lines and go again.'; }
      else { result = 'win'; msg = 'Checkmate — you won! The bot just got tougher.'; }
    } else {
      result = 'draw'; msg = 'Draw. Solid defending.';
    }
    adaptive.recordResult(result);
    setStatus(msg, result === 'win' ? 'win' : (result === 'loss' ? 'loss' : ''));
    updateOpponentUI();
    updateProfileUI();
    el('visionList').innerHTML = '<li class="hint-text">Game over. Hit New Game to keep training.</li>';
    return true;
  }

  // ---- UI helpers ----
  function render(lastMove) { ui.render(game.grid(), lastMove); }
  function refreshAll() { render(null); }

  function setStatus(text, cls) {
    var s = el('status');
    s.textContent = text;
    s.className = 'status ' + (cls || '');
  }

  function setThinking(on, text) {
    thinking = on;
    if (on) { ui.lock(); if (text) setStatus(text); }
    else ui.unlock();
  }

  function updateOpponentUI() {
    var info = adaptive.levelInfo();
    el('levelBadge').textContent = info.name;
    var pct = Math.round(((adaptive.profile.level) / (Adaptive.LEVELS.length - 1)) * 100);
    el('strengthFill').style.width = Math.max(8, pct) + '%';
    el('insight').textContent = adaptive.insight();
  }

  function updateProfileUI() {
    var p = adaptive.profile;
    el('statAcc').textContent = adaptive.avgAccuracy() + '%';
    el('statGames').textContent = p.gamesPlayed;
    el('statRecord').textContent = p.wins + '-' + p.losses + '-' + p.draws;
    el('statStreak').textContent = p.bestStreak;
    el('statBlunders').textContent = p.blunders;
    el('statBrilliant').textContent = p.brilliant;
  }

  // Wipe planning marks (used whenever the position changes).
  function clearMarks() {
    threatsOn = false;
    var t = el('threats'); if (t) t.classList.remove('active');
    ui.clearAnnotations();
  }

  // Highlight every player piece under attack and draw arrows from each
  // attacker — "what can eat my stuff".
  function showThreats() {
    ui.clearAnnotations();
    var RED = '#e0625e';
    var them = PLAYER === Chess.WHITE ? Chess.BLACK : Chess.WHITE;
    var count = 0;
    for (var i = 0; i < 128; i++) {
      if (i & 0x88) { i += 7; continue; }
      var p = game.board[i];
      if (!p || Chess.colorOf(p) !== PLAYER) continue;
      var attackers = game.attackersOf(them, i);
      if (attackers.length) {
        count++;
        ui.markSquare(Chess.algebraic(i), RED);
        attackers.forEach(function (a) {
          ui.markArrow(Chess.algebraic(a), Chess.algebraic(i), RED);
        });
      }
    }
    ui.redrawAnnotations();
    if (count === 0) setStatus('No pieces under attack right now — you are safe. Look for YOUR captures instead.');
    else setStatus(count + ' of your piece(s) can be captured. Red arrows show the attackers — are they defended?');
  }

  function wireControls() {
    el('newGame').addEventListener('click', function () {
      game = new Chess();
      lastAnalysis = null;
      ui.clearHint();
      ui.clearSelection();
      clearMarks();
      setThinking(false);
      refreshAll();
      setStatus('New game. White to play — that is you.');
      scheduleVision();
      updateOpponentUI();
    });

    el('undo').addEventListener('click', function () {
      if (thinking) return;
      // Undo one full move pair (AI reply + your move) so it's your turn again.
      if (game.history.length >= 1 && game.turn === PLAYER) game.undoMove();
      if (game.history.length >= 1) game.undoMove();
      lastAnalysis = null;
      ui.clearHint();
      ui.clearSelection();
      clearMarks();
      var lm = game.history.length
        ? lastMoveFromHistory()
        : null;
      render(lm);
      setStatus('Took it back. Your move.');
      scheduleVision();
    });

    el('flip').addEventListener('click', function () {
      ui.setOrientation(ui.orientation === 'w' ? 'b' : 'w');
      render(ui.lastMove);
    });

    el('hint').addEventListener('click', function () {
      if (thinking || game.turn !== PLAYER) return;
      var a = lastAnalysis || coach.analyse(game, REF);
      lastAnalysis = a;
      if (a.best) ui.showHint(Chess.algebraic(a.best.move.from), Chess.algebraic(a.best.move.to));
      setStatus('Hint: follow the arrow — but try to see why.');
    });

    el('visionToggle').addEventListener('change', function () {
      if (lastAnalysis) renderVision(lastAnalysis); else scheduleVision();
    });

    el('resetProfile').addEventListener('click', function () {
      if (confirm('Reset all learning and stats? This cannot be undone.')) {
        adaptive.reset();
        updateOpponentUI();
        updateProfileUI();
        setStatus('Profile reset. Back to Beginner Bot.');
      }
    });

    // --- planning / annotation controls ---
    el('drawToggle').addEventListener('click', function () {
      var on = !ui.drawMode;
      ui.setDrawMode(on);
      el('drawToggle').classList.toggle('active', on);
      if (on) setStatus('Draw mode ON — drag to draw arrows, tap a square to highlight. Tap Draw again to play.');
      else setStatus('Draw mode off. Your move.');
    });

    el('threats').addEventListener('click', function () {
      if (thinking) return;
      threatsOn = !threatsOn;
      el('threats').classList.toggle('active', threatsOn);
      if (threatsOn) showThreats();
      else ui.clearAnnotations();
    });

    el('clearAnno').addEventListener('click', function () {
      threatsOn = false;
      el('threats').classList.remove('active');
      ui.clearAnnotations();
    });

    el('swatches').addEventListener('click', function (e) {
      var btn = e.target.closest('.swatch');
      if (!btn) return;
      ui.setDrawColor(btn.dataset.color);
      el('swatches').querySelectorAll('.swatch').forEach(function (s) { s.classList.remove('selected'); });
      btn.classList.add('selected');
      if (!ui.drawMode) { ui.setDrawMode(true); el('drawToggle').classList.add('active'); }
    });
  }

  function lastMoveFromHistory() {
    var u = game.history[game.history.length - 1];
    if (!u) return null;
    return { from: Chess.algebraic(u.move.from), to: Chess.algebraic(u.move.to) };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
