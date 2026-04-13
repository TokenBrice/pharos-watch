# Supply Snapshot Pipeline

Daily market cap snapshot pipeline. Captures each PSI-eligible stablecoin's circulating supply (in USD) once per day from cached DefiLlama data and stores it in D1 for historical charting.

The snapshot does **not** call on-chain RPCs --- it relies entirely on DefiLlama's aggregated supply data cached by the 15-minute `syncStablecoins()` cron.

---

## Cron Schedule

- **Primary schedule:** chained after each `*/15 * * * *` `sync-stablecoins` run (same-day upsert path after a safe stablecoins-cache write)
- **Safety-net fallback:** `0 8 * * *` (daily at 08:00 UTC)
- **Function:** `snapshotSupply(db: D1Database): Promise<CronResult>`
- **File:** `worker/src/cron/snapshot-supply.ts`
- **Registration:** declared in `worker/wrangler.toml`; executed from both `worker/src/handlers/scheduled/quarter-hourly.ts` and `worker/src/handlers/scheduled/daily-0800.ts`

---

## Algorithm

1. Fetch the cached "stablecoins" payload from the D1 cache table
2. Verify cache freshness:
   - Cache age > 1200 seconds (20 min): skip snapshot and return cron `status: "degraded"` with `reason: "cache_stale"`
   - Cache age > 600 seconds (10 min): log warning but proceed (degraded freshness)
3. Parse and validate the cached payload via `loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: false })`
4. Filter to only `PSI_ELIGIBLE_STABLECOINS` (currently 193 entries: 191 tracked + 2 shadow)
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
7. Check the cooldown guard:
   - read cache key `snapshot-supply:last-write`
   - if the previous successful write is < 1 hour old, skip with `reason: "cooldown_active"`
8. Data quality check: warn if fewer than 80% of expected coins have valid data
9. Execute all statements via `batchExecute()` (batch size = 100, D1 limit)
10. If zero rows were prepared, return cron `status: "degraded"` with `reason: "all_coins_zero_supply"`
11. Update cache key `snapshot-supply:last-write`
12. Log item count and date

---

## Database Schema

### supply_history

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

The primary key `(stablecoin_id, snapshot_date)` enforces one row per coin per UTC day. The cron uses `INSERT OR REPLACE`, so re-runs on the same day are idempotent and refresh the row with the latest valid cached values. In the checked-in migration tree this table now lives in `worker/migrations/0000_baseline.sql`.

### onchain_supply

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

### chain_supply_history

```sql
CREATE TABLE IF NOT EXISTS chain_supply_history (
  chain_id TEXT NOT NULL,
  snapshot_date INTEGER NOT NULL,  -- UTC midnight epoch seconds
  total_usd REAL NOT NULL,
  stablecoin_count INTEGER NOT NULL,
  PRIMARY KEY (chain_id, snapshot_date)
);
```

| Column | Type | Description |
|--------|------|-------------|
| `chain_id` | TEXT | Canonical chain identifier after shared resolver normalization (e.g. `ethereum`, `bsc`, `citrea`) |
| `snapshot_date` | INTEGER | Unix seconds floored to UTC midnight |
| `total_usd` | REAL | Total stablecoin supply on this chain in USD |
| `stablecoin_count` | INTEGER | Number of distinct stablecoins contributing supply on this chain |

- **Populated by:** `snapshot-chain-supply` cron stage (`worker/src/cron/snapshot-chain-supply.ts`) running in the `*/15 * * * *` quarter-hourly slot, chained after `snapshot-supply`.
- **Normalization:** the cron canonicalizes raw DefiLlama chain labels through the shared chain resolver before writing, so display-name aliases and tracked metadata names collapse into the same `chain_id`.
- **Write pattern:** `INSERT OR REPLACE` — idempotent, re-runs on the same day refresh the row.
- **Volume:** ~50 rows/day (one row per active chain per UTC day).
- **Primary use:** future trend charts on chain profile pages (`/chains/[chain]/`). The live `/api/chains` leaderboard does not read this table — it computes aggregates on-the-fly from the stablecoins cache.
- **Recoverability status:** historical rows written before the 2026-04-08 resolver fix are not approved for public charting. The retained D1 data does not include archived historical `stablecoins` cache payloads, so pre-fix chain splits cannot be reconstructed exactly. Any future public chain-history surface must start from a post-fix baseline date unless an audited export/purge plan is executed first.
- **Publication guard:** if a fresh stablecoins cache produces zero valid per-chain rows, the cron returns `status: "degraded"` with `reason: "no-valid-chain-rows"` and skips the write instead of overwriting the historical series with an empty snapshot.
- **Current migration note:** this table is part of `worker/migrations/0000_baseline.sql` in the post-squash migration tree.

