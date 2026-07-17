# Supply Snapshot Pipeline

Daily market cap snapshot pipeline. Captures cached `peggedAssets` whose IDs are PSI-eligible, stores their circulating supply (in USD) in D1, and uses that history for charting and replay.

Shadow assets are part of PSI eligibility, but this cron only reads rows present in the cached `stablecoins` payload. Shadow-asset history therefore requires separate historical/backfill coverage unless a shadow asset is present in that cache.

The snapshot does **not** call upstream APIs or on-chain RPCs. DefiLlama remains the primary source for regular assets, but the cached payload can include CoinGecko gap-fill rows, DefiLlama history gap-fill rows, commodity/CoinGecko supplemental rows, on-chain-total-supply supplemental rows, and configured on-chain-circulating-supply rows assembled by the 15-minute `syncStablecoins()` cron.

When DefiLlama publishes a tracked zero-supply row for an asset that also has positive supplemental coverage, `syncStablecoins()` keeps the positive supplemental row. This prevents a zero-valued primary duplicate from suppressing current CoinGecko or commodity supply before the exact snapshot-coverage check runs.

---

## Cron Schedule

- **Primary schedule:** chained after each `*/15 * * * *` `sync-stablecoins` run (same-day upsert path after a safe stablecoins-cache write)
- **Safety-net fallback:** `0 8 * * *` (daily at 08:00 UTC)
- **Function:** `snapshotSupply(db: D1Database, signal?: AbortSignal, options?: SnapshotSupplyOptions): Promise<CronResult>`
- **File:** `worker/src/cron/snapshot-supply.ts`
- **Registration:** declared in `worker/wrangler.toml`; executed from both `worker/src/handlers/scheduled/quarter-hourly.ts` and `worker/src/handlers/scheduled/daily-0800.ts`

---

## Algorithm

1. Fetch, parse, and validate the cached "stablecoins" payload via `loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: false })`
2. For the 08:00 UTC safety-net fallback, require the `stablecoins` cache row to have `updated_at >= slotStartedAt`; if it still reflects the previous 07:45 quarter-hourly run, return `status: "degraded"` with `reason: "stablecoins_cache_before_slot"` and do not consume the daily write marker
3. Verify cache freshness:
   - Cache age > 1200 seconds (20 min): skip snapshot and return cron `status: "degraded"` with `reason: "cache_stale"`
   - Cache age > 600 seconds (10 min): log warning but proceed (degraded freshness)
4. Filter to `PSI_ELIGIBLE_STABLECOINS`; the eligibility registry owns the active and shadow composition
5. Floor current date/time to UTC midnight:
   ```typescript
   const snapshotDate = Math.floor(
     Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000
   );
   ```
6. Build the exact completion identity and check the once-per-UTC-date guard:
   - read cache key `snapshot-supply:last-write`
   - coverage-version 2 markers bind the UTC date to a SHA-256 digest of the sorted required active IDs plus the exact applied waiver IDs, owners, and expiries; count-only version 1 markers remain readable but cannot authorize a writer skip
   - when the marker date and digest match the current complete coverage evaluation, conditionally repair only same-day rows whose stored `price` is still `null` and whose current cache row now has a positive price; otherwise skip with `reason: "already_written_today"`
   - same-day repair never overwrites a non-null historical price, circulating supply, or rows outside cron ownership
7. For each PSI-eligible cached asset:
   - Sum circulating supply via `sumPegBuckets(asset.circulating)` --- already in USD
   - Skip if sum <= 0
   - Extract price (must be a number > 0, else `null`)
   - Build `INSERT OR REPLACE` statement
8. Exact-set data quality check: require every active registry ID to have positive cached supply or an owned, reasoned, unexpired publication waiver. Shadow rows are written when present but do not block active-universe completion. Missing cache IDs and present rows with invalid supply are named separately in `partial_snapshot_blocked` metadata.
9. Atomically replace the cron-owned rows for the UTC date and write the completion marker in one bounded D1 batch. Multi-row inserts stay below the 100-bind limit. Supply-row deletion is restricted to the union of current PSI-eligible IDs and the prior version 2 marker's sorted `ownedRowIds`, so same-day admin-backfill rows outside snapshot ownership are preserved.
10. If zero rows were prepared after passing the exact-set guard, return cron `status: "degraded"` with `reason: "all_coins_zero_supply"`; this is not normally reachable because the non-empty active set would fail the exact-set guard first
11. The same transaction updates cache key `snapshot-supply:last-write`; any statement failure rolls back the row replacement and marker together
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

