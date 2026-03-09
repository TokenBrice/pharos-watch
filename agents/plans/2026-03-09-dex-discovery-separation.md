# DEX Discovery Separation — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split the monolithic DEX liquidity cron into a scoring cron (30 min) and an independent discovery cron (20 min slot) with staged pool storage, tiered priority, and freshness confidence decay.

**Architecture:** Two independent cron jobs communicate through a `dex_pool_staging` D1 table. The discovery cron crawls CG/GT/DexScreener/CG Tickers on a tiered priority schedule and writes raw pool entries to staging. The scoring cron reads staging, merges with primary sources, applies confidence decay, scores, and persists to `dex_liquidity`.

**Tech Stack:** Cloudflare Workers, D1, TypeScript, Vitest

**Design doc:** `agents/plans/2026-03-09-dex-discovery-separation-design.md`

---

## Execution Strategy (cmcs)

### Phase 1 — Two Parallel Worktrees

```
dex-discovery-module  ──────▶  (4 sequential tickets, all NEW files)
dex-scoring-refactor  ──────▶  (2 sequential tickets, MODIFY existing files)
```

These touch zero overlapping files and run fully in parallel.

### Phase 2 — One Worktree (after Phase 1 merges)

```
dex-discovery-integration ──▶  (3 sequential tickets: wiring, tests, docs)
```

Wires the two streams together: cron registration, integration tests, documentation.

---

## Worktree A: `dex-discovery-module`

### TICKET-001: D1 migration + shared types

```yaml
title: "Add dex_pool_staging and dex_discovery_meta tables + shared types"
agent: codex
model: gpt-5.3-codex
reasoning_effort: medium
```

#### Goal

Create the D1 migration for the two new tables and the TypeScript interfaces used by both the discovery cron and the scoring cron's staging merge.

#### Task

1. Determine the next migration number by listing `worker/migrations/` — the new file should be `worker/migrations/NNNN_dex_discovery_staging.sql` where NNNN is one above the current highest.

2. Create the migration file with this SQL:

```sql
-- Pool discovery staging table
CREATE TABLE IF NOT EXISTS dex_pool_staging (
  pool_id       TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  source        TEXT NOT NULL,
  chain         TEXT NOT NULL,
  protocol      TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  tvl_usd       REAL,
  volume_24h    REAL,
  fee_tier      REAL,
  balance_ratio REAL,
  is_stable     INTEGER,
  base_token    TEXT,
  quote_token   TEXT,
  quote_symbol  TEXT,
  price_usd     REAL,
  locked_liq_pct REAL,
  raw_json      TEXT,
  discovered_at INTEGER NOT NULL,
  refreshed_at  INTEGER NOT NULL,
  PRIMARY KEY (pool_id, stablecoin_id)
);

CREATE INDEX IF NOT EXISTS idx_staging_coin ON dex_pool_staging(stablecoin_id);
CREATE INDEX IF NOT EXISTS idx_staging_refreshed ON dex_pool_staging(refreshed_at);

-- Discovery backoff tracking
CREATE TABLE IF NOT EXISTS dex_discovery_meta (
  stablecoin_id       TEXT PRIMARY KEY,
  consecutive_misses  INTEGER NOT NULL DEFAULT 0,
  last_crawl_at       INTEGER NOT NULL,
  last_hit_at         INTEGER
);
```

3. Create `worker/src/cron/dex-discovery/types.ts` with these interfaces:

```typescript
/** Raw pool entry written to dex_pool_staging by the discovery cron. */
export interface StagedPool {
  poolId: string;           // chain:address (lowercase)
  stablecoinId: string;
  source: "cg_onchain" | "gecko_terminal" | "dexscreener" | "cg_tickers";
  chain: string;
  protocol: string;         // normalized protocol name
  symbol: string;           // pool symbol e.g. "USDC/USDT"
  tvlUsd: number | null;
  volume24h: number | null;
  feeTier: number | null;   // basis points
  balanceRatio: number | null; // 0-1
  isStable: boolean | null;
  baseToken: string | null;
  quoteToken: string | null;
  quoteSymbol: string | null;
  priceUsd: number | null;
  lockedLiqPct: number | null;
  rawJson: string | null;
  discoveredAt: number;     // epoch seconds
  refreshedAt: number;      // epoch seconds
}

/** Backoff state per stablecoin, read from dex_discovery_meta. */
export interface DiscoveryMeta {
  stablecoinId: string;
  consecutiveMisses: number;
  lastCrawlAt: number;      // epoch seconds
  lastHitAt: number | null;  // epoch seconds, null if never found pools
}

/**
 * Staged pool defaults contract.
 * Defines how missing fields are handled when merging staged pools into scoring.
 * Used by the scoring cron's merge logic — NOT by the discovery cron.
 */
export const STAGED_POOL_DEFAULTS = {
  /** No incentive data available from discovery sources */
  organicFraction: 0.5,
  /** Conservative — balance data only from CG Onchain; GT/DS/tickers lack it */
  balanceRatioFallback: 1.0,
  /** Only CG Onchain provides locked liquidity */
  lockedLiquidityFallback: null as number | null,
} as const;

/**
 * Confidence decay for staged pool age.
 * Multiplies into effective TVL alongside quality multiplier.
 */
export function stagedPoolConfidence(ageHours: number): number {
  if (ageHours > 24) return 0; // excluded
  return Math.max(0.5, 1 - ageHours / 48);
}

/**
 * Maturity estimate for staged pool (days since first discovered).
 * Capped at 30 to avoid inflating durability for long-lived staging rows.
 */
export function stagedPoolMaturityDays(discoveredAt: number, now: number): number {
  const days = (now - discoveredAt) / 86400;
  return Math.min(Math.max(0, days), 30);
}

/** Tier thresholds for discovery priority. */
export const DISCOVERY_TIERS = {
  /** 0 pools from primary sources → crawl every run */
  T1_MAX_POOLS: 0,
  /** 1-4 pools or single chain → crawl every 3rd run */
  T2_MAX_POOLS: 4,
  /** T2 modulo divisor */
  T2_MODULO: 3,
  /** T3 (>=5 pools, >=2 chains) → crawl every 10th run */
  T3_MODULO: 10,
  /** Backoff: 3-5 misses → demote to T2 cadence */
  BACKOFF_T2_MISSES: 3,
  /** Backoff: 6-9 misses → demote to T3 cadence */
  BACKOFF_T3_MISSES: 6,
  /** Backoff: 10+ misses → dormant (daily only) */
  BACKOFF_DORMANT_MISSES: 10,
  /** Dormant = at most once per 24h */
  DORMANT_INTERVAL_SEC: 86400,
} as const;
```

#### Acceptance Criteria

- `ls worker/migrations/ | tail -1` shows the new migration file
- `worker/src/cron/dex-discovery/types.ts` exists and `cd worker && npx tsc --noEmit` passes
- `stagedPoolConfidence(0) === 1`, `stagedPoolConfidence(24) === 0.5`, `stagedPoolConfidence(25) === 0`
- `stagedPoolMaturityDays(now - 86400 * 10, now) === 10`, `stagedPoolMaturityDays(now - 86400 * 60, now) === 30`

---

### TICKET-002: Discovery orchestrator with tier computation

```yaml
title: "Create discovery cron orchestrator with tiered priority and backoff"
agent: codex
model: gpt-5.4
reasoning_effort: high
```

#### Goal

Create the orchestrator that reads current coverage + backoff state, computes effective tiers, orders coins for crawling, and runs the budget loop.

#### Task

1. Read these files for context:
   - `worker/src/cron/dex-discovery/types.ts` (created by TICKET-001)
   - `shared/lib/stablecoins.ts` (stablecoin metadata with `contracts` map)
   - `worker/src/cron/dex-liquidity/orchestrator.ts` (existing orchestrator for pattern reference — look at how it returns `CronResult`, uses `AbortSignal`, handles errors)
   - `worker/src/lib/cron-helpers.ts` (for `CronResult` type and any shared helpers)

2. Create `worker/src/cron/dex-discovery/orchestrator.ts` implementing `syncDexDiscovery()`:

```typescript
export async function syncDexDiscovery(
  db: D1Database,
  cgApiKey: string | null,
  signal?: AbortSignal,
): Promise<CronResult>
```

The function must:

a) **Read current state** from D1:
   - Query `dex_liquidity` for `stablecoin_id, pool_count, chain_count` (to determine base tier)
   - Query `dex_discovery_meta` for all rows (backoff state)
   - Read `discovery_run_seq` from a D1 config table (e.g., `INSERT OR REPLACE INTO kv_config(key, value) VALUES ('discovery_run_seq', ?)` — create the row if missing, starting at 0). Increment and write back.

b) **Compute effective tier per coin** using all tracked stablecoins from `STABLECOINS` (from `shared/lib/stablecoins.ts`). Filter out shadow stablecoins. For each coin:
   - Base tier from pool_count: 0 pools → T1, 1-4 pools (or chain_count <= 1) → T2, else → T3
   - Apply backoff from `consecutive_misses`: 3-5 → demote to T2 cadence, 6-9 → T3, 10+ → dormant
   - Dormant coins: skip unless `last_crawl_at` is older than `DORMANT_INTERVAL_SEC`

c) **Filter to eligible coins this run**: T1 always eligible, T2 when `seq % T2_MODULO === 0`, T3 when `seq % T3_MODULO === 0`. Dormant check from (b).

d) **Sort eligible coins** by `last_crawl_at` ascending (most stale first). Coins with no meta row sort first (never crawled).

e) **Chain-aware source routing**: For each coin, read its `contracts` map from `STABLECOINS`. Build a per-coin set of chains to query. This gets passed to the crawl function.

f) **Budget loop**: Set a wall-clock deadline (14 minutes from start). Iterate through sorted coins. For each coin, call `crawlCoin()` (from `crawl-sources.ts`, TICKET-003). After each coin, check if deadline is reached — if so, break cleanly.

g) **After loop**: Call cleanup (from `persistence.ts`, TICKET-004). Return `CronResult` with:
   - `status`: `ok` if no source family failed, `degraded` if some failed
   - `itemCount`: number of coins crawled
   - `metadata`: JSON with `coinsCrawled`, `poolsDiscovered`, `poolsRefreshed`, `tierBreakdown`, `budgetExhausted`

3. Create unit tests in `worker/src/cron/dex-discovery/__tests__/orchestrator.test.ts`:
   - Test `computeEffectiveTier()` (extract as a pure testable function):
     - 0 pools → T1
     - 3 pools, 1 chain → T2
     - 5 pools, 2 chains → T3
     - 0 pools + 5 consecutive misses → T2 cadence (backoff)
     - 0 pools + 10 consecutive misses → dormant
     - Dormant coin with recent crawl → skipped
     - Dormant coin with stale crawl (>24h) → eligible
   - Test `isEligibleThisRun()`:
     - T1 always eligible
     - T2 eligible on seq % 3 === 0
     - T3 eligible on seq % 10 === 0
   - Test coin sorting by staleness

#### Acceptance Criteria

- `cd worker && npx tsc --noEmit` passes
- `npm test -- --run worker/src/cron/dex-discovery/__tests__/orchestrator.test.ts` — all tests pass
- `syncDexDiscovery` is exported from the file
- Pure functions `computeEffectiveTier` and `isEligibleThisRun` are exported for testing

---

### TICKET-003: Discovery crawl sources with chain-aware routing

```yaml
title: "Extract crawl logic from existing fetch modules and adapt for staged discovery"
agent: codex
model: gpt-5.1-codex-max
reasoning_effort: high
```

#### Goal

Create the per-coin crawl function that queries CG/GT/DexScreener/CG Tickers and returns `StagedPool[]` entries. This extracts and adapts logic from the existing `fetch-crawlers.ts` and `fetch-fallbacks.ts`.

#### Task

1. Read these files thoroughly — they contain the logic to extract:
   - `worker/src/cron/dex-liquidity/fetch-crawlers.ts` — `fetchCgPools()`, `fetchGtPools()`, rate limiting, chain registry usage
   - `worker/src/cron/dex-liquidity/fetch-fallbacks.ts` — `fetchDsFallbackPools()`, `fetchCgTickersFallback()`
   - `worker/src/cron/dex-liquidity/constants.ts` — API endpoints, rate limits, budget constants
   - `worker/src/cron/dex-liquidity/crawl-helpers.ts` — GT API interaction helpers
   - `worker/src/cron/dex-liquidity/pool-helpers.ts` — `normalizeProtocol()`, quality multiplier lookup, symbol normalization
   - `worker/src/lib/chain-registry.ts` — chain-to-provider slug mapping
   - `worker/src/cron/dex-discovery/types.ts` — `StagedPool` interface

