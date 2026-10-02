# Supply Snapshot Pipeline

Daily market cap snapshot pipeline. Captures non-restored cached `peggedAssets` whose IDs are PSI-eligible, stores their circulating supply (in USD) in D1, and uses that history for charting and replay.

Shadow assets are part of PSI eligibility, but this cron only reads non-restored rows present in the cached `stablecoins` payload. Shadow-asset history therefore requires separate historical/backfill coverage unless a non-restored shadow asset is present in that cache.

The snapshot does **not** call upstream APIs or on-chain RPCs. DefiLlama remains the primary source for regular assets, but the cached payload can include bounded CoinGecko aggregate gap-fill with matching missing-chain remainder attribution, DefiLlama history gap-fill rows, commodity/CoinGecko supplemental rows, on-chain-total-supply supplemental rows, and configured on-chain-circulating-supply rows assembled by the 15-minute `syncStablecoins()` cron. ADR-8 explicitly permits these documented, fail-closed, double-count-safe supplemental paths; they do not change the USD units of DefiLlama list supply.

The generic single-contract on-chain fallback in `fiat-cg.ts` preserves its successful probe's chain label and canonical chain ID as one public `chainCirculating` row. This repairs a producer mapping omission; ordinary positive CoinGecko aggregates still do not invent chain partitions. Current-only rows omit unobserved historical amounts.

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
   - when the marker date and digest match the current complete coverage evaluation and no required active ID recovered outside the marker's `ownedRowIds` since that write, conditionally repair only same-day rows whose stored `price` is still `null` and whose current non-restored cache row now has a positive observed price (written with its observation clock); otherwise skip with `reason: "already_written_today"`
   - a required active ID that recovered since the last write (present now, absent from the prior `ownedRowIds`) bypasses the price-only repair and falls through to the full atomic date replacement in steps 9–11, so every cron-owned row for that date — including already-written circulating values and prices — is rewritten from the current observations
   - same-day repair never overwrites a non-null historical price, circulating supply, or rows outside cron ownership
7. For each PSI-eligible cached asset:
   - Skip rows marked `supplyRestored === true`; carried-forward supply is not a fresh daily observation
   - Sum circulating supply via `sumPegBuckets(asset.circulating)` --- already in USD
   - Skip if sum <= 0
   - Extract price (must be a number > 0 and an actual observation per `isObservedPrice`, so a nominal par reference is `null`) with its observation clock `priceObservedAt` (`null` when absent or invalid)
   - Build `INSERT OR REPLACE` statement
8. Exact-set data quality check: require every active registry ID to have positive cached supply (fresh or restored) or an owned, reasoned, unexpired publication waiver. Restored-only active IDs are deliberate exclusions, not coverage gaps: the snapshot still writes every fresh observation, skips the restored rows, and returns `ok` with `quality: { reason: "snapshot_written_restored_skipped", restoredOnlyIds }` — the atomic write already committed, so this is input quality, not work that did not happen. Genuinely missing cache IDs and invalid-supply rows still block via `partial_snapshot_blocked` metadata (`missingActiveIds`, `missingCacheActiveIds`, `invalidSupplyIds`). Non-restored shadow rows are written when present but do not block active-universe completion. When a required ID that was restored at write time later produces a fresh observation the same UTC day, the snapshot re-writes the date atomically so its row stops missing.
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
  price_observed_at INTEGER,       -- 0253: actual observation clock of price (NULL = unknown)
  PRIMARY KEY (stablecoin_id, snapshot_date)
);

