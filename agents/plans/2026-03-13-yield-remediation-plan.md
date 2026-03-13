# Yield Intelligence Remediation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate all redundancies, hardcoded magic numbers, data validation gaps, dead code, inconsistent formatting, and missing test coverage identified in the yield intelligence audit.

**Architecture:** Extract shared frontend utilities from duplicated sites into `src/lib/yield-constants.ts`. Consolidate worker-side magic numbers into named constants. Refactor `fetch-tbill-rate.ts` fallback paths into a single helper. Add targeted tests for untested code paths. Remove dead code from `yield-sync/types.ts`. Guard `computeMedian` against NaN/Infinity.

**Tech Stack:** TypeScript, Vitest, React (frontend components), Cloudflare Workers (cron/API)

**TDD note:** Tasks 1-3 and 7-8 are pure refactorings with no behavior change — existing tests provide regression coverage. Tasks 4-6 follow TDD where applicable (test first, then implement). Tasks 9-12 are test-only tasks that increase coverage. Task 5b introduces a defensive guard following TDD.

**Deferred:** The audit identified that `handleYieldRankings` calls `buildReportCardsSnapshot(db)` on every cache-miss request. This is a performance concern but is mitigated by CDN caching (`s-maxage=300`). Optimizing this (e.g., a secondary cache layer for hydrated rankings) is deferred to a future iteration as it requires API-layer design changes beyond the scope of this remediation.

---

## Chunk 1: Shared Frontend Utilities & Consistency

### Task 1: Extract `getPysColor` and PYS breakdown to shared yield-constants

**Files:**
- Modify: `src/lib/yield-constants.ts`
- Modify: `src/components/yield-leaderboard.tsx:57-62,238-240`
- Modify: `src/components/yield-detail-section.tsx:46-51,203-205`

- [ ] **Step 1: Add `getPysColor` and `computePysBreakdown` to yield-constants.ts**

In `src/lib/yield-constants.ts`, append after the existing `formatYieldWarningSignal` function:

```typescript
/** Static PYS color classes (Tailwind purge-safe). */
export function getPysColor(pys: number | null): string {
  if (pys === null) return "text-muted-foreground";
  if (pys > 40) return "text-emerald-700 dark:text-emerald-400";
  if (pys > 20) return "text-amber-700 dark:text-amber-400";
  return "text-red-700 dark:text-red-400";
}

/**
 * Compute PYS breakdown components for display (tooltips, stat cards).
 * This mirrors the intermediate values from the worker's `computePYS()` in yield-helpers.ts.
 * The final PYS score is served by the API — this is for breakdown UI only.
 */
export function computePysBreakdown(
  apy30d: number,
  safetyScore: number | null,
  yieldStability: number | null,
) {
  const effectiveSafety = safetyScore ?? 40;
  const riskPenalty = Math.max(0.5, (101 - effectiveSafety) / 20);
  const yieldEfficiency = apy30d / riskPenalty;
  const sustainabilityMult = Math.max(0.3, yieldStability ?? 1.0);
  return { riskPenalty, yieldEfficiency, sustainabilityMult };
}
```

- [ ] **Step 2: Update yield-leaderboard.tsx to use shared utilities**

In `src/components/yield-leaderboard.tsx`:

1. Remove the local `getPysColor` function (lines 56-62)
2. Update the import from `@/lib/yield-constants` on line 22:
   ```typescript
   // Before:
   import { WARNING_SIGNAL_LABELS } from "@/lib/yield-constants";
   // After:
   import { WARNING_SIGNAL_LABELS, formatYieldWarningSignal, getPysColor, computePysBreakdown } from "@/lib/yield-constants";
   ```
3. Replace lines 238-240 (inside the `.map` callback):
   ```typescript
   // Before:
   const riskPenalty = Math.max(0.5, (101 - (safetyScore ?? 40)) / 20);
   const yieldEfficiency = row.apy30d / riskPenalty;
   const sustainabilityMult = Math.max(0.3, row.yieldStability ?? 1.0);
   // After:
   const { riskPenalty, yieldEfficiency, sustainabilityMult } = computePysBreakdown(row.apy30d, safetyScore, row.yieldStability);
   ```

