# Yield Intelligence Layer — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a yield data pipeline and standalone `/yield/` page that ranks yield-bearing stablecoins by risk-adjusted yield (Pharos Yield Score).

**Architecture:** A new `sync-yield-data` cron (30-min cycle, `10,40` trigger) resolves APY for 15 yield-bearing stablecoins using a three-tier strategy (on-chain rate > DeFiLlama Yields > price-derived). A daily cron fetches the T-bill risk-free rate from the US Treasury API. Two new API endpoints (`/api/yield-rankings`, `/api/yield-history`) serve the data. A standalone `/yield/` page displays a leaderboard table and yield-vs-safety scatter plot.

**Tech Stack:** Cloudflare Workers + D1, TypeScript, Recharts (ScatterChart), TanStack Query, Next.js 16 static export.

**Design doc:** `docs/plans/yield-intelligence-design.md`

---

## Task 1: D1 Migration

**Files:**
- Create: `worker/migrations/0031_yield_data.sql`

**Step 1: Create the migration file**

```sql
-- 0031_yield_data.sql
-- Yield Intelligence: current snapshots + historical data

CREATE TABLE IF NOT EXISTS yield_data (
  stablecoin_id   TEXT PRIMARY KEY,
  symbol          TEXT NOT NULL,
  current_apy     REAL NOT NULL,
  apy_base        REAL,
  apy_reward      REAL,
  apy_7d          REAL NOT NULL,
  apy_30d         REAL NOT NULL,
  yield_source    TEXT NOT NULL,
  yield_type      TEXT NOT NULL,
  source_pool     TEXT,
  source_tvl_usd  REAL,
  data_source     TEXT NOT NULL,
  safety_score    REAL,
  safety_grade    TEXT,
  pharos_yield_score  REAL,
  yield_to_risk       REAL,
  excess_yield        REAL,
  yield_stability     REAL,
  apy_variance_30d    REAL,
  apy_min_30d         REAL,
  apy_max_30d         REAL,
  exchange_rate       REAL,
  exchange_rate_prev  REAL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_yield_pys ON yield_data(pharos_yield_score DESC);
CREATE INDEX IF NOT EXISTS idx_yield_apy ON yield_data(apy_30d DESC);

CREATE TABLE IF NOT EXISTS yield_history (
  stablecoin_id   TEXT NOT NULL,
  recorded_at     INTEGER NOT NULL,
  apy             REAL NOT NULL,
  apy_base        REAL,
  apy_reward      REAL,
  exchange_rate   REAL,
  source_tvl_usd  REAL,
  data_source     TEXT NOT NULL,
  PRIMARY KEY (stablecoin_id, recorded_at)
);

CREATE INDEX IF NOT EXISTS idx_yield_hist_coin ON yield_history(stablecoin_id, recorded_at DESC);
```

**Step 2: Verify migration numbering**

Run: `ls worker/migrations/ | tail -5`
Expected: Latest is `0030_*.sql`, so `0031` is correct.

**Step 3: Commit**

```bash
git add worker/migrations/0031_yield_data.sql
git commit -m "feat(db): add yield_data and yield_history tables"
```

---

## Task 2: Worker Constants & Circuit Breaker

**Files:**
- Modify: `worker/src/lib/constants.ts`

**Step 1: Add yield constants**

Add to `worker/src/lib/constants.ts`:

```typescript
// Yield Intelligence
export const RISK_FREE_RATE_FALLBACK = 4.25;
export const TREASURY_FISCAL_DATA_URL =
  "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/avg_interest_rates?filter=security_desc:eq:Treasury Bills&sort=-record_date&page[size]=1&fields=record_date,avg_interest_rate_amt";
export const PYS_SCALING_FACTOR = 5;
```

Add `"DL_YIELDS"` to `CIRCUIT_SOURCE` if not already there (it is — `DL_YIELDS: "defillama-yields"` exists). Also add the Treasury source:

```typescript
// Add to CIRCUIT_SOURCE:
TREASURY_RATES: "treasury-rates",
```

Add to `CACHE_FRESHNESS_THRESHOLDS`:

```typescript
"yield-data": 3600, // 1 hour (cron runs every 30 min, 2x buffer)
```

**Step 2: Commit**

```bash
git add worker/src/lib/constants.ts
git commit -m "feat(constants): add yield intelligence constants"
```

---

## Task 3: Frontend & Shared Types

**Files:**
- Modify: `src/lib/types.ts`

**Step 1: Add yield types**

Append to `src/lib/types.ts`:

```typescript
// ── Yield Intelligence ──────────────────────────────────────────────
export interface YieldRanking {
  id: string;
  symbol: string;
  name: string;
  currentApy: number;
  apy7d: number;
  apy30d: number;
  apyBase: number | null;
  apyReward: number | null;
  yieldSource: string;
  yieldType: string;
  dataSource: string;
  sourceTvlUsd: number | null;
  pharosYieldScore: number | null;
  safetyScore: number | null;
  safetyGrade: string | null;
  yieldToRisk: number | null;
  excessYield: number | null;
  yieldStability: number | null;
  apyVariance30d: number | null;
  apyMin30d: number | null;
  apyMax30d: number | null;
}

export interface YieldRankingsResponse {
  rankings: YieldRanking[];
  riskFreeRate: number;
  scalingFactor: number;
  updatedAt: number;
}

export interface YieldHistoryPoint {
  date: number;
  apy: number;
  apyBase: number | null;
  apyReward: number | null;
  exchangeRate: number | null;
  sourceTvlUsd: number | null;
}
```

**Step 2: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(types): add YieldRanking and YieldHistoryPoint types"
```

---

## Task 4: YieldConfig on StablecoinMeta

**Files:**
- Modify: `src/lib/types.ts` (add `YieldConfig` type to `StablecoinMeta`)
- Modify: `src/lib/stablecoins.ts` (add `yieldConfig` to `StablecoinOpts`, populate for 15 coins)

**Step 1: Add YieldConfig to types.ts**

Add above the Yield Intelligence section just added:

```typescript
export type YieldType = "lending-vault" | "rebase" | "fee-sharing" | "lp-receipt" | "nav-appreciation" | "governance-set";

export interface YieldConfig {
  /** DeFiLlama pool UUID for deterministic matching */
  defiLlamaPoolId?: string;
  /** Human-readable yield source description */
  yieldSource: string;
  /** Yield mechanism type */
  yieldType: YieldType;
}
```

Add `yieldConfig?: YieldConfig` to the `StablecoinMeta` interface.

**Step 2: Add yieldConfig to StablecoinOpts**

In `src/lib/stablecoins.ts`, add to `StablecoinOpts`:

```typescript
yieldConfig?: import("./types").YieldConfig;
```

In the `coin()` function, add `yieldConfig: opts?.yieldConfig` to the return object.

**Step 3: Populate yieldConfig for all 15 yield-bearing coins**

For each coin flagged `yieldBearing: true`, add a `yieldConfig`. The `defiLlamaPoolId` values will be populated in Task 5. Example:

```typescript
// USDe (146)
yieldConfig: { yieldSource: "Ethena staking (sUSDe)", yieldType: "lending-vault" },

// USYC (237)
yieldConfig: { yieldSource: "Hashnote T-bill fund", yieldType: "nav-appreciation" },

// USDY (129)
yieldConfig: { yieldSource: "Ondo T-bill fund", yieldType: "nav-appreciation" },

// BUIDL (173)
yieldConfig: { yieldSource: "BlackRock T-bill fund", yieldType: "nav-appreciation" },

// YLDS (272)
yieldConfig: { yieldSource: "Figure yield fund", yieldType: "nav-appreciation" },

// reUSD (339)
yieldConfig: { yieldSource: "Re Protocol vault", yieldType: "nav-appreciation" },

// TBILL (257)
yieldConfig: { yieldSource: "OpenEden T-bill vault", yieldType: "nav-appreciation" },

// YUSD (255)
yieldConfig: { yieldSource: "Aegis delta-neutral strategy", yieldType: "lending-vault" },

// USDB (172)
yieldConfig: { yieldSource: "Blast native yield", yieldType: "governance-set" },

// AZND (327)
yieldConfig: { yieldSource: "Mu Digital AUD yield fund", yieldType: "nav-appreciation" },

// OUSD (23)
yieldConfig: { yieldSource: "Origin lending + DeFi strategies", yieldType: "rebase" },

