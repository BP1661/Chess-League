#!/usr/bin/env node
'use strict';

/**
 * Round-robin schedule generator for future leagues.
 *
 * Emits the `weeks` array (and a players stub) for league.json using the circle
 * method. Handles an odd number of players (one bye per round), single or double
 * round-robin (double = reversed colors in the second leg), and groups rounds
 * into weeks.
 *
 * Usage:
 *   node scripts/make-schedule.js --players Ben,Tom,Pole,Jack,Bode,Blake,Sam \
 *     --legs 2 --rounds-per-week 4
 *
 * Flags:
 *   --players  Comma-separated display names (required).
 *   --legs     1 = single round-robin, 2 = double (default 2).
 *   --rounds-per-week  How many rounds per week bucket (default 4).
 *
 * Copy the printed JSON into league.json (fill in each player's chess.com
 * username and set weekStart).
 */

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : 'true';
      args[key] = val;
    }
  }
  return args;
}

/** Circle-method single round-robin. Returns [{pairs:[[white,black]...], bye}]. */
function singleRoundRobin(names) {
  const arr = names.slice();
  const BYE = '__bye__';
  if (arr.length % 2) arr.push(BYE);
  const n = arr.length;
  let rest = arr.slice(1);
  const fixed = arr[0];
  const rounds = [];
  for (let r = 0; r < n - 1; r += 1) {
    const row = [fixed, ...rest];
    const pairs = [];
    let bye = null;
    for (let i = 0; i < n / 2; i += 1) {
      const a = row[i];
      const b = row[n - 1 - i];
      if (a === BYE) { bye = b; continue; }
      if (b === BYE) { bye = a; continue; }
      // Alternate colors by round + board to keep white/black balanced.
      pairs.push((r + i) % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push({ pairs, bye });
    rest = [rest[rest.length - 1], ...rest.slice(0, rest.length - 1)]; // rotate
  }
  return rounds;
}

function buildSchedule(names, legs, roundsPerWeek) {
  let rounds = singleRoundRobin(names);
  if (legs === 2) {
    const second = rounds.map((r) => ({
      pairs: r.pairs.map(([w, b]) => [b, w]), // reversed colors
      bye: r.bye,
    }));
    rounds = rounds.concat(second);
  }

  const weeks = [];
  let roundNo = 0;
  for (let i = 0; i < rounds.length; i += roundsPerWeek) {
    const bucket = rounds.slice(i, i + roundsPerWeek);
    weeks.push({
      week: weeks.length + 1,
      rounds: bucket.map((r) => ({
        round: (roundNo += 1),
        bye: r.bye,
        matchups: r.pairs,
      })),
    });
  }
  return weeks;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.players) {
    console.error('Missing --players. Example:\n  node scripts/make-schedule.js --players Ann,Bob,Cy,Deb,Eve --legs 2 --rounds-per-week 4');
    process.exit(1);
  }
  const names = args.players.split(',').map((s) => s.trim()).filter(Boolean);
  const legs = Number(args.legs || 2);
  const roundsPerWeek = Number(args['rounds-per-week'] || 4);

  const weeks = buildSchedule(names, legs, roundsPerWeek);
  const stub = {
    name: 'New League',
    timezone: 'America/Los_Angeles',
    defaultTimeControl: 'rapid',
    timeControls: ['rapid', 'blitz', 'bullet', 'daily'],
    weekStart: 'YYYY-MM-DD',
    players: names.map((n) => ({ name: n, username: 'CHESS_COM_USERNAME' })),
    weeks,
  };
  console.log(JSON.stringify(stub, null, 2));
  console.error(
    `\n// ${names.length} players, ${legs === 2 ? 'double' : 'single'} round-robin, ` +
    `${weeks.reduce((a, w) => a + w.rounds.length, 0)} rounds across ${weeks.length} weeks.`
  );
}

if (require.main === module) main();

module.exports = { singleRoundRobin, buildSchedule };
