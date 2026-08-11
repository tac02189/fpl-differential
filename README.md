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
  Cloudflare Worker (`worker/fpl-proxy.js`) whose URL is injected at build time via `VITE_FPL_PROXY`.
- Push notifications use standard Web Push (VAPID, no FCM console setup) with subscriptions stored in
  Firestore and a GitHub Actions cron as the sender — deadline reminders (T-24h / T-2h) and injury alerts.
- Squads are private until each GW deadline passes — that's the API, not a bug. Pre-season, rankings lean
  on FPL's own projections and last season's per-90 rates (reliability-damped), blending to real data by GW6.

## Development

```bash
npm install
npm run dev      # Vite dev server with FPL API proxy
npm run deploy   # build + firebase deploy --only hosting
```

Worker deploy (one-time Cloudflare account + `npx wrangler login` required):

```bash
cd worker && npx wrangler deploy
```

Then put the worker URL in `.env.production` as `VITE_FPL_PROXY=https://fpl-proxy.<subdomain>.workers.dev`.