CREATE INDEX idx_supply_hist_date ON supply_history(snapshot_date DESC);
```

| Column | Type | Description |
|--------|------|-------------|
| `stablecoin_id` | TEXT | Canonical ticker-issuer ID (e.g. `usdt-tether`) |
| `snapshot_date` | INTEGER | Unix seconds floored to UTC midnight |
| `circulating_usd` | REAL | Total market cap in USD |
| `price` | REAL | USD price at snapshot time (may be `null`). Since mint-burn-flow v6.23 the cron writes it only when the published price is an actual observation (`isObservedPrice`); a nominal par reference is stored as `null`. Rows written earlier can hold nominal par |
| `price_observed_at` | INTEGER | Actual observation time of `price` (the asset's `priceObservedAt`), migration `0253`. `null` when unknown: rows written before `0253` or by a prior Worker, admin backfill rows, and prices without an observation clock. Mint/burn event-time valuation admits a snapshot price only through this clock (±24h of the event), never through `snapshot_date` |

The primary key `(stablecoin_id, snapshot_date)` enforces one row per coin per UTC day. The first complete run atomically replaces the cron-owned daily set. Later runs with unchanged complete coverage only fill a same-day `null` price (with its observation clock) from a current positive observed cache price, preserving the original circulating value and every non-null price. A later run in which a required active ID has recovered since the last write is the exception: it atomically replaces the whole cron-owned daily set from current observations (see the error-handling table), so same-day first-observation immutability holds only while coverage is unchanged. In the checked-in migration tree this table lives in `worker/migrations/0000_baseline.sql`, with `price_observed_at` added by `0253_supply_history_price_observed_at.sql`.

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
- **Observation admission (2026-09-28):** cache freshness alone does not prove chain supply freshness. A known-chain contribution marked `supplyRestored`, observed more than 1800 seconds ago, or carrying an unavailable canonical `current` defers only that entire chain row; unaffected chains still publish. Never subtract the unavailable contributor to publish a smaller subtotal. Run metadata records sorted `restoredOnlyIds`, `staleSupplyIds`, `missingSupplyIds`, and `deferredChainIds`, plus `deferredChains` mapping each affected canonical chain ID to its blocking asset IDs. Legacy non-restored rows without `supplyObservedAt` inherit the admitted cache timestamp. Explicit zero remains observed zero. Missing required asset identities still fail the existing exact-coverage gate; per-asset quarantine at intake does not relax daily exact coverage.
  Assets with no known chain partition remain visible in restored/stale metadata but cannot globally veto chains to which they have no attributed contribution. Chain history measures known attribution, not an invented partition of aggregate supply.
- **Partial-run status (R4):** successfully publishing or retaining every admitted chain returns `ok` with `metadata.quality: "partial"` and `reason: "chain_observations_partially_deferred"` when any chain is deferred. This completes the per-chain admission/write work while exposing input-quality gaps; it does not certify complete chain coverage or freshness of deferred rows. There is no materiality threshold: even a small unavailable contribution defers its whole chain. A fully deferred run with no previously admitted rows remains `degraded` with `chain_observations_unavailable`; database failure and global admission failures remain `degraded`. Partial-day retries may return `ok` with zero newly inserted rows because first observations are already persisted, while still recording outstanding deferrals.
- **Normalization:** the cron preserves upstream/display labels as `chainCirculating` object keys for compatibility, while producers attach an optional canonical `chainId`; the shared resolver uses that explicit ID first and falls back to the label for older or malformed rows before writing `chain_id`.
- **Write/recovery pattern (2026-09-28):** each chain keeps its first admitted observation for the UTC day and unchanged coverage identity. The atomic batch preserves the partial marker's admitted `ownedRowIds` plus currently deferred rows, inserts only newly admitted chains, and updates the coverage-version 2 marker. `chainObservationProgressVersion: 1` certifies that owned rows passed chain admission; legacy markers without this proof still require replacement rather than freezing unverified values. Deferred legacy rows are preserved until fresh admission can replace them; absent deferred rows stay absent. Same-day recovery fills missing chains without rewriting earlier admitted peers. The marker carries `chainObservationAdmissionVersion: 1` only when no deferrals remain. Once exact coverage and complete admission are proven, the day skips unconditionally even if later input becomes restored/stale/unavailable, preserving both rows and completion marker. Coverage-identity changes still recompute and remove disappeared chains. The per-asset `snapshot-supply` contract remains distinct and unchanged: unchanged complete coverage only repairs null prices, whereas recovery of a required ID outside prior ownership replaces the full owned daily set.
- **Volume:** ~103 rows/day (one row per admitted active chain per UTC day).
- **Primary use:** future trend charts on chain profile pages (`/chains/[chain]/`). The live `/api/chains` leaderboard does not read this table — it computes aggregates on-the-fly from the stablecoins cache.
- **Recoverability status:** historical rows written before the 2026-04-08 resolver fix are not approved for public charting. The retained D1 data does not include archived historical `stablecoins` cache payloads, so pre-fix chain splits cannot be reconstructed exactly. Any future public chain-history surface must start from a post-fix baseline date unless an audited export/purge plan is executed first.
- **Publication guard:** if a fresh stablecoins cache produces zero valid per-chain rows and no admitted rows belong to the same-day coverage identity, the cron returns `status: "degraded"` with `reason: "no-valid-chain-rows"` (or `chain_observations_unavailable` for deferred inputs) and skips the write instead of overwriting the historical series with an empty snapshot.
- **Current migration note:** this table is part of `worker/migrations/0000_baseline.sql` in the post-squash migration tree.

---

## Supply Data Source

**Primary source:** DefiLlama list API (`stablecoins.llama.fi/stablecoins`), cached every 15 minutes by `syncStablecoins()`.

**Tracked gap-fill exceptions:** `syncStablecoins()` now has three supply-reconciliation lanes for tracked DefiLlama-backed assets:

- For exactly one missing metadata deployment, the explicit CoinGecko aggregate gap-fill lane can raise the aggregate and attribute only the admitted increase to that chain. This is not a chain-only attribution that leaves the aggregate unchanged. A fresh timestamped current observation is required; stale or ambiguous attribution fails closed. The bounded admission contract below requires coherent buckets and no duplicate native/bridge/custody amount.
- If the DefiLlama live list collapses a tracked asset to zero supply but recent DefiLlama chart history still has a fresh non-zero total, the worker repairs the current plus 1d/7d/30d total supply buckets from that chart history and tags the asset `supplySource = "defillama-history-gap-fill"`. This covers list-endpoint regressions such as TRYB where the per-chain live row zeroes out while DefiLlama history remains populated.
- If a tracked asset collapses to zero supply and DefiLlama chart history is missing, stale, or below the $1M current-point floor, the worker falls back to the curated on-chain aggregate read (`applyCuratedOnChainSupplyGap`) and republishes the asset as `supplySource = "onchain-total-supply"`, rewriting `chainCirculating` and clearing the 1d/7d/30d buckets; an unreadable leg fails closed and leaves the zero row untouched.

Open USD (`ousd-open-standard`, DefiLlama `443`) has a reviewed four-leg zero-row repair roster: Tempo, Ethereum, Base, and Solana. The [Bridge reserve page](https://reserves.bridge.xyz/ousd) binds all four contracts; their observed 2026-09-30 combined supply reconciles to the [issuer transparency aggregate](https://transparency.bridge.xyz/v0/stablecoins/ousd) of approximately $477.31M. EVM `totalSupply()` and Solana `getTokenSupply` are summed, not canonical-chain reallocated. Every leg must succeed. This roster is consumed only by the existing zero-list-supply reconciliation lane: it does not override a positive DefiLlama total, and does not admit an asset whose row disappears from the list. Missing-row restoration retains its separate bounded continuity policy.

The snapshot cron records the admitted cached USD aggregate, including an accepted supplemental aggregate raise, without fetching or applying another reconciliation. The producer owns the aggregate/chain packet and its provenance. Synthetic and supplemental rows keep their display-label keys and carry `chainId` when the producer knows the canonical identity, so downstream aggregation does not need to infer identity from presentation text.

**Per-asset admission vs whole-cohort holds (DEC-03):** `syncStablecoins()` quarantines per asset and publishes healthy peers. Intake first requires a JSON object envelope with an array `peggedAssets`; anything else is a global schema failure that records the DefiLlama circuit outcome and takes the whole-list CoinGecko fallback. Before the frozen-snapshot merge or any field access, null, primitive and array rows are quarantined by index (`admitPeggedAssetRows`); `filterStructurallyValidAssets` then quarantines rows without an id or string name/symbol and rows whose current `circulating` buckets are absent (`{}`), non-finite, negative or overflow on summation. An explicit `{peggedUSD: 0}` is observed zero supply and is admitted. Invalid historical aggregate buckets drop to absence (`null`) without quarantining the asset. Reasons are logged on `malformed-assets-dropped` and counted in `rowsDropped`; a quarantined tracked coin then takes the normal tracked-coverage restore path. At publication each normalized row is validated on its own against the published row schema (aggregate buckets finite and nonnegative); a schema-invalid row is quarantined, logged, recorded in `stablecoins:invalid-last`, and removed from the run's downstream cohort. The whole list is held only for an invalid envelope, a duplicate published id, or a quarantine that leaves fewer than `MIN_VALID_ASSET_COUNT` rows. The daily snapshot's exact-coverage rule is unchanged by this: a quarantined or restored active ID still holds or annotates the daily write exactly as described in the Algorithm and Error Handling sections.

`canonicalizeChainCirculating()` retains the label fallback for legacy or upstream rows that have no usable `chainId`. That tolerance is intentional: the Safety Score V9 supply extension still receives raw upstream labels and pools unrecognized labels into its reviewed uncanonicalized-chain-label control path rather than silently assigning them to a different chain.

**Supplemental on-chain exceptions:** `syncStablecoins()` can admit `detailProvider === "coingecko"` assets through an on-chain supply fallback: a curated multi-deployment aggregate read (`fetchCuratedAggregateOnChainMcap`, which fails closed when any configured leg is unreadable and can reallocate a canonical chain's supply across representation legs) where one is configured, otherwise a single-deployment `totalSupply()` read. The default label is `supplySource = "onchain-total-supply"`. For narrow protocol-inventory cases, the worker can subtract configured live holder balances from that same total-supply read and publish `supplySource = "onchain-circulating-supply"`; if any configured balance read fails, the fallback is skipped for that run. The snapshot cron records the cached USD total and does not repeat those RPC reads.

The 2026-10-01 reviewed deployment extensions require complete rosters:

- **spUSDT (`susdt-spark`)** sums the native Ethereum, Arbitrum, and X Layer ERC-4626 vault supplies. USDT0 is X Layer collateral, not a bridged spUSDT representation; X Layer uses the reviewed supply RPC profile. Arbitrum retains its explicit observed-zero allowance.
- **syrupUSDC (`syrupusdc-maple`)** reads all nine deployments, including Arc through the Worker registry primary/fallback. Ethereum remains the conserved global total: Arc's reviewed CCIP BurnMint representation is subtracted from Ethereum's chain bucket and attributed to Arc, never added to the aggregate.
- **syzUSD (`syzusd-yuzu`)** reads all eight deployments, including the reviewed Aptos fungible-asset metadata address through the pinned `https://api.mainnet.aptoslabs.com/v1` REST profile. The existing Aptos-framework reader pins supply and decimals to one ledger version; absent observations or a decimals mismatch reject the aggregate. Aptos has its own dispatch family, so Movement's USDCx-only Ethereum xReserve reconciliation remains Movement-only. Plasma remains the canonical total, with Aptos representation supply reallocated rather than summed.

