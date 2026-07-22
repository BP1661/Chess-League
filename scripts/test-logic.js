#!/usr/bin/env node
'use strict';

/** Offline tests for the schedule-driven logic (no network). node scripts/test-logic.js */

const assert = require('assert');
const {
  buildResults, resultFromGame, filterLeagueGames,
  localMidnightEpochSec, addDays,
} = require('./fetch-results');

let passed = 0;
const check = (name, fn) => { fn(); passed += 1; console.log(`  ✓ ${name}`); };

// --- date/timezone helpers -------------------------------------------------

check('addDays does calendar math across month boundary', () => {
  assert.strictEqual(addDays('2026-07-20', 6), '2026-07-26');
  assert.strictEqual(addDays('2026-07-27', 6), '2026-08-02');
});

check('Pacific week boundary maps to the right UTC instant (PDT = UTC-7)', () => {
  const epoch = localMidnightEpochSec('2026-07-20', 'America/Los_Angeles');
  assert.strictEqual(new Date(epoch * 1000).toISOString(), '2026-07-20T07:00:00.000Z');
});

// --- matchup resolution + standings ---------------------------------------

const league = {
  timeControls: ['rapid', 'blitz'],
  defaultTimeControl: 'rapid',
  players: [
    { name: 'Alice', username: 'alice' },
    { name: 'Bob', username: 'bob' },
    { name: 'Carol', username: 'carol' },
    { name: 'Dave', username: 'dave' },
  ],
  nameToUser: { Alice: 'alice', Bob: 'bob', Carol: 'carol', Dave: 'dave' },
  weeks: [
    {
      week: 1, start: '2026-07-20', end: '2026-07-26',
      startEpoch: 1000, endEpoch: 2000,
      rounds: [
        { round: 1, bye: null, matchups: [['Alice', 'Bob'], ['Carol', 'Dave']] },
      ],
    },
  ],
};

const g = (url, tc, t, w, wr, b, br) => ({
  url, time_class: tc, end_time: t, rated: true,
  white: { username: w, result: wr }, black: { username: b, result: br },
});

const pool = [
  g('r1', 'rapid', 1200, 'alice', 'win', 'bob', 'resigned'),   // first rapid in window → counts
  g('r2', 'rapid', 1500, 'alice', 'timeout', 'bob', 'win'),    // later rapid → ignored
  g('b1', 'blitz', 1300, 'alice', 'agreed', 'bob', 'agreed'),  // blitz draw in window
  g('x1', 'rapid', 500, 'carol', 'win', 'dave', 'resigned'),   // out of window → ignored
];

const nowSec = 3000; // after the window → unplayed matchups are "missed"
const { weeks, standings } = buildResults(league, pool, nowSec);
const m = weeks[0].rounds[0].matchups;

check('first game of the window (of that time control) decides the matchup', () => {
  assert.strictEqual(m[0].results.rapid.status, 'played');
  assert.strictEqual(m[0].results.rapid.url, 'r1'); // r1, not the later r2
  assert.strictEqual(m[0].results.rapid.winnerUser, 'alice');
  assert.strictEqual(m[0].results.rapid.score, '1–0'); // Alice is scheduled white and won
});

check('each time control resolves independently', () => {
  assert.strictEqual(m[0].results.blitz.status, 'played');
  assert.strictEqual(m[0].results.blitz.score, '½–½');
});

check('games outside the week window do not count', () => {
  assert.strictEqual(m[1].results.rapid.status, 'missed'); // Carol–Dave: only game was out of window
  assert.strictEqual(m[1].results.rapid.score, null);
});

check('pending vs missed depends on whether the window has closed', () => {
  const future = buildResults(league, pool, 1500); // now is inside the window
  assert.strictEqual(future.weeks[0].rounds[0].matchups[1].results.rapid.status, 'pending');
  assert.strictEqual(future.weeks[0].isCurrent, true);
});

check('standings rank by game points (win 1 / draw ½), per time control', () => {
  const rapid = standings.rapid;
  assert.strictEqual(rapid.find((r) => r.username === 'alice').points, 1);
  assert.strictEqual(rapid.find((r) => r.username === 'bob').points, 0);
  assert.strictEqual(rapid[0].username, 'alice'); // Alice leads rapid
  const blitz = standings.blitz;
  assert.strictEqual(blitz.find((r) => r.username === 'alice').points, 0.5);
  assert.strictEqual(blitz.find((r) => r.username === 'bob').points, 0.5);
});

check('score orients to the scheduled white even if actual colors were swapped', () => {
  // Bob had white in the actual game but Alice is the scheduled white and lost it.
  const swapped = resultFromGame(
    g('s1', 'rapid', 1200, 'bob', 'win', 'alice', 'resigned').white
      ? g('s1', 'rapid', 1200, 'bob', 'win', 'alice', 'resigned')
      : null,
    'alice'
  );
  assert.strictEqual(swapped.winnerUser, 'bob');
  assert.strictEqual(swapped.score, '0–1'); // scheduled white (Alice) lost
});

check('filterLeagueGames dedupes by url and drops non-members', () => {
  const set = new Set(['alice', 'bob']);
  const dup = [pool[0], pool[0], g('n1', 'rapid', 1200, 'alice', 'win', 'guest', 'resigned')];
  assert.strictEqual(filterLeagueGames(dup, set).length, 1);
});

console.log(`\n${passed} checks passed.`);
