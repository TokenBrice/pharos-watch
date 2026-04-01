# Worker Infrastructure

Cloudflare Worker serving the Pharos API. Handles HTTP routing, edge caching, CORS, admin auth, and 28 scheduled runtime jobs across 13 cron expressions / trigger slots. `CRON_INTERVALS` / `/api/status` track the same 28 jobs; cemetery and tracking appendices are now folded into daily digest delivery instead of a separate cron.

Execution note: the `snapshot-supply` retry path runs on the `*/15 * * * *` trigger only after a downstream-safe `sync-stablecoins` cache write.

**Deployed at:** `api.pharos.watch` (public API route) and `ops-api.pharos.watch` (operator-prep route declared in `wrangler.toml`; pair with Cloudflare Access before use)

---

## Runtime Limits and Observability

Worker runtime safety and telemetry controls are declared in `worker/wrangler.toml` and should be managed in git (the CI deploy job now runs `wrangler versions upload`, preview smoke against the uploaded candidate, `wrangler versions deploy`, and then `wrangler triggers deploy`, so dashboard-only edits can be overwritten on the next deployment).

```toml
[limits]
cpu_ms = 30000

[observability]
enabled = true
head_sampling_rate = 0.1

[observability.logs]
enabled = true
invocation_logs = true
```

- `cpu_ms = 30000`: hard cap on CPU time per invocation (not wall-clock runtime). This is independent from in-app wall-clock cron timeouts in `logCronRun()`. Raised from 5000 to give isolated cron triggers comfortable headroom; higher Cloudflare ceilings are vendor-plan details and are intentionally not treated as repo source of truth here.
- `observability.enabled`: enables Worker traces.
- `head_sampling_rate = 0.1`: samples 10% of traces.
- `observability.logs.enabled` + `invocation_logs = true`: enables Workers Logs in dashboard.
- `preview_urls = true`: keeps per-version preview URLs available so CI can smoke an uploaded Worker version before production promotion.

---

## Env Interface

The `Env` interface is defined in `worker/src/lib/env.ts` and consumed by `worker/src/index.ts` plus the HTTP-request helper stack under `worker/src/handlers/http*.ts` and the scheduled-runtime entrypoint/context (`worker/src/handlers/scheduled.ts`, `worker/src/handlers/scheduled/context.ts`). `DB`, `CORS_ORIGIN`, `SELF_URL`, `CF_ACCESS_TEAM_DOMAIN`, and `CF_ACCESS_OPS_API_AUD` are set in `wrangler.toml`; the remaining active bindings are runtime env values (typically provided via `wrangler secret put`).

`worker/src/lib/env.ts` is now the canonical worker binding contract and exports four groupings:

- `WORKER_REQUIRED_ENV_KEYS`
- `WORKER_OPTIONAL_ENV_KEYS`
- `WORKER_RESERVED_ENV_KEYS`
- `WORKER_ACTIVE_ENV_KEYS` (`required + optional`)

The paired Pages Functions contract lives in `functions/lib/ops-env.ts` with the same `required` / `optional` / `reserved` / `active` shape. Worker runtime validation logs contract errors when Access bindings are only partially configured or when `PUBLIC_API_RATE_LIMIT_SALT` is missing.

| Binding                         | Type       | Required           | Used by                                                                                                                                                                    |
| ------------------------------- | ---------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DB`                            | D1Database | Yes                | All crons and API handlers                                                                                                                                                 |
| `CORS_ORIGIN`                   | string     | Yes                | Comma-separated CORS allowlist. Repo default: `https://pharos.watch,https://ops.pharos.watch`                                                                              |
| `SELF_URL`                      | string     | No                 | Status self-check external probe base URL; the default production origin (`https://api.pharos.watch`) is router-probed internally to avoid custom-domain self-fetch `522`s |
| `OPS_UI_ORIGIN`                 | string     | No                 | Reserved on the worker runtime for cross-runtime alignment. The value is active on Pages Functions host gating (`https://ops.pharos.watch`)                                 |
| `OPS_API_ORIGIN`                | string     | No                 | Reserved on the worker runtime for cross-runtime alignment. The value is active on Pages Functions proxying (`https://ops-api.pharos.watch`)                                |
| `CF_ACCESS_TEAM_DOMAIN`         | string     | No                 | Cloudflare Access team domain used by worker-side JWT verification for `ops-api.pharos.watch` admin requests (defaults to `pharos-watch` when unset)                    |
| `CF_ACCESS_OPS_UI_AUD`          | string     | No                 | Reserved on the worker runtime today; active only in the Pages contract once Pages-side UI JWT validation is introduced                                                    |
| `CF_ACCESS_OPS_API_AUD`         | string     | No                 | Cloudflare Access audience used by `worker/src/lib/auth.ts` to verify `Cf-Access-Jwt-Assertion` on `ops-api.pharos.watch` admin requests                                 |
| `ETHERSCAN_API_KEY`             | string     | No                 | Blacklist sync, USDS status                                                                                                                                                |
| `TRONGRID_API_KEY`              | string     | No                 | Blacklist sync (Tron chain)                                                                                                                                                |
| `DRPC_API_KEY`                  | string     | No                 | L2 archive node balance lookups                                                                                                                                            |
| `ALCHEMY_API_KEY`               | string     | No                 | Chain RPC primary endpoints                                                                                                                                                |
| `GRAPH_API_KEY`                 | string     | No                 | DEX liquidity (The Graph subgraphs)                                                                                                                                        |
| `ALERT_WEBHOOK_URL`             | string     | No                 | Discord/Slack error alerts                                                                                                                                                 |
| `ANTHROPIC_API_KEY`             | string     | No                 | Daily digest LLM generation                                                                                                                                                |
| `CMC_API_KEY`                   | string     | No                 | Price fallback (CoinMarketCap)                                                                                                                                             |
| `OPENEXCHANGERATES_API_KEY`     | string     | No                 | Real-time FX rate cross-validation (Open Exchange Rates)                                                                                                                   |
| `COINGECKO_API_KEY`             | string     | No                 | Price enrichment, depeg confirmation                                                                                                                                       |
| `SIM_API_KEY`                   | string     | No                 | Treasury stable-exposure snapshot reads against Sim by Dune wallet-balance APIs                                                                                            |
| `GITHUB_PAT`                    | string     | No (worker contract); Yes for feedback submissions | Feedback → GitHub Issues                                                                                                                                                   |
| `FEEDBACK_IP_SALT`              | string     | No (worker contract); Yes for feedback submissions | Rate limit IP hashing for `POST /api/feedback`                                                                                                                             |
| `PUBLIC_API_RATE_LIMIT_SALT`    | string     | Yes for deployed public API traffic | Dedicated salt for hashed public API rate limiting. Public `/api/*` traffic returns `503` until this binding is configured.                                |
| `TWITTER_API_KEY`               | string     | No                 | Digest → Twitter (OAuth consumer key)                                                                                                                                      |
| `TWITTER_API_SECRET`            | string     | No                 | Digest → Twitter (OAuth consumer secret)                                                                                                                                   |
| `TWITTER_ACCESS_TOKEN`          | string     | No                 | Digest → Twitter (access token)                                                                                                                                            |
| `TWITTER_ACCESS_TOKEN_SECRET`   | string     | No                 | Digest → Twitter (access token secret)                                                                                                                                     |
| `TELEGRAM_BOT_TOKEN`            | string     | No                 | Digest → Telegram, bot chat replies, subscriber alert dispatch                                                                                                             |
| `TELEGRAM_CHAT_ID`              | string     | No                 | Digest channel posts and cemetery announcements                                                                                                                            |
| `TELEGRAM_WEBHOOK_SECRET`       | string     | No                 | Telegram webhook secret validation via `X-Telegram-Bot-Api-Secret-Token`                                                                                                   |
| `MAINTENANCE_MODE`              | `string?`  | No                 | Optional. When set to the exact string `"true"`, the worker returns 503 for all non-`OPTIONS` requests. Used as a kill switch.                                             |
| `MINT_BURN_DISABLED_IDS`        | string     | No                 | Mint/burn runtime disable list by stablecoin ID (CSV)                                                                                                                      |
| `MINT_BURN_DISABLED_SYMBOLS`    | string     | No                 | Mint/burn runtime disable list by symbol (CSV)                                                                                                                             |
| `MINT_BURN_MAJOR_SYMBOLS`       | string     | No                 | Mint/burn health-check major symbols override (CSV)                                                                                                                        |
| `MINT_BURN_STALE_WARN_SEC`      | string     | No                 | Mint/burn stale-warning threshold override (seconds)                                                                                                                       |
| `MINT_BURN_STALE_CRIT_SEC`      | string     | No                 | Mint/burn stale-critical threshold override (seconds)                                                                                                                      |
| `MINT_BURN_ALERT_COOLDOWN_SEC`  | string     | No                 | Mint/burn stale alert dedupe cooldown override (seconds)                                                                                                                   |

---

## Module Initialization

Three modules derive runtime configuration from `Env` bindings via pure functions. These are called in the scheduled context factory (`worker/src/handlers/scheduled/context.ts`) and in `worker/src/handlers/http.ts`, with results passed as parameters rather than stored in module-level state:

| Function                                                | Called in             | Purpose                                              |
| ------------------------------------------------------- | --------------------- | ---------------------------------------------------- |
| `normalizeCgApiKey(env.COINGECKO_API_KEY)`               | `fetch` + `scheduled` | Returns normalized API key for CoinGecko requests    |
| `buildChainRpcs(env.ALCHEMY_API_KEY, env.DRPC_API_KEY)` | `fetch` + `scheduled` | Builds chain RPC configs with Alchemy/dRPC primaries |
| `normalizeWebhookUrl(env.ALERT_WEBHOOK_URL)`             | `scheduled`           | Returns normalized webhook URL for error alerts      |

These are pure functions. `Env` bindings are only available inside handler functions (not at module initialization time), so values are computed fresh per-request/per-trigger via the context factory. The notable exception is `worker/src/lib/jwt-verify.ts`, which intentionally keeps an in-memory JWKS cache (`cachedJwks`, 1-hour TTL) at module scope to avoid refetching Cloudflare Access signing keys on every admin request.

## Public API Rate Limiting

Non-admin public `/api/*` requests are rate-limited through the D1-backed `public_api_rate_limit` table with per-minute hashed IP buckets. The worker now requires a dedicated `PUBLIC_API_RATE_LIMIT_SALT` binding for this path and returns `503` for public API traffic until that binding is configured. `FEEDBACK_IP_SALT` remains scoped to feedback submission hashing only. If the distributed limiter path fails after a valid salt is present, the worker logs the failure and allows the request instead of switching to an isolate-local fallback limiter.

---

## HTTP Request Handling

### Method Routing

| Method    | Handling                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------- |
| `OPTIONS` | Returns 204 with CORS headers (preflight)                                                                            |
| `POST`    | `/api/feedback`, `/api/telegram-webhook`, and mutating admin endpoints from `shared/lib/api-endpoints.ts`            |
| `GET`     | Read endpoints + admin debug routes; mutating admin routes return 405 except `/api/audit-depeg-history?dry-run=true` |
| Other     | Returns 405 `{ error: "Method not allowed" }`                                                                        |