---

## Supply Data Source

**Primary source:** DefiLlama list API (`stablecoins.llama.fi/stablecoins`), cached every 15 minutes by `syncStablecoins()`.

**Tracked gap-fill exceptions:** `syncStablecoins()` now has two history-repair lanes for tracked DefiLlama-backed assets:

- If one or more known metadata deployments are missing from DefiLlama's `chainCirculating`, and CoinGecko reports a materially higher total market cap, the worker repairs the current plus 1d/7d/30d total supply buckets from recent CoinGecko market-cap history and tags the asset `supplySource = "coingecko-gap-fill"`. This fixes undercounted multichain totals such as issuer-backed coins whose XRPL / Stellar supply lags or is absent in DefiLlama coverage.
- If the DefiLlama live list collapses a tracked asset to zero supply but recent DefiLlama chart history still has a fresh non-zero total, the worker repairs the current plus 1d/7d/30d total supply buckets from that chart history and tags the asset `supplySource = "defillama-history-gap-fill"`. This covers list-endpoint regressions such as TRYB where the per-chain live row zeroes out while DefiLlama history remains populated.

The snapshot cron records those repaired USD totals as-is.

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
| `getPrevMonthRawOrNull(c)` | Same for month (returns `null` if unavailable) |

---


### Decimal handling

Do not assume `18` decimals, or even one fixed decimal count per token across all chains. The authoritative source is `contracts[].decimals` in the metadata assets under `shared/data/stablecoins/*.json`, loaded via `shared/lib/stablecoins/index.ts`. The exact exception set changes as metadata evolves; use the live metadata, not hardcoded examples.

---

## API Endpoints

### GET /api/supply-history

| Param | Required | Default | Constraints |
|-------|----------|---------|-------------|
| `stablecoin` | Yes | --- | Canonical Pharos stablecoin ID |
| `days` | No | 365 | Min 1, max 1825 (5 years requested). Older dates depend on how much archival history has been ingested into `supply_history` through the cron plus admin backfills. |

```sql
SELECT snapshot_date, circulating_usd, price
FROM supply_history
WHERE stablecoin_id = ? AND snapshot_date >= ?
ORDER BY snapshot_date ASC
```

**Response:** array of `{ date, circulatingUsd, price }`

**Cache profile:** slow (`s-maxage=3600`, `max-age=300`)

### GET /api/stablecoin/{id} (detail --- supply_history fallback)

For CoinGecko-only coins, commodity tokens (gold/silver), or any coin where external detail APIs return empty or stale history, the detail endpoint falls back to the `supply_history` table and reconstructs the `DetailToken` format. CoinGecko-derived history is treated as stale when its newest point is more than 72 hours behind wall clock time, which prevents per-coin charts from freezing on an old market-cap series when D1 already has fresher daily snapshots.

### POST /api/backfill-supply-history (admin)

Admin endpoint (requires Access service-token headers). Backfills `supply_history` from:

- **Commodity tokens:** CoinGecko `market_chart`
- **CoinGecko-only and commodity detail providers:** CoinGecko `market_chart`
- **DefiLlama-backed regular coins:** DefiLlama detail API

When a historical market-price series is available for a coin, the backfill also persists daily `supply_history.price` on restored rows, including regular USD stablecoins. Historical PSI replay relies on that field to prefer day-level deviation over blunt `peak_deviation_bps` fallback.

The handler explicitly supports `detailProvider === "coingecko"` and `detailProvider === "commodity"` in addition to DefiLlama-backed assets. Non-USD regular coins fetch historical prices for native-to-USD conversion. Batch processing uses `stablecoin`, `batch`, and `batchSize`.

---

## Frontend

### Hook: useSupplyHistory(id)

**File:** `src/hooks/use-stablecoins.ts`

- Fetches `/api/supply-history?stablecoin=<id>&days=<days>`
- Validates the response with `SupplyHistoryResponseSchema` from `@shared/types`
- Returns normalized `{ date, circulatingUsd, price }` points directly; there is no detail-endpoint transform in the hook anymore
- TanStack Query: `staleTime = 1 hour`, `refetchInterval = 2 hours`

### McapChart

**File:** `src/components/mcap-chart.tsx`

Individual stablecoin market cap history. Area chart with time range filtering (7d, 30d, 90d, all). Used on the stablecoin detail page.

