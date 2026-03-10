# Worker Infrastructure

Cloudflare Worker serving the Pharos API. Handles HTTP routing, edge caching, CORS, admin auth, and 21 named runtime jobs across 9 trigger slots.

Execution note: the `snapshot-supply` retry path runs on the `*/15 * * * *` trigger only after a downstream-safe `sync-stablecoins` cache write.

**Deployed at:** `api.pharos.watch` (custom domain via `wrangler.toml`)

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

The `Env` interface is defined in `worker/src/lib/env.ts` and consumed by `worker/src/index.ts` plus `worker/src/handlers/http.ts` and `worker/src/handlers/scheduled.ts`. `DB` and `CORS_ORIGIN` are set in `wrangler.toml`; remaining bindings are runtime env values (typically provided via `wrangler secret put`).

| Binding | Type | Required | Used by |
|---------|------|----------|---------|
| `DB` | D1Database | Yes | All crons and API handlers |
| `CORS_ORIGIN` | string | Yes | CORS headers (`https://pharos.watch`) |
| `SELF_URL` | string | No | Status self-check external probe base URL; the default production origin (`https://api.pharos.watch`) is router-probed internally to avoid custom-domain self-fetch `522`s |
| `ETHERSCAN_API_KEY` | string | No | Blacklist sync, USDS status |
| `TRONGRID_API_KEY` | string | No | Blacklist sync (Tron chain) |
| `DRPC_API_KEY` | string | No | L2 archive node balance lookups |
| `ALCHEMY_API_KEY` | string | No | Chain RPC primary endpoints |
| `ADMIN_KEY` | string | No | Admin endpoint auth |
| `GRAPH_API_KEY` | string | No | DEX liquidity (The Graph subgraphs) |
| `ALERT_WEBHOOK_URL` | string | No | Discord/Slack error alerts |
| `ANTHROPIC_API_KEY` | string | No | Daily digest LLM generation |
| `CMC_API_KEY` | string | No | Price fallback (CoinMarketCap) |
| `COINGECKO_API_KEY` | string | No | Price enrichment, depeg confirmation |
| `GITHUB_PAT` | string | No | Feedback → GitHub Issues/Discussions |
| `GITHUB_REPO_NODE_ID` | string | No | Feature request → GitHub Discussions |
| `GITHUB_DISCUSSION_CATEGORY_ID` | string | No | Discussion category routing |
| `FEEDBACK_IP_SALT` | string | Yes (for feedback) | Rate limit IP hashing for `POST /api/feedback` |
| `TWITTER_API_KEY` | string | No | Digest → Twitter (OAuth consumer key) |
| `TWITTER_API_SECRET` | string | No | Digest → Twitter (OAuth consumer secret) |
| `TWITTER_ACCESS_TOKEN` | string | No | Digest → Twitter (access token) |
| `TWITTER_ACCESS_TOKEN_SECRET` | string | No | Digest → Twitter (access token secret) |
| `TELEGRAM_BOT_TOKEN` | string | No | Digest → Telegram, bot chat replies, subscriber alert dispatch |
| `TELEGRAM_CHAT_ID` | string | No | Digest → Telegram |
| `TELEGRAM_WEBHOOK_SECRET` | string | No | Random string for webhook URL validation (set via `wrangler secret put`) |
| `MAINTENANCE_MODE` | `string?` | No | Optional. When set to the exact string `"true"`, the worker returns 503 for all requests. Used as a kill switch. |
| `MINT_BURN_DISABLED_IDS` | string | No | Mint/burn runtime disable list by stablecoin ID (CSV) |
| `MINT_BURN_DISABLED_SYMBOLS` | string | No | Mint/burn runtime disable list by symbol (CSV) |
| `MINT_BURN_MAJOR_SYMBOLS` | string | No | Mint/burn health-check major symbols override (CSV) |
| `MINT_BURN_STALE_WARN_SEC` | string | No | Mint/burn stale-warning threshold override (seconds) |
| `MINT_BURN_STALE_CRIT_SEC` | string | No | Mint/burn stale-critical threshold override (seconds) |
| `MINT_BURN_ALERT_COOLDOWN_SEC` | string | No | Mint/burn stale alert dedupe cooldown override (seconds) |

---

## Module Initialization

Three modules use a lazy-init pattern to receive API keys from the `Env` at runtime. Called at the top of both runtime handler modules (`worker/src/handlers/http.ts` and `worker/src/handlers/scheduled.ts`):

| Initializer | Called in | Purpose |
|-------------|----------|---------|
| `initCoinGecko(env.COINGECKO_API_KEY)` | `fetch` + `scheduled` | Switches CoinGecko base URL between free/pro tier |
| `initChainRpcs(env.ALCHEMY_API_KEY, env.DRPC_API_KEY)` | `fetch` + `scheduled` | Builds chain RPC configs with Alchemy/dRPC primaries |
| `initAlerts(env.ALERT_WEBHOOK_URL)` | `fetch` + `scheduled` | Configures webhook URL for error alerts |

