# Supply Snapshot Pipeline

Daily market cap snapshot pipeline. Captures non-restored cached `peggedAssets` whose IDs are PSI-eligible, stores their circulating supply (in USD) in D1, and uses that history for charting and replay.

Shadow assets are part of PSI eligibility, but this cron only reads non-restored rows present in the cached `stablecoins` payload. Shadow-asset history therefore requires separate historical/backfill coverage unless a non-restored shadow asset is present in that cache.

The snapshot does **not** call upstream APIs or on-chain RPCs. DefiLlama remains the primary source for regular assets, but the cached payload can include CoinGecko missing-chain remainder attributions, DefiLlama history gap-fill rows, commodity/CoinGecko supplemental rows, on-chain-total-supply supplemental rows, and configured on-chain-circulating-supply rows assembled by the 15-minute `syncStablecoins()` cron.

> **Agent navigation** — Grep the heading you need: Cron Schedule · Algorithm · Database Schema · Supply Data Source · API Endpoints · Frontend · Error Handling · Key Constraints · Supply Pipeline · Circuit Breakers · DefiLlama list vs detail API.

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

1. Fetch, parse, and validate the object-shaped cached "stablecoins" payload via `loadStablecoinsCache(db, { mode: "strict" })`
2. For the 08:00 UTC safety-net fallback, require the `stablecoins` cache row to have `updated_at >= slotStartedAt`; if it still reflects the previous 07:45 quarter-hourly run, return `status: "degraded"` with `reason: "stablecoins_cache_before_slot"` and do not consume the daily write marker --- unless the UTC day is already complete under the current coverage identity, in which case the run returns healthy with `reason: "already_written_today_before_freshness_gate"`
3. Verify cache freshness (both snapshot crons derive these gates from the `sync-stablecoins` producer cadence — 900 s via the shared cache-freshness lane — instead of unanchored literals):
   - Cache age > 1800 seconds (two producer intervals): skip snapshot and return cron `status: "degraded"` with `reason: "cache_stale"`
   - Cache age > 900 seconds (one producer interval): log warning but proceed (degraded freshness)
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
   - when the marker date and digest match the current complete coverage evaluation, conditionally repair only same-day rows whose stored `price` is still `null` and whose current non-restored cache row now has a positive price; otherwise skip with `reason: "already_written_today"`
   - same-day repair never overwrites a non-null historical price, circulating supply, or rows outside cron ownership
7. For each PSI-eligible cached asset:
   - Skip rows marked `supplyRestored === true`; carried-forward supply is not a fresh daily observation
   - Sum circulating supply via `sumPegBuckets(asset.circulating)` --- already in USD
   - Skip if sum <= 0
   - Extract price (must be a number > 0, else `null`)
   - Build `INSERT OR REPLACE` statement
8. Exact-set data quality check: require every active registry ID to have positive cached supply (fresh or restored) or an owned, reasoned, unexpired publication waiver. Restored-only active IDs are deliberate exclusions, not coverage gaps: the snapshot still writes every fresh observation, skips the restored rows, and returns `status: "degraded"` with `reason: "snapshot_written_restored_skipped"` naming `restoredOnlyIds`. Genuinely missing cache IDs and invalid-supply rows still block via `partial_snapshot_blocked` metadata (`missingActiveIds`, `missingCacheActiveIds`, `invalidSupplyIds`). Non-restored shadow rows are written when present but do not block active-universe completion. When a required ID that was restored at write time later produces a fresh observation the same UTC day, the snapshot re-writes the date atomically so its row stops missing.
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
| `stablecoin_count` | INTEGER | Number of core-aggregate active stablecoins (`CORE_AGGREGATE_ACTIVE_IDS`) with positive supply on this chain |

