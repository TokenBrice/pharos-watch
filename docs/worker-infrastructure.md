# Worker Infrastructure

Cloudflare Worker serving the Pharos API. Handles HTTP routing, edge caching, CORS, admin auth, and 26 scheduled runtime jobs across 10 cron expressions / trigger slots. `CRON_INTERVALS` / `/api/status` track 25 of them; `announce-cemetery-additions` runs on the Telegram trigger but is intentionally excluded from the shared status metadata set.

Execution note: the `snapshot-supply` retry path runs on the `*/15 * * * *` trigger only after a downstream-safe `sync-stablecoins` cache write.

**Deployed at:** `api.pharos.watch` (public API route) and `ops-api.pharos.watch` (operator-prep route declared in `wrangler.toml`; pair with Cloudflare Access before use)

---

## Runtime Limits and Observability

Worker runtime safety and telemetry controls are declared in `worker/wrangler.toml` and should be managed in git (the CI deploy job runs `wrangler deploy` and then `wrangler triggers deploy`, so dashboard-only edits can be overwritten on the next deployment).

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

- `cpu_ms = 30000`: hard cap on CPU time per invocation (not wall-clock runtime). This is independent from in-app wall-clock cron timeouts in `logCronRun()`. Raised from 5000 to give isolated cron triggers comfortable headroom (paid plan allows up to 300,000ms).
- `observability.enabled`: enables Worker traces.
- `head_sampling_rate = 0.1`: samples 10% of traces.
- `observability.logs.enabled` + `invocation_logs = true`: enables Workers Logs in dashboard.

---

## Env Interface

The `Env` interface is defined in `worker/src/lib/env.ts` and consumed by `worker/src/index.ts` plus `worker/src/handlers/http.ts` and the scheduled-runtime entrypoint/context (`worker/src/handlers/scheduled.ts`, `worker/src/handlers/scheduled/context.ts`). `DB` and `CORS_ORIGIN` are set in `wrangler.toml`; remaining bindings are runtime env values (typically provided via `wrangler secret put`).

| Binding                         | Type       | Required           | Used by                                                                                                                                                                    |
| ------------------------------- | ---------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DB`                            | D1Database | Yes                | All crons and API handlers                                                                                                                                                 |
| `CORS_ORIGIN`                   | string     | Yes                | Comma-separated CORS allowlist. Repo default: `https://pharos.watch,https://ops.pharos.watch`                                                                              |
| `SELF_URL`                      | string     | No                 | Status self-check external probe base URL; the default production origin (`https://api.pharos.watch`) is router-probed internally to avoid custom-domain self-fetch `522`s |
| `OPS_UI_ORIGIN`                 | string     | No                 | Shared operator-origin override. The worker runtime does not currently read it, but the same value is used by Pages Functions host gating (`https://ops.pharos.watch`)     |
| `OPS_API_ORIGIN`                | string     | No                 | Shared operator-origin override. The worker runtime does not currently read it, but the same value is used by Pages Functions proxying (`https://ops-api.pharos.watch`)    |
| `CF_ACCESS_TEAM_DOMAIN`         | string     | No                 | Reserved on the worker runtime today; used only for Cloudflare Access-related operator-origin surfaces when configured                                                     |
| `CF_ACCESS_OPS_UI_AUD`          | string     | No                 | Reserved on the worker runtime today; future/operator-surface Access UI JWT audience                                                                                       |
| `CF_ACCESS_OPS_API_AUD`         | string     | No                 | Reserved on the worker runtime today; future/operator-surface Access API JWT audience                                                                                      |
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
| `GITHUB_PAT`                    | string     | No                 | Feedback → GitHub Issues/Discussions                                                                                                                                       |
| `GITHUB_REPO_NODE_ID`           | string     | No                 | Feature request → GitHub Discussions                                                                                                                                       |
| `GITHUB_DISCUSSION_CATEGORY_ID` | string     | No                 | Discussion category routing                                                                                                                                                |
| `FEEDBACK_IP_SALT`              | string     | Yes (for feedback) | Rate limit IP hashing for `POST /api/feedback`                                                                                                                             |
| `PUBLIC_API_RATE_LIMIT_SALT`    | string     | No                 | Optional salt for hashed public API rate limiting; falls back to `FEEDBACK_IP_SALT`, then a built-in constant                                                              |
| `TWITTER_API_KEY`               | string     | No                 | Digest → Twitter (OAuth consumer key)                                                                                                                                      |
| `TWITTER_API_SECRET`            | string     | No                 | Digest → Twitter (OAuth consumer secret)                                                                                                                                   |
| `TWITTER_ACCESS_TOKEN`          | string     | No                 | Digest → Twitter (access token)                                                                                                                                            |
| `TWITTER_ACCESS_TOKEN_SECRET`   | string     | No                 | Digest → Twitter (access token secret)                                                                                                                                     |
| `TELEGRAM_BOT_TOKEN`            | string     | No                 | Digest → Telegram, bot chat replies, subscriber alert dispatch                                                                                                             |
| `TELEGRAM_CHAT_ID`              | string     | No                 | Digest channel posts and cemetery announcements                                                                                                                            |
| `TELEGRAM_WEBHOOK_SECRET`       | string     | No                 | Random string for webhook URL validation (set via `wrangler secret put`)                                                                                                   |
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

These are pure functions (no module-level mutable state). `Env` bindings are only available inside handler functions (not at module initialization time), so values are computed fresh per-request/per-trigger via the context factory.

## Public API Rate Limiting

