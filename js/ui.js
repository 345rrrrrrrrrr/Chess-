/*
 * ui.js — board rendering and interaction. Knows nothing about chess strategy;
 * it renders a grid, handles click-to-move + promotion, and draws hint arrows.
 * All rules questions are delegated back to the controller via callbacks.
 */
(function (global) {
  'use strict';

  var GLYPH = {
    P: '♙', N: '♘', B: '♗', R: '♖', Q: '♕', K: '♔',
    p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚'
  };

  function UI(opts) {
    this.boardEl = document.getElementById('board');
    this.promotionEl = document.getElementById('promotion');
    this.orientation = 'w';
    this.selected = null;            // algebraic square currently selected
    this.legalTargets = [];          // [{to, capture}]
    this.lastMove = null;            // {from, to}
    this.hint = null;                // {from, to}
    this.locked = false;             // ignore input while AI thinks / animating

    // callbacks injected by the controller
    this.getLegalTargets = opts.getLegalTargets;   // (fromAlg) -> [{to, capture}]
    this.onMove = opts.onMove;                      // (from, to, promotion)
    this.isPlayerPiece = opts.isPlayerPiece;        // (fromAlg) -> bool
  }

  UI.prototype.setOrientation = function (o) { this.orientation = o; };
  UI.prototype.lock = function () { this.locked = true; };
  UI.prototype.unlock = function () { this.locked = false; };

  UI.prototype.render = function (grid, lastMove) {
    this.lastMove = lastMove || this.lastMove;
    this.boardEl.innerHTML = '';
    var ranks = [7, 6, 5, 4, 3, 2, 1, 0];
    var files = [0, 1, 2, 3, 4, 5, 6, 7];
    if (this.orientation === 'b') { ranks.reverse(); files.reverse(); }

    for (var ri = 0; ri < 8; ri++) {
      for (var fi = 0; fi < 8; fi++) {
        var r = ranks[ri], f = files[fi];
        var alg = 'abcdefgh'[f] + (r + 1);
        var piece = grid[7 - r][f];
        var sqEl = document.createElement('div');
        var dark = (r + f) % 2 === 0;
        sqEl.className = 'square ' + (dark ? 'dark' : 'light');
        sqEl.dataset.sq = alg;

        if (this.lastMove && (this.lastMove.from === alg || this.lastMove.to === alg)) {
          sqEl.classList.add('lastmove');
        }
        if (this.selected === alg) sqEl.classList.add('sel');

        if (piece) {
          sqEl.classList.add(piece === piece.toUpperCase() ? 'w-piece' : 'b-piece');
          var span = document.createElement('span');
          span.className = 'piece';
          span.textContent = GLYPH[piece];
          sqEl.appendChild(span);
        }

        var tgt = this.targetFor(alg);
        if (tgt) {
          if (tgt.capture) sqEl.classList.add('capture-target');
          var dot = document.createElement('span');
          dot.className = 'dot';
          sqEl.appendChild(dot);
        }

        // edge coordinates
        if (fi === 0) {
          var rc = document.createElement('span');
          rc.className = 'coord rank';
          rc.textContent = (r + 1);
          sqEl.appendChild(rc);
        }
        if (ri === 7) {
          var fc = document.createElement('span');
          fc.className = 'coord';
          fc.textContent = 'abcdefgh'[f];
          sqEl.appendChild(fc);
        }

        sqEl.addEventListener('click', this.onSquareClick.bind(this, alg));
        this.boardEl.appendChild(sqEl);
      }
    }
    this.drawHint();
  };

  UI.prototype.targetFor = function (alg) {
    for (var i = 0; i < this.legalTargets.length; i++) {
      if (this.legalTargets[i].to === alg) return this.legalTargets[i];
    }
    return null;
  };

  UI.prototype.onSquareClick = function (alg) {
    if (this.locked) return;
    var tgt = this.targetFor(alg);
    if (this.selected && tgt) {
      this.attemptMove(this.selected, alg);
      return;
    }
    if (this.isPlayerPiece(alg)) {
      this.selected = alg;
      this.legalTargets = this.getLegalTargets(alg);
      this.rerenderSelection();
    } else {
      this.clearSelection();
    }
  };

  UI.prototype.attemptMove = function (from, to) {
    var tgt = this.targetFor(to);
    this.clearSelection();
    if (tgt && tgt.promotion) {
      this.askPromotion(from, to, tgt.color);
    } else {
      this.onMove(from, to, null);
    }
  };

  UI.prototype.askPromotion = function (from, to, color) {
    var self = this;
    var pieces = ['q', 'r', 'b', 'n'];
    this.promotionEl.innerHTML = '';
    pieces.forEach(function (p) {
      var btn = document.createElement('button');
      var glyph = color === 'w' ? p.toUpperCase() : p;
      btn.textContent = GLYPH[glyph];
      btn.addEventListener('click', function () {
        self.promotionEl.classList.add('hidden');
        self.onMove(from, to, p);
      });
      self.promotionEl.appendChild(btn);
    });
    this.promotionEl.classList.remove('hidden');
  };

  UI.prototype.clearSelection = function () {
    this.selected = null;
    this.legalTargets = [];
    this.rerenderSelection();
  };

  // Lightweight refresh of selection state without rebuilding the whole board.
  UI.prototype.rerenderSelection = function () {
    var sqs = this.boardEl.querySelectorAll('.square');
    var self = this;
    sqs.forEach(function (el) {
      el.classList.remove('sel', 'capture-target');
      var existing = el.querySelector('.dot');
      if (existing) existing.remove();
      var alg = el.dataset.sq;
      if (self.selected === alg) el.classList.add('sel');
      var tgt = self.targetFor(alg);
      if (tgt) {
        if (tgt.capture) el.classList.add('capture-target');
        var dot = document.createElement('span');
        dot.className = 'dot';
        el.appendChild(dot);
      }
    });
  };

  UI.prototype.showHint = function (from, to) {
    this.hint = { from: from, to: to };
    this.drawHint();
  };
  UI.prototype.clearHint = function () {
    this.hint = null;
    var old = this.boardEl.querySelector('.hint-arrow');
    if (old) old.remove();
  };

  // Draw an SVG arrow overlay from -> to for hints / best-move display.
  UI.prototype.drawHint = function () {
    var old = this.boardEl.querySelector('.hint-arrow');
    if (old) old.remove();
    if (!this.hint) return;
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'hint-arrow');
    svg.setAttribute('viewBox', '0 0 8 8');
    svg.setAttribute('preserveAspectRatio', 'none');
    var a = this.center(this.hint.from);
    var b = this.center(this.hint.to);
    var defs = document.createElementNS(svg.namespaceURI, 'defs');
    defs.innerHTML = '<marker id="ah" markerWidth="4" markerHeight="4" refX="2" refY="2" orient="auto">' +
      '<path d="M0,0 L4,2 L0,4 z" fill="#4fd1c5"/></marker>';
    svg.appendChild(defs);
    var line = document.createElementNS(svg.namespaceURI, 'line');
    line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
    line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
    line.setAttribute('stroke', '#4fd1c5');
    line.setAttribute('stroke-width', '0.22');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('opacity', '0.85');
    line.setAttribute('marker-end', 'url(#ah)');
    svg.appendChild(line);
    this.boardEl.appendChild(svg);
  };

  // Centre of a square in board-grid coordinates (0..8), honouring orientation.
  UI.prototype.center = function (alg) {
    var f = alg.charCodeAt(0) - 97;
    var r = parseInt(alg[1], 10) - 1;
    var col = this.orientation === 'w' ? f : 7 - f;
    var row = this.orientation === 'w' ? 7 - r : r;
    return { x: col + 0.5, y: row + 0.5 };
  };

  global.UI = UI;
})(typeof window !== 'undefined' ? window : this);
