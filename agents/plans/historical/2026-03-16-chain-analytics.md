# Chain Analytics Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add chain-centric analytics to Pharos: a `/chains/` leaderboard with Chain Health Score, `/chains/[chain]/` profile pages, `GET /api/chains` endpoint, and `chain_supply_history` D1 table with daily snapshot cron stage.

**Architecture:** Server-side `GET /api/chains` endpoint computes chain aggregates on-the-fly from the stablecoins cache + report card cache (two D1 reads). Frontend uses two new hooks (`useChains`, `useChainStablecoins`) to power the leaderboard and profile pages. A daily cron stage snapshots per-chain supply totals for future trend charts.

**Tech Stack:** Next.js 16 (static export), React 19, TypeScript strict, Tailwind CSS v4, shadcn/ui, TanStack Query, Recharts (treemap), Cloudflare Workers + D1.

**Spec:** `agents/specs/2026-03-16-chain-analytics-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `shared/types/chains.ts` | `ChainSummary`, `ChainsResponse` TypeScript interfaces |
| `shared/lib/chain-health.ts` | Pure health score computation: HHI, Shannon entropy, peg stability, quality, composite + bands |
| `shared/lib/chain-aggregator.ts` | Aggregate `StablecoinData[]` into `ChainSummary[]` (chain dedup, delta computation, health score wiring) |
| `worker/migrations/0069_chain_supply_history.sql` | D1 migration: `chain_supply_history` table |
| `worker/src/api/chains.ts` | `handleChains(db)` API handler |
| `worker/src/cron/snapshot-chain-supply.ts` | Daily cron stage: snapshot per-chain supply totals |
| `src/hooks/use-chains.ts` | `useChains()` and `useChainStablecoins(chainId)` hooks |
| `src/app/chains/page.tsx` | `/chains/` server component (metadata, static params, shell) |
| `src/app/chains/client.tsx` | `/chains/` client component (leaderboard table, KPI strip) |
| `src/app/chains/[chain]/page.tsx` | `/chains/[chain]/` server component (metadata, static params, shell) |
| `src/app/chains/[chain]/client.tsx` | `/chains/[chain]/` client component (hero, health card, treemap, backing bar, stablecoin table) |

### New Test Files

| File | Tests |
|------|-------|
| `shared/lib/__tests__/chain-health.test.ts` | Health score sub-factors and composite: HHI, entropy, peg stability, quality, bands, edge cases |
| `shared/lib/__tests__/chain-aggregator.test.ts` | Aggregation logic: delta computation, alias dedup, zero-supply exclusion, sorting |
| `worker/src/api/__tests__/chains.test.ts` | API handler: cache miss (503), happy path (response shape + health scores), report card cache unavailable (null health) |
| `worker/src/cron/__tests__/snapshot-chain-supply.test.ts` | Cron stage: inserts rows, skips stale cache, respects abort signal |

### Modified Files

| File | Change |
|------|--------|
| `shared/lib/chains.ts` | Export `CHAIN_ALIASES` constant for alias deduplication |
| `shared/lib/api-endpoints.ts` | Add `chains` to `API_PATHS` and `ENDPOINT_DEFINITIONS` |
| `worker/src/route-registry.ts` | Register chains handler import + route entry |
| `worker/src/lib/constants.ts` | Add `chains: 600` to `CACHE_FRESHNESS_THRESHOLDS` |
| `worker/src/handlers/scheduled/quarter-hourly.ts` | Add `snapshot-chain-supply` stage after `snapshot-supply` |
| `src/lib/nav-config.ts` | Add "Chains" to Data group (first position), import `Layers` icon |
| `src/components/key-info-card.tsx` | Wrap chain logos/names with `Link` to `/chains/[chain]/` |

---

## Chunk 1: Shared Types, Health Score Logic, and Chain Aggregator

### Task 1: Chain Analytics TypeScript Types

**Files:**
- Create: `shared/types/chains.ts`
- Modify: `shared/types/index.ts` (re-export)

- [ ] **Step 1: Create the types file**

```typescript
// shared/types/chains.ts
export interface ChainHealthFactors {
  concentration: number;
  quality: number | null;
  pegStability: number;
  backingDiversity: number;
}

export type HealthBand = "robust" | "healthy" | "mixed" | "fragile" | "concentrated";

export interface ChainDominantStablecoin {
  id: string;
  symbol: string;
  share: number;
}

export interface ChainSummary {
  id: string;
  name: string;
  logoPath: string;
  type: "evm" | "tron" | "other";
  totalUsd: number;
  change24h: number;
  change24hPct: number;
  change7d: number;
  change7dPct: number;
  change30d: number;
  change30dPct: number;
  stablecoinCount: number;
  dominantStablecoin: ChainDominantStablecoin;
  dominanceShare: number;
  healthScore: number | null;
  healthBand: HealthBand | null;
  healthFactors: ChainHealthFactors;
}

export interface ChainsResponse {
  chains: ChainSummary[];
  globalTotalUsd: number;
  updatedAt: number;
  healthMethodologyVersion: string;
}
```

- [ ] **Step 2: Re-export from shared/types/index.ts**

Add `export type { ... } from "./chains";` with all exported types to `shared/types/index.ts`.

- [ ] **Step 3: Verify types compile**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS (no type errors)

- [ ] **Step 4: Commit**

```bash
git add shared/types/chains.ts shared/types/index.ts
git commit -m "feat(chains): add chain analytics TypeScript types"
```

### Task 2: Chain Health Score — Pure Computation

**Files:**
- Create: `shared/lib/chain-health.ts`
- Create: `shared/lib/__tests__/chain-health.test.ts`

- [ ] **Step 1: Write failing tests for health score sub-factors**

Create `shared/lib/__tests__/chain-health.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  computeConcentrationScore,
  computeBackingDiversityScore,
  computePegStabilityScore,
  computeQualityScore,
  computeHealthScore,
  getHealthBand,
  HEALTH_METHODOLOGY_VERSION,
} from "../chain-health";

describe("computeConcentrationScore", () => {
  it("returns 0 for a single-stablecoin chain", () => {
    expect(computeConcentrationScore([1.0])).toBe(0);
  });

  it("returns ~50 for an even two-coin split", () => {
    const score = computeConcentrationScore([0.5, 0.5]);
    expect(score).toBe(50);
  });

  it("returns high score for evenly distributed coins", () => {
    const shares = [0.25, 0.25, 0.25, 0.25];
    expect(computeConcentrationScore(shares)).toBe(75);
  });

  it("returns 0 for empty array", () => {
    expect(computeConcentrationScore([])).toBe(0);
  });
});

describe("computeBackingDiversityScore", () => {
  it("returns 0 for monoculture (all one type)", () => {
    const distribution = { "rwa-backed": 1, "crypto-backed": 0, algorithmic: 0 };
    expect(computeBackingDiversityScore(distribution)).toBe(0);
  });

  it("returns 100 for perfect three-way split", () => {
    const distribution = { "rwa-backed": 1/3, "crypto-backed": 1/3, algorithmic: 1/3 };
    expect(computeBackingDiversityScore(distribution)).toBe(100);
  });

  it("returns intermediate score for two-type split", () => {
    const distribution = { "rwa-backed": 0.5, "crypto-backed": 0.5, algorithmic: 0 };
    const score = computeBackingDiversityScore(distribution);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
  });
});

describe("computePegStabilityScore", () => {
  it("returns 100 for perfect peg", () => {
    const coins = [{ price: 1.0, pegRef: 1.0, supplyUsd: 1_000_000 }];
    expect(computePegStabilityScore(coins)).toBe(100);
  });

  it("returns 0 when deviation exceeds 500 bps", () => {
    const coins = [{ price: 0.94, pegRef: 1.0, supplyUsd: 1_000_000 }];
    expect(computePegStabilityScore(coins)).toBe(0);
  });

  it("returns 50 for no-price coins", () => {
    const coins = [{ price: null as number | null, pegRef: 1.0, supplyUsd: 1_000_000 }];
    expect(computePegStabilityScore(coins)).toBe(50);
  });

  it("supply-weights multiple coins", () => {
    const coins = [
      { price: 1.0, pegRef: 1.0, supplyUsd: 900_000 },
      { price: 0.97, pegRef: 1.0, supplyUsd: 100_000 },
    ];
    const score = computePegStabilityScore(coins);
    // 90% weight at 100, 10% weight at 40 => 94
    expect(score).toBe(94);
  });
});

describe("computeQualityScore", () => {
  it("returns supply-weighted average", () => {
    const coins = [
      { safetyScore: 80, supplyUsd: 500_000 },
      { safetyScore: 60, supplyUsd: 500_000 },
    ];
    expect(computeQualityScore(coins, 0.5)).toBe(70);
  });

  it("returns null when coverage is below threshold", () => {
    const coins = [
      { safetyScore: null as number | null, supplyUsd: 600_000 },
      { safetyScore: 80, supplyUsd: 400_000 },
    ];
    expect(computeQualityScore(coins, 0.5)).toBeNull();
  });

  it("uses default 40 for unrated coins when coverage is sufficient", () => {
    const coins = [
      { safetyScore: 80, supplyUsd: 800_000 },
      { safetyScore: null as number | null, supplyUsd: 200_000 },
    ];
    const score = computeQualityScore(coins, 0.5);
    // 80% at 80, 20% at 40 => 72
    expect(score).toBe(72);
  });
});

