#!/usr/bin/env node
'use strict';

/**
 * Chess League Tracker — schedule-driven data fetcher / aggregator.
 *
 * Reads league.json (players + a weekly round-robin schedule), pulls the
 * relevant months of chess.com games for each player, and for every scheduled
 * matchup finds the FIRST game the two players played against each other inside
 * that week's Pacific-time window. Results are precomputed for every time
 * control so the static page can switch instantly. Standings rank by total game
 * points (win 1 / draw ½ / loss 0).
 *
 * Closed months are cached to data/cache/ and never refetched; only months that
 * are still "live" (contain the current date) are re-pulled. No auth, no npm
 * dependencies — uses Node's built-in fetch (Node >= 20).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'data', 'cache');
const DATA_DIR = path.join(ROOT, 'data');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');
const LEAGUE_FILE = path.join(ROOT, 'league.json');

const USER_AGENT = 'chess-league-tracker/1.0 (+https://github.com/bp1661/chess-league)';

const DRAW_RESULTS = new Set([
  'agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Timezone helpers — convert a wall-clock date in a named zone to a UTC epoch.
// ---------------------------------------------------------------------------

/** Offset (ms) between the given zone's wall clock and UTC at `date`. */
function tzOffsetMs(timeZone, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const m = {};
  for (const p of dtf.formatToParts(date)) if (p.type !== 'literal') m[p.type] = p.value;
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second);
  return asUTC - date.getTime();
}

/** Epoch seconds for `YYYY-MM-DD` at 00:00:00 local time in `timeZone`. */
function localMidnightEpochSec(dateStr, timeZone) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const utcGuess = Date.UTC(y, mo - 1, d, 0, 0, 0);
  let off = tzOffsetMs(timeZone, new Date(utcGuess));
  let epoch = utcGuess - off;
  const off2 = tzOffsetMs(timeZone, new Date(epoch));
  if (off2 !== off) epoch = utcGuess - off2; // DST boundary correction
  return Math.floor(epoch / 1000);
}

/** Add `n` days to a `YYYY-MM-DD` string (calendar math in UTC). */
function addDays(dateStr, n) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function httpGet(url, { retries = 4 } = {}) {
  let attempt = 0;
  while (true) {
    attempt += 1;
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    } catch (err) {
      if (attempt > retries) throw err;
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    if (res.status === 404) return null;
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt <= retries) {
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
}

async function fetchArchives(username) {
  const url = `https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/archives`;
  const data = await httpGet(url);
  if (!data || !Array.isArray(data.archives)) return null;
  return data.archives;
}

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

/** Cache-aware month fetch. `liveMonths` = set of "YYYY-MM" still being played. */
async function fetchMonth(username, year, month, archiveUrl, liveMonths) {
  const key = `${year}-${String(month).padStart(2, '0')}`;
  const file = cachePath(username, year, month);
  if (!liveMonths.has(key) && fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* corrupt → refetch */ }
  }
  const data = await httpGet(archiveUrl);
  if (!data || !Array.isArray(data.games)) return [];
  const trimmed = data.games.map(trimGame);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(trimmed));
  return trimmed;
}

/** Fetch a user's games, restricted to the archive months in `monthSet`. */
async function fetchUserSeasonGames(username, monthSet, liveMonths) {
  const archives = await fetchArchives(username);
  if (archives === null) {
    console.warn(`! ${username}: profile unavailable (private or nonexistent) — skipping`);
    return { games: [], unavailable: true };
  }
  const games = [];
  for (const archiveUrl of archives) {
    const m = archiveUrl.match(/\/(\d{4})\/(\d{2})$/);
    if (!m) continue;
    const key = `${m[1]}-${m[2]}`;
    if (!monthSet.has(key)) continue;
    const monthGames = await fetchMonth(username, Number(m[1]), Number(m[2]), archiveUrl, liveMonths);
    games.push(...monthGames);
    await sleep(120);
  }
  console.log(`  ${username}: ${games.length} games in season months`);
  return { games, unavailable: false };
}

// ---------------------------------------------------------------------------
// Filtering + classification
// ---------------------------------------------------------------------------

function filterLeagueGames(games, leagueSet) {
  const seen = new Set();
  const out = [];
  for (const g of games) {
    const w = g.white?.username?.toLowerCase();
    const b = g.black?.username?.toLowerCase();
    if (!w || !b || !leagueSet.has(w) || !leagueSet.has(b)) continue;
    if (seen.has(g.url)) continue;
    seen.add(g.url);
    out.push(g);
  }
  return out;
}

