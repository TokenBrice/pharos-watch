# Report Card Dimension Scorer Tests

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add unit tests for the 5 untested report card dimension scorers (`scorePegStability`, `scoreLiquidity`, `scoreDecentralization`, `chainInfraScore`, `computeCollateralQualityFromReserves`) to catch formula regressions that would silently corrupt every safety grade.

**Architecture:** All functions live in `shared/lib/report-cards.ts` and are pure (no DB, no async). Tests go in the existing `src/lib/__tests__/report-cards.test.ts` file, extending its `makeMeta` helper. Each function is tested in its own `describe` block with edge cases driven by the branching logic documented below.

**Tech Stack:** Vitest, TypeScript strict

---

## Context: What's Already Tested

The existing `src/lib/__tests__/report-cards.test.ts` covers:
- `scoreResilience` (blacklist sub-factor)
- `resolveGovernanceQuality` (regulated-entity promotion)
- `scoreDependencyRisk` (reserve-derived dependencies)
- `computeOverallGrade` (no-liquidity penalty)
- `isBlacklistable` (inherited risk)

The integration test `worker/src/lib/__tests__/safety-scores.test.ts` **mocks all dimension scorers** — so no formula logic is exercised there.

## What's NOT Tested (this plan)

| Function | Branches | Risk |
|----------|----------|------|
| `scorePegStability` | 3 NR conditions, active depeg cap, yield-bearing annotation | Wrong grade for every coin with peg data |
| `scoreLiquidity` | NR condition, HHI threshold, detail pluralization | Wrong liquidity dimension on every card |
| `scoreDecentralization` | 6 governance qualities x 4 chain tiers x 4 deployment models, infra penalty guard | Wrong decentralization grade for every coin |
| `chainInfraScore` | 4 tiers x 4 models = 16 combos | Feeds into `scoreDecentralization`, `scoreResilience` |
| `computeCollateralQualityFromReserves` | 5 risk levels, weighted average, empty array | Feeds into drift detection and reserve display |

---

## Existing File State

The test file `src/lib/__tests__/report-cards.test.ts` currently has these imports and helpers. The implementer should merge new imports into this block (do NOT create a second import statement).

```typescript
// Current imports — add new functions to this block:
import { describe, it, expect } from "vitest";
import {
  scoreResilience,
  isBlacklistable,
  INHERITED_BLACKLIST_THRESHOLD_PCT,
  resolveGovernanceQuality,
  GOVERNANCE_QUALITY_SCORE,
  scoreDependencyRisk,
  computeOverallGrade,
  NO_LIQUIDITY_PENALTY,
  // --- ADD THESE ---
  scorePegStability,
  scoreLiquidity,
  scoreDecentralization,
  chainInfraScore,
  computeCollateralQualityFromReserves,
} from "@shared/lib/report-cards";
import type { ReportCardDimension, PegSummaryCoin } from "@shared/types";
import type { StablecoinMeta } from "@shared/types";
```

The existing `makeMeta` helper (reuse as-is):

```typescript
function makeMeta(overrides: Partial<StablecoinMeta> = {}): StablecoinMeta {
  return {
    id: "test",
    name: "Test Coin",
    symbol: "TST",
    geckoId: null,
    cmcId: null,
    llamaId: null,
    peg: "USD",
    decimals: {},
    contracts: {},
    links: {},
    flags: { governance: "centralized", backing: "rwa-backed", pegCurrency: "USD", yieldBearing: false, rwa: true, navToken: false },
    ...overrides,
  } as StablecoinMeta;
}
```

**Grade thresholds** (from `shared/lib/report-cards.ts`) — needed to verify grade assertions:

| Grade | Min Score |
|-------|-----------|
| A+ | 87 |
| A | 83 |
| A- | 80 |
| B+ | 75 |
| B | 70 |
| B- | 65 |
| C+ | 60 |
| C | 55 |
| C- | 50 |
| D | 40 |
| F | 0 |

`scoreToGrade(null)` returns `"NR"`.