2. Also read `shared/lib/stablecoins.ts` — understand the `contracts` field shape (it maps chain IDs to contract addresses).

3. Create `worker/src/cron/dex-discovery/crawl-sources.ts` with:

```typescript
export interface CrawlResult {
  pools: StagedPool[];
  priceObs: Array<{ stablecoinId: string; price: number; tvl: number; chain: string; protocol: string }>;
}

/**
 * Crawl all sources for a single stablecoin.
 * Queries only chains where the coin is deployed (chain-aware routing).
 * Returns discovered pools as StagedPool entries ready for staging table.
 */
export async function crawlCoin(
  stablecoinId: string,
  coinChains: Map<string, string>,  // chain → contract address (from stablecoin metadata)
  cgApiKey: string | null,
  knownPoolIds: Set<string>,         // pools already in staging, for dedup
  signal?: AbortSignal,
  deadlineMs?: number,
): Promise<CrawlResult>
```

The function must:

a) **CoinGecko Onchain** (if `cgApiKey` is set): For each chain in `coinChains` that has a CG mapping in the chain registry, query `/onchain/networks/{network}/tokens/{address}/pools`. Extract pool data into `StagedPool` entries. Use the existing rate limiting pattern from `fetch-crawlers.ts`. Skip pools already in `knownPoolIds`. Extract balance ratio from token prices for stable pairs, fee tier from `pool_fee_percentage`, locked liquidity from `locked_liquidity_percentage`.

b) **GeckoTerminal** (for GT-only chains, or all chains if no CG key): For each chain in `coinChains` that has a GT mapping but was not already queried via CG, query GT `/networks/{network}/tokens/{address}/pools`. Extract into `StagedPool` entries. Use existing GT rate limiting (2000ms). No balance ratio or locked liquidity from GT.

c) **DexScreener** (for chains not covered by CG/GT, or if CG+GT found 0 pools): Query `/tokens/v1/{chainDsId}/{address}` for each contract. Apply the existing quality gates (TVL > $1K, volume > 0 or TVL > $10K). Extract into `StagedPool` entries. Use existing DS rate limiting (1100ms).

d) **CoinGecko Tickers** (only if steps a-c found 0 pools AND coin has a `geckoId`): Query `/coins/{geckoId}/tickers`. Apply existing filters (`!is_stale && !is_anomaly`, USD quote, volume >= $1K). Aggregate per-exchange into synthetic pool entries with `source: "cg_tickers"`, `poolType: "orderbook"`.

e) After each source, check `deadlineMs` — if exceeded, return what was found so far.

f) Collect price observations from all sources (for DEX price cross-validation in the scoring cron).

**Important:** Reuse existing helper functions where possible. Import from `../dex-liquidity/pool-helpers.ts` for `normalizeProtocol()`, quality multiplier lookups, and symbol normalization. Import from `../dex-liquidity/constants.ts` for API endpoints and rate limits. Import from `../dex-liquidity/crawl-helpers.ts` for GT pagination. Import from `../../lib/chain-registry.ts` for chain slug resolution. Do NOT duplicate these — import them.

If any of these helpers are not exported from the existing modules, add exports (but do not modify the helper logic).

#### Acceptance Criteria

- `cd worker && npx tsc --noEmit` passes
- `crawlCoin` is exported from `worker/src/cron/dex-discovery/crawl-sources.ts`
- The function imports from existing modules — no duplicate logic for rate limiting, chain registry, or protocol normalization
- All `StagedPool` entries have `poolId` in `chain:address` lowercase format
- DexScreener and CG tickers are only queried as fallbacks (when earlier sources found 0 pools)

---

### TICKET-004: Discovery persistence + entry point

```yaml
title: "Create staging persistence, cleanup, and cron entry point"
agent: codex
model: gpt-5.3-codex
reasoning_effort: medium
```

#### Goal

Create the persistence layer that writes to `dex_pool_staging` and `dex_discovery_meta`, handles cleanup, and wire the entry point.