This pattern exists because `Env` bindings are only available inside handler functions (not at module initialization time). Worker isolates may be reused, but env-aware setup must still happen inside request/scheduled handlers.

---

## HTTP Request Handling

### Method Routing

| Method | Handling |
|--------|----------|
| `OPTIONS` | Returns 204 with CORS headers (preflight) |
| `POST` | `/api/feedback` and mutating admin endpoints from `shared/lib/api-endpoints.ts` |
| `GET` | Read endpoints + admin debug routes; mutating admin routes return 405 except `/api/audit-depeg-history?dry-run=true` |
| Other | Returns 405 `{ error: "Method not allowed" }` |

Method/path flags (`mutatingAdmin`, `cacheBypass`, probe groups, status actions) are centralized in `shared/lib/api-endpoints.ts` and consumed by both worker and frontend status tooling.

### Public API Rate Limiting

- `worker/src/handlers/http.ts` applies a best-effort per-IP in-memory limiter for non-admin requests before router dispatch.
- Default threshold: `60 requests / 60 seconds` per IP (isolate-local, not globally shared across all isolates/PoPs).
- Admin requests authenticated with `X-Admin-Key` bypass this limiter.

### CORS Headers

Applied to every response via `addCorsHeaders()`:

| Header | Value |
|--------|-------|
| `Access-Control-Allow-Origin` | `CORS_ORIGIN` env var (static: `https://pharos.watch`) |
| `Access-Control-Allow-Methods` | `GET, POST, OPTIONS` |
| `Access-Control-Allow-Headers` | `Content-Type, X-Admin-Key, Idempotency-Key` |
| `Access-Control-Expose-Headers` | `X-Data-Age, Warning` |
| `Access-Control-Max-Age` | `86400` |
| `X-Content-Type-Options` | `nosniff` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Content-Security-Policy` | `default-src 'none'; frame-ancestors 'none'` |

### Edge Cache Strategy

The Worker uses `caches.default` (Cloudflare's per-colo edge cache) to cache GET responses:

1. **Cache bypass rules**:
   - All non-GET requests bypass edge cache.
   - GET paths marked `cacheBypass: true` in `shared/lib/api-endpoints.ts` bypass edge cache (health, status, and admin/backfill endpoints like `/api/backfill-*`, `/api/audit-depeg-history`, `/api/backfill-dews`).

2. **Cache check:** `caches.default.match(cacheKey)` — returns cached response if available

3. **Cache store:** `ctx.waitUntil(cache.put(cacheKey, response.clone()))` — the response is cloned **without** CORS headers before caching. CORS headers are added per-request after cache lookup to avoid caching origin-specific headers.

4. **Cache-Control profiles** (set by individual API handlers):

| Profile | `Cache-Control` header | Used by |
|---------|----------------------|---------|
| Realtime | `public, s-maxage=60, max-age=10` | stablecoins, stablecoin-summary, blacklist, depeg-events, peg-summary, mint-burn-events |
| Standard | `public, s-maxage=300, max-age=60` | stablecoin-charts, dex-liquidity, usds-status, daily-digest, digest-archive, report-cards, stability-index, yield-rankings, mint-burn-flows, stress-signals |
| Slow | `public, s-maxage=3600, max-age=300` | supply-history, bluechip-ratings, dex-liquidity-history, yield-history, safety-score-history, digest-snapshot |

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

- Reads `X-Admin-Key` header from request
- Compares against `ADMIN_KEY` env var using timing-safe comparison: both values are SHA-256 hashed via `crypto.subtle.digest()`, then compared with `crypto.subtle.timingSafeEqual()`
- Returns `null` if authorized, 401 Response if not

### Router-Dispatched Status Actions

Status page manual/admin actions are dispatched through `worker/src/router.ts` using shared endpoint definitions (`shared/lib/api-endpoints.ts`). Examples:

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /api/trigger-digest` | `X-Admin-Key` | Force-regenerates digest with `force=true`, posts to Twitter + Telegram |
| `POST /api/reset-blacklist-sync` | `X-Admin-Key` | Rolls back sync state: EVM −50,000 blocks, Tron −7 days |
| `GET /api/debug-sync-state` | `X-Admin-Key` | Returns all `blacklist_sync_state` rows |

Additional backfill/audit actions are defined in the same registry and surfaced dynamically on `/status`. `POST /api/feedback` is router-dispatched too, but it is not part of the status action registry.

### Backfill Query Helper

**File:** `worker/src/lib/backfill-query.ts`

Backfill handlers reuse shared parsing/selection helpers for `stablecoin`, `batch`, and `batchSize` query params:
- `selectBackfillCoins(...)` resolves single-coin mode (`?stablecoin=<id>`) vs batched mode (`?batch=<n>[&batchSize=<n>]`) with bounded integer parsing.
- `noCoinsInBatchResponse()` returns the canonical no-op payload `{ "message": "No coins in this batch" }`.

