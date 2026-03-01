# Worker Infrastructure

Cloudflare Worker serving the Pharos API. Handles HTTP routing, edge caching, CORS, admin auth, and 15 cron jobs across 4 trigger slots.

**Deployed at:** `api.pharos.watch` (custom domain via `wrangler.toml`)

---

## Env Interface

All bindings defined in `worker/src/index.ts`. Only `DB` and `CORS_ORIGIN` are set in `wrangler.toml`; all others are secrets configured via `wrangler secret put`.

| Binding | Type | Required | Used by |
|---------|------|----------|---------|
| `DB` | D1Database | Yes | All crons and API handlers |
| `CORS_ORIGIN` | string | Yes | CORS headers (`https://pharos.watch`) |
| `ETHERSCAN_API_KEY` | string | No | Blacklist sync, USDS status, price enrichment |
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
| `FEEDBACK_IP_SALT` | string | No | Rate limit IP hashing |
| `TWITTER_API_KEY` | string | No | Digest → Twitter (OAuth consumer key) |
| `TWITTER_API_SECRET` | string | No | Digest → Twitter (OAuth consumer secret) |
| `TWITTER_ACCESS_TOKEN` | string | No | Digest → Twitter (access token) |
| `TWITTER_ACCESS_TOKEN_SECRET` | string | No | Digest → Twitter (access token secret) |
| `TELEGRAM_BOT_TOKEN` | string | No | Digest → Telegram |
| `TELEGRAM_CHAT_ID` | string | No | Digest → Telegram |

---

## Module Initialization

Three modules use a lazy-init pattern to receive API keys from the `Env` at runtime. Called at the top of both `fetch` and `scheduled` handlers:

| Initializer | Called in | Purpose |
|-------------|----------|---------|
| `initCoinGecko(env.COINGECKO_API_KEY)` | `fetch` + `scheduled` | Switches CoinGecko base URL between free/pro tier |
| `initChainRpcs(env.ALCHEMY_API_KEY, env.DRPC_API_KEY)` | `scheduled` only | Builds chain RPC configs with Alchemy/dRPC primaries |
| `initAlerts(env.ALERT_WEBHOOK_URL)` | `scheduled` only | Configures webhook URL for error alerts |

This pattern exists because Cloudflare Workers don't have persistent module state across invocations — `Env` bindings are only available inside handler functions.

---

## HTTP Request Handling

### Method Routing

| Method | Handling |
|--------|----------|
| `OPTIONS` | Returns 204 with CORS headers (preflight) |
| `POST` | Only `/api/feedback` — all other paths return 405 |
| `GET` | All API routes — dispatched to router or inline admin handlers |
| Other | Returns 405 `{ error: "Method not allowed" }` |

### CORS Headers

Applied to every response via `addCorsHeaders()`:

| Header | Value |
|--------|-------|
| `Access-Control-Allow-Origin` | Request origin (dynamic) |
| `Access-Control-Allow-Methods` | `GET, POST, OPTIONS` |
| `Access-Control-Allow-Headers` | `Content-Type, X-Admin-Key` |
| `Access-Control-Max-Age` | `86400` |
| `X-Content-Type-Options` | `nosniff` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Content-Security-Policy` | `default-src 'none'; frame-ancestors 'none'` |

### Edge Cache Strategy

The Worker uses `caches.default` (Cloudflare's per-colo edge cache) to cache GET responses:

1. **Skip list** — these endpoints bypass cache entirely:
   - `/api/health`, `/api/status`
   - `/api/backfill-depegs`, `/api/backfill-supply-history`, `/api/backfill-cg-prices`
   - `/api/audit-depeg-history`, `/api/backfill-stability-index`, `/api/backfill-mint-burn-prices`

2. **Cache check:** `caches.default.match(cacheKey)` — returns cached response if available

3. **Cache store:** `ctx.waitUntil(cache.put(cacheKey, response.clone()))` — the response is cloned **without** CORS headers before caching. CORS headers are added per-request after cache lookup to avoid caching origin-specific headers.

4. **Cache-Control profiles** (set by individual API handlers):

| Profile | `Cache-Control` header | Used by |
|---------|----------------------|---------|
| Realtime | `public, s-maxage=60, max-age=10` | stablecoins, blacklist, depeg-events, peg-summary |
| Standard | `public, s-maxage=300, max-age=60` | stablecoin-charts, dex-liquidity, usds-status |
| Slow | `public, s-maxage=3600, max-age=300` | supply-history, daily-digest, bluechip-ratings, dex-liquidity-history |

### Admin Auth

**File:** `worker/src/lib/auth.ts`

- Reads `X-Admin-Key` header from request
- Compares against `ADMIN_KEY` env var using timing-safe comparison: both values are SHA-256 hashed via `crypto.subtle.digest()`, then compared with `crypto.subtle.timingSafeEqual()`
- Returns `null` if authorized, 401 Response if not

### Inline Admin Endpoints

Three admin endpoints are handled directly in `index.ts` (not via the router):

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /api/trigger-digest` | `X-Admin-Key` | Force-regenerates digest with `skipDedup=true`, posts to Twitter + Telegram |
| `GET /api/reset-blacklist-sync` | `X-Admin-Key` | Rolls back sync state: EVM −50,000 blocks, Tron −7 days |
| `GET /api/debug-sync-state` | `X-Admin-Key` | Returns all `blacklist_sync_state` rows |

