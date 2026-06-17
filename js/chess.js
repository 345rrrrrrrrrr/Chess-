/*
 * chess.js — a self-contained chess rules engine using the 0x88 board model.
 *
 * No external dependencies. Exposes a global `Chess` constructor on window.
 * Handles legal move generation, check/checkmate/stalemate detection,
 * castling, en passant, promotion, FEN import/export and make/unmake for
 * fast search by the AI.
 *
 * Pieces are single chars: white = PNBRQK, black = pnbrqk. Empty = null.
 */
(function (global) {
  'use strict';

  var WHITE = 'w';
  var BLACK = 'b';

  // 0x88 move offsets per piece type (lowercased type).
  var OFFSETS = {
    n: [-33, -31, -18, -14, 14, 18, 31, 33],
    b: [-17, -15, 15, 17],
    r: [-16, -1, 1, 16],
    q: [-17, -16, -15, -1, 1, 15, 17, 16],
    k: [-17, -16, -15, -1, 1, 15, 17, 16]
  };
  var SLIDING = { b: true, r: true, q: true };

  // Castling rights bit flags.
  var WK = 1, WQ = 2, BK = 4, BQ = 8;

  function isWhite(p) { return p && p === p.toUpperCase(); }
  function colorOf(p) { return isWhite(p) ? WHITE : BLACK; }
  function typeOf(p) { return p ? p.toLowerCase() : null; }

  // 0x88 helpers.
  function rank(sq) { return sq >> 4; }
  function file(sq) { return sq & 7; }
  function onBoard(sq) { return (sq & 0x88) === 0; }
  function sq(f, r) { return r * 16 + f; }

  function algebraic(s) {
    return 'abcdefgh'[file(s)] + (rank(s) + 1);
  }
  function fromAlgebraic(str) {
    var f = str.charCodeAt(0) - 97;
    var r = parseInt(str[1], 10) - 1;
    return sq(f, r);
  }

  var START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  function Chess(fen) {
    this.board = new Array(128).fill(null);
    this.turn = WHITE;
    this.castling = WK | WQ | BK | BQ;
    this.ep = -1;          // en passant target square (0x88) or -1
    this.halfmoves = 0;
    this.fullmoves = 1;
    this.kings = { w: -1, b: -1 };
    this.history = [];
    this.load(fen || START_FEN);
  }

  Chess.WHITE = WHITE;
  Chess.BLACK = BLACK;

  Chess.prototype.load = function (fen) {
    this.board = new Array(128).fill(null);
    this.history = [];
    var parts = fen.split(/\s+/);
    var rows = parts[0].split('/');
    for (var r = 0; r < 8; r++) {
      var row = rows[7 - r];
      var f = 0;
      for (var i = 0; i < row.length; i++) {
        var c = row[i];
        if (/[1-8]/.test(c)) {
          f += parseInt(c, 10);
        } else {
          var s = sq(f, r);
          this.board[s] = c;
          if (c === 'K') this.kings.w = s;
          if (c === 'k') this.kings.b = s;
          f++;
        }
      }
    }
    this.turn = parts[1] === 'b' ? BLACK : WHITE;
    this.castling = 0;
    var rights = parts[2] || '-';
    if (rights.indexOf('K') >= 0) this.castling |= WK;
    if (rights.indexOf('Q') >= 0) this.castling |= WQ;
    if (rights.indexOf('k') >= 0) this.castling |= BK;
    if (rights.indexOf('q') >= 0) this.castling |= BQ;
    this.ep = parts[3] && parts[3] !== '-' ? fromAlgebraic(parts[3]) : -1;
    this.halfmoves = parts[4] ? parseInt(parts[4], 10) : 0;
    this.fullmoves = parts[5] ? parseInt(parts[5], 10) : 1;
  };

  Chess.prototype.fen = function () {
    var rows = [];
    for (var r = 7; r >= 0; r--) {
      var row = '';
      var empty = 0;
      for (var f = 0; f < 8; f++) {
        var p = this.board[sq(f, r)];
        if (p) {
          if (empty) { row += empty; empty = 0; }
          row += p;
        } else empty++;
      }
      if (empty) row += empty;
      rows.push(row);
    }
    var rights = '';
    if (this.castling & WK) rights += 'K';
    if (this.castling & WQ) rights += 'Q';
    if (this.castling & BK) rights += 'k';
    if (this.castling & BQ) rights += 'q';
    if (!rights) rights = '-';
    var epStr = this.ep >= 0 ? algebraic(this.ep) : '-';
    return rows.join('/') + ' ' + this.turn + ' ' + rights + ' ' + epStr +
      ' ' + this.halfmoves + ' ' + this.fullmoves;
  };

  // Is square `s` attacked by side `bySide`?
  Chess.prototype.attacked = function (bySide, s) {
    for (var i = 0; i < 128; i++) {
      if (i & 0x88) { i += 7; continue; }
      var p = this.board[i];
      if (!p || colorOf(p) !== bySide) continue;
      var t = typeOf(p);
      if (t === 'p') {
        var dir = bySide === WHITE ? 16 : -16;
        if (i + dir + 1 === s || i + dir - 1 === s) {
          // ensure capture squares stay on the same diagonal (no wrap)
          if (onBoard(i + dir + 1) && i + dir + 1 === s) return true;
          if (onBoard(i + dir - 1) && i + dir - 1 === s) return true;
        }
        continue;
      }
      if (t === 'n' || t === 'k') {
        var offs = OFFSETS[t];
        for (var k = 0; k < offs.length; k++) {
          if (i + offs[k] === s) return true;
        }
        continue;
      }
      // sliding
      var so = OFFSETS[t];
      for (var d = 0; d < so.length; d++) {
        var to = i + so[d];
        while (onBoard(to)) {
          if (this.board[to]) {
            if (to === s) return true;
            break;
          }
          if (to === s) return true;
          to += so[d];
        }
      }
    }
    return false;
  };

  // List the squares of all `bySide` pieces that attack `target` (0x88).
  // Used by the "Threats" helper to show what can capture a piece.
  Chess.prototype.attackersOf = function (bySide, target) {
    var res = [];
    for (var i = 0; i < 128; i++) {
      if (i & 0x88) { i += 7; continue; }
      var p = this.board[i];
      if (!p || colorOf(p) !== bySide) continue;
      var t = typeOf(p);
      if (t === 'p') {
        var dir = bySide === WHITE ? 16 : -16;
        var fwd = i + dir;
        var l = fwd - 1, r = fwd + 1;
        if (onBoard(l) && l === target && rank(l) === rank(fwd)) res.push(i);
        if (onBoard(r) && r === target && rank(r) === rank(fwd)) res.push(i);
        continue;
      }
      if (t === 'n' || t === 'k') {
        var offs = OFFSETS[t];
        for (var k = 0; k < offs.length; k++) {
          if (i + offs[k] === target) { res.push(i); break; }
        }
        continue;
      }
      var so = OFFSETS[t];
      for (var d = 0; d < so.length; d++) {
        var to = i + so[d];
        while (onBoard(to)) {
          if (to === target) { res.push(i); break; }
          if (this.board[to]) break;
          to += so[d];
        }
      }
    }
    return res;
  };

  Chess.prototype.inCheck = function (side) {
    side = side || this.turn;
    var kingSq = this.kings[side];
    return this.attacked(side === WHITE ? BLACK : WHITE, kingSq);
  };

  // Generate pseudo-legal moves for the side to move.
  Chess.prototype.pseudoMoves = function () {
    var moves = [];
    var us = this.turn;
    var them = us === WHITE ? BLACK : WHITE;
    for (var i = 0; i < 128; i++) {
      if (i & 0x88) { i += 7; continue; }
      var p = this.board[i];
      if (!p || colorOf(p) !== us) continue;
      var t = typeOf(p);
      if (t === 'p') {
        var dir = us === WHITE ? 16 : -16;
        var startRank = us === WHITE ? 1 : 6;
        var promoRank = us === WHITE ? 7 : 0;
        var one = i + dir;
        if (onBoard(one) && !this.board[one]) {
          this.addPawnMove(moves, i, one, promoRank);
          var two = i + dir * 2;
          if (rank(i) === startRank && !this.board[two]) {
            moves.push({ from: i, to: two, flags: 'b' });
          }
        }
        var caps = [i + dir - 1, i + dir + 1];
        for (var c = 0; c < 2; c++) {
          var to = caps[c];
          if (!onBoard(to)) continue;
          if (rank(to) !== rank(one)) continue; // prevent horizontal wrap
          var target = this.board[to];
          if (target && colorOf(target) === them) {
            this.addPawnMove(moves, i, to, promoRank, 'c');
          } else if (to === this.ep) {
            moves.push({ from: i, to: to, flags: 'e' });
          }
        }
      } else if (t === 'n' || t === 'k') {
        var offs = OFFSETS[t];
        for (var k = 0; k < offs.length; k++) {
          var d2 = i + offs[k];
          if (!onBoard(d2)) continue;
          var tg = this.board[d2];
          if (!tg) moves.push({ from: i, to: d2, flags: 'n' });
          else if (colorOf(tg) === them) moves.push({ from: i, to: d2, flags: 'c' });
        }
        if (t === 'k') this.addCastling(moves, i, us, them);
      } else {
        var so = OFFSETS[t];
        for (var dd = 0; dd < so.length; dd++) {
          var sqx = i + so[dd];
          while (onBoard(sqx)) {
            var occ = this.board[sqx];
            if (!occ) {
              moves.push({ from: i, to: sqx, flags: 'n' });
            } else {
              if (colorOf(occ) === them) moves.push({ from: i, to: sqx, flags: 'c' });
              break;
            }
            sqx += so[dd];
          }
        }
      }
    }
    return moves;
  };

  Chess.prototype.addPawnMove = function (moves, from, to, promoRank, flag) {
    flag = flag || 'n';
    if (rank(to) === promoRank) {
      ['q', 'r', 'b', 'n'].forEach(function (pp) {
        moves.push({ from: from, to: to, flags: flag + 'p', promotion: pp });
      });
    } else {
      moves.push({ from: from, to: to, flags: flag });
    }
  };

  Chess.prototype.addCastling = function (moves, from, us, them) {
    if (this.inCheck(us)) return;
    if (us === WHITE) {
      if ((this.castling & WK) && !this.board[from + 1] && !this.board[from + 2] &&
        !this.attacked(them, from + 1) && !this.attacked(them, from + 2)) {
        moves.push({ from: from, to: from + 2, flags: 'k' });
      }
      if ((this.castling & WQ) && !this.board[from - 1] && !this.board[from - 2] &&
        !this.board[from - 3] && !this.attacked(them, from - 1) &&
        !this.attacked(them, from - 2)) {
        moves.push({ from: from, to: from - 2, flags: 'q' });
      }
    } else {
      if ((this.castling & BK) && !this.board[from + 1] && !this.board[from + 2] &&
        !this.attacked(them, from + 1) && !this.attacked(them, from + 2)) {
        moves.push({ from: from, to: from + 2, flags: 'k' });
      }
      if ((this.castling & BQ) && !this.board[from - 1] && !this.board[from - 2] &&
        !this.board[from - 3] && !this.attacked(them, from - 1) &&
        !this.attacked(them, from - 2)) {
        moves.push({ from: from, to: from - 2, flags: 'q' });
      }
    }
  };

  // Apply a move, recording undo info. Does not validate legality.
  Chess.prototype.makeMove = function (m) {
    var us = this.turn;
    var them = us === WHITE ? BLACK : WHITE;
    var piece = this.board[m.from];
    var undo = {
      move: m,
      captured: this.board[m.to],
      castling: this.castling,
      ep: this.ep,
      halfmoves: this.halfmoves,
      kings: { w: this.kings.w, b: this.kings.b },
      epCapturedSq: -1,
      epCaptured: null
    };

    this.board[m.to] = piece;
    this.board[m.from] = null;

    // en passant capture removes the pawn behind the target
    if (m.flags.indexOf('e') >= 0) {
      var capSq = us === WHITE ? m.to - 16 : m.to + 16;
      undo.epCapturedSq = capSq;
      undo.epCaptured = this.board[capSq];
      this.board[capSq] = null;
    }

    // promotion
    if (m.promotion) {
      this.board[m.to] = us === WHITE ? m.promotion.toUpperCase() : m.promotion;
    }

    // king moves / castling rook shift
    if (typeOf(piece) === 'k') {
      this.kings[us] = m.to;
      if (m.flags === 'k') {
        this.board[m.to - 1] = this.board[m.to + 1];
        this.board[m.to + 1] = null;
      } else if (m.flags === 'q') {
        this.board[m.to + 1] = this.board[m.to - 2];
        this.board[m.to - 2] = null;
      }
      this.castling &= us === WHITE ? ~(WK | WQ) : ~(BK | BQ);
    }

    // update castling rights when rooks move or are captured
    this.updateCastlingRights(m.from);
    this.updateCastlingRights(m.to);

    // en passant target
    this.ep = -1;
    if (m.flags === 'b') {
      this.ep = us === WHITE ? m.from + 16 : m.from - 16;
    }

    // clocks
    if (typeOf(piece) === 'p' || undo.captured || m.flags.indexOf('e') >= 0) {
      this.halfmoves = 0;
    } else {
      this.halfmoves++;
    }
    if (us === BLACK) this.fullmoves++;

    this.turn = them;
    this.history.push(undo);
    return undo;
  };

  Chess.prototype.updateCastlingRights = function (s) {
    if (s === sq(0, 0)) this.castling &= ~WQ;
    else if (s === sq(7, 0)) this.castling &= ~WK;
    else if (s === sq(0, 7)) this.castling &= ~BQ;
    else if (s === sq(7, 7)) this.castling &= ~BK;
  };

  Chess.prototype.undoMove = function () {
    var undo = this.history.pop();
    if (!undo) return;
    var m = undo.move;
    var them = this.turn;
    var us = them === WHITE ? BLACK : WHITE;

    this.turn = us;
    this.castling = undo.castling;
    this.ep = undo.ep;
    this.halfmoves = undo.halfmoves;
    this.kings = undo.kings;
    if (us === BLACK) this.fullmoves--;

    var piece = this.board[m.to];
    // undo promotion: restore pawn
    if (m.promotion) {
      piece = us === WHITE ? 'P' : 'p';
    }
    this.board[m.from] = piece;
    this.board[m.to] = undo.captured;

    if (undo.epCapturedSq >= 0) {
      this.board[undo.epCapturedSq] = undo.epCaptured;
      this.board[m.to] = null;
    }

    // undo castling rook shift
    if (typeOf(piece) === 'k') {
      if (m.flags === 'k') {
        this.board[m.to + 1] = this.board[m.to - 1];
        this.board[m.to - 1] = null;
      } else if (m.flags === 'q') {
        this.board[m.to - 2] = this.board[m.to + 1];
        this.board[m.to + 1] = null;
      }
    }
  };

  // Fully legal moves (filters out moves leaving own king in check).
  Chess.prototype.moves = function () {
    var pseudo = this.pseudoMoves();
    var legal = [];
    var us = this.turn;
    for (var i = 0; i < pseudo.length; i++) {
      this.makeMove(pseudo[i]);
      if (!this.attacked(us === WHITE ? BLACK : WHITE, this.kings[us])) {
        legal.push(pseudo[i]);
      }
      this.undoMove();
    }
    return legal;
  };

  Chess.prototype.isCheckmate = function () {
    return this.inCheck() && this.moves().length === 0;
  };
  Chess.prototype.isStalemate = function () {
    return !this.inCheck() && this.moves().length === 0;
  };
  Chess.prototype.isDraw = function () {
    return this.halfmoves >= 100 || this.isStalemate() || this.insufficientMaterial();
  };
  Chess.prototype.isGameOver = function () {
    return this.moves().length === 0 || this.isDraw();
  };

  Chess.prototype.insufficientMaterial = function () {
    var pieces = [];
    for (var i = 0; i < 128; i++) {
      if (i & 0x88) { i += 7; continue; }
      var p = this.board[i];
      if (p && typeOf(p) !== 'k') pieces.push(typeOf(p));
    }
    if (pieces.length === 0) return true;
    if (pieces.length === 1 && (pieces[0] === 'b' || pieces[0] === 'n')) return true;
    if (pieces.length === 2 && pieces[0] === 'b' && pieces[1] === 'b') return true;
    return false;
  };

  // Convert a move to Standard Algebraic Notation (SAN).
  Chess.prototype.toSan = function (m) {
    if (m.flags === 'k') return this.checkSuffix(m, 'O-O');
    if (m.flags === 'q') return this.checkSuffix(m, 'O-O-O');
    var piece = this.board[m.from];
    var t = typeOf(piece);
    var san = '';
    if (t === 'p') {
      if (m.flags.indexOf('c') >= 0 || m.flags.indexOf('e') >= 0) {
        san += 'abcdefgh'[file(m.from)] + 'x';
      }
      san += algebraic(m.to);
      if (m.promotion) san += '=' + m.promotion.toUpperCase();
    } else {
      san += t.toUpperCase();
      san += this.disambiguate(m);
      if (m.flags.indexOf('c') >= 0) san += 'x';
      san += algebraic(m.to);
    }
    return this.checkSuffix(m, san);
  };

  Chess.prototype.checkSuffix = function (m, san) {
    this.makeMove(m);
    if (this.inCheck()) san += this.moves().length === 0 ? '#' : '+';
    this.undoMove();
    return san;
  };

  Chess.prototype.disambiguate = function (m) {
    var piece = this.board[m.from];
    var legal = this.moves();
    var sameDest = legal.filter(function (x) {
      return x.to === m.to && x.from !== m.from &&
        typeOf(this.board[x.from]) === typeOf(piece);
    }, this);
    if (sameDest.length === 0) return '';
    var sameFile = sameDest.some(function (x) { return file(x.from) === file(m.from); });
    var sameRank = sameDest.some(function (x) { return rank(x.from) === rank(m.from); });
    if (!sameFile) return 'abcdefgh'[file(m.from)];
    if (!sameRank) return String(rank(m.from) + 1);
    return algebraic(m.from);
  };

  // Find a legal move matching {from,to[,promotion]} in algebraic squares.
  Chess.prototype.findMove = function (fromAlg, toAlg, promotion) {
    var from = fromAlgebraic(fromAlg);
    var to = fromAlgebraic(toAlg);
    var legal = this.moves();
    for (var i = 0; i < legal.length; i++) {
      var m = legal[i];
      if (m.from === from && m.to === to) {
        if (m.promotion && promotion && m.promotion !== promotion) continue;
        if (m.promotion && !promotion && m.promotion !== 'q') continue;
        return m;
      }
    }
    return null;
  };

  // Snapshot the board as an 8x8 array (rank 8 first) for the UI.
  Chess.prototype.grid = function () {
    var g = [];
    for (var r = 7; r >= 0; r--) {
      var row = [];
      for (var f = 0; f < 8; f++) row.push(this.board[sq(f, r)]);
      g.push(row);
    }
    return g;
  };

  // expose helpers used elsewhere
  Chess.algebraic = algebraic;
  Chess.fromAlgebraic = fromAlgebraic;
  Chess.typeOf = typeOf;
  Chess.colorOf = colorOf;
  Chess.file = file;
  Chess.rank = rank;
  Chess.sq = sq;

  global.Chess = Chess;
})(typeof window !== 'undefined' ? window : this);