- [ ] **Step 3: Update yield-detail-section.tsx to use shared utilities**

In `src/components/yield-detail-section.tsx`:

1. Remove the local `getPysColor` function (lines 46-51)
2. Update the import from `@/lib/yield-constants` on line 12:
   ```typescript
   // Before:
   import { WARNING_SIGNAL_LABELS, formatYieldWarningSignal } from "@/lib/yield-constants";
   // After:
   import { WARNING_SIGNAL_LABELS, formatYieldWarningSignal, getPysColor, computePysBreakdown } from "@/lib/yield-constants";
   ```
3. Replace lines 203-205:
   ```typescript
   // Before:
   const riskPenalty = Math.max(0.5, (101 - (ranking.safetyScore ?? 40)) / 20);
   const yieldEfficiency = ranking.apy30d / riskPenalty;
   const sustainabilityMult = Math.max(0.3, ranking.yieldStability ?? 1.0);
   // After:
   const { riskPenalty, yieldEfficiency, sustainabilityMult } = computePysBreakdown(ranking.apy30d, ranking.safetyScore, ranking.yieldStability);
   ```

- [ ] **Step 4: Build to verify no regressions**

Run: `npm run build`
Expected: Clean build, no type errors

- [ ] **Step 5: Commit**

```bash
git add src/lib/yield-constants.ts src/components/yield-leaderboard.tsx src/components/yield-detail-section.tsx
git commit -m "refactor(yield): extract getPysColor and computePysBreakdown to shared yield-constants"
```

---

### Task 2: Standardize warning signal fallback formatting

**Files:**
- Modify: `src/components/yield-leaderboard.tsx:405`
- Modify: `src/components/yield-detail-section.tsx:238,250`

- [ ] **Step 1: Fix the leaderboard warning signal fallback**

In `src/components/yield-leaderboard.tsx`, line 405 (inside the signals tooltip), change:

```typescript
// Before:
<li key={signal}>{WARNING_SIGNAL_LABELS[signal] ?? signal}</li>
// After:
<li key={signal}>{formatYieldWarningSignal(signal)}</li>
```

`formatYieldWarningSignal` is already imported (added in Task 1 step 2). It returns the label from `WARNING_SIGNAL_LABELS` or falls back to a hyphen-to-space conversion, consistent with the detail section and history chart.

After this change, `WARNING_SIGNAL_LABELS` is no longer directly used in the leaderboard. Remove it from the import on line 22 to avoid a lint warning:
```typescript
// Before:
import { WARNING_SIGNAL_LABELS, formatYieldWarningSignal, getPysColor, computePysBreakdown } from "@/lib/yield-constants";
// After:
import { formatYieldWarningSignal, getPysColor, computePysBreakdown } from "@/lib/yield-constants";
```

- [ ] **Step 2: Simplify redundant fallback in yield-detail-section.tsx**

In `src/components/yield-detail-section.tsx`, lines 238 and 250 have a redundant double-lookup pattern (`WARNING_SIGNAL_LABELS[signal] ?? formatYieldWarningSignal(signal)`). Since `formatYieldWarningSignal` already checks `WARNING_SIGNAL_LABELS` first, simplify both:

Line 238 (single warning display):
```typescript
// Before:
<span>{WARNING_SIGNAL_LABELS[singleWarning] ?? formatYieldWarningSignal(singleWarning)}</span>
// After:
<span>{formatYieldWarningSignal(singleWarning)}</span>
```

Line 250 (multiple warnings list):
```typescript
// Before:
<li key={signal}>{WARNING_SIGNAL_LABELS[signal] ?? formatYieldWarningSignal(signal)}</li>
// After:
<li key={signal}>{formatYieldWarningSignal(signal)}</li>
```

After these changes, the detail section no longer directly uses `WARNING_SIGNAL_LABELS`. Remove it from the import on line 12 (keeping only `formatYieldWarningSignal`, `getPysColor`, `computePysBreakdown`).