---

## Cron Scheduling

Cloudflare Workers supports a maximum of **4 cron triggers**. All 4 slots are used. Adding a new job requires piggybacking on an existing trigger with a minute check.

### wrangler.toml Triggers

```toml
[triggers]
crons = [
  "*/15 * * * *",
  "3,23,43 * * * *",
  "10,40 * * * *",
  "0 8 * * *",
]
```

### Trigger 1: `*/15 * * * *` (every 15 minutes)

| Job | Function | File | Documentation |
|-----|----------|------|---------------|
| `sync-stablecoins` | `syncStablecoins()` | `worker/src/cron/sync-stablecoins.ts` | `docs/data-pipeline.md`, `docs/depeg-detection.md` |
| `sync-stablecoin-charts` | `syncStablecoinCharts()` | `worker/src/cron/sync-stablecoin-charts.ts` | This doc (below) |
| `sync-fx-rates` | `syncFxRates()` | `worker/src/cron/sync-fx-rates.ts` | `docs/data-pipeline.md`, `docs/classification.md` |
| `stability-index` | `computeAndStoreStabilityIndex()` | `worker/src/cron/stability-index.ts` | `docs/stability-index.md` |
| `compute-dews` | `computeAndStoreDEWS()` | `worker/src/cron/compute-dews.ts` | `docs/dews.md` |
| *(inline)* | Stale-cache health alert | `worker/src/index.ts` | This doc (below) |

**Dependencies:** Stability index waits for `syncStablecoins()` to complete (`stablecoinsSync.then(...)`).

**Inline staleness alert:** After sync-stablecoins completes, if the `stablecoins` cache is older than 1800 seconds (30 min), `sendAlert()` fires a webhook notification. This is a health check — not a cron job itself.

### Trigger 2: `3,23,43 * * * *` (every 20 minutes, offset at :03/:23/:43)

| Job | Function | File | Documentation |
|-----|----------|------|---------------|
| `sync-blacklist` | `syncBlacklist()` | `worker/src/cron/sync-blacklist.ts` | `docs/blacklist-tracker.md` |
| `sync-mint-burn` | `syncMintBurn()` | `worker/src/cron/sync-mint-burn.ts` | This doc (below) |

**Shared Etherscan rate limiter:** Both `sync-blacklist` and `sync-mint-burn` use the Etherscan V2 API. To stay within the free-tier 5 req/sec cap, a single `createRateLimiter(4)` instance is created at the trigger level and passed into both jobs. This ensures combined Etherscan requests from both crons never exceed 4 req/sec, leaving headroom for retries.

### Trigger 3: `10,40 * * * *` (every 30 minutes, at :10/:40)

| Job | Function | File | Documentation |
|-----|----------|------|---------------|
| `sync-dex-liquidity` | `syncDexLiquidity()` | `worker/src/cron/sync-dex-liquidity.ts` | `docs/dex-liquidity.md` |
| `sync-yield-data` | `syncYieldData()` | `worker/src/cron/sync-yield-data.ts` | `docs/plans/yield-intelligence-design.md` |