/** Pair outcome from the raw result fields. */
function classifyOutcome(game) {
  if (game.white?.result === 'win') return { winner: 'white', draw: false };
  if (game.black?.result === 'win') return { winner: 'black', draw: false };
  return { winner: null, draw: true };
}

const pairKey = (a, b) => [a, b].sort().join('|');

/** Resolve a single game into a scheduled-matchup result oriented to `whiteUser`. */
function resultFromGame(game, whiteUser) {
  const { winner, draw } = classifyOutcome(game);
  let winnerUser = null;
  if (winner === 'white') winnerUser = game.white.username.toLowerCase();
  else if (winner === 'black') winnerUser = game.black.username.toLowerCase();

  let score;
  if (draw) score = '½–½';
  else score = winnerUser === whiteUser ? '1–0' : '0–1';

  return {
    status: 'played',
    draw,
    winnerUser,
    score, // oriented to the scheduled white player
    url: game.url,
    endTime: game.end_time,
    date: game.end_time ? new Date(game.end_time * 1000).toISOString() : null,
    timeClass: game.time_class,
    actualWhite: game.white.username.toLowerCase(),
    actualBlack: game.black.username.toLowerCase(),
  };
}

// ---------------------------------------------------------------------------
// League config
// ---------------------------------------------------------------------------

function loadLeague() {
  const cfg = JSON.parse(fs.readFileSync(LEAGUE_FILE, 'utf8'));
  const timeZone = cfg.timezone || 'America/Los_Angeles';
  const timeControls = cfg.timeControls || ['rapid', 'blitz', 'bullet', 'daily'];
  const defaultTimeControl = cfg.defaultTimeControl || timeControls[0];

  const players = cfg.players.map((p) => ({ name: p.name, username: p.username.toLowerCase() }));
  const nameToUser = {};
  const userToName = {};
  for (const p of players) {
    nameToUser[p.name] = p.username;
    userToName[p.username] = p.name;
  }

  // Derive each week's Mon–Sun window from weekStart.
  const weeks = cfg.weeks.map((w, i) => {
    const start = addDays(cfg.weekStart, 7 * i);
    const end = addDays(start, 6);
    const startEpoch = localMidnightEpochSec(start, timeZone);
    const endEpoch = localMidnightEpochSec(addDays(end, 1), timeZone); // exclusive
    return { week: w.week, start, end, startEpoch, endEpoch, rounds: w.rounds };
  });

  return { cfg, timeZone, timeControls, defaultTimeControl, players, nameToUser, userToName, weeks };
}

