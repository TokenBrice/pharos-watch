---
title: "Add staging table merge with confidence decay and defaults contract"
agent: codex
model: gpt-5.4
reasoning_effort: high
done: false
---

## Goal

After the scoring cron fetches primary sources and processes pool metrics, read the staging table and merge discovered pools into the pool set before scoring. Apply confidence decay based on pool age and use the staged pool defaults contract for missing fields.

## Context

After scoring-refactor TICKET-001 stripped the optional discovery phases, the scoring cron only uses primary sources (DeFiLlama + Curve + UniV3 + Aerodrome). This ticket adds the staging table merge that replaces those phases — the discovery cron (separate worktree) populates the staging table, and this merge reads from it.

**Important:** After TICKET-001 strips optional discovery, `knownPoolAddrs` (built by `buildKnownPoolAddresses()`) contains only primary-source pool IDs. This is correct — staged pools should only be skipped when a primary source already covers them.

## Key Import Paths (verified against codebase)

| What | Import from |
|------|-------------|
| `CronResult` | `../../lib/db` |
| `PoolEntry`, `LiquidityMetrics`, `GtNewPool`, `CgNewPool` | `./types` |
| `mergeGtPools`, `mergeCgPools` | `./fetch-crawlers` |
| `normalizeProtocol`, `getGtDexQuality`, `getQualityMultiplier` | `./pool-helpers` |
| `StagedPool`, `STAGED_POOL_DEFAULTS`, `stagedPoolConfidence`, `stagedPoolMaturityDays` | `../dex-discovery/types` |

`D1Database` is a global type — do NOT import it.

## Important: Quality Multiplier Functions

The codebase has TWO quality functions in `pool-helpers.ts`:

- `getQualityMultiplier(poolType: string, curveA?: number): number` — for classified pool types like `"curve-stableswap"`, `"uniswap-v3-5bp"`. Used by `processPoolMetrics` for DL pools.
- `getGtDexQuality(dexId: string): number` — for DEX identifier strings like `"uniswap_v3"`, `"aerodrome"`. Used by `fetchCgPools`, `fetchGtPools`, `fetchDsFallbackPools`.

**For staged pools, use `getGtDexQuality(row.protocol)`.** Staged pools come from CG/GT/DexScreener/tickers where we have a DEX identifier, not a classified pool type.

## Task

1. Read these files:
   - `worker/src/cron/dex-liquidity/orchestrator.ts` — current state after TICKET-001 stripped discovery phases
   - `worker/src/cron/dex-liquidity/types.ts` — `PoolEntry`, `LiquidityMetrics`, `GtNewPool`, `CgNewPool` interfaces
   - `worker/src/cron/dex-liquidity/fetch-crawlers.ts` — `mergeGtPools()` and `mergeCgPools()` functions (both return `void` — they modify `metrics` in place)
   - `worker/src/cron/dex-liquidity/pool-helpers.ts` — `getGtDexQuality(dexId)`, `normalizeProtocol()`
   - `worker/src/cron/dex-discovery/types.ts` — `StagedPool`, `STAGED_POOL_DEFAULTS`, `stagedPoolConfidence`, `stagedPoolMaturityDays`

2. Create `worker/src/cron/dex-liquidity/staging-merge.ts`:

```typescript
import type { LiquidityMetrics } from "./types";

/**
 * Read staged pools from dex_pool_staging (refreshed within 24h),
 * convert to pool entries with confidence decay and defaults,
 * and merge into existing metrics.
 *
 * If the staging table doesn't exist yet (pre-migration), catches the D1 error
 * and returns zero counts gracefully.
 */
export async function mergeStagedPools(
  db: D1Database,
  metrics: Map<string, LiquidityMetrics>,
  knownPoolAddrs: Set<string>,
  nowSec: number,
): Promise<{ mergedCount: number; skippedCount: number }>
```

Implementation details:

### Step 1: Read staging table (with error handling)

```typescript
let rows;
try {
  const result = await db
    .prepare(`SELECT pool_id, stablecoin_id, source, chain, protocol, symbol,
                     tvl_usd, volume_24h, fee_tier, balance_ratio, is_stable,
                     base_token, quote_token, quote_symbol, price_usd, locked_liq_pct,
                     discovered_at, refreshed_at
              FROM dex_pool_staging WHERE refreshed_at >= ?`)
    .bind(nowSec - 86400)
    .all();
  rows = result.results;
} catch (err) {
  // Table may not exist yet (pre-migration). Gracefully return zero.
  console.warn("[dex-liquidity] staging table read failed (pre-migration?):", err);
  return { mergedCount: 0, skippedCount: 0 };
}
```