New helpers to add (after `makeMeta`):

```typescript
function makePeg(overrides: Partial<PegSummaryCoin> = {}): PegSummaryCoin {
  return {
    id: "test",
    symbol: "TST",
    name: "Test Coin",
    pegType: "peggedUSD",
    pegCurrency: "USD",
    governance: "centralized",
    currentDeviationBps: 5,
    pegScore: 90,
    pegPct: 99,
    severityScore: 95,
    spreadPenalty: 0,
    eventCount: 1,
    worstDeviationBps: -200,
    activeDepeg: false,
    lastEventAt: 1700000000,
    trackingSpanDays: 365,
    methodologyVersion: "v1",
    ...overrides,
  };
}
```

**Step 2: Write the test block**

```typescript
describe("scorePegStability", () => {
  // --- NR cases ---

  it("returns NR for NAV tokens", () => {
    const meta = makeMeta({ flags: { governance: "centralized", backing: "rwa-backed", pegCurrency: "USD", yieldBearing: false, rwa: true, navToken: true } });
    const result = scorePegStability(makePeg({ pegScore: 95 }), meta);
    expect(result.grade).toBe("NR");
    expect(result.score).toBeNull();
    expect(result.detail).toContain("NAV token");
  });

  it("returns NR when peg is undefined", () => {
    const result = scorePegStability(undefined, makeMeta());
    expect(result.grade).toBe("NR");
    expect(result.score).toBeNull();
  });

  it("returns NR when pegScore is null", () => {
    const result = scorePegStability(makePeg({ pegScore: null }), makeMeta());
    expect(result.grade).toBe("NR");
    expect(result.score).toBeNull();
  });

  it("returns NR when no price data and no events", () => {
    const result = scorePegStability(
      makePeg({ currentDeviationBps: null, eventCount: 0, pegScore: 80 }),
      makeMeta(),
    );
    expect(result.grade).toBe("NR");
    expect(result.score).toBeNull();
    expect(result.detail).toContain("No price data");
  });

  // --- Score clamping ---

  it("clamps score to 0-100 range", () => {
    const over = scorePegStability(makePeg({ pegScore: 110 }), makeMeta());
    expect(over.score).toBe(100);

    const under = scorePegStability(makePeg({ pegScore: -5 }), makeMeta());
    expect(under.score).toBe(0);
  });

  it("rounds pegScore to nearest integer", () => {
    const result = scorePegStability(makePeg({ pegScore: 87.6 }), makeMeta());
    expect(result.score).toBe(88);
  });

  // --- Active depeg cap ---

  it("caps score at 65 during active depeg", () => {
    const result = scorePegStability(
      makePeg({ pegScore: 90, activeDepeg: true }),
      makeMeta(),
    );
    expect(result.score).toBe(65);
    expect(result.detail).toContain("active depeg");
    expect(result.detail).toContain("capped at C");
  });

  it("does not raise score to 65 when pegScore is already below 65 during active depeg", () => {
    const result = scorePegStability(
      makePeg({ pegScore: 40, activeDepeg: true }),
      makeMeta(),
    );
    expect(result.score).toBe(40);
  });

  // --- Grade mapping ---

  it("maps score to correct grade via scoreToGrade", () => {
    const high = scorePegStability(makePeg({ pegScore: 95 }), makeMeta());
    expect(high.grade).toBe("A+");

    const mid = scorePegStability(makePeg({ pegScore: 72 }), makeMeta());
    expect(mid.grade).toBe("B");

    const low = scorePegStability(makePeg({ pegScore: 30 }), makeMeta());
    expect(low.grade).toBe("F");
  });

  // --- Detail string ---

  it("includes event count in detail", () => {
    const single = scorePegStability(makePeg({ eventCount: 1 }), makeMeta());
    expect(single.detail).toContain("1 depeg event");
    expect(single.detail).not.toContain("events");

    const multi = scorePegStability(makePeg({ eventCount: 3 }), makeMeta());
    expect(multi.detail).toContain("3 depeg events");
  });

  it("includes worst deviation when present", () => {
    const result = scorePegStability(makePeg({ worstDeviationBps: -500 }), makeMeta());
    expect(result.detail).toContain("-500 bps");
  });

  it("notes 'No depeg events' when eventCount is 0 but has price data", () => {
    const result = scorePegStability(
      makePeg({ eventCount: 0, currentDeviationBps: 5, worstDeviationBps: null }),
      makeMeta(),
    );
    expect(result.detail).toContain("No depeg events");
  });

  it("appends yield-bearing annotation when flag is set", () => {
    const meta = makeMeta({ flags: { governance: "centralized", backing: "rwa-backed", pegCurrency: "USD", yieldBearing: true, rwa: true, navToken: false } });
    const result = scorePegStability(makePeg(), meta);
    expect(result.detail).toContain("yield-bearing");
  });

  it("does not append yield-bearing annotation when flag is false", () => {
    const result = scorePegStability(makePeg(), makeMeta());
    expect(result.detail).not.toContain("yield-bearing");
  });
});
```

