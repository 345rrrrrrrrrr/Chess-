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

    // --- planning annotations (arrows + highlighted squares) ---
    this.annotations = { arrows: [], squares: [] };  // squares: [{sq,color}]
    this.drawMode = false;           // when true, board taps/drags draw instead of move
    this.drawColor = '#e8a13a';      // current annotation colour
    this._annoStart = null;          // square where a drag began
    this._annoPointer = null;        // active pointer id while drawing

    // callbacks injected by the controller
    this.getLegalTargets = opts.getLegalTargets;   // (fromAlg) -> [{to, capture}]
    this.onMove = opts.onMove;                      // (from, to, promotion)
    this.isPlayerPiece = opts.isPlayerPiece;        // (fromAlg) -> bool

    this.bindAnnotationEvents();
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
    this.redrawAnnotations();
    this.drawHint();
  };

  UI.prototype.targetFor = function (alg) {
    for (var i = 0; i < this.legalTargets.length; i++) {
      if (this.legalTargets[i].to === alg) return this.legalTargets[i];
    }
    return null;
  };

  UI.prototype.onSquareClick = function (alg) {
    if (this.locked || this.drawMode) return;  // draw mode handles taps itself
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
    var c = this.cell(alg);
    return { x: c.col + 0.5, y: c.row + 0.5 };
  };

  // Top-left grid cell (col,row in 0..7) of a square, honouring orientation.
  UI.prototype.cell = function (alg) {
    var f = alg.charCodeAt(0) - 97;
    var r = parseInt(alg[1], 10) - 1;
    return {
      col: this.orientation === 'w' ? f : 7 - f,
      row: this.orientation === 'w' ? 7 - r : r
    };
  };

  // ===================== Planning annotations =====================

  UI.prototype.setDrawMode = function (on) {
    this.drawMode = on;
    this._annoStart = null;
    if (on) this.clearSelection();
    this.boardEl.classList.toggle('draw-mode', on);
  };
  UI.prototype.setDrawColor = function (c) { this.drawColor = c; };

  UI.prototype.clearAnnotations = function () {
    this.annotations = { arrows: [], squares: [] };
    this.redrawAnnotations();
  };
  UI.prototype.hasAnnotations = function () {
    return this.annotations.arrows.length > 0 || this.annotations.squares.length > 0;
  };

  // Toggle a highlighted square (user tap). Same square+colour removes it.
  UI.prototype.toggleSquare = function (sq, color) {
    var arr = this.annotations.squares;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].sq === sq) {
        if (arr[i].color === color) { arr.splice(i, 1); }
        else { arr[i].color = color; }
        this.redrawAnnotations();
        return;
      }
    }
    arr.push({ sq: sq, color: color });
    this.redrawAnnotations();
  };

  // Toggle an arrow (user drag). Same from/to+colour removes it.
  UI.prototype.toggleArrow = function (from, to, color) {
    var arr = this.annotations.arrows;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].from === from && arr[i].to === to) {
        if (arr[i].color === color) { arr.splice(i, 1); }
        else { arr[i].color = color; }
        this.redrawAnnotations();
        return;
      }
    }
    arr.push({ from: from, to: to, color: color });
    this.redrawAnnotations();
  };

  // Programmatic (non-toggling) marks, used by the Threats helper.
  UI.prototype.markSquare = function (sq, color) {
    if (!this.annotations.squares.some(function (s) { return s.sq === sq && s.color === color; })) {
      this.annotations.squares.push({ sq: sq, color: color });
    }
  };
  UI.prototype.markArrow = function (from, to, color) {
    if (!this.annotations.arrows.some(function (a) { return a.from === from && a.to === to && a.color === color; })) {
      this.annotations.arrows.push({ from: from, to: to, color: color });
    }
  };

  // Map a pointer position to a board square (clamped to the board).
  UI.prototype.squareFromPoint = function (clientX, clientY) {
    var rect = this.boardEl.getBoundingClientRect();
    var col = Math.floor((clientX - rect.left) / rect.width * 8);
    var row = Math.floor((clientY - rect.top) / rect.height * 8);
    col = Math.max(0, Math.min(7, col));
    row = Math.max(0, Math.min(7, row));
    var file = this.orientation === 'w' ? col : 7 - col;
    var rank = this.orientation === 'w' ? 7 - row : row;
    return 'abcdefgh'[file] + (rank + 1);
  };

  UI.prototype.bindAnnotationEvents = function () {
    var self = this;
    // Right-click drag draws on desktop; suppress the context menu.
    this.boardEl.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    this.boardEl.addEventListener('pointerdown', function (e) {
      var anno = self.drawMode || e.button === 2;
      if (!anno || self.locked) return;
      e.preventDefault();
      self._annoStart = self.squareFromPoint(e.clientX, e.clientY);
      self._annoPointer = e.pointerId;
      try { self.boardEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }, { passive: false });
    this.boardEl.addEventListener('pointermove', function (e) {
      if (self._annoStart == null || e.pointerId !== self._annoPointer) return;
      e.preventDefault();
      self.drawPreview(self._annoStart, self.squareFromPoint(e.clientX, e.clientY));
    }, { passive: false });
    var finish = function (e) {
      if (self._annoStart == null) return;
      var end = self.squareFromPoint(e.clientX, e.clientY);
      var start = self._annoStart;
      self._annoStart = null;
      self._annoPointer = null;
      self.clearPreview();
      if (start === end) self.toggleSquare(start, self.drawColor);
      else self.toggleArrow(start, end, self.drawColor);
    };
    this.boardEl.addEventListener('pointerup', finish);
    this.boardEl.addEventListener('pointercancel', function () {
      self._annoStart = null; self._annoPointer = null; self.clearPreview();
    });
  };

  // Build (or rebuild) the SVG overlay holding squares + arrows.
  UI.prototype.redrawAnnotations = function () {
    var old = this.boardEl.querySelector('.anno-layer');
    if (old) old.remove();
    var a = this.annotations;
    if (!a.squares.length && !a.arrows.length) return;

    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'anno-layer');
    svg.setAttribute('viewBox', '0 0 8 8');
    svg.setAttribute('preserveAspectRatio', 'none');

    // square highlights (drawn first, under the arrows)
    a.squares.forEach(function (s) {
      var c = this.cell(s.sq);
      var rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', c.col + 0.04);
      rect.setAttribute('y', c.row + 0.04);
      rect.setAttribute('width', 0.92);
      rect.setAttribute('height', 0.92);
      rect.setAttribute('rx', 0.08);
      rect.setAttribute('fill', s.color);
      rect.setAttribute('opacity', '0.42');
      svg.appendChild(rect);
    }, this);

    // arrows, each with a colour-matched arrowhead marker
    var defs = document.createElementNS(ns, 'defs');
    svg.appendChild(defs);
    var seen = {};
    a.arrows.forEach(function (ar, idx) {
      var mid = 'ah' + idx;
      var marker = document.createElementNS(ns, 'marker');
      marker.setAttribute('id', mid);
      marker.setAttribute('markerWidth', '3.2');
      marker.setAttribute('markerHeight', '3.2');
      marker.setAttribute('refX', '1.6');
      marker.setAttribute('refY', '1.6');
      marker.setAttribute('orient', 'auto');
      var head = document.createElementNS(ns, 'path');
      head.setAttribute('d', 'M0,0 L3.2,1.6 L0,3.2 z');
      head.setAttribute('fill', ar.color);
      marker.appendChild(head);
      defs.appendChild(marker);
      svg.appendChild(this.arrowLine(ns, ar.from, ar.to, ar.color, 'url(#' + mid + ')'));
      seen[mid] = true;
    }, this);

    this.boardEl.appendChild(svg);
  };

  // Construct an arrow <line>, shortened at both ends so it sits inside squares.
  UI.prototype.arrowLine = function (ns, fromSq, toSq, color, marker) {
    var a = this.center(fromSq), b = this.center(toSq);
    var dx = b.x - a.x, dy = b.y - a.y;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / len, uy = dy / len;
    var x1 = a.x + ux * 0.28, y1 = a.y + uy * 0.28;
    var x2 = b.x - ux * 0.34, y2 = b.y - uy * 0.34;
    var line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', x1); line.setAttribute('y1', y1);
    line.setAttribute('x2', x2); line.setAttribute('y2', y2);
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', '0.17');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('opacity', '0.9');
    line.setAttribute('marker-end', marker);
    return line;
  };

  // Live preview while dragging an arrow / highlighting a square.
  UI.prototype.drawPreview = function (fromSq, toSq) {
    this.clearPreview();
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'anno-preview');
    svg.setAttribute('viewBox', '0 0 8 8');
    svg.setAttribute('preserveAspectRatio', 'none');
    if (fromSq === toSq) {
      var c = this.cell(fromSq);
      var rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', c.col + 0.04); rect.setAttribute('y', c.row + 0.04);
      rect.setAttribute('width', 0.92); rect.setAttribute('height', 0.92);
      rect.setAttribute('rx', 0.08);
      rect.setAttribute('fill', this.drawColor); rect.setAttribute('opacity', '0.42');
      svg.appendChild(rect);
    } else {
      var defs = document.createElementNS(ns, 'defs');
      defs.innerHTML = '<marker id="ahp" markerWidth="3.2" markerHeight="3.2" refX="1.6" refY="1.6" orient="auto">' +
        '<path d="M0,0 L3.2,1.6 L0,3.2 z" fill="' + this.drawColor + '"/></marker>';
      svg.appendChild(defs);
      svg.appendChild(this.arrowLine(ns, fromSq, toSq, this.drawColor, 'url(#ahp)'));
    }
    this.boardEl.appendChild(svg);
  };
  UI.prototype.clearPreview = function () {
    var old = this.boardEl.querySelector('.anno-preview');
    if (old) old.remove();
  };

  global.UI = UI;
})(typeof window !== 'undefined' ? window : this);