Method/path flags (`mutatingAdmin`, `cacheBypass`, probe groups, status actions) are centralized in `shared/lib/api-endpoints.ts` and consumed by both worker and frontend status tooling.

### Public API Rate Limiting

- `worker/src/handlers/http/gates.ts` calls `checkPublicApiRateLimit(...)` for non-admin public `/api/*` traffic before router dispatch.
- Default threshold: `300 requests / 60 seconds` per IP hash, enforced through the D1-backed `public_api_rate_limit` table.
- If the distributed D1 path fails, `worker/src/lib/rate-limit.ts` logs the failure and returns `null`, which makes the request gate fail open for that request.
- Requests that are already authorized for the `ops-api.pharos.watch` admin lane bypass this limiter.

### Public API Request-Source Attribution

- `worker/src/handlers/http.ts` records minute-bucketed public API attribution telemetry in `api_request_source_stats`
- the dataset is scoped to non-admin `/api/*` traffic and excludes `/api/telegram-webhook`
- source buckets are:
  - `web` when browser evidence indicates a request originated from `https://pharos.watch`
  - `external` for everything else in scope
- first-party website evidence comes from:
  - `Origin` or `Referer` matching `https://pharos.watch`
  - or the browser-safe frontend marker `application/vnd.pharos.web+json` in `Accept` combined with `Sec-Fetch-Site: same-site|same-origin`
- retention is pruned opportunistically to the latest `35` days
- operators read the aggregate split through `GET /api/request-source-stats` on `ops-api.pharos.watch`

### CORS Headers

Applied to every response via `addCorsHeaders()`:

| Header                          | Value                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `Access-Control-Allow-Origin`   | matching request origin from the `CORS_ORIGIN` allowlist, otherwise the first configured origin |
| `Vary`                          | `Origin`                                                                                        |
| `Access-Control-Allow-Methods`  | `GET, POST, OPTIONS`                                                                            |
| `Access-Control-Allow-Headers`  | `Content-Type, Idempotency-Key`                                                                 |
| `Access-Control-Expose-Headers` | `X-Data-Age, Warning`                                                                           |
| `Access-Control-Max-Age`        | `86400`                                                                                         |
| `X-Content-Type-Options`        | `nosniff`                                                                                       |
| `Strict-Transport-Security`     | `max-age=31536000; includeSubDomains`                                                           |
| `Referrer-Policy`               | `strict-origin-when-cross-origin`                                                               |
| `Content-Security-Policy`       | `default-src 'none'; frame-ancestors 'none'`                                                    |

`CORS_ORIGIN` is now treated as a comma-separated allowlist. If the incoming request includes an `Origin` header that matches one of the configured entries, the Worker echoes that specific origin. Otherwise it falls back to the first configured origin.

### Edge Cache Strategy