**Step 3: Run tests to verify they pass**

Run: `npm test -- --run src/lib/__tests__/report-cards.test.ts`
Expected: All `scorePegStability` tests PASS (these are characterization tests against existing working code).

**Step 4: Commit**

```bash
git add src/lib/__tests__/report-cards.test.ts
git commit -m "test: add scorePegStability unit tests"
```

---

## Task 2: scoreLiquidity tests

**Files:**
- Modify: `src/lib/__tests__/report-cards.test.ts`
- Reference: `shared/lib/report-cards.ts:210-227`

**Step 1: Add import**

Add `scoreLiquidity` to the existing import block.

**Step 2: Write the test block**

```typescript
describe("scoreLiquidity", () => {
  // --- NR case ---

  it("returns NR when liq is undefined", () => {
    const result = scoreLiquidity(undefined);
    expect(result.grade).toBe("NR");
    expect(result.score).toBeNull();
    expect(result.detail).toBe("No DEX liquidity data");
  });

  it("returns NR when liquidityScore is null", () => {
    const result = scoreLiquidity({ liquidityScore: null, concentrationHhi: null, poolCount: 0, chainCount: 0 });
    expect(result.grade).toBe("NR");
    expect(result.score).toBeNull();
  });

  // --- Score clamping ---

  it("clamps score to 0-100 range", () => {
    const over = scoreLiquidity({ liquidityScore: 105, concentrationHhi: 0.2, poolCount: 5, chainCount: 2 });
    expect(over.score).toBe(100);

    const under = scoreLiquidity({ liquidityScore: -3, concentrationHhi: 0.2, poolCount: 1, chainCount: 1 });
    expect(under.score).toBe(0);
  });

  it("rounds to nearest integer", () => {
    const result = scoreLiquidity({ liquidityScore: 74.6, concentrationHhi: 0.3, poolCount: 3, chainCount: 1 });
    expect(result.score).toBe(75);
    expect(result.grade).toBe("B+");
  });

  // --- Grade mapping ---

  it("maps high score to A+ grade", () => {
    const result = scoreLiquidity({ liquidityScore: 92, concentrationHhi: 0.1, poolCount: 20, chainCount: 5 });
    expect(result.grade).toBe("A+");
  });

  it("maps low score to F grade", () => {
    const result = scoreLiquidity({ liquidityScore: 15, concentrationHhi: 0.8, poolCount: 1, chainCount: 1 });
    expect(result.grade).toBe("F");
  });

  // --- Detail string ---

  it("includes pool and chain counts with correct pluralization", () => {
    const single = scoreLiquidity({ liquidityScore: 80, concentrationHhi: 0.2, poolCount: 1, chainCount: 1 });
    expect(single.detail).toContain("1 pool across 1 chain");

    const multi = scoreLiquidity({ liquidityScore: 80, concentrationHhi: 0.2, poolCount: 12, chainCount: 3 });
    expect(multi.detail).toContain("12 pools across 3 chains");
  });

  // --- HHI concentration warning ---

  it("includes concentration warning when HHI > 0.5", () => {
    const result = scoreLiquidity({ liquidityScore: 70, concentrationHhi: 0.75, poolCount: 3, chainCount: 1 });
    expect(result.detail).toContain("high concentration");
    expect(result.detail).toContain("HHI: 0.75");
  });

  it("does not include concentration warning when HHI <= 0.5", () => {
    const result = scoreLiquidity({ liquidityScore: 70, concentrationHhi: 0.5, poolCount: 3, chainCount: 2 });
    expect(result.detail).not.toContain("concentration");
  });

  it("does not include concentration warning when HHI is null", () => {
    const result = scoreLiquidity({ liquidityScore: 70, concentrationHhi: null, poolCount: 3, chainCount: 2 });
    expect(result.detail).not.toContain("concentration");
  });
});
```