Non-admin public `/api/*` requests are rate-limited through the D1-backed `public_api_rate_limit` table with per-minute hashed IP buckets. The worker prefers `PUBLIC_API_RATE_LIMIT_SALT`, then `FEEDBACK_IP_SALT`, then a built-in fallback constant to avoid storing raw IPs in D1. If the distributed limiter path fails, the worker falls back to the legacy isolate-local in-memory limiter so the request path still has bounded abuse protection.

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

- `worker/src/handlers/http.ts` calls `checkPublicApiRateLimit(...)` for non-admin public `/api/*` traffic before router dispatch.
- Default threshold: `300 requests / 60 seconds` per IP hash, enforced through the D1-backed `public_api_rate_limit` table.
- If the distributed D1 path fails, `worker/src/lib/rate-limit.ts` falls back to the legacy isolate-local in-memory limiter for the same threshold/window.
- Requests that already carry valid `ops-api.pharos.watch` Access/service-token signals bypass this limiter.

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
| Slow     | `public, s-maxage=3600, max-age=300` | supply-history, bluechip-ratings, dex-liquidity-history, yield-history, safety-score-history, digest-snapshot                                                                     |

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

- Accepts only the `ops-api.pharos.watch` lane carrying Cloudflare Access user/JWT or service-token signals
- Internal worker-origin admin calls (for example `status-self-check`) simulate that same lane instead of using a shared secret
- Returns `null` if authorized, 401 Response if not
- The worker checks header presence only. Cloudflare Access must stay in front of `ops-api.pharos.watch`; if the worker becomes reachable without Access in that path, admin routes are exposed.

### Router-Dispatched Status Actions

Status page manual/admin actions are dispatched through `worker/src/router.ts` using shared endpoint definitions (`shared/lib/api-endpoints.ts`). Examples:

| Endpoint                         | Auth                                         | Description                                                             |
| -------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------- |
| `POST /api/trigger-digest`       | `ops-api` + Access user/JWT or service token | Force-regenerates digest with `force=true`, posts to Twitter + Telegram |
| `POST /api/reset-blacklist-sync` | `ops-api` + Access user/JWT or service token | Rolls back sync state: EVM −50,000 blocks, Tron −7 days                 |
| `GET /api/debug-sync-state`      | `ops-api` + Access user/JWT or service token | Returns all `blacklist_sync_state` rows                                 |

Additional backfill/audit actions are defined in the same registry and surfaced dynamically on `/status`. `POST /api/feedback` is router-dispatched too, but it is not part of the status action registry.

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

Most module-level mutable state was eliminated in the parameter-passing refactor. The remaining module-level state is:

- `rate-limit.ts` → module-level `ipCounts` Map (isolate-local fallback rate limiter)

**Constraints:**

- State persists within an isolate but resets on cold starts
- State is NOT shared across isolates
- The `ipCounts` rate limiter provides best-effort protection within a single isolate only

---

## Cron Scheduling

This worker declares 10 cron expressions in `worker/wrangler.toml`. Fetch-heavy lanes are split across separate trigger slots so they do not compete with the quarter-hourly core pipeline for the Workers per-trigger 6-connection fetch pool.

### wrangler.toml Triggers

```toml
[triggers]
crons = [
  "*/15 * * * *",
  "3,23,43 * * * *",
  "4,24,44 * * * *",
  "6,36 * * * *",
  "13,33,53 * * * *",
  "10,40 * * * *",
  "11 * * * *",
  "2,7,12,17,22,27,32,37,42,47,52,57 * * * *",
  "0 8 * * *",
  "5 8 * * *",
]
```

### Trigger 1: `*/15 * * * *` (every 15 minutes)

| Job                              | Function                                              | File                                              | Documentation                                                                |
| -------------------------------- | ----------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| `sync-stablecoins`               | `syncStablecoins()`                                   | `worker/src/cron/sync-stablecoins.ts`             | [Data Pipeline](./data-pipeline.md), [Depeg Detection](./depeg-detection.md) |
| `snapshot-supply` _(retry path)_ | `snapshotSupply()` (chained after `sync-stablecoins`) | `worker/src/cron/snapshot-supply.ts`              | [Supply Snapshot Pipeline](./supply-snapshot.md)                             |
| `snapshot-chain-supply`          | `snapshotChainSupply()` (chained after `snapshot-supply`, DB-only, 0 external connections) | `worker/src/cron/snapshot-chain-supply.ts` | [Supply Snapshot Pipeline](./supply-snapshot.md) |
| `sync-fx-rates`                  | `syncFxRates()`                                       | `worker/src/cron/sync-fx-rates.ts`                | [Data Pipeline](./data-pipeline.md), [Classification](./classification.md)   |
| `stability-index`                | `computeAndStoreStabilityIndex()`                     | `worker/src/cron/stability-index.ts`              | [Pharos Stability Index](./stability-index.md)                               |
| `compute-dews`                   | `computeAndStoreDEWS()`                               | `worker/src/cron/compute-dews.ts`                 | [DEWS](./dews.md)                                                            |
| `status-self-check`              | `runStatusSelfCheck()`                                | `worker/src/cron/status-self-check.ts`            | [Status Dashboard](./status-dashboard.md)                                    |
| _(inline)_                       | Stale-cache health alert                              | `worker/src/handlers/scheduled/quarter-hourly.ts` | This doc (below)                                                             |

**Execution model:** Jobs in this slot are run sequentially in `worker/src/handlers/scheduled/quarter-hourly.ts` to respect the Workers shared 6-connection fetch pool per cron trigger. `sync-stablecoins` now reports explicit capability metadata:

- `capabilities.stablecoinsCache`
- `capabilities.depegPipeline`

`snapshot-supply` retry and `compute-dews` require the stablecoins-cache capability. `stability-index` additionally requires the depeg-pipeline capability, which prevents depeg-stage regressions from propagating as fresh PSI state.

**Inline staleness alert:** After sync-stablecoins completes, if the `stablecoins` cache is older than 1800 seconds (30 min), `sendAlert()` fires a webhook notification. This is a health check — not a cron job itself.

### Trigger 2: `3,23,43 * * * *` (blacklist — dedicated)

| Job              | Function          | File                                | Documentation                               |
| ---------------- | ----------------- | ----------------------------------- | ------------------------------------------- |
| `sync-blacklist` | `syncBlacklist()` | `worker/src/cron/sync-blacklist.ts` | [Blacklist Tracker](./blacklist-tracker.md) |

Dedicated trigger for blacklist sync. Uses Etherscan for supported chains, chain RPC log scans (Alchemy/public fallback) for Base/Optimism/Avalanche/BSC, dRPC for historical L2 balance reads, and TronGrid for Tron. Gets its own 6-connection pool and CPU budget.

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

### Trigger 5: `13,33,53 * * * *` (every 20 minutes, offset at :13/:33/:53)

| Job                       | Function                       | File                                | Documentation    |
| ------------------------- | ------------------------------ | ----------------------------------- | ---------------- |
| `sync-mint-burn-extended` | `syncMintBurn()` extended lane | `worker/src/cron/sync-mint-burn.ts` | This doc (below) |

This offset schedule exists so long-tail mint/burn backfill pressure cannot starve the critical lane. It uses a separate `mint_burn_run_state.job` key (`sync-mint-burn-extended`) and warning-only coverage semantics.

### Trigger 6: `10,40 * * * *` (every 30 minutes, at :10/:40)

| Job                      | Function                 | File                                                                  | Documentation                                 |
| ------------------------ | ------------------------ | --------------------------------------------------------------------- | --------------------------------------------- |
| `sync-stablecoin-charts` | `syncStablecoinCharts()` | `worker/src/cron/sync-stablecoin-charts.ts`                           | This doc (below)                              |
| `sync-dex-liquidity`     | `syncDexLiquidity()`     | `worker/src/cron/dex-liquidity/orchestrator.ts`                       | [DEX Liquidity Score](./dex-liquidity.md)     |
| `sync-yield-data`        | `syncYieldData()`        | `worker/src/cron/sync-yield-data.ts` + `worker/src/cron/yield-sync/*` | [Yield Intelligence](./yield-intelligence.md) |

**Execution model:** All three jobs are chained sequentially: charts → dex-liquidity → yield-data. Charts is a single lightweight DL fetch (~2s) that completes quickly and frees the pool. `sync-yield-data` is chained after `sync-dex-liquidity` for safety-score dependencies. The slot shares the Workers 6-connection limit, so fetch-heavy additions must account for total in-slot concurrency.

`sync-dex-liquidity` metadata now tracks both row coverage and value coverage. In addition to `currentCoverage` / `previousCoverage`, the cron records `currentGlobalTvl`, `previousGlobalTvl`, top-10 covered TVL, row/value guard flags, and current/previous coverage-class distribution. `/status` surfaces this through the Liquidity Health card.

### Trigger 7: `11 * * * *` (hourly at :11 — reserve + redemption lane)

| Job                         | Function                    | File                                           | Documentation                                     |
| --------------------------- | --------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| `sync-live-reserves`        | `syncLiveReserves()`        | `worker/src/cron/sync-live-reserves.ts`        | This doc (below)                                  |
| `sync-redemption-backstops` | `syncRedemptionBackstops()` | `worker/src/cron/sync-redemption-backstops.ts` | [Redemption Backstops](./redemption-backstops.md) |

**Connection budget:** dedicated hourly trigger for reserve and redemption tuning. Jobs run sequentially so live reserve adapters finish before redemption backstop sync consumes reserve metadata.

### Trigger 8: `2,7,12,17,22,27,32,37,42,47,52,57 * * * *` (Telegram dispatch — dedicated, every 5 min)

| Job                           | Function                      | File                                             | Documentation                                                                                 |
| ----------------------------- | ----------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `dispatch-telegram-alerts`    | `dispatchTelegramAlerts()`    | `worker/src/cron/dispatch-telegram-alerts.ts`    | [Telegram Alert Bot](./telegram-alerts.md)                                                    |
| `announce-cemetery-additions` | `announceCemeteryAdditions()` | `worker/src/cron/announce-cemetery-additions.ts` | [Telegram Alert Bot](./telegram-alerts.md), [Cemetery and Compare](./cemetery-and-compare.md) |

Dedicated trigger for Telegram work. Isolated from the quarter-hourly pipeline so subscriber fan-out and channel posting get their own 6-connection pool and CPU budget. The scheduled handler runs the two jobs sequentially: subscriber alerts first, cemetery channel diff second. Subscriber fan-out uses up to 5 of 6 available connections for parallel `sendBatch()` sends. Up to 200 subscriber message attempts per run; overflow and retryable fresh-send failures are enqueued to `telegram_pending_alerts` in D1 for subsequent runs.

### Trigger 9: `0 8 * * *` (daily at 08:00 UTC — snapshots & lightweight fetchers)