#### Task

1. Read:
   - `worker/src/cron/dex-discovery/types.ts` (StagedPool, DiscoveryMeta interfaces)
   - `worker/src/cron/dex-liquidity/persistence.ts` (pattern reference for D1 upserts and `db.batch()`)

2. Create `worker/src/cron/dex-discovery/persistence.ts`:

```typescript
/**
 * Upsert discovered pools into dex_pool_staging.
 * Uses INSERT OR REPLACE since PK is (pool_id, stablecoin_id).
 */
export async function upsertStagedPools(db: D1Database, pools: StagedPool[]): Promise<void>

/**
 * Update dex_discovery_meta after crawling a coin.
 * Increments consecutive_misses if poolsFound === 0, resets to 0 if > 0.
 * Updates last_crawl_at. Updates last_hit_at if poolsFound > 0.
 */
export async function updateDiscoveryMeta(
  db: D1Database,
  stablecoinId: string,
  poolsFound: number,
  nowSec: number,
): Promise<void>

/**
 * Cleanup stale staging data.
 * - Delete rows where refreshed_at < nowSec - 48h
 * - NULL out raw_json where refreshed_at < nowSec - 6h (save storage, keep pool entry)
 */
export async function cleanupStaging(db: D1Database, nowSec: number): Promise<void>

/**
 * Read current discovery meta for all stablecoins.
 */
export async function readDiscoveryMeta(db: D1Database): Promise<Map<string, DiscoveryMeta>>

/**
 * Read and increment discovery_run_seq from kv_config table.
 * Creates the row if it doesn't exist (starting at 1).
 */
export async function incrementRunSeq(db: D1Database): Promise<number>
```

Use `db.batch()` for atomicity when upserting multiple pools. Batch in groups of 50 to stay within D1 statement limits.

3. Create `worker/src/cron/dex-discovery/index.ts`:

```typescript
export { syncDexDiscovery } from "./orchestrator";
```

#### Acceptance Criteria

- `cd worker && npx tsc --noEmit` passes
- `syncDexDiscovery` is re-exported from `worker/src/cron/dex-discovery/index.ts`
- `upsertStagedPools` uses `INSERT OR REPLACE` with `db.batch()`
- `updateDiscoveryMeta` resets `consecutive_misses` to 0 when pools are found
- `cleanupStaging` deletes rows >48h old and nulls `raw_json` >6h old
- `incrementRunSeq` is idempotent (creates row if missing)

---

## Worktree B: `dex-scoring-refactor`

### TICKET-001: Strip optional discovery phases from scoring cron

```yaml
title: "Remove optional discovery phases from syncDexLiquidity orchestrator"
agent: codex
model: gpt-5.3-codex
reasoning_effort: medium
```

#### Goal

Remove all optional discovery phases from the scoring cron orchestrator. These are moving to the independent discovery cron.

#### Task

1. Read `worker/src/cron/dex-liquidity/orchestrator.ts` fully.

2. Remove the following from `syncDexLiquidity()`:

   a) The `OPTIONAL_DISCOVERY_BUDGET_MS` constant and `optionalDiscoveryDeadlineMs` / `hasOptionalBudget()` / `optionalBudgetExhausted` variables/functions (around lines 18, 106-112).

   b) **Phase 4d**: CG token batch prices block (around lines 114-128). Remove `cgTokenPriceObs` variable and its merge into `priceObservations`.

   c) **Phase 4e**: GT token batch prices block (around lines 130-140). Remove `gtTokenPriceObs` variable and its merge.

   d) **Phase 4f**: CG pool crawl block (around lines 143-167). Remove `cgCrawlNewPools`, `cgCrawlPriceObs` variables.

   e) **Phase 4g**: GT pool crawl block (around lines 169-188). Remove `gtCrawlNewPools`, `gtCrawlPriceObs` variables.

   f) **Phase 5a**: `mergeCgPools(metrics, cgCrawlNewPools)` call.

   g) **Phase 5b**: `mergeGtPools(metrics, gtCrawlNewPools)` call.

   h) **Phase 5c**: DexScreener fallback block (around lines 240-261).

   i) **Phase 5d**: CG tickers fallback block (around lines 264-283).

   j) Remove any now-unused imports (e.g., `fetchCgPools`, `fetchGtPools`, `mergeCgPools`, `mergeGtPools`, `fetchDsFallbackPools`, `fetchCgTickersFallback`, `fetchCgTokenBatchPrices`, `fetchGtTokenBatch`).

   k) In the `metadata` JSON returned at the end, remove `optionalBudgetExhausted` and related fields that no longer apply.

   l) Remove `cgApiKey` from the function signature if it is no longer used (check: it may still be needed for CG token batch in fetch-primary.ts or other phases — only remove if truly unused after stripping).