// USP (331)
yieldConfig: { yieldSource: "PikuDAO lending vault", yieldType: "nav-appreciation" },

// syrupUSDC (cg-syrupusdc)
yieldConfig: { yieldSource: "Maple Finance lending", yieldType: "nav-appreciation" },

// syrupUSDT (cg-syrupusdt)
yieldConfig: { yieldSource: "Maple Finance lending", yieldType: "nav-appreciation" },

// yoUSD (cg-yousd)
yieldConfig: { yieldSource: "Yield Optimizer strategies", yieldType: "nav-appreciation" },
```

**Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/stablecoins.ts
git commit -m "feat(stablecoins): add yieldConfig to all 15 yield-bearing coins"
```

---

## Task 5: Static Mapping Data & Research

**Files:**
- Create: `worker/src/cron/yield-config.ts`

This file contains the three static mapping tables: `YIELD_VARIANT_MAP`, `YIELD_POOL_MAP`, and `ON_CHAIN_RATE_CONFIGS`.

**Step 1: Research DeFiLlama pool UUIDs (verification gate)**

Before writing code, query the DL Yields API to find pool UUIDs for each yield-bearing coin. Run this one-time research:

```bash
curl -s 'https://yields.llama.fi/pools' | jq '[.data[] | select(.stablecoin == true and .exposure == "single") | select(.symbol | test("sUSDe|USYC|USDY|BUIDL|YLDS|TBILL|OUSD|USDB|syrupUSDC|syrupUSDT|yoUSD|AZND|USP|reUSD|YUSD"; "i")) | {pool, symbol, project, chain, tvlUsd, apy}] | sort_by(-.tvlUsd)'
```

**GATE:** Record the `pool` UUID for each matched coin in a scratch file or comment. You must match **at least 10 of 15** yield-bearing coins to a DL pool UUID before proceeding. If a coin cannot be matched (no DL pool exists), explicitly mark it as `""` in the map with a `// Tier 3 only: no DL pool found` comment explaining why. Do NOT leave the map as placeholder comments.

Expected outcome: a concrete list like:
```
146 (USDe → sUSDe): abc123-...  ✓
237 (USYC): def456-...          ✓
129 (USDY): no DL pool found    ✗ (Tier 3 only)
...
Matched: 12/15 ✓ (gate passed)
```

If fewer than 10 coins match, widen the search — try variant symbols, check project names, or query without the stablecoin filter. Only proceed to Step 2 once the gate is met.

**Step 2: Create yield-config.ts with all mapping data**

```typescript
// worker/src/cron/yield-config.ts
// Static configuration for the yield intelligence pipeline.

/** Yield variant: maps a tracked Pharos coin to its untracked yield wrapper. */
export interface YieldVariant {
  variantSymbol: string;
  variantAddress?: string;
  variantChain?: string;
}

/**
 * Coins whose yield comes from a SEPARATE wrapper token that Pharos does not track.
 * Used for DL pool matching (search variantSymbol) and on-chain rate queries.
 * Coins NOT here are their own yield token (e.g., USDY, OUSD, BUIDL).
 */
export const YIELD_VARIANT_MAP: Record<string, YieldVariant> = {
  "146": { variantSymbol: "sUSDe", variantAddress: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", variantChain: "ethereum" },
  // Add more as discovered (e.g., if DAI were tracked with sDAI wrapper)
};

/**
 * Maps Pharos stablecoin ID → DeFiLlama pool UUID for deterministic yield matching.
 * Populated from the DL Yields API research in Step 1.
 * GATE: At least 10/15 coins must have real UUIDs before this task is complete.
 * Empty string = Tier 3 only (no DL pool found — must include a comment explaining why).
 */
export const YIELD_POOL_MAP: Record<string, string> = {
  // Fill ALL 15 entries from Step 1 research. Real UUIDs or "" with explanation.
  "146": "FILL_FROM_STEP_1",  // USDe → sUSDe
  "237": "FILL_FROM_STEP_1",  // USYC
  "129": "FILL_FROM_STEP_1",  // USDY
  "173": "FILL_FROM_STEP_1",  // BUIDL
  "272": "FILL_FROM_STEP_1",  // YLDS
  "339": "FILL_FROM_STEP_1",  // reUSD
  "257": "FILL_FROM_STEP_1",  // TBILL
  "255": "FILL_FROM_STEP_1",  // YUSD
  "172": "FILL_FROM_STEP_1",  // USDB
  "327": "FILL_FROM_STEP_1",  // AZND
  "23":  "FILL_FROM_STEP_1",  // OUSD
  "331": "FILL_FROM_STEP_1",  // USP
  // syrupUSDC, syrupUSDT, yoUSD — use IDs from stablecoins.ts
};

/** On-chain exchange rate config for Tier 1 vault tokens. */
export interface OnChainRateConfig {
  stablecoinId: string;
  chain: string;
  contract: string;
  /** 4-byte function selector (e.g., "0x07a2d13a" for convertToAssets) */
  selector: string;
  decimals: number;
  /** Hex-encoded input amount (e.g., 1e18 = "0x0de0b6b3a7640000") */
  inputAmount: string;
}

/**
 * Tier 1: On-chain exchange rate sources.
 * These produce the highest-fidelity APY by reading vault exchange rates directly.
 */
export const ON_CHAIN_RATE_CONFIGS: OnChainRateConfig[] = [
  {
    stablecoinId: "146", // USDe → sUSDe
    chain: "ethereum",
    contract: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
    // convertToAssets(uint256) selector
    selector: "0x07a2d13a",
    decimals: 18,
    // 1e18 in hex
    inputAmount: "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
];
```

**Step 3: Commit**

```bash
git add worker/src/cron/yield-config.ts
git commit -m "feat(yield): add static mapping data (variant map, pool map, on-chain configs)"
```

---

## Task 6: Pure Computation Helpers + Tests

**Files:**
- Create: `worker/src/cron/yield-helpers.ts`
- Create: `src/lib/__tests__/yield-helpers.test.ts`

These are pure functions with no I/O — testable in isolation.

**Step 1: Write the failing tests**