### Trigger 4: `0 8 * * *` (daily at 08:00 UTC)

| Job | Function | File | Documentation |
|-----|----------|------|---------------|
| `snapshot-supply` | `snapshotSupply()` | `worker/src/cron/snapshot-supply.ts` | `docs/supply-snapshot.md` |
| `snapshot-psi` | `snapshotPsiDaily()` | `worker/src/cron/snapshot-psi.ts` | `docs/stability-index.md` |
| `sync-usds-status` | `syncUsdsStatus()` | `worker/src/cron/sync-usds-status.ts` | This doc (below) |
| `sync-bluechip` | `syncBluechip()` | `worker/src/cron/sync-bluechip.ts` | This doc (below) |
| `daily-digest` | `generateDailyDigest()` | `worker/src/cron/daily-digest.ts` | `docs/digest-pipeline.md` |
| `fetch-tbill-rate` | `fetchTbillRate()` | `worker/src/cron/fetch-tbill-rate.ts` | `docs/plans/yield-intelligence-design.md` |

**Dependencies:** Daily digest waits for `snapshotPsiDaily()` to complete (`psiPromise.then(...)`), since PSI data must be fresh before the LLM call.

### Sub-Modules (not directly registered)

These files are called internally by `syncStablecoins()`, not registered as standalone cron jobs:

| File | Called from | Documentation |
|------|-------------|---------------|
| `worker/src/cron/detect-depegs.ts` | `syncStablecoins()` | `docs/depeg-detection.md` |
| `worker/src/cron/confirm-pending-depegs.ts` | `syncStablecoins()` | `docs/depeg-detection.md` |
| `worker/src/cron/enrich-prices.ts` | `syncStablecoins()` | `docs/data-pipeline.md` |

---

## logCronRun() Wrapper

**File:** `worker/src/lib/db.ts`

Every cron job is wrapped: `ctx.waitUntil(logCronRun(db, "job-name", () => fn(db, ...)))`

```typescript
async function logCronRun(
  db: D1Database,
  job: string,
  fn: () => Promise<CronResult | void>
): Promise<void>
```

**Behavior:**
- Records start time (Unix seconds)
- Executes the job function
- On success: inserts row into `cron_runs` with `status='ok'`, `item_count`, and `metadata`
- On error: inserts row with `status='error'` and error message, calls `sendAlert()`, re-throws
- After each run: prunes rows older than 7 days (`started_at < now - 604800`); if prune fails, falls back to keeping only the top 5000 rows by rowid DESC

**Schema:** `cron_runs(job, started_at, duration_ms, status, item_count, metadata, error)`

---

## Alert System

**File:** `worker/src/lib/alerts.ts`

```typescript
export function initAlerts(url: string | undefined): void
export async function sendAlert(title: string, message: string): Promise<void>
```

Auto-detects webhook format from URL:

| URL contains | Format |
|-------------|--------|
| `discord.com/api/webhooks` | Discord embed (red, `[Pharos] {title}`, timestamp) |
| Anything else | Slack markdown (`*[Pharos] {title}*\n{message}`) |

Non-blocking — errors are logged but never propagated.

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
| `stablecoin-charts` | `syncStablecoinCharts` | Downsampled chart points |
| `fx-rates` | `syncFxRates` | FX rates (EUR, GBP, etc.) |
| `usds-status` | `syncUsdsStatus` | Freeze capability + implementation address |
| `bluechip-ratings` | `syncBluechip` | Ratings map keyed by DefiLlama ID |
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
**Schedule:** `*/15 * * * *` (every 15 min)
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
**Schedule:** `0 8 * * *` (daily at 08:00 UTC)
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
5. Store `Record<string, BluechipRating>` (keyed by DefiLlama ID) via `setCacheIfNewer()`

**Tracked coins:** USDC, USDT, DAI, LUSD, BOLD, PYUSD, PAXG, XAUT, GUSD, USDP, EURC, FDUSD, FRAX, GHO, TUSD, RLUSD, XSGD.