3. Do NOT modify any other files. Do NOT change the scoring logic, primary source fetching, or persistence.

4. Verify the remaining flow is: fetch primary sources → build lookups → parse Curve → fetch UniV3 → fetch Aerodrome → build known pool addresses → process pool metrics → score → coverage guard → persist → history → depth stability.

#### Acceptance Criteria

- `cd worker && npx tsc --noEmit` passes
- `npm run lint` passes (no unused imports/variables)
- No references to `hasOptionalBudget`, `optionalDiscoveryDeadlineMs`, `OPTIONAL_DISCOVERY_BUDGET_MS`, `cgCrawlNewPools`, `gtCrawlNewPools`, `fetchCgPools`, `fetchGtPools`, `mergeCgPools`, `fetchDsFallbackPools`, `fetchCgTickersFallback`, `fetchCgTokenBatchPrices`, `fetchGtTokenBatch` remain in the file
- The existing imports for primary sources (`fetchDataSources`, `fetchUniV3Data`, `fetchAerodromeData`, etc.) and scoring (`computeStablecoinScores`, `persistScores`, etc.) are untouched

---

### TICKET-002: Add staging table merge with confidence decay

```yaml
title: "Read staged pools and merge into scoring with confidence decay and defaults contract"
agent: codex
model: gpt-5.4
reasoning_effort: high
```

#### Goal

After the scoring cron fetches primary sources and processes pool metrics, read the staging table and merge discovered pools into the pool set before scoring.

#### Task

1. Read:
   - `worker/src/cron/dex-liquidity/orchestrator.ts` (after TICKET-001 stripped the discovery phases)
   - `worker/src/cron/dex-liquidity/types.ts` — `PoolEntry`, `LiquidityMetrics`, `GtNewPool` interfaces
   - `worker/src/cron/dex-liquidity/fetch-crawlers.ts` — `mergeGtPools()` function (this is the pattern for merging external pools into metrics)
   - `worker/src/cron/dex-liquidity/pool-helpers.ts` — `pairQuality()`, quality multiplier lookup
   - `worker/src/cron/dex-discovery/types.ts` — `StagedPool`, `STAGED_POOL_DEFAULTS`, `stagedPoolConfidence`, `stagedPoolMaturityDays`

2. Create a new function in `worker/src/cron/dex-liquidity/staging-merge.ts`:

```typescript
import type { D1Database } from "@cloudflare/workers-types";
import type { LiquidityMetrics } from "./types";

/**
 * Read staged pools from dex_pool_staging (refreshed within 24h),
 * convert to GtNewPool-compatible entries with confidence decay and defaults,
 * and merge into existing metrics using mergeGtPools pattern.
 */
export async function mergeStagedPools(
  db: D1Database,
  metrics: Map<string, LiquidityMetrics>,
  knownPoolAddrs: Set<string>,
  nowSec: number,
): Promise<{ mergedCount: number; skippedCount: number }>
```

The function must:

a) Query `SELECT * FROM dex_pool_staging WHERE refreshed_at >= ?` with `nowSec - 86400` (24h cutoff).

b) Group results by `stablecoin_id`.

