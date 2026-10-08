# orwarden

Self-hosted dashboard that keeps OpenRouter routing honest. It scores every provider endpoint of the models you use by price, speed and reliability, keeps a global provider ban list in the workspace default guardrail, and builds per-model presets (`@preset/<slug>`) that pin the most efficient providers in order.

## Run

```sh
cp .env.example .env   # set DASHBOARD_PASSWORD (8+ chars)
docker compose up -d
```

Upgrading an install that ran as `rerouter`: run `docker compose up -d --remove-orphans` once from the same directory so the old container is removed and stops holding the port. If the directory was renamed too, remove the old container by hand first (`docker rm -f rerouter-rerouter-1`). The existing `data/rerouter.db` keeps being used.

Open `http://127.0.0.1:3000`, log in with the password and paste an OpenRouter management key. The key is stored encrypted (AES-GCM, key derived from the dashboard password) in `data/orwarden.db` (an existing `data/rerouter.db` keeps being used). `OPENROUTER_MANAGEMENT_KEY` in `.env` is an optional fallback.

The server refreshes data on `REFRESH_CRON` (settings can override it). Scheduled refreshes run the ban optimizer with hysteresis; in `apply` mode they also patch the guardrail and sync presets marked as auto-sync. Manual actions in the dashboard always apply immediately.

## How it works

orwarden answers one question per model: which providers should serve it, in which order, so you pay as little as possible without getting quantized or unreliable output. Everything below uses the defaults from Settings; every number in brackets is configurable.

### Inputs

- **Snapshot.** On every refresh the server reads the workspace guardrail, your activity and, for every tracked model, all of its endpoints: prices (`p_in`, `p_out`, `p_cache`), quantization, 1-day and 30-minute uptime, throughput, latency, tool support and ZDR.
- **Tracked models.** Models with traffic in the usage window (last `7` completed UTC days, 1–30) plus models you add by hand. Models you remove stay excluded.
- **Workload.** A model's traffic is described by three numbers:
  - `h` – cache hit ratio, cached input tokens / input tokens;
  - `r` – output/input ratio, output tokens (reasoning included) / input tokens;
  - input tokens per day.

  *Actual traffic* takes all three from your activity (tokens over the window divided by the number of days; models without traffic fall back to `h = 0.5`, `r = 0.2` and the default volume). *Named scenarios* (`chat`, `chat-cached`, `agent`, `reasoning`, editable) and *Custom* use fixed `h`, `r`, tool requirement and a volume you choose (default 1M input tokens per day).

### Price of an endpoint

Cost per 1M input tokens for a workload:

```
C = (1 − h) · p_in + h · p_cache + r · p_out
```

Prices are per 1M tokens, so `C` already includes the cached part of the input and the output that the input produces. Money over a period is `C × tokens per day × days / 1M`.

The **effective price** divides by uptime, because a failed request is retried elsewhere: `C_eff = C / uptime`. Endpoints slower than `minTps` (off by default) are multiplied by `slowPenalty` (`1.2`) in the ban optimizer.

### Verdicts

Every endpoint is `ok`, `outlier` or `hard-bad`. Only `ok` endpoints can enter a preset.

- **Hard-bad**
  - quantization below the minimum (`fp8`; per-model exceptions such as `openai/gpt-oss → fp4` for models trained in low precision);
  - undisclosed quantization on an open-weight model (closed models have no quantization rules);
  - 1-day uptime below `97%`;
  - output price above `2.5×` the model median.
- **Outlier**
  - output price above `1.5×` the median;
  - cache price above `3×` the median when the model's cache hit ratio is above `0.3`.

Medians are taken over endpoints that pass the quantization rule.

Quantization ranks: `fp4/int4 < fp6 < fp8/int8 < fp16/bf16 < fp32`.

### Scores

Scores run from 0 to 100 and are relative to the eligible endpoints of the same model:

- **Price** = `100 × C_min / C`, where `C_min` is the cheapest eligible endpoint for the selected workload.
- **Speed** = `100 × (0.7 × tps / tps_max + 0.3 × latency_min / latency)`. An unknown throughput or latency counts as 30%.
- **Reliability** = `100 × (uptime − 0.9) / 0.1`, clamped to 0–100, with uptime = `0.8 × 1d + 0.2 × 30m`.
- **Overall** = `(Price × w_price + Speed × w_speed + Reliability × w_rel) / (w_price + w_speed + w_rel)`. Weights are `60 / 20 / 20` by default. For open-weight models, `15` points are subtracted when the quantization is undisclosed.

### Presets: how the economical list is chosen

A preset is built per model from the **saved** settings only. The filter bar is a what-if view: it changes the tables, never what gets written. Use *Save as defaults* to make a view the rule.

1. **Eligible.** The endpoint must:
   - have the verdict `ok`;
   - support tools when the preset workload needs them;
   - offer ZDR when *ZDR endpoints only* is on;
   - not belong to a provider in the global ban list;
   - not be excluded on the preset card.
2. **Ranking**, set by *Ranking* in Settings:
   - `score` (default): highest overall score first. Price weighs 60%, so this is "cheapest among fast and reliable".
   - `cost`: lowest effective price `C_eff` first, with the score as tie-breaker. This is the most economical option. Pick it if price is all that matters.

   Pinned endpoints always come first, in the order you pinned them.
3. **Top N.** The first `5` (1–20) endpoints form the preset.
4. **Written config:**

   ```json
   {
     "model": "<model>",
     "provider": {
       "order": ["<tag 1>", "<tag 2>", "..."],
       "only": ["<same tags>"],
       "allow_fallbacks": true,
       "quantizations": ["<min quant and above>"],
       "require_parameters": true
     }
   }
   ```

   - `order` and `only` are the ranked tags, so requests never leave the list.
   - `allow_fallbacks` moves to the next endpoint in the list when one fails.
   - `quantizations` is omitted for closed models and when an endpoint reports a non-standard quantization name.
   - `require_parameters` is set only for tool workloads.

**Expected price of a preset.** Requests go to #1. A share of them equal to its downtime falls through to #2, and so on down the list:

```
served_i = uptime_i × Π_{j<i} (1 − uptime_j)
price    = Σ served_i · C_i / Σ served_i
```

This is the "With saved preset" figure. It is compared with:

- **Default routing:** what OpenRouter does without a preset. It spreads traffic across all non-ignored endpoints with weight `uptime / p²`, where `p` is `p_in` by default (`optimizer.routingPrice` in the settings API switches it to `p_in + p_out` or the blended `C`).
- **With global bans:** the same spread after the ban list is applied.

### Global bans

The ban optimizer writes the guardrail's `ignored_providers`:

- **Objective.** Each model's spend is the usage-weighted average of `C_eff × penalty`, with `r` raised to at least `0.5` so that output-heavy outliers always count. The penalties are `×3` for hard-bad, `×5` for an output outlier and `×1.5` for a cache outlier. The averaging uses the default routing weights.
- **Search.** A greedy search adds or removes one provider at a time while that lowers the objective by at least `1%`, for at most `20` moves.
- **Constraint.** A model may never drop below `2` good endpoints, or below what it has if it has fewer. No model may lose all of its endpoints.
- **Low-quant providers.** Providers that only serve below-minimum quantization are banned first (`filters.banLowQuantProviders`, on by default).
- **Manual policies.** *Ban* and *Allow* on the Providers tab override the optimizer.
- **Hysteresis.** Scheduled runs ban a provider after it was a candidate `2` runs in a row and unban after `3` clean runs. They change at most `3` providers per run.

The Providers tab shows, for every provider, how the cost of all tracked models changes if it is banned. A provider "blocks" a model when banning it would leave that model with no endpoint.

### Which options save money

| Goal | Setting |
| --- | --- |
| Cheapest preset regardless of speed | Settings → Ranking: `cost`, or raise the price weight |
| Fewer, cheaper fallbacks | Lower *Top N providers*; the preset price shows what each extra fallback adds |
| Price your real mix | Keep *Actual traffic*, or pick the scenario closest to your client (agents: `agent`, chat with long history: `chat-cached`) |
| Accept cheaper low-precision providers | Lower min quantization (quality risk; shown as "Risk" on the Models tab) |
| Spend less on retries | Keep min uptime high; `C_eff` already charges for downtime |

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