| Job                             | Function                       | File                                               | Documentation                                    |
| ------------------------------- | ------------------------------ | -------------------------------------------------- | ------------------------------------------------ |
| `snapshot-supply`               | `snapshotSupply()`             | `worker/src/cron/snapshot-supply.ts`               | [Supply Snapshot Pipeline](./supply-snapshot.md) |
| `snapshot-safety-grade-history` | `snapshotSafetyGradeHistory()` | `worker/src/cron/snapshot-safety-grade-history.ts` | [Risk Lab](./report-cards.md)                    |
| `snapshot-psi`                  | `snapshotPsiDaily()`           | `worker/src/cron/snapshot-psi.ts`                  | [Pharos Stability Index](./stability-index.md)   |
| `sync-usds-status`              | `syncUsdsStatus()`             | `worker/src/cron/sync-usds-status.ts`              | This doc (below)                                 |
| `fetch-tbill-rate`              | `fetchTbillRate()`             | `worker/src/cron/fetch-tbill-rate.ts`              | [Yield Intelligence](./yield-intelligence.md)    |

**Connection budget:** 3 snapshot jobs are D1-only (0 external connections). `fetch-tbill-rate` (FRED) and `sync-usds-status` (Etherscan) use ≤2 concurrent external connections on this trigger.

### Trigger 10: `5 8 * * *` (daily at 08:05 UTC — heavy external fetchers)

| Job              | Function                | File                                | Documentation                           |
| ---------------- | ----------------------- | ----------------------------------- | --------------------------------------- |
| `sync-bluechip`  | `syncBluechip()`        | `worker/src/cron/sync-bluechip.ts`  | This doc (below)                        |
| `daily-digest`   | `generateDailyDigest()` | `worker/src/cron/daily-digest.ts`   | [Digest Pipeline](./digest-pipeline.md) |
| `discovery-scan` | `runDiscoveryScan()`    | `worker/src/cron/discovery-scan.ts` | [Data Pipeline](./data-pipeline.md)     |

**Connection budget:** `sync-bluechip` (3 parallel batch connections), `daily-digest` (1 long-lived Anthropic API call), and `discovery-scan` (1 CoinGecko call) use ≤5 concurrent external connections. The 5-minute offset from Trigger 9 ensures PSI snapshot data is available for the daily digest without an explicit chain dependency.

### Cron Slot Capacity and Connection Pool Budget

Workers enforce a **6 concurrent fetch connections** limit per cron trigger invocation. All jobs sharing a trigger slot share this pool. Exceeding 6 causes `fetch()` to queue or fail.

| Trigger | Cron Expression | Max Concurrent External Connections | Headroom |
|---------|----------------|:---:|:---:|
| 1 | `*/15 * * * *` | 3 (sync-stablecoins + sync-fx-rates + status-self-check) | 3 |
| 2 | `3,23,43 * * * *` | 4 (multi-chain blacklist scans) | 2 |
| 3 | `4,24,44 * * * *` | 2 (Alchemy JSON-RPC) | 4 |
| 4 | `6,36 * * * *` | 1 (sequential CG/GT/DexScreener) | 5 |
| 5 | `13,33,53 * * * *` | 2 (Alchemy JSON-RPC, extended lane) | 4 |
| 6 | `10,40 * * * *` | 4 (charts + DEX liquidity + yield) | 2 |
| 7 | `11 * * * *` | 2 (reserve adapters + redemption) | 4 |
| 8 | `2,7,…,57 * * * *` | 5 (Telegram fan-out batch sends) | 1 |
| 9 | `0 8 * * *` | 2 (FRED + Etherscan) | 4 |
| 10 | `5 8 * * *` | 5 (bluechip + Anthropic + CoinGecko) | 1 |

**Policy for new jobs:**
- Jobs requiring ≤1 external connection may share any slot with headroom ≥2.
- Jobs requiring >2 concurrent connections should get a dedicated trigger slot.
- Never add a fetching job to a slot with headroom ≤1 (Triggers 8 and 10 are full).

### Cron Error Handling Policy

All cron jobs follow a 4-tier error classification:

| Tier | Example | Action | Log Level |
|------|---------|--------|-----------|
| **Fatal** | D1 unreachable, binding error | `sendAlert()` + abort job | `error` |
| **Recoverable** | External API timeout, HTTP 5xx | Retry with backoff (max 3), then warn | `warn` |
| **Validation** | Malformed API response, schema mismatch | Skip record, continue processing | `warn` |
| **Degradation** | Partial sync, stale data | Update status page, continue | `warn` |

**Fire-and-forget cleanup** (e.g., rate-limit pruning, cache eviction) may use `.catch()` with a counter. Non-critical background operations should never crash the main job.

**Alert deduplication:** Use job name + error category as the dedup key. Don't send the same alert more than once per 10-minute window.

## Telegram Alert Bot

- Webhook ingress (`POST /api/telegram-webhook`) receives Telegram commands and writes subscriber/subscription state into D1.
- `dispatch-telegram-alerts` diffs DEWS/depeg/safety state against cached snapshots before fan-out on a dedicated 5-minute cron slot.
- `announce-cemetery-additions` diffs the static cemetery dataset against a cached snapshot and posts one channel message when a deploy adds new entries.
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
| `worker/src/cron/enrich-prices.ts`                        | `syncStablecoins()` | [Data Pipeline](./data-pipeline.md)     |
| `worker/src/cron/sync-stablecoins/supplemental-assets.ts` | `syncStablecoins()` | [Data Pipeline](./data-pipeline.md)     |

---

## logCronRun() Wrapper

**File:** `worker/src/lib/cron-logger.ts`

Every cron job is wrapped with `runCronWithLease(...)` + `logCronRun(...)`:

`ctx.waitUntil(logCronRun(db, "job-name", (signal, reportProgress) => runCronWithLease(db, "job-name", async () => fn(db, signal, reportProgress))))`

```typescript
async function logCronRun(
  db: D1Database,
  job: string,
  fn: (signal: AbortSignal, reportProgress: CronProgressReporter) => Promise<CronResult | void>,
): Promise<void>;
```

**Behavior:**

- Records start time (Unix seconds)
- Exposes a lazy `reportProgress(...)` callback that writes/updates `cron_run_progress` only after a job explicitly reports in-flight state
- Executes the job function
- On success: inserts row into `cron_runs` with `status='ok'`, `item_count`, and `metadata`
- On lease contention: inserts row with `status='skipped_locked'` and lease metadata
- On error: inserts row with `status='error'` and error message, calls `sendAlert()`, re-throws
- On completion/error of a progress-reporting job: clears the corresponding `cron_run_progress` row
- After each run: prunes rows older than 7 days (`started_at < now - 604800`); if prune fails, falls back to keeping only the top 5000 rows by rowid DESC

**Schema:** `cron_runs(job, started_at, duration_ms, status, item_count, metadata, error)`

### In-flight Cron Progress

Long-running leased jobs can now surface active progress through `cron_run_progress`, which powers `/api/status` while the run is still live.