- **Populated by:** `snapshot-chain-supply` cron stage (`worker/src/cron/snapshot-chain-supply.ts`) running in the `*/15 * * * *` quarter-hourly slot, chained after `snapshot-supply`.
- **Cache admission gate:** `snapshot-chain-supply` applies the same producer-cadence freshness gate as `snapshot-supply` — it skips with `status: "degraded"` and `reason: "cache_stale"` once the stablecoins cache is older than two `sync-stablecoins` intervals (> 1800 s).
- **Normalization:** the cron preserves upstream/display labels as `chainCirculating` object keys for compatibility, while producers attach an optional canonical `chainId`; the shared resolver uses that explicit ID first and falls back to the label for older or malformed rows before writing `chain_id`.
- **Write pattern:** atomic UTC-date replacement — delete the cron-owned date, multi-row `INSERT OR REPLACE` the recomputed aggregate, and write the same coverage-version 2 identity marker in one D1 batch. Re-runs therefore remove chains that disappeared from the aggregate instead of retaining stale rows.
- **Volume:** ~50 rows/day (one row per active chain per UTC day).
- **Primary use:** future trend charts on chain profile pages (`/chains/[chain]/`). The live `/api/chains` leaderboard does not read this table — it computes aggregates on-the-fly from the stablecoins cache.
- **Recoverability status:** historical rows written before the 2026-04-08 resolver fix are not approved for public charting. The retained D1 data does not include archived historical `stablecoins` cache payloads, so pre-fix chain splits cannot be reconstructed exactly. Any future public chain-history surface must start from a post-fix baseline date unless an audited export/purge plan is executed first.
- **Publication guard:** if a fresh stablecoins cache produces zero valid per-chain rows, the cron returns `status: "degraded"` with `reason: "no-valid-chain-rows"` and skips the write instead of overwriting the historical series with an empty snapshot.
- **Current migration note:** this table is part of `worker/migrations/0000_baseline.sql` in the post-squash migration tree.

---

## Supply Data Source

**Primary source:** DefiLlama list API (`stablecoins.llama.fi/stablecoins`), cached every 15 minutes by `syncStablecoins()`.

**Tracked gap-fill exceptions:** `syncStablecoins()` now has three supply-reconciliation lanes for tracked DefiLlama-backed assets:

- If exactly one known metadata deployment is missing from DefiLlama's `chainCirculating`, CoinGecko reports a materially higher total market cap, and the current CoinGecko history point is fresh, the worker attributes the positive remainder (`CoinGecko total - DefiLlama list total`, floored at zero) to that chain's `chainCirculating` buckets. It preserves the DefiLlama list totals and `supplySource = "defillama"`; stale current points and multiple missing deployments fail closed without attribution.
- If the DefiLlama live list collapses a tracked asset to zero supply but recent DefiLlama chart history still has a fresh non-zero total, the worker repairs the current plus 1d/7d/30d total supply buckets from that chart history and tags the asset `supplySource = "defillama-history-gap-fill"`. This covers list-endpoint regressions such as TRYB where the per-chain live row zeroes out while DefiLlama history remains populated.
- If a tracked asset collapses to zero supply and DefiLlama chart history is missing, stale, or below the $1M current-point floor, the worker falls back to the curated on-chain aggregate read (`applyCuratedOnChainSupplyGap`) and republishes the asset as `supplySource = "onchain-total-supply"`, rewriting `chainCirculating` and clearing the 1d/7d/30d buckets; an unreadable leg fails closed and leaves the zero row untouched.

The snapshot cron records the canonical DefiLlama list totals as-is; only the single-chain CoinGecko remainder is retained in the cached per-chain map. Synthetic and supplemental rows keep their display-label keys and carry `chainId` when the producer knows the canonical identity, so downstream aggregation does not need to infer identity from presentation text.

`canonicalizeChainCirculating()` retains the label fallback for legacy or upstream rows that have no usable `chainId`. That tolerance is intentional: the Safety Score V9 supply extension still receives raw upstream labels and pools unrecognized labels into its reviewed uncanonicalized-chain-label control path rather than silently assigning them to a different chain.