- [ ] **Step 3: Build to verify**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
git add src/components/yield-leaderboard.tsx src/components/yield-detail-section.tsx
git commit -m "fix(yield): standardize warning signal fallback to formatYieldWarningSignal"
```

---

### Task 3: Standardize APY formatting across frontend

**Files:**
- Modify: `src/components/yield-detail-section.tsx:15,259-260`
- Modify: `src/app/yield/client.tsx:161,169,210`

- [ ] **Step 1: Fix yield-detail-section.tsx APY formatting**

In `src/components/yield-detail-section.tsx`, add `formatApy` to the existing import on line 15:
```typescript
// Before:
import { formatCurrency } from "@shared/lib/format";
// After:
import { formatCurrency, formatApy } from "@shared/lib/format";
```

Then replace lines 259-260:
```typescript
// Before:
<DetailStatCard label="Current APY" value={`${ranking.currentApy.toFixed(2)}%`} />
<DetailStatCard label="30d APY" value={`${ranking.apy30d.toFixed(2)}%`} />
// After:
<DetailStatCard label="Current APY" value={formatApy(ranking.currentApy)} />
<DetailStatCard label="30d APY" value={formatApy(ranking.apy30d)} />
```

- [ ] **Step 2: Fix yield client.tsx APY formatting**

In `src/app/yield/client.tsx`, add the import:
```typescript
import { formatApy } from "@shared/lib/format";
```

Replace line 161 (Average Yield stat card):
```typescript
// Before:
<span className="text-2xl font-bold font-mono tabular-nums">{stats.avgApy.toFixed(2)}%</span>
// After:
<span className="text-2xl font-bold font-mono tabular-nums">{formatApy(stats.avgApy)}</span>
```

Replace line 169 (Risk-Free Rate stat card):
```typescript
// Before:
<span className="text-2xl font-bold font-mono tabular-nums">{stats.riskFreeRate.toFixed(2)}%</span>
// After:
<span className="text-2xl font-bold font-mono tabular-nums">{formatApy(stats.riskFreeRate)}</span>
```

Replace line 210 (prose sentence inside scatter annotation card):
```typescript
// Before:
Yields under {data.riskFreeRate.toFixed(2)}% are failing the basic hurdle rate.
// After:
Yields under {formatApy(data.riskFreeRate)} are failing the basic hurdle rate.
```

Note: `formatApy` returns a string like `"4.25%"` (includes the `%` sign), so remove the trailing `%` from the template literal.

- [ ] **Step 3: Build to verify**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
git add src/components/yield-detail-section.tsx src/app/yield/client.tsx
git commit -m "refactor(yield): use formatApy consistently across frontend yield surfaces"
```

---

## Chunk 2: Worker Hardening — Constants, Validation & Refactor

### Task 4: Name magic-number thresholds in yield-helpers.ts

**Files:**
- Modify: `worker/src/cron/yield-helpers.ts:26,28,60-66`

- [ ] **Step 1: Add named constants to yield-helpers.ts**

At the top of `worker/src/cron/yield-helpers.ts`, after the existing `STALE_THRESHOLD_MS` constant (line 4), add:

```typescript
// --- PYS formula constants ---
const PYS_RISK_PENALTY_FLOOR = 0.5;
const PYS_SUSTAINABILITY_FLOOR = 0.3;

// --- Warning signal thresholds ---
const YIELD_SPIKE_THRESHOLD = 2.0;
const YIELD_DIVERGENCE_THRESHOLD = 3.0;
const NEGATIVE_TREND_THRESHOLD = 0.7;
const REWARD_HEAVY_THRESHOLD = 0.8;
const TVL_OUTFLOW_THRESHOLD = -0.2;
```

- [ ] **Step 2: Update computePYS to use named constants**

Replace lines 26-28:

```typescript
// Before:
const riskPenalty = Math.max(0.5, (101 - safetyScore) / 20);
// ...
const sustainabilityMultiplier = Math.max(0.3, 1.0 - apyVarianceScore);
// After:
const riskPenalty = Math.max(PYS_RISK_PENALTY_FLOOR, (101 - safetyScore) / 20);
// ...
const sustainabilityMultiplier = Math.max(PYS_SUSTAINABILITY_FLOOR, 1.0 - apyVarianceScore);
```

- [ ] **Step 3: Update detectWarningSignals to use named constants**

Replace lines 60-66:

