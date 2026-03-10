# Supply Snapshot Pipeline

Daily market cap snapshot pipeline. Captures each PSI-eligible stablecoin's circulating supply (in USD) once per day from cached DefiLlama data and stores it in D1 for historical charting.

The snapshot does **not** call on-chain RPCs --- it relies entirely on DefiLlama's aggregated supply data cached by the 15-minute `syncStablecoins()` cron.

---

## Cron Schedule

- **Primary schedule:** `0 8 * * *` (daily at 08:00 UTC)
- **Retry path:** chained after each `*/15 * * * *` `sync-stablecoins` run (same-day upsert safeguard)
- **Function:** `snapshotSupply(db: D1Database): Promise<CronResult>`
- **File:** `worker/src/cron/snapshot-supply.ts`
- **Registration:** cron declared in `worker/wrangler.toml`, executed via `worker/src/handlers/scheduled.ts`

---

## Algorithm

1. Fetch the cached "stablecoins" payload from the D1 cache table
2. Verify cache freshness:
   - Cache age > 1200 seconds (20 min): skip snapshot and return cron `status: "degraded"` with `reason: "cache_stale"`
   - Cache age > 600 seconds (10 min): log warning but proceed (degraded freshness)
3. Parse cached JSON, extract the `peggedAssets` array
4. Filter to only `PSI_ELIGIBLE_STABLECOINS` (currently 157 entries: 155 tracked + 2 shadow)
5. Floor current date/time to UTC midnight:
   ```typescript
   const snapshotDate = Math.floor(
     Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000
   );
   ```
6. For each tracked coin:
   - Sum circulating supply via `sumPegBuckets(asset.circulating)` --- already in USD
   - Skip if sum <= 0
   - Extract price (must be a number > 0, else `null`)
   - Build `INSERT OR REPLACE` statement
7. Data quality check: warn if fewer than 80% of expected coins have valid data
8. Execute all statements via `batchExecute()` (batch size = 100, D1 limit)
9. If zero rows were prepared, return cron `status: "degraded"` with `reason: "all_coins_zero_supply"`
10. Log item count and date

---

## Database Schema

### supply_history (migration 0015)

```sql
CREATE TABLE IF NOT EXISTS supply_history (
  stablecoin_id TEXT NOT NULL,
  snapshot_date INTEGER NOT NULL,  -- UTC midnight epoch seconds
  circulating_usd REAL NOT NULL,
  price REAL,
  PRIMARY KEY (stablecoin_id, snapshot_date)
);

CREATE INDEX idx_supply_hist_date ON supply_history(snapshot_date DESC);
```

| Column | Type | Description |
|--------|------|-------------|
| `stablecoin_id` | TEXT | Canonical ticker-issuer ID (e.g. `usdt-tether`) |
| `snapshot_date` | INTEGER | Unix seconds floored to UTC midnight |
| `circulating_usd` | REAL | Total market cap in USD |
| `price` | REAL | USD price at snapshot time (may be `null`) |

The primary key `(stablecoin_id, snapshot_date)` enforces one row per coin per UTC day. The cron uses `INSERT OR REPLACE`, so re-runs on the same day are idempotent and refresh the row with the latest valid cached values.

### onchain_supply (migration 0013)

```sql
CREATE TABLE IF NOT EXISTS onchain_supply (
  stablecoin_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  supply REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (stablecoin_id, chain)
);
```

Per-chain supply cache. Not actively used by the current snapshot pipeline.

---

## Supply Data Source

**Primary source:** DefiLlama list API (`stablecoins.llama.fi/stablecoins`), cached every 15 minutes by `syncStablecoins()`.

**Key gotcha:** The list endpoint returns `circulating` values already in USD for all peg types. Do **not** multiply by price --- that double-converts. The detail endpoint (`stablecoins.llama.fi/stablecoin/{id}`) returns native currency values for non-USD pegs, but the list endpoint is already converted.

### sumPegBuckets()

**File:** `shared/lib/supply.ts`

```typescript
export function sumPegBuckets(obj: Record<string, number> | undefined): number {
  if (!obj) return 0;
  return Object.values(obj).reduce((s, v) => s + safeNum(v), 0);
}
```

Safely sums across all peg types (`peggedUSD`, `peggedEUR`, etc.). Invalid values (`null`, `NaN`, `Infinity`) are coerced to 0.

### Other supply helpers

All in `shared/lib/supply.ts`:

| Helper | Description |
|--------|-------------|
| `getCirculatingRaw(c)` | Calls `sumPegBuckets(c.circulating)` |
| `getPrevDayRaw(c)` | Previous day's circulating (for delta calculations) |
| `getPrevWeekRaw(c)` | Same for week |
| `getPrevMonthRaw(c)` | Same for month |

---


### Known decimal exceptions

Do not assume `18` decimals, or even one fixed decimal count per token across all chains. The authoritative source is `contracts[].decimals` in `shared/lib/stablecoins.ts`.

Current examples:

| Decimals | Example tokens |
|----------|----------------|
| 0 | EURCV, USDQ |
| 2 | EURCV, EURS, GUSD, USDCV |
| 4 | BRZ |
| 5 | USDC |
| 6 | USDC, USDT, PYUSD, RLUSD, FDUSD, XAUT, XSGD |
| 7 | AUDD, EURC, EURCV, EURS, PYUSD, USDC, USDY |
| 8 | VEUR |
| 9 | BUCK, FRXUSD, KAG, SBC, USDe, VCHF, VEUR, wsrUSD |
| 12 | UUSD |
| 13 | VEUR |
| 24 | cUSD |

---

## API Endpoints

### GET /api/supply-history

