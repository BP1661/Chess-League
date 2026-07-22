# Chess League ♞

A self-updating tracker for a **scheduled round-robin chess league** on chess.com.
You define the players and a weekly matchup schedule; the tracker finds each
matchup's game on chess.com and builds live **standings** + a **week-by-week
schedule/results** page.

- Each scheduled matchup counts the **first game** the two players play against
  each other **inside that week's window** (weeks run in the league timezone).
- Results are precomputed for every time control, so the page's **Rapid / Blitz /
  Bullet / Daily** switch is instant. The default (e.g. Rapid) is set in config.
- **Standings** rank by total game points (**win 1 · draw ½ · loss 0**).

The site is fully static. A scheduled GitHub Action fetches server-side, caches
results in the repo, and deploys to GitHub Pages. Zero cost, zero server.

## Live site

`https://bp1661.github.io/Chess-League/`

## Repo layout

```
league.json               # players + weekly schedule + settings (edit this)
scripts/fetch-results.js  # fetch + resolve matchups + standings → data/results.json
scripts/make-schedule.js  # round-robin schedule generator for future leagues
scripts/test-logic.js     # offline logic tests (npm test)
data/results.json         # generated output the page reads
data/cache/               # cached monthly archives (closed months fetched once)
index.html + assets/      # the static page
.github/workflows/update-results.yml
```

## Configuring the league — `league.json`

```jsonc
{
  "name": "Chess League — Season 1",
  "timezone": "America/Los_Angeles",   // week windows use this zone
  "defaultTimeControl": "rapid",       // which time control the page shows first
  "timeControls": ["rapid", "blitz", "bullet", "daily"],
  "weekStart": "2026-07-20",           // Week 1's Monday (PT). Weeks derive from this.
  "players": [
    { "name": "Ben", "username": "bigb1201" },   // display name → chess.com handle
    { "name": "Tom", "username": "lamelo_balllll" }
    // ...
  ],
  "weeks": [
    {
      "week": 1,
      "rounds": [
        { "round": 1, "bye": "Pole",
          "matchups": [["Ben", "Tom"], ["Jack", "Bode"], ["Blake", "Sam"]] }
        // matchups are [white, black] display names
      ]
    }
    // ...
  ]
}
```

- **Each week is 7 days** starting from `weekStart` (Mon–Sun). Change `weekStart`
  if the season began on a different date — every week shifts with it.
- **Matchups** are `[whiteName, blackName]`. Scoring ignores who actually had
  which color; the schedule's color is just for display orientation of the score
  (`1–0` = the scheduled white player won).
- Add/remove a player = edit `players` and the schedule, then commit.

### Generating a schedule for a future league

```bash
node scripts/make-schedule.js --players Ann,Bob,Cy,Deb,Eve --legs 2 --rounds-per-week 4
```

Prints a ready-to-paste `league.json` stub (single or double round-robin, one bye
per round for odd player counts). Fill in each player's chess.com username and set
`weekStart`.

## Refreshing the data

- **Automatic:** every 6 hours (cron in the workflow).
- **Manual:** GitHub → **Actions** → **update-and-deploy** → **Run workflow**
  (the "⟳ Refresh now" link on the page points here).

Only months that overlap the season are fetched, and closed months are cached, so
reruns are fast and easy on the API.

## One-time setup

1. **Make the repo public** (required for free GitHub Pages).
2. **Settings → Pages → Source** → **GitHub Actions**.
3. **Settings → Actions → General → Workflow permissions** → *Read and write
   permissions* (so the Action can commit the cached data back).
4. **Actions → update-and-deploy → Run workflow** to fetch data and deploy.

## Running locally

No dependencies (Node ≥ 20 built-in `fetch`).

```bash
node scripts/fetch-results.js   # fetch + build data/results.json
npm run serve                   # preview at http://localhost:8000
npm test                        # offline logic tests
```

> Fetching needs outbound access to `api.chess.com`; some sandboxes block it, but
> GitHub's Action runners do not.