Do NOT read `raw_json` — it's large and not needed for merge.

### Step 2: Group by stablecoin_id and convert

For each staged pool row:

a) **Dedup check:** If `pool_id` is in `knownPoolAddrs`, skip it (primary source wins). Increment `skippedCount`.

b) **Confidence decay:** `const ageHours = (nowSec - row.refreshed_at) / 3600`. Call `stagedPoolConfidence(ageHours)`. If result is 0, skip.

c) **TVL adjustment:** `const adjustedTvl = (row.tvl_usd ?? 0) * confidence`. `const adjustedVolume = (row.volume_24h ?? 0) * confidence`.

d) **Quality multiplier:** Use `getGtDexQuality(row.protocol)` for all staged pool sources. This returns the correct multiplier for DEX identifiers like `"uniswap_v3"`, `"curve"`, `"aerodrome"`, etc.

e) **Convert to GtNewPool or CgNewPool depending on source:**

For `source === "cg_onchain"` (CG provides balance ratio and locked liquidity):
```typescript
const pool: CgNewPool = {
  address: row.pool_id.split(":")[1] ?? row.pool_id,
  chain: row.chain,
  dexId: row.protocol,
  name: row.symbol,
  tvlUsd: adjustedTvl,
  volume24hUsd: adjustedVolume,
  qualityMultiplier: getGtDexQuality(row.protocol),
  maturityDays: stagedPoolMaturityDays(row.discovered_at, nowSec),
  poolType: row.is_stable ? "stable" : "amm",
  price: row.price_usd ?? 0,
  symbol: row.symbol,
  balanceRatio: row.balance_ratio,           // CG provides this
  lockedLiquidityPct: row.locked_liq_pct,    // CG provides this
  feePercentage: row.fee_tier ? row.fee_tier / 100 : null,  // bps -> percentage
};
```

For all other sources (`gecko_terminal`, `dexscreener`, `cg_tickers`):
```typescript
const pool: GtNewPool = {
  address: row.pool_id.split(":")[1] ?? row.pool_id,
  chain: row.chain,
  dexId: row.protocol,
  name: row.symbol,
  tvlUsd: adjustedTvl,
  volume24hUsd: adjustedVolume,
  qualityMultiplier: getGtDexQuality(row.protocol),
  maturityDays: stagedPoolMaturityDays(row.discovered_at, nowSec),
  poolType: row.is_stable ? "stable" : "amm",
  price: row.price_usd ?? 0,
  symbol: row.symbol,
};
```

f) **Group pools by stablecoin_id** into `Map<string, CgNewPool[]>` (for CG source) and `Map<string, GtNewPool[]>` (for all others).

### Step 3: Count and merge

**Since `mergeCgPools` and `mergeGtPools` return `void`** (they modify `metrics` in place), count the total pools in the maps before calling merge:

```typescript
let mergedCount = 0;
for (const pools of cgPoolMap.values()) mergedCount += pools.length;
for (const pools of gtPoolMap.values()) mergedCount += pools.length;

if (cgPoolMap.size > 0) mergeCgPools(metrics, cgPoolMap);
if (gtPoolMap.size > 0) mergeGtPools(metrics, gtPoolMap);
```

Note: `mergeCgPools` handles balance ratio and locked liquidity for CG pools. `mergeGtPools` uses neutral defaults (balance=1.0, organic=0.5) which matches `STAGED_POOL_DEFAULTS`.

### Step 4: Return

```typescript
return { mergedCount, skippedCount };
```

3. In `worker/src/cron/dex-liquidity/orchestrator.ts`, add the staging merge call.

Find the point between `processPoolMetrics()` and `computeStablecoinScores()`. Add:

```typescript
import { mergeStagedPools } from "./staging-merge";

// ... after processPoolMetrics() call and before computeStablecoinScores():
const { mergedCount: stagedMergedCount, skippedCount: stagedSkippedCount } =
  await mergeStagedPools(db, metrics, knownPoolAddrs, syncStartSec);

// ... in the metadata JSON at the end, add these fields:
stagedPoolsMerged: stagedMergedCount,
stagedPoolsSkipped: stagedSkippedCount,
```

