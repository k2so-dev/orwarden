# rerouter

Self-hosted dashboard that keeps OpenRouter routing honest. It scores every provider endpoint of the models you use by price, speed and reliability, keeps a global provider ban list in the workspace default guardrail, and builds per-model presets (`@preset/<slug>`) that pin the most efficient providers in order.

## Run

```sh
cp .env.example .env   # set DASHBOARD_PASSWORD (8+ chars)
docker compose up -d
```

Open `http://127.0.0.1:3000`, log in with the password and paste an OpenRouter management key. The key is stored encrypted (AES-GCM, key derived from the dashboard password) in `data/rerouter.db`. `OPENROUTER_MANAGEMENT_KEY` in `.env` is an optional fallback.

The server refreshes data on `REFRESH_CRON` (settings can override it). Scheduled refreshes run the ban optimizer with hysteresis; in `apply` mode they also patch the guardrail and sync presets marked as auto-sync. Manual actions in the dashboard always apply immediately.

## How endpoints are judged

- Cost per 1M input tokens: `C = (1 - h) * p_in + h * p_cache + r * p_out`, where `h` is the cache hit ratio and `r` the output/input ratio (from your activity or a scenario).
- Hard-bad: unknown quantization, quantization below the minimum (`fp8` by default, native exceptions such as `openai/gpt-oss` at `fp4`), uptime below 97%.
- Outlier: output price above 1.5x the model median, or cache price ratio above 3x the median when caching matters.
- Scores (0-100): price relative to the cheapest eligible endpoint, speed from throughput and latency, reliability from 1d and 30m uptime. The overall score is a weighted mix (60/20/20 by default).
- Presets take the top 5 eligible endpoints by overall score, with `only`, `order`, allowed quantizations and fallbacks enabled.

## Develop

```sh
bun install
DASHBOARD_PASSWORD=devpassword bun run dev:server
bun run dev:web        # Vite on :5173, proxies /api to :3000
bun run test
```

`vue-tsc` needs Node: `cd web && npx vue-tsc --noEmit`.

The frontend uses Vue 3.6 (Vapor mode, release candidate), shadcn-vue, Tailwind CSS 4 and a typed Hono RPC client (`web/src/lib/api.ts`).

## API

All routes live under `/api` and require a session cookie except `/api/auth/*`.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/auth/login`, `/auth/logout` | Session |
| GET | `/auth/session` | Session state |
| GET | `/status` | Key, workspace, last run, errors |
| PUT/DELETE | `/key` | Store or remove the management key |
| GET/PUT | `/settings`, POST `/settings/reset` | Settings |
| POST | `/refresh` | Pull fresh data (`{ full: true }` runs the scheduled cycle) |
| GET | `/catalog?q=` | Model search for the watchlist |
| GET | `/overview` | Models with endpoint scores, costs and scenarios |
| GET | `/history?model=` | Price and uptime history |
| GET | `/providers` | Provider table with ban effects |
| PUT | `/providers/:slug/policy` | `ban`, `allow` or `null` |
| POST | `/bans/apply`, `/bans/rollback` | Write the guardrail |
| GET | `/bans/history` | Runs and decisions |
| GET | `/presets` | Preset plans and remote status |
| PUT | `/presets/settings` | Slug, auto-sync, scenario, pinned, excluded |
| POST | `/presets/sync` | Create or update presets on OpenRouter |
| POST | `/alerts/test` | Send a test alert |

View queries accept `scenario` (`actual`, a scenario name or `custom`), `h`, `r`, `tools`, `tokensPerDay`, `days`, `minQuantization`, `minUptime`, `zdrOnly`, `hideBanned`, `wPrice`, `wSpeed`, `wReliability`.
