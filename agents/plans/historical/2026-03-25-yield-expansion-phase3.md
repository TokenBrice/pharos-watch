# Yield Coverage Expansion — Phase 3: Infrastructure & Discovery Automation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make yield coverage self-expanding over time by automating source discovery, improving matching accuracy, and reducing manual curation overhead.

**Architecture:** Four infrastructure improvements that operate at the matching/discovery layer rather than adding new API sources. Phase 3 assumes Phase 1+2 is complete (protocol-native adapters already in place). These improvements reduce the ongoing maintenance burden by catching new pools, protocols, and wrapper tokens automatically.

**Tech Stack:** TypeScript, Cloudflare Workers (D1 + KV), Vitest, DeFiLlama Yields API.

**Prerequisites:** Phase 1+2 complete. The expanded protocol allowlist and batch adapters from Phase 2 provide the foundation that Phase 3 automates on top of.

**Connection budget:** The monthly coverage audit cron runs in its own isolated slot (not shared with other jobs), so it has the full 6-connection pool. It makes 1 call (DL pools load, usually cached) + 1 DB query. Minimal resource impact.

---

## Task 1: Chain-scoped Layer 3 symbol matching

**Files:**
- Modify: `worker/src/cron/yield-helpers.ts` (`findBestLendingPool`, `matchAllDlPools`)
- Modify: `worker/src/cron/yield-sync/resolve.ts` (pass chain context to matching)
- Test: `worker/src/cron/__tests__/yield-helpers.test.ts`

Currently, Layer 3 (symbol fallback) uses `.includes()` substring matching without considering chain. A coin tracked on Ethereum could match a Solana lending pool for a different token with the same symbol. Adding chain awareness prevents cross-chain false positives.

- [ ] **Step 1: Write test demonstrating the cross-chain false positive**

In `worker/src/cron/__tests__/yield-helpers.test.ts`:

```typescript
describe("findBestLendingPool with chain scope", () => {
  it("does not match a Solana pool for an Ethereum-only coin", () => {
    const pool = {
      pool: "p1", chain: "Solana", project: "kamino-lend", symbol: "USDC",
      tvlUsd: 200_000, apy: 5, apyBase: 5, apyReward: null,
      stablecoin: true, exposure: "single", underlyingTokens: null,
    };

    // Pass chain filter for Ethereum-only coin
    const result = findBestLendingPool("USDC", [pool], LENDING_PROTOCOL_ALLOWLIST, {
      minApy: 0.1, minTvlUsd: 100_000, contractAddresses: [],
      chainFilter: new Set(["Ethereum"]),
    });

    expect(result).toBeNull();
  });

  it("matches a pool on the correct chain", () => {
    const pool = {
      pool: "p2", chain: "Ethereum", project: "aave-v3", symbol: "USDC",
      tvlUsd: 500_000, apy: 4, apyBase: 4, apyReward: null,
      stablecoin: true, exposure: "single", underlyingTokens: null,
    };

    const result = findBestLendingPool("USDC", [pool], LENDING_PROTOCOL_ALLOWLIST, {
      minApy: 0.1, minTvlUsd: 100_000, contractAddresses: [],
      chainFilter: new Set(["Ethereum"]),
    });

    expect(result).toBeTruthy();
  });

  it("matches any chain when chainFilter is omitted (backwards compat)", () => {
    const pool = {
      pool: "p3", chain: "Solana", project: "kamino-lend", symbol: "USDC",
      tvlUsd: 200_000, apy: 5, apyBase: 5, apyReward: null,
      stablecoin: true, exposure: "single", underlyingTokens: null,
    };

    const result = findBestLendingPool("USDC", [pool], LENDING_PROTOCOL_ALLOWLIST, {
      minApy: 0.1, minTvlUsd: 100_000, contractAddresses: [],
    });

    expect(result).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-helpers.test.ts`

- [ ] **Step 3: Add optional chainFilter to findBestLendingPool**

