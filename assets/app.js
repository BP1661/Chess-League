/* Chess League Tracker — static renderer. Fetches data/results.json and draws
   standings, a head-to-head matrix, and a filterable game log. No dependencies. */
(function () {
  'use strict';

  var BUCKET_LABELS = { all: 'All', bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapid', daily: 'Daily' };

  var state = {
    data: null,
    bucket: 'all',
    pair: null, // {a, b} usernames, or null
  };

  var el = {
    updated: document.getElementById('updated'),
    error: document.getElementById('error'),
    toggle: document.getElementById('tc-toggle'),
    standings: document.getElementById('standings'),
    matrix: document.getElementById('matrix'),
    games: document.getElementById('games'),
    logCount: document.getElementById('log-count'),
    clearFilter: document.getElementById('clear-filter'),
    refresh: document.getElementById('refresh-link'),
  };

  function displayOf(username) {
    var p = state.data.playerMap[username];
    return p ? p.display : username;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function wdl(rec) {
    return (
      '<span class="wdl">' +
      '<span class="w">' + rec.w + '</span><span class="sep">–</span>' +
      '<span class="l">' + rec.l + '</span><span class="sep">–</span>' +
      '<span class="d">' + rec.d + '</span></span>'
    );
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  // ---- rendering ----------------------------------------------------------

  function renderToggle() {
    var buckets = state.data.buckets;
    el.toggle.innerHTML = '';
    buckets.forEach(function (b) {
      var btn = document.createElement('button');
      btn.textContent = BUCKET_LABELS[b] || b;
      btn.className = b === state.bucket ? 'active' : '';
      btn.addEventListener('click', function () {
        state.bucket = b;
        renderToggle();
        renderStandings();
        renderMatrix();
      });
      el.toggle.appendChild(btn);
    });
  }

  function renderStandings() {
    var rows = state.data.standings[state.bucket] || [];
    var html =
      '<thead><tr><th class="rank">#</th><th>Player</th>' +
      '<th class="num">Pts</th><th class="num">GP</th>' +
      '<th class="num">W</th><th class="num">L</th><th class="num">D</th>' +
      '<th class="num">Win%</th></tr></thead><tbody>';
    var rank = 0;
    rows.forEach(function (r) {
      rank += 1;
      var unavailable = state.data.unavailable.indexOf(r.username) !== -1;
      html +=
        '<tr><td class="rank">' + rank + '</td>' +
        '<td>' + esc(displayOf(r.username)) +
        (unavailable ? '<span class="badge-unavailable" title="Profile private or unavailable">⚠</span>' : '') +
        '</td>' +
        '<td class="num pts">' + r.points + '</td>' +
        '<td class="num">' + r.games + '</td>' +
        '<td class="num">' + r.wins + '</td>' +
        '<td class="num">' + r.losses + '</td>' +
        '<td class="num">' + r.draws + '</td>' +
        '<td class="num">' + r.winPct.toFixed(1) + '</td></tr>';
    });
    html += '</tbody>';
    el.standings.innerHTML = html;
  }

  function renderMatrix() {
    var players = state.data.players;
    var b = state.bucket;
    var html = '<thead><tr><th class="corner"></th>';
    players.forEach(function (p) {
      html += '<th class="cell-head num">' + esc(p.display) + '</th>';
    });
    html += '</tr></thead><tbody>';

    players.forEach(function (row) {
      html += '<tr><th class="rowhead">' + esc(row.display) + '</th>';
      players.forEach(function (col) {
        if (row.username === col.username) {
          html += '<td class="self">—</td>';
          return;
        }
        var rec = (state.data.headToHead[row.username + '|' + col.username] || {})[b] || { w: 0, l: 0, d: 0 };
        var total = rec.w + rec.l + rec.d;
        var sel =
          state.pair &&
          ((state.pair.a === row.username && state.pair.b === col.username) ||
            (state.pair.a === col.username && state.pair.b === row.username));
        var cls = 'cell' + (total === 0 ? ' empty' : '') + (sel ? ' selected' : '');
        html +=
          '<td class="' + cls + '" data-a="' + row.username + '" data-b="' + col.username + '">' +
          (total === 0 ? '·' : wdl(rec)) +
          '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody>';
    el.matrix.innerHTML = html;

    Array.prototype.forEach.call(el.matrix.querySelectorAll('td.cell'), function (td) {
      td.addEventListener('click', function () {
        var a = td.getAttribute('data-a');
        var bb = td.getAttribute('data-b');
        if (state.pair && state.pair.a === a && state.pair.b === bb) {
          state.pair = null; // toggle off
        } else {
          state.pair = { a: a, b: bb };
        }
        renderMatrix();
        renderGames();
      });
    });
  }

  function filteredGames() {
    var games = state.data.games;
    var b = state.bucket;
    return games.filter(function (g) {
      if (b !== 'all' && g.timeClass !== b) return false;
      if (state.pair) {
        var set = { white: g.white, black: g.black };
        var inPair =
          (set.white === state.pair.a && set.black === state.pair.b) ||
          (set.white === state.pair.b && set.black === state.pair.a);
        if (!inPair) return false;
      }
      return true;
    });
  }

  function renderGames() {
    var games = filteredGames();

    if (state.pair) {
      el.clearFilter.hidden = false;
      el.clearFilter.textContent =
        'Clear filter: ' + displayOf(state.pair.a) + ' vs ' + displayOf(state.pair.b) + ' ✕';
    } else {
      el.clearFilter.hidden = true;
    }

    el.logCount.textContent =
      games.length + ' game' + (games.length === 1 ? '' : 's') +
      (state.bucket !== 'all' ? ' · ' + BUCKET_LABELS[state.bucket] : '');

    if (games.length === 0) {
      el.games.innerHTML = '<tbody><tr><td class="empty-state">No games match this filter yet.</td></tr></tbody>';
      return;
    }

    var html =
      '<thead><tr><th>Date</th><th>White</th><th>Black</th><th>Result</th><th>Type</th><th></th></tr></thead><tbody>';
    games.forEach(function (g) {
      var whiteWon = g.winner === g.white;
      var blackWon = g.winner === g.black;
      var resultCell = g.draw
        ? '<span class="result-draw">½–½ Draw</span>'
        : '<span class="winner">' + esc(displayOf(g.winner)) + '</span> won';
      html +=
        '<tr>' +
        '<td>' + fmtDate(g.date) + '</td>' +
        '<td' + (whiteWon ? ' class="winner"' : '') + '>' + esc(displayOf(g.white)) + '</td>' +
        '<td' + (blackWon ? ' class="winner"' : '') + '>' + esc(displayOf(g.black)) + '</td>' +
        '<td>' + resultCell + '</td>' +
        '<td><span class="tc-badge">' + esc(g.timeClass || '?') + '</span></td>' +
        '<td>' + (g.url ? '<a class="game-link" href="' + esc(g.url) + '" target="_blank" rel="noopener">view ↗</a>' : '') + '</td>' +
        '</tr>';
    });
    html += '</tbody>';
    el.games.innerHTML = html;
  }

  function render() {
    var d = state.data;
    var when = d.generatedAt ? new Date(d.generatedAt) : null;
    el.updated.textContent = when
      ? 'Updated ' + when.toLocaleString()
      : 'No data yet — waiting for the first update run.';

    renderToggle();
    renderStandings();
    renderMatrix();
    renderGames();
  }

  el.clearFilter.addEventListener('click', function () {
    state.pair = null;
    renderMatrix();
    renderGames();
  });

  // ---- boot ---------------------------------------------------------------

  fetch('data/results.json', { cache: 'no-store' })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function (data) {
      data.playerMap = {};
      (data.players || []).forEach(function (p) {
        data.playerMap[p.username] = p;
      });
      data.unavailable = data.unavailable || [];
      data.buckets = data.buckets || ['all', 'bullet', 'blitz', 'rapid', 'daily'];
      state.data = data;
      render();
    })
    .catch(function (err) {
      el.updated.textContent = '';
      el.error.hidden = false;
      el.error.textContent =
        'Could not load results.json (' + err.message + '). ' +
        'If this is a fresh deploy, run the “update-results” GitHub Action once to generate the data.';
    });
})();