```typescript
// src/lib/__tests__/yield-helpers.test.ts
import { describe, it, expect } from "vitest";
import {
  computePYS,
  computeApyFromRate,
  computeApyFromPrice,
  computeYieldStability,
  detectWarningSignals,
} from "../../worker/src/cron/yield-helpers";

describe("computeApyFromRate", () => {
  it("returns correct APY for 7-day rate change", () => {
    // Rate went from 1.0 to 1.001 in 7 days → ~7.6% APY
    const apy = computeApyFromRate(1.001, 1.0, 7);
    expect(apy).toBeCloseTo(7.6, 0);
  });

  it("returns 0 when rates are equal", () => {
    expect(computeApyFromRate(1.0, 1.0, 7)).toBe(0);
  });

  it("returns negative for decreasing rate", () => {
    expect(computeApyFromRate(0.999, 1.0, 7)).toBeLessThan(0);
  });

  it("returns 0 when previous rate is 0", () => {
    expect(computeApyFromRate(1.0, 0, 7)).toBe(0);
  });
});

describe("computeApyFromPrice", () => {
  it("computes annualized return from 30-day price change", () => {
    // Price went from 1.00 to 1.01 in 30 days → ~12.8% APY
    const apy = computeApyFromPrice(1.01, 1.0, 30);
    expect(apy).toBeCloseTo(12.8, 0);
  });

  it("returns 0 when prices are equal", () => {
    expect(computeApyFromPrice(1.0, 1.0, 30)).toBe(0);
  });

  it("returns 0 when old price is 0", () => {
    expect(computeApyFromPrice(1.01, 0, 30)).toBe(0);
  });
});

describe("computePYS", () => {
  it("scores safe high-yield coin well", () => {
    const pys = computePYS({ apy30d: 8, safetyScore: 82, apyVarianceScore: 0.05, scalingFactor: 5 });
    // yieldEfficiency = 8 / max(0.5, (101-82)/20) = 8/0.95 = 8.42
    // sustainability = max(0.3, 1-0.05) = 0.95
    // PYS = min(100, 8.42 * 0.95 * 5) = 40
    expect(pys).toBeCloseTo(40, 0);
  });

  it("penalizes low safety score", () => {
    const safe = computePYS({ apy30d: 10, safetyScore: 90, apyVarianceScore: 0, scalingFactor: 5 });
    const risky = computePYS({ apy30d: 10, safetyScore: 40, apyVarianceScore: 0, scalingFactor: 5 });
    expect(safe).toBeGreaterThan(risky);
  });

  it("penalizes high variance", () => {
    const stable = computePYS({ apy30d: 10, safetyScore: 70, apyVarianceScore: 0.1, scalingFactor: 5 });
    const volatile = computePYS({ apy30d: 10, safetyScore: 70, apyVarianceScore: 0.8, scalingFactor: 5 });
    expect(stable).toBeGreaterThan(volatile);
  });

  it("caps at 100", () => {
    const pys = computePYS({ apy30d: 100, safetyScore: 95, apyVarianceScore: 0, scalingFactor: 10 });
    expect(pys).toBe(100);
  });

  it("returns 0 for 0% APY", () => {
    expect(computePYS({ apy30d: 0, safetyScore: 90, apyVarianceScore: 0, scalingFactor: 5 })).toBe(0);
  });
});

describe("computeYieldStability", () => {
  it("returns 1 for perfectly stable yields", () => {
    expect(computeYieldStability([5, 5, 5, 5, 5])).toBe(1);
  });

  it("returns lower values for volatile yields", () => {
    const stability = computeYieldStability([5, 15, 5, 15, 5]);
    expect(stability).toBeLessThan(0.5);
  });

  it("returns null for empty array", () => {
    expect(computeYieldStability([])).toBeNull();
  });

  it("returns null for single value", () => {
    expect(computeYieldStability([5])).toBeNull();
  });
});

describe("detectWarningSignals", () => {
  it("detects yield spike", () => {
    const signals = detectWarningSignals({ currentApy: 25, apy30d: 10, apyReward: null, apy: 25, medianApy: 8, sourceTvlUsd: null, prevTvlUsd: null });
    expect(signals).toContain("yield-spike");
  });

  it("detects reward-heavy yield", () => {
    const signals = detectWarningSignals({ currentApy: 20, apy30d: 18, apyReward: 17, apy: 20, medianApy: 8, sourceTvlUsd: null, prevTvlUsd: null });
    expect(signals).toContain("reward-heavy");
  });

  it("returns empty for healthy yield", () => {
    const signals = detectWarningSignals({ currentApy: 5, apy30d: 5, apyReward: null, apy: 5, medianApy: 6, sourceTvlUsd: 1e9, prevTvlUsd: 1e9 });
    expect(signals).toHaveLength(0);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/__tests__/yield-helpers.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement the helpers**

```typescript
// worker/src/cron/yield-helpers.ts
// Pure computation functions for yield intelligence. No I/O.

/**
 * Compute annualized APY from two exchange rate snapshots.
 * @param rateNow  Current exchange rate (e.g., convertToAssets(1e18))
 * @param ratePrev Previous exchange rate
 * @param days     Number of days between snapshots
 * @returns APY as a percentage (e.g., 7.5 for 7.5%)
 */
export function computeApyFromRate(rateNow: number, ratePrev: number, days: number): number {
  if (ratePrev <= 0 || days <= 0) return 0;
  const ratio = rateNow / ratePrev;
  if (ratio === 1) return 0;
  return (Math.pow(ratio, 365.25 / days) - 1) * 100;
}

/**
 * Compute annualized APY from price change (for navTokens).
 * @param priceNow  Current price
 * @param pricePrev Price `days` ago
 * @param days      Number of days between snapshots
 */
export function computeApyFromPrice(priceNow: number, pricePrev: number, days: number): number {
  return computeApyFromRate(priceNow, pricePrev, days);
}

interface PYSInput {
  apy30d: number;
  safetyScore: number;
  apyVarianceScore: number;
  scalingFactor: number;
}

/**
 * Compute the Pharos Yield Score (0-100).
 * PYS = min(100, yieldEfficiency * sustainabilityMultiplier * scalingFactor)
 */
export function computePYS({ apy30d, safetyScore, apyVarianceScore, scalingFactor }: PYSInput): number {
  if (apy30d <= 0) return 0;
  const riskPenalty = Math.max(0.5, (101 - safetyScore) / 20);
  const yieldEfficiency = apy30d / riskPenalty;
  const sustainabilityMultiplier = Math.max(0.3, 1.0 - apyVarianceScore);
  return Math.min(100, Math.round(yieldEfficiency * sustainabilityMultiplier * scalingFactor));
}

/**
 * Compute yield stability (0-1) from APY samples.
 * Returns 1 - coefficient_of_variation, clamped to [0, 1].
 * Returns null if fewer than 2 samples.
 */
export function computeYieldStability(apySamples: number[]): number | null {
  if (apySamples.length < 2) return null;
  const mean = apySamples.reduce((s, v) => s + v, 0) / apySamples.length;
  if (mean === 0) return 1;
  const variance = apySamples.reduce((s, v) => s + (v - mean) ** 2, 0) / apySamples.length;
  const cv = Math.sqrt(variance) / Math.abs(mean);
  return Math.max(0, Math.min(1, Math.round((1 - cv) * 100) / 100));
}

/**
 * Compute the APY variance score (0-1) used in PYS formula.
 * This is the coefficient of variation, clamped to [0, 1].
 */
export function computeApyVarianceScore(apySamples: number[]): number {
  if (apySamples.length < 2) return 0;
  const mean = apySamples.reduce((s, v) => s + v, 0) / apySamples.length;
  if (mean === 0) return 0;
  const variance = apySamples.reduce((s, v) => s + (v - mean) ** 2, 0) / apySamples.length;
  return Math.min(1, Math.sqrt(variance) / Math.abs(mean));
}

interface WarningInput {
  currentApy: number;
  apy30d: number;
  apyReward: number | null;
  apy: number;
  medianApy: number;
  sourceTvlUsd: number | null;
  prevTvlUsd: number | null;
}

/**
 * Detect yield sustainability warning signals.
 * Returns array of signal names (empty = healthy).
 */
