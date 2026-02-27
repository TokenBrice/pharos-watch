# Data Pipeline — Price Enrichment, Integrity Guardrails & Blacklist Sync

## Supply Pipeline

Supply data uses a two-source model with automatic fallback:

- **DefiLlama** — primary source for all stablecoins tracked by DefiLlama's stablecoin API
- **CoinGecko market cap** — used for gold/silver/fiat tokens that DefiLlama doesn't track (e.g. XAUT, PAXG, KAU), and as a **full supply fallback** when the DefiLlama stablecoins API is down (circuit breaker triggers `fallbackToCgSupply()`)

No on-chain overrides, no CMC supply patches, no manual supply corrections.

### Circuit Breakers

All external data sources are protected by per-source circuit breakers (`worker/src/lib/circuit-breaker.ts`). State is persisted in the D1 `cache` table under keys like `circuit:defillama-stablecoins`.

- **Open threshold**: 3 consecutive failures
- **Probe interval**: 30 minutes (one request allowed to test recovery)
- **Alerts**: Webhook alert fires on open and close transitions
- **Health impact**: Any open circuit triggers `degraded` status on `/api/health`

Sources tracked: `defillama-stablecoins`, `defillama-coins`, `defillama-yields`, `defillama-protocols`, `coingecko-prices`, `coingecko-mcap`.

### DefiLlama list vs detail API

The **list** endpoint (`stablecoins.llama.fi/stablecoins`) returns `circulating` values **already in USD** for all peg types — `peggedRUB`, `peggedEUR`, `peggedJPY`, etc. are all denominated in USD despite their key names.

The **detail** endpoint (`stablecoins.llama.fi/stablecoin/{id}`) returns values in **native currency** (e.g. RUB for A7A5, EUR for EURC). The worker's `stablecoin-detail.ts` handler multiplies by `parsed.price` to convert these to USD before caching.

Do **not** multiply list endpoint values by price — that would double-convert and produce wildly wrong numbers (e.g. A7A5: $508M × 0.013 = $6.6M instead of $508M).

## Price Enrichment Pipeline

### Dual-Primary Price Validation

Before the enrichment pipeline runs, `fetchDualPrimaryPrices()` fetches prices from both the DefiLlama coins API and CoinGecko `/simple/price` **in parallel** for all assets with a valid `geckoId`. It cross-validates within 50 basis points:

- **Both agree (≤50 bps)** → `priceConfidence: "high"`, use DL price
- **Disagree (>50 bps)** → `priceConfidence: "low"`, use closer-to-peg value, log divergence
- **One source down** → `priceConfidence: "single-source"`, use available
- **Both down** → skip, falls through to enrichment pipeline

Each asset gets tagged with `priceConfidence` (high/single-source/low/fallback) and `supplySource` (defillama/coingecko-fallback).

### Enrichment Pipeline

`enrichMissingPrices()` in `worker/src/cron/enrich-prices.ts` uses a 5-pass system for assets still missing prices after dual-primary:

1. **Pass 1:** Contract address -> DefiLlama coins API (with multi-chain fallback)
2. **Pass 2:** CoinGecko ID -> DefiLlama CoinGecko proxy
3. **Pass 3:** CoinGecko ID -> CoinGecko direct API
4. **Pass 3.5:** CoinMarketCap slug -> CMC quotes API (rate-limited to 1 call/hour via D1 cache timestamp)
5. **Pass 4:** Symbol -> DexScreener search API (best-effort, filtered by >$50K liquidity, peg-type-aware price cap: $1K for fiat stables, $100K for gold, capped at 10 searches per run)

Note: DexScreener's **batch token API** (`/tokens/v1/{chainId}/{addresses}`) is also used in `syncDexLiquidity()` for DEX-implied price observations (separate from the search API used here for price enrichment).

**Price validation ordering:** `isReasonablePrice()` runs **before** `savePriceCache()` so that unreasonable enriched prices never enter the 24-hour cache. This prevents a single bad API response from poisoning the cache across multiple sync cycles.

## Data Integrity Guardrails

The sync pipeline includes multiple layers of validation to prevent bad data from reaching users:

1. **Structural validation**: DefiLlama response must contain `MIN_VALID_ASSET_COUNT` (50) assets with valid `id`, `name`, `symbol`, and `circulating` fields. Malformed objects are dropped before caching
2. **Price validation ordering**: `isReasonablePrice()` rejects prices outside peg-type bounds **before** `savePriceCache()`, not after
3. **Concurrent cron guard**: `setCacheIfNewer()` uses a compare-and-swap pattern — a slow sync run can't overwrite a newer run's data. Uses `syncStartSec` as CAS guard. Applied to all cache-writing crons (stablecoins, bluechip, USDS, daily-digest)
4. **Detail JSON validation**: `stablecoin-detail.ts` parses response JSON before caching; skips cache on parse failure
5. **fetchWithRetry**: Default 15s timeout prevents hanging Workers. Retries on 404 by default (configurable via `{ passthrough404: true }`, `{ timeoutMs: N }`)
6. **Depeg dedup**: `UNIQUE INDEX (stablecoin_id, started_at, source)` prevents duplicate depeg events. Partial index on `ended_at IS NULL` speeds up open-event queries
7. **Depeg interval merge**: `computePegScore()` and `computePegStability()` merge overlapping depeg intervals before summing duration
8. **Depeg direction handling**: If a coin flips from below-peg to above-peg (or vice versa) without recovering, the old event is closed and a new one opened with the correct direction
9. **Peg score consistency**: Both the detail page and peg-summary API use the same tracking window: `Math.min(dataStart, fourYearsAgo)`
10. **Backfill atomicity**: `backfill-depegs.ts` runs DELETE + INSERT via `batchExecute()` (auto-chunks to D1's 100-statement batch limit while maintaining transactional semantics per chunk)
11. **OFFSET/LIMIT safety**: SQL queries use `LIMIT -1` when offset > 0 but no limit is set (bare OFFSET is invalid SQLite). Values are parameterized, not interpolated
12. **Freshness header**: `/api/stablecoins` returns `X-Data-Updated-At` header from the cache timestamp
13. **Timing-safe admin auth**: Admin endpoints (`/api/status`, `/api/backfill-depegs`) hash both keys with SHA-256 before `crypto.subtle.timingSafeEqual()`, preventing both timing side-channel attacks and length-leak attacks
14. **Pagination defaults**: `/api/depeg-events` defaults `limit` to 100 and caps at 1000 (`Math.min(Math.max(parsed || 100, 1), 1000)`); `/api/blacklist` defaults `limit` to 0 (all results) and caps at 5000 (`Math.min(Math.max(parsed || 0, 0), 5000)`)
15. **Unbounded query guard**: `/api/peg-summary` adds `LIMIT 10000` to depeg_events query
16. **Cache-empty 503**: `/api/peg-summary` returns HTTP 503 (not 200) when cache is empty, signaling data unavailability
17. **Orphan depeg cleanup**: `detectDepegEvents()` closes open depeg events whose stablecoin was not processed during the current run (removed from tracked list, failed validation, etc.)
18. **Cron prune resilience**: `logCronRun()` wraps old-entry pruning in try/catch so prune failures don't crash the cron after successful completion. The error-logging catch block is also protected — if logging the error to D1 fails, the original error is still re-thrown
19. **Security headers**: Worker adds `X-Content-Type-Options: nosniff` to all responses
20. **Admin cache bypass**: `/api/backfill-depegs` skips the response cache (alongside `/api/health` and `/api/status`)

## Gold & Silver Spot Prices (gold-api.com)

`syncFxRates()` in `worker/src/cron/sync-fx-rates.ts` fetches gold and silver spot prices from the [gold-api.com](https://gold-api.com) API for commodity-pegged stablecoin peg validation (XAUT, PAXG, KAU, KAG, etc.).

### Why gold-api.com?

The previous source (DefiLlama's `coingecko:gold` / `coingecko:silver` coins API) silently returns empty data, producing garbage peg references and phantom trillion-BPS depegs in backfilled events. gold-api.com requires no API key or rate limiting.

### Live Sync (sync-fx-rates.ts)

- **Endpoint**: `GET https://api.gold-api.com/price/XAU` (gold), `GET https://api.gold-api.com/price/XAG` (silver)
- **Rate limiting**: None — no API key required, fetched every 15-minute cron run.
- **Validation**: Same `isValidRate()` bounds + delta checks as FX rates (gold: $500-$10,000/oz, silver: $5-$500/oz, max 20% change from previous value).
- **Fallback**: If the gold-api.com live fetch fails, previously cached rates are used. The peer median serves as a last-resort reference if no cached rates exist.

### Backfill (backfill-depegs.ts)

- **Endpoint**: `GET /v1/timeseries?api_key=KEY&start_date=...&end_date=...&currency=USD&unit=toz`
- **Windowing**: The 4-year backfill range is split into 30-day windows (API limit), all fetched in parallel (~49 requests, one-time).
- **Output**: Returns both gold and silver daily series in `{ GOLD: FxTimeSeries[], SILVER: FxTimeSeries[] }` format, used by `buildFxLookup()` for time-varying peg references.
- **Fallback**: If no API key is provided, commodity series are empty and the backfill uses current peg rates as static fallback.

### Budget

The live `/price/` endpoint requires no API key and has no documented rate limit — it is called every 15-minute sync run (2 requests: gold + silver), ~5,760/month. The historical `/v1/timeseries` endpoint used by backfills requires an API key; the free tier allows 100 requests/month. The one-time 4-year backfill uses ~49 timeseries requests.

## Stability Index (PSI) Computation

`computeAndStoreStabilityIndex()` in `worker/src/cron/stability-index.ts` runs every 15 minutes and computes a composite ecosystem health score (0–100). Formula: `Score = 100 − severity − breadth + trend`. See `docs/stability-index.md` for full algorithm, calibration examples, and band definitions.

**Band classification:** `BEDROCK` (90–100), `STEADY` (75–89), `TREMOR` (60–74), `FRACTURE` (40–59), `CRISIS` (20–39), `MELTDOWN` (0–19)

**Storage:** `stability_index` table (migration 0022) with `computed_at`, `score`, `band`, `components` (JSON), `input_snapshot` (JSON).

## Pending Depeg Confirmation

For stablecoins with >$1B circulating supply, depeg detection uses a two-phase confirmation system:

1. **Phase 1** (`detect-depegs.ts`): When a large coin crosses the depeg threshold, instead of immediately opening an event, a record is inserted into `depeg_pending` (migration 0023)
2. **Phase 2** (`confirm-pending-depegs.ts`): On the next cron cycle, pending records are re-checked. If the depeg persists, a real depeg event is opened. If the price recovered, the pending record is deleted

This prevents false positive depeg events for systemically important stablecoins during brief price feed glitches.

## Blacklist Sync State Semantics

The `blacklist_sync_state.last_block` column has different semantics per chain type:
- **EVM chains**: stores actual block numbers
- **Tron**: stores millisecond timestamps (Tron events are ordered by timestamp, not block number)

This is intentional — do not mix these values across chain types.
