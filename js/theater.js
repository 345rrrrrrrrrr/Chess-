/*
 * theater.js — the "Vision Theater".
 *
 * A grid of boards, each playing a DIFFERENT engine-vs-engine game slowly and
 * endlessly. Watch hundreds of games flow by; tap any board to study it move
 * by move, or switch on Predict mode to guess each move before it happens and
 * "play the game in your mind".
 *
 * Self-contained: the engine plays both sides. Games are diversified with
 * randomized opening moves and temperature sampling so no two look alike.
 */
(function (global) {
  'use strict';

  var GLYPH = {
    P: '♙', N: '♘', B: '♗', R: '♖', Q: '♕', K: '♔',
    p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚'
  };

  var GEN = { depth: 2, timeMs: 50, sans: false }; // engine settings while generating games
  var MAXPLY = 50;                        // cap a game's length
  var DECISIVE = 900;                     // |eval| at which we adjudicate a win

  // ---- game generation ---------------------------------------------------

  // Softmax-sample a move from the engine's ranked candidates. Early plies use
  // a high "temperature" (lots of variety in the opening); later plies stay
  // sharp so games look reasonable.
  function pickMove(candidates, ply) {
    var poolSize = ply < 4 ? Math.min(8, candidates.length)
      : ply < 10 ? Math.min(4, candidates.length)
        : Math.min(3, candidates.length);
    var pool = candidates.slice(0, poolSize);
    var tau = ply < 4 ? 220 : ply < 10 ? 130 : 80; // centipawns
    var best = pool[0].score;
    var weights = pool.map(function (c) { return Math.exp((c.score - best) / tau); });
    var sum = weights.reduce(function (a, b) { return a + b; }, 0);
    var r = Math.random() * sum;
    for (var i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) return pool[i];
    }
    return pool[0];
  }

  // Generate one complete game. Returns recorded moves + a result tag.
  function generateGame() {
    var g = new Chess();
    var moves = [];
    for (var ply = 0; ply < MAXPLY && !g.isGameOver(); ply++) {
      var res = Engine.search(g, GEN);
      if (!res.candidates.length) break;
      var pick = pickMove(res.candidates, ply);
      moves.push({
        from: Chess.algebraic(pick.move.from),
        to: Chess.algebraic(pick.move.to),
        promotion: pick.move.promotion || null,
        san: g.toSan(pick.move),   // SAN only for the chosen move (cheap)
        score: pick.score
      });
      g.makeMove(pick.move);
      // Adjudicate clearly decided games early so we don't watch dead positions.
      if (Math.abs(pick.score) > DECISIVE && ply > 10) break;
    }
    return { moves: moves, result: resultOf(g, moves) };
  }

  function resultOf(g, moves) {
    if (g.isCheckmate()) {
      // side to move is mated -> the other side won
      return g.turn === Chess.WHITE ? { text: '0-1', cls: 'black-win' }
        : { text: '1-0', cls: 'white-win' };
    }
    if (g.isStalemate() || g.isDraw()) return { text: '½-½', cls: 'draw' };
    var last = moves[moves.length - 1];
    if (last && Math.abs(last.score) > DECISIVE) {
      // score is from the perspective of the side that just moved
      var whiteAhead = (g.turn === Chess.WHITE) ? (last.score < 0) : (last.score > 0);
      return whiteAhead ? { text: '1-0', cls: 'white-win' } : { text: '0-1', cls: 'black-win' };
    }
    return { text: '…', cls: 'ongoing' };
  }

  // Replay a recorded game up to `ply` half-moves; return a Chess position.
  // Accepts either a moves array or a { moves } game object.
  function replayTo(rec, ply) {
    var moves = rec.moves || rec;
    var g = new Chess();
    var last = null;
    for (var i = 0; i < ply && i < moves.length; i++) {
      var m = g.findMove(moves[i].from, moves[i].to, moves[i].promotion);
      if (!m) break;
      g.makeMove(m);
      last = moves[i];
    }
    return { game: g, last: last };
  }

  // ---- rendering ---------------------------------------------------------

  // Build the inner HTML for an 8x8 board (fast string build for mini-boards).
  function boardHTML(grid, last) {
    var html = '';
    for (var r = 7; r >= 0; r--) {
      for (var f = 0; f < 8; f++) {
        var alg = 'abcdefgh'[f] + (r + 1);
        var dark = (r + f) % 2 === 0;
        var cls = 'tsq ' + (dark ? 'd' : 'l');
        if (last && (last.from === alg || last.to === alg)) cls += ' lm';
        var p = grid[7 - r][f];
        html += '<div class="' + cls + '">' + (p ? GLYPH[p] : '') + '</div>';
      }
    }
    return html;
  }

  // expose for testing / reuse
  global.Theater = {
    generateGame: generateGame,
    replayTo: replayTo,
    boardHTML: boardHTML,
    pickMove: pickMove,
    GLYPH: GLYPH
  };

  // The interactive app boots only in a browser (see theater-ui.js wiring at
  // the bottom of this file once DOM is present).
  if (typeof document !== 'undefined') {
    global.TheaterApp = makeApp();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { global.TheaterApp.init(); });
    } else {
      global.TheaterApp.init();
    }
  }

  // ---- interactive controller -------------------------------------------

  function makeApp() {
    var boards = [];        // [{rec, ply, holding}]
    var timer = null;
    var tickMs = 1300;
    var boardCount = 12;
    var running = true;
    var focus = null;       // { rec, ply, predict, predScore, predTotal, sel }
    var generator = null;   // worker-pool (or fallback) game source
    var batchId = 0;        // bumps on New Batch / board-count change to drop stale games

    function el(id) { return document.getElementById(id); }

    function init() {
      boardCount = parseInt(el('boardCount').value, 10) || 12;
      tickMs = parseInt(el('speed').value, 10) || 1300;
      generator = createGenerator();
      el('engineMode').textContent = generator.mode;
      buildGrid();
      wire();
      startBatch();
      loop();

      // Watchdog: if workers fail silently (some browsers / file://), no game
      // ever arrives. After a few seconds with nothing rendered, drop to
      // main-thread generation so the theater always works.
      setTimeout(function () {
        var any = boards.some(function (b) { return b.rec; });
        if (!any && generator.mode.indexOf('worker') >= 0) {
          generator = {
            mode: 'main thread (fallback)',
            request: function (cb) { setTimeout(function () { cb(generateGame()); }, 0); }
          };
          el('engineMode').textContent = generator.mode;
          startBatch();
        }
      }, 4500);
    }

    // Game source: a pool of Web Workers when available (keeps the UI smooth),
    // otherwise main-thread generation in a yielding setTimeout. Both expose
    // request(cb) and resolve callbacks FIFO.
    function createGenerator() {
      var queue = [];   // pending callbacks, resolved in arrival order
      var workers = [];
      try {
        var n = Math.max(1, Math.min(4, (global.navigator && navigator.hardwareConcurrency) || 2));
        for (var i = 0; i < n; i++) {
          var w = new Worker('js/theater-worker.js');
          w.onmessage = function (e) { var cb = queue.shift(); if (cb) cb(e.data); };
          w.onerror = function () { /* fall back silently for this request */ };
          workers.push(w);
        }
      } catch (err) { workers = []; }

      if (workers.length) {
        var rr = 0;
        return {
          mode: workers.length + ' background workers',
          request: function (cb) {
            queue.push(cb);
            workers[rr % workers.length].postMessage('gen');
            rr++;
          }
        };
      }
      // Fallback: generate on the main thread, yielding so the page survives.
      return {
        mode: 'main thread',
        request: function (cb) { setTimeout(function () { cb(generateGame()); }, 0); }
      };
    }

    function wire() {
      el('playPause').addEventListener('click', function () {
        running = !running;
        el('playPause').textContent = running ? '⏸ Pause' : '▶ Play';
      });
      el('newBatch').addEventListener('click', startBatch);
      el('speed').addEventListener('input', function () {
        tickMs = parseInt(el('speed').value, 10);
        el('speedLabel').textContent = (tickMs / 1000).toFixed(1) + 's/move';
        if (timer) { clearInterval(timer); loop(); }
      });
      el('boardCount').addEventListener('change', function () {
        boardCount = parseInt(el('boardCount').value, 10);
        buildGrid();
        startBatch();
      });
      el('focusClose').addEventListener('click', closeFocus);
      el('focusPrev').addEventListener('click', function () { stepFocus(-1); });
      el('focusNext').addEventListener('click', focusNext);
      el('focusStart').addEventListener('click', function () { focus.ply = 0; focus.sel = null; renderFocus(); });
      el('predictToggle').addEventListener('click', togglePredict);
    }

    function buildGrid() {
      var grid = el('grid');
      grid.innerHTML = '';
      grid.style.setProperty('--cols', Math.min(boardCount, columnsFor(boardCount)));
      boards = [];
      for (var i = 0; i < boardCount; i++) {
        var cell = document.createElement('div');
        cell.className = 'mini';
        cell.innerHTML =
          '<div class="mini-board" id="mb' + i + '"></div>' +
          '<div class="mini-meta"><span class="mini-move" id="mm' + i + '">generating…</span>' +
          '<span class="mini-result" id="mr' + i + '"></span></div>';
        cell.addEventListener('click', openFocus.bind(null, i));
        grid.appendChild(cell);
        boards.push({ rec: null, ply: 0, holding: 0 });
      }
    }

    function columnsFor(n) { return n <= 6 ? 3 : n <= 12 ? 4 : 5; }

    // Request the next batch of games. The generator (worker pool or
    // main-thread fallback) streams games back; boards fill in as they arrive.
    function startBatch() {
      batchId++;
      for (var i = 0; i < boards.length; i++) {
        boards[i] = { rec: null, ply: 0, holding: 0, awaiting: true };
        var mm = document.getElementById('mm' + i);
        if (mm) mm.textContent = 'generating…';
        var mr = document.getElementById('mr' + i);
        if (mr) { mr.textContent = ''; mr.className = 'mini-result'; }
        needGame(i);
      }
    }

    // Fetch a fresh game for board i (ignoring late arrivals from old batches).
    function needGame(i) {
      var myBatch = batchId;
      boards[i].awaiting = true;
      generator.request(function (game) {
        if (myBatch !== batchId || !boards[i]) return; // stale
        boards[i].rec = game;
        boards[i].ply = 0;
        boards[i].holding = 0;
        boards[i].awaiting = false;
        renderMini(i);
      });
    }

    function loop() {
      timer = setInterval(tick, tickMs);
    }

    function tick() {
      if (!running) return;
      for (var i = 0; i < boards.length; i++) {
        var b = boards[i];
        if (!b.rec || b.awaiting) continue;
        if (b.holding > 0) { b.holding--; if (b.holding === 0) needGame(i); continue; }
        if (b.ply >= b.rec.moves.length) { b.holding = 3; showResult(i); continue; }
        b.ply++;
        renderMini(i);
      }
    }

    function renderMini(i) {
      var b = boards[i];
      var state = replayTo(b.rec, b.ply);
      var mb = document.getElementById('mb' + i);
      if (mb) mb.innerHTML = boardHTML(state.game.grid(), state.last);
      var mm = document.getElementById('mm' + i);
      if (mm) mm.textContent = b.ply > 0 ? (Math.ceil(b.ply / 2) + '. ' + (state.last ? state.last.san : '')) : 'start';
      var mr = document.getElementById('mr' + i);
      if (mr && b.ply < b.rec.moves.length) { mr.textContent = ''; mr.className = 'mini-result'; }
    }

    function showResult(i) {
      var b = boards[i];
      var mr = document.getElementById('mr' + i);
      if (mr) { mr.textContent = b.rec.result.text; mr.className = 'mini-result ' + b.rec.result.cls; }
    }

    // ---- focus / study mode ----
    function openFocus(i) {
      var b = boards[i];
      if (!b.rec) return;
      focus = { rec: b.rec, ply: b.ply, predict: false, predScore: 0, predTotal: 0, sel: null };
      el('focusModal').classList.remove('hidden');
      el('predictToggle').classList.remove('active');
      el('predictToggle').textContent = '🧠 Predict: off';
      renderFocus();
    }
    function closeFocus() { el('focusModal').classList.add('hidden'); focus = null; }

    function stepFocus(d) {
      if (!focus) return;
      focus.ply = Math.max(0, Math.min(focus.rec.moves.length, focus.ply + d));
      focus.sel = null;
      renderFocus();
    }

    function focusNext() {
      if (!focus) return;
      if (focus.predict && focus.ply < focus.rec.moves.length) {
        // In predict mode, Next reveals the answer for the move you guessed.
        revealPrediction();
        return;
      }
      stepFocus(1);
    }

    function togglePredict() {
      if (!focus) return;
      focus.predict = !focus.predict;
      focus.sel = null;
      el('predictToggle').classList.toggle('active', focus.predict);
      el('predictToggle').textContent = focus.predict ? '🧠 Predict: ON' : '🧠 Predict: off';
      renderFocus();
    }

    function renderFocus(arrow, feedback) {
      var state = replayTo(focus.rec, focus.ply);
      var host = el('focusBoard');
      host.innerHTML = boardHTML(state.game.grid(), state.last);
      // make squares clickable for prediction
      var cells = host.querySelectorAll('.tsq');
      var idx = 0;
      for (var r = 7; r >= 0; r--) {
        for (var f = 0; f < 8; f++) {
          var alg = 'abcdefgh'[f] + (r + 1);
          cells[idx].dataset.sq = alg;
          if (focus.sel === alg) cells[idx].classList.add('sel');
          cells[idx].addEventListener('click', onFocusSquare.bind(null, alg));
          idx++;
        }
      }
      if (arrow) drawFocusArrow(host, arrow.from, arrow.to, arrow.color || '#4fd1c5');

      // move list
      var ml = el('focusMoves');
      ml.innerHTML = '';
      for (var i = 0; i < focus.rec.moves.length; i++) {
        var span = document.createElement('span');
        span.className = 'fmove' + (i < focus.ply ? ' played' : '') + (i === focus.ply - 1 ? ' current' : '');
        span.textContent = (i % 2 === 0 ? (i / 2 + 1) + '.' : '') + focus.rec.moves[i].san + ' ';
        ml.appendChild(span);
      }

      var status = el('focusStatus');
      if (feedback) status.innerHTML = feedback;
      else if (focus.predict) {
        if (focus.ply >= focus.rec.moves.length) status.textContent = 'End of game — ' + focus.rec.result.text;
        else status.textContent = 'Your turn to predict: click the piece, then where it goes. Then press Next.';
      } else {
        status.textContent = focus.ply >= focus.rec.moves.length
          ? 'End of game — ' + focus.rec.result.text
          : 'Move ' + (focus.ply + 1) + ' of ' + focus.rec.moves.length;
      }
      el('predScore').textContent = focus.predTotal ? (focus.predScore + '/' + focus.predTotal + ' predicted') : '';
    }

    function onFocusSquare(alg) {
      if (!focus || !focus.predict || focus.ply >= focus.rec.moves.length) return;
      if (!focus.sel) { focus.sel = alg; renderFocus(); return; }
      if (focus.sel === alg) { focus.sel = null; renderFocus(); return; }
      // second click = destination -> grade against the real move
      var answer = focus.rec.moves[focus.ply];
      var correct = (focus.sel === answer.from && alg === answer.to);
      focus.predTotal++;
      if (correct) focus.predScore++;
      focus._pending = { guess: { from: focus.sel, to: alg }, answer: answer, correct: correct };
      focus.sel = null;
      var fb = correct
        ? '<span class="ok">✓ Yes! ' + answer.san + '</span> — you saw it. Press Next.'
        : '<span class="no">✗ You played ' + focus._pending.guess.from + '→' + focus._pending.guess.to +
          '. The game went ' + answer.san + '.</span> Press Next.';
      renderFocus({ from: answer.from, to: answer.to, color: correct ? '#5fbf7d' : '#e0625e' }, fb);
    }

    function revealPrediction() {
      // advance past the move just guessed
      focus.ply = Math.min(focus.rec.moves.length, focus.ply + 1);
      focus.sel = null;
      focus._pending = null;
      renderFocus();
    }

    function drawFocusArrow(host, fromAlg, toAlg, color) {
      var ns = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('class', 'focus-arrow');
      svg.setAttribute('viewBox', '0 0 8 8');
      svg.setAttribute('preserveAspectRatio', 'none');
      function center(a) {
        var f = a.charCodeAt(0) - 97, r = parseInt(a[1], 10) - 1;
        return { x: f + 0.5, y: (7 - r) + 0.5 };
      }
      var a = center(fromAlg), b = center(toAlg);
      var dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
      var ux = dx / len, uy = dy / len;
      svg.innerHTML = '<defs><marker id="fa" markerWidth="3" markerHeight="3" refX="1.5" refY="1.5" orient="auto">' +
        '<path d="M0,0 L3,1.5 L0,3 z" fill="' + color + '"/></marker></defs>' +
        '<line x1="' + (a.x + ux * 0.3) + '" y1="' + (a.y + uy * 0.3) + '" x2="' + (b.x - ux * 0.35) +
        '" y2="' + (b.y - uy * 0.35) + '" stroke="' + color + '" stroke-width="0.16" stroke-linecap="round" marker-end="url(#fa)"/>';
      host.appendChild(svg);
    }

    return { init: init };
  }
})(typeof self !== 'undefined' ? self : this);