Current consumers:
- `worker/src/api/backfill-cg-prices.ts`
- `worker/src/api/backfill-supply-history.ts`
- `worker/src/api/backfill-depegs.ts`

---

## Cron Scheduling

This worker declares 9 cron expressions in `worker/wrangler.toml`. The paid Workers plan allows up to 250 cron triggers. Fetch-heavy jobs (blacklist, mint/burn, DEX discovery, stablecoin charts) and Telegram alerts each run on dedicated triggers to get independent 6-connection pools and CPU budgets.

### wrangler.toml Triggers

```toml
[triggers]
crons = [
  "*/15 * * * *",
  "3,23,43 * * * *",
  "4,24,44 * * * *",
  "6,26,46 * * * *",
  "13,33,53 * * * *",
  "10,40 * * * *",
  "2,7,12,17,22,27,32,37,42,47,52,57 * * * *",
  "0 8 * * *",
  "5 8 * * *",
]
```

### Trigger 1: `*/15 * * * *` (every 15 minutes)

| Job | Function | File | Documentation |
|-----|----------|------|---------------|
| `sync-stablecoins` | `syncStablecoins()` | `worker/src/cron/sync-stablecoins.ts` | `docs/data-pipeline.md`, `docs/depeg-detection.md` |
| `snapshot-supply` *(retry path)* | `snapshotSupply()` (chained after `sync-stablecoins`) | `worker/src/cron/snapshot-supply.ts` | `docs/supply-snapshot.md` |
| `sync-fx-rates` | `syncFxRates()` | `worker/src/cron/sync-fx-rates.ts` | `docs/data-pipeline.md`, `docs/classification.md` |
| `stability-index` | `computeAndStoreStabilityIndex()` | `worker/src/cron/stability-index.ts` | `docs/stability-index.md` |
| `compute-dews` | `computeAndStoreDEWS()` | `worker/src/cron/compute-dews.ts` | `docs/dews.md` |
| `status-self-check` | `runStatusSelfCheck()` | `worker/src/cron/status-self-check.ts` | `docs/status-dashboard.md` |
| *(inline)* | Stale-cache health alert | `worker/src/handlers/scheduled.ts` | This doc (below) |

**Execution model:** Jobs in this slot are run sequentially in `worker/src/handlers/scheduled.ts` to respect the Workers shared 6-connection fetch pool per cron trigger. `sync-stablecoins` now reports explicit capability metadata:

- `capabilities.stablecoinsCache`
- `capabilities.depegPipeline`

`snapshot-supply` retry and `compute-dews` require the stablecoins-cache capability. `stability-index` additionally requires the depeg-pipeline capability, which prevents depeg-stage regressions from propagating as fresh PSI state.

**Inline staleness alert:** After sync-stablecoins completes, if the `stablecoins` cache is older than 1800 seconds (30 min), `sendAlert()` fires a webhook notification. This is a health check — not a cron job itself.

### Trigger 2: `3,23,43 * * * *` (blacklist — dedicated)

| Job | Function | File | Documentation |
|-----|----------|------|---------------|
| `sync-blacklist` | `syncBlacklist()` | `worker/src/cron/sync-blacklist.ts` | `docs/blacklist-tracker.md` |

Dedicated trigger for blacklist sync. Uses Etherscan for supported chains, chain RPC log scans (Alchemy/public fallback) for Base/Optimism/Avalanche/BSC, dRPC for historical L2 balance reads, and TronGrid for Tron. Gets its own 6-connection pool and CPU budget.

### Trigger 3: `4,24,44 * * * *` (mint/burn critical — dedicated)

| Job | Function | File | Documentation |
|-----|----------|------|---------------|
| `sync-mint-burn` | `syncMintBurn()` critical lane | `worker/src/cron/sync-mint-burn.ts` | This doc (below) |

Dedicated trigger for the critical mint/burn lane. Uses Alchemy JSON-RPC plus the Alchemy circuit breaker. Offset by 1 minute from blacklist to stagger Worker cold starts.

### Trigger 4: `6,26,46 * * * *` (DEX discovery — dedicated)

| Job | Function | File | Documentation |
|-----|----------|------|---------------|
| `sync-dex-discovery` | `syncDexDiscovery()` | `worker/src/cron/dex-discovery/orchestrator.ts` | `docs/dex-liquidity.md` |

Dedicated trigger for DEX pool discovery. Uses strictly sequential fetches (1 connection at a time) from CoinGecko/GeckoTerminal/DexScreener. Stages pools for later merge by `sync-dex-liquidity`.

### Trigger 5: `13,33,53 * * * *` (every 20 minutes, offset at :13/:33/:53)

| Job | Function | File | Documentation |
|-----|----------|------|---------------|
| `sync-mint-burn-extended` | `syncMintBurn()` extended lane | `worker/src/cron/sync-mint-burn.ts` | This doc (below) |