In `worker/src/cron/yield-helpers.ts`, the function has an inline optional options type (line 173-177). Add `chainFilter` as an optional field and a `chain` field to the pool type:

```typescript
export function findBestLendingPool(
  symbol: string,
  dlPools: Array<{
    pool: string; symbol: string; project: string; tvlUsd: number;
    apy: number; apyBase: number | null; apyReward: number | null;
    stablecoin: boolean; exposure: string;
    underlyingTokens?: string[] | null;
    chain?: string; // NEW: optional chain field (DL pool objects have it)
  }>,
  allowlist: Set<string>,
  options?: {
    minApy?: number;
    minTvlUsd?: number;
    contractAddresses?: string[];
    chainFilter?: Set<string>; // NEW: optional DL chain names to restrict to
  },
): { pool: string; apy: number; apyBase: number | null; apyReward: number | null; tvlUsd: number; project: string } | null {
  const symLower = symbol.toLowerCase();
  const minApy = options?.minApy ?? 0;
  const minTvlUsd = options?.minTvlUsd ?? 0;
  const contractSet = new Set((options?.contractAddresses ?? []).map((a) => a.toLowerCase()));
  const chainFilter = options?.chainFilter; // NEW

  // Preserve existing two-phase architecture: add chain filter to baseCandidates only
  const baseCandidates = dlPools.filter((p) =>
    p.exposure === "single" &&
    p.stablecoin &&
    allowlist.has(p.project) &&
    p.apy >= minApy &&
    p.tvlUsd >= minTvlUsd &&
    (!chainFilter || !p.chain || chainFilter.has(p.chain)) // NEW: chain filter (permissive if chain missing)
  );

  // Primary match: exact symbol (UNCHANGED)
  const symbolCandidates = baseCandidates.filter((p) => p.symbol.toLowerCase() === symLower);
  // ... rest of two-phase logic unchanged ...
}
```

**Important:** Do NOT collapse the two-phase matching (symbol match → address fallback). Only add the chain filter to `baseCandidates`. Both phases continue to use `baseCandidates` as their input.

- [ ] **Step 4: Build chain filter from coin metadata in resolve.ts**

In `worker/src/cron/yield-sync/resolve.ts`, when calling `findBestLendingPool`, derive chain names from the coin's contract deployments:

```typescript
// Map Pharos chain IDs to DeFiLlama chain names
const PHAROS_TO_DL_CHAIN: Record<string, string> = {
  "ethereum": "Ethereum",
  "arbitrum": "Arbitrum",
  "base": "Base",
  "optimism": "Optimism",
  "polygon": "Polygon",
  "avalanche": "Avalanche",
  "bsc": "BSC",
  "solana": "Solana",
  "gnosis": "Gnosis",
  // ... extend as needed
};

// Inside auto-lending loop:
const coinChains = new Set(
  (meta.contracts ?? [])
    .map((c) => PHAROS_TO_DL_CHAIN[c.chain])
    .filter(Boolean),
);
// Only apply chain filter if coin has known deployments; omit for universal coins
const chainFilter = coinChains.size > 0 ? coinChains : undefined;

const pool = findBestLendingPool(meta.symbol, dlPools, LENDING_PROTOCOL_ALLOWLIST, {
  minApy: MIN_LENDING_POOL_APY,
  minTvlUsd: MIN_LENDING_POOL_TVL_USD,
  contractAddresses: (meta.contracts ?? []).map((c) => c.address),
  chainFilter,
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-helpers.test.ts`

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/yield-helpers.ts worker/src/cron/yield-sync/resolve.ts worker/src/cron/__tests__/yield-helpers.test.ts
git commit -m "feat(yield): add chain-scoped Layer 3 symbol matching to prevent cross-chain false positives"
```

---

## Task 2: Variant symbol auto-scanning

**Files:**
- Create: `worker/src/cron/yield-sync/variant-scanner.ts`
- Modify: `worker/src/cron/yield-sync/resolve.ts` (call scanner after static matching)
- Test: `worker/src/cron/__tests__/yield-variant-scanner.test.ts`

Currently, wrapper/savings tokens (sUSDe, sDAI, fxSAVE, etc.) must be manually added to `YIELD_VARIANT_MAP`. This scanner automatically detects new wrapper patterns in DeFiLlama pool data by matching known prefix/suffix patterns against tracked stablecoin symbols.

- [ ] **Step 1: Write test for the scanner**

Create `worker/src/cron/__tests__/yield-variant-scanner.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { scanForNewVariants } from "../yield-sync/variant-scanner";
import type { DlPool } from "../yield-sync/types";