Every leg must succeed or the whole roster is unavailable; reads remain sequential and introduce no concurrent connection increase. A real `fetchCuratedAggregateOnChainMcap` live-RPC smoke at 2026-10-01 12:17 UTC returned complete supply partitions of **433,997,819.733304 spUSDT shares**, **852,331,867.552248 syrupUSDC shares**, and **53,319,755.20442983 syzUSD shares**, including X Layer **646,121.111960**, Arc **464,790.751454**, and Aptos **0.110120** shares. The smoke passed `priceUsd = 1` solely to expose supply units; these are not USD market-cap or NAV claims.

The single-deployment read resolves its RPC only from the Worker chain registry, so a deployment on a chain with no registry endpoint (a pin-only chain such as HyperEVM, where any Dwellir endpoint is supplemental) is unreadable on that path. Such an asset gets a one-leg curated roster that pins the reviewed supply profile from `SUPPLY_RPC_DEFAULTS`: `hbusdt-hyperbeat` carries one since 2026-09-28, after CoinGecko froze its market-cap row on 2026-09-26 and the asset fell to a price-less restored carry.

**RPC authority:** `shared/lib/chain-rpc-registry.ts` owns the data-only public, curated-supply, and V9 attribution endpoint profiles. `shared/lib/onchain-supply-probe.ts` chooses reviewed supply deployments and applies documented per-asset overrides before runtime chain fallbacks. Profiles deliberately retain their existing provider order (including Monad's distinct supply/attribution fallbacks and primary-only asset overrides); consolidation adds no providers or retries. The shared authority also retains the exclusion of `polygon-rpc.com`, which returned zero-valued `eth_call` results. syzUSD's Pharos leg reads the ZAN primary (`api.zan.top/public/pharos-mainnet`) with no fallback because `pharos.drpc.org` rejects `eth_call` with JSON-RPC `-32601` (re-checked 2026-09-28), so a dRPC-first leg failed the whole curated aggregate closed.

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

Aggregated homepage market-cap breakdown. The total series comes from `GET /api/stablecoin-charts`, whose cached historical backbone starts from DefiLlama aggregate chart data but is reconciled with structural supplemental tracked-asset daily history from D1 `supply_history` before publication. The endpoint serves that cached series as published and no longer splices a live trailing point from the `stablecoins` cache, so the chart's last point can trail the KPI card until the next `sync-stablecoin-charts` run. The named buckets use per-coin `useSupplyHistory(...)` data and `buildTotalMcapChartRows(...)` in `src/lib/total-mcap-chart.ts` so the homepage breakdown has full-history coverage instead of the shorter `supply_history` window. Those per-coin histories are aligned to the latest point at or before each total-chart date before computing `Others`. A successfully read, non-empty history is zero before its first point (the coin did not exist yet); a failed, missing or empty history stays unavailable at every date, so `Others` is withheld rather than absorbing that cohort, and the chart shows its "gaps are not zero" notice only in that case. The chart fills a gray total-market-cap envelope with the USDT cohort area beneath it (both baselined at zero, not stacked) and overlays cohort lines for USDC, `USDS + DAI`, `Others`, and a dashed `Non-USD share`.

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
| Any required active ID is present only as restored | Write all fresh observations, skip the restored rows, return `ok` with `quality.reason = "snapshot_written_restored_skipped"` naming `restoredOnlyIds`; a same-day recovery re-writes the date |
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

The savUSD curated aggregate reads its Avalanche CCIP LockRelease escrow at `0x8fcc42c414e29e8e3dbfa1628cf45e8ed80c999d` and separates canonical free float, measured remote deployments, and `savUSD unattributed CCIP escrow`. The last bucket conserves custody for unprobed Base, Arbitrum, and Movement representations without attributing them to Avalanche. An unreadable escrow, escrow above canonical supply, or escrow below measured representations rejects the aggregate. Supplemental fiat, commodity, and CoinGecko full-fallback rows preserve the winning supply observation: CoinGecko market-cap `last_updated_at`, or the on-chain supply reader's `observedAt`; a separate price/NAV observation never dates the supply. Silver's units-times-price fallback retains the circulating-supply observation (`coins/markets.last_updated`); a winning CoinGecko market cap retains its own timestamp. DefiLlama protocol market caps without an upstream timestamp remain undated.

V9-only bridge attribution runs at `+8`; fixed-input preparation follows successful half-hourly DEX publication, binds its exact generation ID, and canonical compilation runs at `+22` and `+52`. If that DEX run errors, preparation uses the last accepted consistent exact publication within the shared four-hour `DEX_LIQUIDITY_EVIDENCE_MAX_AGE_SEC` budget (also used by `:46` cadence reuse), recording upstream status, reused generation, age and budget in `dexPublicationRecovery`. Missing, inconsistent or over-budget evidence fails closed with the refusal in `upstreamRecovery`. The compiler rejects DEX dependencies older than the latest accepted generation. Attribution and compilation acquire a D1 memory-lane lease, bind the immutable current Worker version ID and matching finished core slot, decline while an earlier slot remains active, and enforce absolute deadlines. An `ok` core slot admits directly; degraded, non-terminal or post-deploy slots require durable-ledger proof that their `sync-stablecoins` run published the current cache generation, regardless of writer version. Compilation separately requires the fixed input's stablecoin timestamp to match that live generation. Partial active-row coverage remains visible and asset-local; stale/no-write data is inadmissible. Delayed/competing deliveries skip neutrally; missing Worker-version metadata degrades visibly. The critical quarter-hour lane is stablecoins → DDR. Atomic report-card publication feeds V9 separately at `16,46` (`prepare-safety-score-v9-input`, after DEX), including a compact publication-exact peg-provenance seed. Compilation rejects missing, partial or identity-mismatched seeds, never reconstructing them from mutable events.

XAUT's aggregate-only upstream row has bounded V9-only lock/mint attribution. The isolated observer reads reviewed `https://app.tether.to/transparency.json`, requires exactly one XAUT Ethereum row, hashes the raw response, records the issuer timestamp, converts `totalAuthorized`, `notIssued` and `quarantined` to exact six-decimal units, rejects future/>48-hour disclosures, and requires zero quarantined supply. At one finalized Ethereum block at/before the scoring clock, one Multicall reads canonical `totalSupply()`, pinned treasury and official XAUt0 OFT adapter balances, and adapter token/LayerZero endpoint identity. Supply minus treasury must equal disclosed circulating liability (`totalAuthorized - notIssued`); treasury-only mint/burn therefore reconciles. The adapter share uses that liability, not minted ERC-20 supply. The observer hash-binds/confirms the block, verifies token/adapter proxy and implementation identities, and binds the exact reviewed XAUt0 `representationId` inventory. Non-group liability goes to Ethereum; the adapter balance forms one representation-group row with exact aggregate share and common lockbox/protocol failure domains, but no destination allocation or inferred zero route shares. Observation time is the later block/disclosure timestamp; both age independently. The partition exactly conserves upstream USD liability without adding destination claims to locked backing. Missing, stale, skewed, identity/inventory-drifted, disclosure/on-chain-mismatched, non-conserving or materially large pooled evidence fails closed to aggregate-only bridge materiality. The admission journal records issuer-disclosure-plus-on-chain provenance, an allowlisted exact leaf rejection code, and rejected timestamps for disclosure skew/staleness or stale finalized state; it stores no response bodies, URLs or free-form diagnostics. A persisted generation rejected only for XAUT `transparency-stale` stays cron-healthy with rejected-asset diagnostics: expected inventory was observed and the scoring fallback is bounded.

The allowlisted Centrifuge JTRSY/ACRDX deployment-unit path admits reviewed native/burn-mint liabilities; lock/mint and adapter inventories are ineligible. Every inventoried deployment is mandatory. An unreviewed route may remain only with same-generation observed raw supply exactly `"0"`: its controls stay unresolved, while reviewed siblings retain attribution. Nonzero or unobserved unreviewed routes reject. EVM reads bind lagged pre-clock blocks, supply/decimals/Spoke ward, runtime bytecode and an empty EIP-1967 slot. Finalized Solana reads bind Token-2022 mint and exact non-executable System-owned authority; System ownership alone does not imply a key (JTRSY's authority is a Squads vault PDA). Identity, inventory, timing and conservation gates apply equally to zero rows: ≤120-second cross-chain skew, ≤30-minute age and unchanged aggregate USD. Unavailable routes, post-clock reads, identity drift or reconciliation failure reject to aggregate-only materiality.

Reviewed EVM deployment reads fall back only on pinned Multicall3 `eth_getCode = 0x`: sequential `eth_call`s share that block and recheck its hash. Required failures reject; optional failures retain existing decoding.

`xdai-gnosis` has curated native single-route attribution: its liability is native Gnosis gas supply, not a probeable equivalent contract (WXDAI is a subset), so its CoinGecko row has aggregate-only supply. The reviewer-signed `shared/data/safety-score-v9/supply-attribution-reviews-v1.json.nativeSingleRouteReviews` registry derives `CURATED_NATIVE_SINGLE_ROUTE_SUPPLY_ATTRIBUTION`. It distributes only the published aggregate when four gates hold: (1) signed, dated native-surface rationale, neither future-dated nor older than 365 policy days; (2) exactly one current reviewed bridge route with the admitted id; (3) no upstream per-chain rows (a real partition wins); (4) finite positive aggregate. Failure retains aggregate-only null-share materiality. This asserts no new supply or transfer posture: WXDAI evidence cannot cover `gnosis:native:xdai`. Lossless migration and registry iteration tests protect the gates and byte-identical partition. Since Safety Score 9.92, reviewed multi-route aggregate-only assets remain rateable with known quantity and unresolved bridge materiality; this native-gas lane is no general remedy.

The local, unreleased methodology 10.0 adds a reviewed economic-deployment partition lane without changing public aggregate supply or the smooth 5–15% unresolved-control band. `shared/types/safety-score-v9-supply-attribution.ts` owns the strict plan/packet wire and `shared/data/safety-score-v9/supply-attribution-reviews-v1.json.reviews` owns admission; the initial build authors no new coin plans. Strict provider-census eligibility, aggregate-denominator accounting and native-control classification activate only for an authored economic plan or its admitted packet. Without new reviewed data, captured chain partitions, legacy attribution precedence and native route classification stay unchanged. Amount bases, accounting families, holding kinds, in-flight treatments, conservation roundoff, review expiry and observation budgets live in `policy.semantic.supplyAttribution`. Within the new lane, only a complete current census wins; positive subtotals and missing zero-capable deployments do not prove completeness. The original aggregate and observation clock remain authoritative, and partial provider rows retain an explicit unknown remainder.

Generic plans bind an exhaustive exact holding census, circulating-liability scope, treasury exclusions, independent liabilities, exact escrow/receipt relationships, common-claim conversions and primary-proven in-flight treatment. Fixed token units use reviewed decimals; XRPL issued currency has decimal obligations and no ERC-20 decimals; native gas has its own `chain:native:symbol` key distinct from a wrapper. Lock-mint accounting subtracts each canonical escrow once and counts represented claims once; an independently issued destination requires a separately sourced escrow-backed subset, not subtracting all its liabilities. Atomic native-wrapper accounting requires actual backing/receipt reads proving equality; asynchronous bridges require a separately timestamped/generation-bound pending source. Missing reads are not zero. A sourced price/conversion is independently current and never refreshes raw quantity clocks. Known provider contradictions, over-counting, duplicate deductions, stale/future observations, catalog expansion or inconsistent conservation reject the partition.

`worker/src/lib/safety-score-v9/economic-supply-observer.ts` is invoked only by the existing isolated attribution producer and retains asset-local rejection. EVM reads use the plan's positive reviewed safe-block lag, the existing bounded rewind primitive, pinned block hashes and a final anchor recheck. Solana reads use finalized `getAccountInfo` mint supply with exact decimals/program owner, a bounded produced-slot/block-hash/time anchor and a hash of the validated score-bearing response projection (not incidental unsafe-u64 metadata such as `rentEpoch`). XRPL obligations use the exact issuer/currency and validated ledger hash/clock. Receipt conversions, prices, pending claims and mixed-liability backed subsets retain their reviewed API source generation, timestamp and response hash. The packet binds the original base/source/registry generations, aggregate, plan and route census, all observation/reference clocks and exact deployment amounts. Quantity/reference age is at most 1,800 seconds and cross-observation skew at most 120 seconds, owned by policy. Source generation reuse cannot redate those facts.

Supply/control consumption preserves small positive quantities and observed zero but does not grant percentage materiality for aggregate zero, missing aggregate, unresolved scope or a rejected packet. Transfer materiality consumes exact deployment keys before chain aggregation: same-chain native gas and wrappers are separate, and mixed EVM/Solana scope can be complete only with independent admitted transfer evidence. The existing independently eligible raw-lane asset ids are registry-owned; adding an id is not an accounting review. The existing public projections receive aggregate and route quantities through the same normalized fact set, with no fallback that conceals unmatched economic supply and no waiver of issuer non-disclosure. All new consumed source/schema/registry files participate in evaluation/build identity; no generated manifest or release state is advanced by this local build.

For tracked supplemental assets that are not in DefiLlama's stablecoin list, the worker still prefers DefiLlama's `coins.llama.fi` price proxy when it exists, including `coingecko:{id}` rows and exact `chain:contract` rows for single-deployment assets without a CoinGecko ID, then falls back to CoinGecko `simple/price` for the current token price when DefiLlama omits that `geckoId`, including protocol-backed commodity tokens that also carry a DefiLlama `protocolSlug`. Exact `chain:contract` supplemental rows are accepted only when DefiLlama returns a matching symbol, confidence of at least `0.8`, a fresh upstream timestamp, and a price inside the shared peg-aware reasonableness bounds. Gold and silver CoinGecko market-cap fallbacks require their own valid, current `last_updated_at` under the existing CoinGecko freshness policy, independently of spot-price acceptance. Silver `/coins/markets` circulating supply similarly requires a fresh `last_updated` before computing supply × price; a fresh spot price cannot refresh stale supply or market cap. A fresh independently observed market cap may still publish with a null price. Gold tokens use DefiLlama protocol mcap only for the dedicated single-token slugs `tether-gold` and `paxos-gold`; all other protocol slugs ignore protocol mcap and continue through the CoinGecko market-cap/curated on-chain fallback order, preventing issuer-umbrella mcaps from being published as a token's circulating supply. For `detailProvider === "coingecko"` fiat assets, the preferred admission path is still CoinGecko market cap, but plain par-redeemable tracked assets can also enter the cached `/api/stablecoins` payload through a runtime-supported on-chain total-supply fallback: either exactly one supported deployment, a curated single-chain override, a curated aggregate where every configured chain can be read, or the Zephyr Scanner exception. NAV/yield-bearing assets require an observed price for that on-chain fallback and never assume a `$1` quote when the price lane is missing. Curated aggregate legs may explicitly allow reviewed zero-supply native deployments to contribute zero, but unreadable configured chains still fail the whole aggregate closed. Summed aggregates additionally require every current registered deployment to be selected; adding a deployment before probe/accounting review disables that aggregate and retains the existing upstream fallback. Proven canonical lock/mint totals may conserve unprobed remote supply under their explicit reallocation policy. This completeness gate currently withholds the incomplete HLSCOPE, VNXAU, DGLD, JPYm, CHFAU and apyUSD rosters until their omitted deployments are reviewed and supported. The configured apyUSD Ethereum/Base burn/mint pair remains withheld because its current BSC and Solana deployments lack aggregate probe review. The curated yUSD aggregate sums its reviewed Ethereum native deployment and nine LayerZero OFT burn/mint representations, because no leg escrows another. The curated savUSD aggregate reads its ten reviewed Chainlink CCIP deployments but reallocates the canonical Avalanche vault total, because the Avalanche CCIP LockRelease pool escrows every destination-chain mint, and its reviewed zero/dust legs on Katana, BSC, and MegaETH may contribute zero. Both aggregates pin reviewed public RPC endpoints for the chains outside the worker chain registry, and any unreadable leg still fails the whole aggregate closed onto the upstream CoinGecko market cap. Curated sUSDS and sDAI aggregates treat Ethereum `totalSupply()` as the conserved global total because it includes shares escrowed for their canonical lock/mint representations; Base, Optimism, and Arbitrum observations are reallocated out of the Ethereum chain bucket rather than added to that total, and an impossible representation sum fails closed. The curated sUSDe aggregate applies the same reallocation rule to its Ethereum LayerZero OFT adapter escrow across the twenty-four reviewed deployments a supported runtime can read; the TON jetton and Aptos fungible asset have no supply probe, so they are not configured legs; the reviewed escrow-residual read (`CURATED_AGGREGATE_ESCROW_RESIDUALS`) splits the Ethereum canonical row into free float plus an explicit `sUSDe unattributed OFT escrow` remainder that carries their balances, and an unreadable or nonsensical escrow balance fails the aggregate closed. The curated wsrUSD aggregate reallocates the same way out of its Ethereum OFT Adapter lockbox across seventeen reviewed deployments, and the curated dUSD, srUSD, syrupUSDT, syrupUSDC, KRWQ, thBILL, and wiTRY aggregates each reallocate out of their own reviewed Ethereum lockbox — a LayerZero OFT Adapter for srUSD, KRWQ, and thBILL, Chainlink CCIP LockRelease pools for syrupUSDT and syrupUSDC, a Wormhole NTT lock for dUSD, and a protocol escrow contract for wiTRY. GLDT and pGOLD reallocate the same way out of non-Ethereum canonical totals — the ICP ledger total and the Arbitrum CCIP LockRelease/LayerZero OFT Adapter lockboxes respectively; syzUSD reallocates out of its canonical Plasma total across all seven reviewed deployments: Plasma, Ethereum, Monad, HyperEVM, Sei, Pharos, and Berachain. Every spoke must be readable; remote float is deducted from Plasma rather than added to global supply. `CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS` (`shared/lib/onchain-supply-probe.ts`) is the complete reallocating roster. thBILL's Stable-chain representation is a tracked deployment (chainId 988) with pinned reviewed RPC endpoints, so it is a configured leg that reallocates out of the Ethereum bucket like the other representations; an unreadable Stable leg fails the aggregate closed. The eEARN aggregate now includes both independent native Ethereum and Sui receipt supplies. The Sui leg reads the embedded `receipt_token_treasury_cap.total_supply.value` from Ember's pinned vault object `0x0779d2a4e1a6d3412982404cfe5567aac8cea229f17622c7b72d198b22a22e37` using [Sui mainnet GraphQL](https://graphql.mainnet.sui.io/graphql), verifies its exact vault type (USDC underlying and registered eEARN receipt), six-decimal coin metadata, and a checkpoint within 600 seconds of now. Missing/invalid/stale/future evidence fails the complete aggregate closed; null `coinMetadata.supply` is not treated as zero. [Ember's issuer API](https://vaults.api.prod.ember.so/api/v2/vaults) binds both deployments to the same product and reported identical receipt prices on 2026-09-12; the existing common product-price valuation remains, so local operator NAV refresh timing can differ. [Ember's Move source](https://github.com/ember-protocol/Ember-Vaults/blob/main/sources/vault.move) requires an empty TreasuryCap at vault creation and uses that cap for receipt mint/burn accounting. The curated mRe7YIELD aggregate includes its reviewed TAC native issuance alongside Ethereum, Etherlink and Starknet. cUSDO includes the Kaia (`klaytn`) local wrapper alongside Ethereum, Base, BSC and Solana. Both aggregates fail closed on any unreadable leg. cNGN has no curated on-chain aggregate: its destination representation float, including Lisk and Asset Chain, cannot establish the unreadable Bantu-native global supply, so existing upstream supply remains authoritative until complete native accounting is supported. The curated cUSDO, sUSDai, sYUSD, IAUon, SLVon, mHYPER, and sDOLA aggregates sum instead, because each remote leg is either a locally backed vault or a burn/mint representation that no canonical leg escrows; their reviewed zero-supply and dust legs may contribute zero. The curated USDK and XO entries are single Solana deployments configured only so the aggregate lane publishes a per-chain row: their reviewed lock/mint routes escrow the underlying M0 `$M`, never the tracked token, so the published aggregate is unchanged. For active DefiLlama-listed rows that collapse to zero supply, the worker can repair only curated DefiLlama-detail aggregates — currently CADD, ftUSD, and Mento JPY/XOF — from verified on-chain total-supply reads, and only when every configured chain read succeeds and a fresh/static FX reference exists for USD normalization. A narrow protocol-inventory variant can subtract configured non-circulating holder balances from the same live on-chain total supply read and tags the row `supplySource = "onchain-circulating-supply"`; it is currently used for Tangent USG PegKeeper balances and fails closed if the balance reads are unavailable. The same configured exclusion can be replayed by `POST /api/backfill-supply-history` from historical EVM `totalSupply()` and holder `balanceOf()` reads, so daily `supply_history` rows and chart overlays use the same circulating-supply rule as the live cache. Zephyr assets are a narrow protocol-native exception: `zsd-zephyr-protocol` and `zys-zephyr-protocol` use Zephyr Scanner live-stats for native-chain circulation, and ZYS uses the same payload's protocol-published share price because neither CoinGecko nor DefiLlama exposes that wrapper.

If the supplemental CoinGecko market-cap fetch is temporarily unavailable, `syncStablecoins()` now reuses the last known good cached supply snapshot for those supplemental assets instead of emitting zero-supply rows or dropping them from the payload. That preservation rule now covers all tracked `detailProvider === "coingecko"` assets, including ones that currently rely on on-chain supply fallback without a `geckoId`. A configured curated aggregate can also retain a prior reconciled `onchain-total-supply` chain partition when that partition contains exactly the current configured deployment labels, with no derived residual label: if one live leg becomes unreadable but a fresh CoinGecko aggregate still succeeds, this narrow restore requires the current row to be an empty-partition `coingecko-fallback`, requires one finite positive circulating bucket matching the current fallback's peg bucket, requires every copied chain current/history field to be finite and nonnegative, and requires the copied partition to still sum to the fresh aggregate within `max(0.01, aggregate * 1e-9)`. Only the chain partition is carried forward: the aggregate, its `coingecko-fallback` source and its observation time stay fresh, so the row is not flagged `supplyRestored` and never republishes a stale total under a fresh label. Aggregates with residual or malformed partitions, or with a partition that no longer reconciles with today's fresh aggregate, fail closed to the fresh CoinGecko fallback with no chain partition at all. This partition restore runs after primary-ID deduplication; `zarm-mento`, the only active curated aggregate that can also be admitted as a primary-list duplicate, retains its existing fresh-aggregate fallback behavior and does not take this partition-restore path. When a fresh DefiLlama `coins.llama.fi` price is still available, that fresher price is merged onto the restored supply snapshot. Carry-forward is bounded: restores preserve the original `supplyObservedAt`, require an integer timestamp no more than 60 seconds in the future, and expire once that observation is older than 7 days (`SUPPLEMENTAL_RESTORE_MAX_AGE_SEC`) — the asset publishes with its real current fallback supply (or empty supply when no fallback exists) and the run logs the expired IDs instead of indefinitely re-publishing stale totals. Restored rows are flagged `supplyRestored` with `supplyObservedAt` provenance, and the coin detail hero renders a "Stale supply · as of {date}" note from those fields.

For a DefiLlama asset with exactly one missing tracked chain, supply-gap reconciliation (`worker/src/cron/sync-stablecoins/supply-gap-reconciliation.ts`) can raise the aggregate from CoinGecko under the bounded contract below. When admitted, the `coingecko-gap-fill` row keeps the current `chainCirculating` sum equal to `getCirculatingRaw(asset)` by assigning only the nonnegative CoinGecko-minus-DefiLlama remainder to the missing chain, so the reconciled aggregate and chain packet follow the same sum-equals-aggregate contract enforced when curated aggregate packets are restored. NAV and yield-bearing assets are excluded from par-valued on-chain supply repair.

### CoinGecko aggregate gap-fill limits (DEC-01)

The 2026-09-27 owner decision retains this supplemental aggregate path as an explicit, fail-closed, double-count-safe raise. The numeric limits live only in `COINGECKO_GAP_FILL_POLICY`; **the owner reviews the chosen numbers at the implementing PR**.

| Rule | Contract |
|---|---|
| Ratio | `ratio = CoinGecko market cap / DefiLlama list total`, from a fresh timestamped CoinGecko observation; the band is re-checked on the CoinGecko market-chart value actually published |
| Entry (not gap-filled last publication) | `1.05 < ratio <= 1.45` |
| Hysteresis retain (previous published row had `supplySource = "coingecko-gap-fill"`) | `1.02 < ratio <= 1.50`; at or below `1.02` the row returns to DefiLlama and must clear `1.05` again to re-enter |
| No decision | CoinGecko simple-price/history unavailability (including 429s), candidate-cap deferrals and DefiLlama-outage fallback runs carry the prior coherent aggregate, chain packet and provenance for at most two consecutive publications (about 30 minutes at the normal cadence). `supplyGapFill.carryForwardRuns` counts carries, `supplyRestored = true` prevents treating them as fresh daily observations, and the observation time does not advance. A successful fill resets the count; a conclusive rejection or expiry returns to the current provider row |
| Hard ceiling | `maxRatio = 1.50` at current and at every compared historical bucket DefiLlama also observed; above it the contribution never enters the aggregate |
| Coherent history | Current, 1d, 7d and 30d must all come from the same CoinGecko market-chart series (no per-bucket `max(DL, CG)` splicing); a missing CoinGecko point fails the whole fill closed (`history-incomplete`). A bucket DefiLlama did not observe stays absent, because its supplemental contribution cannot be bounded |
| Attribution | Exactly one metadata deployment may be missing (`multiple-missing-chains` otherwise); every attributed DL chain row must be observed (a `null` chain current is a `baseline-mismatch`) and reconcile to the DL total. The missing chain carries only the nonnegative remainder per bucket; a CoinGecko bucket below DefiLlama's leaves that chain remainder absent rather than negative |
| Provenance | Every admitted row carries `supplyGapFill` (`method`, `admission: entered/retained`, `missingChainId`, the retained DefiLlama `canonicalCurrentUsd`, `supplementalCurrentUsd`, `ratio`, `maxRatio`, `observedAt`) beside `supplySource = "coingecko-gap-fill"` |
| Rejection | Out-of-band or unproven contributions leave the DefiLlama row untouched, log `coingecko-gap-fill-rejected`, and appear in run metadata `supplyGapReconciliation.gapFillRejections` (`ratio-out-of-band`, `multiple-missing-chains`, `baseline-mismatch`, `history-incomplete`, `history-ratio-above-bound`) |

**Calibration/replay (2026-09-27):** public DefiLlama/CoinGecko comparison showed that large ratios can reflect provider methodology, even with complete chain coverage. The `1.50` ceiling sits above p90 and the retained single-missing-chain cluster, below the first divergent cluster; entry/retain bands provide hysteresis. Council replay rejected feUSD, USDXL, scUSD and BtcUSD, rejected wCOP for `history-ratio-above-bound`, and retained reUSD by hysteresis.

**History discontinuity and live-depeg impact:** the rejected fills return to canonical DefiLlama totals, so published supply and the next daily `supply_history` observation step down once. This is a methodology change, not a redemption; prior rows are not rewritten. USDXL and scUSD fall below the **$1M live-depeg floor**, lose live detection, and any open event closes as `coverage-lost-supply`. The bound was set under the delegated DEC-01 decision (2026-09-27) and remains subject to owner review.

**Chain wire (Release B):** canonical `stablecoins` cache writes, the response-ready companion and public dataset snapshots carry unavailable chain observations as `null`, never `0`. Rolling back is safe only to the nullable-compatible Release A Worker/Pages pair.

NAV/yield-bearing supplemental assets are never par-valued for supply. When every market price lane fails (e.g. a CoinGecko delisting), an asset with a registered vault NAV route values its on-chain total supply through the pre-intake `resolveVaultNavSupplyPrice` protocol-redeem reuse described in [pricing-pipeline.md](pricing-pipeline.md#coingecko-low-volume-lane); without a trusted NAV the asset stays out and eventually reports as dropped in `trackedCoverage`.

Cached `onchain-total-supply` rows must also satisfy the current curated deployment roster and reconcile their chain packet before any supplemental or missing-tracked carry-forward. Removed/incomplete aggregates and packets missing newly required legs cannot be restored; reviewed canonical escrow residual labels remain allowed. Single-deployment totals retain their existing eligibility, and other upstream supply sources keep the ordinary age ceiling.

The same restore-or-degrade rule guards tracked-id coverage of the main DefiLlama list itself: when the list omits an active tracked coin that was published last cycle, `restoreMissingTrackedAssets()` re-publishes the previous row (marked `supplyRestored`, same 7-day ceiling) instead of silently dropping the coin from the payload for a cycle, and the run records restored/dropped IDs in cron metadata (`trackedCoverage`). Past the ceiling — or with no usable previous supply — the coin stays out and is reported as dropped.

Supplemental tracked IDs use this same tracked-coverage backstop when absent; the supplemental merge only resolves rows fetched in the current run and does not perform a second restoration pass.

Coverage decisions: `rusd-royal-dollar` uses DefiLlama Royal Dollar (`llamaId = 415`). After `sofid-sofi` re-admission on 2026-09-29, nine no-positive-market-cap assets remain quarantined without default waivers: `benji-franklin-templeton`, `wtgxx-wisdomtree`, `busd0-usual`, `tbill-openeden`, `cetes-etherfuse`, `jusd-jusd-stable-token`, `vndc-jade-labs`, `gramg-token-teknoloji`, and `grams-token-teknoloji`. AUDm, CADm, CHFm, COPm, GBPm and ZARm use CoinGecko detail admission after explicit-zero DefiLlama rows and positive permitted fallback coverage; ZARm may retain curated on-chain supply. XOFm remains DefiLlama-backed with curated Celo repair. Zero-collapse candidates precede non-blocking chain gaps so the 15-candidate cap cannot starve repair.

Four records are quarantined with `changedAt: 2026-09-24`, `reviewBy: 2026-10-24`: `hlusd-hela` has no supported tracked contract and CoinGecko is stale since Biconomy's 2026-08-14 trading suspension; `vusd-virtue` has unprobeable IOTA Move issuance, making partial IOTA EVM raw supply inadmissible; `luausd-lumi-finance` has no CoinGecko/DefiLlama price and only an imbalanced, zero-volume Arbitrum Curve pool (~$3.4K effective TVL); `bib01-backed` is in issuer wind-down, with CoinGecko frozen since 2026-09-17 and DefiLlama re-stamping 121.86, so its seven-chain aggregate cannot be valued. `vcred-vcred` stays active: Hemi's registered independent RPCs are `rpc.hemi.network/rpc` and `hemi.drpc.org`; `CURATED_ONCHAIN_SUPPLY_EXCLUSIONS` subtracts 987,400,000 protocol SafeProxy units from 1,000,000,000 total (RPC-verified 2026-09-24), yielding CoinGecko's 12,600,000 circulating basis. `usda-avalon` stays active with dated price-gap acknowledgement: supply is sound, but its sole DefiLlama per-deployment quote (e.g. `nibiru` 0xf4e0…2003) is intermittently re-stamped, not absent.

`syncStablecoinCharts()` starts from `stablecoincharts/all`, repairs FX, then overlays D1 `supply_history` for tracked non-DefiLlama assets without `llamaId` before downsampling/publication. BRZ alone is excepted: its retained legacy DefiLlama ID has no chart rows. CoinGecko-admitted rows with DefiLlama chart identities are not double-counted. `GET /api/stablecoin-charts` serves that exact cached series without a live trailing `stablecoins` aggregate point.

The chart producer has no live-current-point composer: aggregate-universe compatibility is enforced in the live aggregate publication path before this historical cache is consumed.

`usdv-solomon-v2` is a separate active CoinGecko supplemental asset valued on the new six-decimal Chancery mint. DefiLlama re-pointed asset 261 to it on 2026-09-24; the legacy `usdv-solomon` left that lane on 2026-09-27, and its 2026-09-23–26 `supply_history` rows containing replacement supply await reviewed repair. Legacy publication uses supplemental `supplySource = "onchain-total-supply"` via `getTokenSupply` on its exact mint (≈1.51M; unreadable fails closed). Untracked list row 261 is ignored, counting replacement supply only on v2 and preventing its smaller market cap from becoming legacy fallback. Neither generation imports historical price/market-cap series from recycled CoinGecko ID `solomon-usdv`; detail charts use forward local supply history/cache and preserve existing legacy history.

### Circuit Breakers

Per-source circuit breakers protect most high-risk external integrations. The open threshold, probe interval, alert behavior, public-health impact, and the public-impact exclusion list are owned by [Worker Infrastructure: Circuit Breakers](./worker-infrastructure.md#circuit-breakers); the exclusion predicate is `isPublicImpactCircuitKey()` in `shared/lib/public-health.ts` and the key registry is `CIRCUIT_SOURCE` in `worker/src/lib/constants.ts`.

`npm run check:provider-resilience` backs this posture with a registry in `scripts/lib/provider-resilience-registry.mjs`. It records the expected timeout, response-body handling, circuit source where applicable, and regression tests for external provider/fetcher surfaces, and it fails when a new production Worker file adds raw `fetch(...)` without a registry entry.

### DefiLlama list vs detail API

The [DefiLlama list-supply invariant](./architecture.md#architectural-decision-records) governs these values: `circulating` is already USD-denominated for every peg type.

The **detail** endpoint (`stablecoins.llama.fi/stablecoin/{id}`) returns values in **native currency** (e.g. RUB for A7A5, EUR for EURC). The worker's `stablecoin-detail.ts` handler multiplies by `parsed.price` to convert these to USD before caching.

Do not multiply list endpoint values by price; that would double-convert them.

### Supplemental chain history

Current-only on-chain supply packets omit per-chain `circulatingPrevDay`, `circulatingPrevWeek`, and `circulatingPrevMonth`; zero is reserved for an observed zero baseline. Publication and bounded packet restoration accept missing histories while validating any supplied values. Previous-cache loading removes synthetic chain history from legacy current-only on-chain packets before carry-forward. Chain alias normalization preserves unknown history, and chain summaries exclude missing historical pairs rather than counting the whole current balance as new supply. Mint/burn reconciliation leaves these rows `insufficient-source` until a real baseline is available.

### Chain observation absence

Intake (`normalizeChainCirculating`) collapses every provider chain bucket — `current`, `circulatingPrevDay`, `circulatingPrevWeek`, `circulatingPrevMonth` — with an absence-preserving sum: an empty or invalid bucket becomes `null`, an explicit `{peggedUSD: 0}` stays `0`, and a chain row without any `current` keeps the row (the chain is known) with `current: null`. `canonicalizeChainCirculating()` carries `current: null`, and alias merges leave a key unavailable whenever any alias lacks it, so a partial sum never pairs against a complete baseline. `aggregateChains()` skips an unavailable current entirely and pairs a historical window only when both sides are observed: an empty 1d baseline cannot manufacture a mint and an empty current cannot manufacture a redemption, while a numeric zero current is still a real redemption.

Release B (2026-09-28) activates these nullable values in `/api/stablecoins`: canonical and response-ready bodies preserve the same observations without a zero projection. Historical keys omitted by current-only producers remain unavailable, not zero. The frontend chain distribution renders unavailable when a chain current is unknown rather than normalizing a partial denominator to 100%; report-card DEX deployment supply coverage likewise withholds its ratio when any chain current is unobserved. The daily chain snapshot's separate fresh-coverage contract defers affected writes with unavailable observations.

The stablecoins response-ready schema marker advances to `StablecoinListResponseSchema:v2`; retained Release A `v1` companions are ignored and the canonical nullable cache is read with its original generation clock. A failed or delayed companion refresh therefore cannot revive the old zero projection. Previously served HTTP responses can remain cached for the producer-backed profile's 300-second shared max-age plus 300-second stale-while-revalidate window (browser max-age 60 seconds); allow that bounded transition and observe a new sync generation before declaring full cutover. Deploy only after Release A Worker and Pages readiness is observed, and roll back only to those nullable-compatible readers. Legacy stored numeric observations are not retrospectively converted without provenance.