This offset schedule exists so long-tail mint/burn backfill pressure cannot starve the critical lane. It uses a separate `mint_burn_run_state.job` key (`sync-mint-burn-extended`) and warning-only coverage semantics.

### Trigger 6: `10,40 * * * *` (every 30 minutes, at :10/:40)

| Job | Function | File | Documentation |
|-----|----------|------|---------------|
| `sync-stablecoin-charts` | `syncStablecoinCharts()` | `worker/src/cron/sync-stablecoin-charts.ts` | This doc (below) |
| `sync-dex-liquidity` | `syncDexLiquidity()` | `worker/src/cron/dex-liquidity/orchestrator.ts` | `docs/dex-liquidity.md` |
| `sync-yield-data` | `syncYieldData()` | `worker/src/cron/sync-yield-data.ts` + `worker/src/cron/yield-sync/*` | `docs/yield-intelligence.md` |

**Execution model:** All three jobs are chained sequentially: charts → dex-liquidity → yield-data. Charts is a single lightweight DL fetch (~2s) that completes quickly and frees the pool. `sync-yield-data` is chained after `sync-dex-liquidity` for safety-score dependencies. The slot shares the Workers 6-connection limit, so fetch-heavy additions must account for total in-slot concurrency.

`sync-dex-liquidity` metadata now tracks both row coverage and value coverage. In addition to `currentCoverage` / `previousCoverage`, the cron records `currentGlobalTvl`, `previousGlobalTvl`, top-10 covered TVL, row/value guard flags, and current/previous coverage-class distribution. `/status` surfaces this through the Liquidity Health card.

### Trigger 7: `2,7,12,17,22,27,32,37,42,47,52,57 * * * *` (Telegram alerts — dedicated, every 5 min)

| Job | Function | File | Documentation |
|-----|----------|------|---------------|
| `dispatch-telegram-alerts` | `dispatchTelegramAlerts()` | `worker/src/cron/dispatch-telegram-alerts.ts` | `docs/telegram-alerts.md` |

Dedicated trigger for Telegram subscriber alert dispatch. Isolated from the quarter-hourly pipeline so alert fan-out gets its own 6-connection pool and CPU budget. Uses up to 5 of 6 available connections for parallel `sendBatch()` sends. Up to 200 Telegram message attempts per run; overflow and retryable fresh-send failures are enqueued to `telegram_pending_alerts` in D1 for subsequent runs.

### Trigger 8: `0 8 * * *` (daily at 08:00 UTC — snapshots & lightweight fetchers)

| Job | Function | File | Documentation |
|-----|----------|------|---------------|
| `snapshot-supply` | `snapshotSupply()` | `worker/src/cron/snapshot-supply.ts` | `docs/supply-snapshot.md` |
| `snapshot-safety-grade-history` | `snapshotSafetyGradeHistory()` | `worker/src/cron/snapshot-safety-grade-history.ts` | `docs/report-cards.md` |
| `snapshot-psi` | `snapshotPsiDaily()` | `worker/src/cron/snapshot-psi.ts` | `docs/stability-index.md` |
| `sync-usds-status` | `syncUsdsStatus()` | `worker/src/cron/sync-usds-status.ts` | This doc (below) |
| `fetch-tbill-rate` | `fetchTbillRate()` | `worker/src/cron/fetch-tbill-rate.ts` | `docs/yield-intelligence.md` |

**Connection budget:** 3 snapshot jobs are D1-only (0 external connections). `fetch-tbill-rate` (FRED) and `sync-usds-status` (Etherscan) use ≤2 concurrent external connections.

### Trigger 9: `5 8 * * *` (daily at 08:05 UTC — heavy external fetchers)

| Job | Function | File | Documentation |
|-----|----------|------|---------------|
| `sync-bluechip` | `syncBluechip()` | `worker/src/cron/sync-bluechip.ts` | This doc (below) |
| `daily-digest` | `generateDailyDigest()` | `worker/src/cron/daily-digest.ts` | `docs/digest-pipeline.md` |
| `discovery-scan` | `runDiscoveryScan()` | `worker/src/cron/discovery-scan.ts` | `docs/data-pipeline.md` |

**Connection budget:** `sync-bluechip` (3 parallel batch connections), `daily-digest` (1 long-lived Anthropic API call), and `discovery-scan` (1 CoinGecko call) use ≤5 concurrent external connections. The 5-minute offset from Trigger 8 ensures PSI snapshot data is available for the daily digest without an explicit chain dependency.

## Telegram Alert Bot

- Webhook ingress (`POST /api/telegram-webhook`) receives Telegram commands and writes subscriber/subscription state into D1.
- `dispatch-telegram-alerts` diffs DEWS/depeg/safety state against cached snapshots before fan-out on a dedicated 5-minute cron slot.
- Telegram sends are gated by the `telegram-api` circuit breaker to avoid hammering the Bot API during upstream issues.
- Each dispatch run sends up to 200 Telegram message attempts in parallel batches of 5. Overflow and retryable fresh-send failures are enqueued to `telegram_pending_alerts` for subsequent runs.
- Subscriber state now supports quiet hours plus per-subscription controls such as `dews_min_band`, `safety_mode`, and `depeg_worsening_bps_step`.

