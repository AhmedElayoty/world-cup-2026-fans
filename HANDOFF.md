# WCup 2026 app — change summary & open work

> Handoff doc. Last updated 2026-06-29. App is a single `index.html` + `sw.js`,
> kept **byte-identical** across `AhmedElayoty/world-cup-2026-fans` and
> `AhmedElayoty/capriole-sports` — any app change must land in **both** repos.

## Current state
- **Live version: v2.90** (service-worker cache `wcfans-v96`), merged to `main` in both repos.
- Recent work was on branch `claude/argentina-jordan-match-issue-oya8ky`, squash-merged to `main`.

## What shipped (all merged, all live)
1. **v2.88 — knockout bracket bug fix.** `syncKnockout()` mapped ESPN events to bracket
   nodes by date+venue only, so a group game (Argentina vs Jordan) showed up as a knockout
   result and "advanced." Fix: gate `syncKnockout` on `e.season.type !== 13802`
   (group stage = `13802`) — the same gate `confirmedTeams()` already used. SW cache → v94.
2. **v2.89 — R32 opponent panel is lifecycle-aware.** Added `const R32_OPP = "auto"` +
   `_r32OppActive()`. The "probable Round-of-32 opponent" block on the Matches-tab hero
   now renders/recomputes **only during the group stage** and auto-hides once all groups
   finish (and auto-returns for the next tournament's group stage). Gated 3 call sites:
   `drawHero()` (render), `computeNatR32()` (recompute), `loadR32()` (server precompute fetch).
   `"on"`/`"off"` override available. Nothing deleted. SW cache → v95.
3. **v2.90 — weekly leaderboard waits for week completion.** `loadLeaderboard()` holds the
   weekly board on the in-play week and won't roll to the new calendar week (resetting points
   to 0) until the **previous** week's matches are all `post`. Aligns it with the champion
   banner (`lastCompletedWeek()`), which was already completion-based. Fixes "score reset while
   last week's late match (South Africa v Canada, running past UAE midnight) was still live."
   **This is the desired behaviour — keep it.** SW cache → v96.

## Reverted / abandoned — do NOT reapply
- **v2.91** — a `matchWeek()` change that reassigned a Sunday-night→Monday match to the *new*
  week. It was **never committed or pushed** (discarded locally). v2.90 is the chosen behaviour.

## Repo-only ops tooling (world-cup-2026-fans `.github/` only; no app/user impact)
Run from the repo's **Actions** tab. Read-only unless noted.
- `usage-report.yml` / `.github/scripts/usage-report.mjs` — headcount: unique visitors,
  active 24h/7d, accounts, push subscribers, predictors, chat authors, top countries.
- `week-status.yml` / `.github/scripts/week-status.mjs` — per-week date range,
  finished/live/upcoming counts, computed champion, and what the banner resolves to + why.
- `push-pin.yml` / `.github/scripts/push-pin.mjs` — **writes**: pins notification ids into the
  dedup ledger `capriole_wc26_push_sent` (maintenance; merge-only + read-back verified).

## ⚠️ OPEN WORK — the Cloudflare Worker (NOT in this repo)
- The **live push sender** is a Cloudflare Worker named **`wc26-push-scheduler`**, on a
  **1-minute cron**. Its source is **not in either GitHub repo** — it lives only in the
  Cloudflare dashboard. The GitHub Action `push-send.yml` is a **manual fallback only**
  (last ran 2026-06-26), so repo changes do not affect live notifications.
- **Bug:** it re-sends the one-time "Egypt qualified for the Round of 32" notification
  repeatedly. Proven that it **ignores the shared dedup ledger** `capriole_wc26_push_sent`:
  the ids `q-r32-Egypt` and `egy-r32` are already in that ledger (359 entries) yet it still
  fires. Its dedup is likely its own Cloudflare KV that isn't persisting / isn't being checked.
- Worker env vars (from the dashboard): `DRY_RUN=false`, `MIRROR_TEXTDB=true`,
  secret `PUSH_ADMIN_TOKEN`, plus a VAPID private-key secret.

### What to change (the balance)
1. Pull the Worker source (`wrangler login`, then fetch `wc26-push-scheduler`) and **commit it
   to the repo** under e.g. `cloudflare/wc26-push-scheduler.js` (+ `wrangler.toml`) so it's
   version-controlled.
2. **Fix its dedup** so each one-time milestone (`q-r32-Egypt`, `egy-r32`, etc.) fires once:
   persist/check its sent-store reliably, and ideally also consult the shared
   `capriole_wc26_push_sent` ledger as a backstop.
3. Deploy with `wrangler deploy`.

### Immediate stop options (no code)
- Set Worker var `DRY_RUN=true` (computes but sends nothing), **or** disable its cron trigger
  in the Cloudflare dashboard. End-users can also turn it off in-app: Settings → 🔔 Match alerts.

## Reference (public-by-design — these ship in the client JS)
- ESPN public API, league `fifa.world`.
- Data store `textdb.online`; keys prefixed `capriole_wc26_…` :
  `predictions`, `accounts`, `room_8842` (chat), `push_subs`, `push_sent` (dedup ledger),
  `r32`, `fifarank`, `analytics` (visitor counter), `celebrate`.
- VAPID **public** key lives in the client + `push-send.mjs`; the **private** key is a secret
  (GitHub `VAPID_PRIVATE_KEY` / Cloudflare secret) — never in the repo.

## Notes / discipline
- Bump `APP_VERSION` (in `index.html`) **and** the `CACHE` name in `sw.js` on every app change,
  so installed PWAs pick up the new shell.
- Mirror every `index.html`/`sw.js` change to both repos. Only `world-cup-2026-fans` deploys
  via GitHub Pages (`pages.yml`); `capriole-sports` is the primary on its legacy build path.