```typescript
// Before:
if (input.apy30d > 0 && input.currentApy / input.apy30d > 2.0) signals.push("yield-spike");
if (input.medianApy > 0 && input.currentApy > input.medianApy * 3) signals.push("yield-divergence");
if (input.apy30d > 0 && input.currentApy < input.apy30d * 0.7) signals.push("negative-trend");
if (input.apyReward != null && input.currentApy > 0 && input.apyReward / input.currentApy > 0.8) signals.push("reward-heavy");
// ...
if (change < -0.2) signals.push("tvl-outflow");
// After:
if (input.apy30d > 0 && input.currentApy / input.apy30d > YIELD_SPIKE_THRESHOLD) signals.push("yield-spike");
if (input.medianApy > 0 && input.currentApy > input.medianApy * YIELD_DIVERGENCE_THRESHOLD) signals.push("yield-divergence");
if (input.apy30d > 0 && input.currentApy < input.apy30d * NEGATIVE_TREND_THRESHOLD) signals.push("negative-trend");
if (input.apyReward != null && input.currentApy > 0 && input.apyReward / input.currentApy > REWARD_HEAVY_THRESHOLD) signals.push("reward-heavy");
// ...
if (change < TVL_OUTFLOW_THRESHOLD) signals.push("tvl-outflow");
```

- [ ] **Step 4: Run existing tests to verify no regressions**

Run: `npm test -- worker/src/cron/__tests__/yield-helpers.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/yield-helpers.ts
git commit -m "refactor(yield): name magic-number thresholds in yield-helpers"
```

---

### Task 5: Name divergence threshold + guard computeMedian in sync-yield-data.ts

**Files:**
- Modify: `worker/src/cron/sync-yield-data.ts:42,202-208,604,802`

- [ ] **Step 1: Add the divergence threshold constant**

In `worker/src/cron/sync-yield-data.ts`, after line 42 (`D1_SAFE_SQL_IN_CHUNK_SIZE`), add:

```typescript
const CROSS_SOURCE_DIVERGENCE_THRESHOLD = 0.5;
```

- [ ] **Step 2: Replace both inline 0.5 usages**

Replace line 604:
```typescript
// Before:
if (canonicalReference.currentApy > 0 && candidate.currentApy > 0 && divergence > 0.5) {
// After:
if (canonicalReference.currentApy > 0 && candidate.currentApy > 0 && divergence > CROSS_SOURCE_DIVERGENCE_THRESHOLD) {
```

Replace line 802:
```typescript
// Before:
if (divergence > 0.5) {
// After:
if (divergence > CROSS_SOURCE_DIVERGENCE_THRESHOLD) {
```

- [ ] **Step 3: Guard computeMedian against NaN/Infinity**

Replace the `computeMedian` function at lines 202-208:

```typescript
// Before:
function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2 === 1
    ? sorted[Math.floor(sorted.length / 2)]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
}
// After:
function computeMedian(values: number[]): number {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return 0;
  const sorted = [...finite].sort((a, b) => a - b);
  return sorted.length % 2 === 1
    ? sorted[Math.floor(sorted.length / 2)]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
}
```

