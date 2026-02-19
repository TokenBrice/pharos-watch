# Data Pipeline — Price Enrichment, Integrity Guardrails & Blacklist Sync

## Price Enrichment Pipeline

`enrichMissingPrices()` in `worker/src/cron/enrich-prices.ts` uses a 4-pass system for assets with missing or zero prices:

1. **Pass 1:** Contract address -> DefiLlama coins API (with multi-chain fallback)
2. **Pass 2:** CoinGecko ID -> DefiLlama CoinGecko proxy
3. **Pass 3:** CoinGecko ID -> CoinGecko direct API
4. **Pass 4:** Symbol -> DexScreener search API (best-effort, filtered by >$50K liquidity, peg-type-aware price cap: $1K for fiat stables, $100K for gold)

**Price validation ordering:** `isReasonablePrice()` runs **before** `savePriceCache()` so that unreasonable enriched prices never enter the 24-hour cache. This prevents a single bad API response from poisoning the cache across multiple sync cycles.

## Data Integrity Guardrails

The sync pipeline includes multiple layers of validation to prevent bad data from reaching users:

1. **Structural validation**: DefiLlama response must contain 50+ assets with valid `id`, `name`, `symbol`, and `circulating` fields. Malformed objects are dropped before caching
2. **Supply sanity floor**: Cache write is skipped if total tracked supply falls below $100B (current total ~$230B). Prevents a partial DefiLlama outage from showing $0 market cap
3. **Price validation ordering**: `isReasonablePrice()` rejects prices outside peg-type bounds **before** `savePriceCache()`, not after
4. **Concurrent cron guard**: `setCacheIfNewer()` uses a compare-and-swap pattern — a slow sync run can't overwrite a newer run's data. Uses `syncStartSec` as CAS guard
5. **Detail JSON validation**: `stablecoin-detail.ts` parses response JSON before caching; skips cache on parse failure
6. **fetchWithRetry**: Retries on 404 by default (configurable via `{ passthrough404: true }`)
7. **Depeg dedup**: `UNIQUE INDEX (stablecoin_id, started_at, source)` prevents duplicate depeg events. Partial index on `ended_at IS NULL` speeds up open-event queries
8. **Depeg interval merge**: `computePegScore()` and `computePegStability()` merge overlapping depeg intervals before summing duration
9. **Depeg direction handling**: If a coin flips from below-peg to above-peg (or vice versa) without recovering, the old event is closed and a new one opened with the correct direction
10. **Peg score consistency**: Both the detail page and peg-summary API use the same tracking window: `Math.min(dataStart, fourYearsAgo)`
11. **Backfill atomicity**: `backfill-depegs.ts` runs DELETE + INSERT in a single `db.batch()` call (D1 batch is transactional)
12. **OFFSET/LIMIT safety**: SQL queries use `LIMIT -1` when offset > 0 but no limit is set (bare OFFSET is invalid SQLite). Values are parameterized, not interpolated
13. **Freshness header**: `/api/stablecoins` returns `X-Data-Updated-At` header from the cache timestamp

## Blacklist Sync State Semantics

The `blacklist_sync_state.last_block` column has different semantics per chain type:
- **EVM chains**: stores actual block numbers
- **Tron**: stores millisecond timestamps (Tron events are ordered by timestamp, not block number)

This is intentional — do not mix these values across chain types.