export function detectWarningSignals(input: WarningInput): string[] {
  const signals: string[] = [];
  if (input.apy30d > 0 && input.currentApy / input.apy30d > 2.0) signals.push("yield-spike");
  if (input.medianApy > 0 && input.currentApy > input.medianApy * 3) signals.push("yield-divergence");
  if (input.apy30d > 0 && input.currentApy < input.apy30d * 0.7) signals.push("negative-trend");
  if (input.apyReward != null && input.apy > 0 && input.apyReward / input.apy > 0.8) signals.push("reward-heavy");
  if (input.sourceTvlUsd != null && input.prevTvlUsd != null && input.prevTvlUsd > 0) {
    const change = (input.sourceTvlUsd - input.prevTvlUsd) / input.prevTvlUsd;
    if (change < -0.2) signals.push("tvl-outflow");
  }
  return signals;
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/__tests__/yield-helpers.test.ts`
Expected: All PASS.

**Step 5: Commit**

```bash
git add worker/src/cron/yield-helpers.ts src/lib/__tests__/yield-helpers.test.ts
git commit -m "feat(yield): add pure computation helpers with tests"
```

---

## Task 7: Treasury T-bill Rate Fetcher

**Files:**
- Create: `worker/src/cron/fetch-tbill-rate.ts`

**Step 1: Implement the fetcher**

```typescript
// worker/src/cron/fetch-tbill-rate.ts
import { fetchWithRetry } from "../lib/fetch-retry";
import { setCache } from "../lib/db";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import {
  TREASURY_FISCAL_DATA_URL,
  RISK_FREE_RATE_FALLBACK,
  CIRCUIT_SOURCE,
  USER_AGENT,
} from "../lib/constants";
import type { CronResult } from "../lib/db";

interface TreasuryResponse {
  data: { record_date: string; avg_interest_rate_amt: string }[];
}

/**
 * Fetch the latest US T-bill average interest rate from the Treasury Fiscal Data API.
 * Stores it in the cache table as "risk_free_rate" for the yield sync cron to read.
 * Runs daily on the 0 8 * * * trigger.
 */
export async function fetchTbillRate(db: D1Database): Promise<CronResult> {
  if (!await shouldAttemptFetch(db, CIRCUIT_SOURCE.TREASURY_RATES)) {
    console.log("[fetch-tbill-rate] Circuit open, using fallback");
    await setCache(db, "risk_free_rate", String(RISK_FREE_RATE_FALLBACK));
    return { metadata: "skipped: circuit open, wrote fallback" };
  }

  try {
    const res = await fetchWithRetry(TREASURY_FISCAL_DATA_URL, {
      headers: { "User-Agent": USER_AGENT },
    });

    if (!res?.ok) {
      await recordOutcome(db, CIRCUIT_SOURCE.TREASURY_RATES, false);
      console.warn(`[fetch-tbill-rate] API returned ${res?.status}, using fallback`);
      await setCache(db, "risk_free_rate", String(RISK_FREE_RATE_FALLBACK));
      return { metadata: `API error ${res?.status}, wrote fallback` };
    }

    const body = (await res.json()) as TreasuryResponse;
    const rate = parseFloat(body.data?.[0]?.avg_interest_rate_amt);

    if (isNaN(rate) || rate < 0 || rate > 20) {
      await recordOutcome(db, CIRCUIT_SOURCE.TREASURY_RATES, false);
      console.warn(`[fetch-tbill-rate] Invalid rate ${rate}, using fallback`);
      await setCache(db, "risk_free_rate", String(RISK_FREE_RATE_FALLBACK));
      return { metadata: `invalid rate ${rate}, wrote fallback` };
    }

    await setCache(db, "risk_free_rate", String(rate));
    await recordOutcome(db, CIRCUIT_SOURCE.TREASURY_RATES, true);

    const recordDate = body.data[0].record_date;
    console.log(`[fetch-tbill-rate] T-bill rate: ${rate}% (as of ${recordDate})`);
    return { itemCount: 1, metadata: `${rate}% (${recordDate})` };
  } catch (err) {
    await recordOutcome(db, CIRCUIT_SOURCE.TREASURY_RATES, false);
    console.error("[fetch-tbill-rate] Error:", err);
    await setCache(db, "risk_free_rate", String(RISK_FREE_RATE_FALLBACK));
    return { metadata: "error, wrote fallback" };
  }
}
```

**Step 2: Commit**

```bash
git add worker/src/cron/fetch-tbill-rate.ts
git commit -m "feat(yield): add Treasury T-bill rate fetcher"
```

---

## Task 8: Main Yield Sync Cron

**Files:**
- Create: `worker/src/cron/sync-yield-data.ts`

This is the largest piece. It implements the three-tier APY resolution, computes safety scores, PYS, and writes to D1.

**Step 1: Implement sync-yield-data.ts**

```typescript
// worker/src/cron/sync-yield-data.ts
import { TRACKED_STABLECOINS } from "../../../src/lib/stablecoins";
import { fetchWithRetry } from "../lib/fetch-retry";
import { getCache, setCache, batchExecute } from "../lib/db";
import {
  USER_AGENT, CIRCUIT_SOURCE, RISK_FREE_RATE_FALLBACK,
  PYS_SCALING_FACTOR,
} from "../lib/constants";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { getChainRpc } from "../lib/chain-rpcs";
import {
  computeApyFromRate, computeApyFromPrice, computePYS,
  computeYieldStability, computeApyVarianceScore, detectWarningSignals,
} from "./yield-helpers";
import {
  YIELD_VARIANT_MAP, YIELD_POOL_MAP, ON_CHAIN_RATE_CONFIGS,
} from "./yield-config";
import {
  computeOverallGrade, scoreDecentralization, scoreDependencyRisk,
  scoreLiquidity, scorePegStability, scoreResilience, scoreToGrade,
} from "../../../src/lib/report-cards";
import { computePegScore } from "../../../src/lib/peg-score";
import type { StablecoinData, PegSummaryCoin } from "../../../src/lib/types";
import type { CronResult } from "../lib/db";

const DL_YIELDS_URL = "https://yields.llama.fi/pools";

interface DlPool {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number;
  apyBase: number | null;
  apyReward: number | null;
  apyMean30d: number;
  stablecoin: boolean;
  exposure: string;
  underlyingTokens: string[] | null;
}

interface ResolvedYield {
  currentApy: number;
  apyBase: number | null;
  apyReward: number | null;
  sourcePool: string | null;
  sourceTvlUsd: number | null;
  dataSource: "onchain" | "defillama" | "price-derived";
  exchangeRate: number | null;
}

// ── Tier 1: On-chain exchange rates ──────────────────────────────────

async function fetchOnChainRates(): Promise<Map<string, { rate: number }>> {
  const results = new Map<string, { rate: number }>();

  for (const config of ON_CHAIN_RATE_CONFIGS) {
    try {
      const rpc = getChainRpc(config.chain);
      if (!rpc) {
        console.warn(`[yield] No RPC for chain ${config.chain}`);
        continue;
      }

      const callData = config.selector + config.inputAmount.replace("0x", "").padStart(64, "0");
      const res = await fetchWithRetry(rpc.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_call",
          params: [{ to: config.contract, data: callData }, "latest"],
          id: 1,
        }),
      });

      if (!res?.ok) continue;
      const body = await res.json() as { result?: string };
      if (!body.result || body.result === "0x") continue;

      const raw = BigInt(body.result);
      const rate = Number(raw) / 10 ** config.decimals;
      results.set(config.stablecoinId, { rate });
    } catch (err) {
      console.warn(`[yield] On-chain rate failed for ${config.stablecoinId}:`, err);
    }
  }

  return results;
}

// ── Tier 2: DeFiLlama pool matching ──────────────────────────────────

function matchDlPool(
  stablecoinId: string,
  symbol: string,
  dlPools: DlPool[],
): DlPool | null {
  // Layer 1: Static map
  const poolId = YIELD_POOL_MAP[stablecoinId];
  if (poolId) {
    const pool = dlPools.find((p) => p.pool === poolId);
    if (pool) return pool;
  }

  // Layer 2: Fallback matching
  const variant = YIELD_VARIANT_MAP[stablecoinId];
  const searchSymbols = [symbol.toLowerCase()];
  if (variant) searchSymbols.push(variant.variantSymbol.toLowerCase());

  const candidates = dlPools.filter((p) =>
    p.exposure === "single" &&
    p.stablecoin &&
    searchSymbols.some((s) => p.symbol.toLowerCase().includes(s))
  );

  if (candidates.length === 0) return null;
  // Pick highest TVL
  return candidates.reduce((best, p) => (p.tvlUsd > best.tvlUsd ? p : best));
}

// ── Tier 3: Price-derived APY ────────────────────────────────────────

async function getPriceDerivedApy(
  db: D1Database,
  stablecoinId: string,
): Promise<number | null> {
  const now = Math.floor(Date.now() / 1000);
  const thirtyDaysAgo = now - 30 * 86400;

  // Get most recent and ~30d-ago prices from supply_history
  const [recentRow, oldRow] = await Promise.all([
    db.prepare(
      "SELECT price FROM supply_history WHERE stablecoin_id = ? AND price IS NOT NULL ORDER BY snapshot_date DESC LIMIT 1"
    ).bind(stablecoinId).first<{ price: number }>(),
    db.prepare(
      "SELECT price FROM supply_history WHERE stablecoin_id = ? AND price IS NOT NULL AND snapshot_date <= ? ORDER BY snapshot_date DESC LIMIT 1"
    ).bind(stablecoinId, thirtyDaysAgo).first<{ price: number }>(),
  ]);

  if (!recentRow?.price || !oldRow?.price || oldRow.price <= 0) return null;
  return computeApyFromPrice(recentRow.price, oldRow.price, 30);
}

// ── Main sync function ───────────────────────────────────────────────