- [ ] **Step 4: Run full test suite to verify**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/sync-yield-data.ts
git commit -m "refactor(yield): name divergence threshold, guard computeMedian against NaN"
```

---

### Task 6: Fix TVL outflow division-by-zero guard

**Files:**
- Modify: `worker/src/cron/yield-helpers.ts:64`
- Modify: `worker/src/cron/__tests__/yield-helpers.test.ts`

- [ ] **Step 1: Write test for prevTvlUsd = 0**

In `worker/src/cron/__tests__/yield-helpers.test.ts`, inside the `describe("detectWarningSignals")` block, add:

```typescript
it("does not flag tvl-outflow when prevTvlUsd is zero", () => {
  const signals = detectWarningSignals({ ...base, sourceTvlUsd: 0, prevTvlUsd: 0 });
  expect(signals).not.toContain("tvl-outflow");
});
```

- [ ] **Step 2: Run test to verify it passes (guard already present)**

Run: `npm test -- worker/src/cron/__tests__/yield-helpers.test.ts`

The existing code at line 64 checks `input.prevTvlUsd > 0` before the division (`input.prevTvlUsd != null && input.prevTvlUsd > 0`). This test should pass without code changes. If it fails, update the condition to include `> 0`:

```typescript
if (input.sourceTvlUsd != null && input.prevTvlUsd != null && input.prevTvlUsd > 0) {
```

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/yield-helpers.ts worker/src/cron/__tests__/yield-helpers.test.ts
git commit -m "test(yield): add tvl-outflow zero-guard test for detectWarningSignals"
```

---

### Task 7: Refactor fetch-tbill-rate.ts fallback paths

**Files:**
- Modify: `worker/src/cron/fetch-tbill-rate.ts`

The function `fetchTbillRate` (lines 60-249) has four nearly identical error paths: circuit-open (lines 61-98), API error (lines 107-145), parse error (lines 150-186), and exception (lines 209-248). Each repeats the same retained-rate-or-hardcoded logic. Extract into a helper.

- [ ] **Step 1: Extract `handleDegradedFallback` helper**

In `worker/src/cron/fetch-tbill-rate.ts`, add after `writeStructuredBenchmark` (after line 58), before `fetchTbillRate`:

```typescript
async function handleDegradedFallback(
  db: D1Database,
  fallbackMode: string,
  extraMeta?: Record<string, unknown>,
): Promise<CronResult> {
  const previous = await loadPreviousBenchmark(db);
  if (previous && !previous.isFallback) {
    console.log(`[fetch-tbill-rate] ${fallbackMode}, retaining last known good rate`);
    await writeStructuredBenchmark(db, {
      rate: previous.rate,
      recordDate: previous.recordDate,
      fetchedAt: previous.fetchedAt,
      source: previous.source,
      isFallback: false,
      fallbackMode: `${fallbackMode}-retained`,
    });
    return {
      status: "degraded",
      metadata: buildMetadata({
        fallbackMode: `${fallbackMode}-retained`,
        wroteRate: previous.rate,
        recordDate: previous.recordDate,
        ...extraMeta,
      }),
    };
  }

  console.log(`[fetch-tbill-rate] ${fallbackMode}, using hardcoded fallback`);
  await writeStructuredBenchmark(db, {
    rate: RISK_FREE_RATE_FALLBACK,
    recordDate: null,
    fetchedAt: null,
    source: "hardcoded-fallback",
    isFallback: true,
    fallbackMode,
  });
  return {
    status: "degraded",
    metadata: buildMetadata({
      fallbackMode,
      wroteRate: RISK_FREE_RATE_FALLBACK,
      ...extraMeta,
    }),
  };
}
```

- [ ] **Step 2: Replace circuit-open path**

Replace lines 61-98 (the entire `if (!await shouldAttemptFetch(...))` block, which is BEFORE the `try` block):

```typescript
  if (!await shouldAttemptFetch(db, CIRCUIT_SOURCE.TREASURY_RATES)) {
    return handleDegradedFallback(db, "circuit-open");
  }
```

The `try {` block on line 101 remains unchanged.

- [ ] **Step 3: Replace API error path**

Inside the `try` block, replace lines 107-145 (the `if (!res?.ok)` block):

```typescript
    if (!res?.ok) {
      await recordOutcome(db, CIRCUIT_SOURCE.TREASURY_RATES, false);
      return handleDegradedFallback(db, "fred-api-error", { apiStatus: res?.status ?? null });
    }
```

- [ ] **Step 4: Replace parse-error path**

Replace lines 150-186 (the `if (!parsed)` block, after `const parsed = parseFredLatest(csv);`):

```typescript
    if (!parsed) {
      await recordOutcome(db, CIRCUIT_SOURCE.TREASURY_RATES, false);
      return handleDegradedFallback(db, "fred-invalid-data");
    }
```

The happy path (lines 189-208: write parsed rate, record success, return ok) remains unchanged.

- [ ] **Step 5: Replace exception path**

Replace lines 209-248 (the `catch` block body):

```typescript
  } catch (err) {
    await recordOutcome(db, CIRCUIT_SOURCE.TREASURY_RATES, false);
    return handleDegradedFallback(db, "fred-exception", { error: String(err).slice(0, 240) });
  }
```

- [ ] **Step 6: Run tests to verify**

Run: `npm test`
Expected: All tests pass (the behavior is identical, just DRYer)

- [ ] **Step 7: Commit**

```bash
git add worker/src/cron/fetch-tbill-rate.ts
git commit -m "refactor(yield): DRY fetch-tbill-rate fallback paths into handleDegradedFallback"
```

---

## Chunk 3: Dead Code & Type Cleanup

### Task 8: Remove dead `JsonRpcCallResponse` from yield-sync types

**Files:**
- Modify: `worker/src/cron/yield-sync/types.ts:36-39`

- [ ] **Step 1: Verify `JsonRpcCallResponse` is unused**

Search for any import of `JsonRpcCallResponse` across the codebase. Expected: zero imports outside the definition file.

- [ ] **Step 2: Remove the dead interface**

In `worker/src/cron/yield-sync/types.ts`, delete lines 36-39 (and the preceding blank line):

```typescript
// Remove:
export interface JsonRpcCallResponse {
  result?: string;
  error?: unknown;
}
```

- [ ] **Step 3: Build to verify**

Run: `cd worker && npx tsc --noEmit && cd ..`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/yield-sync/types.ts
git commit -m "chore(yield): remove dead JsonRpcCallResponse interface"
```

---

## Chunk 4: Test Coverage for Untested Code Paths

### Task 9: Add matchAllDlPools Layer 1 and Layer 2 tests

**Files:**
- Modify: `worker/src/cron/__tests__/yield-helpers.test.ts`

- [ ] **Step 1: Add Layer 1 (native UUID) test**

In the `describe("matchAllDlPools")` block, add:

```typescript
it("matches Layer 1 native pool by UUID from poolMap", () => {
  const poolMap = { "usde-ethena": "uuid-123" };
  const dlPools = [
    {
      pool: "uuid-123",
      symbol: "USDe",
      stablecoin: true,
      exposure: "single",
      tvlUsd: 5_000_000_000,
      apy: 12.4,
      apyBase: 10.2,
      apyReward: 2.2,
    },
    {
      pool: "uuid-other",
      symbol: "USDe",
      stablecoin: true,
      exposure: "single",
      tvlUsd: 100_000,
      apy: 3.0,
      apyBase: 3.0,
      apyReward: null,
    },
  ];

  const result = matchAllDlPools("usde-ethena", "USDe", dlPools, poolMap, {});
  expect(result).toHaveLength(1);
  expect(result[0].pool).toBe("uuid-123");
  expect(result[0].apy).toBe(12.4);
});

it("excludes Layer 1 pool with exposure !== single", () => {
  const poolMap = { "test-coin": "uuid-multi" };
  const dlPools = [
    {
      pool: "uuid-multi",
      symbol: "TEST",
      stablecoin: true,
      exposure: "multi",
      tvlUsd: 1_000_000,
      apy: 5.0,
      apyBase: 5.0,
      apyReward: null,
    },
  ];

  const result = matchAllDlPools("test-coin", "TEST", dlPools, poolMap, {});
  expect(result).toHaveLength(0);
});
```

- [ ] **Step 2: Add Layer 2 (variant symbol) test**

```typescript
it("matches Layer 2 variant wrapper pool alongside Layer 1", () => {
  const poolMap = { "usde-ethena": "uuid-native" };
  const variantMap = { "usde-ethena": { variantSymbol: "sUSDe" } };
  const dlPools = [
    {
      pool: "uuid-native",
      symbol: "USDe",
      stablecoin: true,
      exposure: "single",
      tvlUsd: 5_000_000_000,
      apy: 0,
      apyBase: 0,
      apyReward: null,
    },
    {
      pool: "uuid-wrapper",
      symbol: "sUSDe",
      stablecoin: false,
      exposure: "single",
      tvlUsd: 3_000_000_000,
      apy: 12.4,
      apyBase: 12.4,
      apyReward: null,
    },
  ];

  const result = matchAllDlPools("usde-ethena", "USDe", dlPools, poolMap, variantMap);
  expect(result).toHaveLength(2);
  expect(result.map((r) => r.pool)).toContain("uuid-native");
  expect(result.map((r) => r.pool)).toContain("uuid-wrapper");
});
```

- [ ] **Step 3: Add deduplication test**

```typescript
it("deduplicates when Layer 1 and Layer 2 resolve to the same pool UUID", () => {
  const poolMap = { "test-coin": "uuid-same" };
  const variantMap = { "test-coin": { variantSymbol: "sTEST" } };
  const dlPools = [
    {
      pool: "uuid-same",
      symbol: "sTEST",
      stablecoin: true,
      exposure: "single",
      tvlUsd: 1_000_000,
      apy: 5.0,
      apyBase: 5.0,
      apyReward: null,
    },
  ];

  const result = matchAllDlPools("test-coin", "TEST", dlPools, poolMap, variantMap);
  expect(result).toHaveLength(1);
});
```

- [ ] **Step 4: Run tests**

Run: `npm test -- worker/src/cron/__tests__/yield-helpers.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/__tests__/yield-helpers.test.ts
git commit -m "test(yield): add matchAllDlPools Layer 1 and Layer 2 coverage"
```

---

### Task 10: Add dedupeYieldRankings edge-case tests

**Files:**
- Modify: `shared/lib/__tests__/yield-rankings.test.ts`

- [ ] **Step 1: Add all-null-scores test**

In the `describe("dedupeYieldRankings")` block, using the existing `makeRanking` helper, add:

```typescript
it("handles rows with all null scores gracefully", () => {
  const rankings = dedupeYieldRankings([
    makeRanking({ id: "a", currentApy: 0, pharosYieldScore: null, apy30d: 0, sourceTvlUsd: null }),
    makeRanking({ id: "a", currentApy: 0, pharosYieldScore: null, apy30d: 0, sourceTvlUsd: null }),
  ]);
  expect(rankings).toHaveLength(1);
});
```

- [ ] **Step 2: Add single-row passthrough test**

```typescript
it("returns a single row unchanged", () => {
  const rankings = dedupeYieldRankings([
    makeRanking({ id: "solo", currentApy: 5.0 }),
  ]);
  expect(rankings).toHaveLength(1);
  expect(rankings[0].id).toBe("solo");
});
```

- [ ] **Step 3: Run tests**

Run: `npm test -- shared/lib/__tests__/yield-rankings.test.ts`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add shared/lib/__tests__/yield-rankings.test.ts
git commit -m "test(yield): add dedupeYieldRankings edge-case coverage"
```

---

### Task 11: Add computeApyFromRate edge-case tests

**Files:**
- Modify: `worker/src/cron/__tests__/yield-helpers.test.ts`

- [ ] **Step 1: Add decreasing-rate test**

In the `describe("computeApyFromRate")` block, add:

```typescript
it("returns negative APY for decreasing rate", () => {
  const apy = computeApyFromRate(0.99, 1.0, 7);
  expect(apy).toBeLessThan(0);
});
```

- [ ] **Step 2: Add 7-day vault rate test matching the actual formula**

```typescript
it("computes expected APY for a 7-day vault rate change", () => {
  // Rate went from 1.0 to 1.001 over 7 days
  // (1.001)^(365.25/7) - 1 ≈ 0.05343 → 5.34%
  const apy = computeApyFromRate(1.001, 1.0, 7);
  expect(apy).toBeCloseTo(5.34, 0);
});
```

- [ ] **Step 3: Run tests**

Run: `npm test -- worker/src/cron/__tests__/yield-helpers.test.ts`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/__tests__/yield-helpers.test.ts
git commit -m "test(yield): add computeApyFromRate edge-case coverage"
```

---

### Task 12: Add frontend yield-constants unit tests

**Files:**
- Create: `src/lib/__tests__/yield-constants.test.ts`

- [ ] **Step 1: Write tests for the shared utilities**

Create `src/lib/__tests__/yield-constants.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  formatYieldWarningSignal,
  getPysColor,
  computePysBreakdown,
} from "@/lib/yield-constants";