The primary key `(stablecoin_id, snapshot_date)` enforces one row per coin per UTC day. The first complete run atomically replaces the cron-owned daily set. Later complete runs only fill a same-day `null` price from a current positive cache price, preserving the original circulating value and every non-null price. In the checked-in migration tree this table now lives in `worker/migrations/0000_baseline.sql`.

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
- **Write pattern:** atomic UTC-date replacement — delete the cron-owned date, multi-row `INSERT OR REPLACE` the recomputed aggregate, and write the same coverage-version 2 identity marker in one D1 batch. Re-runs therefore remove chains that disappeared from the aggregate instead of retaining stale rows.
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

**Supplemental on-chain exceptions:** `syncStablecoins()` can admit `detailProvider === "coingecko"` assets through a single-deployment on-chain supply fallback. The default label is `supplySource = "onchain-total-supply"`. For narrow protocol-inventory cases, the worker can subtract configured live holder balances from that same total-supply read and publish `supplySource = "onchain-circulating-supply"`; if any configured balance read fails, the fallback is skipped for that run. The snapshot cron records the cached USD total and does not repeat those RPC reads.

Configured protocol-inventory exclusions also participate in admin historical repair. `POST /api/backfill-supply-history` can rebuild their daily `supply_history` rows from EVM `totalSupply()` minus the same holder `balanceOf()` exclusions at the closest block before each UTC day close. Tangent USG uses this path for PegKeeper balances; rows are written with `price = null` when no replay-safe historical market price exists.

**Key gotcha:** The list endpoint returns `circulating` values already in USD for all peg types. Do **not** multiply by price --- that double-converts. The detail endpoint (`stablecoins.llama.fi/stablecoin/{id}`) returns native currency values for non-USD pegs, but the list endpoint is already converted.

### sumPegBuckets()

**File:** `shared/lib/supply.ts`