---

## Health & Status Endpoints

### GET /api/health

Returns cache freshness for key data sources, with per-source staleness thresholds:

| Cache Key | Stale threshold |
|-----------|----------------|
| `stablecoins` | 600s (10 min) |
| `stablecoin-charts` | 600s (10 min) |
| `usds-status` | 86,400s (24h) |
| `fx-rates` | 1,800s (30 min) |
| `bluechip-ratings` | 86,400s (24h) |
| `dex-liquidity` | 43,200s (12h) |
| `yield-data` | 3,600s (1h) |

### GET /api/status

Returns recent `cron_runs` rows for operational monitoring. Tracks 14 cron jobs via the `CRON_INTERVALS` map:

| Job | Interval | Trigger |
|-----|----------|---------|
| `sync-stablecoins` | 900s (15min) | `*/15 * * * *` |
| `sync-stablecoin-charts` | 900s (15min) | `*/15 * * * *` |
| `sync-fx-rates` | 900s (15min) | `*/15 * * * *` |
| `stability-index` | 900s (15min) | `*/15 * * * *` |
| `compute-dews` | 900s (15min) | `*/15 * * * *` |
| `sync-blacklist` | 1,200s (20min) | `3,23,43 * * * *` |
| `sync-mint-burn` | 1,200s (20min) | `3,23,43 * * * *` |
| `sync-dex-liquidity` | 1,800s (30min) | `10,40 * * * *` |
| `sync-yield-data` | 1,800s (30min) | `10,40 * * * *` |
| `sync-usds-status` | 86,400s (24h) | `0 8 * * *` |
| `sync-bluechip` | 86,400s (24h) | `0 8 * * *` |
| `daily-digest` | 86,400s (24h) | `0 8 * * *` |
| `snapshot-supply` | 86,400s (24h) | `0 8 * * *` |
| `snapshot-psi` | 86,400s (24h) | `0 8 * * *` |
| `fetch-tbill-rate` | 86,400s (24h) | `0 8 * * *` |

A job is marked "unhealthy" if its last run had `status='error'` or if the last run started more than 2× its expected interval ago.

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
| `worker/src/index.ts` | Entry point: Env interface, CORS, edge cache, method routing, admin endpoints, scheduled handler |
| `worker/wrangler.toml` | Deployment config: custom domain, cron triggers, D1 binding, vars |
| `worker/src/lib/db.ts` | Database helpers: `logCronRun`, `batchExecute`, cache CRUD, block tracking, price cache |
| `worker/src/lib/auth.ts` | Admin auth: timing-safe `X-Admin-Key` comparison |
| `worker/src/lib/alerts.ts` | Webhook alerts: auto-detects Discord/Slack format |
| `worker/src/lib/constants.ts` | Shared constants: API URLs, thresholds, cache profiles |
| `worker/src/lib/chain-rpcs.ts` | Chain RPC configs: Alchemy/dRPC/public fallback for 11 chains |
| `worker/src/lib/coingecko.ts` | CoinGecko init: free/pro URL switching, auth headers |
| `worker/src/lib/bluechip-slugs.ts` | Bluechip slug → DefiLlama ID mapping (17 coins) |
| `worker/src/lib/mint-burn-contracts.ts` | Mint/burn contract configs: stablecoin/chain mappings, mint addresses, decimals, `startBlock` (earliest block to scan), `SAFE_HAVEN_IDS` |
| `worker/src/lib/mint-burn-scoring.ts` | FIS computation, gauge bands, flight-to-quality detection (pure functions) |
| `worker/src/cron/sync-stablecoin-charts.ts` | Chart sync: DefiLlama charts, FX fix, downsampling |
| `worker/src/cron/sync-mint-burn.ts` | Mint/burn flow sync: Etherscan Transfer event scanning, hourly aggregation |
| `worker/src/cron/sync-usds-status.ts` | USDS freeze monitor: ERC-1967 proxy inspection |
| `worker/src/cron/sync-bluechip.ts` | Bluechip ratings: batch fetch from bluechip.org |
| `worker/migrations/0001_initial.sql` | `cache`, `blacklist_events`, `blacklist_sync_state` tables |
