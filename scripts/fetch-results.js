#!/usr/bin/env node
'use strict';

/**
 * Chess League Tracker — data fetcher / aggregator.
 *
 * Pulls each league member's monthly game archives from the chess.com public
 * API, keeps only games played BETWEEN two league members, dedupes them, and
 * writes a head-to-head matrix + standings + game log to data/results.json.
 *
 * Closed (past) months are cached to data/cache/ and never refetched; only the
 * current month is re-pulled on each run. No auth and no npm dependencies —
 * uses Node's built-in fetch (Node >= 20).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'data', 'cache');
const DATA_DIR = path.join(ROOT, 'data');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');
const LEAGUE_FILE = path.join(ROOT, 'league.json');

const USER_AGENT =
  'chess-league-tracker/1.0 (https://github.com/bp1661/chess-league; contact: benpetricoff@gmail.com)';

const DRAW_RESULTS = new Set([
  'agreed',
  'repetition',
  'stalemate',
  'insufficient',
  '50move',
  'timevsinsufficient',
]);

const TIME_CLASSES = ['bullet', 'blitz', 'rapid', 'daily'];
const BUCKETS = ['all', ...TIME_CLASSES];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * GET JSON with retry/backoff. Returns:
 *   - parsed object on 200
 *   - null on 404 (private / nonexistent profile) — caller skips gracefully
 * Throws only after exhausting retries on transient (429/5xx/network) errors.
 */
async function httpGet(url, { retries = 4 } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
    } catch (err) {
      if (attempt > retries) throw err;
      const wait = 1000 * 2 ** (attempt - 1);
      console.warn(`  network error for ${url} (attempt ${attempt}): ${err.message}; retrying in ${wait}ms`);
      await sleep(wait);
      continue;
    }

    if (res.status === 404) return null;
    if (res.ok) return res.json();

    // 429 / 5xx → retry with backoff
    if ((res.status === 429 || res.status >= 500) && attempt <= retries) {
      const wait = 1000 * 2 ** (attempt - 1);
      console.warn(`  HTTP ${res.status} for ${url} (attempt ${attempt}); retrying in ${wait}ms`);
      await sleep(wait);
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
}

// ---------------------------------------------------------------------------
// Fetching (with disk cache)
// ---------------------------------------------------------------------------

/** List of monthly archive URLs for a user, or null if the profile is unavailable. */
async function fetchArchives(username) {
  const url = `https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/archives`;
  const data = await httpGet(url);
  if (!data || !Array.isArray(data.archives)) return null;
  return data.archives;
}

/** Keep only the fields we need, to keep the cached JSON small. */
function trimGame(g) {
  return {
    url: g.url,
    time_class: g.time_class,
    end_time: g.end_time,
    rated: g.rated,
    white: { username: g.white?.username, result: g.white?.result },
    black: { username: g.black?.username, result: g.black?.result },
  };
}

function cachePath(username, year, month) {
  const mm = String(month).padStart(2, '0');
  return path.join(CACHE_DIR, `${username.toLowerCase()}_${year}_${mm}.json`);
}

/**
 * Fetch one month of a user's games, using the disk cache for closed months.
 * The current month is always refetched. Returns an array of trimmed games.
 */
async function fetchMonth(username, year, month, archiveUrl, now) {
  const isCurrentMonth = year === now.getUTCFullYear() && month === now.getUTCMonth() + 1;
  const file = cachePath(username, year, month);

  if (!isCurrentMonth && fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // corrupt cache file → refetch below
    }
  }

  const data = await httpGet(archiveUrl);
  if (!data || !Array.isArray(data.games)) return [];
  const trimmed = data.games.map(trimGame);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(trimmed));
  return trimmed;
}

/** Fetch every archived game for a user. Returns {games, unavailable}. */
async function fetchAllGamesForUser(username, now) {
  const archives = await fetchArchives(username);
  if (archives === null) {
    console.warn(`! ${username}: profile unavailable (private or nonexistent) — skipping`);
    return { games: [], unavailable: true };
  }

  const games = [];
  for (const archiveUrl of archives) {
    // .../games/YYYY/MM
    const m = archiveUrl.match(/\/(\d{4})\/(\d{2})$/);
    if (!m) continue;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const monthGames = await fetchMonth(username, year, month, archiveUrl, now);
    games.push(...monthGames);
    // Be gentle only when we actually hit the network (current month or cache miss).
    await sleep(120);
  }
  console.log(`  ${username}: ${archives.length} months, ${games.length} games`);
  return { games, unavailable: false };
}

// ---------------------------------------------------------------------------
// Filtering + classification
// ---------------------------------------------------------------------------

/** Keep only games where BOTH players are in the league; dedupe by url. */
function filterLeagueGames(games, leagueSet) {
  const seen = new Set();
  const out = [];
  for (const g of games) {
    const w = g.white?.username?.toLowerCase();
    const b = g.black?.username?.toLowerCase();
    if (!w || !b) continue;
    if (!leagueSet.has(w) || !leagueSet.has(b)) continue;
    if (seen.has(g.url)) continue;
    seen.add(g.url);
    out.push(g);
  }
  return out;
}