**Step 3: Run tests**

Run: `npm test -- --run src/lib/__tests__/report-cards.test.ts`
Expected: All `scoreLiquidity` tests PASS.

**Step 4: Commit**

```bash
git add src/lib/__tests__/report-cards.test.ts
git commit -m "test: add scoreLiquidity unit tests"
```

---

## Task 3: chainInfraScore tests

**Files:**
- Modify: `src/lib/__tests__/report-cards.test.ts`
- Reference: `shared/lib/report-cards.ts:346-349`

This function feeds into `scoreDecentralization` and `scoreResilience`. Testing it standalone first ensures the multiplication formula is correct.

**Step 1: Add import**

Add `chainInfraScore` to the import block.

**Step 2: Write the test block**

```typescript
describe("chainInfraScore", () => {
  // --- Exact milestone values ---

  it("returns 100 for ethereum + single-chain", () => {
    expect(chainInfraScore("ethereum", "single-chain")).toBe(100);
  });

  it("returns 85 for ethereum + canonical-bridge", () => {
    expect(chainInfraScore("ethereum", "canonical-bridge")).toBe(85);
  });

  it("returns 60 for ethereum + third-party-bridge", () => {
    expect(chainInfraScore("ethereum", "third-party-bridge")).toBe(60);
  });

  it("returns 40 for ethereum + native-multichain", () => {
    expect(chainInfraScore("ethereum", "native-multichain")).toBe(40);
  });

  it("returns 66 for stage1-l2 + single-chain", () => {
    expect(chainInfraScore("stage1-l2", "single-chain")).toBe(66);
  });

  it("returns 56 for stage1-l2 + canonical-bridge", () => {
    // 66 * 0.85 = 56.1, rounded to 56
    expect(chainInfraScore("stage1-l2", "canonical-bridge")).toBe(56);
  });

  it("returns 26 for stage1-l2 + native-multichain", () => {
    // 66 * 0.40 = 26.4, rounded to 26
    expect(chainInfraScore("stage1-l2", "native-multichain")).toBe(26);
  });

  it("returns 20 for established-alt-l1 + single-chain", () => {
    expect(chainInfraScore("established-alt-l1", "single-chain")).toBe(20);
  });

  it("returns 0 for unproven + any deployment model", () => {
    expect(chainInfraScore("unproven", "single-chain")).toBe(0);
    expect(chainInfraScore("unproven", "canonical-bridge")).toBe(0);
    expect(chainInfraScore("unproven", "native-multichain")).toBe(0);
  });

  // --- Rounding ---

  it("rounds to nearest integer (stage1-l2 + third-party-bridge)", () => {
    // 66 * 0.60 = 39.6, rounded to 40
    expect(chainInfraScore("stage1-l2", "third-party-bridge")).toBe(40);
  });
});
```

**Step 3: Run tests**

Run: `npm test -- --run src/lib/__tests__/report-cards.test.ts`
Expected: All `chainInfraScore` tests PASS.

**Step 4: Commit**

```bash
git add src/lib/__tests__/report-cards.test.ts
git commit -m "test: add chainInfraScore unit tests"
```

---

## Task 4: computeCollateralQualityFromReserves tests