```typescript
export function sumPegBuckets(obj: Record<string, number> | null | undefined): number {
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

Do not assume `18` decimals, or even one fixed decimal count per token across all chains. The authoritative source is `contracts[].decimals` in the per-coin metadata assets under `shared/data/stablecoins/coins/*.json`, loaded via `shared/lib/stablecoins/registry.ts`. The exact exception set changes as metadata evolves; use the live metadata, not hardcoded examples.

---

## API Endpoints

### GET /api/supply-history

| Param | Required | Default | Constraints |
|-------|----------|---------|-------------|
| `stablecoin` | Yes | --- | Canonical Pharos stablecoin ID |
| `days` | No | 365 | Min 1, max 5000. Older dates depend on how much archival history has been ingested into `supply_history` through the cron plus admin backfills. |

```sql
SELECT snapshot_date, circulating_usd, price
FROM supply_history
WHERE stablecoin_id = ? AND snapshot_date >= ?
  AND snapshot_date <= ? -- when snapshot-supply:last-write exists
ORDER BY snapshot_date ASC
```

**Response:** array of `{ date, circulatingUsd, price }`

**Cache profile:** slow (`s-maxage=3600`, `max-age=300`). Responses include `X-Data-Age` from the `snapshot-supply:last-write` marker's `updated_at` when available, falling back to the latest served snapshot row only when the marker is absent. Rows newer than the completed daily snapshot marker are hidden so a failed chunked write cannot expose a partial latest day.

### GET /api/stablecoin/{id} (detail --- supply_history fallback)

For CoinGecko-only coins and commodity tokens (gold/silver), empty or stale external detail history falls back to the `supply_history` table and reconstructs the `DetailToken` format. DefiLlama-backed detail falls back to `supply_history` on upstream failure, circuit-open, parse-error, or exception paths; it does not currently use the empty/stale-history fallback unless the DefiLlama handler is extended. CoinGecko-derived history is treated as stale when its newest point is more than 72 hours behind wall clock time, which prevents per-coin charts from freezing on an old market-cap series when D1 already has fresher daily snapshots.

### POST /api/backfill-supply-history (admin)

Admin endpoint (requires Access service-token headers). Backfills `supply_history` from:

- **Commodity tokens:** CoinGecko `market_chart` market caps; when those caps are missing, historical EVM `totalSupply()` at each UTC day close for single-deployment assets; protocol TVL fallback only after those sources fail
- **CoinGecko-only and commodity detail providers:** CoinGecko `market_chart`
- **Configured protocol-inventory on-chain assets:** historical EVM `totalSupply()` minus configured holder balances
- **DefiLlama-backed regular coins:** DefiLlama detail API

When a historical market-price series is available for a coin, the backfill also persists daily `supply_history.price` on restored rows, including regular USD stablecoins. Historical PSI replay relies on that field to prefer day-level deviation over blunt `peak_deviation_bps` fallback.

The handler explicitly supports `detailProvider === "coingecko"` and `detailProvider === "commodity"` in addition to DefiLlama-backed assets. Non-USD regular coins fetch historical prices for native-to-USD conversion. Commodity and CoinGecko-only total-supply fallback reads replay historical blocks instead of projecting a current `totalSupply()` across the window, and it fails closed for multi-deployment assets that cannot be represented by exactly one supported EVM contract. Batch processing uses `stablecoin`, `batch`, and `batchSize`; optional `startDay` / `endDay` bounds limit the UTC daily rows written, with future `endDay` values clamped to the last completed UTC day.

---

## Frontend

### Hook: useSupplyHistory(id)

**File:** `src/hooks/use-stablecoins.ts`

- Fetches `/api/supply-history?stablecoin=<id>&days=<days>`
- Returns the response typed as `SupplyHistoryPoint[]`; the runtime query registry used by this hook attaches `SupplyHistoryResponseSchema` (`z.array(SupplyHistoryPointSchema)`), so the payload is runtime-validated in strict mode
- Returns normalized `{ date, circulatingUsd, price }` points directly; there is no detail-endpoint transform in the hook anymore
- TanStack Query: `staleTime = 24 hours`, `refetchInterval = 48 hours` (derived from the daily `CRON_24H` producer interval)

### McapChart

**File:** `src/components/mcap-chart.tsx`

Individual stablecoin market cap history. Area chart with time range filtering (7d, 30d, 90d, 1y, all). Used on the stablecoin detail page.

### HomeAltHero Market-Cap Chart

**File:** `src/components/home-alt-hero.tsx`

Aggregated homepage market-cap breakdown. The total series comes from `GET /api/stablecoin-charts`, whose cached historical backbone starts from DefiLlama aggregate chart data but is reconciled with structural supplemental tracked-asset daily history from D1 `supply_history` before publication. The endpoint then appends or replaces the trailing point with a live aggregate from the current `stablecoins` cache so the homepage chart headline matches the KPI card. The named buckets use per-coin `useSupplyHistory(...)` data and `buildTotalMcapChartRows(...)` in `src/lib/total-mcap-chart.ts` so the homepage breakdown has full-history coverage instead of the shorter `supply_history` window. Those per-coin histories are aligned to the latest point at or before each total-chart date before computing `Others`. The visible stacks are USDT, USDC, `USDS + DAI`, and `Others`.

### Compare page

**File:** `src/app/compare/client.tsx`

The compare data model fetches per-coin `/api/supply-history` series directly through `useQueries()` in `src/hooks/use-compare-data-model.ts`. Side-by-side comparison charts do not depend on `GET /api/stablecoin/:id`.

---

## Error Handling

| Condition | Behavior |
|-----------|----------|
| `loadStablecoinsCache()` returns `kind !== "ok"` | Return degraded with the loader reason (`missing-cache`, `json-parse-failed`, `invalid-payload-shape`, `missing-pegged-assets`, `legacy-array-not-allowed`, or `filtered-malformed-entries`) |
| Cache > 20 min old | Return degraded (`reason: "cache_stale"`) |
| Today's UTC snapshot has a version 2 marker matching the current exact ID/waiver digest | Skip write (`reason: "already_written_today"`) |
| 0 prepared rows with a non-empty active set | Return degraded without writing rows (`reason: "partial_snapshot_blocked"`) via the exact-set guard |
| 0 prepared rows after passing the exact-set guard | Return degraded (`reason: "all_coins_zero_supply"`); not normally reachable while the active set is non-empty |
| Any active ID lacks valid supply and no owned unexpired waiver applies | Return degraded with named `missingActiveIds`, `missingCacheActiveIds`, and `invalidSupplyIds`; do not write the completion marker |
| Atomic date-replacement exception (non-abort) | Roll back rows and marker together, `recordCronFailure()`, then return degraded (`reason: "db_write_failed"`); abort errors are re-thrown via `rethrowIfAborted` |

All cron runs are logged to the `cron_runs` table (7-day retention).

---

## Key Constraints

1. Depends entirely on the strict cached `stablecoins` payload; the snapshot job itself performs no upstream API or RPC reads
2. Price may be `null` if DL price data is unavailable
3. One snapshot per UTC day (no intraday data)
4. Strict cache loading means malformed or legacy array payloads fail closed instead of snapshotting partial data
5. DefiLlama-backed non-USD backfills require historical prices for native-to-USD conversion
6. Daily cron and admin backfill both use `INSERT OR REPLACE` for idempotent re-runs; the cron scopes replacement deletes by marker-owned/current PSI IDs so unrelated admin rows survive
7. The write path is guarded by a once-per-UTC-date version 2 exact-identity check on the `snapshot-supply:last-write` marker (the first healthy run after UTC midnight writes the single daily snapshot) even though the cron is chained to the 15-minute lane
8. `supply_history` is kept as an archive for downstream historical replays such as PSI backfills; recover older gaps with the admin backfill when needed
9. The date replacement and daily completion marker commit in the same D1 transaction. A failure leaves the prior rows and marker intact and the changed identity retryable.
