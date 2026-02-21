# Data Pipeline — Price Enrichment, Integrity Guardrails & Blacklist Sync

## Price Enrichment Pipeline

`enrichMissingPrices()` in `worker/src/cron/enrich-prices.ts` uses a 4-pass system for assets with missing or zero prices:

1. **Pass 1:** Contract address -> DefiLlama coins API (with multi-chain fallback)
2. **Pass 2:** CoinGecko ID -> DefiLlama CoinGecko proxy
3. **Pass 3:** CoinGecko ID -> CoinGecko direct API
4. **Pass 3.5:** CoinMarketCap slug -> CMC quotes API (rate-limited to 1 call/hour via D1 cache timestamp, also stashes market cap for supply override downstream)
5. **Pass 4:** Symbol -> DexScreener search API (best-effort, filtered by >$50K liquidity, peg-type-aware price cap: $1K for fiat stables, $100K for gold)

**Price validation ordering:** `isReasonablePrice()` runs **before** `savePriceCache()` so that unreasonable enriched prices never enter the 24-hour cache. This prevents a single bad API response from poisoning the cache across multiple sync cycles.

## Data Integrity Guardrails

The sync pipeline includes multiple layers of validation to prevent bad data from reaching users:

1. **Structural validation**: DefiLlama response must contain `MIN_VALID_ASSET_COUNT` (50) assets with valid `id`, `name`, `symbol`, and `circulating` fields. Malformed objects are dropped before caching
2. **Supply sanity floor**: Cache write is skipped if total tracked supply falls below $100B (current total ~$230B). Prevents a partial DefiLlama outage from showing $0 market cap
3. **Price validation ordering**: `isReasonablePrice()` rejects prices outside peg-type bounds **before** `savePriceCache()`, not after
4. **Concurrent cron guard**: `setCacheIfNewer()` uses a compare-and-swap pattern — a slow sync run can't overwrite a newer run's data. Uses `syncStartSec` as CAS guard. Applied to all cache-writing crons (stablecoins, bluechip, USDS, daily-digest)
5. **Detail JSON validation**: `stablecoin-detail.ts` parses response JSON before caching; skips cache on parse failure
6. **fetchWithRetry**: Default 15s timeout prevents hanging Workers. Retries on 404 by default (configurable via `{ passthrough404: true }`, `{ timeoutMs: N }`)
7. **Depeg dedup**: `UNIQUE INDEX (stablecoin_id, started_at, source)` prevents duplicate depeg events. Partial index on `ended_at IS NULL` speeds up open-event queries
8. **Depeg interval merge**: `computePegScore()` and `computePegStability()` merge overlapping depeg intervals before summing duration
9. **Depeg direction handling**: If a coin flips from below-peg to above-peg (or vice versa) without recovering, the old event is closed and a new one opened with the correct direction
10. **Peg score consistency**: Both the detail page and peg-summary API use the same tracking window: `Math.min(dataStart, fourYearsAgo)`
11. **Backfill atomicity**: `backfill-depegs.ts` runs DELETE + INSERT via `batchExecute()` (auto-chunks to D1's 100-statement batch limit while maintaining transactional semantics per chunk)
12. **OFFSET/LIMIT safety**: SQL queries use `LIMIT -1` when offset > 0 but no limit is set (bare OFFSET is invalid SQLite). Values are parameterized, not interpolated
13. **Freshness header**: `/api/stablecoins` returns `X-Data-Updated-At` header from the cache timestamp
14. **On-chain supply override**: `syncOnchainSupply()` writes to `onchain_supply` table; main sync reads it and overrides DefiLlama data when on-chain diverges >5%. 2-hour freshness guard prevents stale on-chain data from being used. Wrapped in try/catch so failures don't block the main sync. BigInt-to-number conversion uses shared `bigIntToDecimal()` from `worker/src/lib/bigint.ts` (handles >15 decimal tokens safely)
15. **Timing-safe admin auth**: Admin endpoints (`/api/status`, `/api/backfill-depegs`) hash both keys with SHA-256 before `crypto.subtle.timingSafeEqual()`, preventing both timing side-channel attacks and length-leak attacks
16. **Pagination defaults**: `/api/blacklist` and `/api/depeg-events` default `limit` to 100 and cap at 1000 (`Math.min(Math.max(parsed || 100, 1), 1000)`) to prevent unbounded result sets
17. **Unbounded query guard**: `/api/peg-summary` adds `LIMIT 10000` to depeg_events query
18. **Cache-empty 503**: `/api/peg-summary` returns HTTP 503 (not 200) when cache is empty, signaling data unavailability
19. **Orphan depeg cleanup**: `detectDepegEvents()` closes open depeg events whose stablecoin was not processed during the current run (removed from tracked list, failed validation, etc.)
20. **Cron prune resilience**: `logCronRun()` wraps old-entry pruning in try/catch so prune failures don't crash the cron after successful completion. The error-logging catch block is also protected — if logging the error to D1 fails, the original error is still re-thrown
21. **Security headers**: Worker adds `X-Content-Type-Options: nosniff` to all responses
22. **Admin cache bypass**: `/api/backfill-depegs` skips the response cache (alongside `/api/health` and `/api/status`)

## On-Chain Supply Verification

`syncOnchainSupply()` in `worker/src/cron/sync-onchain-supply.ts` runs every 30 minutes (piggybacks on the `*/10` cron at :00 and :30, to stay within Cloudflare's 4-cron-trigger limit) and queries on-chain supply for stablecoins that have contract addresses configured in `src/lib/stablecoins.ts`.

### Per-Token Supply Methods

Not all tokens can use raw `totalSupply()` — some include non-circulating tokens (treasury reserves, pre-minted lending capacity). Each token can configure a `supplyMethod` in `StablecoinMeta`:

| Method | How it works | Example tokens |
|--------|-------------|----------------|
| `totalSupply` (default) | Raw `totalSupply()` is circulating | LUSD, BOLD, GHO, DAI |
| `totalSupply-minus-addresses` | `totalSupply() - sum(balanceOf(addr))` | USDT (minus Tether Treasury), USDC (minus Circle Reserve) |
| `custom-contract` | Call a dedicated circulating supply contract | (available for future use) |
| `exclude` | Skip on-chain supply, rely on DefiLlama | crvUSD, MIM (complex multi-contract supply) |

### How It Works

1. Iterates `TRACKED_STABLECOINS`, collects all entries with `contracts` defined (skips `exclude` tokens)
2. Groups contracts by chain ID
3. For each EVM chain, builds a single JSON-RPC batch containing:
   - `totalSupply()` (selector `0x18160ddd`) for each contract
   - `decimals()` (selector `0x313ce567`) for on-chain verification of configured decimals
   - `balanceOf(address)` (selector `0x70a08231`) for each treasury/reserve address to subtract
4. For Tron: calls `triggerConstantContract` sequentially per contract with the same call types
5. **Decimals verification**: if on-chain decimals differ from configured value, the contract is skipped and an error is logged
6. **Supply computation**: for `totalSupply-minus-addresses` tokens, subtracts all configured balances from totalSupply before storing
7. Writes per-chain **circulating** supply (after adjustments) to D1 `onchain_supply` table via `INSERT OR REPLACE`

All chains are queried in parallel. Individual contract/chain failures are logged and skipped without blocking others.

### Override Logic

In `sync-stablecoins.ts`, after DefiLlama data is fetched and prices are enriched but before cache write:

1. Reads `onchain_supply` rows with 2-hour freshness (`updated_at > now - 7200`)
2. For each stablecoin with on-chain data, compares on-chain total supply (token units) with DefiLlama supply (`llamaMcap / price`)
3. If divergence exceeds **5%**: overrides `circulating` with `onchainTotal × price` (USD, matching DefiLlama convention), and overwrites `chainCirculating` and `chains`
4. If divergence is within 5%, keeps DefiLlama data (small differences are normal — DefiLlama may exclude burned tokens, lock contracts, etc.)
5. **Upper guard**: rejects overrides where on-chain is >3x DefiLlama (likely non-circulating tokens)
6. **Lower guard**: rejects overrides where on-chain is <50% of DefiLlama (likely RPC failure)
7. **Large override warning**: logs critical warning for overrides changing mcap by >$500M

The override is wrapped in `try/catch` so failures never block the main sync.

### Contract Address Registry

Contract addresses and supply methods are stored in `StablecoinMeta` in `src/lib/stablecoins.ts`:

```typescript
interface ContractDeployment {
  chain: string;      // Chain ID matching CHAIN_RPCS (e.g., "ethereum", "tron")
  address: string;    // Contract address (0x... for EVM, T... for Tron)
  decimals: number;   // Token decimals (verified against on-chain decimals())
}

interface SupplyMethodConfig {
  type: "totalSupply" | "totalSupply-minus-addresses" | "custom-contract" | "exclude";
  subtractAddresses?: { chain: string; address: string }[];
  customContract?: { chain: string; address: string; selector: string; decimals: number };
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

## Gold & Silver Spot Prices (metals.dev)

`syncFxRates()` in `worker/src/cron/sync-fx-rates.ts` fetches gold and silver spot prices from the [metals.dev](https://metals.dev) API for commodity-pegged stablecoin peg validation (XAUT, PAXG, KAU, KAG, etc.).

### Why metals.dev?

The previous source (DefiLlama's `coingecko:gold` / `coingecko:silver` coins API) silently returns empty data, producing garbage peg references and phantom trillion-BPS depegs in backfilled events.

### Live Sync (sync-fx-rates.ts)

- **Endpoint**: `GET /v1/latest?api_key=KEY&currency=USD&unit=toz`
- **Rate limiting**: Once per day (free tier = 100 requests/month). The cron runs every 2 hours but checks if the cached metals rates are <24h old before making an API call. Peer median handles intra-day peg validation.
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
