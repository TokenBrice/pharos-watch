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

1. **Structural validation**: DefiLlama response must contain `MIN_VALID_ASSET_COUNT` (50) assets with valid `id`, `name`, `symbol`, and `circulating` fields. Malformed objects are dropped before caching
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
14. **On-chain supply override**: `syncOnchainSupply()` writes to `onchain_supply` table; main sync reads it and overrides DefiLlama data when on-chain diverges >5%. 2-hour freshness guard prevents stale on-chain data from being used. Wrapped in try/catch so failures don't block the main sync. BigInt-to-number conversion uses shared `bigIntToDecimal()` from `worker/src/lib/bigint.ts` (handles >15 decimal tokens safely)
15. **Timing-safe admin auth**: Admin endpoints (`/api/status`, `/api/backfill-depegs`) use `crypto.subtle.timingSafeEqual()` for key comparison, preventing timing side-channel attacks
16. **Pagination caps**: `/api/blacklist` and `/api/depeg-events` cap `limit` to `Math.min(limit, 1000)` to prevent unbounded result sets
17. **Unbounded query guard**: `/api/peg-summary` adds `LIMIT 10000` to depeg_events query
18. **Cache-empty 503**: `/api/peg-summary` returns HTTP 503 (not 200) when cache is empty, signaling data unavailability
19. **Orphan depeg cleanup**: `detectDepegEvents()` closes open depeg events whose stablecoin was not processed during the current run (removed from tracked list, failed validation, etc.)
20. **Cron prune resilience**: `logCronRun()` wraps old-entry pruning in try/catch so prune failures don't crash the cron after successful completion
21. **Security headers**: Worker adds `X-Content-Type-Options: nosniff` to all responses
22. **Admin cache bypass**: `/api/backfill-depegs` skips the response cache (alongside `/api/health` and `/api/status`)

## On-Chain Supply Verification

`syncOnchainSupply()` in `worker/src/cron/sync-onchain-supply.ts` runs every 30 minutes (piggybacks on the `*/10` cron at :00 and :30, to stay within Cloudflare's 4-cron-trigger limit) and queries `totalSupply()` on-chain for stablecoins that have contract addresses configured in `src/lib/stablecoins.ts`.

### How It Works

1. Iterates `TRACKED_STABLECOINS`, collects all entries with `contracts` defined
2. Groups contracts by chain ID
3. For EVM chains: sends a **JSON-RPC batch** of `eth_call` requests for `totalSupply()` (selector `0x18160ddd`) — one HTTP POST per chain
4. For Tron: calls `triggerConstantContract` sequentially per contract (excludes `TRON_BURN_ADDRESS` from supply)
5. Parses `BigInt` results via `bigIntToDecimal()` (from `worker/src/lib/bigint.ts`) to get human-readable supply
6. Writes per-chain supply to D1 `onchain_supply` table via `INSERT OR REPLACE`

All chains are queried in parallel. Individual contract/chain failures are logged and skipped without blocking others.

### Override Logic

In `sync-stablecoins.ts`, after DefiLlama data is fetched and prices are enriched but before cache write:

1. Reads `onchain_supply` rows with 2-hour freshness (`updated_at > now - 7200`)
2. For each stablecoin with on-chain data, compares on-chain total supply (token units) with DefiLlama supply (`llamaMcap / price`)
3. If divergence exceeds **5%**: overrides `circulating` with `onchainTotal × price` (USD, matching DefiLlama convention), and overwrites `chainCirculating` and `chains`
4. If divergence is within 5%, keeps DefiLlama data (small differences are normal — DefiLlama may exclude burned tokens, lock contracts, etc.)

The override is wrapped in `try/catch` so failures never block the main sync.

### Contract Address Registry

Contract addresses are stored in the `contracts` field of `StablecoinMeta` in `src/lib/stablecoins.ts`:

```typescript
interface ContractDeployment {
  chain: string;      // Chain ID matching CHAIN_RPCS (e.g., "ethereum", "tron")
  address: string;    // Contract address (0x... for EVM, T... for Tron)
  decimals: number;   // Token decimals
}
```

Chain RPC endpoints are configured in `worker/src/lib/chain-rpcs.ts` (11 chains: Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche, BSC, Gnosis, Fantom, Celo, Tron).

### D1 Table

```sql
CREATE TABLE onchain_supply (
  stablecoin_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  supply REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (stablecoin_id, chain)
);
```

## Blacklist Sync State Semantics

The `blacklist_sync_state.last_block` column has different semantics per chain type:
- **EVM chains**: stores actual block numbers
- **Tron**: stores millisecond timestamps (Tron events are ordered by timestamp, not block number)

This is intentional — do not mix these values across chain types.