```sql
CREATE TABLE cron_run_progress (
  job TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
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
| `sync-dex-discovery`      | 23 min  | Multi-source pool staging; dedicated 30-minute trigger allows extended runtime                                                                                                                            |
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
- **Health impact**: Any open circuit triggers `degraded` status on `/api/health`

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
| `ALCHEMY`                            | `alchemy`                     | `sync-mint-burn`                                                             |
| `PYTH_PRICES`                        | `pyth-prices`                 | `enrich-prices` primary consensus                                            |
| `BINANCE_PRICES`                     | `binance-prices`              | `enrich-prices` primary consensus                                            |
| `COINBASE_PRICES`                    | `coinbase-prices`             | `enrich-prices` primary consensus                                            |
| `REDSTONE_PRICES`                    | `redstone-prices`             | `enrich-prices` primary consensus                                            |
| `CURVE_ONCHAIN`                      | `curve-onchain`               | `enrich-prices` primary consensus                                            |
| `CURVE_LIQUIDITY_API`                | `curve-liquidity-api`         | `sync-dex-liquidity` (Curve pool liquidity fetch)                            |
| `FX_REALTIME`                        | `fx-realtime`                 | `sync-fx-rates` real-time FX cross-validation                                |
| `GECKO_TERMINAL_PROBE`               | `geckoterminal-probe`         | `enrich-prices` GeckoTerminal price probe fallback                           |
| `TWITTER_API`                        | `twitter-api`                 | `daily-digest` social posting                                                |
| `TELEGRAM_API`                       | `telegram-api`                | `daily-digest` social posting, `dispatch-telegram-alerts` subscriber fan-out |
| Dynamic `live-reserves:<scope>` keys | e.g. `live-reserves:infinifi` | `sync-live-reserves` per configured source or exact shared-source cluster    |

Primary-oracle implementation notes:

- `PYTH_PRICES` only counts as a healthy outcome when at least one requested feed resolves into a usable price; Hermes feed IDs are normalized by lowercasing and stripping an optional leading `0x`.
- `REDSTONE_PRICES` only counts as healthy when it returns at least one usable symbol. The worker queries an exact-case tracked-symbol allowlist in sequential batches of 10 and retries batch-dropped symbols individually once.

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

All lightweight cron data is stored in the generic `cache` table (migration `0001_initial.sql`):

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

Lease primitives are implemented in `worker/src/lib/cron-lease.ts` and backed by migration `0034_cron_leases.sql`.
These are infrastructure primitives only; scheduler-wide wiring is handled separately in later phases.

```sql
CREATE TABLE IF NOT EXISTS cron_leases (
  job TEXT PRIMARY KEY,
  lease_owner TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

| Function                                   | Description                                                                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `acquireCronLease(db, job, owner, ttlSec)` | Acquires lease for a job, or takes over when expired. Returns `true` on success, `false` if another active owner holds the lease. |
| `renewCronLease(db, job, owner, ttlSec)`   | Extends `lease_until` for the current owner. Returns `false` if ownership was lost.                                               |
| `releaseCronLease(db, job, owner)`         | Deletes lease row only when caller still owns it.                                                                                 |
| `runCronWithLease(db, job, fn, opts)`      | Wrapper primitive: acquire → heartbeat renewals → run fn → release; returns `ok` or `skipped_locked` with metadata.               |

Default behavior in `runCronWithLease`:

- Lease TTL defaults to `jobTimeout + 60s`
- Heartbeat defaults to `max(15s, ttl/3)`
- Owner defaults to `crypto.randomUUID()` when available

### Lease Integration Status

Lease primitives are now wired into scheduled cron execution through `worker/src/handlers/scheduled/context.ts`, which is shared by all slot runners.
When a lease cannot be acquired, the run is skipped (non-fatal) and recorded as `status='skipped_locked'` in `cron_runs`.

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
**Schedule:** `10,40 * * * *` (every 30 min, shared with dex-liquidity and yield-data)
**Data source:** `https://stablecoins.llama.fi/stablecoincharts/all`

**Algorithm:**

1. Fetch full chart history from DefiLlama (single GET request)
2. Validate: must receive array with ≥100 data points
3. FX rate corruption fix:
   - Read cached FX rates from the `fx-rates` cache key
   - For each chart point, validate implied FX rate: `totalCirculatingUSD[key] / totalCirculating[key]`
   - If rate falls outside tolerance band (`fxRate / RATE_TOLERANCE` to `fxRate * RATE_TOLERANCE`), recompute the USD value using the correct FX rate
   - `RATE_TOLERANCE = 3` (accepts 1/3× to 3× of expected rate)
4. Downsample to adaptive time buckets:
   - Last 90 days: daily (86,400s intervals)
   - 90 days to 2 years: weekly (604,800s intervals)
   - Older than 2 years: monthly (2,592,000s intervals)
5. Write to cache via `setCacheIfNewer()` (CAS — won't overwrite newer data)

**No staleness guard** — always attempts fetch on every trigger.

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

### sync-live-reserves

**File:** `worker/src/cron/sync-live-reserves.ts`
**Schedule:** `11 * * * *` (hourly at :11 UTC)
**Data source:** Protocol-specific reserve APIs and on-chain vault/accounting reads via adapter registry (`worker/src/cron/reserve-adapters/`)

**Purpose:** Syncs live reserve composition from protocol data APIs into the `reserve_composition` D1 table and records per-coin operational state in `reserve_sync_state`. Each coin with `liveReservesConfig` declares an adapter, semantics, source inputs, and optional breaker scope. The cron iterates configured coins sequentially, applies per-source circuit breaker logic, reuses exact duplicate HTTP source configs within a run, and persists both successful snapshots and failed/degraded sync state. For the full adapter/config/API contract, see [live-reserves.md](./live-reserves.md).

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
| `collateral-positions-api` | `zchf-frankencoin`, `deuro-deuro`                                        | `inputs.primary.kind = "http-json"` -> official ecosystem collateral-position APIs + official price mapping endpoints                                                                                                                                                                                                                                                                                             |
| `crvusd`                   | `crvusd-curve`                                                           | `inputs.primary.kind = "http-json"` -> `https://prices.curve.finance/v1/crvusd/markets`                                                                                                                                                                                                                                                                                                                           |
| `ethena`                   | `usde-ethena`                                                            | `inputs.primary.kind = "http-json"` -> `https://app.ethena.fi/api/positions/current/collateral`                                                                                                                                                                                                                                                                                                                   |
| `chainlink-nav`            | `usdy-ondo-finance`, `ustb-superstate`, `mtbill-midas`                   | `inputs.primary.kind = "onchain-evm"` -> Chainlink NAV feed oracle `latestRoundData()` via Etherscan proxy RPC                                                                                                                                                                                                                                                                                                   |
| `chainlink-por`            | `fdusd-first-digital`                                                    | `inputs.primary.kind = "onchain-evm"` -> Chainlink Proof-of-Reserve feed `latestRoundData()` via Etherscan proxy RPC                                                                                                                                                                                                                                                                                             |
| `circle-transparency`      | `usdc-circle`, `eurc-circle`                                             | `inputs.primary.kind = "http-html"` -> `https://www.circle.com/transparency` (server-rendered HTML reserve data)                                                                                                                                                                                                                                                                                                 |
| `frax`                     | `frax-frax`                                                              | `inputs.primary.kind = "http-json"` -> `https://api.frax.finance/combineddata/`                                                                                                                                                                                                                                                                                                                                  |
| `gho`                      | `gho-aave`                                                               | `inputs.primary.kind = "onchain-evm"` -> Ethereum facilitator bucket `eth_call` reads (capacity, minted amounts) via Etherscan proxy RPC                                                                                                                                                                                                                                                                         |
| `sky-makercore`            | `usds-sky`, `dai-makerdao`                                               | `inputs.primary.kind = "http-json"` -> `https://api.llama.fi/protocol/makerdao` (DefiLlama protocol TVL breakdown)                                                                                                                                                                                                                                                                                               |
| `tether`                   | `usdt-tether`                                                            | `inputs.primary.kind = "http-json"` -> `https://app.tether.to/transparency.json`                                                                                                                                                                                                                                                                                                                                 |

### sync-redemption-backstops

**File:** `worker/src/cron/sync-redemption-backstops.ts`  
**Schedule:** `11 * * * *` (hourly at :11 UTC, immediately after `sync-live-reserves`)  
**Data source:** Stablecoins cache, DEX liquidity snapshot, redemption-backstop config registry, and live reserve-sync metadata where available

**Purpose:** Builds the current `redemption_backstop` dataset for redeemable assets and writes daily rows to `redemption_backstop_history`. This sync is deliberately separate from report-card generation so redeemability remains a first-class worker dataset with its own cron visibility, API surface, and methodology versioning.

Current dynamic reserve-metadata support is used for `iusd-infinifi`, whose immediate redeemable capacity is derived from the live reserve lane’s standardized metadata (`immediateRedeemableUsd`, `immediateRedeemableRatio`). Other covered assets currently use conservative modelled capacity rules such as full-supply redeemability or configured liquid-buffer ratios, depending on route family.
| `falcon` | `usdf-falcon` | `inputs.primary.kind = "http-json"` -> `https://api.falcon.finance/api/v1/transparency` |
| `infinifi` | `iusd-infinifi` | `inputs.primary.kind = "http-json"` -> `https://eth-api.infinifi.xyz/api/protocol/data` |
| `m0` | `m-m0`, `musd-metamask`, `usdn-noble` | `inputs.primary.kind = "http-json"` -> `https://protocol-api.m0.org/graphql` (`CollateralCurrent`) |
| `mento` | `cusd-celo`, `ceur-celo` | `inputs.primary.kind = "http-html"` -> `https://reserve.mento.org/` (server-rendered `reserveComposition`) |
| `evm-branch-balances` | `bold-liquity`, `usnd-nerite` | `inputs.primary.kind = "onchain-evm"` -> branch `ActivePool` ERC-20 balances + DefiLlama prices |
| `openeden-usdo` | `usdo-openeden` | `inputs.primary.kind = "http-json"` -> `https://prod-gw.openeden.com/usdo/sys/reserve-composition-last` |
| `reservoir` | `wsrusd-reservoir` | `inputs.primary.kind = "http-json"` -> `https://app.reservoir.xyz/api/reserves/raw` |
| `erc4626-single-asset` | `syrupusdc-maple`, `syrupusdt-maple` | `inputs.primary.kind = "onchain-evm"` -> Ethereum `totalAssets()` / `asset()` calls against the vault contract |
| `fx` | `fxusd-f-x-protocol` | `inputs.primary.kind = "http-json"` -> `https://api.aladdin.club/api1/get_fx_tvl` (`data.poolInfo`) |
| `single-asset` | `lusd-liquity`, `meusd-mezo`, `feusd-felix` | `inputs.primary.kind = "onchain-evm"` or `http-json` -> single-asset probe with fixed 100% composition |

**Operational behavior:**

- Circuit breakers are keyed per source identity (`live-reserves:<scope>`), not as one global `live-reserves` source. Exact duplicates that intentionally share one upstream payload, such as the M0 GraphQL feed or the Mento reserve page, can share a breaker scope and one fetched result inside a run. Distinct URLs should not share a breaker scope.
- The cron writes `reserve_sync_state` on every path, including degraded/error/skipped outcomes.
- Successful snapshots write `reserve_composition` and `reserve_sync_state` together in one D1 batch, and downstream readers ignore orphaned composition rows that do not have a matching successful sync state.
- Adapter warnings are reserved for unresolved material mapping drift. Known Ethena alt-collateral that is intentionally bucketed into `Other crypto collateral` does not emit warnings, and infiniFi dust farms that round to `0%` in the displayed mix do not keep the cron degraded.
- Cron result status is explicit:
  - `ok` when all configured coins sync cleanly
  - `degraded` when any sync fails, is skipped, or returns warnings
  - `error` when no configured coin syncs successfully

**Adding a new adapter:** Create `worker/src/cron/reserve-adapters/<protocol>.ts`, register it in `index.ts`, and add a structured `liveReservesConfig` to the coin metadata. The cron, reserve API, status surface, and detail-page fallback logic all consume that config.

### sync-bluechip

**File:** `worker/src/cron/sync-bluechip.ts`
**Schedule:** `5 8 * * *` (daily at 08:05 UTC)
**Data source:** `https://backend.bluechip.org/coin-data/{slug}`

**Purpose:** Fetches safety ratings from bluechip.org for 19 tracked stablecoins.

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
2. Fetch ratings for all 19 slugs in `BLUECHIP_SLUG_MAP` (file: `worker/src/lib/bluechip-slugs.ts`)
   - Processed in batches of 3, with 500ms delay between batches
   - Each request uses `fetchWithRetry()` with `maxRetries: 2`
3. For each response, extract:
   - `grade` (A+ through F)
   - `collateralization` (percentage)
   - `smartContractAudit` (boolean)
   - `dateOfRating`, `dateLastChange`
   - `smidge`: 6 category summaries (stability, management, implementation, decentralization, governance, externals) — HTML stripped via regex
4. If zero ratings fetched: preserve existing cache, don't overwrite
5. Store `Record<string, BluechipRating>` (keyed by canonical Pharos ID) via `setCacheIfNewer()`

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

Returns raw and effective status, recent `cron_runs`, active `cron_run_progress` rows, data-quality metrics, state-machine metadata, synthetic probe summary, and transition timeline. Tracks 25 cron jobs across 10 triggers via `CRON_INTERVALS` in `shared/lib/cron-jobs.ts`:

| Job                             | Interval       | Trigger                                     |
| ------------------------------- | -------------- | ------------------------------------------- |
| `sync-stablecoins`              | 900s (15min)   | `*/15 * * * *`                              |
| `sync-stablecoin-charts`        | 1,800s (30min) | `10,40 * * * *`                             |
| `sync-fx-rates`                 | 900s (15min)   | `*/15 * * * *`                              |
| `stability-index`               | 900s (15min)   | `*/15 * * * *`                              |
| `compute-dews`                  | 900s (15min)   | `*/15 * * * *`                              |
| `status-self-check`             | 900s (15min)   | `*/15 * * * *`                              |
| `dispatch-telegram-alerts`      | 300s (5min)    | `2,7,12,17,22,27,32,37,42,47,52,57 * * * *` |
| `sync-blacklist`                | 1,200s (20min) | `3,23,43 * * * *`                           |
| `sync-mint-burn`                | 1,200s (20min) | `4,24,44 * * * *`                           |
| `sync-dex-discovery`            | 1,800s (30min) | `6,36 * * * *`                              |
| `sync-mint-burn-extended`       | 1,200s (20min) | `13,33,53 * * * *`                          |
| `sync-dex-liquidity`            | 1,800s (30min) | `10,40 * * * *`                             |
| `sync-yield-data`               | 1,800s (30min) | `10,40 * * * *`                             |
| `snapshot-supply`               | 86,400s (24h)  | `*/15 * * * *` (primary) / `0 8 * * *` (fallback) |
| `snapshot-chain-supply`         | 86,400s (24h)  | `*/15 * * * *`                              |
| `snapshot-safety-grade-history` | 86,400s (24h)  | `0 8 * * *`                                 |
| `fetch-tbill-rate`              | 86,400s (24h)  | `0 8 * * *`                                 |
| `snapshot-psi`                  | 86,400s (24h)  | `0 8 * * *`                                 |
| `sync-usds-status`              | 86,400s (24h)  | `0 8 * * *`                                 |
| `sync-live-reserves`            | 3,600s (1h)    | `11 * * * *`                                |
| `sync-redemption-backstops`     | 3,600s (1h)    | `11 * * * *`                                |
| `sync-bluechip`                 | 86,400s (24h)  | `5 8 * * *`                                 |
| `daily-digest`                  | 86,400s (24h)  | `5 8 * * *`                                 |
| `weekly-recap`                  | 604,800s (7d)  | `5 8 * * *`                                 |
| `discovery-scan`                | 86,400s (24h)  | `5 8 * * *`                                 |

A job is marked "unhealthy" if its last run had `status='error'` or if the last run started more than 2× its expected interval ago. `/api/status` now also exposes `crons[*].inFlight` while a long-running leased job is active, including `stage`, `itemsDone/itemsTotal`, the last heartbeat timestamp, and a `stale` flag when the active-progress row stops updating.

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
| `worker/src/handlers/http.ts`                      | HTTP request pipeline: CORS, method gating, edge cache, route-context assembly, router dispatch                                                                     |
| `worker/src/handlers/scheduled.ts`                 | Thin cron entrypoint: env-aware init + cron-expression-to-slot-runner dispatch                                                                                      |
| `worker/src/handlers/scheduled/context.ts`         | Shared scheduled runtime context: lease-aware `runLeasedCron`, slot config, stablecoins capability parsing                                                          |
| `worker/src/handlers/scheduled/*.ts`               | Per-trigger slot runners (quarter-hourly, isolated 20-minute lanes, half-hourly including DEX discovery, hourly reserve sync, Telegram, and daily slots)             |
| `worker/src/lib/env.ts`                            | Worker Env interface + `parseCsvEnv()` helper for CSV-based runtime overrides                                                                                       |
| `worker/wrangler.toml`                             | Deployment config: custom domain, cron triggers, D1 binding, vars                                                                                                   |
| `worker/src/lib/db.ts`                             | Database helpers: `batchExecute`, block tracking                                                                                                                    |
| `worker/src/lib/db-cache.ts`                       | Cache CRUD: `getCache`, `setCache`, `setCacheIfNewer`, `getPriceCache`, `savePriceCache`                                                                            |
| `worker/src/lib/cron-logger.ts`                    | `logCronRun` wrapper and `CronResult` type                                                                                                                          |
| `worker/src/lib/cron-lease.ts`                     | Cron lease primitives: `acquireCronLease`, `runCronWithLease`, `CRON_TIMEOUT_MS`                                                                                    |
| `worker/src/lib/auth.ts`                           | Admin auth: `ops-api` Access/service-token signal validation                                                                                                        |
| `worker/src/lib/alerts.ts`                         | Webhook alerts: auto-detects Discord/Slack format                                                                                                                   |
| `worker/src/lib/constants.ts`                      | Shared constants: API URLs, thresholds, cache profiles                                                                                                              |
| `shared/lib/cron-jobs.ts`                          | Shared cron expressions, per-job intervals, `CRON_INTERVALS`, and status-page grouping/trigger metadata                                                             |
| `shared/lib/status-thresholds.ts`                  | Shared status threshold constants for frontend + worker data-quality/status bands                                                                                   |
| `worker/src/lib/blacklist-gaps.ts`                 | Shared blacklist gap query helper (Tron null-amount exclusion + recent window)                                                                                      |
| `worker/src/lib/chain-registry.ts`                 | Unified chain mappings + chain RPC configs: Alchemy/dRPC/public fallback for 11 chains                                                                              |
| `worker/src/lib/coingecko.ts`                      | CoinGecko init: free/pro URL switching, auth headers                                                                                                                |
| `worker/src/lib/bluechip-slugs.ts`                 | Bluechip slug → canonical Pharos ID mapping (19 coins)                                                                                                              |
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
| `worker/src/cron/sync-usds-status.ts`              | USDS freeze monitor: ERC-1967 proxy inspection                                                                                                                      |
| `worker/src/cron/sync-bluechip.ts`                 | Bluechip ratings: batch fetch from bluechip.org                                                                                                                     |
| `worker/src/cron/snapshot-safety-grade-history.ts` | Daily Safety Score grade history snapshot writer (seed + grade-change events)                                                                                       |
| `worker/src/cron/status-self-check.ts`             | Status reliability self-check: default-origin internal router probes, external `SELF_URL` HTTP probes, hysteresis persistence, discrepancy + probe-failure alerting |
| `worker/src/lib/status-reliability.ts`             | Status state machine + transition/probe/discrepancy persistence helpers                                                                                             |
| `worker/migrations/0001_initial.sql`               | `cache`, `blacklist_events`, `blacklist_sync_state` tables                                                                                                          |

---

### Migration Squash Strategy

Currently at 69 D1 migrations. When the count approaches ~150, perform a one-time squash:

1. Export current schema: `wrangler d1 export stablecoin-db --remote --output=baseline.sql`
2. Replace all migration files with a single `0001_baseline.sql`
3. Reset D1's internal migration tracking
4. Verify with a fresh `wrangler d1 migrations apply --remote`

See also `docs/MANIFEST.md` for the rollback runbook.