describe("formatYieldWarningSignal", () => {
  it("returns the mapped label for known signals", () => {
    expect(formatYieldWarningSignal("yield-spike")).toBe("Yield spike");
    expect(formatYieldWarningSignal("tvl-outflow")).toBe("TVL outflow");
  });

  it("converts unknown signals from kebab-case to space-separated", () => {
    expect(formatYieldWarningSignal("some-new-signal")).toBe("some new signal");
  });
});

describe("getPysColor", () => {
  it("returns muted for null", () => {
    expect(getPysColor(null)).toBe("text-muted-foreground");
  });

  it("returns emerald for scores above 40", () => {
    expect(getPysColor(41)).toContain("emerald");
  });

  it("returns amber for scores between 21 and 40", () => {
    expect(getPysColor(30)).toContain("amber");
  });

  it("returns red for scores 20 or below", () => {
    expect(getPysColor(10)).toContain("red");
  });
});

describe("computePysBreakdown", () => {
  it("computes correct breakdown for typical inputs", () => {
    const { riskPenalty, yieldEfficiency, sustainabilityMult } = computePysBreakdown(10, 80, 0.9);
    expect(riskPenalty).toBeCloseTo(1.05, 2);
    expect(yieldEfficiency).toBeCloseTo(10 / 1.05, 1);
    expect(sustainabilityMult).toBeCloseTo(0.9, 2);
  });

  it("uses default safety score of 40 when null", () => {
    const { riskPenalty } = computePysBreakdown(5, null, 0.8);
    expect(riskPenalty).toBeCloseTo((101 - 40) / 20, 2);
  });

  it("clamps risk penalty floor to 0.5", () => {
    const { riskPenalty } = computePysBreakdown(5, 100, 0.8);
    expect(riskPenalty).toBe(0.5);
  });

  it("defaults sustainability to 1.0 when stability is null", () => {
    const { sustainabilityMult } = computePysBreakdown(5, 80, null);
    expect(sustainabilityMult).toBe(1.0);
  });

  it("clamps sustainability floor to 0.3 when stability is very low", () => {
    const { sustainabilityMult } = computePysBreakdown(5, 80, 0.1);
    expect(sustainabilityMult).toBe(0.3);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm test -- src/lib/__tests__/yield-constants.test.ts`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add src/lib/__tests__/yield-constants.test.ts
git commit -m "test(yield): add unit tests for shared yield-constants utilities"
```

---

## Chunk 5: Documentation Update

### Task 13: Update yield-intelligence.md documentation

**Files:**
- Modify: `docs/yield-intelligence.md`

- [ ] **Step 1: Update File Index**

In the File Index table at the bottom of `docs/yield-intelligence.md`, update the `src/lib/yield-constants.ts` row:

```markdown
| `src/lib/yield-constants.ts`                         | Warning-signal labels, `formatYieldWarningSignal`, `getPysColor`, `computePysBreakdown` — shared frontend yield utilities |
| `src/lib/__tests__/yield-constants.test.ts`           | Unit tests for shared frontend yield utilities                                                                           |
```

- [ ] **Step 2: Update Warning Signals section**

In the "Warning Signals (Phase 2)" section, after the signal table, add a note:

```markdown
All frontend surfaces (leaderboard, detail section, history chart) format warning signals via the shared `formatYieldWarningSignal()` function in `src/lib/yield-constants.ts`, which maps known signal keys to human-readable labels and falls back to hyphen-to-space conversion for unknown signals.
```

- [ ] **Step 3: Update PYS section**

In the "Pharos Yield Score (PYS)" section, after the formula block, add:

```markdown
Frontend components display PYS breakdown via `computePysBreakdown()` in `src/lib/yield-constants.ts`, which mirrors the intermediate values (`riskPenalty`, `yieldEfficiency`, `sustainabilityMult`) from the worker's `computePYS()`. The final PYS value is always served by the API.
```

- [ ] **Step 4: Commit**

```bash
git add docs/yield-intelligence.md
git commit -m "docs(yield): update yield-intelligence.md after remediation"
```

---

## Final Verification

### Task 14: Full build + test + type-check gate

- [ ] **Step 1: Run full build**

Run: `npm run build`
Expected: Clean build, zero errors

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 3: Run worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: Zero type errors

- [ ] **Step 4: Run linter**

Run: `npm run lint`
Expected: Zero new lint errors