| Param | Required | Default | Constraints |
|-------|----------|---------|-------------|
| `stablecoin` | Yes | --- | Canonical Pharos stablecoin ID (legacy aliases are resolved) |
| `days` | No | 365 | Min 1, max 1825 (5 years) |

```sql
SELECT snapshot_date, circulating_usd, price
FROM supply_history
WHERE stablecoin_id = ? AND snapshot_date >= ?
ORDER BY snapshot_date ASC
```

**Response:** array of `{ date, circulatingUsd, price }`

**Cache profile:** slow (`s-maxage=3600`, `max-age=300`)

### GET /api/stablecoin/{id} (detail --- supply_history fallback)

For CoinGecko-only coins (ID starts with `cg-`), commodity tokens (gold/silver), or any coin where external APIs return no data, the detail endpoint falls back to the `supply_history` table and reconstructs the `DetailToken` format.

### POST /api/backfill-supply-history (admin)

Admin endpoint (requires `X-Admin-Key`). Backfills `supply_history` from:

- **Commodity tokens:** CoinGecko `market_chart`
- **Regular coins:** DefiLlama detail API

Other CoinGecko-only non-commodity tokens are skipped because the current backfill path has no historical supply source for them. Non-USD regular coins fetch historical prices for native-to-USD conversion. Batch processing uses `stablecoin`, `batch`, and `batchSize`.

---

## Frontend

### Hook: useSupplyHistory(id)

**File:** `src/hooks/use-stablecoins.ts`

- Fetches `/api/stablecoin/{id}` (detail API, not `/api/supply-history`)
- Transforms via `detailToSupplyHistory()`: tries `totalCirculatingUSD` first, falls back to `circulating`, filters zero values
- TanStack Query: `staleTime = 1 hour`, `refetchInterval = 2 hours`

### McapChart

**File:** `src/components/mcap-chart.tsx`

Individual stablecoin market cap history. Area chart with time range filtering (7d, 30d, 90d, all). Used on the stablecoin detail page.

### TotalMcapChart

**File:** `src/components/total-mcap-chart.tsx`

Aggregated market cap breakdown. Stacked chart showing USDT, USDC, USDS, DAI individually with "Other" as the remainder.

### Compare page

**File:** `src/app/compare/client.tsx`

Fetches individual supply histories for each selected coin. Side-by-side comparison charts.

---

## Error Handling

| Condition | Behavior |
|-----------|----------|
| `getCache()` returns `null` | Return degraded (`reason: "cache_missing"`) |
| Cache > 20 min old | Return degraded (`reason: "cache_stale"`) |
| No `peggedAssets` in payload | Return degraded (`reason: "cache_payload_missing_pegged_assets"`) |
| 0 prepared rows (all tracked coins missing/zero supply) | Return degraded (`reason: "all_coins_zero_supply"`) |
| < 80% of tracked coins have valid data | Log warning, continue |
| `batchExecute()` exception | Propagate to `logCronRun` error handler |

All cron runs are logged to the `cron_runs` table (7-day retention).

---

## Chain RPC Configuration

**File:** `worker/src/lib/chain-registry.ts`

Not used by the snapshot cron but available for future on-chain supply fetching.

| Category | Chains |
|----------|--------|
| EVM (Alchemy) | Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche, BSC |
| EVM (dRPC fallback) | Gnosis, Fantom, Celo |
| Tron | Alchemy or TronGrid |

**Strategy:** Alchemy primary, dRPC fallback, public RPC fallback.

---

## Key Constraints

1. Depends entirely on DefiLlama data (no on-chain verification)
2. Price may be `null` if DL price data is unavailable
3. One snapshot per UTC day (no intraday data)
4. Tron `balanceOf` subtraction not yet supported (needs base58-to-hex conversion)
6. Non-USD peg backfill requires historical prices (may fall back to current price)
7. Daily cron and admin backfill both use `INSERT OR REPLACE` for idempotent re-runs

---

## File Index

| File | Role |
|------|------|
| `worker/src/cron/snapshot-supply.ts` | Snapshot cron: reads cache, builds `INSERT OR REPLACE` statements, batch executes |
| `worker/src/api/supply-history.ts` | `GET /api/supply-history` handler |
| `worker/src/api/stablecoin-detail.ts` | Detail API with `supply_history` fallback for CG-only/commodity coins |
| `worker/src/api/backfill-supply-history.ts` | Admin backfill endpoint |
| `worker/src/lib/db.ts` | `batchExecute()`, `getCache()`, `logCronRun()` |
| `worker/src/lib/chain-registry.ts` | Unified chain mappings + chain RPC configs (future on-chain supply) |
| `worker/migrations/0015_supply_history.sql` | `supply_history` table |
| `worker/migrations/0013_onchain_supply.sql` | `onchain_supply` table (per-chain cache) |
| `shared/lib/supply.ts` | `sumPegBuckets()`, `getCirculatingRaw()`, other supply helpers |
| `shared/lib/psi-eligible.ts` | PSI-eligible tracked + shadow stablecoin registry used by the snapshot filter |
| `shared/lib/shadow-stablecoins.ts` | Shadow-asset metadata referenced by `PSI_ELIGIBLE_STABLECOINS` |
| `shared/types/index.ts` | `StablecoinMeta` types |
| `shared/lib/stablecoins.ts` | Stablecoin metadata |
| `src/hooks/use-stablecoins.ts` | `useSupplyHistory()` hook, `detailToSupplyHistory()` transform |
| `src/components/mcap-chart.tsx` | Individual mcap chart |
| `src/components/total-mcap-chart.tsx` | Aggregated mcap breakdown chart |