/** Determine pair outcome. Returns {winner: 'white'|'black'|null, draw: bool}. */
function classifyOutcome(game) {
  const wr = game.white?.result;
  const br = game.black?.result;
  if (wr === 'win') return { winner: 'white', draw: false };
  if (br === 'win') return { winner: 'black', draw: false };
  // No winner → draw (both sides carry a draw-type result).
  return { winner: null, draw: true };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

const emptyRecord = () => ({ w: 0, l: 0, d: 0 });
const emptyBucketed = () => Object.fromEntries(BUCKETS.map((b) => [b, emptyRecord()]));

/**
 * Build the normalized game log, head-to-head records, and standings.
 * `players` is the ordered list of {username, display}.
 */
function buildAggregates(leagueGames, players) {
  const usernames = players.map((p) => p.username);

  // Head-to-head: records[`${a}|${b}`] = a's W/L/D vs b, bucketed by time class.
  const h2h = {};
  for (const a of usernames) {
    for (const b of usernames) {
      if (a !== b) h2h[`${a}|${b}`] = emptyBucketed();
    }
  }

  // Standings: standings[bucket][username] = {w,l,d}
  const standings = {};
  for (const bucket of BUCKETS) {
    standings[bucket] = {};
    for (const u of usernames) standings[bucket][u] = emptyRecord();
  }

  const games = [];

  for (const g of leagueGames) {
    const white = g.white.username.toLowerCase();
    const black = g.black.username.toLowerCase();
    const tc = TIME_CLASSES.includes(g.time_class) ? g.time_class : null;
    const buckets = tc ? ['all', tc] : ['all'];
    const { winner, draw } = classifyOutcome(g);

    // winner in white/black terms → winner/loser usernames
    let winnerUser = null;
    let loserUser = null;
    if (winner === 'white') {
      winnerUser = white;
      loserUser = black;
    } else if (winner === 'black') {
      winnerUser = black;
      loserUser = white;
    }

    for (const bucket of buckets) {
      if (draw) {
        h2h[`${white}|${black}`][bucket].d += 1;
        h2h[`${black}|${white}`][bucket].d += 1;
        standings[bucket][white].d += 1;
        standings[bucket][black].d += 1;
      } else {
        h2h[`${winnerUser}|${loserUser}`][bucket].w += 1;
        h2h[`${loserUser}|${winnerUser}`][bucket].l += 1;
        standings[bucket][winnerUser].w += 1;
        standings[bucket][loserUser].l += 1;
      }
    }

    games.push({
      url: g.url,
      timeClass: g.time_class,
      endTime: g.end_time,
      date: g.end_time ? new Date(g.end_time * 1000).toISOString() : null,
      rated: g.rated,
      white,
      black,
      winner: winnerUser, // username or null (draw)
      draw,
    });
  }

  games.sort((a, b) => (b.endTime || 0) - (a.endTime || 0));

  // Turn standings maps into sorted leaderboards per bucket.
  const leaderboards = {};
  for (const bucket of BUCKETS) {
    leaderboards[bucket] = usernames
      .map((u) => {
        const r = standings[bucket][u];
        const gamesPlayed = r.w + r.l + r.d;
        const points = r.w + 0.5 * r.d;
        const winPct = gamesPlayed ? (r.w / gamesPlayed) * 100 : 0;
        return {
          username: u,
          wins: r.w,
          losses: r.l,
          draws: r.d,
          games: gamesPlayed,
          points,
          winPct: Math.round(winPct * 10) / 10,
        };
      })
      .sort(
        (x, y) =>
          y.points - x.points ||
          y.winPct - x.winPct ||
          y.games - x.games ||
          x.username.localeCompare(y.username)
      );
  }

  return { games, headToHead: h2h, standings: leaderboards };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function loadLeague() {
  const cfg = JSON.parse(fs.readFileSync(LEAGUE_FILE, 'utf8'));
  const seen = new Set();
  const players = [];
  for (const raw of cfg.players || []) {
    const username = String(raw).toLowerCase().trim();
    if (!username || seen.has(username)) continue;
    seen.add(username);
    players.push({ username, display: String(raw).trim() });
  }
  players.sort((a, b) => a.username.localeCompare(b.username));
  return { players, timeClasses: cfg.timeClasses || TIME_CLASSES };
}

async function main() {
  const now = new Date();
  const { players } = loadLeague();
  const leagueSet = new Set(players.map((p) => p.username));
  console.log(`League: ${players.map((p) => p.display).join(', ')}`);

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const allGames = [];
  const unavailable = [];
  for (const p of players) {
    console.log(`Fetching ${p.display}...`);
    const { games, unavailable: gone } = await fetchAllGamesForUser(p.username, now);
    if (gone) unavailable.push(p.username);
    allGames.push(...games);
  }

  const leagueGames = filterLeagueGames(allGames, leagueSet);
  console.log(`Total games fetched: ${allGames.length}; league-vs-league (deduped): ${leagueGames.length}`);

  const { games, headToHead, standings } = buildAggregates(leagueGames, players);

  const output = {
    generatedAt: now.toISOString(),
    players,
    timeClasses: TIME_CLASSES,
    buckets: BUCKETS,
    standings,
    headToHead,
    games,
    unavailable,
    totals: { leagueGames: leagueGames.length },
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(output, null, 2));
  console.log(`Wrote ${RESULTS_FILE}`);
  if (unavailable.length) console.log(`Unavailable profiles: ${unavailable.join(', ')}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  httpGet,
  fetchArchives,
  fetchMonth,
  trimGame,
  filterLeagueGames,
  classifyOutcome,
  buildAggregates,
  loadLeague,
  DRAW_RESULTS,
  TIME_CLASSES,
  BUCKETS,
};