See `docs/telegram-alerts.md` for command syntax, D1 tables, snapshot seeding behavior, and operational setup.

### Sub-Modules (not directly registered)

These files are called internally by `syncStablecoins()`, not registered as standalone cron jobs:

| File | Called from | Documentation |
|------|-------------|---------------|
| `worker/src/cron/detect-depegs.ts` | `syncStablecoins()` | `docs/depeg-detection.md` |
| `worker/src/cron/confirm-pending-depegs.ts` | `syncStablecoins()` | `docs/depeg-detection.md` |
| `worker/src/cron/enrich-prices.ts` | `syncStablecoins()` | `docs/data-pipeline.md` |
| `worker/src/cron/sync-stablecoins/supplemental-assets.ts` | `syncStablecoins()` | `docs/data-pipeline.md` |

---

## logCronRun() Wrapper

**File:** `worker/src/lib/db.ts`

Every cron job is wrapped with `runCronWithLease(...)` + `logCronRun(...)`:

`ctx.waitUntil(logCronRun(db, "job-name", (signal, reportProgress) => runCronWithLease(db, "job-name", async () => fn(db, signal, reportProgress))))`

```typescript
async function logCronRun(
  db: D1Database,
  job: string,
  fn: (signal: AbortSignal, reportProgress: CronProgressReporter) => Promise<CronResult | void>
): Promise<void>
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

| Job | Timeout | Reason |
|-----|---------|--------|
| Default | 5 min | Standard jobs complete in <60s |
| `sync-dex-liquidity` | 13 min | 150+ pool crawl, with headroom below the platform wall-clock limit |
| `sync-dex-discovery` | 16 min | Multi-source pool staging; isolated trigger allows extended runtime |
| `sync-blacklist` | 12 min | Multi-chain scan + balance enrichment; isolated trigger allows extended runtime |
| `sync-mint-burn` | 10 min | Multi-contract EVM log scan; isolated trigger allows extended runtime |
| `sync-mint-burn-extended` | 10 min | Long-tail mint/burn lane with its own run-state |
| `daily-digest` | 8 min | LLM generation + distribution |

Configuration: `CRON_TIMEOUT_MS` record in `worker/src/lib/db.ts`.

### Circuit Breakers

All external data sources are protected by per-source circuit breakers (`worker/src/lib/circuit-breaker.ts`). State is persisted in the D1 `cache` table under keys like `circuit:defillama-stablecoins`.

- **Open threshold**: 3 consecutive failures
- **Probe interval**: 30 minutes (one request allowed to test recovery)
- **Alerts**: Webhook alert fires on open and close transitions
- **Health impact**: Any open circuit triggers `degraded` status on `/api/health`

Sources tracked (defined in `CIRCUIT_SOURCE` in `worker/src/lib/constants.ts`):

| Source key | Cache key | Used by |
|-----------|-----------|---------|
| `DL_STABLECOINS` | `defillama-stablecoins` | `sync-stablecoins` |
| `DL_STABLECOIN_DETAIL` | `defillama-stablecoin-detail` | `GET /api/stablecoin/:id` (DefiLlama detail upstream) |
| `DL_COINS` | `defillama-coins` | `enrich-prices` |
| `DL_YIELDS` | `defillama-yields` | `sync-yield-data`, `sync-dex-liquidity` |
| `DL_PROTOCOLS` | `defillama-protocols` | `sync-dex-liquidity` |
| `CG_PRICES` | `coingecko-prices` | `enrich-prices` |
| `CG_DETAIL_PLATFORMS` | `coingecko-detail-platforms` | `GET /api/stablecoin/:id` (CoinGecko-only detail provider) |
| `CG_MCAP` | `coingecko-mcap` | `sync-stablecoins` (CG supply fallback) |
| `CMC_PRICES` | `coinmarketcap-prices` | `enrich-prices` pass 3.5 fallback |
| `DEXSCREENER_PRICES` | `dexscreener-prices` | `enrich-prices` pass 4 fallback |
| `TREASURY_RATES` | `treasury-rates` | `fetch-tbill-rate` |
| `ETHERSCAN` | `etherscan` | `sync-blacklist` |
| `ALCHEMY` | `alchemy` | `sync-mint-burn` |
| `TWITTER_API` | `twitter-api` | `daily-digest` social posting |
| `TELEGRAM_API` | `telegram-api` | `daily-digest` social posting, `dispatch-telegram-alerts` subscriber fan-out |

---

## Alert System

**File:** `worker/src/lib/alerts.ts`

```typescript
export function initAlerts(url: string | undefined): void
export async function sendAlert(title: string, message: string): Promise<boolean>
```

Auto-detects webhook format from URL:

| URL contains | Format |
|-------------|--------|
| `discord.com/api/webhooks` | Discord embed (red, `[Pharos] {title}`, timestamp) |
| Anything else | Slack markdown (`*[Pharos] {title}*\n{message}`) |

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

| Cache Key | Writer | Data |
|-----------|--------|------|
| `stablecoins` | `syncStablecoins` | Full DefiLlama pegged assets payload |
| `stablecoins:invalid-last` | `syncStablecoins` | Last schema-invalid stablecoins payload (diagnostic only, never served to clients) |
| `stablecoin-charts` | `syncStablecoinCharts` | Downsampled chart points |
| `fx-rates` | `syncFxRates` | FX rates (EUR, GBP, etc.) |
| `usds-status` | `syncUsdsStatus` | Freeze capability + implementation address |
| `bluechip-ratings` | `syncBluechip` | Ratings map keyed by canonical Pharos ID |
| `yield-rankings` | `syncYieldData` | Pre-computed yield rankings + PYS scores |
| `risk_free_rate` | `fetchTbillRate` | Current T-bill rate for PYS computation |

**Cache access helpers:**

| Function | Description |
|----------|-------------|
| `getCache(db, key)` | Returns `{ value, updatedAt }` or `null` |
| `setCache(db, key, value)` | `INSERT OR REPLACE` with current timestamp |
| `setCacheIfNewer(db, key, value, syncStartSec)` | Compare-and-swap: only writes if existing `updated_at <= syncStartSec`. Prevents slow cron runs from overwriting newer data. |

### Batch Execution

```typescript
async function batchExecute(
  db: D1Database,
  stmts: D1PreparedStatement[],
  chunkSize = 100  // D1_BATCH_SIZE
): Promise<void>
```

Chunks statements into batches of 100 (D1's batch limit) and executes sequentially.

### Cron Lease Primitives (Phase C)

Lease primitives are implemented in `worker/src/lib/db.ts` and backed by migration `0034_cron_leases.sql`.
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

| Function | Description |
|----------|-------------|
| `acquireCronLease(db, job, owner, ttlSec)` | Acquires lease for a job, or takes over when expired. Returns `true` on success, `false` if another active owner holds the lease. |
| `renewCronLease(db, job, owner, ttlSec)` | Extends `lease_until` for the current owner. Returns `false` if ownership was lost. |
| `releaseCronLease(db, job, owner)` | Deletes lease row only when caller still owns it. |
| `runCronWithLease(db, job, fn, opts)` | Wrapper primitive: acquire → heartbeat renewals → run fn → release; returns `ok` or `skipped_locked` with metadata. |

Default behavior in `runCronWithLease`:
- Lease TTL defaults to `jobTimeout + 60s`
- Heartbeat defaults to `max(15s, ttl/3)`
- Owner defaults to `crypto.randomUUID()` when available

### Lease Integration Status

Lease primitives are now wired into scheduled cron execution in `worker/src/handlers/scheduled.ts` for all cron jobs.
When a lease cannot be acquired, the run is skipped (non-fatal) and recorded as `status='skipped_locked'` in `cron_runs`.

### Block Tracking (Blacklist)

| Function | Description |
|----------|-------------|
| `getLastBlock(db, configKey)` | Returns last processed block/timestamp, or 0 |
| `setLastBlock(db, configKey, block)` | `INSERT OR REPLACE` into `blacklist_sync_state` |

### Price Cache

| Function | Description |
|----------|-------------|
| `getPriceCache(db)` | Returns `Map<assetId, { price, updatedAt }>` from `price_cache` table |
| `savePriceCache(db, entries)` | Batch upsert into `price_cache` |

---

## Undocumented Cron Details

The three crons below were previously only listed by filename in `docs/architecture.md`. Their full algorithms are documented here.

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

| Constant | Value |
|----------|-------|
| `USDS_PROXY` | `0xdC035D45d973E3EC169d2276DDab16f1e407384F` |
| `IMPL_SLOT` | `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc` (ERC-1967) |
| `NO_FREEZE_IMPL` | `0x1923dfee706a8e78157416c29cbccfde7cdf4102` |
| `IS_BLOCKED_SELECTOR` | `0xe4c0aaf4` (keccak256 of `isBlocked(address)`) |
| `STALE_HOURS` | 20 |

**Algorithm:**

1. Check cache freshness: if `usds-status` cache is <20 hours old, skip
2. Read implementation address from ERC-1967 storage slot via `eth_getStorageAt`
3. If implementation matches `NO_FREEZE_IMPL`: `freezeActive = false` (known safe impl)
4. Otherwise: probe the proxy with `eth_call` using `isBlocked(address(0))` selector
   - If call returns ≥32 bytes: freeze function exists (`freezeActive = true`)
   - If call reverts: no freeze function (`freezeActive = false`)
   - If probe fails entirely: preserve cached status, don't update
5. Store `{ freezeActive, implementationAddress, lastChecked }` via `setCacheIfNewer()`

### sync-bluechip

**File:** `worker/src/cron/sync-bluechip.ts`
**Schedule:** `5 8 * * *` (daily at 08:05 UTC)
**Data source:** `https://backend.bluechip.org/coin-data/{slug}`