c) For each staged pool:
   - Skip if `pool_id` is already in `knownPoolAddrs` (primary source wins on conflict)
   - Compute confidence: `stagedPoolConfidence((nowSec - refreshedAt) / 3600)`
   - Skip if confidence === 0
   - Apply confidence to TVL: `adjustedTvl = (tvlUsd ?? 0) * confidence`
   - Convert to a `GtNewPool`-compatible structure:
     - `address`: extract from poolId (part after `:`)
     - `chain`: from staging row
     - `dexId`: `protocol` from staging row
     - `name`: `symbol` from staging row
     - `tvlUsd`: `adjustedTvl`
     - `volume24hUsd`: `(volume24h ?? 0) * confidence`
     - `qualityMultiplier`: look up from protocol using existing quality helpers; use `feeTier` if available
     - `maturityDays`: `stagedPoolMaturityDays(discoveredAt, nowSec)`
     - `poolType`: infer from source + protocol (use existing pattern)
     - `price`: `priceUsd ?? 0`
     - `symbol`: from staging row
   - For CG Onchain pools (source === 'cg_onchain'), also set `balanceRatio` and `lockedLiquidityPct` if available
   - For all other sources, use `STAGED_POOL_DEFAULTS.balanceRatioFallback` and `STAGED_POOL_DEFAULTS.lockedLiquidityFallback`

d) Call `mergeGtPools(metrics, groupedNewPools)` (the existing merge function handles the rest: TVL aggregation, protocol/chain breakdown, top pool insertion, organic fraction default of 0.5).

e) Return count of merged and skipped pools.

3. In `worker/src/cron/dex-liquidity/orchestrator.ts`, add the staging merge call **after** `processPoolMetrics()` and **before** `computeStablecoinScores()`:

```typescript
// After processPoolMetrics() and before computeStablecoinScores():
const { mergedCount, skippedCount } = await mergeStagedPools(
  db, metrics, knownPoolAddrs, syncStartSec,
);
```

Include `mergedCount` and `skippedCount` in the returned metadata JSON.

4. Create unit tests in `worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts`:
   - Test confidence decay: pool 0h old → confidence 1.0, 12h → 0.75, 24h → 0.5, 25h → 0 (excluded)
   - Test that primary pools are not overridden (pool in `knownPoolAddrs` is skipped)
   - Test defaults contract: GT-sourced pool gets `organicFraction: 0.5`, `balanceRatio: 1.0`
   - Test CG-sourced pool preserves its `balanceRatio` and `lockedLiqPct`
   - Test TVL adjustment: a 100K TVL pool at 12h age → effective TVL of 75K

#### Acceptance Criteria

- `cd worker && npx tsc --noEmit` passes
- `npm test -- --run worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts` — all tests pass
- `mergeStagedPools` is called in the orchestrator between pool metrics processing and scoring
- Primary source pools always take precedence over staged pools
- Confidence decay is applied to both TVL and volume

---

## Worktree C: `dex-discovery-integration` (Phase 2)

> **Prerequisite:** Worktrees A and B must be merged to main before starting Phase 2.

### TICKET-001: Register discovery cron + methodology v3.3

```yaml
title: "Wire discovery cron into scheduled handler and bump methodology version"
agent: codex
model: gpt-5.3-codex
reasoning_effort: medium
```

#### Goal

Register `syncDexDiscovery` on the 20-minute cron trigger and bump the liquidity methodology to v3.3.

#### Task

1. Read:
   - `worker/src/handlers/scheduled.ts` — understand the cron dispatcher pattern, especially the 20-minute trigger case block
   - `worker/src/lib/cron-schedule.ts` — job definitions
   - `worker/src/cron/dex-discovery/index.ts` — the export to import
   - `shared/lib/liquidity-score-version.ts` — version history format

2. In `worker/src/lib/cron-schedule.ts`, add `sync-dex-discovery` to the job list with `intervalSec: 1200` (20 minutes), associated with the `twentyMinuteOffset` schedule.

3. In `worker/src/handlers/scheduled.ts`, in the `twentyMinuteOffset` case block:
   - Import `syncDexDiscovery` from `../cron/dex-discovery`
   - Add a `ctx.waitUntil()` call for `runLeasedCron("sync-dex-discovery", (signal) => syncDexDiscovery(db, env.COINGECKO_API_KEY ?? null, signal))`
   - Place it alongside (parallel with) the existing blacklist and mint-burn calls — it should fire via `ctx.waitUntil()` independently, NOT chained after them

4. In `shared/lib/liquidity-score-version.ts`:
   - Add a new version entry for v3.3 with the current date
   - Description: "Separated discovery pipeline with staged pool confidence decay"
   - Update the `LIQUIDITY_METHODOLOGY_VERSION` constant to `"3.3"`

