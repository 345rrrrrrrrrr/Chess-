/*
 * adaptive.js — the "brain" that learns your level and keeps you in the zone.
 *
 * Core idea: after every one of YOUR moves we measure how close it was to the
 * engine's best move (centipawn loss / "accuracy"). We keep a running profile
 * and convert it into an opponent strength so the game is always *just* hard
 * enough — dumb when you start, sharper as you sharpen.
 *
 * It also tracks where you tend to go wrong (tactics vs. quiet positions,
 * openings vs. endgames) so the coach can target feedback.
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'adaptiveChessProfile.v1';

  // Strength levels map to engine settings. Index = level (0..N-1).
  var LEVELS = [
    { name: 'Beginner Bot', depth: 1, blunderRate: 0.85, timeMs: 300 },
    { name: 'Casual Bot', depth: 2, blunderRate: 0.6, timeMs: 500 },
    { name: 'Improver Bot', depth: 2, blunderRate: 0.4, timeMs: 700 },
    { name: 'Club Bot', depth: 3, blunderRate: 0.25, timeMs: 1000 },
    { name: 'Sharp Bot', depth: 3, blunderRate: 0.12, timeMs: 1400 },
    { name: 'Strong Bot', depth: 4, blunderRate: 0.05, timeMs: 1800 },
    { name: 'Ruthless Bot', depth: 4, blunderRate: 0.0, timeMs: 2500 }
  ];

  function defaultProfile() {
    return {
      level: 0,                 // current opponent strength index
      momentum: 0,              // running signal that pushes level up/down
      gamesPlayed: 0,
      wins: 0, losses: 0, draws: 0,
      moveCount: 0,
      totalCpLoss: 0,           // cumulative centipawn loss across all moves
      recentAccuracy: [],       // last N per-move accuracy %
      blunders: 0,              // moves losing > 200cp
      mistakes: 0,              // moves losing 100-200cp
      inaccuracies: 0,          // moves losing 50-100cp
      brilliant: 0,             // best-move matches when alternatives existed
      bestStreak: 0,
      history: []               // per-game summaries
    };
  }

  function load() {
    try {
      var raw = global.localStorage && localStorage.getItem(STORAGE_KEY);
      if (raw) return Object.assign(defaultProfile(), JSON.parse(raw));
    } catch (e) { /* ignore */ }
    return defaultProfile();
  }

  function save(p) {
    try {
      if (global.localStorage) localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
    } catch (e) { /* ignore */ }
  }

  function Adaptive() {
    this.profile = load();
  }

  Adaptive.LEVELS = LEVELS;

  Adaptive.prototype.levelInfo = function () {
    return LEVELS[Math.max(0, Math.min(LEVELS.length - 1, this.profile.level))];
  };

  Adaptive.prototype.engineOptions = function () {
    return Object.assign({}, this.levelInfo());
  };

  // Translate a centipawn loss into an accuracy percentage (0..100).
  // 0 cp lost = 100%, large losses decay toward 0.
  Adaptive.prototype.accuracyFromCpLoss = function (cpLoss) {
    return Math.max(0, Math.round(100 * Math.exp(-cpLoss / 250)));
  };

  // Record one of the player's moves.
  //   cpLoss: how much worse than best (centipawns, >= 0)
  //   wasBest: did the player find the engine's top move?
  //   hadChoice: were there meaningful alternatives?
  Adaptive.prototype.recordMove = function (cpLoss, wasBest, hadChoice) {
    var p = this.profile;
    p.moveCount++;
    p.totalCpLoss += cpLoss;
    var acc = this.accuracyFromCpLoss(cpLoss);
    p.recentAccuracy.push(acc);
    if (p.recentAccuracy.length > 20) p.recentAccuracy.shift();

    if (cpLoss > 200) p.blunders++;
    else if (cpLoss > 100) p.mistakes++;
    else if (cpLoss > 50) p.inaccuracies++;

    if (wasBest && hadChoice) {
      p.brilliant++;
      p.bestStreak++;
    } else if (cpLoss > 80) {
      p.bestStreak = 0;
    }

    // Momentum: good moves push up, bad moves push down. The board adapts
    // smoothly rather than lurching between levels.
    if (acc >= 90) p.momentum += 1.0;
    else if (acc >= 75) p.momentum += 0.4;
    else if (acc >= 55) p.momentum -= 0.2;
    else p.momentum -= 1.0;

    this.applyMomentum();
    save(p);
    return acc;
  };

  // Shift difficulty level when momentum crosses a threshold.
  Adaptive.prototype.applyMomentum = function () {
    var p = this.profile;
    var changed = false;
    if (p.momentum >= 4 && p.level < LEVELS.length - 1) {
      p.level++; p.momentum = 1; changed = true;
    } else if (p.momentum <= -4 && p.level > 0) {
      p.level--; p.momentum = -1; changed = true;
    }
    return changed;
  };

  // Record the result of a finished game and nudge level by outcome too.
  Adaptive.prototype.recordResult = function (result) {
    var p = this.profile;
    p.gamesPlayed++;
    if (result === 'win') { p.wins++; p.momentum += 2; }
    else if (result === 'loss') { p.losses++; p.momentum -= 2; }
    else { p.draws++; }
    p.history.push({
      result: result,
      level: p.level,
      avgAccuracy: this.avgAccuracy(),
      date: Date.now()
    });
    if (p.history.length > 100) p.history.shift();
    this.applyMomentum();
    save(p);
  };

  Adaptive.prototype.avgAccuracy = function () {
    var r = this.profile.recentAccuracy;
    if (!r.length) return 100;
    return Math.round(r.reduce(function (a, b) { return a + b; }, 0) / r.length);
  };

  // A coaching insight string about the player's current tendencies.
  Adaptive.prototype.insight = function () {
    var p = this.profile;
    if (p.moveCount < 4) return 'Play a few moves and I will start reading your style…';
    var acc = this.avgAccuracy();
    if (p.blunders > p.mistakes && p.blunders > 2) {
      return 'You are dropping pieces to tactics. Before each move, scan every check, capture and threat.';
    }
    if (acc >= 90) return 'Razor sharp lately. I am cranking up the pressure.';
    if (acc >= 75) return 'Solid and steady — you rarely give much away.';
    if (acc >= 55) return 'Decent moves, but you are leaking small advantages. Slow down on quiet positions.';
    return 'We are rebuilding fundamentals. Protect your pieces and control the center.';
  };

  Adaptive.prototype.reset = function () {
    this.profile = defaultProfile();
    save(this.profile);
  };

  global.Adaptive = Adaptive;
})(typeof self !== 'undefined' ? self : this);