**Purpose:** Fetches safety ratings from bluechip.org for 17 tracked stablecoins.

**Constants:**

| Constant | Value |
|----------|-------|
| `STALE_HOURS` | 6 |
| `API_BASE` | `https://backend.bluechip.org/coin-data` |
| Batch size | 3 concurrent requests |
| Batch delay | 500ms between batches |
| Max retries | 2 per request |

**Algorithm:**

1. Check cache freshness: if `bluechip-ratings` cache is <6 hours old, skip
2. Fetch ratings for all 17 slugs in `BLUECHIP_SLUG_MAP` (file: `worker/src/lib/bluechip-slugs.ts`)
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

**Tracked coins:** USDC, USDT, DAI, LUSD, BOLD, PYUSD, PAXG, XAUT, GUSD, USDP, EURC, FDUSD, FRAX, GHO, TUSD, RLUSD, XSGD.

---

## Health & Status Endpoints

### GET /api/health

Returns cache freshness for key data sources, with per-source staleness thresholds:

| Cache Key | Stale threshold |
|-----------|----------------|
| `stablecoins` | 600s (10 min) |
| `stablecoin-charts` | 3,600s (1h) |
| `usds-status` | 86,400s (24h) |
| `fx-rates` | 1,800s (30 min) |
| `bluechip-ratings` | 86,400s (24h) |
| `dex-liquidity` | 43,200s (12h) |
| `yield-data` | 3,600s (1h) |
| `dews` | 1,800s (30 min) |