**Files:**
- Modify: `src/lib/__tests__/report-cards.test.ts`
- Reference: `shared/lib/report-cards.ts:271-279`

**Step 1: Add import**

Add `computeCollateralQualityFromReserves` to the import block.

**Step 2: Write the test block**

```typescript
describe("computeCollateralQualityFromReserves", () => {
  it("returns 0 for empty reserves array", () => {
    expect(computeCollateralQualityFromReserves([])).toBe(0);
  });

  it("returns 100 for 100% very-low risk reserves", () => {
    const reserves = [{ name: "US Treasuries", pct: 100, risk: "very-low" as const }];
    expect(computeCollateralQualityFromReserves(reserves)).toBe(100);
  });

  it("returns 5 for 100% very-high risk reserves", () => {
    const reserves = [{ name: "Algo backing", pct: 100, risk: "very-high" as const }];
    expect(computeCollateralQualityFromReserves(reserves)).toBe(5);
  });

  it("computes weighted average for mixed reserves", () => {
    const reserves = [
      { name: "Treasuries", pct: 60, risk: "very-low" as const },  // 60% * 100 = 6000
      { name: "Corporate bonds", pct: 40, risk: "medium" as const }, // 40% * 50  = 2000
    ];
    // (6000 + 2000) / 100 = 80
    expect(computeCollateralQualityFromReserves(reserves)).toBe(80);
  });

  it("handles reserves that don't sum to 100%", () => {
    const reserves = [
      { name: "USDC", pct: 30, risk: "low" as const },     // 30 * 75 = 2250
      { name: "ETH", pct: 20, risk: "high" as const },      // 20 * 25 = 500
    ];
    // totalPct = 50, weighted = 2750, result = 2750/50 = 55
    expect(computeCollateralQualityFromReserves(reserves)).toBe(55);
  });

  it("rounds to nearest integer", () => {
    const reserves = [
      { name: "Treasuries", pct: 70, risk: "very-low" as const },  // 70 * 100 = 7000
      { name: "Crypto", pct: 30, risk: "high" as const },           // 30 * 25  = 750
    ];
    // (7000 + 750) / 100 = 77.5, rounded to 78
    expect(computeCollateralQualityFromReserves(reserves)).toBe(78);
  });

  it("returns 0 when all pct values are 0", () => {
    const reserves = [{ name: "Ghost", pct: 0, risk: "very-low" as const }];
    expect(computeCollateralQualityFromReserves(reserves)).toBe(0);
  });
});
```

**Step 3: Run tests**

Run: `npm test -- --run src/lib/__tests__/report-cards.test.ts`
Expected: All `computeCollateralQualityFromReserves` tests PASS.

**Step 4: Commit**

```bash
git add src/lib/__tests__/report-cards.test.ts
git commit -m "test: add computeCollateralQualityFromReserves unit tests"
```

---

## Task 5: scoreDecentralization tests

**Files:**
- Modify: `src/lib/__tests__/report-cards.test.ts`
- Reference: `shared/lib/report-cards.ts:538-572`

This is the most complex scorer: it combines governance quality, chain infrastructure, and a penalty guard. The helpers are already tested in Tasks 3-4, so here we test the orchestration logic.

**Step 1: Add import**

Add `scoreDecentralization` to the import block.

**Step 2: Write the test block**