export async function syncYieldData(db: D1Database): Promise<CronResult> {
  const startSec = Math.floor(Date.now() / 1000);
  const yieldCoins = TRACKED_STABLECOINS.filter((m) => m.flags.yieldBearing);

  if (yieldCoins.length === 0) {
    return { itemCount: 0, metadata: "no yield-bearing coins" };
  }

  // 1. Fetch DL pools (Tier 2 source)
  let dlPools: DlPool[] = [];
  if (await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_YIELDS)) {
    try {
      const res = await fetchWithRetry(DL_YIELDS_URL, {
        headers: { "User-Agent": USER_AGENT },
      });
      if (res?.ok) {
        const body = await res.json() as { data: DlPool[] };
        dlPools = body.data ?? [];
        await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, true);
      } else {
        await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, false);
      }
    } catch {
      await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, false);
    }
  }

  // 2. Fetch on-chain rates (Tier 1 source)
  const onChainRates = await fetchOnChainRates();

  // 3. Read cached risk-free rate
  const rfCache = await getCache(db, "risk_free_rate");
  const riskFreeRate = rfCache ? parseFloat(rfCache.value) : RISK_FREE_RATE_FALLBACK;

  // 4. Compute safety scores inline (report-cards API does NOT cache results)
  // Follows the same two-phase approach as daily-digest.ts (non-dependent first, then dependent)
  const safetyScores = await computeSafetyScores(db);

  // 5. Resolve yield for each coin
  const resolved: { id: string; symbol: string; yield: ResolvedYield | null }[] = [];

  for (const meta of yieldCoins) {
    const id = meta.id;
    const symbol = meta.symbol;

    // Tier 1: On-chain rate
    const rateConfig = ON_CHAIN_RATE_CONFIGS.find((c) => c.stablecoinId === id);
    if (rateConfig && onChainRates.has(id)) {
      const { rate } = onChainRates.get(id)!;
      // Need previous rate from yield_history
      const prevRow = await db.prepare(
        "SELECT exchange_rate FROM yield_history WHERE stablecoin_id = ? AND recorded_at <= ? ORDER BY recorded_at DESC LIMIT 1"
      ).bind(id, startSec - 7 * 86400).first<{ exchange_rate: number | null }>();

      if (prevRow?.exchange_rate && prevRow.exchange_rate > 0) {
        const apy = computeApyFromRate(rate, prevRow.exchange_rate, 7);
        resolved.push({
          id, symbol,
          yield: { currentApy: apy, apyBase: apy, apyReward: null, sourcePool: null, sourceTvlUsd: null, dataSource: "onchain", exchangeRate: rate },
        });
        continue;
      }
      // Fall through if no previous rate yet (first run)
    }

    // Tier 2: DeFiLlama pool match
    const pool = matchDlPool(id, symbol, dlPools);
    if (pool && pool.apy != null && pool.apy >= 0) {
      resolved.push({
        id, symbol,
        yield: {
          currentApy: pool.apy,
          apyBase: pool.apyBase,
          apyReward: pool.apyReward,
          sourcePool: pool.pool,
          sourceTvlUsd: pool.tvlUsd,
          dataSource: "defillama",
          exchangeRate: null,
        },
      });
      continue;
    }

    // Tier 3: Price-derived (navTokens only)
    if (meta.flags.navToken) {
      const apy = await getPriceDerivedApy(db, id);
      if (apy != null) {
        resolved.push({
          id, symbol,
          yield: {
            currentApy: apy,
            apyBase: apy,
            apyReward: null,
            sourcePool: null,
            sourceTvlUsd: null,
            dataSource: "price-derived",
            exchangeRate: null,
          },
        });
        continue;
      }
    }

    // No data available
    resolved.push({ id, symbol, yield: null });
  }

  // 6. Compute trailing averages, PYS, and store
  const yieldDataStmts: D1PreparedStatement[] = [];
  const historyStmts: D1PreparedStatement[] = [];
  let updatedCount = 0;

  // Compute median APY for warning signal detection
  const allApys = resolved.filter((r) => r.yield).map((r) => r.yield!.currentApy);
  const medianApy = allApys.length > 0 ? sortedMedian(allApys) : 0;

  for (const { id, symbol, yield: y } of resolved) {
    if (!y) continue;

    const meta = yieldCoins.find((m) => m.id === id)!;
    const yieldConfig = meta.yieldConfig;

    // Load historical APY samples for trailing averages
    const histRows = await db.prepare(
      "SELECT apy, recorded_at, source_tvl_usd FROM yield_history WHERE stablecoin_id = ? AND recorded_at >= ? ORDER BY recorded_at ASC"
    ).bind(id, startSec - 30 * 86400).all<{ apy: number; recorded_at: number; source_tvl_usd: number | null }>();

    const samples = (histRows.results ?? []).map((r) => r.apy);
    samples.push(y.currentApy);

    const apy7dSamples = samples.slice(-Math.ceil(samples.length * 7 / 30));
    const apy7d = apy7dSamples.length > 0 ? apy7dSamples.reduce((s, v) => s + v, 0) / apy7dSamples.length : y.currentApy;
    const apy30d = samples.reduce((s, v) => s + v, 0) / samples.length;

    const apyVarianceScore = computeApyVarianceScore(samples);
    const yieldStability = computeYieldStability(samples);
    const variance30d = samples.length >= 2
      ? Math.sqrt(samples.reduce((s, v) => s + (v - apy30d) ** 2, 0) / samples.length)
      : null;
    const apyMin30d = samples.length > 0 ? Math.min(...samples) : null;
    const apyMax30d = samples.length > 0 ? Math.max(...samples) : null;

    // Safety score
    const safetyScore = safetyScores.get(id) ?? 40; // default 40 for unrated
    const safetyGrade = safetyScores.has(id) ? (safetyScores.get(id + "_grade") ?? "NR") : "NR";

    // PYS
    const pys = computePYS({ apy30d, safetyScore, apyVarianceScore, scalingFactor: PYS_SCALING_FACTOR });
    const yieldToRisk = (101 - safetyScore) > 0 ? apy30d / (101 - safetyScore) : null;
    const excessYield = apy30d - riskFreeRate;

    // Previous exchange rate (for Tier 1 coins)
    const prevRateRow = await db.prepare(
      "SELECT exchange_rate FROM yield_history WHERE stablecoin_id = ? AND recorded_at <= ? AND exchange_rate IS NOT NULL ORDER BY recorded_at DESC LIMIT 1"
    ).bind(id, startSec - 7 * 86400).first<{ exchange_rate: number | null }>();

    // Upsert yield_data
    yieldDataStmts.push(
      db.prepare(
        `INSERT OR REPLACE INTO yield_data (
          stablecoin_id, symbol, current_apy, apy_base, apy_reward, apy_7d, apy_30d,
          yield_source, yield_type, source_pool, source_tvl_usd, data_source,
          safety_score, safety_grade, pharos_yield_score, yield_to_risk, excess_yield, yield_stability,
          apy_variance_30d, apy_min_30d, apy_max_30d, exchange_rate, exchange_rate_prev, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id, symbol, y.currentApy, y.apyBase, y.apyReward, apy7d, apy30d,
        yieldConfig?.yieldSource ?? "Unknown", yieldConfig?.yieldType ?? "nav-appreciation",
        y.sourcePool, y.sourceTvlUsd, y.dataSource,
        safetyScore, safetyGrade, pys, yieldToRisk, excessYield, yieldStability,
        variance30d, apyMin30d, apyMax30d, y.exchangeRate, prevRateRow?.exchange_rate ?? null, startSec,
      )
    );

    // Insert yield_history point
    historyStmts.push(
      db.prepare(
        `INSERT OR IGNORE INTO yield_history (stablecoin_id, recorded_at, apy, apy_base, apy_reward, exchange_rate, source_tvl_usd, data_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, startSec, y.currentApy, y.apyBase, y.apyReward, y.exchangeRate, y.sourceTvlUsd, y.dataSource)
    );

    updatedCount++;
  }

  // 7. Batch write
  if (yieldDataStmts.length > 0) await batchExecute(db, yieldDataStmts);
  if (historyStmts.length > 0) await batchExecute(db, historyStmts);

  // 8. Prune old history (>365 days)
  const pruneCutoff = startSec - 365 * 86400;
  await db.prepare("DELETE FROM yield_history WHERE recorded_at < ?").bind(pruneCutoff).run();

  // 9. Cache the rankings response for fast API reads
  const rankingsData = await db.prepare("SELECT * FROM yield_data ORDER BY pharos_yield_score DESC").all();
  await setCache(db, "yield-rankings", JSON.stringify({
    rankings: (rankingsData.results ?? []).map(rowToRanking),
    riskFreeRate,
    scalingFactor: PYS_SCALING_FACTOR,
    updatedAt: startSec,
  }));

  console.log(`[sync-yield-data] Updated ${updatedCount}/${yieldCoins.length} coins`);
  return { itemCount: updatedCount, metadata: `${updatedCount} coins, rf=${riskFreeRate}%` };
}

// ── Helpers ──────────────────────────────────────────────────────────

