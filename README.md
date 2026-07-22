# Chess League ♞

A self-updating head-to-head tracker for a fixed group of chess.com players.
It pulls each member's games from the chess.com public API, keeps only games
played **between two league members**, and shows a standings table, a
head-to-head matrix, and a filterable game log — broken out by time control
(bullet / blitz / rapid / daily).

The site is fully static. A scheduled GitHub Action does the fetching
server-side, caches results in the repo, and commits them; GitHub Pages then
serves the page. Zero cost, zero server.

## Live site

`https://bp1661.github.io/chess-league` (after Pages is enabled — see below).

## How it works

```
league.json                        # the list of players — edit this to add/remove
scripts/fetch-results.js           # fetch + filter + aggregate → data/results.json
data/results.json                  # generated output the page reads
data/cache/<user>_<YYYY>_<MM>.json # cached monthly archives (closed months fetched once)
index.html + assets/               # the static page
.github/workflows/update-results.yml
```

1. For each player, list their monthly archives, then fetch each month
   (past months are read from `data/cache/` and never refetched; only the
   current month is re-pulled).
2. Keep a game only if **both** players are in the league; dedupe by game URL.
3. Aggregate into per-pair records, standings (points = win 1 / draw ½), and a
   game log — each split per time class plus a combined total.
4. Write `data/results.json`; the page renders it.

Private/unavailable profiles are skipped gracefully (flagged with ⚠ on the
page) instead of failing the whole run.

## Adding or removing a player

Edit `league.json` and commit:

```json
{
  "players": ["LAMELO_BALLLLL", "colemartin99", "..."],
  "timeClasses": ["bullet", "blitz", "rapid", "daily"]
}
```

Usernames are case-insensitive. The next Action run picks up the change.

## Refreshing the data

- **Automatic:** every 6 hours (cron in the workflow).
- **Manual:** GitHub → **Actions** → **update-results** → **Run workflow**
  (the "⟳ Refresh now" link on the page points here).

## One-time setup

1. **Make the repo public** (required for free GitHub Pages).
2. **Settings → Pages** → *Deploy from a branch* → branch `main`, folder `/ (root)`.
3. **Settings → Actions → General → Workflow permissions** → *Read and write
   permissions* (so the Action can commit the updated data).
4. Trigger **update-results** once manually to generate the first dataset.

## Running locally

No dependencies (uses Node ≥ 20's built-in `fetch`).

```bash
node scripts/fetch-results.js   # fetch + build data/results.json
npm run serve                   # preview at http://localhost:8000
npm test                        # offline logic tests
```

> Note: fetching requires outbound access to `api.chess.com`. Some sandboxed
> environments block it; the GitHub Action runners do not.