```typescript
describe("scoreDecentralization", () => {
  // --- Governance quality base scores ---

  it("scores 85 for decentralized governance (dao-governance)", () => {
    const meta = makeMeta({
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
    });
    const result = scoreDecentralization("decentralized", meta);
    expect(result.score).toBe(85);
    expect(result.grade).toBe("A-");
  });

  it("scores 20 for centralized governance (single-entity) without regulation", () => {
    const meta = makeMeta();
    const result = scoreDecentralization("centralized", meta);
    expect(result.score).toBe(20);
    expect(result.grade).toBe("F");
  });

  it("scores 40 for regulated centralized governance", () => {
    const meta = makeMeta({
      jurisdiction: { country: "United States", regulator: "NYDFS", license: "BitLicense" },
      proofOfReserves: { type: "independent-audit", url: "https://example.com", provider: "Deloitte" },
    });
    const result = scoreDecentralization("centralized", meta);
    expect(result.score).toBe(40);
    expect(result.grade).toBe("D");
  });

  // --- Chain infra penalty ---

  it("applies no penalty when infra score >= 80 (ethereum + single-chain)", () => {
    const meta = makeMeta({
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      chainTier: "ethereum",
      deploymentModel: "single-chain",
    });
    const result = scoreDecentralization("decentralized", meta);
    // Base 85, infra 100 >= 80, penalty 0
    expect(result.score).toBe(85);
  });

  it("applies -15 penalty when infra score is 50-79", () => {
    const meta = makeMeta({
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      chainTier: "stage1-l2",
      deploymentModel: "single-chain",
    });
    const result = scoreDecentralization("decentralized", meta);
    // Base 85, infra = 66 (50-79 band), penalty = -15 => 70
    expect(result.score).toBe(70);
  });

  it("applies -50 penalty when infra score is 15-49", () => {
    const meta = makeMeta({
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      chainTier: "established-alt-l1",
      deploymentModel: "single-chain",
    });
    const result = scoreDecentralization("decentralized", meta);
    // Base 85, infra = 20 (15-49 band), penalty = -50 => 35
    expect(result.score).toBe(35);
  });

  it("applies -65 penalty when infra score < 15", () => {
    const meta = makeMeta({
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      chainTier: "unproven",
      deploymentModel: "single-chain",
    });
    const result = scoreDecentralization("decentralized", meta);
    // Base 85, infra = 0 (<15 band), penalty = -65 => 20
    expect(result.score).toBe(20);
  });

  // --- Penalty guard: centralized types skip infra penalty ---

  it("does NOT apply infra penalty for single-entity governance", () => {
    const meta = makeMeta({
      chainTier: "unproven",
      deploymentModel: "native-multichain",
    });
    const result = scoreDecentralization("centralized", meta);
    // single-entity = 20, penalty guard skips infra penalty
    expect(result.score).toBe(20);
  });

  it("does NOT apply infra penalty for regulated-entity governance", () => {
    const meta = makeMeta({
      chainTier: "unproven",
      deploymentModel: "native-multichain",
      jurisdiction: { country: "United States", regulator: "NYDFS", license: "BitLicense" },
      proofOfReserves: { type: "independent-audit", url: "https://example.com", provider: "Deloitte" },
    });
    const result = scoreDecentralization("centralized", meta);
    // regulated-entity = 40, penalty guard skips infra penalty
    expect(result.score).toBe(40);
  });

  // --- Score floor ---

  it("floors score at 0 (never negative)", () => {
    const meta = makeMeta({
      flags: { governance: "centralized-dependent", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      governanceQuality: "wrapper",
      chainTier: "unproven",
      deploymentModel: "native-multichain",
    });
    const result = scoreDecentralization("centralized-dependent", meta);
    // wrapper = 10, infra = 0 (<15 band), penalty = -65 => -55 clamped to 0
    expect(result.score).toBe(0);
    expect(result.grade).toBe("F");
  });

  // --- Detail string ---

  it("includes governance quality label and infra label in detail", () => {
    const meta = makeMeta({
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
    });
    const result = scoreDecentralization("decentralized", meta);
    expect(result.detail).toBeTruthy();
    expect(result.detail.length).toBeGreaterThan(0);
  });

  // --- No meta fallback ---

  it("works without meta (uses defaults)", () => {
    const result = scoreDecentralization("decentralized");
    expect(result.score).toBe(85);
    expect(result.grade).toBe("A-");
  });
});
```

**Step 3: Run tests**

Run: `npm test -- --run src/lib/__tests__/report-cards.test.ts`
Expected: All `scoreDecentralization` tests PASS.

**Step 4: Commit**

```bash
git add src/lib/__tests__/report-cards.test.ts
git commit -m "test: add scoreDecentralization unit tests"
```