5. Also update the `LIQUIDITY_METHODOLOGY_VERSION` reference in `worker/src/cron/dex-liquidity/persistence.ts` if it imports the version from the shared module (verify by reading the file).

#### Acceptance Criteria

- `cd worker && npx tsc --noEmit` passes
- `npm run build` passes (full frontend + worker type check)
- `syncDexDiscovery` is registered on the 20-minute trigger
- It runs in parallel with blacklist and mint-burn (via `ctx.waitUntil`, not chained)
- `LIQUIDITY_METHODOLOGY_VERSION` is `"3.3"` in the shared module
- The version history array includes the v3.3 entry

---

### TICKET-002: Integration tests

```yaml
title: "Add integration tests for scoring-with-empty-staging and end-to-end discovery flow"
agent: codex
model: gpt-5.3-codex
reasoning_effort: medium
```

#### Goal

Verify no regression when the staging table is empty and test the full discovery → staging → merge pipeline.

#### Task

1. Read:
   - Existing test files in `worker/src/cron/dex-liquidity/__tests__/` for test patterns and D1 mocking approach
   - `worker/src/cron/dex-discovery/__tests__/orchestrator.test.ts` (already created in TICKET-002 of Worktree A)
   - `worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts` (already created in TICKET-002 of Worktree B)

2. Add tests to `worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts`:
   - **Empty staging table**: `mergeStagedPools()` with an empty result set returns `{ mergedCount: 0, skippedCount: 0 }` and does not modify metrics
   - **Scoring produces identical output with empty staging**: Mock the D1 query to return 0 rows, verify the scoring cron's behavior is unchanged

3. Add tests to `worker/src/cron/dex-discovery/__tests__/orchestrator.test.ts`:
   - **Chain-aware routing**: Coin with contracts on `{ethereum: "0x...", arbitrum: "0x..."}` only generates crawl calls for those 2 chains, not all 30+
   - **Backoff reset**: After `consecutive_misses = 10` (dormant), finding 1 pool resets to 0

#### Acceptance Criteria

- `npm test -- --run` passes all new and existing tests
- Empty staging table test proves no regression in scoring output
- Chain-aware routing test verifies only relevant chains are queried

---

### TICKET-003: Documentation updates

```yaml
title: "Update docs for discovery separation and methodology v3.3"
agent: codex
model: gpt-5.3-codex-spark
reasoning_effort: low
```

#### Goal

Update all relevant documentation to reflect the new architecture.

#### Task

1. Update `docs/dex-liquidity.md`:
   - Add a new section "## Discovery Cron" after the existing overview, explaining the separation
   - Document `dex_pool_staging` and `dex_discovery_meta` tables
   - Document tiered priority (T1/T2/T3) with backoff
   - Document chain-aware source routing
   - Document freshness confidence decay formula
   - Document staged pool defaults contract
   - Update the "Data sources" paragraph to mention that CG/GT/DexScreener/CG Tickers now run on the independent discovery cron
   - Update the "Storage" section to include the two new tables

2. Update `docs/worker-infrastructure.md`:
   - In the cron schedule section, add `sync-dex-discovery` to the 20-minute trigger job list
   - Note that 3 jobs now run on the 20-minute slot: blacklist, mint-burn, dex-discovery
   - Document the connection budget analysis (1 sequential connection for discovery)

3. Update `docs/data-flow-map.md`:
   - Add the discovery cron → dex_pool_staging → scoring cron flow
   - Show the staging table as an intermediate step in the DEX liquidity pipeline

4. Update `docs/methodology-page.md`:
   - Add v3.3 entry to the methodology changelog section
   - Description: "Separated discovery pipeline with staged pool confidence decay. Discovery sources (CG Onchain, GeckoTerminal, DexScreener, CG Tickers) now run on an independent 20-minute cron with 3x more budget. Staged pools merged into scoring with freshness confidence decay and explicit defaults contract."

#### Acceptance Criteria

- All four docs files are updated
- `npm run build` passes (docs don't break the build)
- No references to the old "5-minute optional discovery budget" remain in `docs/dex-liquidity.md`
- The 20-minute trigger section in `docs/worker-infrastructure.md` lists 3 jobs