function sortedMedian(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Compute safety scores inline — report-cards API handler does NOT cache results,
 * so we must compute them ourselves (same approach as daily-digest.ts lines 426-558).
 */
async function computeSafetyScores(db: D1Database): Promise<Map<string, number | string>> {
  const scores = new Map<string, number | string>();

  try {
    // Load stablecoins cache (for price data / peg types)
    const stablecoinsCache = await getCache(db, "stablecoins");
    let peggedAssets: StablecoinData[] = [];
    if (stablecoinsCache) {
      const parsed = JSON.parse(stablecoinsCache.value) as { peggedAssets: StablecoinData[] };
      peggedAssets = parsed.peggedAssets;
    }
    const priceById = new Map(peggedAssets.map((a) => [a.id, a]));

    // Load depeg events (4-year window) + dex liquidity
    const nowSec = Math.floor(Date.now() / 1000);
    const fourYearsAgoSec = nowSec - Math.ceil(4 * 365.25 * 86400);
    const [eventsResult, dexLiqResult] = await Promise.all([
      db.prepare("SELECT * FROM depeg_events WHERE started_at > ? ORDER BY started_at DESC")
        .bind(fourYearsAgoSec)
        .all(),
      db.prepare("SELECT stablecoin_id, liquidity_score, concentration_hhi, pool_count, chain_count FROM dex_liquidity")
        .all<{ stablecoin_id: string; liquidity_score: number | null; concentration_hhi: number | null; pool_count: number; chain_count: number }>(),
    ]);

    // Build depeg event lookup (reuse rowToDepegEvent from daily-digest pattern)
    const allEvents = (eventsResult.results ?? []) as { stablecoin_id: string; started_at: number; [k: string]: unknown }[];
    const eventsByCoin = new Map<string, typeof allEvents>();
    for (const e of allEvents) {
      const list = eventsByCoin.get(e.stablecoin_id) ?? [];
      list.push(e);
      eventsByCoin.set(e.stablecoin_id, list);
    }

    // Build dex liquidity lookup
    const dexLiqMap: Record<string, { liquidityScore: number | null; concentrationHhi: number | null; poolCount: number; chainCount: number }> = {};
    for (const row of dexLiqResult.results ?? []) {
      dexLiqMap[row.stablecoin_id] = {
        liquidityScore: row.liquidity_score,
        concentrationHhi: row.concentration_hhi,
        poolCount: row.pool_count,
        chainCount: row.chain_count,
      };
    }

    const overallScores = new Map<string, number>();

    // Phase 1: non-dependent coins
    for (const meta of TRACKED_STABLECOINS) {
      if (meta.flags.navToken) continue;
      if (meta.flags.governance === "centralized-dependent") continue;

      const asset = priceById.get(meta.id);
      const events = eventsByCoin.get(meta.id) ?? [];
      const trackingStart = events.length > 0
        ? Math.min(Math.min(...events.map((e) => e.started_at)), fourYearsAgoSec)
        : fourYearsAgoSec;
      const scoreResult = computePegScore(events as any[], trackingStart, nowSec);

      const pegData: PegSummaryCoin = {
        id: meta.id, symbol: meta.symbol, name: meta.name,
        pegType: asset?.pegType ?? "", pegCurrency: meta.flags.pegCurrency,
        governance: meta.flags.governance,
        currentDeviationBps: null, pegScore: scoreResult.pegScore,
        pegPct: scoreResult.pegPct, severityScore: scoreResult.severityScore,
        spreadPenalty: scoreResult.spreadPenalty, eventCount: scoreResult.eventCount,
        worstDeviationBps: scoreResult.worstDeviationBps,
        activeDepeg: scoreResult.activeDepeg, lastEventAt: scoreResult.lastEventAt,
        trackingSpanDays: scoreResult.trackingSpanDays,
      };

      const canBl = meta.canBeBlacklisted !== undefined ? meta.canBeBlacklisted : (meta.flags.governance as string) === "centralized";
      const dims = {
        pegStability: scorePegStability(pegData, meta),
        liquidity: scoreLiquidity(dexLiqMap[meta.id]),
        resilience: scoreResilience(meta, canBl),
        decentralization: scoreDecentralization(meta.flags.governance, meta),
        dependencyRisk: scoreDependencyRisk(meta, overallScores),
      };
      const overall = computeOverallGrade(dims, { navToken: !!meta.flags.navToken });
      if (overall.score !== null) {
        overallScores.set(meta.id, overall.score);
        scores.set(meta.id, overall.score);
        scores.set(meta.id + "_grade", overall.grade);
      }
    }

    // Phase 2: dependent coins (need parent scores computed first)
    for (const meta of TRACKED_STABLECOINS) {
      if (meta.flags.navToken) continue;
      if (meta.flags.governance !== "centralized-dependent") continue;

      const asset = priceById.get(meta.id);
      const events = eventsByCoin.get(meta.id) ?? [];
      const trackingStart = events.length > 0
        ? Math.min(Math.min(...events.map((e) => e.started_at)), fourYearsAgoSec)
        : fourYearsAgoSec;
      const scoreResult = computePegScore(events as any[], trackingStart, nowSec);

      const pegData: PegSummaryCoin = {
        id: meta.id, symbol: meta.symbol, name: meta.name,
        pegType: asset?.pegType ?? "", pegCurrency: meta.flags.pegCurrency,
        governance: meta.flags.governance,
        currentDeviationBps: null, pegScore: scoreResult.pegScore,
        pegPct: scoreResult.pegPct, severityScore: scoreResult.severityScore,
        spreadPenalty: scoreResult.spreadPenalty, eventCount: scoreResult.eventCount,
        worstDeviationBps: scoreResult.worstDeviationBps,
        activeDepeg: scoreResult.activeDepeg, lastEventAt: scoreResult.lastEventAt,
        trackingSpanDays: scoreResult.trackingSpanDays,
      };

      const canBl = meta.canBeBlacklisted !== undefined ? meta.canBeBlacklisted : (meta.flags.governance as string) === "centralized";
      const dims = {
        pegStability: scorePegStability(pegData, meta),
        liquidity: scoreLiquidity(dexLiqMap[meta.id]),
        resilience: scoreResilience(meta, canBl),
        decentralization: scoreDecentralization(meta.flags.governance, meta),
        dependencyRisk: scoreDependencyRisk(meta, overallScores),
      };
      const overall = computeOverallGrade(dims, { navToken: false });
      if (overall.score !== null) {
        overallScores.set(meta.id, overall.score);
        scores.set(meta.id, overall.score);
        scores.set(meta.id + "_grade", overall.grade);
      }
    }
  } catch (err) {
    console.warn("[yield] Safety score computation failed, using fallbacks:", err);
  }

  return scores;
}

function rowToRanking(row: Record<string, unknown>) {
  return {
    id: row.stablecoin_id,
    symbol: row.symbol,
    name: TRACKED_STABLECOINS.find((m) => m.id === row.stablecoin_id)?.name ?? String(row.symbol),
    currentApy: row.current_apy,
    apy7d: row.apy_7d,
    apy30d: row.apy_30d,
    apyBase: row.apy_base,
    apyReward: row.apy_reward,
    yieldSource: row.yield_source,
    yieldType: row.yield_type,
    dataSource: row.data_source,
    sourceTvlUsd: row.source_tvl_usd,
    pharosYieldScore: row.pharos_yield_score,
    safetyScore: row.safety_score,
    safetyGrade: row.safety_grade,
    yieldToRisk: row.yield_to_risk,
    excessYield: row.excess_yield,
    yieldStability: row.yield_stability,
    apyVariance30d: row.apy_variance_30d,
    apyMin30d: row.apy_min_30d,
    apyMax30d: row.apy_max_30d,
  };
}
```

**Important note for the implementer:** The `computeSafetyScores` function computes report-card grades inline because the report-cards API handler does NOT write to the D1 cache table — it computes live per-request. This approach mirrors `worker/src/cron/daily-digest.ts` lines 426-558. The depeg event row shape from the raw D1 query may need a `rowToDepegEvent` mapping — check the daily-digest for the exact transformation and adapt `computePegScore` input accordingly.

**Step 2: Worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS (fix any type errors).

**Step 3: Commit**

```bash
git add worker/src/cron/sync-yield-data.ts
git commit -m "feat(yield): implement sync-yield-data cron with three-tier APY resolution"
```

---

## Task 9: Wire Crons into index.ts

**Files:**
- Modify: `worker/src/index.ts`

**Step 1: Add imports and wire both triggers**

Add imports at the top of `worker/src/index.ts`:

```typescript
import { syncYieldData } from "./cron/sync-yield-data";
import { fetchTbillRate } from "./cron/fetch-tbill-rate";
```

In the `"10,40 * * * *"` case, add the yield sync alongside dex-liquidity:

```typescript
case "10,40 * * * *": {
  ctx.waitUntil(logCronRun(db, "sync-dex-liquidity", () => syncDexLiquidity(db, env.GRAPH_API_KEY ?? null, env.COINGECKO_API_KEY ?? null)));
  ctx.waitUntil(logCronRun(db, "sync-yield-data", () => syncYieldData(db)));
  break;
}
```

In the `"0 8 * * *"` case, add the T-bill rate fetch:

```typescript
case "0 8 * * *": {
  ctx.waitUntil(logCronRun(db, "snapshot-supply", () => snapshotSupply(db)));
  ctx.waitUntil(logCronRun(db, "fetch-tbill-rate", () => fetchTbillRate(db)));
  // ... rest unchanged
}
```

**Step 2: Worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS.

**Step 3: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat(yield): wire sync-yield-data and fetch-tbill-rate into cron triggers"
```

---

## Task 10: API Handlers

**Files:**
- Create: `worker/src/api/yield-rankings.ts`
- Create: `worker/src/api/yield-history.ts`

**Step 1: Implement yield-rankings handler**

```typescript
// worker/src/api/yield-rankings.ts
import { createCacheHandler } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

/**
 * GET /api/yield-rankings
 * Returns pre-computed yield rankings from cache (written by sync-yield-data cron).
 */
export const handleYieldRankings = createCacheHandler(
  "yield-rankings",
  "yield-rankings",
  CACHE_PROFILES.standard,
  3600, // 1 hour freshness threshold
);
```

**Step 2: Implement yield-history handler**

```typescript
// worker/src/api/yield-history.ts
import { withErrorHandler, isValidStablecoinId } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

interface YieldHistoryRow {
  recorded_at: number;
  apy: number;
  apy_base: number | null;
  apy_reward: number | null;
  exchange_rate: number | null;
  source_tvl_usd: number | null;
}

export const handleYieldHistory = withErrorHandler("yield-history", async (
  db: D1Database,
  url: URL,
): Promise<Response> => {
  const stablecoinId = url.searchParams.get("stablecoin");
  if (!stablecoinId) {
    return new Response(
      JSON.stringify({ error: "Missing ?stablecoin= parameter" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!isValidStablecoinId(stablecoinId)) {
    return new Response(
      JSON.stringify({ error: "Invalid stablecoin ID" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const parsedDays = parseInt(url.searchParams.get("days") ?? "90", 10);
  const days = Number.isNaN(parsedDays) ? 90 : Math.min(365, Math.max(1, parsedDays));
  const cutoff = Math.floor(Date.now() / 1000) - days * 86_400;

  const result = await db
    .prepare(
      `SELECT recorded_at, apy, apy_base, apy_reward, exchange_rate, source_tvl_usd
       FROM yield_history
       WHERE stablecoin_id = ? AND recorded_at >= ?
       ORDER BY recorded_at ASC`
    )
    .bind(stablecoinId, cutoff)
    .all<YieldHistoryRow>();

  const history = (result.results ?? []).map((row) => ({
    date: row.recorded_at,
    apy: row.apy,
    apyBase: row.apy_base,
    apyReward: row.apy_reward,
    exchangeRate: row.exchange_rate,
    sourceTvlUsd: row.source_tvl_usd,
  }));

  return new Response(JSON.stringify(history), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": CACHE_PROFILES.slow,
    },
  });
});
```

**Step 3: Commit**

```bash
git add worker/src/api/yield-rankings.ts worker/src/api/yield-history.ts
git commit -m "feat(api): add yield-rankings and yield-history handlers"
```

---

## Task 11: Router, Health, and Status Registration

**Files:**
- Modify: `worker/src/router.ts`
- Modify: `worker/src/api/health.ts`
- Modify: `worker/src/api/status.ts`

**Step 1: Register routes in router.ts**

Add imports:

```typescript
import { handleYieldRankings } from "./api/yield-rankings";
import { handleYieldHistory } from "./api/yield-history";
```

Add route matching (before the 404 fallback):

```typescript
if (path === "/api/yield-rankings") {
  return handleYieldRankings(db);
}
if (path === "/api/yield-history") {
  return handleYieldHistory(db, url);
}
```

**Step 2: Add to status.ts CRON_INTERVALS**

```typescript
const CRON_INTERVALS: Record<string, number> = {
  // ... existing entries ...
  "sync-yield-data": 1800,
  "fetch-tbill-rate": 86400,
};
```

**Step 3: Add yield-data freshness check to health.ts**

After the dex-liquidity freshness check block, add:

```typescript
// Check yield_data table freshness
try {
  const yieldAge = await db
    .prepare("SELECT MIN(? - updated_at) as age FROM yield_data")
    .bind(now)
    .first<{ age: number | null }>();
  const yieldMaxAge = 7200; // 2 hours
  const yieldAgeSeconds = yieldAge?.age ?? null;
  const yieldRatio = yieldAgeSeconds != null ? yieldAgeSeconds / yieldMaxAge : Infinity;
  if (yieldRatio > worstRatioMut) worstRatioMut = yieldRatio;
  caches["yield-data"] = { ageSeconds: yieldAgeSeconds, maxAge: yieldMaxAge, healthy: yieldRatio <= 1.5 };
} catch {
  // yield_data table may not exist yet
}
```

**Step 4: Worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS.

**Step 5: Commit**

```bash
git add worker/src/router.ts worker/src/api/health.ts worker/src/api/status.ts
git commit -m "feat(api): register yield routes in router, health, and status"
```

---

## Task 12: Pipeline Smoke Test

**Files:** None (verification only)

This task catches every upstream issue (migration not applied, cron logic bugs, empty pool map, broken safety score computation) **before** building frontend UI on top of the pipeline.

**Step 1: Start local worker**

```bash
cd worker && npx wrangler dev --local
```

Wait for the worker to start and bind to `localhost:8787`.

**Step 2: Apply migration locally**

In a separate terminal:

```bash
cd worker && npx wrangler d1 execute stablecoin-db --local --file=migrations/0031_yield_data.sql
```

**Step 3: Trigger the yield sync manually**

Since cron triggers don't fire in local dev, call the sync function directly. Create a temporary test script or use the admin trigger pattern. Alternatively, add a temporary `/api/trigger-yield-sync` admin endpoint (remove after testing), or call the cron handler via:

```bash
curl -s http://localhost:8787/api/health | jq .
```

Then verify the yield-rankings endpoint returns data:

```bash
curl -s http://localhost:8787/api/yield-rankings | jq '.rankings | length'
```

**Expected:** A number > 0 (ideally 10-15 coins). If 0, investigate: check worker logs for errors from sync-yield-data.

**Step 4: Validate data quality**

```bash
curl -s http://localhost:8787/api/yield-rankings | jq '[.rankings[] | {symbol, pys: .pharosYieldScore, safety: .safetyScore, apy: .apy30d, source: .dataSource}]'
```

Verify:
- `pharosYieldScore` is non-null for every coin (the safety score bug would show as all scores being ~identical)
- `safetyScore` varies across coins (not all 40 — that would mean `computeSafetyScores` failed silently)
- `dataSource` shows a mix of "defillama" and "price-derived" (at minimum — "onchain" may need historical data first)
- `apy30d` values are plausible (0.1%-30% range, not 0 or absurdly high)

**Step 5: Commit checkpoint**

No code changes needed if the pipeline is healthy. If you had to fix bugs, commit them:

```bash
git add -A
git commit -m "fix(yield): pipeline smoke test fixes"
```

---

## Task 13: Frontend Hooks

**Files:**
- Create: `src/hooks/use-yield-rankings.ts`
- Create: `src/hooks/use-yield-history.ts`

**Step 1: Create use-yield-rankings.ts**

```typescript
"use client";

import type { YieldRankingsResponse } from "@/lib/types";
import { useApiQuery, CRON_20MIN } from "./use-api-query";

export function useYieldRankings() {
  return useApiQuery<YieldRankingsResponse>(
    ["yield-rankings"],
    "/api/yield-rankings",
    CRON_20MIN,
  );
}
```

**Step 2: Create use-yield-history.ts**

```typescript
"use client";

import type { YieldHistoryPoint } from "@/lib/types";
import { useApiQuery, CRON_1H } from "./use-api-query";

export function useYieldHistory(stablecoinId: string, days = 90) {
  return useApiQuery<YieldHistoryPoint[]>(
    ["yield-history", stablecoinId, days],
    `/api/yield-history?stablecoin=${encodeURIComponent(stablecoinId)}&days=${days}`,
    CRON_1H,
  );
}
```

**Step 3: Commit**

```bash
git add src/hooks/use-yield-rankings.ts src/hooks/use-yield-history.ts
git commit -m "feat(hooks): add useYieldRankings and useYieldHistory hooks"
```

---

## Task 14: Yield Leaderboard Component

**Files:**
- Create: `src/components/yield-leaderboard.tsx`

**Step 1: Implement the sortable leaderboard table**

Build a sortable table component for yield-bearing stablecoins. Follow the patterns from `src/components/stablecoin-table.tsx` for sorting, and `src/components/liquidity-table.tsx` for the column layout.

Key columns: Rank, Coin (logo + name), APY (30d), Safety Grade, PYS, Yield Source, Yield Type (badge), TVL, Yield Stability (bar), 30d Range.

Use existing components:
- `StablecoinLogo` for coin logos
- `formatCurrency` from `@/lib/format` for TVL
- `REPORT_CARD_GRADE_COLORS` from `@/lib/report-cards` for grade badge colors

The component receives `rankings: YieldRanking[]` and `logos: Map` as props. It handles sorting state internally with `useState`.

Refer to `docs/plans/yield-intelligence-design.md` Section 6.1 for the full column spec.

**Step 2: Commit**

```bash
git add src/components/yield-leaderboard.tsx
git commit -m "feat(ui): add yield leaderboard table component"
```

---

## Task 15: Yield Scatter Plot Component

**Files:**
- Create: `src/components/yield-scatter-plot.tsx`

**Step 1: Implement the scatter plot**

Build a Recharts `<ScatterChart>` with:
- X-axis: Safety score (0-100), labeled with grade boundaries
- Y-axis: 30-day APY (%)
- Dot size: `log(marketCap)` (use data from `/api/stablecoins` or pass as prop)
- Dot color: by `yieldType`
- Quadrant shading: Use `<ReferenceArea>` with subtle background tints (refer to design doc Section 6.2)
- Reference line: Horizontal dashed line at `riskFreeRate`
- Hover tooltip: Coin name, APY, safety grade, PYS, yield source
- Click handler: Navigate to `/stablecoin/{id}`

Use existing chart patterns from `src/components/mcap-chart.tsx`:
- `ResponsiveContainer` wrapper
- `RECHARTS_TOOLTIP_STYLES` from `@/lib/chart-colors`
- Custom tick components for axis formatting

The component receives `rankings: YieldRanking[]`, `riskFreeRate: number`, and `onDotClick: (id: string) => void` as props.

**Step 2: Commit**

```bash
git add src/components/yield-scatter-plot.tsx
git commit -m "feat(ui): add yield vs safety scatter plot component"
```

---

## Task 16: /yield/ Page + Nav Config

**Files:**
- Create: `src/app/yield/page.tsx`
- Create: `src/app/yield/client.tsx`
- Modify: `src/lib/nav-config.ts`

**Step 1: Create SSG page wrapper**

```typescript
// src/app/yield/page.tsx
import dynamic from "next/dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { Skeleton } from "@/components/ui/skeleton";

const YieldClient = dynamic(
  () => import("./client").then((m) => ({ default: m.YieldClient })),
  { loading: () => <Skeleton className="h-[600px] w-full rounded-xl" /> },
);

const yieldBearingCount = TRACKED_STABLECOINS.filter((m) => m.flags.yieldBearing).length;
const desc = `Risk-adjusted yield rankings for ${yieldBearingCount} yield-bearing stablecoins. Compare APY, safety grades, and the Pharos Yield Score.`;

export const metadata: Metadata = {
  title: "Yield Intelligence | Pharos",
  description: desc,
  alternates: { canonical: "/yield/" },
  openGraph: {
    title: "Stablecoin Yield Intelligence",
    description: desc,
    url: "/yield/",
  },
};

export default function YieldPage() {
  return (
    <div className="space-y-6">
      <BreadcrumbJsonLd name="Yield Intelligence" path="/yield/" />
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">Yield Intelligence</span>
        </nav>
        <h1 className="text-4xl font-extrabold tracking-tighter">Yield Intelligence</h1>
        <p className="text-sm text-muted-foreground">
          Risk-adjusted yield rankings for {yieldBearingCount} yield-bearing stablecoins.
        </p>
      </div>
      <YieldClient />
    </div>
  );
}
```

**Step 2: Create client component**

Build `src/app/yield/client.tsx` following the pattern of `src/app/liquidity/client.tsx`:

1. Call `useYieldRankings()` hook
2. Render 3 summary stat cards (Average Yield, Risk-Free Rate, Best Risk-Adjusted)
3. Render `YieldScatterPlot` component
4. Render `YieldLeaderboard` component
5. Include disclaimer text at the bottom
6. Handle loading/error states with `Skeleton` and error banner
7. Use `useLogos()` for coin logos
8. Use `useRouter()` for scatter plot dot click → navigate to detail page

Refer to `docs/plans/yield-intelligence-design.md` Section 6 for the full UI spec.

**Step 3: Add to nav-config.ts**

Add the yield page to the navigation. Check `src/lib/nav-config.ts` for the correct group (likely "Data" or "Analysis") and add:

```typescript
{ href: "/yield", label: "Yield", icon: TrendingUp, description: "Risk-adjusted yield rankings" },
```

Import `TrendingUp` from `lucide-react`.

**Step 4: Commit**

```bash
git add src/app/yield/page.tsx src/app/yield/client.tsx src/lib/nav-config.ts
git commit -m "feat(ui): add /yield/ page with leaderboard and scatter plot"
```

---

## Task 17: Documentation Updates

**Files:**
- Modify: `docs/architecture.md` (add yield files to file tree)
- Modify: `docs/api-reference.md` (document new endpoints)

**Step 1: Update architecture.md**

Add the new yield files to the appropriate sections of the file tree.

**Step 2: Update api-reference.md**

Add documentation for:
- `GET /api/yield-rankings` — response shape, cache profile, data source
- `GET /api/yield-history?stablecoin=ID&days=90` — query params, response shape, cache profile

Follow the format of existing endpoint documentation in that file.

**Step 3: Commit**

```bash
git add docs/architecture.md docs/api-reference.md
git commit -m "docs: add yield intelligence endpoints and files to documentation"
```

---

## Task 18: Build Verification

**Step 1: Run all tests**

Run: `npm test`
Expected: All tests pass, including new yield-helpers tests.

**Step 2: Worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS.

**Step 3: Frontend lint**

Run: `npm run lint`
Expected: PASS.

**Step 4: Full build**

Run: `npm run build`
Expected: Static export succeeds with the new `/yield/` page included.

**Step 5: Final commit (if any lint/type fixes were needed)**

```bash
git add -A
git commit -m "fix: resolve lint and type-check issues from yield intelligence feature"
```

---

## Task Dependency Graph

```
Task 1 (migration)
  └── Task 2 (constants)
       └── Task 3 (types)
            └── Task 4 (yieldConfig on StablecoinMeta)
                 └── Task 5 (static mapping data + DL research — GATE: ≥10/15 UUIDs)
                      ├── Task 6 (pure computation helpers + tests)
                      ├── Task 7 (T-bill rate fetcher)
                      └── Task 8 (sync-yield-data cron — inline safety scores)
                           └── Task 9 (wire crons into index.ts)
                                └── Task 10 (API handlers)
                                     └── Task 11 (router + health + status)
                                          └── Task 12 (PIPELINE SMOKE TEST ← validates all backend)
Task 3 (types) ──────────────────────────────── Task 13 (frontend hooks)
Task 12 (smoke test passes) ─┬── Task 14 (leaderboard component)
                              └── Task 15 (scatter plot component)
                                        └── Task 16 (/yield/ page + nav)
                                             └── Task 17 (docs)
                                                  └── Task 18 (build verification)
```

Tasks 6, 7, and 8 can run in parallel after Task 5. Task 13 (frontend hooks) depends only on Task 3 (types) and can run in parallel with backend tasks. Tasks 14-15 depend on Task 12 (smoke test) — no frontend components should be built until the pipeline is validated.