### TotalMcapChart

**File:** `src/components/total-mcap-chart.tsx`

Aggregated market cap breakdown. The total series comes from the downsampled `stablecoin-charts` cache. The named buckets use each coin's cached detail history (`GET /api/stablecoin/:id`) so the homepage breakdown has full-history coverage instead of the shorter `supply_history` window. Those per-coin histories are aligned to the latest point at or before each total-chart date before computing `Others`. The visible stacks are USDT, USDC, `USDS + DAI`, and `Others`.

### Compare page

**File:** `src/app/compare/client.tsx`

The compare data model fetches per-coin `/api/supply-history` series directly through `useQueries()` in `src/hooks/use-compare-data-model.ts`. Side-by-side comparison charts do not depend on `GET /api/stablecoin/:id`.

---

## Error Handling

| Condition | Behavior |
|-----------|----------|
| `loadStablecoinsCache()` returns `kind !== "ok"` | Return degraded with the loader reason (`missing-cache`, `json-parse-failed`, `invalid-payload-shape`, `missing-pegged-assets`, or `legacy-array-not-allowed`) |
| Cache > 20 min old | Return degraded (`reason: "cache_stale"`) |
| Successful write < 1 hour ago | Skip write (`reason: "cooldown_active"`) |
| 0 prepared rows (all tracked coins missing/zero supply) | Return degraded (`reason: "all_coins_zero_supply"`) |
| < 80% of tracked coins have valid data | Log warning, continue |
| `batchExecute()` exception | Propagate to `logCronRun` error handler |

All cron runs are logged to the `cron_runs` table (7-day retention).

---

## Key Constraints

1. Depends entirely on DefiLlama data (no on-chain verification)
2. Price may be `null` if DL price data is unavailable
3. One snapshot per UTC day (no intraday data)
4. Strict cache loading means malformed or legacy array payloads fail closed instead of snapshotting partial data
5. DefiLlama-backed non-USD backfills require historical prices for native-to-USD conversion
6. Daily cron and admin backfill both use `INSERT OR REPLACE` for idempotent re-runs
7. The write path is intentionally throttled by a 1-hour cooldown cache key even though the cron is chained to more frequent lanes
8. `supply_history` is kept as an archive for downstream historical replays such as PSI backfills; recover older gaps with the admin backfill when needed

---

## File Index

| File | Role |
|------|------|
| `worker/src/cron/snapshot-supply.ts` | Snapshot cron: reads cache, builds `INSERT OR REPLACE` statements, batch executes |
| `worker/src/cron/snapshot-chain-supply.ts` | Chain-level snapshot cron: aggregates per-chain totals from stablecoins cache → `chain_supply_history` |
| `worker/migrations/0000_baseline.sql` | Baseline schema for `supply_history`, `onchain_supply`, and `chain_supply_history` |
| `worker/src/api/supply-history.ts` | `GET /api/supply-history` handler |
| `worker/src/api/stablecoin-detail.ts` | Detail API with `supply_history` fallback for CG-only/commodity coins |
| `worker/src/api/backfill-supply-history.ts` | Admin backfill endpoint |
| `worker/src/lib/db.ts` | `batchExecute()` helper used by snapshot and backfill writes |
| `worker/src/lib/db-cache.ts` | `getCache()` cache-row access helpers |
| `worker/src/lib/cron-logger.ts` | `CronResult` type and `logCronRun()` wrapper used by scheduled handlers |
| `worker/src/lib/stablecoins-cache.ts` | Strict/lenient stablecoins-cache loader and failure reasons |
| `shared/lib/supply.ts` | `sumPegBuckets()`, `getCirculatingRaw()`, other supply helpers |
| `shared/lib/psi-eligible.ts` | PSI-eligible tracked + shadow stablecoin registry used by the snapshot filter |
| `shared/lib/shadow-stablecoins.ts` | Shadow-asset metadata referenced by `PSI_ELIGIBLE_STABLECOINS` |
| `shared/types/index.ts` | `StablecoinMeta` types |
| `shared/lib/stablecoins/index.ts` | Stablecoin metadata loader backed by `shared/data/stablecoins/*.json` |
| `src/hooks/use-stablecoins.ts` | `useSupplyHistory()` hook for `/api/supply-history` |
| `src/hooks/use-compare-data-model.ts` | Compare-page supply-history queries |
| `src/components/mcap-chart.tsx` | Individual mcap chart |
| `src/components/total-mcap-chart.tsx` | Aggregated mcap breakdown chart |
