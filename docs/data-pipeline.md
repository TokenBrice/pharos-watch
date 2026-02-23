# Data Pipeline — Price Enrichment, Integrity Guardrails & Blacklist Sync

## Supply Pipeline

Supply data uses a simple two-source model:

- **DefiLlama** — primary source for all stablecoins tracked by DefiLlama's stablecoin API
- **CoinGecko market cap** — used only for gold/silver/fiat tokens that DefiLlama doesn't track (e.g. XAUT, PAXG, KAU)

No on-chain overrides, no CMC supply patches, no manual supply corrections.

### DefiLlama list vs detail API

The **list** endpoint (`stablecoins.llama.fi/stablecoins`) returns `circulating` values **already in USD** for all peg types — `peggedRUB`, `peggedEUR`, `peggedJPY`, etc. are all denominated in USD despite their key names.

The **detail** endpoint (`stablecoins.llama.fi/stablecoin/{id}`) returns values in **native currency** (e.g. RUB for A7A5, EUR for EURC). The worker's `stablecoin-detail.ts` handler multiplies by `parsed.price` to convert these to USD before caching.

Do **not** multiply list endpoint values by price — that would double-convert and produce wildly wrong numbers (e.g. A7A5: $508M × 0.013 = $6.6M instead of $508M).

## Price Enrichment Pipeline

`enrichMissingPrices()` in `worker/src/cron/enrich-prices.ts` uses a 5-pass system for assets with missing or zero prices:

1. **Pass 1:** Contract address -> DefiLlama coins API (with multi-chain fallback)
2. **Pass 2:** CoinGecko ID -> DefiLlama CoinGecko proxy
3. **Pass 3:** CoinGecko ID -> CoinGecko direct API
4. **Pass 3.5:** CoinMarketCap slug -> CMC quotes API (rate-limited to 1 call/hour via D1 cache timestamp)
5. **Pass 4:** Symbol -> DexScreener search API (best-effort, filtered by >$50K liquidity, peg-type-aware price cap: $1K for fiat stables, $100K for gold)

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
14. **Pagination defaults**: `/api/blacklist` and `/api/depeg-events` default `limit` to 100 and cap at 1000 (`Math.min(Math.max(parsed || 100, 1), 1000)`) to prevent unbounded result sets
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
- **Fallback**: If no API key is configured, metals are skipped and peer median is the sole reference.

### Backfill (backfill-depegs.ts)

- **Endpoint**: `GET /v1/timeseries?api_key=KEY&start_date=...&end_date=...&currency=USD&unit=toz`
- **Windowing**: The 4-year backfill range is split into 30-day windows (API limit), all fetched in parallel (~49 requests, one-time).
- **Output**: Returns both gold and silver daily series in `{ GOLD: FxTimeSeries[], SILVER: FxTimeSeries[] }` format, used by `buildFxLookup()` for time-varying peg references.
- **Fallback**: If no API key is provided, commodity series are empty and the backfill uses current peg rates as static fallback.

### Budget

Free tier = 100 requests/month. Monthly usage: ~30 live (1/day) + 49 backfill (one-time) = 79 requests.

## Blacklist Sync State Semantics

The `blacklist_sync_state.last_block` column has different semantics per chain type:
- **EVM chains**: stores actual block numbers
- **Tron**: stores millisecond timestamps (Tron events are ordered by timestamp, not block number)

This is intentional — do not mix these values across chain types.