**Supplemental on-chain exceptions:** `syncStablecoins()` can admit `detailProvider === "coingecko"` assets through an on-chain supply fallback: a curated multi-deployment aggregate read (`fetchCuratedAggregateOnChainMcap`, which fails closed when any configured leg is unreadable and can reallocate a canonical chain's supply across representation legs) where one is configured, otherwise a single-deployment `totalSupply()` read. The default label is `supplySource = "onchain-total-supply"`. For narrow protocol-inventory cases, the worker can subtract configured live holder balances from that same total-supply read and publish `supplySource = "onchain-circulating-supply"`; if any configured balance read fails, the fallback is skipped for that run. The snapshot cron records the cached USD total and does not repeat those RPC reads.

Configured protocol-inventory exclusions also participate in admin historical repair. `POST /api/backfill-supply-history` can rebuild their daily `supply_history` rows from EVM `totalSupply()` minus the same holder `balanceOf()` exclusions at the closest block before each UTC day close. Every repaired row requires a replay-safe historical market price; the only explicit par-policy exception is the code-owned Base Dollar allowlist entry, which records price `1`. Tangent USG uses this path for PegKeeper balances and skips days without a historical price.

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
- **Reviewed single-contract USD supplemental assets:** historical EVM `totalSupply()` at each UTC day close, requiring a historical USD price unless the asset is in the explicit code-owned par-policy allowlist (currently BD, whose documented direct redemption supports price `1`)
- **Configured protocol-inventory on-chain assets:** historical EVM `totalSupply()` minus configured holder balances
- **DefiLlama-backed regular coins:** DefiLlama detail API

On-chain `totalSupply()` and configured inventory-exclusion backfills persist a historical `supply_history.price` on every written row and skip days without one, except for the explicit Base Dollar par-policy price of `1`. Historical PSI replay relies on that field to prefer day-level deviation over blunt `peak_deviation_bps` fallback.

The handler explicitly supports `detailProvider === "coingecko"` and `detailProvider === "commodity"` in addition to DefiLlama-backed assets. Non-USD regular coins fetch historical prices for native-to-USD conversion. Commodity and CoinGecko-only total-supply fallback reads replay historical blocks instead of projecting a current `totalSupply()` across the window, and it fails closed for multi-deployment assets that cannot be represented by exactly one supported EVM contract. Batch processing uses `stablecoin`, `batch`, and `batchSize`; optional `startDay` / `endDay` bounds limit the UTC daily rows written, with future `endDay` values clamped to the last completed UTC day.

---

## Frontend

### Hook: useSupplyHistory(id)

**File:** `src/hooks/use-stablecoins.ts`

- Fetches `/api/supply-history?stablecoin=<id>&days=<days>`
- Returns the response typed as `SupplyHistoryPoint[]`; the runtime query registry used by this hook attaches `SupplyHistoryResponseSchema` (`z.array(SupplyHistoryPointSchema)`), so the payload is runtime-validated in strict mode
- Returns normalized `{ date, circulatingUsd, price }` points directly; there is no detail-endpoint transform in the hook anymore
- TanStack Query: `staleTime = 24 hours`, `refetchInterval = 48 hours` (derived from the `CRON_SUPPLY_SNAPSHOT` producer interval, i.e. `CRON_INTERVALS["snapshot-supply"]` = one day)

### McapChart

**File:** `src/components/mcap-chart.tsx`

Individual stablecoin market cap history. Area chart with time range filtering (7d, 30d, 90d, 1y, all). Used on the stablecoin detail page.

### HomeAltHero Market-Cap Chart

**File:** `src/components/home-alt-hero.tsx`

Aggregated homepage market-cap breakdown. The total series comes from `GET /api/stablecoin-charts`, whose cached historical backbone starts from DefiLlama aggregate chart data but is reconciled with structural supplemental tracked-asset daily history from D1 `supply_history` before publication. The endpoint serves that cached series as published and no longer splices a live trailing point from the `stablecoins` cache, so the chart's last point can trail the KPI card until the next `sync-stablecoin-charts` run. The named buckets use per-coin `useSupplyHistory(...)` data and `buildTotalMcapChartRows(...)` in `src/lib/total-mcap-chart.ts` so the homepage breakdown has full-history coverage instead of the shorter `supply_history` window. Those per-coin histories are aligned to the latest point at or before each total-chart date before computing `Others`. The chart fills a gray total-market-cap envelope with the USDT cohort area beneath it (both baselined at zero, not stacked) and overlays cohort lines for USDC, `USDS + DAI`, `Others`, and a dashed `Non-USD share`.

### Compare page

**File:** `src/app/compare/page.tsx` (lazily loads `src/components/compare/compare-client.tsx`)

The compare data model fetches per-coin `/api/supply-history` series directly through `useQueries()` in `src/hooks/use-compare-data-model.ts`. Side-by-side comparison charts do not depend on `GET /api/stablecoin/:id`.

---

## Error Handling

| Condition | Behavior |
|-----------|----------|
| `loadStablecoinsCache()` returns `kind !== "ok"` | Return degraded with the loader reason (`missing-cache`, `json-parse-failed`, `invalid-payload-shape`, `missing-pegged-assets`, `filtered-malformed-entries`, `published-contract-invalid`, or `cache-read-failed`); a legacy array payload fails as `invalid-payload-shape` |
| Cache older than two producer intervals (> 1800 s) | Return degraded (`reason: "cache_stale"`) |
| Today's UTC snapshot has a version 2 marker matching the current exact ID/waiver digest and no required ID recovered since that write | Skip the row write (`reason: "already_written_today"`, or `"repaired_missing_prices_today"` when the same-day pass filled null prices) |
| Same-day null-price repair query fails | `recordCronFailure()`, then return degraded (`reason: "same_day_price_repair_failed"`) |
| 0 prepared rows with a non-empty active set | Return degraded without writing rows (`reason: "partial_snapshot_blocked"`) via the exact-set guard |
| 0 prepared rows after passing the exact-set guard | Return degraded (`reason: "all_coins_zero_supply"`); not normally reachable while the active set is non-empty |
| Any active ID lacks cached supply entirely or has invalid supply without an owned unexpired waiver | Return degraded with named `missingActiveIds`, `missingCacheActiveIds`, and `invalidSupplyIds`; do not write the completion marker |
| Any required active ID is present only as restored | Write all fresh observations, skip the restored rows, return degraded (`reason: "snapshot_written_restored_skipped"`) naming `restoredOnlyIds`; a same-day recovery re-writes the date |
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

## Supply Pipeline

Supply data uses a two-source model with automatic fallback:

- **DefiLlama** — primary source for all stablecoins tracked by DefiLlama's stablecoin API
- **CoinGecko market cap** — used for gold/silver/fiat tokens that DefiLlama doesn't track (e.g. XAUT, PAXG, KAU), and as a **full supply fallback** when the DefiLlama stablecoins API is down (circuit breaker triggers `syncViaCoingeckoFallback()`)

Manual supply corrections, CMC supply patches, and open-ended on-chain overrides remain disallowed. Curated on-chain reads are code-reviewed fallback paths with explicit asset scope and fail-closed behavior.

V9-only bridge attribution runs on the dedicated `+8` expression. The V9 fixed input is then prepared immediately after successful half-hourly DEX publication, carrying that exact DEX generation ID, and canonical compilation runs at `+22` and `+52`. The compiler rejects an input when its DEX dependency is older than the latest accepted DEX generation. The isolated attribution and compilation lanes acquire a D1-backed memory-lane lease, bind to the immutable current Worker version ID and matching finished core slot, decline admission while an earlier scheduled slot is still active, and enforce absolute deadlines. An `ok` core slot admits directly. A degraded slot admits only when the durable publication ledger proves that the same Worker published the current `stablecoins` cache during that slot, and the compiler separately requires the fixed input's stablecoin timestamp to match the live cache generation. This keeps partial active-row coverage visible and asset-local without admitting stale or no-write stablecoin data. Delayed or competing deliveries skip neutrally; missing Worker-version metadata degrades visibly. The critical quarter-hour production lane is stablecoins → DDR; the atomic report-card publication that feeds V9 runs separately, on the half-hourly `16,46` chart slot (`prepare-safety-score-v9-input`, after DEX publication). That atomic publication includes a compact, publication-exact V9 peg-provenance seed; the later V9 compiler rejects missing, partial, or identity-mismatched seeds rather than reconstructing provenance from mutable event rows.

XAUT has a bounded, V9-only lock/mint attribution for its otherwise aggregate-only upstream row. Inside the isolated producer, the XAUT observer first reads the reviewed `https://app.tether.to/transparency.json` source. It requires exactly one XAUT Ethereum row, captures the raw response hash and issuer timestamp, converts `totalAuthorized`, `notIssued`, and `quarantined` to exact six-decimal raw units, rejects future or older-than-48-hour disclosures, and requires quarantined supply to be zero. It then selects one finalized Ethereum block at or before the scoring clock and reads canonical `totalSupply()`, the pinned Tether treasury and official XAUt0 OFT adapter `balanceOf()` values, and the adapter's token/LayerZero endpoint identity in one Multicall. The disclosure's authorized amount must equal finalized total supply and its not-issued amount must equal the finalized treasury balance. V9 therefore divides the locked adapter balance by circulating liabilities (`totalAuthorized - notIssued`), not by minted ERC-20 supply. It hash-binds and confirms the block, verifies canonical token and adapter proxy/implementation identities, and binds the result to the exact reviewed XAUt0 `representationId` route inventory. The non-group circulating liability is attributed to Ethereum and the adapter balance becomes one reviewed XAUt0 representation-group row. The group carries the exact aggregate share and common lockbox/protocol failure domains, but no destination-chain allocation; individual destination routes never receive inferred zero shares. Packet observation time is the later of the confirmed block and issuer disclosure timestamps, while validation independently ages both inputs. The partition conserves the upstream USD liability exactly and never sums destination representations on top of their locked backing. Missing, stale, skewed, identity-drifted, disclosure/on-chain-mismatched, inventory-drifted, non-conserving, or materially large pooled evidence fails closed to aggregate-only bridge materiality. Its admission journal truthfully identifies the source as issuer-disclosure-plus-on-chain, records an allowlisted exact leaf rejection code, and retains the rejected source timestamp for disclosure skew/staleness or stale finalized state without persisting response bodies, URLs, or free-form diagnostics. A persisted generation whose only rejection is XAUT `transparency-stale` remains cron-healthy, with diagnostic rejected-asset metadata, because the producer observed the expected inventory and the scoring fallback is bounded.

The reviewed deployment-unit path also covers the explicitly allowlisted Centrifuge V3 JTRSY and ACRDX inventories. Those assets qualify because the protocol burns source-chain shares before hub-authorized destination minting, so complete deployment `totalSupply()` units form one non-duplicative partition; lock-and-mint and adapter inventories are not eligible for this path. Every official deployment must be present: JTRSY binds seven EVM contracts plus its Solana mint, while ACRDX binds five EVM contracts plus its Solana mint. Each EVM observation uses a safely lagged, hash-bound block at or before the scoring clock and atomically reads `totalSupply()`, decimals, and the pinned Centrifuge Spoke ward while also pinning runtime bytecode and requiring an empty EIP-1967 implementation slot. The Solana observation binds the Token-2022 mint and exact direct authority from one finalized account context and verifies the authority is a non-executable System-owned account. The complete packet must stay inside the 120-second cross-chain envelope, be no older than 30 minutes, and conserve the existing aggregate USD liability exactly. Any unavailable route, post-clock observation, code/controller/proxy drift, inventory mismatch, skew, or reconciliation failure rejects the whole packet and retains aggregate-only bridge materiality.

A curated native single-route attribution covers `xdai-gnosis`, whose entire liability is native Gnosis gas-token supply with no probeable contract equal to it (WXDAI is a strict subset), so its CoinGecko supplemental row publishes an aggregate with no per-chain partition. The reviewer-signed table `CURATED_NATIVE_SINGLE_ROUTE_SUPPLY_ATTRIBUTION` (`worker/src/lib/safety-score-v9/curated-single-route-supply.ts`) distributes that already-published aggregate onto the asset's single reviewed bridge route at V9 supply-review build time, only when all four gates hold: (1) a reviewer-signed, dated entry with a prose rationale naming the native-supply surface exists for the asset; (2) the curated `bridgeRouteRisk.routes` inventory has exactly one route, its id equals the entry's `routeId`, and it carries `reviewDisposition: "reviewed"`; (3) the asset resolves no per-chain supply rows, so a real upstream partition always wins over the curated attribution; and (4) the published aggregate supply is a finite positive USD number. The attribution asserts no new supply number — it only distributes the already-admitted aggregate across one chain, so it cannot restate supply or double count — and any failed gate falls back to the pre-existing aggregate-only null-share bridge materiality.

For tracked supplemental assets that are not in DefiLlama's stablecoin list, the worker still prefers DefiLlama's `coins.llama.fi` price proxy when it exists, including `coingecko:{id}` rows and exact `chain:contract` rows for single-deployment assets without a CoinGecko ID, then falls back to CoinGecko `simple/price` for the current token price when DefiLlama omits that `geckoId`, including protocol-backed commodity tokens that also carry a DefiLlama `protocolSlug`. Exact `chain:contract` supplemental rows are accepted only when DefiLlama returns a matching symbol, confidence of at least `0.8`, a fresh upstream timestamp, and a price inside the shared peg-aware reasonableness bounds. Gold tokens use DefiLlama protocol mcap only for the dedicated single-token slugs `tether-gold` and `paxos-gold`; all other protocol slugs ignore protocol mcap and continue through the CoinGecko market-cap/curated on-chain fallback order, preventing issuer-umbrella mcaps from being published as a token's circulating supply. For `detailProvider === "coingecko"` fiat assets, the preferred admission path is still CoinGecko market cap, but plain par-redeemable tracked assets can also enter the cached `/api/stablecoins` payload through a runtime-supported on-chain total-supply fallback: either exactly one supported deployment, a curated single-chain override, a curated aggregate where every configured chain can be read, or the Zephyr Scanner exception. NAV/yield-bearing assets require an observed price for that on-chain fallback and never assume a `$1` quote when the price lane is missing. Curated aggregate legs may explicitly allow reviewed zero-supply native deployments to contribute zero, but unreadable configured chains still fail the whole aggregate closed. The curated apyUSD aggregate sums its reviewed Ethereum and Base CCIP burn/mint deployments so a current per-chain materiality split accompanies the CoinGecko-priced NAV supply. The curated yUSD aggregate sums its reviewed Ethereum native deployment and nine LayerZero OFT burn/mint representations, because no leg escrows another. The curated savUSD aggregate reads its ten reviewed Chainlink CCIP deployments but reallocates the canonical Avalanche vault total, because the Avalanche CCIP LockRelease pool escrows every destination-chain mint, and its reviewed zero/dust legs on Katana, BSC, and MegaETH may contribute zero. Both aggregates pin reviewed public RPC endpoints for the chains outside the worker chain registry, and any unreadable leg still fails the whole aggregate closed onto the upstream CoinGecko market cap. Curated sUSDS and sDAI aggregates treat Ethereum `totalSupply()` as the conserved global total because it includes shares escrowed for their canonical lock/mint representations; Base, Optimism, and Arbitrum observations are reallocated out of the Ethereum chain bucket rather than added to that total, and an impossible representation sum fails closed. The curated sUSDe aggregate applies the same reallocation rule to its Ethereum LayerZero OFT adapter escrow across the twenty-four reviewed deployments a supported runtime can read; the TON jetton and Aptos fungible asset have no supply probe, so they are not configured legs and their balances stay inside the Ethereum bucket instead of failing the aggregate closed. The curated wsrUSD aggregate reallocates the same way out of its Ethereum OFT Adapter lockbox across seventeen reviewed deployments, and the curated dUSD, srUSD, syrupUSDT, syrupUSDC, KRWQ, thBILL, and wiTRY aggregates each reallocate out of their own reviewed Ethereum lockbox — a LayerZero OFT Adapter for srUSD, KRWQ, and thBILL, Chainlink CCIP LockRelease pools for syrupUSDT and syrupUSDC, a Wormhole NTT lock for dUSD, and a protocol escrow contract for wiTRY. GLDT and pGOLD reallocate the same way out of non-Ethereum canonical totals — the ICP ledger total and the Arbitrum CCIP LockRelease/LayerZero OFT Adapter lockboxes respectively; `CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS` (`shared/lib/onchain-supply-probe.ts`) is the complete reallocating roster. thBILL follows the sUSDe rule for its untracked Stable-chain representation, whose balance stays inside the Ethereum bucket rather than failing the aggregate closed. The curated cUSDO, sUSDai, sYUSD, IAUon, SLVon, mHYPER, and sDOLA aggregates sum instead, because each remote leg is either a locally backed vault or a burn/mint representation that no canonical leg escrows; their reviewed zero-supply and dust legs may contribute zero. The curated USDK and XO entries are single Solana deployments configured only so the aggregate lane publishes a per-chain row: their reviewed lock/mint routes escrow the underlying M0 `$M`, never the tracked token, so the published aggregate is unchanged. For active DefiLlama-listed rows that collapse to zero supply, the worker can repair only curated DefiLlama-detail aggregates — currently CADD, ftUSD, and Mento JPY/XOF — from verified on-chain total-supply reads, and only when every configured chain read succeeds and a fresh/static FX reference exists for USD normalization. A narrow protocol-inventory variant can subtract configured non-circulating holder balances from the same live on-chain total supply read and tags the row `supplySource = "onchain-circulating-supply"`; it is currently used for Tangent USG PegKeeper balances and fails closed if the balance reads are unavailable. The same configured exclusion can be replayed by `POST /api/backfill-supply-history` from historical EVM `totalSupply()` and holder `balanceOf()` reads, so daily `supply_history` rows and chart overlays use the same circulating-supply rule as the live cache. Zephyr assets are a narrow protocol-native exception: `zsd-zephyr-protocol` and `zys-zephyr-protocol` use Zephyr Scanner live-stats for native-chain circulation, and ZYS uses the same payload's protocol-published share price because neither CoinGecko nor DefiLlama exposes that wrapper.

If the supplemental CoinGecko market-cap fetch is temporarily unavailable, `syncStablecoins()` now reuses the last known good cached supply snapshot for those supplemental assets instead of emitting zero-supply rows or dropping them from the payload. That preservation rule now covers all tracked `detailProvider === "coingecko"` assets, including ones that currently rely on on-chain supply fallback without a `geckoId`. A configured curated aggregate can also retain a prior reconciled `onchain-total-supply` packet when its partition contains exactly the current configured deployment labels, with no derived residual label: if one live leg becomes unreadable but a fresh CoinGecko aggregate still succeeds, this narrow restore requires the current row to be an empty-partition `coingecko-fallback`, requires one finite positive circulating bucket matching the current fallback's peg bucket, and requires every copied chain current/history field to be finite and nonnegative. It carries only the exact supply fields plus their original observation time while keeping the current price and top-level history fields. Aggregates with residual or malformed partitions fail closed to the fresh CoinGecko fallback. This partial restore runs after primary-ID deduplication; `zarm-mento`, the only active curated aggregate that can also be admitted as a primary-list duplicate, retains its existing fresh-aggregate fallback behavior and does not take this partition-restore path. When a fresh DefiLlama `coins.llama.fi` price is still available, that fresher price is merged onto the restored supply snapshot. Carry-forward is bounded: restores preserve the original `supplyObservedAt`, require an integer timestamp no more than 60 seconds in the future, and expire once that observation is older than 7 days (`SUPPLEMENTAL_RESTORE_MAX_AGE_SEC`) — the asset publishes with its real current fallback supply (or empty supply when no fallback exists) and the run logs the expired IDs instead of indefinitely re-publishing stale totals. Restored rows are flagged `supplyRestored` with `supplyObservedAt` provenance, and the coin detail hero renders a "Stale supply · as of {date}" note from those fields.

NAV/yield-bearing supplemental assets are never par-valued for supply. When every market price lane fails (e.g. a CoinGecko delisting), an asset with a registered vault NAV route values its on-chain total supply through the pre-intake `resolveVaultNavSupplyPrice` protocol-redeem reuse described in [pricing-pipeline.md](pricing-pipeline.md#coingecko-low-volume-lane); without a trusted NAV the asset stays out and eventually reports as dropped in `trackedCoverage`.

The same restore-or-degrade rule guards tracked-id coverage of the main DefiLlama list itself: when the list omits an active tracked coin that was published last cycle, `restoreMissingTrackedAssets()` re-publishes the previous row (marked `supplyRestored`, same 7-day ceiling) instead of silently dropping the coin from the payload for a cycle, and the run records restored/dropped IDs in cron metadata (`trackedCoverage`). Past the ceiling — or with no usable previous supply — the coin stays out and is reported as dropped.

The 2026-07-10 Night Watch supply audit restored `rusd-royal-dollar` to that primary path by mapping the live DefiLlama Royal Dollar row (`llamaId = 415`). Eight other assets remained absent from the DefiLlama stablecoins list while CoinGecko reported no positive market cap: `benji-franklin-templeton`, `wtgxx-wisdomtree`, `busd0-usual`, `tbill-openeden`, `cetes-etherfuse`, `jusd-jusd-stable-token`, `vndc-jade-labs`, and `sofid-sofi`. The 2026-07-11 follow-up added `gramg-token-teknoloji` and `grams-token-teknoloji`, whose permitted sources likewise report no positive circulating market cap. Those ten reviewed no-supply records are quarantined and therefore outside the active publication contract; they have no default publication waivers. The 2026-07-12 review moved AUDm, CADm, CHFm, COPm, GBPm, and ZARm to CoinGecko detail admission because their mapped DefiLlama rows reported explicit zero supply and the permitted fallback path had positive coverage. ZARm can retain its existing curated on-chain supply source inside that admission path. XOFm remains DefiLlama-backed and uses its existing curated Celo total-supply repair; zero-supply collapse candidates are processed before non-blocking chain gaps so that repair cannot be starved by the 15-candidate cap.

The aggregate `stablecoin-charts` cache now reconciles structural supplemental tracked assets back into the published total-market-cap history instead of relying on DefiLlama's aggregate chart feed alone. `syncStablecoinCharts()` still starts from `stablecoincharts/all`, but after the FX repair pass it overlays only the tracked non-DefiLlama cohort with no `llamaId` from D1 `supply_history` before downsampling and cache publication. BRZ is the narrow audited exception because its retained legacy DefiLlama ID has no chart rows. A CoinGecko-admitted live row with a populated DefiLlama chart identity is therefore not double-counted. `GET /api/stablecoin-charts` then serves that cached, downsampled series exactly as published; it no longer overlays a live trailing aggregate point built from the `stablecoins` cache.

### Circuit Breakers

Per-source circuit breakers protect most high-risk external integrations. The open threshold, probe interval, alert behavior, public-health impact, and the public-impact exclusion list are owned by [Worker Infrastructure: Circuit Breakers](./worker-infrastructure.md#circuit-breakers); the exclusion predicate is `isPublicImpactCircuitKey()` in `shared/lib/public-health.ts` and the key registry is `CIRCUIT_SOURCE` in `worker/src/lib/constants.ts`.

`npm run check:provider-resilience` backs this posture with a registry in `scripts/lib/provider-resilience-registry.mjs`. It records the expected timeout, response-body handling, circuit source where applicable, and regression tests for external provider/fetcher surfaces, and it fails when a new production Worker file adds raw `fetch(...)` without a registry entry.

### DefiLlama list vs detail API

The [DefiLlama list-supply invariant](./architecture.md#architectural-decision-records) governs these values: `circulating` is already USD-denominated for every peg type.

The **detail** endpoint (`stablecoins.llama.fi/stablecoin/{id}`) returns values in **native currency** (e.g. RUB for A7A5, EUR for EURC). The worker's `stablecoin-detail.ts` handler multiplies by `parsed.price` to convert these to USD before caching.

Do not multiply list endpoint values by price; that would double-convert them.