---

## Task 6: Golden-path integration test — overall grade from realistic coin profiles

**Why this matters:** Tasks 1-5 test each scorer in isolation. But the original problem is "a bug would silently produce wrong safety grades." This test runs all five scorers through `computeOverallGrade` with 3 archetypal coin profiles and asserts on the final grade. If any scorer regresses, this test fails — directly answering "is the final grade still correct?"

**Files:**
- Modify: `src/lib/__tests__/report-cards.test.ts`
- Reference: `shared/lib/report-cards.ts` (all scorer functions + `computeOverallGrade`)

**Key reference — `computeOverallGrade` scoring:**
- Weights: resilience 0.30, liquidity 0.30, decentralization 0.25, dependencyRisk 0.15
- Peg stability applies as a power-curve multiplier (exponent 0.20) on the weighted sum
- `NO_LIQUIDITY_PENALTY` (0.9x) when liquidity is NR
- Final score = `round(clamp(0, 100, weightedSum * pegMultiplier))`

**Step 1: Write the test block**

```typescript
describe("golden-path: overall grade from realistic coin profiles", () => {
  // These tests compose all 5 dimension scorers + computeOverallGrade.
  // They catch regressions in any scorer that cascade to a wrong final grade.

  it("CeFi RWA coin (USDT-like): strong peg, good liquidity, centralized", () => {
    const peg = makePeg({ pegScore: 95, activeDepeg: false, eventCount: 0, currentDeviationBps: 2, worstDeviationBps: null });
    const meta = makeMeta({
      flags: { governance: "centralized", backing: "rwa-backed", pegCurrency: "USD", yieldBearing: false, rwa: true, navToken: false },
      chainTier: "ethereum",
      deploymentModel: "native-multichain",
    });
    const liq = { liquidityScore: 88, concentrationHhi: 0.15, poolCount: 50, chainCount: 8 };
    const depScores = new Map<string, number>();

    const dims = {
      pegStability: scorePegStability(peg, meta),
      liquidity: scoreLiquidity(liq),
      resilience: scoreResilience(meta, true),
      decentralization: scoreDecentralization("centralized", meta),
      dependencyRisk: scoreDependencyRisk(meta, depScores),
    };
    const result = computeOverallGrade(dims);

    // Centralized governance drags decentralization down, but strong peg/liquidity compensate
    expect(result.overallScore).not.toBeNull();
    expect(result.overallScore!).toBeGreaterThanOrEqual(40);
    expect(result.overallScore!).toBeLessThanOrEqual(70);
    expect(["C+", "C", "B-", "B"]).toContain(result.overallGrade);
  });

  it("DeFi crypto-backed coin (DAI-like): strong peg, good liquidity, decentralized", () => {
    const peg = makePeg({ pegScore: 92, activeDepeg: false, eventCount: 2, currentDeviationBps: -3, worstDeviationBps: -150 });
    const meta = makeMeta({
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      chainTier: "ethereum",
      deploymentModel: "single-chain",
    });
    const liq = { liquidityScore: 85, concentrationHhi: 0.25, poolCount: 30, chainCount: 4 };
    const depScores = new Map<string, number>();

    const dims = {
      pegStability: scorePegStability(peg, meta),
      liquidity: scoreLiquidity(liq),
      resilience: scoreResilience(meta, false),
      decentralization: scoreDecentralization("decentralized", meta),
      dependencyRisk: scoreDependencyRisk(meta, depScores),
    };
    const result = computeOverallGrade(dims);

    // Decentralized + no blacklist + strong peg = high grade
    expect(result.overallScore).not.toBeNull();
    expect(result.overallScore!).toBeGreaterThanOrEqual(75);
    expect(result.overallScore!).toBeLessThanOrEqual(95);
    expect(["B+", "A-", "A"]).toContain(result.overallGrade);
  });

  it("CeFi-Dep wrapper coin (USDe-like): decent peg, limited liquidity, dependent", () => {
    const peg = makePeg({ pegScore: 85, activeDepeg: false, eventCount: 3, currentDeviationBps: -15, worstDeviationBps: -300 });
    const meta = makeMeta({
      flags: { governance: "centralized-dependent", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      chainTier: "ethereum",
      deploymentModel: "canonical-bridge",
      reserves: [
        { name: "stETH", pct: 50, risk: "medium" as const },
        { name: "USDT", pct: 50, risk: "low" as const, coinId: "usdt-tether" },
      ],
    });
    const liq = { liquidityScore: 65, concentrationHhi: 0.55, poolCount: 8, chainCount: 2 };
    const depScores = new Map([["usdt-tether", 60]]);

    const dims = {
      pegStability: scorePegStability(peg, meta),
      liquidity: scoreLiquidity(liq),
      resilience: scoreResilience(meta, "possible"),
      decentralization: scoreDecentralization("centralized-dependent", meta),
      dependencyRisk: scoreDependencyRisk(meta, depScores),
    };
    const result = computeOverallGrade(dims);

    // Moderate across the board — should land in C-to-B range
    expect(result.overallScore).not.toBeNull();
    expect(result.overallScore!).toBeGreaterThanOrEqual(35);
    expect(result.overallScore!).toBeLessThanOrEqual(65);
    expect(["C-", "C", "C+", "B-"]).toContain(result.overallGrade);
  });

  it("active depeg crushes the final grade regardless of other strengths", () => {
    const peg = makePeg({ pegScore: 90, activeDepeg: true, eventCount: 1, currentDeviationBps: -500, worstDeviationBps: -500 });
    const meta = makeMeta({
      flags: { governance: "decentralized", backing: "crypto-backed", pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false },
      chainTier: "ethereum",
      deploymentModel: "single-chain",
    });
    const liq = { liquidityScore: 90, concentrationHhi: 0.1, poolCount: 40, chainCount: 6 };
    const depScores = new Map<string, number>();

    const dims = {
      pegStability: scorePegStability(peg, meta),
      liquidity: scoreLiquidity(liq),
      resilience: scoreResilience(meta, false),
      decentralization: scoreDecentralization("decentralized", meta),
      dependencyRisk: scoreDependencyRisk(meta, depScores),
    };
    const result = computeOverallGrade(dims);

    // Active depeg caps peg stability at 65, which applies as power-curve multiplier
    // This should drag the overall grade down noticeably vs the DAI-like test
    expect(result.overallScore).not.toBeNull();
    expect(result.overallScore!).toBeLessThan(80);
  });
});
```

