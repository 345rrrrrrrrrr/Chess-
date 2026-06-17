/*
 * theater-worker.js — generates complete games off the main thread so the
 * Vision Theater stays perfectly smooth. Loads the engine via importScripts;
 * theater.js's interactive controller is skipped here (no `document`).
 */
/* global importScripts, Theater */
importScripts('chess.js', 'ai.js', 'theater.js');

self.onmessage = function () {
  self.postMessage(self.Theater.generateGame());
};