Health freshness checks for mint/burn major symbols and scheduler stale alerts use the same shared resolver in `worker/src/lib/mint-burn-health-config.ts`, including env overrides (`MINT_BURN_MAJOR_SYMBOLS`, `MINT_BURN_STALE_WARN_SEC`, `MINT_BURN_STALE_CRIT_SEC`, `MINT_BURN_ALERT_COOLDOWN_SEC`).

### GET /api/status

Returns raw and effective status, recent `cron_runs`, active `cron_run_progress` rows, data-quality metrics, state-machine metadata, synthetic probe summary, and transition timeline. Tracks 21 cron jobs across 9 triggers via `CRON_INTERVALS` in `worker/src/lib/cron-schedule.ts`, which is derived from the shared `shared/lib/cron-jobs.ts` source of truth:

| Job | Interval | Trigger |
|-----|----------|---------|
| `sync-stablecoins` | 900s (15min) | `*/15 * * * *` |
| `sync-stablecoin-charts` | 1,800s (30min) | `10,40 * * * *` |
| `sync-fx-rates` | 900s (15min) | `*/15 * * * *` |
| `stability-index` | 900s (15min) | `*/15 * * * *` |
| `compute-dews` | 900s (15min) | `*/15 * * * *` |
| `status-self-check` | 900s (15min) | `*/15 * * * *` |
| `dispatch-telegram-alerts` | 300s (5min) | `2,7,12,17,22,27,32,37,42,47,52,57 * * * *` |
| `sync-blacklist` | 1,200s (20min) | `3,23,43 * * * *` |
| `sync-mint-burn` | 1,200s (20min) | `4,24,44 * * * *` |
| `sync-dex-discovery` | 1,200s (20min) | `6,26,46 * * * *` |
| `sync-mint-burn-extended` | 1,200s (20min) | `13,33,53 * * * *` |
| `sync-dex-liquidity` | 1,800s (30min) | `10,40 * * * *` |
| `sync-yield-data` | 1,800s (30min) | `10,40 * * * *` |
| `snapshot-supply` | 86,400s (24h) | `0 8 * * *` |
| `snapshot-safety-grade-history` | 86,400s (24h) | `0 8 * * *` |
| `fetch-tbill-rate` | 86,400s (24h) | `0 8 * * *` |
| `snapshot-psi` | 86,400s (24h) | `0 8 * * *` |
| `sync-usds-status` | 86,400s (24h) | `0 8 * * *` |
| `sync-bluechip` | 86,400s (24h) | `5 8 * * *` |
| `daily-digest` | 86,400s (24h) | `5 8 * * *` |
| `discovery-scan` | 86,400s (24h) | `5 8 * * *` |

A job is marked "unhealthy" if its last run had `status='error'` or if the last run started more than 2× its expected interval ago. `/api/status` now also exposes `crons[*].inFlight` while a long-running leased job is active, including `stage`, `itemsDone/itemsTotal`, the last heartbeat timestamp, and a `stale` flag when the active-progress row stops updating.

### GET /api/status-history

Admin timeline feed for machine consumers. Returns persisted status state, status-system staleness, latest synthetic probe aggregate, discrepancy summary, and recent status transitions.

