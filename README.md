# FPL Differential

Season-long Fantasy Premier League companion — a differential-hunting instrument. Transfer targets
are presented like a differential diagnosis: low-ownership candidates ranked with supporting evidence
(projection, form, xGI/90, defensive contribution, fixture run) and red flags (injury news, rotation risk).

**Live:** https://fpl-differential.web.app (Firebase Hosting)

## Tabs

- **HQ** — deadline countdown (local time), chips tracker (both half-season sets), team value/bank, squad with injury flags, price arrows, transfer momentum. Switches to live points during an active gameweek.
- **Ddx** — the differential board. Ownership/position/price filters over every player in the game.
- **Fixtures** — FDR heat grid, next 6 GWs, sortable by ease, with attack/defense-specific difficulty toggles.
- **Captain** — your 15 ranked for the armband; template vs differential framing.
- **Rivals** — mini-league standings, the differential matrix (what they own that you don't, and your edges).

## Stack

React 18 + Vite + Tailwind v4, PWA (`vite-plugin-pwa`), lucide-react. Data from the official FPL API —
read-only, no login; the app needs only a team ID and (optionally) a classic-league ID, entered in Settings.

## Architecture notes

- The FPL API sends no CORS headers. Dev uses Vite's proxy (`/fpl-api`); production routes through a
  Cloudflare Worker (`worker/fpl-proxy.js`) whose URL is set in `src/config.js`. `VITE_FPL_PROXY` overrides
  it at build time; a normal build needs nothing set.
- Push notifications use standard Web Push (VAPID, no FCM console setup) with subscriptions stored in the
  same Worker's Cloudflare KV and a GitHub Actions cron as the sender — deadline reminders (about a day out,
  and again in the final 8 hours) and injury alerts. The cron is set for every 30 minutes, but GitHub runs it
  about five times a day; the reminder windows in `scripts/notify.mjs` are sized for that. An early plan put
  subscriptions in Firestore; that was superseded before launch, and the project has no Firestore database.
- Tests: `npm test` runs `test/run.mjs` — 18 suites (17 under `test/`, plus `scripts/test-notify-plan.mjs`),
  one process each, no dependencies. `npm test -- <name>` runs one. CI runs the same thing on pushes touching
  the worker, the push client, the cron, or the tests.
- Squads are private until each GW deadline passes — that's the API, not a bug. Pre-season, rankings lean
  on FPL's own projections and last season's per-90 rates (reliability-damped), blending to real data by GW6.

## Development

```bash
npm install
npm run dev      # Vite dev server with FPL API proxy
npm run deploy   # build + firebase deploy --only hosting
```

The Cloudflare worker deploys separately; `npm run deploy` does not touch it. It needs a one-time
`npx wrangler login` first:

```bash
cd worker && npx --yes wrangler@4.152.0 deploy
```

Run it from your own terminal (the desktop app's Terminal panel works). Claude's shell reads a stale copy of
the Cloudflare credential and fails asking for `CLOUDFLARE_API_TOKEN`. Adding `--dry-run` needs no login and is
worth doing first. The production worker URL is already in `src/config.js`, so nothing goes in `.env.production`.