4. Create unit tests in `worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { stagedPoolConfidence, stagedPoolMaturityDays } from "../../dex-discovery/types";

describe("stagedPoolConfidence", () => {
  it("returns 1.0 for freshly refreshed pool", () => {
    expect(stagedPoolConfidence(0)).toBe(1);
  });
  it("returns 0.75 for 12-hour-old pool", () => {
    expect(stagedPoolConfidence(12)).toBe(0.75);
  });
  it("returns 0.5 for 24-hour-old pool", () => {
    expect(stagedPoolConfidence(24)).toBe(0.5);
  });
  it("returns 0 for pool older than 24h", () => {
    expect(stagedPoolConfidence(25)).toBe(0);
  });
});

describe("stagedPoolMaturityDays", () => {
  it("computes days since discovery", () => {
    const now = 1710000000;
    expect(stagedPoolMaturityDays(now - 86400 * 10, now)).toBe(10);
  });
  it("caps at 30 days", () => {
    const now = 1710000000;
    expect(stagedPoolMaturityDays(now - 86400 * 60, now)).toBe(30);
  });
  it("returns 0 for future discovery (clock skew)", () => {
    const now = 1710000000;
    expect(stagedPoolMaturityDays(now + 1000, now)).toBe(0);
  });
});

describe("mergeStagedPools", () => {
  it("returns zero counts with empty staging table", async () => {
    const mockDb = {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: [] }),
        }),
      }),
    } as unknown as D1Database;

    const { mergeStagedPools } = await import("../staging-merge");
    const metrics = new Map();
    const knownPoolAddrs = new Set<string>();
    const result = await mergeStagedPools(mockDb, metrics, knownPoolAddrs, 1710000000);

    expect(result.mergedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
  });

  it("skips pools that exist in knownPoolAddrs", async () => {
    const mockDb = {
      prepare: () => ({
        bind: () => ({
          all: async () => ({
            results: [{
              pool_id: "ethereum:0xabc",
              stablecoin_id: "usdc-usd-coin",
              source: "gecko_terminal",
              chain: "ethereum",
              protocol: "uniswap_v3",
              symbol: "USDC/USDT",
              tvl_usd: 100000,
              volume_24h: 50000,
              fee_tier: null,
              balance_ratio: null,
              is_stable: 1,
              base_token: "0xabc",
              quote_token: "0xdef",
              quote_symbol: "USDT",
              price_usd: 1.0,
              locked_liq_pct: null,
              discovered_at: 1709900000,
              refreshed_at: 1710000000,
            }],
          }),
        }),
      }),
    } as unknown as D1Database;

    const { mergeStagedPools } = await import("../staging-merge");
    const metrics = new Map();
    const knownPoolAddrs = new Set(["ethereum:0xabc"]);
    const result = await mergeStagedPools(mockDb, metrics, knownPoolAddrs, 1710000000);

    expect(result.skippedCount).toBe(1);
    expect(result.mergedCount).toBe(0);
  });

  it("gracefully handles missing staging table", async () => {
    const mockDb = {
      prepare: () => ({
        bind: () => ({
          all: async () => { throw new Error("no such table: dex_pool_staging"); },
        }),
      }),
    } as unknown as D1Database;

    const { mergeStagedPools } = await import("../staging-merge");
    const metrics = new Map();
    const knownPoolAddrs = new Set<string>();
    const result = await mergeStagedPools(mockDb, metrics, knownPoolAddrs, 1710000000);

    expect(result.mergedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
  });
});
```

Note: Use actual stablecoin IDs from the codebase (check `TRACKED_STABLECOINS` for format — IDs look like `"usdc-usd-coin"`, `"usdt-tether"`, etc.). Or use dynamic import to avoid needing to mock `TRACKED_STABLECOINS`.

## Acceptance Criteria

- `cd worker && npx tsc --noEmit` exits 0
- `npm test -- --run worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts` — all tests pass
- `mergeStagedPools` is called in orchestrator between pool metrics processing and scoring
- `grep -c "mergeStagedPools" worker/src/cron/dex-liquidity/orchestrator.ts` returns >= 1
- Primary source pools take precedence (pools in `knownPoolAddrs` are skipped)
- Uses `getGtDexQuality(protocol)` NOT `getQualityMultiplier(protocol, ...)` for staged pools
- No `import type { D1Database }` anywhere — it's a global
- Gracefully handles missing staging table (try/catch returns 0/0)
- Confidence decay applied to both TVL and volume
- CG-sourced pools preserve `balanceRatio` and `lockedLiqPct`
- `npm run build` exits 0
- `npm test` exits 0 (no regressions)
- `npm run lint` exits 0