---

## Key Constants

**File:** `worker/src/lib/constants.ts`

| Constant | Value | Purpose |
|----------|-------|---------|
| `D1_BATCH_SIZE` | 100 | Max statements per D1 batch |
| `ETHERSCAN_V2_BASE` | `https://api.etherscan.io/v2/api` | Etherscan unified endpoint |
| `DEFILLAMA_BASE` | `https://stablecoins.llama.fi` | DefiLlama stablecoins |
| `DEFILLAMA_COINS` | `https://coins.llama.fi` | DefiLlama coin prices |
| `DEFILLAMA_API` | `https://api.llama.fi` | DefiLlama yields/protocols |
| `USER_AGENT` | `Pharos/1.0 (stablecoin analytics)` | All outbound requests |
| `MIN_VALID_ASSET_COUNT` | 50 | Minimum assets from DL for valid sync |
| `DEXSCREENER_MIN_LIQUIDITY_USD` | 50,000 | DexScreener pool threshold |

---

## File Index

| File | Role |
|------|------|
| `worker/src/index.ts` | Thin worker entry: delegates `fetch`/`scheduled` to handler modules |
| `worker/src/handlers/http.ts` | HTTP request pipeline: CORS, method gating, edge cache, route-context assembly, router dispatch |
| `worker/src/handlers/scheduled.ts` | Cron scheduler pipeline: trigger-slot orchestration, `logCronRun`, lease wrappers, staleness alert |
| `worker/src/lib/env.ts` | Worker Env interface + `parseCsvEnv()` helper for CSV-based runtime overrides |
| `worker/wrangler.toml` | Deployment config: custom domain, cron triggers, D1 binding, vars |
| `worker/src/lib/db.ts` | Database helpers: `logCronRun`, `batchExecute`, cache CRUD, block tracking, price cache, cron lease primitives |
| `worker/src/lib/auth.ts` | Admin auth: timing-safe `X-Admin-Key` comparison |
| `worker/src/lib/alerts.ts` | Webhook alerts: auto-detects Discord/Slack format |
| `worker/src/lib/constants.ts` | Shared constants: API URLs, thresholds, cache profiles |
| `worker/src/lib/cron-schedule.ts` | Worker-facing `CRON_INTERVALS` export derived from shared cron metadata |
| `shared/lib/cron-jobs.ts` | Shared cron expressions, per-job intervals, and status-page grouping/trigger metadata |
| `worker/src/lib/status-thresholds.ts` | Shared status threshold constants for blacklist/on-chain quality bands |
| `worker/src/lib/blacklist-gaps.ts` | Shared blacklist gap query helper (Tron null-amount exclusion + recent window) |
| `worker/src/lib/chain-registry.ts` | Unified chain mappings + chain RPC configs: Alchemy/dRPC/public fallback for 11 chains |
| `worker/src/lib/coingecko.ts` | CoinGecko init: free/pro URL switching, auth headers |
| `worker/src/lib/bluechip-slugs.ts` | Bluechip slug → canonical Pharos ID mapping (17 coins) |
| `worker/src/lib/mint-burn-health-config.ts` | Shared mint/burn freshness defaults, env override resolver, stale-symbol evaluator |
| `worker/src/lib/dex-liquidity.ts` | Shared `dex_liquidity` table loader (`loadDexLiquidityMap`) |
| `worker/src/lib/psi-recompute.ts` | Shared historical PSI day-input builder used by audit/backfill admin APIs |
| `worker/src/lib/mint-burn-contracts.ts` | Mint/burn event configs resolved from shared stablecoin contracts, plus explicit vault overrides, `startBlock`, and `SAFE_HAVEN_IDS` |
| `worker/src/lib/mint-burn-scoring.ts` | FIS computation, gauge bands, flight-to-quality detection (pure functions) |
| `worker/src/cron/sync-stablecoin-charts.ts` | Chart sync: DefiLlama charts, FX fix, downsampling |
| `worker/src/cron/sync-mint-burn.ts` | Mint/burn flow sync: Alchemy log scanning (Transfer + custom topics), hourly aggregation |
| `worker/src/cron/sync-usds-status.ts` | USDS freeze monitor: ERC-1967 proxy inspection |
| `worker/src/cron/sync-bluechip.ts` | Bluechip ratings: batch fetch from bluechip.org |
| `worker/src/cron/snapshot-safety-grade-history.ts` | Daily Safety Score grade history snapshot writer (seed + grade-change events) |
| `worker/src/cron/status-self-check.ts` | Status reliability self-check: default-origin internal router probes, external `SELF_URL` HTTP probes, hysteresis persistence, discrepancy + probe-failure alerting |
| `worker/src/lib/status-reliability.ts` | Status state machine + transition/probe/discrepancy persistence helpers |
| `worker/migrations/0001_initial.sql` | `cache`, `blacklist_events`, `blacklist_sync_state` tables |