The Worker uses `caches.default` (Cloudflare's per-colo edge cache) to cache GET responses:

1. **Cache bypass rules**:
   - All non-GET requests bypass edge cache.
   - GET paths marked `cacheBypass: true` in `shared/lib/api-endpoints.ts` bypass edge cache (health, status, and admin/backfill endpoints like `/api/backfill-*`, `/api/audit-depeg-history`, `/api/backfill-dews`).

2. **Cache check:** `caches.default.match(cacheKey)` — returns cached response if available

3. **Cache store:** `ctx.waitUntil(cache.put(cacheKey, response.clone()))` — the response is cloned **without** CORS headers before caching. CORS headers are added per-request after cache lookup to avoid caching origin-specific headers.

4. **Cache-Control profiles** (set by individual API handlers):

| Profile  | `Cache-Control` header               | Used by                                                                                                                                                                           |
| -------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Realtime | `public, s-maxage=60, max-age=10`    | stablecoins, stablecoin-summary, blacklist, depeg-events, peg-summary, mint-burn-events                                                                                           |
| Per-coin | `public, s-maxage=300, max-age=10`   | stablecoin detail (`/api/stablecoin/:id`)                                                                                                                                         |
| Standard | `public, s-maxage=300, max-age=60`   | stablecoin-charts, redemption-backstops, usds-status, daily-digest, digest-archive, report-cards, stability-index, yield-rankings, mint-burn-flows, stress-signals |
| Custom   | `public, s-maxage=300, max-age=300`  | dex-liquidity                                                                                                                                                      |
| Slow     | `public, s-maxage=3600, max-age=300` | supply-history, bluechip-ratings, dex-liquidity-history, yield-history, safety-score-history                                                                                      |
| Archive  | `public, s-maxage=86400, max-age=3600` | digest-snapshot                                                                                                                                                  |

Admin `GET` routes are also forced to `Cache-Control: no-store` by `addAdminGetNoStoreHeader()` in `worker/src/router.ts`.

### External API Monitoring Baseline

When public API usage grows, monitor these three Cloudflare dimensions first:

1. **Per-endpoint request volume**
   - Track top paths by requests and trend (`/api/stablecoin/:id`, `/api/stablecoin-summary/:id`, `/api/stablecoins`, `/api/report-cards`).
   - Alert on sudden spikes (for example, >2x 24h baseline).
2. **Per-endpoint cache performance**
   - Track `CF-Cache-Status` mix (HIT vs MISS/BYPASS) and overall cache-hit ratio by path.
   - Investigate if heavy endpoints drift toward MISS-heavy traffic.
3. **Per-endpoint error rate**
   - Track 5xx rate by path (especially `502`/`503`), not just global error rate.
   - Alert when 5xx ratio breaches your SLO target (for example, >1% for 5 minutes).

This baseline is enough to catch most abuse, regression, or cache-efficiency problems early.

### Admin Auth

**File:** `worker/src/lib/auth.ts`

- Accepts only the `ops-api.pharos.watch` lane after Cloudflare Access has authenticated the caller and injected `Cf-Access-Jwt-Assertion`
- Internal worker-origin admin calls (for example `status-self-check`) simulate that same lane instead of using a shared secret
- Returns `null` if authorized, 401 Response if not
- The worker verifies `Cf-Access-Jwt-Assertion` against `CF_ACCESS_OPS_API_AUD` using the team-domain JWKS and enforces JWT claims including `aud`, `exp`, and `iss`.
- Cloudflare Access must still stay in front of `ops-api.pharos.watch`, because the worker does not authenticate callers independently of that Access layer.

### Router-Dispatched Status Actions

Operator admin actions are dispatched through `worker/src/router.ts` using shared endpoint definitions (`shared/lib/api-endpoints.ts`) and worker action handlers under `worker/src/api/admin-actions.ts`. Examples:

| Endpoint                         | Auth                                         | Description                                                             |
| -------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------- |
| `POST /api/trigger-digest`       | `ops-api` + Access user/JWT or service token | Queues a leased background digest run with `force=true`, then returns `202 Accepted` immediately |
| `POST /api/reset-blacklist-sync` | `ops-api` + Access user/JWT or service token | Rolls back sync state: EVM −50,000 blocks, Tron −7 days                 |
| `GET /api/debug-sync-state`      | `ops-api` + Access user/JWT or service token | Returns all `blacklist_sync_state` rows                                 |

Additional backfill/audit actions are defined in the same registry and surfaced dynamically on `/admin/`. `POST /api/feedback` is router-dispatched too, but it is not part of the status action registry.

### Idempotent Admin Actions

**File:** `worker/src/lib/idempotency.ts`

These router-dispatched admin routes honor an optional `Idempotency-Key` header:

- `POST /api/backfill-depegs`
- `POST /api/backfill-supply-history`
- `POST /api/backfill-stability-index`
- `POST /api/backfill-cg-prices`
- `POST /api/backfill-mint-burn-prices`
- `POST /api/backfill-mint-burn`
- `POST /api/reclassify-atomic-roundtrips`
- `POST /api/audit-depeg-history`
- `POST /api/trigger-digest`
- `POST /api/reset-blacklist-sync`
- `POST /api/remediate-blacklist-amount-gaps`
- `POST /api/backfill-blacklist-current-balances`

The worker fingerprints method + path + sorted query + body for a given action key. Replays return the stored response with `X-Idempotent-Replay: true`; conflicting reuse returns `409`.

### Backfill Query Helper

**File:** `worker/src/lib/backfill-query.ts`

Backfill handlers reuse shared parsing/selection helpers for `stablecoin`, `batch`, and `batchSize` query params:

- `selectBackfillCoins(...)` resolves single-coin mode (`?stablecoin=<id>`) vs batched mode (`?batch=<n>[&batchSize=<n>]`) with bounded integer parsing.
- `noCoinsInBatchResponse()` returns the canonical no-op payload `{ "message": "No coins in this batch" }`.

Current consumers:

- `worker/src/api/backfill-cg-prices.ts`
- `worker/src/api/backfill-supply-history.ts`
- `worker/src/api/backfill-depegs.ts`

### Module-Level State

Most module-level mutable state was eliminated in the parameter-passing refactor. The remaining intentional cache is:

- `jwt-verify.ts` → module-level `cachedJwks` with a 1-hour TTL for Cloudflare Access signing keys

**Constraints:**

- State persists within an isolate but resets on cold starts
- State is NOT shared across isolates
- The JWKS cache is an optimization only; auth still re-fetches when the cache is cold or expired

---

## Cron Scheduling

This worker declares 13 cron expressions in `worker/wrangler.toml`. Fetch-heavy lanes are split across separate trigger slots so they do not compete with the quarter-hourly core pipeline for the Workers per-trigger 6-connection fetch pool.

### wrangler.toml Triggers

```toml
[triggers]
crons = [
  "*/15 * * * *",
  "3 * * * *",
  "4,24,44 * * * *",
  "6,36 * * * *",
  "13,33,53 * * * *",
  "10,40 * * * *",
  "11 * * * *",
  "20 * * * *",
  "25 */4 * * *",
  "2,7,12,17,22,27,32,37,42,47,52,57 * * * *",
  "0 8 * * *",
  "5 8 * * *",
  "0 6 1 * *",
]
```

### Trigger 1: `*/15 * * * *` (every 15 minutes)

| Job                              | Function                                              | File                                              | Documentation                                                                |
| -------------------------------- | ----------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| `sync-fx-rates`                  | `syncFxRates()`                                       | `worker/src/cron/sync-fx-rates.ts`                | [Data Pipeline](./data-pipeline.md), [Classification](./classification.md)   |
| `sync-stablecoins`               | `syncStablecoins()`                                   | `worker/src/cron/sync-stablecoins.ts`             | [Data Pipeline](./data-pipeline.md), [Depeg Detection](./depeg-detection.md) |
| `snapshot-supply` _(retry path)_ | `snapshotSupply()` (chained after `sync-stablecoins`) | `worker/src/cron/snapshot-supply.ts`              | [Supply Snapshot Pipeline](./supply-snapshot.md)                             |
| `snapshot-chain-supply`          | `snapshotChainSupply()` (chained after `snapshot-supply`, DB-only, 0 external connections) | `worker/src/cron/snapshot-chain-supply.ts` | [Supply Snapshot Pipeline](./supply-snapshot.md) |
| `status-self-check`              | `runStatusSelfCheck()`                                | `worker/src/cron/status-self-check.ts`            | [Status Dashboard](./status-dashboard.md)                                    |
| _(inline)_                       | Stale-cache health alert                              | `worker/src/handlers/scheduled/quarter-hourly.ts` | This doc (below)                                                             |

**Execution model:** Jobs in this slot are run sequentially in `worker/src/handlers/scheduled/quarter-hourly.ts` to respect the Workers shared 6-connection fetch pool per cron trigger. `sync-fx-rates` runs first so Chainlink / FX probes get a clean fetch window before the heavier stablecoin pricing pipeline consumes the slot budget. `sync-stablecoins` now reports explicit capability metadata:

- `capabilities.stablecoinsCache`
- `capabilities.depegPipeline`

`snapshot-supply` retry requires the stablecoins-cache capability. Both `snapshot-supply` and `snapshot-chain-supply` enforce a 1-hour cooldown via a `cache` table key (`snapshot-supply:last-write` / `snapshot-chain-supply:last-write`) to prevent redundant DB writes when triggered on the quarter-hourly slot. `stability-index` and `compute-dews` were moved to the half-hourly trigger (Trigger 6) to halve their run frequency. `sync-dex-liquidity` still refreshes every 30 minutes, while `sync-yield-data` now publishes on its own hourly post-DEX trigger.

**Inline staleness alert:** After sync-stablecoins completes, if the `stablecoins` cache is older than 1800 seconds (30 min), `sendAlert()` fires a webhook notification. This is a health check — not a cron job itself.

### Trigger 2: `3 * * * *` (blacklist — dedicated hourly)

| Job              | Function          | File                                | Documentation                               |
| ---------------- | ----------------- | ----------------------------------- | ------------------------------------------- |
| `sync-blacklist` | `syncBlacklist()` | `worker/src/cron/sync-blacklist.ts` | [Blacklist Tracker](./blacklist-tracker.md) |

Dedicated hourly trigger for blacklist sync (reduced from every 20 minutes — blacklist events are infrequent enough that hourly cadence is sufficient). Uses Etherscan for supported chains, chain RPC log scans (Alchemy/public fallback) for Base/Optimism/Avalanche/BSC, dRPC for historical L2 balance reads, and TronGrid for Tron (with TronGrid circuit breaker gating). Gets its own 6-connection pool and CPU budget.

### Trigger 3: `4,24,44 * * * *` (mint/burn critical — dedicated)

| Job              | Function                       | File                                | Documentation    |
| ---------------- | ------------------------------ | ----------------------------------- | ---------------- |
| `sync-mint-burn` | `syncMintBurn()` critical lane | `worker/src/cron/sync-mint-burn.ts` | This doc (below) |

Dedicated trigger for the critical mint/burn lane. Uses Alchemy JSON-RPC plus the Alchemy circuit breaker. Offset by 1 minute from blacklist to stagger Worker cold starts.

### Trigger 4: `6,36 * * * *` (DEX discovery — dedicated, every 30 minutes)

| Job                  | Function             | File                                            | Documentation                             |
| -------------------- | -------------------- | ----------------------------------------------- | ----------------------------------------- |
| `sync-dex-discovery` | `syncDexDiscovery()` | `worker/src/cron/dex-discovery/orchestrator.ts` | [DEX Liquidity Score](./dex-liquidity.md) |

Dedicated trigger for DEX pool discovery. Uses strictly sequential fetches (1 connection at a time) from CoinGecko/GeckoTerminal/DexScreener. Stages pools for later merge by `sync-dex-liquidity`.
The lane is best-effort by design: a 12-minute shared budget plus 25-second per-coin cap force partial `degraded` completion before the Worker nears its platform wall-clock ceiling.

### Trigger 5: `13,33,53 * * * *` (every 20 minutes, offset at :13/:33/:53)

| Job                       | Function                       | File                                | Documentation    |
| ------------------------- | ------------------------------ | ----------------------------------- | ---------------- |
| `sync-mint-burn-extended` | `syncMintBurn()` extended lane | `worker/src/cron/sync-mint-burn.ts` | This doc (below) |

This offset schedule exists so long-tail mint/burn backfill pressure cannot starve the critical lane. It uses a separate `mint_burn_run_state.job` key (`sync-mint-burn-extended`) and warning-only coverage semantics.

### Trigger 6: `10,40 * * * *` (every 30 minutes, at :10/:40)

| Job                      | Function                                | File                                                                  | Documentation                                        |
| ------------------------ | --------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------- |
| `sync-stablecoin-charts` | `syncStablecoinCharts()`                | `worker/src/cron/sync-stablecoin-charts.ts`                           | This doc (below)                                     |
| `sync-dex-liquidity`     | `syncDexLiquidity()`                    | `worker/src/cron/dex-liquidity/orchestrator.ts`                       | [DEX Liquidity Score](./dex-liquidity.md)            |
| `compute-dews`           | `computeAndStoreDEWS()`                 | `worker/src/cron/compute-dews.ts`                                     | [DEWS](./dews.md)                                    |
| `stability-index`        | `computeAndStoreStabilityIndex()`       | `worker/src/cron/stability-index.ts`                                  | [Pharos Stability Index](./stability-index.md)       |

**Execution model:** The slot runs in the same sequential order for connection control: charts → dex-liquidity → compute-dews → stability-index. Charts is a single lightweight DL fetch (~2s) that completes quickly and frees the pool. `compute-dews` and `stability-index` are DB-only (0 external connections) and benefit from running after dex-liquidity provides fresh liquidity scores. `sync-stablecoin-charts` enforces a 1-hour cooldown via `stablecoin-charts:last-write` — on the alternate 30-min run, it returns immediately with `cooldown_active`. The reliability change is failure containment: `sync-dex-liquidity` no longer suppresses downstream DEWS / PSI execution for the whole slot when it throws. Downstream jobs still run and make their own degraded/no-write decisions against the latest available tables. `compute-dews` also now treats malformed persisted `stress_signals` and `yield_data.warning_signals` rows as degraded input coverage instead of a validation-only footnote, so operators can see corrupt carry-forward state in cron metadata before it silently distorts the next run. The slot shares the Workers 6-connection limit, so fetch-heavy additions must account for total in-slot concurrency. `sync-dex-liquidity` still stages its protocol-native DEX fetchers only after Curve and subgraph enrichment have consumed their response bodies, and the newer Meteora / PancakeSwap / Slipstream lanes follow the same sequencing rule rather than overlapping the earlier fetch-heavy phase. UniV3 subgraph queries continue to run in parallel across chains for reduced wall-clock time.

`sync-dex-liquidity` metadata now tracks both row coverage and value coverage. In addition to `currentCoverage` / `previousCoverage`, the cron records `currentGlobalTvl`, `previousGlobalTvl`, top-10 covered TVL, row/value guard flags, and current/previous coverage-class distribution. `/status` surfaces this through the Liquidity Health card.

### Trigger 7: `11 * * * *` (hourly at :11 — reserve + redemption lane)

| Job                         | Function                    | File                                           | Documentation                                     |
| --------------------------- | --------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| `sync-live-reserves`        | `syncLiveReserves()`        | `worker/src/cron/sync-live-reserves.ts`        | This doc (below)                                  |
| `sync-redemption-backstops` | `syncRedemptionBackstops()` | `worker/src/cron/sync-redemption-backstops.ts` | [Redemption Backstops](./redemption-backstops.md) |
| `sync-kinesis-supply`       | `syncKinesisSupply()`       | `worker/src/cron/sync-kinesis-supply.ts`       | This doc (below)                                  |

**Connection budget:** dedicated hourly trigger for reserve and redemption tuning. Jobs run sequentially so live reserve adapters finish before redemption backstop sync consumes reserve metadata. Kinesis supply sync adds 2 sequential HTTP fetches (1 connection peak).

### Trigger 8: `20 * * * *` (hourly at :20 — core yield publication)

| Job               | Function          | File                                                                  | Documentation                                 |
| ----------------- | ----------------- | --------------------------------------------------------------------- | --------------------------------------------- |
| `sync-yield-data` | `syncYieldData()` | `worker/src/cron/sync-yield-data.ts` + `worker/src/cron/yield-sync/*` | [Yield Intelligence](./yield-intelligence.md) |

**Connection budget:** dedicated hourly trigger for the core publisher. The job consumes cached DEX pools plus the cached supplemental yield snapshot, keeps deterministic on-chain reads to a single in-flight lane, and is allowed a larger app-level timeout because it no longer shares the half-hourly slot.

### Trigger 9: `25 */4 * * *` (every 4 hours at :25 — yield supplemental lane)

| Job                         | Function                   | File                                            | Documentation                                 |
| --------------------------- | -------------------------- | ----------------------------------------------- | --------------------------------------------- |
| `sync-yield-supplemental`   | `syncYieldSupplemental()`  | `worker/src/cron/sync-yield-supplemental.ts`    | [Yield Intelligence](./yield-intelligence.md) |

**Connection budget:** dedicated multi-hour trigger for the heavier optional yield families (Morpho, Pendle, Yearn/Kong, Beefy, Compound V3, Aave V3). It writes a cache snapshot that the hourly publisher consumes, so protocol-API stalls reduce optional coverage instead of blocking `yield-rankings`.

### Trigger 10: `2,7,12,17,22,27,32,37,42,47,52,57 * * * *` (Telegram dispatch — dedicated, every 5 min)

| Job                           | Function                      | File                                             | Documentation                                                                                 |
| ----------------------------- | ----------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `dispatch-telegram-alerts`    | `dispatchTelegramAlerts()`    | `worker/src/cron/dispatch-telegram-alerts.ts`    | [Telegram Alert Bot](./telegram-alerts.md)                                                    |

Dedicated trigger for Telegram work. Isolated from the quarter-hourly pipeline so subscriber fan-out gets its own 6-connection pool and CPU budget. Subscriber fan-out uses up to 5 of 6 available connections for parallel `sendBatch()` sends. Up to 200 subscriber message attempts per run; overflow and retryable fresh-send failures are enqueued to `telegram_pending_alerts` in D1 for subsequent runs.

### Trigger 11: `0 8 * * *` (daily at 08:00 UTC — snapshots & lightweight fetchers)

| Job                             | Function                       | File                                               | Documentation                                    |
| ------------------------------- | ------------------------------ | -------------------------------------------------- | ------------------------------------------------ |
| `snapshot-supply`               | `snapshotSupply()`             | `worker/src/cron/snapshot-supply.ts`               | [Supply Snapshot Pipeline](./supply-snapshot.md) |
| `snapshot-safety-grade-history` | `snapshotSafetyGradeHistory()` | `worker/src/cron/snapshot-safety-grade-history.ts` | [Risk Lab](./report-cards.md)                    |
| `snapshot-psi`                  | `snapshotPsiDaily()`           | `worker/src/cron/snapshot-psi.ts`                  | [Pharos Stability Index](./stability-index.md)   |
| `sync-usds-status`              | `syncUsdsStatus()`             | `worker/src/cron/sync-usds-status.ts`              | This doc (below)                                 |
| `fetch-tbill-rate`              | `fetchTbillRate()`             | `worker/src/cron/fetch-tbill-rate.ts`              | [Yield Intelligence](./yield-intelligence.md)    |

**Connection budget:** 3 snapshot jobs are D1-only (0 external connections). `fetch-tbill-rate` (ECB/FRED/Treasury/SIX benchmark fetches, still serialized inside one job) and `sync-usds-status` (Etherscan) are still executed sequentially on the external-fetch branch to keep this trigger conservative on connection use, but a failed `fetch-tbill-rate` run no longer suppresses `sync-usds-status`.

### Trigger 12: `5 8 * * *` (daily at 08:05 UTC — heavy external fetchers)

| Job              | Function                | File                                | Documentation                           |
| ---------------- | ----------------------- | ----------------------------------- | --------------------------------------- |
| `sync-bluechip`  | `syncBluechip()`        | `worker/src/cron/sync-bluechip.ts`  | This doc (below)                        |
| `daily-digest`   | `generateDailyDigest()` | `worker/src/cron/daily-digest.ts`   | [Digest Pipeline](./digest-pipeline.md) |
| `weekly-recap`   | `generateWeeklyRecap()` | `worker/src/cron/weekly-recap.ts`   | [Digest Pipeline](./digest-pipeline.md) |
| `discovery-scan` | `runDiscoveryScan()`    | `worker/src/cron/discovery-scan.ts` | [Data Pipeline](./data-pipeline.md)     |

**Connection budget:** `sync-bluechip` (3 parallel batch connections), `daily-digest` / `weekly-recap` (1 long-lived Anthropic API call at a time because the recap is chained after the daily digest), and `discovery-scan` (1 CoinGecko call) use ≤5 concurrent external connections. The 5-minute offset from Trigger 11 ensures PSI snapshot data is available for the daily digest without an explicit chain dependency. `weekly-recap` and `discovery-scan` both run Monday-only and return immediately on other days. Reliability is now failure-contained at the job level for this slot: a thrown `sync-bluechip`, `daily-digest`, `weekly-recap`, or `discovery-scan` run is recorded independently and no longer aborts the rest of the 08:05 lane before the remaining jobs can settle.

### Trigger 13: `0 6 1 * *` (monthly at 06:00 UTC on the 1st)

| Job                    | Function                   | File                                           | Documentation                                   |
| ---------------------- | -------------------------- | ---------------------------------------------- | ----------------------------------------------- |
| `yield-coverage-audit` | `runYieldCoverageAudit()`  | `worker/src/handlers/scheduled/monthly-yield-audit.ts` | [Yield Intelligence](./yield-intelligence.md) |

Runs once a month on the 1st at 06:00 UTC. Scans unmatched high-TVL DeFiLlama pools and flags missing protocols as high-confidence or review-needed expansion candidates.

### Cron Slot Capacity and Connection Pool Budget

Workers enforce a **6 concurrent fetch connections** limit per cron trigger invocation. All jobs sharing a trigger slot share this pool. Exceeding 6 causes `fetch()` to queue or fail.

| Trigger | Cron Expression | Max Concurrent External Connections | Headroom |
|---------|----------------|:---:|:---:|
| 1 | `*/15 * * * *` | 3 (sync-stablecoins + sync-fx-rates + status-self-check; stability-index/compute-dews moved to T6) | 3 |
| 2 | `3 * * * *` | 4 (multi-chain blacklist scans) | 2 |
| 3 | `4,24,44 * * * *` | 2 (Alchemy JSON-RPC) | 4 |
| 4 | `6,36 * * * *` | 1 (sequential CG/GT/DexScreener) | 5 |
| 5 | `13,33,53 * * * *` | 2 (Alchemy JSON-RPC, extended lane) | 4 |
| 6 | `10,40 * * * *` | 4 (charts + DEX liquidity + compute-dews(0) + stability-index(0)) | 2 |
| 7 | `11 * * * *` | 1 (reserve adapters + Kinesis are sequential; redemption is DB-only) | 5 |
| 8 | `20 * * * *` | 1 (core yield publisher) | 5 |
| 9 | `25 */4 * * *` | 5 (supplemental yield families) | 1 |
| 10 | `2,7,…,57 * * * *` | 5 (Telegram fan-out batch sends) | 1 |
| 11 | `0 8 * * *` | 1 (benchmark feeds and Etherscan are serialized) | 5 |
| 12 | `5 8 * * *` | 5 (bluechip + Anthropic + CoinGecko) | 1 |
| 13 | `0 6 1 * *` | 1 (DeFiLlama yield scan) | 5 |

**Policy for new jobs:**
- Jobs requiring ≤1 external connection may share any slot with headroom ≥2.
- Jobs requiring >2 concurrent connections should get a dedicated trigger slot.
- Never add a fetching job to a slot with headroom ≤1 (Triggers 9, 10, and 12 are effectively full).

### Cron Error Handling Policy

Shared cron behavior is narrower than a single worker-wide tier system:

- `runLeasedCron(...)` / `logCronRun(...)` record `ok`, `error`, and lease-skip outcomes per job in `cron_runs`
- thrown job errors trigger `sendAlert()` and are re-thrown unless the scheduled slot catches them locally to keep sibling jobs running
- retries, degraded returns, no-write fallbacks, and cooldowns are job-specific rather than enforced by one shared classification layer
- fire-and-forget cleanup work may use `.catch()` when failure should not crash the main cron path

There is no shared 10-minute alert-dedup layer in the worker today. Any cooldown or dedupe behavior is implemented by individual jobs when needed.

## Telegram Alert Bot

- Webhook ingress (`POST /api/telegram-webhook`) receives Telegram commands and writes subscriber/subscription state into D1.
- `dispatch-telegram-alerts` diffs DEWS/depeg/safety state plus launch promotions against cached snapshots before fan-out on a dedicated 5-minute cron slot.
- `daily-digest` now appends pending cemetery additions and newly tracked coins to the next Telegram digest post after a deploy.
- Telegram sends are gated by the `telegram-api` circuit breaker to avoid hammering the Bot API during upstream issues.
- Each dispatch run sends up to 200 Telegram message attempts in parallel batches of 5. Overflow and retryable fresh-send failures are enqueued to `telegram_pending_alerts` for subsequent runs.
- Subscriber state now supports quiet hours plus per-subscription controls such as `dews_min_band`, `safety_mode`, and `depeg_worsening_bps_step`.

See [Telegram Alert Bot](./telegram-alerts.md) for command syntax, D1 tables, snapshot seeding behavior, and operational setup.

### Sub-Modules (not directly registered)

These files are called internally by `syncStablecoins()`, not registered as standalone cron jobs:

| File                                                      | Called from         | Documentation                           |
| --------------------------------------------------------- | ------------------- | --------------------------------------- |
| `worker/src/cron/detect-depegs.ts`                        | `syncStablecoins()` | [Depeg Detection](./depeg-detection.md) |
| `worker/src/cron/confirm-pending-depegs.ts`               | `syncStablecoins()` | [Depeg Detection](./depeg-detection.md) |
| `worker/src/cron/sync-stablecoins/enrich-prices.ts`      | `syncStablecoins()` | [Data Pipeline](./data-pipeline.md)     |
| `worker/src/cron/sync-stablecoins/supplemental-assets.ts` | `syncStablecoins()` | [Data Pipeline](./data-pipeline.md)     |

---

## logCronRun() Wrapper

**File:** `worker/src/lib/cron-logger.ts`

Every scheduled trigger now runs as one fenced slot in `worker/src/handlers/scheduled.ts`, keyed by shared schedule metadata plus the normalized scheduled timestamp. Inside that slot, each cron job is still wrapped with `runCronWithLease(...)` + `logCronRun(...)` via `runLeasedCron(...)` from the scheduled runtime context.

`await runScheduledSlotWithFence(db, scheduleKey, () => runner(runtime), { slotStartedAt })`

```typescript
async function logCronRun(
  db: D1Database,
  job: string,
  fn: (signal: AbortSignal, reportProgress: CronProgressReporter) => Promise<CronResult | void>,
  alertFn?: (title: string, message: string) => Promise<unknown> | void,
  options?: { slotStartedAt?: number | null },
): Promise<void>;
```

**Behavior:**

- Records start time (Unix seconds)
- Records the normalized slot timestamp (`slot_started_at`) alongside per-job history/progress rows
- Exposes a `reportProgress(...)` callback; leased jobs now emit wrapper-owned milestones (`started`, `lease-acquired`, `completed`, timeout/skip states when applicable) before any cron-specific progress stages
- Executes the job function
- On success: inserts row into `cron_runs` with `status='ok'`, `item_count`, and `metadata`
- On lease contention: inserts row with `status='skipped_locked'` and lease metadata
- On error: inserts row with `status='error'` and error message, calls `sendAlert()`, re-throws
- On completion/error of a progress-reporting job: clears the corresponding `cron_run_progress` row
- After each run: prunes rows older than 7 days (`started_at < now - 604800`); if prune fails, falls back to keeping only the top 5000 rows by rowid DESC

**Schema:** `cron_runs(job, started_at, duration_ms, status, item_count, metadata, error, slot_started_at)`

### In-flight Cron Progress

Long-running leased jobs can now surface active progress through `cron_run_progress`, which powers `/api/status` while the run is still live. The status handler now cross-checks that progress row against an active matching `cron_leases` entry before exposing it as `crons[*].inFlight`, so orphaned progress from a hard-killed invocation no longer masquerades as a live run.

`sync-stablecoins` now uses those cron-specific progress stages to expose its major pipeline boundaries (`intake`, `price-enrichment`, `price-validation`, `staleness-check`, `cache-write`, `depeg-pipeline`, plus fallback equivalents) instead of remaining opaque for the full quarter-hourly wall-clock.

```sql
CREATE TABLE cron_run_progress (
  job TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  slot_started_at INTEGER,
  updated_at INTEGER NOT NULL,
  stage TEXT,
  items_done INTEGER,
  items_total INTEGER,
  message TEXT,
  lease_owner TEXT,
  metadata TEXT
);
```

Current producers:

- `sync-stablecoins`
- `sync-live-reserves`
- `sync-blacklist`
- `sync-mint-burn`
- `sync-mint-burn-extended`
- `sync-dex-discovery`

### Per-Job Cron Timeouts

Each cron job receives an `AbortSignal` from `logCronRun()` that fires after a configurable timeout. Jobs that exceed their timeout are aborted and logged with `status='error'`. The signal is threaded through to `fetchWithRetry()` so that in-flight HTTP requests are also cancelled.

Some long-running jobs also enforce their own earlier wall-clock guard so they can return a controlled `degraded` result with metadata instead of hard-failing at the wrapper timeout. `sync-blacklist`, for example, self-stops after 7 minutes and avoids starting a new config when fewer than 60 seconds remain.

| Job                       | Timeout | Reason                                                                                                                                                                                                    |
| ------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default                   | 5 min   | Standard jobs complete in <60s                                                                                                                                                                            |
| `sync-stablecoins`        | 8 min   | Core quarter-hour pipeline entrypoint now includes dual-primary pricing, supplemental overlays, multi-pass enrichment, and depeg processing; explicit headroom avoids timing out on bounded fallback work |
| `sync-dex-liquidity`      | 13 min  | 150+ pool crawl, with headroom below the platform wall-clock limit                                                                                                                                        |
| `sync-dex-discovery`      | 13 min  | Multi-source pool staging with explicit 12-minute self-budget so the wrapper still has headroom to log a controlled degraded/error result                                                                  |
| `sync-blacklist`          | 12 min  | Multi-chain scan + balance enrichment; isolated trigger allows extended runtime                                                                                                                           |
| `sync-mint-burn`          | 10 min  | Multi-contract EVM log scan; isolated trigger allows extended runtime                                                                                                                                     |
| `sync-mint-burn-extended` | 10 min  | Long-tail mint/burn lane with its own run-state                                                                                                                                                           |
| `daily-digest`            | 8 min   | LLM generation + distribution                                                                                                                                                                             |

Configuration: `CRON_TIMEOUT_MS` record in `worker/src/lib/cron-lease.ts`.

### Circuit Breakers

All external data sources are protected by per-source circuit breakers (`worker/src/lib/circuit-breaker.ts`). State is persisted in the D1 `cache` table under keys like `circuit:defillama-stablecoins`.

- **Open threshold**: 3 consecutive failures
- **Probe interval**: 30 minutes (one request allowed to test recovery)
- **Alerts**: Webhook alert fires on open and close transitions
- **Health impact**: 3 or more open circuits degrade `/api/health`; smaller circuit failures still surface in the circuit list without degrading public health on their own

Sources tracked (defined in `CIRCUIT_SOURCE` in `worker/src/lib/constants.ts`):

| Source key                           | Cache key                     | Used by                                                                      |
| ------------------------------------ | ----------------------------- | ---------------------------------------------------------------------------- |
| `DL_STABLECOINS`                     | `defillama-stablecoins`       | `sync-stablecoins`                                                           |
| `DL_STABLECOIN_DETAIL`               | `defillama-stablecoin-detail` | `GET /api/stablecoin/:id` (DefiLlama detail upstream)                        |
| `DL_COINS`                           | `defillama-coins`             | `enrich-prices`                                                              |
| `DL_YIELDS`                          | `defillama-yields`            | `sync-yield-data`, `sync-dex-liquidity`                                      |
| `DL_PROTOCOLS`                       | `defillama-protocols`         | `sync-dex-liquidity`                                                         |
| `CG_PRICES`                          | `coingecko-prices`            | `enrich-prices`                                                              |
| `CG_DETAIL_PLATFORMS`                | `coingecko-detail-platforms`  | `GET /api/stablecoin/:id` (CoinGecko-only detail provider)                   |
| `CG_MCAP`                            | `coingecko-mcap`              | `sync-stablecoins` (CG supply fallback)                                      |
| `CG_DISCOVERY`                       | `coingecko-discovery`         | `discovery-scan`                                                             |
| `CMC_PRICES`                         | `coinmarketcap-prices`        | `enrich-prices` pass 2 fallback                                              |
| `DEXSCREENER_PRICES`                 | `dexscreener-prices`          | `enrich-prices` pass 3 fallback                                              |
| `TREASURY_RATES`                     | `treasury-rates`              | `fetch-tbill-rate`                                                           |
| `ETHERSCAN`                          | `etherscan`                   | `sync-blacklist`                                                             |
| `TRONGRID`                           | `trongrid`                    | `sync-blacklist` (Tron chains)                                               |
| `DRPC`                               | `drpc`                        | Blacklist balance enrichment (L2 archive reads)                              |
| `ALCHEMY`                            | `alchemy`                     | `sync-mint-burn`                                                             |
| `PYTH_PRICES`                        | `pyth-prices`                 | `enrich-prices` primary consensus                                            |
| `BINANCE_PRICES`                     | `binance-prices`              | `enrich-prices` primary consensus                                            |
| `COINBASE_PRICES`                    | `coinbase-prices`             | `enrich-prices` primary consensus                                            |
| `REDSTONE_PRICES`                    | `redstone-prices`             | `enrich-prices` primary consensus                                            |
| `CURVE_ONCHAIN`                      | `curve-onchain`               | `enrich-prices` primary consensus                                            |
| `CURVE_LIQUIDITY_API`                | `curve-liquidity-api`         | `sync-dex-liquidity` (Curve pool liquidity fetch)                            |
| `FX_FRANKFURTER`                     | `fx-frankfurter`              | `sync-fx-rates` primary Frankfurter API circuit breaker                      |
| `FX_REALTIME`                        | `fx-realtime`                 | `sync-fx-rates` real-time FX cross-validation                                |
| `GECKO_TERMINAL_PROBE`               | `geckoterminal-probe`         | `enrich-prices` GeckoTerminal price probe fallback                           |
| `TWITTER_API`                        | `twitter-api`                 | `daily-digest` social posting                                                |
| `TELEGRAM_API`                       | `telegram-api`                | `daily-digest` social posting, `dispatch-telegram-alerts` subscriber fan-out |
| `KINESIS_KAU`                        | `kinesis-kau-horizon`         | `sync-kinesis-supply` KAU chain circulation fetch                            |
| `KINESIS_KAG`                        | `kinesis-kag-horizon`         | `sync-kinesis-supply` KAG chain circulation fetch                            |
| Dynamic `live-reserves:<scope>` keys | e.g. `live-reserves:infinifi` | `sync-live-reserves` per configured breaker scope; some adapters also opt into source-invariant within-run result sharing |

Primary-oracle implementation notes:

- `PYTH_PRICES` only counts as a healthy outcome when at least one requested feed resolves into a usable price; Hermes feed IDs are normalized by lowercasing and stripping an optional leading `0x`.
- `REDSTONE_PRICES` only counts as healthy when it returns at least one usable symbol. The worker queries an exact-case tracked-symbol allowlist in sequential batches of 10 and retries batch-dropped symbols individually once.
- Scheduled handlers that write breaker state from cron outcomes now treat `degraded` and `skipped_locked` as neutral by default; only explicit `ok` heals a breaker and only thrown/error outcomes count as failures unless a source-specific handler opts into stricter semantics.

---

## Alert System

**File:** `worker/src/lib/alerts.ts`

```typescript
export function normalizeWebhookUrl(url: string | undefined): string | null;
export async function sendAlert(webhookUrl: string | null | undefined, title: string, message: string): Promise<boolean>;
```

Auto-detects webhook format from URL:

| URL contains               | Format                                             |
| -------------------------- | -------------------------------------------------- |
| `discord.com/api/webhooks` | Discord embed (red, `[Pharos] {title}`, timestamp) |
| Anything else              | Slack markdown (`*[Pharos] {title}*\n{message}`)   |

`sendAlert()` returns `true` only when the webhook responds with `2xx`. Non-2xx responses and fetch errors are logged with status/context, and failures never propagate to caller control flow.

---

## Shared Database Helpers

**File:** `worker/src/lib/db.ts`

### Cache Table

All lightweight cron data is stored in the generic `cache` table. In the current migration tree that schema lives in `worker/migrations/0000_baseline.sql`; see [`worker/migrations/MANIFEST.md`](../worker/migrations/MANIFEST.md) for the squashed lineage.

```sql
CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

| Cache Key                  | Writer                 | Data                                                                               |
| -------------------------- | ---------------------- | ---------------------------------------------------------------------------------- |
| `stablecoins`              | `syncStablecoins`      | Full DefiLlama pegged assets payload                                               |
| `stablecoins:invalid-last` | `syncStablecoins`      | Last schema-invalid stablecoins payload (diagnostic only, never served to clients) |
| `stablecoin-charts`        | `syncStablecoinCharts` | Downsampled chart points                                                           |
| `fx-rates`                 | `syncFxRates`          | FX rates (EUR, GBP, etc.)                                                          |
| `usds-status`              | `syncUsdsStatus`       | Freeze capability + implementation address                                         |
| `bluechip-ratings`         | `syncBluechip`         | Ratings map keyed by canonical Pharos ID                                           |
| `yield-rankings`           | `syncYieldData`        | Pre-computed yield rankings + PYS scores                                           |
| `risk_free_rate`           | `fetchTbillRate`       | Current T-bill rate for PYS computation                                            |

**Cache access helpers:**

| Function                                        | Description                                                                                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `getCache(db, key)`                             | Returns `{ value, updatedAt }` or `null`                                                                                     |
| `setCache(db, key, value)`                      | `INSERT OR REPLACE` with current timestamp                                                                                   |
| `setCacheIfNewer(db, key, value, syncStartSec)` | Compare-and-swap: only writes if existing `updated_at <= syncStartSec`. Prevents slow cron runs from overwriting newer data. |

### Batch Execution

```typescript
async function batchExecute(
  db: D1Database,
  stmts: D1PreparedStatement[],
  chunkSize = 100, // D1_BATCH_SIZE
): Promise<void>;
```

Chunks statements into batches of 100 (D1's batch limit) and executes sequentially.

### Cron Lease Primitives (Phase C)

Lease primitives are implemented in `worker/src/lib/cron-lease.ts` and are part of `worker/migrations/0000_baseline.sql`.
Scheduled slot fencing is backed by migration `0074_cron_slot_executions.sql`.

```sql
CREATE TABLE IF NOT EXISTS cron_leases (
  job TEXT PRIMARY KEY,
  lease_owner TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

```sql
CREATE TABLE IF NOT EXISTS cron_slot_executions (
  slot_key TEXT NOT NULL,
  slot_started_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  result_status TEXT,
  execution_owner TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL,
  metadata TEXT,
  PRIMARY KEY (slot_key, slot_started_at)
);
```

| Function                                   | Description                                                                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `acquireCronLease(db, job, owner, ttlSec)` | Acquires lease for a job, or takes over when expired. Returns `true` on success, `false` if another active owner holds the lease. |
| `renewCronLease(db, job, owner, ttlSec)`   | Extends `lease_until` for the current owner. Returns `false` if ownership was lost.                                               |
| `releaseCronLease(db, job, owner)`         | Deletes lease row only when caller still owns it.                                                                                 |
| `runCronWithLease(db, job, fn, opts)`      | Wrapper primitive: acquire → heartbeat renewals → run fn → release; returns `ok` or `skipped_locked` with metadata.               |
| `runScheduledSlotWithFence(db, slotKey, fn, opts)` | Deduplicates and heartbeats an entire trigger slot before any slot runner work begins.                                    |

Default behavior in `runCronWithLease`:

- Lease TTL defaults to `jobTimeout + 60s`
- Heartbeat defaults to `max(15s, ttl/3)`
- Owner defaults to `crypto.randomUUID()` when available
- Successful renewals reset the lease-failure counter, so only consecutive heartbeat misses can lose the lease
- The outer cron timeout now aborts the lease wrapper itself instead of only the inner job signal

### Lease Integration Status

Scheduled execution is now wired in two layers:

- `worker/src/handlers/scheduled.ts` normalizes `event.scheduledTime` into a durable slot timestamp and awaits the fenced slot inline via `runScheduledSlotWithFence(...)`, which keeps manual `/__scheduled` replays from being cancelled mid-slot by preview-only `waitUntil()` teardown semantics
- `worker/src/handlers/scheduled/context.ts` keeps per-job `runLeasedCron(...)` for job-level overlap protection, timeout logging, and progress

This means duplicate trigger deliveries for the same slot are skipped before shared-slot fan-out can reorder downstream jobs, while individual jobs inside the accepted slot still use their existing per-job leases.

### Block Tracking (Blacklist)

| Function                             | Description                                     |
| ------------------------------------ | ----------------------------------------------- |
| `getLastBlock(db, configKey)`        | Returns last processed block/timestamp, or 0    |
| `setLastBlock(db, configKey, block)` | `INSERT OR REPLACE` into `blacklist_sync_state` |

### Price Cache

| Function                      | Description                                                           |
| ----------------------------- | --------------------------------------------------------------------- |
| `getPriceCache(db)`           | Returns `Map<assetId, { price, updatedAt }>` from `price_cache` table |
| `savePriceCache(db, entries)` | Batch upsert into `price_cache`                                       |

---

## Undocumented Cron Details

The three crons below were previously only listed by filename in [Architecture](./architecture.md). Their full algorithms are documented here.

### sync-stablecoin-charts

**File:** `worker/src/cron/sync-stablecoin-charts.ts`
**Schedule:** `10,40 * * * *` (shared half-hourly trigger; successful writes are capped at once per hour)
**Data source:** `https://stablecoins.llama.fi/stablecoincharts/all`

**Algorithm:**

1. Read `stablecoin-charts:last-write`; if the previous successful write is <1 hour old, return immediately with `cooldown_active`
2. Fetch full chart history from DefiLlama (single GET request)
3. Validate: must receive array with ≥100 data points
4. FX rate corruption fix:
   - Read cached FX rates from the `fx-rates` cache key
   - Only points within the recent live-reference window are eligible for repair; older history is left untouched because the current FX cache is not a historical reference series
   - For each eligible chart point, validate implied FX rate: `totalCirculatingUSD[key] / totalCirculating[key]`
   - If rate falls outside tolerance band (`fxRate / RATE_TOLERANCE` to `fxRate * RATE_TOLERANCE`), recompute the USD value using the current cached FX rate
   - `RATE_TOLERANCE = 3` (accepts 1/3× to 3× of expected rate)
5. Downsample to adaptive time buckets:
   - Last 90 days: daily (86,400s intervals)
   - 90 days to 2 years: weekly (604,800s intervals)
   - Older than 2 years: monthly (2,592,000s intervals)
6. If the downsampled payload has fewer than 10 points, return `status: "degraded"` and skip publication
7. Write to cache via `setCacheIfNewer()` (CAS — won't overwrite newer data) and update `stablecoin-charts:last-write`

**Cooldown guard:** alternate half-hourly runs skip the upstream fetch entirely when the 1-hour write cooldown is still active.

### sync-usds-status

**File:** `worker/src/cron/sync-usds-status.ts`
**Schedule:** `0 8 * * *` (daily at 08:00 UTC)
**Data source:** Etherscan V2 API (on-chain reads)

**Purpose:** Monitors whether the USDS token contract has been upgraded to include freeze/blacklist capability (which it currently does not have).

**Constants:**

| Constant              | Value                                                                           |
| --------------------- | ------------------------------------------------------------------------------- |
| `USDS_PROXY`          | `0xdC035D45d973E3EC169d2276DDab16f1e407384F`                                    |
| `IMPL_SLOT`           | `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc` (ERC-1967) |
| `NO_FREEZE_IMPL`      | `0x1923dfee706a8e78157416c29cbccfde7cdf4102`                                    |
| `IS_BLOCKED_SELECTOR` | `0xe4c0aaf4` (keccak256 of `isBlocked(address)`)                                |
| `STALE_HOURS`         | 20                                                                              |

**Algorithm:**

1. Check cache freshness: if `usds-status` cache is <20 hours old, skip
2. Read implementation address from ERC-1967 storage slot via `eth_getStorageAt`
3. If implementation matches `NO_FREEZE_IMPL`: `freezeActive = false` (known safe impl)
4. Otherwise: probe the proxy with `eth_call` using `isBlocked(address(0))` selector
   - If call returns ≥32 bytes: freeze function exists (`freezeActive = true`)
   - If call reverts: no freeze function (`freezeActive = false`)
   - If probe fails entirely: preserve cached status, don't update
5. Store `{ freezeActive, implementationAddress, lastChecked }` via `setCacheIfNewer()`
6. If the cache write fails after provider checks succeeded, return `status: "degraded"` with `reason: "cache-write-failed"` instead of recording a clean success

### sync-live-reserves

**File:** `worker/src/cron/sync-live-reserves.ts`
**Schedule:** `11 * * * *` (hourly at :11 UTC)
**Data source:** Protocol-specific reserve APIs and on-chain vault/accounting reads via adapter registry (`worker/src/cron/reserve-adapters/`)

**Purpose:** Syncs live reserve composition from protocol data APIs into the `reserve_composition` D1 table and records per-coin operational state in `reserve_sync_state`. Each coin with `liveReservesConfig` declares an adapter, semantics, source inputs, and optional breaker scope. The shared adapter registry also classifies reserve shape (`sourceModel`) and evidence strength (`evidenceClass`). The cron iterates configured coins sequentially, delegates each coin to a single execution helper (breaker decision, adapter/fallback execution, validation, finalize), only reuses fetched results for adapters explicitly marked `source-invariant`, and persists both successful snapshots and failed/degraded sync state. Warning-bearing snapshots remain visible on reserve detail/status surfaces, but report-card collateral passthrough only consumes fresh authoritative `independent` evidence whose latest sync state is `ok`. For the full adapter/config/API contract, see [live-reserves.md](./live-reserves.md).

**D1 table: `reserve_composition`**

| Column          | Type    | Description                           |
| --------------- | ------- | ------------------------------------- |
| `stablecoin_id` | TEXT PK | Pharos coin ID                        |
| `slices`        | TEXT    | JSON-serialized `ReserveSlice[]`      |
| `fetched_at`    | INTEGER | Unix seconds of last successful sync  |
| `source`        | TEXT    | Adapter key used (e.g., `"infinifi"`) |

Only coins with `liveReservesConfig` set in their metadata appear in this table. One row per coin (latest snapshot only). A row is only considered an authoritative live snapshot when it matches the coin’s `reserve_sync_state.last_success_at`.

**D1 table: `reserve_sync_state`**

| Column              | Type    | Description                                         |
| ------------------- | ------- | --------------------------------------------------- |
| `stablecoin_id`     | TEXT PK | Pharos coin ID                                      |
| `adapter_key`       | TEXT    | Adapter key used for the last attempt               |
| `breaker_key`       | TEXT    | Per-source circuit-breaker key                      |
| `last_attempted_at` | INTEGER | Unix seconds of the latest sync attempt             |
| `last_success_at`   | INTEGER | Unix seconds of the latest successful live snapshot |
| `last_status`       | TEXT    | `ok`, `degraded`, `error`, or `skipped`             |
| `warning_count`     | INTEGER | Count of warnings returned by the adapter           |
| `warnings`          | TEXT    | JSON-serialized warning objects                     |
| `last_error`        | TEXT    | Last failure message, if any                        |
| `metadata`          | TEXT    | Adapter-specific operational metadata               |

**Registered adapters:**

| Adapter                    | Coins                                                                    | Source                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accountable`              | `aznd-mu-digital`, `yusd-aegis`, `usn-noon`, `nusd-neutrl`, `yzusd-yuzu` | `inputs.primary.kind = "http-json"` -> Accountable dashboard JSON feeds such as `https://mu.accountable.capital:10443/dashboard`, `https://aegis.accountable.capital:10443/dashboard/YUSD`, and `https://cache.accountable.capital/dashboard/<slug>` using bucket families like `type`, `reserves_split`, `deployment`, `type_split`, and `exposure_split`; each distinct dashboard URL has its own breaker scope |
| `asymmetry`                | `usdaf-asymmetry`                                                        | `inputs.primary.kind = "http-json"` -> `https://app.asymmetry.finance/api/stats` (`usdaf.branch`)                                                                                                                                                                                                                                                                                                                 |
| `btcfi`                    | `btcusd-btcfi`                                                           | `inputs.primary.kind = "http-json"` -> `https://www.btcfi.one/api/getBtcfiMarket?isTestnet=false` + handler metadata                                                                                                                                                                                                                                                                                              |
| `chainlink-nav`            | `usdy-ondo-finance`, `ustb-superstate`, `mtbill-midas`                   | `inputs.primary.kind = "onchain-evm"` -> Chainlink NAV feed oracle `latestRoundData()` via Etherscan proxy RPC                                                                                                                                                                                                                                                                                                   |
| `chainlink-por`            | `tusd-trueusd`                                                           | `inputs.primary.kind = "onchain-evm"` -> Chainlink Proof-of-Reserve feed `latestRoundData()` via Etherscan proxy RPC                                                                                                                                                                                                                                                                                             |
| `circle-transparency`      | `usdc-circle`, `eurc-circle`                                             | `inputs.primary.kind = "http-html"` -> `https://www.circle.com/transparency` (server-rendered HTML reserve data)                                                                                                                                                                                                                                                                                                 |
| `collateral-positions-api` | `zchf-frankencoin`, `deuro-deuro`                                        | `inputs.primary.kind = "http-json"` -> official ecosystem collateral-position APIs + official price mapping endpoints                                                                                                                                                                                                                                                                                             |
| `crvusd`                   | `crvusd-curve`                                                           | `inputs.primary.kind = "http-json"` -> `https://prices.curve.finance/v1/crvusd/markets`                                                                                                                                                                                                                                                                                                                           |
| `ethena`                   | `usde-ethena`                                                            | `inputs.primary.kind = "http-json"` -> `https://app.ethena.fi/api/positions/current/collateral`                                                                                                                                                                                                                                                                                                                   |
| `evm-branch-balances`      | `bold-liquity`, `usnd-nerite`, `usd0-usual`                              | `inputs.primary.kind = "onchain-evm"` -> branch ERC-20 balances plus DefiLlama valuation, with optional fixed-price overrides for wrapper assets that lack direct DL pricing                                                                                                                                                                                                                                     |
| `falcon`                   | `usdf-falcon`                                                            | `inputs.primary.kind = "http-json"` -> `https://api.falcon.finance/api/v1/transparency`                                                                                                                                                                                                                                                                                                                          |
| `fdusd-transparency`       | `fdusd-first-digital`                                                    | `inputs.primary.kind = "http-html"` -> `https://www.firstdigitallabs.com/transparency` (server-rendered reserve composition + as-of date)                                                                                                                                                                                                                                                                        |
| `frax`                     | `frax-frax`, `frxusd-frax`                                               | `inputs.primary.kind = "http-json"` -> `https://api.frax.finance/combineddata/`                                                                                                                                                                                                                                                                                                                                  |
| `gho`                      | `gho-aave`                                                               | `inputs.primary.kind = "onchain-evm"` -> Ethereum `eth_call` reads against the GHO token and reviewed mainnet GSM modules; current GSM backing is measured onchain and the remaining supply stays aggregated as residual issuance / reserve buffer                                                                                                                                                                 |
| `fx`                       | `fxusd-f-x-protocol`                                                     | `inputs.primary.kind = "http-json"` -> `https://api.aladdin.club/api1/get_fx_tvl` (`data.poolInfo`)                                                                                                                                                                                                                                                                                                             |
| `infinifi` | `iusd-infinifi` | `inputs.primary.kind = "http-json"` -> `https://eth-api.infinifi.xyz/api/protocol/data` |
| `m0` | `m-m0`, `musd-metamask`, `usdn-noble` | `inputs.primary.kind = "http-json"` -> `https://protocol-api.m0.org/graphql` (`CollateralCurrent`) |
| `mento` | `cusd-celo`, `ceur-celo` | `inputs.primary.kind = "http-html"` -> `https://reserve.mento.org/` (server-rendered `reserveComposition`) |
| `openeden-usdo` | `usdo-openeden` | `inputs.primary.kind = "http-json"` -> `https://prod-gw.openeden.com/usdo/sys/reserve-composition-last` |
| `reservoir` | `wsrusd-reservoir` | `inputs.primary.kind = "http-json"` -> `https://app.reservoir.xyz/api/reserves/raw` |
| `erc4626-single-asset` | `syrupusdc-maple`, `syrupusdt-maple` | `inputs.primary.kind = "onchain-evm"` -> Ethereum `totalAssets()` / `asset()` calls against the vault contract |
| `sgforge-coinvertible` | `eurcv-societe-generale-forge` | `inputs.primary.kind = "http-html"` -> `https://www.sgforge.com/product/coinvertible/` (daily CoinVertible circulation/cash disclosure) |
| `single-asset` | `usyc-hashnote`, `buidl-blackrock`, `lusd-liquity`, `meusd-mezo`, `feusd-felix`, `cetes-etherfuse`, `paxg-paxos`, `usdb-blast` | `inputs.primary.kind = "onchain-evm"` or `http-json` -> single-asset probe with fixed 100% composition |
| `sky-makercore`            | `usds-sky`, `dai-makerdao`                                               | `inputs.primary.kind = "http-json"` -> `https://api.llama.fi/protocol/makerdao` (DefiLlama protocol TVL breakdown)                                                                                                                                                                                                                                                                                               |
| `tether`                   | `usdt-tether`                                                            | `inputs.primary.kind = "http-json"` -> `https://app.tether.to/transparency.json`                                                                                                                                                                                                                                                                                                                                 |

**Operational behavior:**

- Circuit breakers are keyed per source identity (`live-reserves:<scope>`), not as one global `live-reserves` source.
- Within-run fetched-result reuse is opt-in via adapter registry metadata (`sharedSourceMode = "source-invariant"`). This currently applies to M0, Mento, and Sky/MakerCore; coin-aware adapters such as Frax do not share cached results across coins.
- The cron writes `reserve_sync_state` on every path, including degraded/error/skipped outcomes.
- Successful snapshots write `reserve_composition` and `reserve_sync_state` together in one D1 batch, and downstream readers ignore orphaned composition rows that do not have a matching successful sync state.
- Adapter warnings are reserved for unresolved material mapping drift. Known Ethena alt-collateral that is intentionally bucketed into `Other crypto collateral` does not emit warnings, and infiniFi dust farms that round to `0%` in the displayed mix do not keep the run-level cron degraded.
- Cron result status is explicit:
  - `ok` when at least one configured coin synced and `failed + skipped <= ceil(total * 0.1)`
  - `degraded` when at least one configured coin synced and `failed + skipped > ceil(total * 0.1)`
  - `error` when no configured coin synced successfully and at least one coin failed or was skipped

**Adding a new adapter:** Create `worker/src/cron/reserve-adapters/<protocol>.ts`, register it in `index.ts`, and add a structured `liveReservesConfig` to the coin metadata. The cron, reserve API, status surface, and detail-page fallback logic all consume that config.

### sync-redemption-backstops

**File:** `worker/src/cron/sync-redemption-backstops.ts`  
**Schedule:** `11 * * * *` (hourly at :11 UTC, immediately after `sync-live-reserves`)  
**Data source:** Stablecoins cache, DEX liquidity snapshot, redemption-backstop config registry, and live reserve-sync metadata where available

**Purpose:** Builds the current `redemption_backstop` dataset for redeemable assets and writes daily rows to `redemption_backstop_history`. This sync is deliberately separate from report-card generation so redeemability remains a first-class worker dataset with its own cron visibility, API surface, and methodology versioning.

Current reserve-sync support distinguishes direct and proxy live-capacity telemetry. Only adapters that explicitly expose immediate redemption capacity can drive `sourceMode = dynamic`, while fee-only adapters (for example `single-asset`) are now restricted to fee telemetry only. Reserve-sync routes require a fresh `ok` authoritative reserve snapshot; degraded snapshots, stale rows, and rows without scoring-grade freshness evidence now fall back conservatively or leave the route unrated.

### sync-kinesis-supply

**File:** `worker/src/cron/sync-kinesis-supply.ts`
**Schedule:** `11 * * * *` (hourly at :11 UTC, after `sync-redemption-backstops`)
**Data source:** Kinesis Horizon `/coin_in_circulation` endpoint (KAU and KAG chains)

**Purpose:** Fetches circulation, cumulative mint, and cumulative redemption totals from the two Kinesis Stellar-fork blockchains. Writes circulation to the `onchain_supply` table for independent supply verification against DefiLlama/CoinGecko. Caches full totals in the `cache` table under `kinesis-kinesis-kau-totals` / `kinesis-kinesis-kag-totals` for future flow-delta computation.

**Endpoints:**
- KAU: `https://kau-mainnet.kinesisgroup.io/coin_in_circulation`
- KAG: `https://kag-mainnet.kinesisgroup.io/coin_in_circulation`

**Circuit breakers:** `KINESIS_KAU` and `KINESIS_KAG` (independent per chain).

### sync-bluechip

**File:** `worker/src/cron/sync-bluechip.ts`
**Schedule:** `5 8 * * *` (daily at 08:05 UTC)
**Data source:** `https://backend.bluechip.org/coin-data/{slug}`

**Purpose:** Fetches safety ratings from bluechip.org for 20 tracked stablecoins.

**Constants:**

| Constant      | Value                                    |
| ------------- | ---------------------------------------- |
| `STALE_HOURS` | 6                                        |
| `API_BASE`    | `https://backend.bluechip.org/coin-data` |
| Batch size    | 3 concurrent requests                    |
| Batch delay   | 500ms between batches                    |
| Max retries   | 2 per request                            |

**Algorithm:**

1. Check cache freshness: if `bluechip-ratings` cache is <6 hours old, skip
2. Fetch ratings for all 20 slugs in `BLUECHIP_SLUG_MAP` (file: `worker/src/lib/bluechip-slugs.ts`)
   - Processed in batches of 3, with 500ms delay between batches
   - Each request uses `fetchWithRetry()` with `maxRetries: 2`
3. For each response, extract:
   - `grade` (A+ through F)
   - `collateralization` (percentage)
   - `smartContractAudit` (boolean)
   - `dateOfRating`, `dateLastChange`
   - `smidge`: 6 category summaries (stability, management, implementation, decentralization, governance, externals) — HTML stripped via regex
4. Merge any freshly fetched rows onto the previous cache map so missed slugs do not disappear from the published payload
5. Treat malformed/non-JSON `200` responses as slug-scoped failures (`json-parse-failed`) instead of aborting the whole cron on a raw parser exception
6. If zero ratings fetched: preserve existing cache, don't overwrite
7. If only a subset of slugs succeeded: store the merged map and return `status: "degraded"` with `fallbackMode: "partial-cache-merge"`; this degraded partial-refresh path does not count as a circuit-breaker failure as long as at least one fresh slug was recovered
8. Store `Record<string, BluechipRating>` (keyed by canonical Pharos ID) via `setCacheIfNewer()`

**Tracked coins:** USDC, USDT, DAI, LUSD, BOLD, PYUSD, PAXG, XAUT, GUSD, USDP, EURC, FDUSD, FRAX, GHO, TUSD, RLUSD, XSGD, OUSD, CETES.

---

## Health & Status Endpoints

### GET /api/health

Returns cache freshness for key data sources, with per-source staleness thresholds:

| Cache Key           | Stale threshold |
| ------------------- | --------------- |
| `stablecoins`       | 600s (10 min)   |
| `stablecoin-charts` | 3,600s (1h)     |
| `usds-status`       | 86,400s (24h)   |
| `fx-rates`          | 1,800s (30 min) |
| `bluechip-ratings`  | 86,400s (24h)   |
| `dex-liquidity`     | 43,200s (12h)   |
| `yield-data`        | 3,600s (1h)     |
| `dews`              | 1,800s (30 min) |

Health freshness checks for mint/burn major symbols and scheduler stale alerts use the same shared resolver in `worker/src/lib/mint-burn-health-config.ts`, including env overrides (`MINT_BURN_MAJOR_SYMBOLS`, `MINT_BURN_STALE_WARN_SEC`, `MINT_BURN_STALE_CRIT_SEC`, `MINT_BURN_ALERT_COOLDOWN_SEC`). The public `/api/health` status itself now follows critical-lane sync freshness (`lastSuccessfulSyncAt` + latest run status) rather than raw event recency, so quiet majors do not produce false stale health.

`/api/health` also returns a `warnings: string[]` field. Subquery failures (for example blacklist or circuit-state lookups) no longer silently degrade to zero-like values; instead the endpoint downgrades `status` and emits machine-readable warning strings while still returning `200`.

### GET /api/status

Returns raw and effective status, recent `cron_runs`, active `cron_run_progress` rows, data-quality metrics, state-machine metadata, synthetic probe summary, and transition timeline. Tracks 28 cron jobs across 13 triggers via `CRON_INTERVALS` in `shared/lib/cron-jobs.ts`:

| Job                             | Interval       | Trigger                                     |
| ------------------------------- | -------------- | ------------------------------------------- |
| `sync-stablecoins`              | 900s (15min)   | `*/15 * * * *`                              |
| `sync-stablecoin-charts`        | 3,600s (1h)    | `10,40 * * * *` (1h cooldown)               |
| `sync-fx-rates`                 | 900s (15min)   | `*/15 * * * *`                              |
| `stability-index`               | 1,800s (30min) | `10,40 * * * *`                             |
| `compute-dews`                  | 1,800s (30min) | `10,40 * * * *`                             |
| `status-self-check`             | 900s (15min)   | `*/15 * * * *`                              |
| `dispatch-telegram-alerts`      | 300s (5min)    | `2,7,12,17,22,27,32,37,42,47,52,57 * * * *` |
| `sync-blacklist`                | 3,600s (1h)    | `3 * * * *`                                  |
| `sync-mint-burn`                | 1,200s (20min) | `4,24,44 * * * *`                           |
| `sync-dex-discovery`            | 1,800s (30min) | `6,36 * * * *`                              |
| `sync-mint-burn-extended`       | 1,200s (20min) | `13,33,53 * * * *`                          |
| `sync-dex-liquidity`            | 1,800s (30min) | `10,40 * * * *`                             |
| `sync-yield-data`               | 3,600s (1h)    | `20 * * * *`                                |
| `sync-yield-supplemental`       | 14,400s (4h)   | `25 */4 * * *`                              |
| `snapshot-supply`               | 86,400s (24h)  | `*/15 * * * *` (primary) / `0 8 * * *` (fallback) |
| `snapshot-chain-supply`         | 86,400s (24h)  | `*/15 * * * *`                              |
| `snapshot-safety-grade-history` | 86,400s (24h)  | `0 8 * * *`                                 |
| `fetch-tbill-rate`              | 86,400s (24h)  | `0 8 * * *`                                 |
| `snapshot-psi`                  | 86,400s (24h)  | `0 8 * * *`                                 |
| `sync-usds-status`              | 86,400s (24h)  | `0 8 * * *`                                 |
| `sync-live-reserves`            | 3,600s (1h)    | `11 * * * *`                                |
| `sync-redemption-backstops`     | 3,600s (1h)    | `11 * * * *`                                |
| `sync-kinesis-supply`           | 3,600s (1h)    | `11 * * * *`                                |
| `sync-bluechip`                 | 86,400s (24h)  | `5 8 * * *`                                 |
| `daily-digest`                  | 86,400s (24h)  | `5 8 * * *`                                 |
| `weekly-recap`                  | 604,800s (7d)  | `5 8 * * *`                                 |
| `discovery-scan`                | 604,800s (7d)  | `5 8 * * *` (Monday-only)                   |
| `yield-coverage-audit`          | 2,592,000s (30d) | `0 6 1 * *`                               |

A job is marked "unhealthy" if its last run had `status='error'` or if the last run started more than 2× its expected interval ago. `/api/status` now also exposes `crons[*].inFlight` while a long-running leased job is active, including `stage`, `itemsDone/itemsTotal`, the last heartbeat timestamp, and a `stale` flag when the active-progress row stops updating. Only progress rows backed by a still-active matching lease are surfaced this way.

The status handler now surfaces per-subsection loader failures through `sectionErrors` instead of silently swallowing them. When a subsection query fails, the affected field degrades to `null`/empty and the response still returns `200` with a machine-readable error entry for that subsection.

### GET /api/status-history

Admin timeline feed for machine consumers. Returns persisted status state, status-system staleness, latest synthetic probe aggregate, discrepancy summary, and recent status transitions.

---

## Key Constants

**File:** `worker/src/lib/constants.ts`

| Constant                        | Value                               | Purpose                               |
| ------------------------------- | ----------------------------------- | ------------------------------------- |
| `D1_BATCH_SIZE`                 | 100                                 | Max statements per D1 batch           |
| `ETHERSCAN_V2_BASE`             | `https://api.etherscan.io/v2/api`   | Etherscan unified endpoint            |
| `DEFILLAMA_BASE`                | `https://stablecoins.llama.fi`      | DefiLlama stablecoins                 |
| `DEFILLAMA_COINS`               | `https://coins.llama.fi`            | DefiLlama coin prices                 |
| `DEFILLAMA_API`                 | `https://api.llama.fi`              | DefiLlama yields/protocols            |
| `USER_AGENT`                    | `Pharos/1.0 (stablecoin analytics)` | All outbound requests                 |
| `MIN_VALID_ASSET_COUNT`         | 50                                  | Minimum assets from DL for valid sync |
| `DEXSCREENER_MIN_LIQUIDITY_USD` | 50,000                              | DexScreener pool threshold            |

---

## File Index

| File                                               | Role                                                                                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worker/src/index.ts`                              | Thin worker entry: delegates `fetch`/`scheduled` to handler modules                                                                                                 |
| `worker/src/handlers/http.ts`                      | HTTP request orchestration: preflight, gates, edge cache lookup/write, route-context build, router dispatch                                                        |
| `worker/src/handlers/http/cors.ts`                 | CORS origin resolution, preflight response, and response-header decoration                                                                                           |
| `worker/src/handlers/http/gates.ts`                | Maintenance-mode gate, public API rate limiting, and one-time env-contract warnings                                                                                  |
| `worker/src/handlers/http/context.ts`              | Route dependency hydration from `Env` into `FullRouteContext`                                                                                                        |
| `worker/src/handlers/http/edge-cache.ts`           | Edge cache match/store policy for cacheable GET requests                                                                                                             |
| `worker/src/handlers/scheduled.ts`                 | Thin cron entrypoint: env-aware init + cron-expression-to-slot-runner dispatch                                                                                      |
| `worker/src/handlers/scheduled/context.ts`         | Shared scheduled runtime context: lease-aware `runLeasedCron`, slot config, stablecoins capability parsing                                                          |
| `worker/src/handlers/scheduled/*.ts`               | Per-trigger slot runners (quarter-hourly, isolated mint/burn lanes, half-hourly including DEX discovery, hourly blacklist + reserve slots, Telegram, and daily slots) |
| `worker/src/lib/env.ts`                            | Worker Env interface + `parseCsvEnv()` helper for CSV-based runtime overrides                                                                                       |
| `worker/wrangler.toml`                             | Deployment config: custom domain, cron triggers, D1 binding, vars                                                                                                   |
| `worker/src/lib/db.ts`                             | Database helpers: `batchExecute`, block tracking                                                                                                                    |
| `worker/src/lib/db-cache.ts`                       | Cache CRUD: `getCache`, `setCache`, `setCacheIfNewer`, `getPriceCache`, `savePriceCache`                                                                            |
| `worker/src/lib/cron-logger.ts`                    | `logCronRun` wrapper and `CronResult` type                                                                                                                          |
| `worker/src/lib/cron-lease.ts`                     | Cron lease primitives: `acquireCronLease`, `runCronWithLease`, `CRON_TIMEOUT_MS`                                                                                    |
| `worker/src/lib/auth.ts`                           | Admin auth: verifies the `ops-api` Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`)                                                                               |
| `worker/src/lib/alerts.ts`                         | Webhook alerts: auto-detects Discord/Slack format                                                                                                                   |
| `worker/src/lib/constants.ts`                      | Shared constants: API URLs, thresholds, cache profiles                                                                                                              |
| `shared/lib/cron-jobs.ts`                          | Shared cron expressions, per-job intervals, `CRON_INTERVALS`, and status-page grouping/trigger metadata                                                             |
| `shared/lib/status-thresholds.ts`                  | Shared status threshold constants for frontend + worker data-quality/status bands                                                                                   |
| `worker/src/lib/blacklist-gaps.ts`                 | Shared blacklist gap query helper (Tron null-amount exclusion + recent window)                                                                                      |
| `worker/src/lib/chain-registry.ts`                 | Unified chain mappings + chain RPC configs: Alchemy/dRPC/public fallback for 11 chains                                                                              |
| `worker/src/lib/coingecko.ts`                      | CoinGecko init: free/pro URL switching, auth headers                                                                                                                |
| `worker/src/lib/bluechip-slugs.ts`                 | Bluechip slug → canonical Pharos ID mapping (20 coins)                                                                                                              |
| `worker/src/lib/mint-burn-health-config.ts`        | Shared mint/burn freshness defaults, env override resolver, stale-symbol evaluator                                                                                  |
| `worker/src/lib/dex-liquidity.ts`                  | Shared `dex_liquidity` table loader (`loadDexLiquidityMap`)                                                                                                         |
| `worker/src/lib/redemption-backstop-sources.ts`    | Redemption-route resolver: capacity models, docs, costs, and effective-exit scoring inputs                                                                          |
| `worker/src/lib/redemption-backstops-store.ts`     | D1 snapshot storage + `GET /api/redemption-backstops` response builder                                                                                              |
| `worker/src/lib/psi-recompute.ts`                  | Shared historical PSI day-input builder used by audit/backfill admin APIs                                                                                           |
| `worker/src/lib/mint-burn-contracts.ts`            | Mint/burn event configs resolved from shared stablecoin contracts, plus explicit vault overrides, `startBlock`, and per-config tiering metadata                     |
| `worker/src/lib/mint-burn-scoring.ts`              | FIS computation, gauge bands, flight-to-quality detection (pure functions)                                                                                          |
| `worker/src/cron/sync-stablecoin-charts.ts`        | Chart sync: DefiLlama charts, FX fix, downsampling                                                                                                                  |
| `worker/src/cron/sync-mint-burn.ts`                | Mint/burn flow sync: Alchemy log scanning (Transfer + custom topics), hourly aggregation                                                                            |
| `worker/src/cron/sync-redemption-backstops.ts`     | Hourly redemption-route snapshot sync used by detail pages and report cards                                                                                         |
| `worker/src/cron/sync-kinesis-supply.ts`           | Hourly Kinesis Horizon supply sync: KAU/KAG circulation, mint, and redemption totals                                                                               |
| `worker/src/cron/sync-usds-status.ts`              | USDS freeze monitor: ERC-1967 proxy inspection                                                                                                                      |
| `worker/src/cron/sync-bluechip.ts`                 | Bluechip ratings: batch fetch from bluechip.org                                                                                                                     |
| `worker/src/cron/snapshot-safety-grade-history.ts` | Daily Safety Score grade history snapshot writer (seed + grade-change events)                                                                                       |
| `worker/src/cron/status-self-check.ts`             | Status reliability self-check: default-origin internal router probes, external `SELF_URL` HTTP probes, hysteresis persistence, discrepancy + probe-failure alerting |
| `worker/src/lib/status-reliability.ts`             | Stable facade for status reliability imports                                                                                                                        |
| `worker/src/lib/status-state-store.ts`             | Status hysteresis state persistence, snapshots, and transition history                                                                                              |
| `worker/src/lib/status-probe-store.ts`             | Status self-probe persistence helpers                                                                                                                                                                                                     |
| `worker/src/lib/status-discrepancy-store.ts`       | Divergence/probe-failure streak persistence and alert markers                                                                                                                                                                             |
| `worker/src/lib/status-discrepancy-view.ts`        | Discrepancy view assembly from effective status + probe summary                                                                                                                                                                           |
| `worker/migrations/0000_baseline.sql`              | Baseline schema for `cache`, blacklist tables, cron leases, and the rest of the pre-0072 D1 surface                                                                |

---

### Migration Baseline

The D1 migration tree was squashed on 2026-03-25. `worker/migrations/0000_baseline.sql` now represents historical migrations `0001` through `0071`, and fresh databases apply that baseline before the remaining checked-in incremental migrations (`0072+`).

Normal production deploy still applies D1 migrations before the new worker binary is live. Because of that ordering, the default path only supports backward-compatible migrations: new migration files starting at `0071` must include `-- rollout-safety: backward-compatible` and avoid destructive table/column drop-or-rename patterns. Any destructive cleanup needs a separate coordinated rollout after the new worker code is already serving. See also [`worker/migrations/MANIFEST.md`](../worker/migrations/MANIFEST.md) for the rollback runbook, the baseline lineage, and the enforced rollout-safety contract.
