/* Chess League — static renderer. Reads data/results.json (schedule + per-time-
   control results) and renders standings + a week-by-week schedule. The time
   control switcher just re-reads precomputed data — no recomputation. */
(function () {
  'use strict';

  var TC_LABELS = { rapid: 'Rapid', blitz: 'Blitz', bullet: 'Bullet', daily: 'Daily' };

  var state = { data: null, tc: 'rapid', userToName: {} };

  var el = {
    leagueName: document.getElementById('league-name'),
    leagueSub: document.getElementById('league-sub'),
    updated: document.getElementById('updated'),
    error: document.getElementById('error'),
    toggle: document.getElementById('tc-toggle'),
    standings: document.getElementById('standings'),
    schedule: document.getElementById('schedule'),
    scheduleHint: document.getElementById('schedule-hint'),
    refresh: document.getElementById('refresh-link'),
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function nameOf(username) {
    return state.userToName[username] || username;
  }

  function fmtRange(startISO, endISO) {
    // start/end are YYYY-MM-DD strings.
    function d(s) {
      var p = s.split('-');
      return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', timeZone: 'UTC',
      });
    }
    return d(startISO) + ' – ' + d(endISO);
  }

  // ---- toggle --------------------------------------------------------------

  function renderToggle() {
    var tcs = state.data.league.timeControls;
    el.toggle.innerHTML = '';
    tcs.forEach(function (tc) {
      var btn = document.createElement('button');
      btn.textContent = TC_LABELS[tc] || tc;
      btn.className = tc === state.tc ? 'active' : '';
      btn.addEventListener('click', function () {
        state.tc = tc;
        renderAll();
      });
      el.toggle.appendChild(btn);
    });
  }

  // ---- standings -----------------------------------------------------------

  function renderStandings() {
    var rows = (state.data.standings || {})[state.tc] || [];
    var html =
      '<thead><tr><th class="rank">#</th><th>Player</th>' +
      '<th class="num">Pts</th><th class="num">GP</th>' +
      '<th class="num">W</th><th class="num">L</th><th class="num">D</th>' +
      '<th class="num">Win%</th></tr></thead><tbody>';
    var rank = 0;
    rows.forEach(function (r) {
      rank += 1;
      var gone = state.data.unavailable.indexOf(r.username) !== -1;
      html +=
        '<tr' + (rank === 1 ? ' class="leader"' : '') + '>' +
        '<td class="rank">' + rank + '</td>' +
        '<td>' + esc(r.name) +
        (gone ? '<span class="badge-warn" title="chess.com profile private/unavailable">⚠</span>' : '') +
        '</td>' +
        '<td class="num pts">' + r.points + '</td>' +
        '<td class="num">' + r.games + '</td>' +
        '<td class="num">' + r.wins + '</td>' +
        '<td class="num">' + r.losses + '</td>' +
        '<td class="num">' + r.draws + '</td>' +
        '<td class="num">' + r.winPct.toFixed(1) + '</td></tr>';
    });
    if (!rows.length) html += '<tr><td colspan="8" class="empty-state">No players.</td></tr>';
    html += '</tbody>';
    el.standings.innerHTML = html;
  }

  // ---- schedule ------------------------------------------------------------

  function matchupRow(mu, week) {
    var res = (mu.results || {})[state.tc] || { status: 'pending', score: null };
    var whiteWon = res.status === 'played' && res.winnerUser === mu.whiteUser;
    var blackWon = res.status === 'played' && res.winnerUser === mu.blackUser;

    var mid;
    if (res.status === 'played') {
      mid = '<a class="score" href="' + esc(res.url) + '" target="_blank" rel="noopener" title="View game">' +
        esc(res.score) + '</a>';
    } else if (res.status === 'missed') {
      mid = '<span class="chip missed">no game</span>';
    } else {
      // pending
      mid = '<span class="chip ' + (week.isCurrent ? 'live' : 'upcoming') + '">' +
        (week.isCurrent ? 'this week' : 'upcoming') + '</span>';
    }

    return (
      '<div class="matchup">' +
      '<span class="side white' + (whiteWon ? ' won' : '') + '">' + esc(nameOf(mu.whiteUser)) + '</span>' +
      '<span class="mid">' + mid + '</span>' +
      '<span class="side black' + (blackWon ? ' won' : '') + '">' + esc(nameOf(mu.blackUser)) + '</span>' +
      '</div>'
    );
  }

  function renderSchedule() {
    var weeks = state.data.weeks || [];
    var html = '';
    weeks.forEach(function (w) {
      html +=
        '<div class="week' + (w.isCurrent ? ' current' : '') + '">' +
        '<div class="week-head">' +
        '<span class="week-title">Week ' + w.week + '</span>' +
        '<span class="week-dates">' + fmtRange(w.start, w.end) + '</span>' +
        (w.isCurrent ? '<span class="chip live">current</span>' : '') +
        '</div>';
      w.rounds.forEach(function (r) {
        html +=
          '<div class="round">' +
          '<div class="round-head">Round ' + r.round +
          (r.half_end ? ' <span class="half">· end of first half</span>' : '') +
          '<span class="bye">bye: ' + esc(r.bye) + '</span>' +
          '</div>' +
          '<div class="matchups">';
        r.matchups.forEach(function (mu) { html += matchupRow(mu, w); });
        html += '</div></div>';
      });
      html += '</div>';
    });
    el.schedule.innerHTML = html || '<div class="empty-state">No schedule configured.</div>';
  }

  // ---- boot ----------------------------------------------------------------

  function renderAll() {
    renderToggle();
    renderStandings();
    renderSchedule();
  }

  function render() {
    var d = state.data;
    el.leagueName.textContent = '♞ ' + d.league.name;
    var legs = countMeetings(d);
    el.leagueSub.textContent =
      d.league.players.length + ' players · ' +
      (legs === 2 ? 'double ' : '') + 'round-robin · ' + (TC_LABELS[d.league.defaultTimeControl] || d.league.defaultTimeControl) + ' default';
    var when = d.generatedAt ? new Date(d.generatedAt) : null;
    el.updated.textContent = when ? 'Updated ' + when.toLocaleString() : 'No data yet.';
    el.scheduleHint.textContent =
      'Weeks run in ' + d.league.timezone + '. Bold = winner. Switch time control above.';
    renderAll();
  }

  function countMeetings(d) {
    // crude: does any pair appear twice across the schedule?
    var seen = {}, twice = false;
    (d.weeks || []).forEach(function (w) {
      w.rounds.forEach(function (r) {
        r.matchups.forEach(function (mu) {
          var k = [mu.whiteUser, mu.blackUser].sort().join('|');
          if (seen[k]) twice = true;
          seen[k] = true;
        });
      });
    });
    return twice ? 2 : 1;
  }

  fetch('data/results.json', { cache: 'no-store' })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function (data) {
      state.data = data;
      state.tc = data.league.defaultTimeControl || 'rapid';
      data.unavailable = data.unavailable || [];
      (data.league.players || []).forEach(function (p) { state.userToName[p.username] = p.name; });
      render();
    })
    .catch(function (err) {
      el.updated.textContent = '';
      el.error.hidden = false;
      el.error.textContent =
        'Could not load results.json (' + err.message + '). ' +
        'If this is a fresh deploy, run the “update-and-deploy” GitHub Action once to generate the data.';
    });
})();