describe("scanForNewVariants", () => {
  const knownVariants = new Set(["SUSDE", "SDAI", "SUSDS"]); // Uppercased, matching production wiring

  it("detects sXXX prefix pattern for a tracked symbol", () => {
    const pools: DlPool[] = [{
      pool: "new-pool", chain: "Ethereum", project: "some-protocol",
      symbol: "sFRAX", tvlUsd: 5_000_000, apy: 3.5, apyBase: 3.5,
      apyReward: null, apyMean30d: 3.5, stablecoin: false,
      exposure: "single", underlyingTokens: null,
    }];
    const trackedSymbols = new Set(["FRAX", "USDC", "USDe"]);

    const results = scanForNewVariants(pools, trackedSymbols, knownVariants);
    expect(results).toContainEqual(expect.objectContaining({
      baseSymbol: "FRAX",
      variantSymbol: "sFRAX",
      poolId: "new-pool",
    }));
  });

  it("skips variants already in the known set", () => {
    const pools: DlPool[] = [{
      pool: "existing", chain: "Ethereum", project: "ethena",
      symbol: "sUSDe", tvlUsd: 3_000_000_000, apy: 4.0, apyBase: 4.0,
      apyReward: null, apyMean30d: 4.0, stablecoin: false,
      exposure: "single", underlyingTokens: null,
    }];
    const trackedSymbols = new Set(["USDe"]);

    const results = scanForNewVariants(pools, trackedSymbols, knownVariants);
    expect(results).toEqual([]);
  });

  it("detects SAVE/VAULT/EARN suffix patterns", () => {
    const pools: DlPool[] = [{
      pool: "save-pool", chain: "Ethereum", project: "fx-protocol",
      symbol: "fxSAVE", tvlUsd: 30_000_000, apy: 5, apyBase: 5,
      apyReward: null, apyMean30d: 5, stablecoin: false,
      exposure: "single", underlyingTokens: null,
    }];
    const trackedSymbols = new Set(["fxUSD"]);

    const results = scanForNewVariants(pools, trackedSymbols, knownVariants);
    // fxSAVE: strip "SAVE" suffix → "fx" which doesn't match "fxUSD" (case-sensitive)
    // This tests that partial prefix matches are NOT false-positived
    expect(results).toEqual([]);
  });

  it("requires minimum TVL to avoid noise", () => {
    const pools: DlPool[] = [{
      pool: "tiny", chain: "Ethereum", project: "unknown",
      symbol: "sUSDC", tvlUsd: 1_000, apy: 10, apyBase: 10,
      apyReward: null, apyMean30d: 10, stablecoin: false,
      exposure: "single", underlyingTokens: null,
    }];
    const trackedSymbols = new Set(["USDC"]);

    const results = scanForNewVariants(pools, trackedSymbols, knownVariants);
    expect(results).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-variant-scanner.test.ts`

- [ ] **Step 3: Implement the scanner**

Create `worker/src/cron/yield-sync/variant-scanner.ts`:

```typescript
import type { DlPool } from "./types";

const MIN_VARIANT_TVL_USD = 500_000;
const WRAPPER_PREFIX_PATTERNS = ["s", "st", "w"]; // sXXX, stXXX, wXXX
const WRAPPER_SUFFIX_PATTERNS = ["SAVE", "VAULT", "EARN", "STAKE"];

interface DiscoveredVariant {
  baseSymbol: string;
  variantSymbol: string;
  poolId: string;
  chain: string;
  project: string;
  tvlUsd: number;
  apy: number;
}

export function scanForNewVariants(
  dlPools: DlPool[],
  trackedSymbols: Set<string>,
  knownVariantSymbols: Set<string>,
): DiscoveredVariant[] {
  const results: DiscoveredVariant[] = [];
  const seen = new Set<string>();

  for (const pool of dlPools) {
    if (pool.exposure !== "single") continue;
    if (pool.tvlUsd < MIN_VARIANT_TVL_USD) continue;
    if (pool.apy <= 0) continue;

    const sym = pool.symbol.toUpperCase();
    if (knownVariantSymbols.has(sym)) continue; // Use uppercased sym for consistent comparison

    // Check prefix patterns: sXXX where XXX is a tracked symbol
    for (const prefix of WRAPPER_PREFIX_PATTERNS) {
      const prefixUpper = prefix.toUpperCase();
      if (sym.startsWith(prefixUpper) && sym.length > prefixUpper.length) {
        const candidate = sym.slice(prefixUpper.length);
        if (trackedSymbols.has(candidate) && !seen.has(sym)) {
          results.push({
            baseSymbol: candidate,
            variantSymbol: pool.symbol,
            poolId: pool.pool,
            chain: pool.chain,
            project: pool.project,
            tvlUsd: pool.tvlUsd,
            apy: pool.apy,
          });
          seen.add(sym);
        }
      }
    }

    // Check suffix patterns: XXX + SAVE/VAULT/EARN
    for (const suffix of WRAPPER_SUFFIX_PATTERNS) {
      const suffixUpper = suffix.toUpperCase();
      if (sym.endsWith(suffixUpper) && sym.length > suffixUpper.length) {
        const candidate = sym.slice(0, -suffixUpper.length);
        if (trackedSymbols.has(candidate) && !seen.has(sym)) {
          results.push({
            baseSymbol: candidate,
            variantSymbol: pool.symbol,
            poolId: pool.pool,
            chain: pool.chain,
            project: pool.project,
            tvlUsd: pool.tvlUsd,
            apy: pool.apy,
          });
          seen.add(sym);
        }
      }
    }
  }

  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-variant-scanner.test.ts`

- [ ] **Step 5: Wire scanner into resolve pipeline as advisory logging**

In `worker/src/cron/yield-sync/resolve.ts`, after the auto-lending discovery loop (find the `console.log(...Auto-discovery...)` line as anchor):

```typescript
import { scanForNewVariants } from "./variant-scanner";

// Advisory: log newly discovered wrapper tokens for manual review
const trackedSymbols = new Set(TRACKED_STABLECOINS.map((m) => m.symbol.toUpperCase()));
const knownVariantSymbols = new Set(
  Object.values(YIELD_VARIANT_MAP).map((v) => v.variantSymbol.toUpperCase()),
);
const newVariants = scanForNewVariants(dlPools, trackedSymbols, knownVariantSymbols);
if (newVariants.length > 0) {
  console.log(
    `[sync-yield-data] Variant scanner found ${newVariants.length} new wrapper tokens:`,
    newVariants.map((v) => `${v.variantSymbol} (${v.baseSymbol}, ${v.chain}, $${(v.tvlUsd / 1e6).toFixed(1)}M)`).join(", "),
  );
}
```

**Note:** Phase 3 starts with advisory logging only (no auto-insertion into rankings). Auto-insertion can be enabled in a follow-up after validating the scanner's accuracy over a few weeks.

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/yield-sync/variant-scanner.ts worker/src/cron/yield-sync/resolve.ts \
       worker/src/cron/__tests__/yield-variant-scanner.test.ts
git commit -m "feat(yield): add variant symbol auto-scanner for new wrapper token discovery"
```

---

## Task 3: Monthly coverage audit cron

**Files:**
- Create: `worker/src/cron/yield-coverage-audit.ts`
- Modify: `worker/wrangler.toml` (add monthly cron trigger)
- Test: `worker/src/cron/__tests__/yield-coverage-audit.test.ts`

Automated monthly job that compares the DeFiLlama pool universe against Pharos yield coverage, flags high-TVL pools we're missing, and writes a coverage report to the DB cache for dashboard consumption.

- [ ] **Step 1: Write test for the audit logic**

Create `worker/src/cron/__tests__/yield-coverage-audit.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { identifyCoverageGaps } from "../yield-coverage-audit";
import type { DlPool } from "../yield-sync/types";

describe("identifyCoverageGaps", () => {
  it("identifies high-TVL stablecoin pools not matched to any tracked coin", () => {
    const dlPools: DlPool[] = [{
      pool: "unknown-pool", chain: "Ethereum", project: "new-protocol",
      symbol: "NEW_STABLE", tvlUsd: 50_000_000, apy: 5, apyBase: 5,
      apyReward: null, apyMean30d: 5, stablecoin: true,
      exposure: "single", underlyingTokens: null,
    }];
    const coveredPoolIds = new Set<string>(); // nothing covered
    const trackedSymbols = new Set(["USDC", "USDT"]);

    const gaps = identifyCoverageGaps(dlPools, coveredPoolIds, trackedSymbols);
    expect(gaps.unmatchedHighTvlPools.length).toBe(1);
    expect(gaps.unmatchedHighTvlPools[0].pool).toBe("unknown-pool");
  });

  it("does not flag pools already covered", () => {
    const dlPools: DlPool[] = [{
      pool: "covered-pool", chain: "Ethereum", project: "aave-v3",
      symbol: "USDC", tvlUsd: 100_000_000, apy: 3, apyBase: 3,
      apyReward: null, apyMean30d: 3, stablecoin: true,
      exposure: "single", underlyingTokens: null,
    }];
    const coveredPoolIds = new Set(["covered-pool"]);
    const trackedSymbols = new Set(["USDC"]);

    const gaps = identifyCoverageGaps(dlPools, coveredPoolIds, trackedSymbols);
    expect(gaps.unmatchedHighTvlPools.length).toBe(0);
  });

  it("identifies protocols with stablecoin pools not in allowlist", () => {
    const dlPools: DlPool[] = [{
      pool: "p1", chain: "Ethereum", project: "brand-new-protocol",
      symbol: "USDC", tvlUsd: 10_000_000, apy: 4, apyBase: 4,
      apyReward: null, apyMean30d: 4, stablecoin: true,
      exposure: "single", underlyingTokens: null,
    }];

    const gaps = identifyCoverageGaps(dlPools, new Set(), new Set(["USDC"]));
    expect(gaps.missingProtocols.length).toBeGreaterThan(0);
    expect(gaps.missingProtocols[0].project).toBe("brand-new-protocol");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-coverage-audit.test.ts`

- [ ] **Step 3: Implement the audit logic**

Create `worker/src/cron/yield-coverage-audit.ts`:

```typescript
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { setCache } from "../lib/db-cache";
import { LENDING_PROTOCOL_ALLOWLIST, YIELD_POOL_MAP, YIELD_VARIANT_MAP } from "./yield-config";
import { loadDlStablecoinPools } from "./yield-sync/sources";
import type { DlPool } from "./yield-sync/types";
import type { CronResult } from "../lib/cron-logger";

const MIN_GAP_TVL_USD = 1_000_000; // Only flag pools with >$1M TVL

interface CoverageGap {
  unmatchedHighTvlPools: Array<{
    pool: string; chain: string; project: string; symbol: string; tvlUsd: number; apy: number;
  }>;
  missingProtocols: Array<{
    project: string; poolCount: number; totalTvlUsd: number;
  }>;
  variantCandidates: Array<{
    baseSymbol: string; variantSymbol: string; poolId: string; tvlUsd: number;
  }>;
  summary: {
    totalDlPools: number; coveredPools: number; coverageRatio: number;
    auditDate: string;
  };
}

export function identifyCoverageGaps(
  dlPools: DlPool[],
  coveredPoolIds: Set<string>,
  trackedSymbols: Set<string>,
): CoverageGap {
  const singleExposureStablePools = dlPools.filter(
    (p) => p.exposure === "single" && p.stablecoin && p.tvlUsd >= MIN_GAP_TVL_USD,
  );

  // 1. High-TVL pools not matched to any tracked coin
  const unmatchedHighTvlPools = singleExposureStablePools
    .filter((p) => !coveredPoolIds.has(p.pool))
    .sort((a, b) => b.tvlUsd - a.tvlUsd)
    .slice(0, 50)
    .map((p) => ({
      pool: p.pool, chain: p.chain, project: p.project,
      symbol: p.symbol, tvlUsd: p.tvlUsd, apy: p.apy,
    }));

  // 2. Protocols with stablecoin pools not in allowlist
  const nonAllowlistedPools = singleExposureStablePools.filter(
    (p) => !LENDING_PROTOCOL_ALLOWLIST.has(p.project),
  );
  const byProject = new Map<string, { count: number; tvl: number }>();
  for (const p of nonAllowlistedPools) {
    const entry = byProject.get(p.project) ?? { count: 0, tvl: 0 };
    entry.count++;
    entry.tvl += p.tvlUsd;
    byProject.set(p.project, entry);
  }
  const missingProtocols = [...byProject.entries()]
    .filter(([, v]) => v.tvl >= MIN_GAP_TVL_USD)
    .map(([project, v]) => ({ project, poolCount: v.count, totalTvlUsd: v.tvl }))
    .sort((a, b) => b.totalTvlUsd - a.totalTvlUsd)
    .slice(0, 20);

  // 3. Coverage summary
  const covered = singleExposureStablePools.filter((p) => coveredPoolIds.has(p.pool)).length;

  return {
    unmatchedHighTvlPools,
    missingProtocols,
    variantCandidates: [], // Populated by variant scanner (Task 2)
    summary: {
      totalDlPools: singleExposureStablePools.length,
      coveredPools: covered,
      coverageRatio: singleExposureStablePools.length > 0
        ? covered / singleExposureStablePools.length
        : 1,
      auditDate: new Date().toISOString().split("T")[0],
    },
  };
}

export async function runYieldCoverageAudit(
  db: D1Database,
  signal?: AbortSignal,
): Promise<CronResult> {
  const { pools } = await loadDlStablecoinPools(db, signal);

  const coveredPoolIds = new Set([
    ...Object.values(YIELD_POOL_MAP),
    // Variant pools are matched dynamically — approximate by collecting all pool IDs
    // that were used in the last yield sync (stored in yield_data table)
  ]);

  // Also load currently active source_pool values from yield_data
  const activeRows = await db
    .prepare("SELECT DISTINCT source_pool FROM yield_data WHERE source_pool IS NOT NULL")
    .all<{ source_pool: string }>();
  for (const row of activeRows.results ?? []) {
    coveredPoolIds.add(row.source_pool);
  }

  const trackedSymbols = new Set(TRACKED_STABLECOINS.map((m) => m.symbol.toUpperCase()));
  const gaps = identifyCoverageGaps(pools, coveredPoolIds, trackedSymbols);

  // Write audit report to cache for optional dashboard consumption
  await setCache(db, "yield-coverage-audit", JSON.stringify(gaps));

  console.log(
    `[yield-coverage-audit] Coverage: ${gaps.summary.coveredPools}/${gaps.summary.totalDlPools} pools (${(gaps.summary.coverageRatio * 100).toFixed(1)}%). ` +
    `Gaps: ${gaps.unmatchedHighTvlPools.length} unmatched high-TVL pools, ${gaps.missingProtocols.length} missing protocols.`,
  );

  return {
    status: "ok",
    itemCount: gaps.unmatchedHighTvlPools.length + gaps.missingProtocols.length,
    metadata: JSON.stringify({
      coverageRatio: gaps.summary.coverageRatio,
      unmatchedCount: gaps.unmatchedHighTvlPools.length,
      missingProtocolCount: gaps.missingProtocols.length,
      topGaps: gaps.unmatchedHighTvlPools.slice(0, 5).map((p) => `${p.symbol}@${p.project}`),
    }),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-coverage-audit.test.ts`

- [ ] **Step 5: Register the cron trigger**

The cron system uses a registry pattern, not a switch/case. Three files to update:

**5a.** In `shared/lib/cron-jobs.ts`, add a new schedule key to `CRON_SCHEDULES`:

```typescript
export const CRON_SCHEDULES = {
  // ... existing schedules ...
  monthlyYieldAudit: "0 6 1 * *",
} as const;
```

And add the corresponding bucket to `CRON_SCHEDULE_BUCKETS`:

```typescript
monthlyYieldAudit: { intervalSec: 30 * 86400, offsetSec: 6 * 3600 },
```

**5b.** Create a slot runner at `worker/src/handlers/scheduled/monthly-yield-audit.ts`.

The slot runner must follow the established pattern used by all existing runners (see `half-hourly.ts` for reference): use `runtime.runLeasedCron(job, fn)` which accepts `(signal: AbortSignal, reportProgress: CronProgressReporter) => Promise<CronResult | void>`:

```typescript
import type { ScheduledRuntimeContext } from "./context";
import { runYieldCoverageAudit } from "../../cron/yield-coverage-audit";

export async function runMonthlyYieldAuditSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  try {
    await runtime.runLeasedCron("yield-coverage-audit", (signal) =>
      runYieldCoverageAudit(runtime.db, signal),
    );
  } catch (err) {
    console.error("[cron] yield-coverage-audit failed in monthly slot:", err);
  }
}
```

**5c.** Add a job definition entry to `CRON_JOB_DEFINITIONS_BASE` in `shared/lib/cron-jobs.ts` (required for status page and cron infrastructure to recognize the new job):

```typescript
{
  job: "yield-coverage-audit",
  label: "Yield coverage audit",
  group: "other",
  intervalSec: 30 * 86400,
  scheduleKey: "monthlyYieldAudit",
  triggerMode: "isolated",
  maxConnections: 1,
},
```

**5d.** In `worker/src/handlers/scheduled.ts`, import and register:

```typescript
import { runMonthlyYieldAuditSlot } from "./scheduled/monthly-yield-audit";

const SLOT_RUNNER_BY_SCHEDULE: Record<string, SlotRunner> = {
  // ... existing entries ...
  [CRON_SCHEDULES.monthlyYieldAudit]: runMonthlyYieldAuditSlot,
};
```

**5e.** In `worker/wrangler.toml`, add the cron expression to the triggers array:

```toml
crons = [
  # ... existing crons ...
  "0 6 1 * *"
]
```

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/yield-coverage-audit.ts worker/src/cron/__tests__/yield-coverage-audit.test.ts \
       shared/lib/cron-jobs.ts worker/src/handlers/scheduled.ts \
       worker/src/handlers/scheduled/monthly-yield-audit.ts worker/wrangler.toml
git commit -m "feat(yield): add monthly yield coverage audit cron"
```

---

## Task 4: Protocol allowlist auto-expansion alerts

**Files:**
- Modify: `worker/src/cron/yield-coverage-audit.ts` (add protocol recommendation logic)
- Test: `worker/src/cron/__tests__/yield-coverage-audit.test.ts`

Extend the coverage audit to produce actionable protocol recommendations: protocols with >$5M stablecoin TVL across single-exposure pools that are NOT in our allowlist.

- [ ] **Step 1: Write test for protocol recommendations**

In `worker/src/cron/__tests__/yield-coverage-audit.test.ts`:

```typescript
describe("protocol recommendations", () => {
  it("recommends protocols with >$5M stablecoin TVL not in allowlist", () => {
    const dlPools: DlPool[] = [
      {
        pool: "p1", chain: "Ethereum", project: "rising-protocol",
        symbol: "USDC", tvlUsd: 3_000_000, apy: 4, apyBase: 4,
        apyReward: null, apyMean30d: 4, stablecoin: true,
        exposure: "single", underlyingTokens: null,
      },
      {
        pool: "p2", chain: "Ethereum", project: "rising-protocol",
        symbol: "USDT", tvlUsd: 4_000_000, apy: 3.5, apyBase: 3.5,
        apyReward: null, apyMean30d: 3.5, stablecoin: true,
        exposure: "single", underlyingTokens: null,
      },
    ];

    const gaps = identifyCoverageGaps(dlPools, new Set(), new Set(["USDC", "USDT"]));
    expect(gaps.protocolRecommendations).toContainEqual(
      expect.objectContaining({
        project: "rising-protocol",
        totalTvlUsd: 7_000_000,
        recommendedTier: "high-confidence",
      }),
    );
  });
});
```

- [ ] **Step 2: Run test**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-coverage-audit.test.ts`

- [ ] **Step 3: Add recommendation tier to CoverageGap type**

In `yield-coverage-audit.ts`:

1. Extend the `CoverageGap` interface:

```typescript
interface CoverageGap {
  // ... existing fields ...
  protocolRecommendations: Array<{
    project: string;
    poolCount: number;
    totalTvlUsd: number;
    recommendedTier: "high-confidence" | "review-needed";
    examplePools: string[]; // Top 3 pool UUIDs for manual review
  }>;
}
```

2. Add the recommendation logic inside `identifyCoverageGaps()` to populate the new field.

3. **Update the return statement** of `identifyCoverageGaps()` to include the new field (currently returns `variantCandidates: []` — add `protocolRecommendations` alongside it):

```typescript
return {
  unmatchedHighTvlPools,
  missingProtocols,
  variantCandidates: [],
  protocolRecommendations, // NEW
  summary: { ... },
};
```

The recommendation logic:
- `high-confidence`: >$10M total stablecoin TVL, >3 pools, all pools pass quality filters
- `review-needed`: >$5M total TVL but fewer pools or lower quality signals

- [ ] **Step 4: Run tests**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-coverage-audit.test.ts`

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/yield-coverage-audit.ts worker/src/cron/__tests__/yield-coverage-audit.test.ts
git commit -m "feat(yield): add protocol allowlist recommendations to coverage audit"
```

---

## Task 5: Update documentation and bump methodology version

**Files:**
- Modify: `docs/yield-intelligence.md`
- Modify: `shared/lib/yield-methodology-version.ts`
- Modify: `docs/yield-intelligence-timeline.md`

- [ ] **Step 1: Document Phase 3 infrastructure in yield-intelligence.md**

Add sections for:
- Chain-scoped symbol matching (how it works, which chains are mapped)
- Variant auto-scanner (patterns detected, advisory vs auto-insert mode)
- Monthly coverage audit (what it reports, how to interpret results)

- [ ] **Step 2: Bump methodology version**

```typescript
{
  version: "5.1",
  title: "Yield Infrastructure Automation",
  date: "2026-XX-XX", // actual date
  effectiveAt: Math.floor(Date.now() / 1000), // replace with actual Unix timestamp
  summary:
    "Chain-scoped Layer 3 symbol matching prevents cross-chain false positives, variant symbol auto-scanner detects new wrapper tokens (advisory mode), and monthly yield coverage audit cron provides protocol expansion recommendations.",
  impact: [
    "Chain-scoped matching reduces false positives in auto-lending discovery",
    "Variant scanner detects new wrapper tokens automatically (advisory logs)",
    "Monthly coverage audit cron flags high-TVL gaps and missing protocols",
  ],
  commits: [],
  reconstructed: false,
},
```

- [ ] **Step 3: Run merge gate**

Run: `npm run test:merge-gate`

- [ ] **Step 4: Commit**

```bash
git add docs/yield-intelligence.md shared/lib/yield-methodology-version.ts docs/yield-intelligence-timeline.md
git commit -m "docs: yield methodology v5.1 — infrastructure automation"
```