describe("computeHealthScore", () => {
  it("computes weighted composite", () => {
    const score = computeHealthScore({
      quality: 80,
      concentration: 60,
      pegStability: 90,
      backingDiversity: 40,
    });
    // 0.35*80 + 0.25*60 + 0.25*90 + 0.15*40 = 28+15+22.5+6 = 71.5 => 72
    expect(score).toBe(72);
  });

  it("returns null when quality is null", () => {
    expect(computeHealthScore({
      quality: null,
      concentration: 60,
      pegStability: 90,
      backingDiversity: 40,
    })).toBeNull();
  });
});

describe("getHealthBand", () => {
  it("maps score ranges correctly", () => {
    expect(getHealthBand(85)).toBe("robust");
    expect(getHealthBand(65)).toBe("healthy");
    expect(getHealthBand(45)).toBe("mixed");
    expect(getHealthBand(25)).toBe("fragile");
    expect(getHealthBand(10)).toBe("concentrated");
    expect(getHealthBand(null)).toBeNull();
  });
});

describe("HEALTH_METHODOLOGY_VERSION", () => {
  it("is a semver-like string", () => {
    expect(HEALTH_METHODOLOGY_VERSION).toMatch(/^\d+\.\d+$/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- shared/lib/__tests__/chain-health.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement chain-health.ts**

Create `shared/lib/chain-health.ts`:

```typescript
import type { ChainHealthFactors, HealthBand } from "../types/chains";

export const HEALTH_METHODOLOGY_VERSION = "1.0";

const QUALITY_WEIGHT = 0.35;
const CONCENTRATION_WEIGHT = 0.25;
const PEG_STABILITY_WEIGHT = 0.25;
const BACKING_DIVERSITY_WEIGHT = 0.15;

const DEFAULT_UNRATED_SAFETY_SCORE = 40;
const QUALITY_COVERAGE_THRESHOLD = 0.5;

// --- Sub-factor computations ---

/** Concentration: 100 * (1 - HHI). Single coin = 0, even N-way split = 100*(1-1/N). */
export function computeConcentrationScore(shares: number[]): number {
  if (shares.length <= 1) return 0;
  const hhi = shares.reduce((sum, s) => sum + s * s, 0);
  return Math.round(100 * (1 - hhi));
}

/** Backing diversity: normalized Shannon entropy across 3 backing types. */
export function computeBackingDiversityScore(
  distribution: Record<string, number>,
): number {
  const values = Object.values(distribution).filter((v) => v > 0);
  if (values.length <= 1) return 0;
  const entropy = -values.reduce((sum, p) => sum + p * Math.log(p), 0);
  const maxEntropy = Math.log(3); // ln(3) for three backing types
  return Math.round(100 * (entropy / maxEntropy));
}

interface PegStabilityCoin {
  price: number | null;
  pegRef: number;
  supplyUsd: number;
}

/** Peg stability: supply-weighted average of per-coin peg proximity (100 - deviationBps/5). */
export function computePegStabilityScore(coins: PegStabilityCoin[]): number {
  let totalWeight = 0;
  let weightedSum = 0;
  for (const coin of coins) {
    if (coin.supplyUsd <= 0) continue;
    let coinScore: number;
    if (coin.price == null || coin.pegRef <= 0) {
      coinScore = 50; // neutral for no-price
    } else {
      const deviationBps = Math.abs(coin.price - coin.pegRef) / coin.pegRef * 10_000;
      coinScore = Math.max(0, 100 - deviationBps / 5);
    }
    weightedSum += coinScore * coin.supplyUsd;
    totalWeight += coin.supplyUsd;
  }
  if (totalWeight === 0) return 50;
  return Math.round(weightedSum / totalWeight);
}

interface QualityCoin {
  safetyScore: number | null;
  supplyUsd: number;
}

/** Quality: supply-weighted average of safety scores. Null if <50% coverage by value. */
export function computeQualityScore(
  coins: QualityCoin[],
  coverageThreshold = QUALITY_COVERAGE_THRESHOLD,
): number | null {
  let totalSupply = 0;
  let ratedSupply = 0;
  for (const coin of coins) {
    totalSupply += coin.supplyUsd;
    if (coin.safetyScore != null) ratedSupply += coin.supplyUsd;
  }
  if (totalSupply === 0) return null;
  if (ratedSupply / totalSupply < coverageThreshold) return null;

  let weightedSum = 0;
  for (const coin of coins) {
    const score = coin.safetyScore ?? DEFAULT_UNRATED_SAFETY_SCORE;
    weightedSum += score * coin.supplyUsd;
  }
  return Math.round(weightedSum / totalSupply);
}

// --- Composite ---

export function computeHealthScore(factors: ChainHealthFactors): number | null {
  if (factors.quality == null) return null;
  const raw =
    QUALITY_WEIGHT * factors.quality +
    CONCENTRATION_WEIGHT * factors.concentration +
    PEG_STABILITY_WEIGHT * factors.pegStability +
    BACKING_DIVERSITY_WEIGHT * factors.backingDiversity;
  return Math.round(raw);
}

export function getHealthBand(score: number | null): HealthBand | null {
  if (score == null) return null;
  if (score >= 80) return "robust";
  if (score >= 60) return "healthy";
  if (score >= 40) return "mixed";
  if (score >= 20) return "fragile";
  return "concentrated";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- shared/lib/__tests__/chain-health.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add shared/lib/chain-health.ts shared/lib/__tests__/chain-health.test.ts
git commit -m "feat(chains): add chain health score computation with tests"
```

### Task 3: Chain Aggregator — Transform Stablecoins Cache into ChainSummary[]

**Files:**
- Modify: `shared/lib/chains.ts` (export `CHAIN_ALIASES`)
- Create: `shared/lib/chain-aggregator.ts`
- Create: `shared/lib/__tests__/chain-aggregator.test.ts`

- [ ] **Step 0: Export CHAIN_ALIASES from chains.ts**

In `shared/lib/chains.ts`, add after the `CHAIN_META` export:

```typescript
/** Alias chains that share a display name. Map alias -> canonical key. */
export const CHAIN_ALIASES: Record<string, string> = {
  "hyperliquid-l1": "hyperliquid",
};
```

- [ ] **Step 1: Write failing tests for chain aggregation**

Create `shared/lib/__tests__/chain-aggregator.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { aggregateChains, type ChainAggregatorInput } from "../chain-aggregator";

function makeInput(overrides: Partial<ChainAggregatorInput> = {}): ChainAggregatorInput {
  return {
    peggedAssets: [
      {
        id: "usdt-tether",
        symbol: "USDT",
        name: "Tether",
        price: 1.0,
        pegType: "peggedUSD",
        chainCirculating: {
          ethereum: { current: 300, circulatingPrevDay: 295, circulatingPrevWeek: 280, circulatingPrevMonth: 250 },
          bsc: { current: 200, circulatingPrevDay: 200, circulatingPrevWeek: 200, circulatingPrevMonth: 200 },
        },
      },
      {
        id: "usdc-circle",
        symbol: "USDC",
        name: "USD Coin",
        price: 0.999,
        pegType: "peggedUSD",
        chainCirculating: {
          ethereum: { current: 250, circulatingPrevDay: 248, circulatingPrevWeek: 240, circulatingPrevMonth: 230 },
        },
      },
    ],
    safetyScores: { "usdt-tether": 75, "usdc-circle": 88 },
    pegRates: { peggedUSD: 1 },
    ...overrides,
  };
}

describe("aggregateChains", () => {
  it("aggregates chain totals and computes deltas", () => {
    const result = aggregateChains(makeInput());
    const eth = result.chains.find((c) => c.id === "ethereum");
    expect(eth).toBeDefined();
    expect(eth!.totalUsd).toBe(550); // 300 + 250
    expect(eth!.stablecoinCount).toBe(2);
    expect(eth!.change24h).toBeCloseTo(7); // (300-295) + (250-248) = 5+2
  });

  it("sorts by totalUsd descending", () => {
    const result = aggregateChains(makeInput());
    expect(result.chains[0].id).toBe("ethereum");
    expect(result.chains[1].id).toBe("bsc");
  });

  it("excludes chains with zero total supply", () => {
    const input = makeInput({
      peggedAssets: [{
        id: "usdt-tether", symbol: "USDT", price: 1.0,
        pegType: "peggedUSD",
        chainCirculating: {
          ethereum: { current: 100, circulatingPrevDay: 100, circulatingPrevWeek: 100, circulatingPrevMonth: 100 },
          bsc: { current: 0, circulatingPrevDay: 0, circulatingPrevWeek: 0, circulatingPrevMonth: 0 },
        },
      }],
    });
    const result = aggregateChains(input);
    expect(result.chains.find((c) => c.id === "bsc")).toBeUndefined();
  });

  it("skips chains not in CHAIN_META", () => {
    const input = makeInput({
      peggedAssets: [{
        id: "usdt-tether", symbol: "USDT", price: 1.0,
        pegType: "peggedUSD",
        chainCirculating: {
          ethereum: { current: 50, circulatingPrevDay: 50, circulatingPrevWeek: 50, circulatingPrevMonth: 50 },
          "unknown-chain-xyz": { current: 50, circulatingPrevDay: 50, circulatingPrevWeek: 50, circulatingPrevMonth: 50 },
        },
      }],
    });
    const result = aggregateChains(input);
    expect(result.chains.find((c) => c.id === "unknown-chain-xyz")).toBeUndefined();
  });

  it("computes globalTotalUsd across all chains", () => {
    const result = aggregateChains(makeInput());
    expect(result.globalTotalUsd).toBe(750); // 550 + 200
  });

  it("computes dominanceShare", () => {
    const result = aggregateChains(makeInput());
    const eth = result.chains.find((c) => c.id === "ethereum")!;
    expect(eth.dominanceShare).toBeCloseTo(550 / 750, 4);
  });

  it("computes health score factors", () => {
    const result = aggregateChains(makeInput());
    const eth = result.chains.find((c) => c.id === "ethereum")!;
    expect(eth.healthFactors.concentration).toBeGreaterThan(0);
    expect(eth.healthFactors.quality).toBeGreaterThan(0);
    expect(eth.healthFactors.pegStability).toBeGreaterThan(0);
    expect(eth.healthScore).toBeGreaterThan(0);
    expect(eth.healthBand).toBeTruthy();
  });

  it("deduplicates alias chains (hyperliquid)", () => {
    const input = makeInput({
      peggedAssets: [{
        id: "usdt-tether", symbol: "USDT", price: 1.0,
        pegType: "peggedUSD",
        chainCirculating: {
          hyperliquid: { current: 60, circulatingPrevDay: 60, circulatingPrevWeek: 60, circulatingPrevMonth: 60 },
          "hyperliquid-l1": { current: 40, circulatingPrevDay: 40, circulatingPrevWeek: 40, circulatingPrevMonth: 40 },
        },
      }],
    });
    const result = aggregateChains(input);
    const hl = result.chains.filter((c) => c.name === "Hyperliquid L1");
    expect(hl).toHaveLength(1);
    expect(hl[0].totalUsd).toBe(100);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- shared/lib/__tests__/chain-aggregator.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement chain-aggregator.ts**

Create `shared/lib/chain-aggregator.ts`:

```typescript
import { CHAIN_META, CHAIN_ALIASES } from "./chains";
import { TRACKED_META_BY_ID } from "./stablecoins";
import { getPegReference } from "./peg-rates";
import {
  computeConcentrationScore,
  computeBackingDiversityScore,
  computePegStabilityScore,
  computeQualityScore,
  computeHealthScore,
  getHealthBand,
  HEALTH_METHODOLOGY_VERSION,
} from "./chain-health";
import type { BackingType } from "../types";
import type {
  ChainSummary,
  ChainsResponse,
  ChainHealthFactors,
} from "../types/chains";

/** Narrow input type — only the fields the aggregator actually reads. */
export interface ChainAggregatorAsset {
  id: string;
  symbol: string;
  name?: string;
  price: number | null;
  pegType?: string;
  chainCirculating?: Record<string, { current?: number; circulatingPrevDay?: number; circulatingPrevWeek?: number; circulatingPrevMonth?: number }>;
}

export interface ChainAggregatorInput {
  peggedAssets: ChainAggregatorAsset[];
  safetyScores: Record<string, number>; // stablecoin id -> safety score (0-100)
  pegRates: Record<string, number>;
}

interface ChainAccumulator {
  totalUsd: number;
  prevDay: number;
  prevWeek: number;
  prevMonth: number;
  coins: Array<{
    id: string;
    symbol: string;
    supplyUsd: number;
    price: number | null;
    pegType: string | undefined;
    safetyScore: number | null;
    backing: BackingType | undefined;
  }>;
}

function resolveCanonicalChainId(raw: string): string | null {
  const canonical = CHAIN_ALIASES[raw] ?? raw;
  return CHAIN_META[canonical] ? canonical : null;
}

export function aggregateChains(input: ChainAggregatorInput): ChainsResponse {
  const { peggedAssets, safetyScores, pegRates } = input;
  // Note: peggedAssets uses ChainAggregatorAsset (narrow type), not full StablecoinData

  // Phase 1: accumulate per-chain data
  const accumulators = new Map<string, ChainAccumulator>();

  for (const asset of peggedAssets) {
    const cc = asset.chainCirculating;
    if (!cc || typeof cc !== "object") continue;

    for (const [rawChainId, data] of Object.entries(cc)) {
      if (!data || typeof data !== "object") continue;
      const d = data as { current?: number; circulatingPrevDay?: number; circulatingPrevWeek?: number; circulatingPrevMonth?: number };
      const current = d.current ?? 0;
      if (current <= 0) continue;

      const chainId = resolveCanonicalChainId(rawChainId);
      if (!chainId) continue;

      let acc = accumulators.get(chainId);
      if (!acc) {
        acc = { totalUsd: 0, prevDay: 0, prevWeek: 0, prevMonth: 0, coins: [] };
        accumulators.set(chainId, acc);
      }

      acc.totalUsd += current;
      acc.prevDay += d.circulatingPrevDay ?? 0;
      acc.prevWeek += d.circulatingPrevWeek ?? 0;
      acc.prevMonth += d.circulatingPrevMonth ?? 0;

      const meta = TRACKED_META_BY_ID.get(asset.id);
      acc.coins.push({
        id: asset.id,
        symbol: asset.symbol,
        supplyUsd: current,
        price: typeof asset.price === "number" ? asset.price : null,
        pegType: asset.pegType,
        safetyScore: safetyScores[asset.id] ?? null,
        backing: meta?.flags?.backing,
      });
    }
  }

  // Phase 2: compute summaries
  const globalTotalUsd = Array.from(accumulators.values()).reduce((s, a) => s + a.totalUsd, 0);
  const chains: ChainSummary[] = [];

  for (const [chainId, acc] of accumulators) {
    if (acc.totalUsd <= 0) continue;

    const meta = CHAIN_META[chainId];
    if (!meta) continue;

    // Deltas
    const change24h = acc.totalUsd - acc.prevDay;
    const change7d = acc.totalUsd - acc.prevWeek;
    const change30d = acc.totalUsd - acc.prevMonth;

    // Dominant stablecoin
    const sorted = [...acc.coins].sort((a, b) => b.supplyUsd - a.supplyUsd);
    const dominant = sorted[0];

    // Supply shares for concentration
    const shares = acc.coins.map((c) => c.supplyUsd / acc.totalUsd);

    // Backing distribution
    const backingTotals: Record<string, number> = { "rwa-backed": 0, "crypto-backed": 0, algorithmic: 0 };
    for (const coin of acc.coins) {
      const key = coin.backing ?? "rwa-backed"; // default to rwa-backed for unknowns
      backingTotals[key] = (backingTotals[key] ?? 0) + coin.supplyUsd;
    }
    const backingDist: Record<string, number> = {};
    for (const [key, val] of Object.entries(backingTotals)) {
      backingDist[key] = acc.totalUsd > 0 ? val / acc.totalUsd : 0;
    }

    // Peg stability
    const pegCoins = acc.coins.map((c) => {
      const coinMeta = TRACKED_META_BY_ID.get(c.id);
      const pegRef = getPegReference(c.pegType, pegRates, coinMeta?.commodityOunces);
      return { price: c.price, pegRef, supplyUsd: c.supplyUsd };
    });

    // Quality
    const qualityCoins = acc.coins.map((c) => ({
      safetyScore: c.safetyScore,
      supplyUsd: c.supplyUsd,
    }));

    const healthFactors: ChainHealthFactors = {
      concentration: computeConcentrationScore(shares),
      quality: computeQualityScore(qualityCoins),
      pegStability: computePegStabilityScore(pegCoins),
      backingDiversity: computeBackingDiversityScore(backingDist),
    };

    const healthScore = computeHealthScore(healthFactors);
    const healthBand = getHealthBand(healthScore);

    chains.push({
      id: chainId,
      name: meta.name,
      logoPath: meta.logoPath,
      type: meta.type,
      totalUsd: acc.totalUsd,
      change24h,
      change24hPct: acc.prevDay > 0 ? change24h / acc.prevDay : 0,
      change7d,
      change7dPct: acc.prevWeek > 0 ? change7d / acc.prevWeek : 0,
      change30d,
      change30dPct: acc.prevMonth > 0 ? change30d / acc.prevMonth : 0,
      stablecoinCount: acc.coins.length,
      dominantStablecoin: {
        id: dominant.id,
        symbol: dominant.symbol,
        share: dominant.supplyUsd / acc.totalUsd,
      },
      dominanceShare: globalTotalUsd > 0 ? acc.totalUsd / globalTotalUsd : 0,
      healthScore,
      healthBand,
      healthFactors,
    });
  }

  chains.sort((a, b) => b.totalUsd - a.totalUsd);

  return {
    chains,
    globalTotalUsd,
    updatedAt: Math.floor(Date.now() / 1000),
    healthMethodologyVersion: HEALTH_METHODOLOGY_VERSION,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- shared/lib/__tests__/chain-aggregator.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Run type-check**

Run: `npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add shared/lib/chains.ts shared/lib/chain-aggregator.ts shared/lib/__tests__/chain-aggregator.test.ts
git commit -m "feat(chains): add chain aggregator with health score integration"
```

---

## Chunk 2: Worker API Endpoint, D1 Migration, and Cron Stage

### Task 4: API Endpoint Registration (shared + worker wiring)

**Files:**
- Modify: `shared/lib/api-endpoints.ts` (add `chains` path + definition)
- Modify: `worker/src/lib/constants.ts` (add freshness threshold)

- [ ] **Step 1: Add API_PATHS.chains**

In `shared/lib/api-endpoints.ts`, add to the `API_PATHS` object (after `stressSignals`):

```typescript
chains: () => "/api/chains",
```

- [ ] **Step 2: Add ENDPOINT_DEFINITIONS entry**

In `shared/lib/api-endpoints.ts`, add to the `ENDPOINT_DEFINITIONS` array (after the `stress-signals` entry, before the `feedback` entry):

```typescript
{
  key: "chains",
  path: API_PATHS.chains(),
  methods: ["GET"],
  adminRequired: false,
  mutatingAdmin: false,
  cacheBypass: false,
  probeGroup: "public",
},
```

- [ ] **Step 3: Add freshness threshold**

In `worker/src/lib/constants.ts`, add to `CACHE_FRESHNESS_THRESHOLDS`:

```typescript
chains: 600,
```

- [ ] **Step 4: Verify types compile**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add shared/lib/api-endpoints.ts worker/src/lib/constants.ts
git commit -m "feat(chains): register /api/chains endpoint and freshness threshold"
```

### Task 5: Chains API Handler

**Files:**
- Create: `worker/src/api/chains.ts`
- Create: `worker/src/api/__tests__/chains.test.ts`
- Modify: `worker/src/route-registry.ts`

- [ ] **Step 1: Write failing tests for the chains handler**

Create `worker/src/api/__tests__/chains.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { mockD1 } from "./helpers/mock-d1";

// Mock stablecoins to avoid importing full metadata tree
vi.mock("@shared/lib/stablecoins", () => ({
  TRACKED_META_BY_ID: new Map([
    ["usdt-tether", { flags: { backing: "rwa-backed" }, commodityOunces: undefined }],
    ["usdc-circle", { flags: { backing: "rwa-backed" }, commodityOunces: undefined }],
    ["dai-makerdao", { flags: { backing: "crypto-backed" }, commodityOunces: undefined }],
  ]),
  TRACKED_STABLECOINS: [],
}));

import { handleChains } from "../chains";

function freshCache(payload: unknown, ageSeconds = 60) {
  return {
    match: "cache",
    matchBinds: ["stablecoins"],
    rows: [],
    first: {
      key: "stablecoins",
      value: JSON.stringify(payload),
      updated_at: Math.floor(Date.now() / 1000) - ageSeconds,
    },
  };
}

function reportCardCache(scores: Record<string, { score: number; grade: string }>) {
  return {
    match: "cache",
    matchBinds: ["report_card_cache"],
    rows: [],
    first: {
      key: "report_card_cache",
      value: JSON.stringify({
        scores,
        updatedAt: Math.floor(Date.now() / 1000) - 60,
      }),
      updated_at: Math.floor(Date.now() / 1000) - 60,
    },
  };
}

describe("handleChains", () => {
  it("returns 503 when stablecoins cache is missing", async () => {
    const db = mockD1();
    const response = await handleChains(db);
    expect(response.status).toBe(503);
  });

  it("returns chains sorted by totalUsd", async () => {
    const payload = {
      peggedAssets: [
        {
          id: "usdt-tether", symbol: "USDT", name: "Tether", price: 1.0, pegType: "peggedUSD",
          circulating: { peggedUSD: 500 },
          chainCirculating: {
            ethereum: { current: 300, circulatingPrevDay: 290, circulatingPrevWeek: 280, circulatingPrevMonth: 250 },
            bsc: { current: 200, circulatingPrevDay: 200, circulatingPrevWeek: 200, circulatingPrevMonth: 200 },
          },
        },
        {
          id: "usdc-circle", symbol: "USDC", name: "USD Coin", price: 0.999, pegType: "peggedUSD",
          circulating: { peggedUSD: 300 },
          chainCirculating: {
            ethereum: { current: 300, circulatingPrevDay: 300, circulatingPrevWeek: 300, circulatingPrevMonth: 300 },
          },
        },
      ],
    };

    const db = mockD1([
      freshCache(payload),
      reportCardCache({ "usdt-tether": { score: 75, grade: "B" }, "usdc-circle": { score: 88, grade: "A" } }),
    ]);

    const response = await handleChains(db);
    expect(response.status).toBe(200);
    const body = await response.json() as { chains: Array<{ id: string; totalUsd: number; healthScore: number | null }> };
    expect(body.chains[0].id).toBe("ethereum");
    expect(body.chains[0].totalUsd).toBe(600);
    expect(body.chains[0].healthScore).toBeTypeOf("number");
  });

  it("returns null healthScore when report card cache is missing", async () => {
    const payload = {
      peggedAssets: [{
        id: "usdt-tether", symbol: "USDT", name: "Tether", price: 1.0, pegType: "peggedUSD",
        circulating: { peggedUSD: 100 },
        chainCirculating: {
          ethereum: { current: 100, circulatingPrevDay: 100, circulatingPrevWeek: 100, circulatingPrevMonth: 100 },
        },
      }],
    };

    const db = mockD1([freshCache(payload)]);
    const response = await handleChains(db);
    expect(response.status).toBe(200);
    const body = await response.json() as { chains: Array<{ healthScore: number | null }> };
    // No report card cache → quality null → healthScore null
    expect(body.chains[0].healthScore).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- worker/src/api/__tests__/chains.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the handler**

Create `worker/src/api/chains.ts`:

```typescript
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { loadReportCardCache } from "../lib/report-card-cache";
import { aggregateChains } from "@shared/lib/chain-aggregator";
import { derivePegRates } from "@shared/lib/peg-rates";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { addFreshnessHeaders, errorResponse, jsonResponse } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

const CHAINS_FRESHNESS_MAX_AGE_SEC = 600;

export async function handleChains(db: D1Database): Promise<Response> {
  const stablecoinsResult = await loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: false });
  if (stablecoinsResult.kind !== "ok") {
    return errorResponse(503, "Data not yet available");
  }

  const { peggedAssets, fxFallbackRates } = stablecoinsResult.payload;

  // Derive peg rates for non-USD peg stability calculation
  const { rates: pegRates } = derivePegRates(peggedAssets, TRACKED_META_BY_ID, fxFallbackRates);

  // Load safety scores from report card cache (one D1 read)
  const safetyScores: Record<string, number> = {};
  const reportCardResult = await loadReportCardCache(db);
  if (reportCardResult.kind === "ok") {
    for (const [id, entry] of Object.entries(reportCardResult.payload.scores)) {
      safetyScores[id] = entry.score;
    }
  }

  const response = aggregateChains({
    peggedAssets,
    safetyScores,
    pegRates,
  });

  // Use stablecoins cache updatedAt for freshness
  response.updatedAt = stablecoinsResult.updatedAt;

  const headers = addFreshnessHeaders(
    { "Cache-Control": CACHE_PROFILES.realtime },
    stablecoinsResult.updatedAt,
    CHAINS_FRESHNESS_MAX_AGE_SEC,
  );

  return jsonResponse(response, headers);
}
```

- [ ] **Step 4: Register the handler in route-registry.ts**

In `worker/src/route-registry.ts`:

1. Add import: `import { handleChains } from "./api/chains";`
2. Add to `STATIC_ROUTE_HANDLERS_BY_KEY` (after `"stress-signals"`):
```typescript
chains: withErrorHandler("chains", ({ db }) => handleChains(db)),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- worker/src/api/__tests__/chains.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Run full type-check**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add worker/src/api/chains.ts worker/src/api/__tests__/chains.test.ts worker/src/route-registry.ts
git commit -m "feat(chains): add GET /api/chains handler with health score"
```

### Task 6: D1 Migration — chain_supply_history Table

**Files:**
- Create: `worker/migrations/0069_chain_supply_history.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- Chain supply history: daily snapshots of per-chain stablecoin supply totals.
-- ~50 chains x 1 row/day = ~50 rows/day. Negligible storage.
CREATE TABLE IF NOT EXISTS chain_supply_history (
  chain_id TEXT NOT NULL,
  snapshot_date INTEGER NOT NULL,
  total_usd REAL NOT NULL,
  stablecoin_count INTEGER NOT NULL,
  PRIMARY KEY (chain_id, snapshot_date)
);
```

- [ ] **Step 2: Commit**

```bash
git add worker/migrations/0069_chain_supply_history.sql
git commit -m "feat(chains): add chain_supply_history D1 migration"
```

### Task 7: Chain Supply Snapshot Cron Stage

**Files:**
- Create: `worker/src/cron/snapshot-chain-supply.ts`
- Create: `worker/src/cron/__tests__/snapshot-chain-supply.test.ts`
- Modify: `worker/src/handlers/scheduled/quarter-hourly.ts`

- [ ] **Step 1: Write failing tests**

Create `worker/src/cron/__tests__/snapshot-chain-supply.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

vi.mock("@shared/lib/stablecoins", () => ({
  TRACKED_META_BY_ID: new Map(),
  TRACKED_STABLECOINS: [],
}));

vi.mock("@shared/lib/supply", () => ({
  sumPegBuckets: (c: Record<string, number> | undefined) => {
    if (!c) return 0;
    return Object.values(c).reduce((a, b) => a + b, 0);
  },
}));

import { snapshotChainSupply } from "../snapshot-chain-supply";

describe("snapshotChainSupply", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T08:30:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("returns degraded when cache is missing", async () => {
    const db = mockD1();
    const result = await snapshotChainSupply(db);
    expect(result.itemCount).toBe(0);
    expect(result.status).toBe("degraded");
  });

  it("inserts rows for chains with supply", async () => {
    const payload = {
      peggedAssets: [
        {
          id: "usdt-tether", symbol: "USDT", name: "Tether", price: 1.0, pegType: "peggedUSD",
          circulating: { peggedUSD: 100 },
          chainCirculating: {
            ethereum: { current: 60, circulatingPrevDay: 60, circulatingPrevWeek: 60, circulatingPrevMonth: 60 },
            bsc: { current: 40, circulatingPrevDay: 40, circulatingPrevWeek: 40, circulatingPrevMonth: 40 },
          },
          chains: ["ethereum", "bsc"],
        },
      ],
    };
    const freshUpdatedAt = Math.floor(Date.now() / 1000) - 60;
    const db = mockD1([{
      match: "cache",
      matchBinds: ["stablecoins"],
      rows: [],
      first: { key: "stablecoins", value: JSON.stringify(payload), updated_at: freshUpdatedAt },
    }]);
    const result = await snapshotChainSupply(db);
    expect(result.itemCount).toBe(2); // ethereum + bsc
  });

  it("returns degraded when aborted", async () => {
    const db = mockD1();
    const controller = new AbortController();
    controller.abort();
    const result = await snapshotChainSupply(db, controller.signal);
    expect(result.status).toBe("degraded");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- worker/src/cron/__tests__/snapshot-chain-supply.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement snapshot-chain-supply.ts**

Create `worker/src/cron/snapshot-chain-supply.ts`:

```typescript
import { batchExecute } from "../lib/db";
import { CHAIN_META, CHAIN_ALIASES } from "@shared/lib/chains";
import type { CronResult } from "../lib/cron-logger";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";

export async function snapshotChainSupply(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  if (signal?.aborted) {
    return { status: "degraded", itemCount: 0, metadata: JSON.stringify({ reason: "aborted" }) };
  }

  const cache = await loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: false });
  if (cache.kind !== "ok") {
    console.error("[snapshot-chain-supply] No stablecoins cache found");
    return { status: "degraded", itemCount: 0, metadata: JSON.stringify({ reason: cache.reason }) };
  }

  const cacheAge = Math.floor(Date.now() / 1000) - cache.updatedAt;
  if (cacheAge > 1200) {
    console.warn(`[snapshot-chain-supply] Cache is ${cacheAge}s old (>1200s), skipping`);
    return { status: "degraded", itemCount: 0, metadata: JSON.stringify({ reason: "cache_stale", cacheAgeSec: cacheAge }) };
  }

  // Accumulate per-chain totals
  const chainTotals = new Map<string, { totalUsd: number; coinCount: number }>();

  for (const asset of cache.payload.peggedAssets) {
    const cc = asset.chainCirculating;
    if (!cc || typeof cc !== "object") continue;

    for (const [rawId, data] of Object.entries(cc)) {
      if (!data || typeof data !== "object") continue;
      const current = (data as { current?: number }).current ?? 0;
      if (current <= 0) continue;

      const canonicalId = CHAIN_ALIASES[rawId] ?? rawId;
      if (!CHAIN_META[canonicalId]) continue;

      const existing = chainTotals.get(canonicalId) ?? { totalUsd: 0, coinCount: 0 };
      existing.totalUsd += current;
      existing.coinCount += 1;
      chainTotals.set(canonicalId, existing);
    }
  }

  // Floor to UTC midnight
  const now = new Date();
  const snapshotDate = Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000,
  );

  const stmts: D1PreparedStatement[] = [];
  for (const [chainId, { totalUsd, coinCount }] of chainTotals) {
    stmts.push(
      db.prepare(
        "INSERT OR REPLACE INTO chain_supply_history (chain_id, snapshot_date, total_usd, stablecoin_count) VALUES (?, ?, ?, ?)",
      ).bind(chainId, snapshotDate, totalUsd, coinCount),
    );
  }

  if (stmts.length > 0) {
    await batchExecute(db, stmts);
  }

  console.log(`[snapshot-chain-supply] Inserted ${stmts.length} rows for ${new Date(snapshotDate * 1000).toISOString().slice(0, 10)}`);
  return { itemCount: stmts.length };
}
```

- [ ] **Step 4: Register in CRON_JOB_DEFINITIONS_BASE**

In `shared/lib/cron-jobs.ts`, add to `CRON_JOB_DEFINITIONS_BASE` (right after the `snapshot-supply` entry):

```typescript
{
  job: "snapshot-chain-supply",
  label: "Chain supply snapshot",
  group: "quarter-hourly",
  intervalSec: 86400,
  scheduleKey: "quarterHourly",
  triggerMode: "shared",
  maxConnections: 0, // DB-only computation
},
```

- [ ] **Step 5: Wire into quarter-hourly scheduler**

In `worker/src/handlers/scheduled/quarter-hourly.ts`:

1. Add import: `import { snapshotChainSupply } from "../../cron/snapshot-chain-supply";`
2. After the `snapshot-supply` job block (after line 49), add:
```typescript
if (stablecoinsCacheSafe) {
  await runQuarterHourlyJob("snapshot-chain-supply", (signal) => snapshotChainSupply(runtime.db, signal));
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- worker/src/cron/__tests__/snapshot-chain-supply.test.ts`
Expected: ALL PASS

- [ ] **Step 7: Run full type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add shared/lib/cron-jobs.ts worker/src/cron/snapshot-chain-supply.ts worker/src/cron/__tests__/snapshot-chain-supply.test.ts worker/src/handlers/scheduled/quarter-hourly.ts
git commit -m "feat(chains): add chain supply snapshot cron stage"
```

---

## Chunk 3: Frontend Hooks, Navigation, and Leaderboard Page

### Task 8: Frontend Hooks

**Files:**
- Create: `src/hooks/use-chains.ts`

- [ ] **Step 1: Create the hooks file**

```typescript
"use client";

import { useMemo } from "react";
import { API_PATHS } from "@shared/lib/api-endpoints";
import type { ChainsResponse } from "@shared/types/chains";
import { useApiQuery } from "./use-api-query";
import { useStablecoins } from "./use-stablecoins";
import { CRON_15MIN } from "@/lib/cron-intervals";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { StablecoinData } from "@shared/types";

export function useChains() {
  return useApiQuery<ChainsResponse>(
    ["chains"],
    API_PATHS.chains(),
    CRON_15MIN,
  );
}

export interface ChainStablecoin {
  id: string;
  name: string;
  symbol: string;
  price: number | null;
  pegType: string | undefined;
  supplyOnChain: number;
  chainShare: number;
  change24h: number;
  change24hPct: number;
  change7d: number;
  change7dPct: number;
  change30d: number;
  change30dPct: number;
  backing: string | undefined;
}

export function useChainStablecoins(chainId: string) {
  const { data, isLoading, isError } = useStablecoins();

  return useMemo(() => {
    if (!data?.peggedAssets) {
      return { coins: [], totalUsd: 0, isLoading, isError };
    }

    let totalUsd = 0;
    const coins: ChainStablecoin[] = [];

    for (const asset of data.peggedAssets) {
      const cc = asset.chainCirculating;
      if (!cc || typeof cc !== "object") continue;
      const chainData = cc[chainId] as { current?: number; circulatingPrevDay?: number; circulatingPrevWeek?: number; circulatingPrevMonth?: number } | undefined;
      if (!chainData?.current || chainData.current <= 0) continue;

      const supplyOnChain = chainData.current;
      totalUsd += supplyOnChain;

      const prev24h = chainData.circulatingPrevDay ?? 0;
      const prev7d = chainData.circulatingPrevWeek ?? 0;
      const prev30d = chainData.circulatingPrevMonth ?? 0;
      const meta = TRACKED_META_BY_ID.get(asset.id);

      coins.push({
        id: asset.id,
        name: asset.name ?? asset.symbol,
        symbol: asset.symbol,
        price: typeof asset.price === "number" ? asset.price : null,
        pegType: asset.pegType,
        supplyOnChain,
        chainShare: 0, // computed below
        change24h: supplyOnChain - prev24h,
        change24hPct: prev24h > 0 ? (supplyOnChain - prev24h) / prev24h : 0,
        change7d: supplyOnChain - prev7d,
        change7dPct: prev7d > 0 ? (supplyOnChain - prev7d) / prev7d : 0,
        change30d: supplyOnChain - prev30d,
        change30dPct: prev30d > 0 ? (supplyOnChain - prev30d) / prev30d : 0,
        backing: meta?.flags?.backing,
      });
    }

    // Fill chainShare now that totalUsd is known
    for (const coin of coins) {
      coin.chainShare = totalUsd > 0 ? coin.supplyOnChain / totalUsd : 0;
    }

    coins.sort((a, b) => b.supplyOnChain - a.supplyOnChain);

    return { coins, totalUsd, isLoading, isError };
  }, [data, chainId, isLoading, isError]);
}
```

- [ ] **Step 2: Verify types compile**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/hooks/use-chains.ts
git commit -m "feat(chains): add useChains and useChainStablecoins hooks"
```

### Task 9: Sidebar Navigation

**Files:**
- Modify: `src/lib/nav-config.ts`

- [ ] **Step 1: Add Chains to Data group**

In `src/lib/nav-config.ts`:

1. Add `Layers` to the lucide-react import
2. Insert as first item in the "Data" group:
```typescript
{ href: "/chains", label: "Chains", icon: Layers, description: "Stablecoin activity per chain" },
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/lib/nav-config.ts
git commit -m "feat(chains): add Chains to sidebar navigation"
```

### Task 10: Chains Leaderboard Page

**Files:**
- Create: `src/app/chains/page.tsx`
- Create: `src/app/chains/client.tsx`

- [ ] **Step 1: Create the server component**

Create `src/app/chains/page.tsx`:

```tsx
import type { Metadata } from "next";
import { buildPageMetadata } from "@/lib/page-metadata";
import { ChainsLeaderboardClient } from "./client";
import { FeaturePageShell } from "@/components/feature-page-shell";

export const metadata: Metadata = buildPageMetadata({
  title: "Chains",
  description: "Ranking blockchain networks by stablecoin supply, health score, and composition. Explore per-chain stablecoin analytics on Pharos.",
  canonical: "/chains/",
});

export default function ChainsPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Chains"
      path="/chains/"
      title="Chains"
      statusBadge={{ status: "beta" }}
      methodology={{ version: "1.0", changelogPath: "/methodology#chain-health-score" }}
      leadParagraphs={[
        "Blockchain networks ranked by stablecoin supply and health. The Chain Health Score rates each chain's stablecoin ecosystem on quality, concentration, peg stability, and backing diversity.",
      ]}
    >
      <ChainsLeaderboardClient />
    </FeaturePageShell>
  );
}
```

- [ ] **Step 2: Create the client component**

Create `src/app/chains/client.tsx`:

```tsx
"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useChains } from "@/hooks/use-chains";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ChainSummary, HealthBand } from "@shared/types/chains";

type SortKey = "totalUsd" | "healthScore" | "change24hPct" | "change7dPct" | "change30dPct" | "stablecoinCount" | "dominanceShare";
type SortDir = "asc" | "desc";

type ColumnId = "health" | "supply" | "change24hPct" | "change7dPct" | "change30dPct" | "dominanceShare" | "stablecoinCount" | "dominantStablecoin";

const DEFAULT_COLUMNS: ColumnId[] = ["health", "supply", "change7dPct", "dominanceShare"];
const ALL_COLUMNS: { id: ColumnId; label: string }[] = [
  { id: "health", label: "Health" },
  { id: "supply", label: "Supply" },
  { id: "change24hPct", label: "24h %" },
  { id: "change7dPct", label: "7d %" },
  { id: "change30dPct", label: "30d %" },
  { id: "dominanceShare", label: "Global Share" },
  { id: "stablecoinCount", label: "Stablecoins" },
  { id: "dominantStablecoin", label: "Dominant" },
];

const HEALTH_BAND_COLORS: Record<HealthBand, string> = {
  robust: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  healthy: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  mixed: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  fragile: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  concentrated: "bg-red-500/15 text-red-700 dark:text-red-400",
};

function formatUsd(value: number): string {
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function formatPct(value: number): string {
  const pct = value * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="px-4 py-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-bold tracking-tight">{value}</p>
      </CardContent>
    </Card>
  );
}

function HealthBadge({ score, band }: { score: number | null; band: HealthBand | null }) {
  if (score == null || band == null) {
    return <span className="text-xs text-muted-foreground">--</span>;
  }
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", HEALTH_BAND_COLORS[band])}>
      {score}
      <span className="hidden sm:inline capitalize">{band}</span>
    </span>
  );
}

export function ChainsLeaderboardClient() {
  const { data, isLoading, isError } = useChains();
  const [sortKey, setSortKey] = useState<SortKey>("totalUsd");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [visibleColumns, setVisibleColumns] = useState<Set<ColumnId>>(new Set(DEFAULT_COLUMNS));

  function toggleColumn(col: ColumnId) {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });
  }

  const isVisible = (col: ColumnId) => visibleColumns.has(col);

  const sorted = useMemo(() => {
    if (!data?.chains) return [];
    return [...data.chains].sort((a, b) => {
      const av = a[sortKey] ?? -Infinity;
      const bv = b[sortKey] ?? -Infinity;
      return sortDir === "desc" ? (bv as number) - (av as number) : (av as number) - (bv as number);
    });
  }, [data, sortKey, sortDir]);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  if (isLoading) {
    return <div className="flex items-center justify-center py-20 text-muted-foreground">Loading chain data...</div>;
  }
  if (isError || !data) {
    return <div className="flex items-center justify-center py-20 text-destructive">Failed to load chain data.</div>;
  }

  const topHealthChain = [...data.chains].sort((a, b) => (b.healthScore ?? -1) - (a.healthScore ?? -1))[0];

  return (
    <div className="space-y-6">
      {/* KPI Strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Total Stablecoin Supply" value={formatUsd(data.globalTotalUsd)} />
        <KpiCard label="Active Chains" value={String(data.chains.length)} />
        <KpiCard label="Top Chain Dominance" value={data.chains[0] ? `${data.chains[0].name} ${(data.chains[0].dominanceShare * 100).toFixed(1)}%` : "--"} />
        <KpiCard label="Healthiest Chain" value={topHealthChain?.healthScore != null ? `${topHealthChain.name} (${topHealthChain.healthScore})` : "--"} />
      </div>

      {/* Column toggle */}
      <div className="flex justify-end">
        <div className="flex flex-wrap gap-1.5">
          {ALL_COLUMNS.map((col) => (
            <button
              key={col.id}
              onClick={() => toggleColumn(col.id)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                isVisible(col.id)
                  ? "border-primary/30 bg-primary/10 text-foreground"
                  : "border-border/60 bg-background text-muted-foreground hover:bg-muted/40",
              )}
            >
              {col.label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-xs font-medium text-muted-foreground">
              <th className="px-3 py-2 w-10">#</th>
              <th className="px-3 py-2">Chain</th>
              {isVisible("health") && <th className="px-3 py-2 cursor-pointer select-none" onClick={() => handleSort("healthScore")}>Health</th>}
              {isVisible("supply") && <th className="px-3 py-2 text-right cursor-pointer select-none" onClick={() => handleSort("totalUsd")}>Supply</th>}
              {isVisible("change24hPct") && <th className="px-3 py-2 text-right cursor-pointer select-none" onClick={() => handleSort("change24hPct")}>24h</th>}
              {isVisible("change7dPct") && <th className="px-3 py-2 text-right cursor-pointer select-none" onClick={() => handleSort("change7dPct")}>7d</th>}
              {isVisible("change30dPct") && <th className="px-3 py-2 text-right cursor-pointer select-none" onClick={() => handleSort("change30dPct")}>30d</th>}
              {isVisible("dominanceShare") && <th className="px-3 py-2 text-right cursor-pointer select-none" onClick={() => handleSort("dominanceShare")}>Global Share</th>}
              {isVisible("stablecoinCount") && <th className="px-3 py-2 text-right cursor-pointer select-none" onClick={() => handleSort("stablecoinCount")}>Stablecoins</th>}
              {isVisible("dominantStablecoin") && <th className="px-3 py-2">Dominant</th>}
            </tr>
          </thead>
          <tbody>
            {sorted.map((chain, i) => (
              <tr key={chain.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                <td className="px-3 py-2.5 text-muted-foreground">{i + 1}</td>
                <td className="px-3 py-2.5">
                  <Link href={`/chains/${chain.id}/`} className="flex items-center gap-2 hover:underline">
                    <Image src={chain.logoPath} alt="" width={20} height={20} className="rounded-full" />
                    <span className="font-medium">{chain.name}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">{chain.type}</span>
                  </Link>
                </td>
                {isVisible("health") && (
                  <td className="px-3 py-2.5"><HealthBadge score={chain.healthScore} band={chain.healthBand} /></td>
                )}
                {isVisible("supply") && (
                  <td className="px-3 py-2.5 text-right font-mono">{formatUsd(chain.totalUsd)}</td>
                )}
                {isVisible("change24hPct") && (
                  <td className={cn("px-3 py-2.5 text-right font-mono", chain.change24hPct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
                    {formatPct(chain.change24hPct)}
                  </td>
                )}
                {isVisible("change7dPct") && (
                  <td className={cn("px-3 py-2.5 text-right font-mono", chain.change7dPct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
                    {formatPct(chain.change7dPct)}
                  </td>
                )}
                {isVisible("change30dPct") && (
                  <td className={cn("px-3 py-2.5 text-right font-mono", chain.change30dPct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
                    {formatPct(chain.change30dPct)}
                  </td>
                )}
                {isVisible("dominanceShare") && (
                  <td className="px-3 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-primary/60" style={{ width: `${Math.min(100, chain.dominanceShare * 100)}%` }} />
                      </div>
                      <span className="text-xs font-mono text-muted-foreground w-10 text-right">{(chain.dominanceShare * 100).toFixed(1)}%</span>
                    </div>
                  </td>
                )}
                {isVisible("stablecoinCount") && (
                  <td className="px-3 py-2.5 text-right font-mono">{chain.stablecoinCount}</td>
                )}
                {isVisible("dominantStablecoin") && (
                  <td className="px-3 py-2.5 text-sm">
                    {chain.dominantStablecoin.symbol} ({(chain.dominantStablecoin.share * 100).toFixed(0)}%)
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/app/chains/page.tsx src/app/chains/client.tsx
git commit -m "feat(chains): add /chains/ leaderboard page"
```

---

## Chunk 4: Chain Profile Page and Contextual Links

### Task 11: Chain Profile Page

**Files:**
- Create: `src/app/chains/[chain]/page.tsx`
- Create: `src/app/chains/[chain]/client.tsx`

- [ ] **Step 1: Create the server component**

Create `src/app/chains/[chain]/page.tsx`:

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CHAIN_META } from "@shared/lib/chains";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { buildPageMetadata } from "@/lib/page-metadata";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { ChainProfileClient } from "./client";

function getActiveChainIds(): string[] {
  const chainIds = new Set<string>();
  for (const coin of TRACKED_STABLECOINS) {
    if (coin.contracts) {
      for (const contract of coin.contracts) {
        if (CHAIN_META[contract.chain]) chainIds.add(contract.chain);
      }
    }
  }
  return Array.from(chainIds);
}

export function generateStaticParams() {
  return getActiveChainIds().map((chain) => ({ chain }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ chain: string }>;
}): Promise<Metadata> {
  const { chain } = await params;
  const meta = CHAIN_META[chain];
  if (!meta) return {};
  return buildPageMetadata({
    title: `${meta.name} Stablecoin Analytics`,
    description: `Stablecoin supply, composition, health score, and activity on ${meta.name}. Explore which stablecoins are deployed on ${meta.name} and their market share.`,
    canonical: `/chains/${chain}/`,
  });
}

export default async function ChainProfilePage({
  params,
}: {
  params: Promise<{ chain: string }>;
}) {
  const { chain } = await params;
  const meta = CHAIN_META[chain];
  if (!meta) notFound();

  return (
    <FeaturePageShell
      breadcrumbName={meta.name}
      breadcrumbLabel={meta.name}
      path={`/chains/${chain}/`}
      title={`${meta.name} Stablecoins`}
    >
      <ChainProfileClient chainId={chain} />
    </FeaturePageShell>
  );
}
```

Note: The `generateStaticParams` uses contracts as a proxy for "active chains". At runtime the client will get the real data from the API. Chains that have stablecoins via `chainCirculating` but no contracts in our metadata will still work at runtime via client-side navigation; they just won't be pre-rendered.

- [ ] **Step 2: Create the client component**

Create `src/app/chains/[chain]/client.tsx`:

```tsx
"use client";

import { useMemo } from "react";
import Link from "next/link";
import Image from "next/image";
import { useChains, useChainStablecoins } from "@/hooks/use-chains";
import { CHAIN_META } from "@shared/lib/chains";
import { BACKING_LABELS_SHORT } from "@shared/lib/classification";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { buildStablecoinUrl } from "@/lib/urls";
import type { HealthBand, ChainSummary } from "@shared/types/chains";

const HEALTH_BAND_COLORS: Record<HealthBand, string> = {
  robust: "text-emerald-600 dark:text-emerald-400",
  healthy: "text-sky-600 dark:text-sky-400",
  mixed: "text-amber-600 dark:text-amber-400",
  fragile: "text-orange-600 dark:text-orange-400",
  concentrated: "text-red-600 dark:text-red-400",
};

const HEALTH_BAND_BG: Record<HealthBand, string> = {
  robust: "bg-emerald-500/15",
  healthy: "bg-sky-500/15",
  mixed: "bg-amber-500/15",
  fragile: "bg-orange-500/15",
  concentrated: "bg-red-500/15",
};

const BACKING_BAR_COLORS: Record<string, string> = {
  "rwa-backed": "bg-sky-500",
  "crypto-backed": "bg-violet-500",
  algorithmic: "bg-amber-500",
};

function formatUsd(value: number): string {
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function formatPct(value: number): string {
  const pct = value * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function FactorGauge({ label, score, maxLabel }: { label: string; score: number | null; maxLabel?: string }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono font-medium">{score != null ? score : "--"}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        {score != null && (
          <div className="h-full rounded-full bg-primary/70 transition-all" style={{ width: `${score}%` }} />
        )}
      </div>
      {maxLabel && <p className="text-[10px] text-muted-foreground">{maxLabel}</p>}
    </div>
  );
}

function HeroCard({ chain, chainId }: { chain: ChainSummary; chainId: string }) {
  const meta = CHAIN_META[chainId];
  return (
    <Card>
      <CardContent className="px-5 py-5">
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex items-center gap-3">
            {meta && <Image src={meta.logoPath} alt="" width={40} height={40} className="rounded-full" />}
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold">{chain.name}</h2>
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">{chain.type}</span>
              </div>
              {chain.healthScore != null && chain.healthBand && (
                <span className={cn("text-sm font-semibold", HEALTH_BAND_COLORS[chain.healthBand])}>
                  Health: {chain.healthScore} ({chain.healthBand})
                </span>
              )}
            </div>
          </div>
          <div className="ml-auto grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-5">
            <div><p className="text-xs text-muted-foreground">Supply</p><p className="font-bold">{formatUsd(chain.totalUsd)}</p></div>
            <div><p className="text-xs text-muted-foreground">Global Share</p><p className="font-bold">{(chain.dominanceShare * 100).toFixed(1)}%</p></div>
            <div><p className="text-xs text-muted-foreground">24h</p><p className={cn("font-mono", chain.change24hPct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>{formatPct(chain.change24hPct)}</p></div>
            <div><p className="text-xs text-muted-foreground">7d</p><p className={cn("font-mono", chain.change7dPct >= 0 ? "text-emerald-600" : "text-red-600")}>{formatPct(chain.change7dPct)}</p></div>
            <div><p className="text-xs text-muted-foreground">30d</p><p className={cn("font-mono", chain.change30dPct >= 0 ? "text-emerald-600" : "text-red-600")}>{formatPct(chain.change30dPct)}</p></div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function HealthBreakdownCard({ chain }: { chain: ChainSummary }) {
  const { healthFactors, healthScore, healthBand } = chain;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Chain Health Score</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {healthScore != null && healthBand ? (
          <div className="flex items-center gap-3">
            <div className={cn("flex h-14 w-14 items-center justify-center rounded-full text-xl font-bold", HEALTH_BAND_BG[healthBand], HEALTH_BAND_COLORS[healthBand])}>
              {healthScore}
            </div>
            <div>
              <p className={cn("font-semibold capitalize", HEALTH_BAND_COLORS[healthBand])}>{healthBand}</p>
              <p className="text-xs text-muted-foreground">Composite health score</p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Insufficient safety score coverage for a composite health score. Sub-factors shown below.</p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <FactorGauge label="Quality (35%)" score={healthFactors.quality} />
          <FactorGauge label="Concentration (25%)" score={healthFactors.concentration} />
          <FactorGauge label="Peg Stability (25%)" score={healthFactors.pegStability} />
          <FactorGauge label="Backing Diversity (15%)" score={healthFactors.backingDiversity} />
        </div>
      </CardContent>
    </Card>
  );
}

function CompositionSection({ chainId }: { chainId: string }) {
  const { coins, totalUsd } = useChainStablecoins(chainId);
  const top5 = coins.slice(0, 5);
  const rest = coins.slice(5);
  const restTotal = rest.reduce((s, c) => s + c.supplyOnChain, 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Stablecoin Composition</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Treemap-like blocks */}
          <div className="grid grid-cols-3 gap-1.5 auto-rows-fr" style={{ minHeight: "200px" }}>
            {top5.map((coin) => {
              const pct = totalUsd > 0 ? coin.supplyOnChain / totalUsd : 0;
              return (
                <Link
                  key={coin.id}
                  href={buildStablecoinUrl(coin.id)}
                  className="flex flex-col items-center justify-center rounded-lg border bg-muted/30 p-2 text-center text-xs hover:bg-muted/50 transition-colors"
                  style={{ gridColumn: pct > 0.4 ? "span 2" : undefined, gridRow: pct > 0.4 ? "span 2" : undefined }}
                >
                  <span className="font-semibold">{coin.symbol}</span>
                  <span className="text-muted-foreground">{(pct * 100).toFixed(1)}%</span>
                  <span className="font-mono text-[10px]">{formatUsd(coin.supplyOnChain)}</span>
                </Link>
              );
            })}
            {rest.length > 0 && (
              <div className="flex flex-col items-center justify-center rounded-lg border bg-muted/20 p-2 text-center text-xs">
                <span className="text-muted-foreground">{rest.length} others</span>
                <span className="font-mono text-[10px]">{formatUsd(restTotal)}</span>
              </div>
            )}
          </div>

          {/* Ranked breakdown */}
          <div className="space-y-2">
            {coins.slice(0, 10).map((coin, i) => (
              <div key={coin.id} className="flex items-center gap-2 text-sm">
                <span className="w-5 text-right text-xs text-muted-foreground">{i + 1}</span>
                <Link href={buildStablecoinUrl(coin.id)} className="flex-1 truncate font-medium hover:underline">
                  {coin.name} ({coin.symbol})
                </Link>
                <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary/60" style={{ width: `${coin.chainShare * 100}%` }} />
                </div>
                <span className="w-16 text-right font-mono text-xs">{formatUsd(coin.supplyOnChain)}</span>
                <span className="w-12 text-right font-mono text-xs text-muted-foreground">{(coin.chainShare * 100).toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function BackingBreakdown({ chainId }: { chainId: string }) {
  const { coins, totalUsd } = useChainStablecoins(chainId);

  const backingTotals = useMemo(() => {
    const totals: Record<string, number> = { "rwa-backed": 0, "crypto-backed": 0, algorithmic: 0 };
    for (const coin of coins) {
      const key = coin.backing ?? "rwa-backed";
      totals[key] = (totals[key] ?? 0) + coin.supplyOnChain;
    }
    return totals;
  }, [coins]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Supply by Backing Type</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex h-4 w-full overflow-hidden rounded-full">
          {Object.entries(backingTotals).map(([type, amount]) => {
            const pct = totalUsd > 0 ? (amount / totalUsd) * 100 : 0;
            if (pct <= 0) return null;
            return <div key={type} className={cn("h-full", BACKING_BAR_COLORS[type])} style={{ width: `${pct}%` }} />;
          })}
        </div>
        <div className="flex flex-wrap gap-4 text-xs">
          {Object.entries(backingTotals).map(([type, amount]) => {
            const pct = totalUsd > 0 ? (amount / totalUsd) * 100 : 0;
            if (pct <= 0) return null;
            return (
              <div key={type} className="flex items-center gap-1.5">
                <div className={cn("h-2.5 w-2.5 rounded-full", BACKING_BAR_COLORS[type])} />
                <span>{BACKING_LABELS_SHORT[type as keyof typeof BACKING_LABELS_SHORT] ?? type}</span>
                <span className="font-mono text-muted-foreground">{pct.toFixed(1)}%</span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function StablecoinTable({ chainId }: { chainId: string }) {
  const { coins } = useChainStablecoins(chainId);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">All Stablecoins</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs font-medium text-muted-foreground">
                <th className="px-3 py-2 w-10">#</th>
                <th className="px-3 py-2">Stablecoin</th>
                <th className="px-3 py-2 text-right">Supply on Chain</th>
                <th className="px-3 py-2 text-right">Chain Share</th>
                <th className="px-3 py-2 text-right">7d</th>
                <th className="px-3 py-2 text-right">30d</th>
              </tr>
            </thead>
            <tbody>
              {coins.map((coin, i) => (
                <tr key={coin.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="px-3 py-2.5 text-muted-foreground">{i + 1}</td>
                  <td className="px-3 py-2.5">
                    <Link href={buildStablecoinUrl(coin.id)} className="font-medium hover:underline">
                      {coin.name} <span className="text-muted-foreground">({coin.symbol})</span>
                    </Link>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono">{formatUsd(coin.supplyOnChain)}</td>
                  <td className="px-3 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-primary/60" style={{ width: `${Math.min(100, coin.chainShare * 100)}%` }} />
                      </div>
                      <span className="font-mono text-xs text-muted-foreground">{(coin.chainShare * 100).toFixed(1)}%</span>
                    </div>
                  </td>
                  <td className={cn("px-3 py-2.5 text-right font-mono", coin.change7dPct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
                    {formatPct(coin.change7dPct)}
                  </td>
                  <td className={cn("px-3 py-2.5 text-right font-mono", coin.change30dPct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
                    {formatPct(coin.change30dPct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

export function ChainProfileClient({ chainId }: { chainId: string }) {
  const { data, isLoading, isError } = useChains();

  const chain = useMemo(() => {
    if (!data?.chains) return null;
    return data.chains.find((c) => c.id === chainId) ?? null;
  }, [data, chainId]);

  if (isLoading) {
    return <div className="flex items-center justify-center py-20 text-muted-foreground">Loading chain data...</div>;
  }
  if (isError || !data) {
    return <div className="flex items-center justify-center py-20 text-destructive">Failed to load chain data.</div>;
  }
  if (!chain) {
    return <div className="flex items-center justify-center py-20 text-muted-foreground">No data available for this chain.</div>;
  }

  return (
    <div className="space-y-6">
      <HeroCard chain={chain} chainId={chainId} />
      <HealthBreakdownCard chain={chain} />
      <CompositionSection chainId={chainId} />
      <BackingBreakdown chainId={chainId} />
      <StablecoinTable chainId={chainId} />
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/app/chains/[chain]/page.tsx src/app/chains/[chain]/client.tsx
git commit -m "feat(chains): add /chains/[chain]/ profile page"
```

### Task 12: Contextual Chain Links from Stablecoin Detail

**Files:**
- Modify: `src/components/key-info-card.tsx`

- [ ] **Step 1: Read the file**

Read `src/components/key-info-card.tsx` to find the exact location where chain logos are rendered in the contract addresses section.

- [ ] **Step 2: Wrap chain names/logos with Links**

Find the `ContractChainButton` or equivalent component that renders chain logos in the contracts section. Wrap the chain logo + name with a `Link` to `/chains/${chainId}/`, while preserving the existing click-to-expand contract detail behavior.

The change should be minimal: add a small chain name link or icon that navigates to `/chains/[chain]/` alongside the existing contract display. The exact implementation depends on the current component structure.

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/components/key-info-card.tsx
git commit -m "feat(chains): add contextual chain links from stablecoin detail page"
```

---

## Chunk 5: Documentation, Lint, Tests, Final Verification

### Task 13: Documentation Updates

**Files:**
- Modify: `docs/architecture.md` (add chain analytics section)
- Modify: `docs/api-reference.md` (add `/api/chains`)
- Modify: `docs/supply-snapshot.md` (add `chain_supply_history`)
- Modify: `docs/worker-infrastructure.md` (add chains cron stage)
- Modify: `docs/data-flow-map.md` (add chain data flow)
- Modify: `docs/methodology-page.md` (add Chain Health Score section mapping)
- Modify: `src/app/about/` (update about page to mention chain analytics feature)
- Modify: `CLAUDE.md` (add `/chains/` and `/chains/[chain]/` to Directory Overview)

- [ ] **Step 1: Update docs/architecture.md**

Add chain analytics to the curated file tree and page listing. Add `/api/chains` to the API endpoints section.

- [ ] **Step 2: Update docs/api-reference.md**

Add the `GET /api/chains` endpoint with request/response documentation, matching the spec's `ChainsResponse` interface.

- [ ] **Step 3: Update docs/supply-snapshot.md**

Add `chain_supply_history` table schema and explain the daily snapshot cron stage.

- [ ] **Step 4: Update docs/worker-infrastructure.md**

Add `snapshot-chain-supply` as a new cron stage in the quarter-hourly slot documentation. Update the runtime job count from 25 to 26 and status-tracked job count from 24 to 25.

- [ ] **Step 5: Update docs/data-flow-map.md**

Add chain data flow: `DefiLlama chainCirculating → stablecoins cache → /api/chains handler → useChains hook → /chains/ page`.

- [ ] **Step 6: Update docs/methodology-page.md**

Add Chain Health Score section mapping (formula, sub-factors, bands).

- [ ] **Step 7: Update about page**

Add chain analytics to the about page's feature listing per `docs/about-page.md` update rules.

- [ ] **Step 8: Update CLAUDE.md Directory Overview**

Add `chains, chains/[chain]` to the `src/app/` line.

- [ ] **Step 9: Commit**

```bash
git add docs/ src/app/about/ CLAUDE.md
git commit -m "docs: add chain analytics documentation"
```

### Task 14: Final Build, Lint, and Test Pass

- [ ] **Step 1: Run lint**

Run: `npm run lint`
Expected: PASS (zero errors; warnings are acceptable)

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 3: Run full build + type-check**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Manual review**

Verify:
1. The chain health score tests produce results matching the calibration table from the spec (Arbitrum ~78, Ethereum ~74, etc.) when fed realistic supply distributions — these are integration-level validations, not strict unit test assertions, since live data varies.
2. The `/api/chains` endpoint returns well-formed JSON when the dev server is running.
3. The leaderboard page renders and sorts correctly.
4. The chain profile page renders hero, health breakdown, composition, backing bar, and stablecoin table.

- [ ] **Step 5: Final commit if any fixups needed**

```bash
git add -A
git commit -m "fix: address lint/test issues from chain analytics integration"
```