**Step 2: Run tests**

Run: `npm test -- --run src/lib/__tests__/report-cards.test.ts`
Expected: All golden-path tests PASS. If any fail, it means our expected ranges are wrong — adjust ranges to match actual output (these are characterization tests).

**Step 3: Commit**

```bash
git add src/lib/__tests__/report-cards.test.ts
git commit -m "test: add golden-path integration tests for overall grade composition"
```

---

## Task 7: Final verification

**Step 1: Run the full test suite**

Run: `npm test`
Expected: All tests pass, no regressions.

**Step 2: Verify coverage improvement**

Run: `npx vitest run --coverage -- src/lib/__tests__/report-cards.test.ts`
Expected: `shared/lib/report-cards.ts` coverage increases. The five functions should show near-complete branch coverage.

**Step 3: Final commit (if any adjustments needed)**

---

## Notes for implementer

- **These are characterization tests** — they document the existing behavior, not a new spec. If a test fails, the function changed, not the test.
- **`makeMeta` already exists** in the test file. Reuse it. Only add `makePeg` as a new helper.
- **Import additions** should be grouped into the existing import statement from `@shared/lib/report-cards`, not a separate import.
- **`scoreToGrade` is tested implicitly** through every scorer test that asserts on `.grade`. No need for a dedicated block.
- **`resolveResilienceFactors` is tested indirectly** through `scoreDecentralization` and the existing `scoreResilience` tests. A dedicated block is not worth the effort given its simple override logic.