/** Archive months (YYYY-MM, UTC) spanning the whole season, padded ±1 month. */
function seasonMonths(weeks) {
  const minStart = Math.min(...weeks.map((w) => w.startEpoch));
  const maxEnd = Math.max(...weeks.map((w) => w.endEpoch));
  const months = new Set();
  const cur = new Date(minStart * 1000);
  cur.setUTCDate(1);
  const last = new Date(maxEnd * 1000);
  cur.setUTCMonth(cur.getUTCMonth() - 1); // pad before
  const stop = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 1)); // pad after
  while (cur <= stop) {
    months.add(`${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, '0')}`);
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return months;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function buildResults(league, pool, nowSec) {
  const { timeControls, players, nameToUser } = league;

  // Index league games by unordered pair.
  const byPair = new Map();
  for (const g of pool) {
    const k = pairKey(g.white.username.toLowerCase(), g.black.username.toLowerCase());
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push(g);
  }
  for (const list of byPair.values()) list.sort((a, b) => (a.end_time || 0) - (b.end_time || 0));

  // Standings accumulators, one per time control.
  const standings = {};
  for (const tc of timeControls) {
    standings[tc] = {};
    for (const p of players) standings[tc][p.username] = { wins: 0, losses: 0, draws: 0 };
  }

  const weeks = league.weeks.map((w) => {
    const isCurrent = nowSec >= w.startEpoch && nowSec < w.endEpoch;
    const windowClosed = nowSec >= w.endEpoch;

    const rounds = w.rounds.map((r) => {
      const matchups = r.matchups.map(([whiteName, blackName]) => {
        const whiteUser = nameToUser[whiteName];
        const blackUser = nameToUser[blackName];
        const candidates = (byPair.get(pairKey(whiteUser, blackUser)) || []).filter(
          (g) => g.end_time >= w.startEpoch && g.end_time < w.endEpoch
        );

        const results = {};
        for (const tc of timeControls) {
          const first = candidates.find((g) => g.time_class === tc); // earliest of this TC
          if (first) {
            const res = resultFromGame(first, whiteUser);
            results[tc] = res;
            // Accrue standings for this played game.
            const s = standings[tc];
            if (res.draw) {
              s[whiteUser].draws += 1;
              s[blackUser].draws += 1;
            } else {
              const loserUser = res.winnerUser === whiteUser ? blackUser : whiteUser;
              s[res.winnerUser].wins += 1;
              s[loserUser].losses += 1;
            }
          } else {
            results[tc] = { status: windowClosed ? 'missed' : 'pending', score: null };
          }
        }

        return { white: whiteName, black: blackName, whiteUser, blackUser, results };
      });

      return { round: r.round, bye: r.bye, half_end: !!r.half_end, matchups };
    });

    return {
      week: w.week, start: w.start, end: w.end,
      startEpoch: w.startEpoch, endEpoch: w.endEpoch,
      isCurrent, windowClosed, rounds,
    };
  });

  // Turn standings maps into sorted leaderboards.
  const leaderboards = {};
  for (const tc of timeControls) {
    leaderboards[tc] = players
      .map((p) => {
        const r = standings[tc][p.username];
        const games = r.wins + r.losses + r.draws;
        const points = r.wins + 0.5 * r.draws;
        return {
          name: p.name, username: p.username,
          points, games, wins: r.wins, losses: r.losses, draws: r.draws,
          winPct: games ? Math.round((r.wins / games) * 1000) / 10 : 0,
        };
      })
      .sort((a, b) => b.points - a.points || b.wins - a.wins || b.games - a.games || a.name.localeCompare(b.name));
  }

  return { weeks, standings: leaderboards };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const nowSec = Math.floor(Date.now() / 1000);
  const league = loadLeague();
  const leagueSet = new Set(league.players.map((p) => p.username));
  console.log(`League: ${league.cfg.name} — ${league.players.map((p) => `${p.name}(${p.username})`).join(', ')}`);

  const monthSet = seasonMonths(league.weeks);
  // Months whose window is still open (or in the future) must be refetched.
  const liveMonths = new Set();
  for (const w of league.weeks) {
    if (nowSec < w.endEpoch) {
      for (const key of monthsBetween(w.startEpoch, w.endEpoch)) liveMonths.add(key);
    }
  }
  console.log(`Season months: ${[...monthSet].join(', ')} | live (refetch): ${[...liveMonths].join(', ') || 'none'}`);

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const allGames = [];
  const unavailable = [];
  for (const p of league.players) {
    console.log(`Fetching ${p.name} (${p.username})...`);
    const { games, unavailable: gone } = await fetchUserSeasonGames(p.username, monthSet, liveMonths);
    if (gone) unavailable.push(p.username);
    allGames.push(...games);
  }

  const pool = filterLeagueGames(allGames, leagueSet);
  console.log(`League-vs-league games in season months (deduped): ${pool.length}`);

  const { weeks, standings } = buildResults(league, pool, nowSec);

  const output = {
    generatedAt: new Date(nowSec * 1000).toISOString(),
    league: {
      name: league.cfg.name,
      timezone: league.timeZone,
      timeControls: league.timeControls,
      defaultTimeControl: league.defaultTimeControl,
      players: league.players,
    },
    weeks,
    standings,
    unavailable,
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(output, null, 2));
  console.log(`Wrote ${RESULTS_FILE}`);
  if (unavailable.length) console.log(`Unavailable profiles: ${unavailable.join(', ')}`);
}

/** YYYY-MM months (UTC) touched by an epoch-second window. */
function monthsBetween(startSec, endSec) {
  const out = [];
  const cur = new Date(startSec * 1000);
  cur.setUTCDate(1);
  const stop = new Date((endSec - 1) * 1000);
  while (
    cur.getUTCFullYear() < stop.getUTCFullYear() ||
    (cur.getUTCFullYear() === stop.getUTCFullYear() && cur.getUTCMonth() <= stop.getUTCMonth())
  ) {
    out.push(`${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, '0')}`);
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  httpGet, fetchArchives, fetchMonth, trimGame,
  filterLeagueGames, classifyOutcome, resultFromGame, pairKey,
  loadLeague, buildResults, seasonMonths, monthsBetween,
  localMidnightEpochSec, addDays,
  DRAW_RESULTS,
};
