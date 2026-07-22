#!/usr/bin/env node
'use strict';

/**
 * Offline sanity tests for the pure aggregation logic (no network).
 * Run: node scripts/test-logic.js
 */

const assert = require('assert');
const {
  filterLeagueGames,
  classifyOutcome,
  buildAggregates,
} = require('./fetch-results');

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

// Fixture: a small league of 3, with a non-member (guest) mixed in.
const players = [
  { username: 'alice', display: 'Alice' },
  { username: 'bob', display: 'Bob' },
  { username: 'carol', display: 'Carol' },
];
const leagueSet = new Set(players.map((p) => p.username));

const raw = [
  // Alice beats Bob (blitz)
  { url: 'g1', time_class: 'blitz', end_time: 100, rated: true,
    white: { username: 'Alice', result: 'win' }, black: { username: 'bob', result: 'resigned' } },
  // Same game shows up in Bob's archive too (dup by url) — must be deduped
  { url: 'g1', time_class: 'blitz', end_time: 100, rated: true,
    white: { username: 'Alice', result: 'win' }, black: { username: 'bob', result: 'resigned' } },
  // Bob draws Carol (rapid, stalemate)
  { url: 'g2', time_class: 'rapid', end_time: 200, rated: true,
    white: { username: 'bob', result: 'stalemate' }, black: { username: 'Carol', result: 'stalemate' } },
  // Carol beats Alice (bullet, black wins)
  { url: 'g3', time_class: 'bullet', end_time: 300, rated: true,
    white: { username: 'alice', result: 'timeout' }, black: { username: 'carol', result: 'win' } },
  // Alice vs a non-member — must be dropped
  { url: 'g4', time_class: 'blitz', end_time: 400, rated: true,
    white: { username: 'alice', result: 'win' }, black: { username: 'randoGuest', result: 'checkmated' } },
];

check('filterLeagueGames keeps only league-vs-league and dedupes by url', () => {
  const filtered = filterLeagueGames(raw, leagueSet);
  const urls = filtered.map((g) => g.url).sort();
  assert.deepStrictEqual(urls, ['g1', 'g2', 'g3']);
});

check('classifyOutcome detects white win, black win, and draw', () => {
  assert.deepStrictEqual(classifyOutcome(raw[0]), { winner: 'white', draw: false });
  assert.deepStrictEqual(classifyOutcome(raw[3]), { winner: 'black', draw: false });
  assert.deepStrictEqual(classifyOutcome(raw[2]), { winner: null, draw: true });
});

const filtered = filterLeagueGames(raw, leagueSet);
const { games, headToHead, standings } = buildAggregates(filtered, players);

check('game log is deduped, normalized, and newest-first', () => {
  assert.strictEqual(games.length, 3);
  assert.deepStrictEqual(games.map((g) => g.url), ['g3', 'g2', 'g1']);
  assert.strictEqual(games[2].winner, 'alice'); // g1 winner
  assert.strictEqual(games[1].draw, true); // g2 draw
});

check('head-to-head records are correct and symmetric', () => {
  // Alice beat Bob once (blitz)
  assert.deepStrictEqual(headToHead['alice|bob'].all, { w: 1, l: 0, d: 0 });
  assert.deepStrictEqual(headToHead['alice|bob'].blitz, { w: 1, l: 0, d: 0 });
  assert.deepStrictEqual(headToHead['bob|alice'].all, { w: 0, l: 1, d: 0 });
  // Bob drew Carol (rapid)
  assert.deepStrictEqual(headToHead['bob|carol'].all, { w: 0, l: 0, d: 1 });
  assert.deepStrictEqual(headToHead['carol|bob'].rapid, { w: 0, l: 0, d: 1 });
  // Carol beat Alice (bullet)
  assert.deepStrictEqual(headToHead['carol|alice'].bullet, { w: 1, l: 0, d: 0 });
  assert.deepStrictEqual(headToHead['alice|carol'].all, { w: 0, l: 1, d: 0 });
});

check('standings aggregate points (win=1, draw=0.5) and sort', () => {
  const all = standings.all;
  const alice = all.find((r) => r.username === 'alice');
  const bob = all.find((r) => r.username === 'bob');
  const carol = all.find((r) => r.username === 'carol');
  // Alice: 1W 1L 0D → 1 pt; Bob: 0W 1L 1D → 0.5; Carol: 1W 0L 1D → 1.5
  assert.strictEqual(alice.points, 1);
  assert.strictEqual(bob.points, 0.5);
  assert.strictEqual(carol.points, 1.5);
  assert.strictEqual(alice.games, 2);
  // Sorted by points desc → Carol, Alice, Bob
  assert.deepStrictEqual(all.map((r) => r.username), ['carol', 'alice', 'bob']);
});

check('bucketed standings only count the matching time class', () => {
  const bullet = standings.bullet;
  const carol = bullet.find((r) => r.username === 'carol');
  assert.strictEqual(carol.wins, 1); // her bullet win over Alice
  const bob = bullet.find((r) => r.username === 'bob');
  assert.strictEqual(bob.games, 0); // Bob played no bullet
});

console.log(`\n${passed} checks passed.`);
