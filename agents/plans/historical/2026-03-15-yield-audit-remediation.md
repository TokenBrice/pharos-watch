# Yield Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all data accuracy bugs, reliability issues, test coverage gaps, and configuration improvements identified in the yield intelligence audit (`agents/audits/2026-03-15-yield-intelligence-audit.md`).

**Architecture:** Pure function fixes with TDD come first, then worker reliability patches, then config/threshold tuning, then doc updates. Each task produces a standalone commit.

**Tech Stack:** TypeScript, Vitest, Cloudflare Workers (D1)

---

## Chunk 1: Pure Function Fixes + Test Coverage

### Task 1: Fix Layer 2 variant symbol `.includes()` → exact match

The critical data accuracy bug. Layer 2 uses `.includes()` which causes `sUSDa` to match `sUSDai`.

**Files:**
- Modify: `worker/src/cron/yield-helpers.ts:124`
- Modify: `worker/src/cron/__tests__/yield-helpers.test.ts`

- [ ] **Step 1: Write the failing test proving `.includes()` is wrong**

In `worker/src/cron/__tests__/yield-helpers.test.ts`, add inside the `matchAllDlPools` describe block:

```typescript
it("does not cross-contaminate variant symbols that are prefixes of other symbols", () => {
  // sUSDa must NOT match sUSDai — that's a different token
  const variantMap = { "usda-avalon": { variantSymbol: "sUSDa" } };
  const dlPools = [
    {
      pool: "uuid-susdai",
      symbol: "sUSDai",
      stablecoin: false,
      exposure: "single",
      tvlUsd: 200_000_000,
      apy: 6.77,
      apyBase: 6.77,
      apyReward: null,
    },
    {
      pool: "uuid-susda",
      symbol: "sUSDa",
      stablecoin: false,
      exposure: "single",
      tvlUsd: 50_000_000,
      apy: 4.5,
      apyBase: 4.5,
      apyReward: null,
    },
  ];

  const result = matchAllDlPools("usda-avalon", "USDa", dlPools, {}, variantMap);
  expect(result).toHaveLength(1);
  expect(result[0].pool).toBe("uuid-susda");
  expect(result[0].apy).toBe(4.5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-helpers.test.ts --reporter=verbose`
Expected: FAIL — the current `.includes()` matches `sUSDai` instead of `sUSDa`.

- [ ] **Step 3: Fix the implementation — exact match for Layer 2**

In `worker/src/cron/yield-helpers.ts:124`, change:

```typescript
// BEFORE:
const candidates = dlPools.filter(p => p.exposure === "single" && p.symbol.toLowerCase().includes(sym));

// AFTER:
const candidates = dlPools.filter(p => p.exposure === "single" && p.symbol.toLowerCase() === sym);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-helpers.test.ts --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 5: Also add a test for empty pool array edge case**

```typescript
it("returns empty array when dlPools is empty", () => {
  const result = matchAllDlPools("test-coin", "TEST", [], { "test-coin": "uuid-1" }, {});
  expect(result).toHaveLength(0);
});
```

- [ ] **Step 6: Run tests, commit**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-helpers.test.ts --reporter=verbose`

```bash
git add worker/src/cron/yield-helpers.ts worker/src/cron/__tests__/yield-helpers.test.ts
git commit -m "fix(yield): use exact match for Layer 2 variant symbol matching

Fixes cross-contamination where sUSDa incorrectly matched sUSDai pool.
Root cause: .includes() substring matching instead of === exact match."
```

---

### Task 2: Fix `governance-set` duplicate label + add `zero-yield` warning signal

**Files:**
- Modify: `shared/lib/classification.ts:291`
- Modify: `worker/src/cron/yield-helpers.ts:69-79`
- Modify: `src/lib/yield-constants.ts:1-8`

- [ ] **Step 1: Fix the duplicate label**

In `shared/lib/classification.ts:291`, change:

```typescript
// BEFORE:
"governance-set": "Native",

// AFTER:
"governance-set": "Gov. Set",
```

- [ ] **Step 2: Add `zero-yield` warning signal constant and detection**

In `worker/src/cron/yield-helpers.ts`, add after `TVL_OUTFLOW_THRESHOLD` (line 15):

```typescript
const ZERO_YIELD_HISTORY_THRESHOLD = 0.5; // flag when current=0 but 30d avg > 0.5%
```

In `detectWarningSignals()` (line 79), add before the `return`:

```typescript
if (input.currentApy === 0 && input.apy30d > ZERO_YIELD_HISTORY_THRESHOLD) signals.push("zero-yield");
```

- [ ] **Step 3: Add frontend label for `zero-yield`**

In `src/lib/yield-constants.ts`, add to `WARNING_SIGNAL_LABELS`:

```typescript
"zero-yield": "Zero yield",
```

- [ ] **Step 4: Add tests for the new signal**

In `worker/src/cron/__tests__/yield-helpers.test.ts`, inside `detectWarningSignals` describe:

```typescript
it("detects zero-yield when current is 0 but 30d average > 0.5%", () => {
  const signals = detectWarningSignals({ ...base, currentApy: 0, apy30d: 2 });
  expect(signals).toContain("zero-yield");
});

it("does not flag zero-yield when 30d average is also near zero", () => {
  const signals = detectWarningSignals({ ...base, currentApy: 0, apy30d: 0.3 });
  expect(signals).not.toContain("zero-yield");
});
```

- [ ] **Step 5: Run all tests, commit**

Run: `npm test`

```bash
git add shared/lib/classification.ts worker/src/cron/yield-helpers.ts worker/src/cron/__tests__/yield-helpers.test.ts src/lib/yield-constants.ts
git commit -m "fix(yield): fix governance-set duplicate label; add zero-yield warning signal"
```

---

### Task 3: Fix variance/stability scores for near-zero APY means

When mean APY < 1e-10, both `computeYieldStability` and `computeApyVarianceScore` return misleading values. `computeYieldStability` returns 1 ("perfectly stable") and `computeApyVarianceScore` returns 0 (no variance). Both should return null for near-zero means, since there's insufficient signal. In PYS, null `apyVarianceScore` should default to a neutral value rather than 0 (which gives a 1.0 sustainability boost).

**Files:**
- Modify: `worker/src/cron/yield-helpers.ts:35-58`
- Modify: `worker/src/cron/sync-yield-data.ts:522` (handle null variance)
- Modify: `worker/src/cron/__tests__/yield-helpers.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// In computeYieldStability describe:
it("returns null for near-zero mean APY (insufficient signal)", () => {
  expect(computeYieldStability([0, 0, 0, 0])).toBeNull();
  expect(computeYieldStability([0.0000001, 0, 0.0000001, 0])).toBeNull();
});

// In computeApyVarianceScore describe:
it("returns null for near-zero mean (insufficient signal)", () => {
  expect(computeApyVarianceScore([0, 0, 0])).toBeNull();
  expect(computeApyVarianceScore([0.0000001, 0, 0.0000001, 0])).toBeNull();
});
```

- [ ] **Step 2: Run tests to see them fail**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-helpers.test.ts -t "near-zero"`
Expected: FAIL — currently returns 1 / 0 instead of null.

- [ ] **Step 3: Fix both functions**

In `worker/src/cron/yield-helpers.ts:46`, change:

```typescript
// BEFORE:
if (Math.abs(mean) < 1e-10) return 1;

// AFTER:
if (Math.abs(mean) < 1e-10) return null;
```

Change `computeApyVarianceScore` return type and near-zero guard (line 52-55):

```typescript
// BEFORE:
export function computeApyVarianceScore(apySamples: number[]): number {
  if (apySamples.length < 2) return 0;
  const mean = apySamples.reduce((s, v) => s + v, 0) / apySamples.length;
  if (Math.abs(mean) < 1e-10) return 0;

// AFTER:
export function computeApyVarianceScore(apySamples: number[]): number | null {
  if (apySamples.length < 2) return null;
  const mean = apySamples.reduce((s, v) => s + v, 0) / apySamples.length;
  if (Math.abs(mean) < 1e-10) return null;
```

- [ ] **Step 4: Update PYS caller to handle null variance**

In `worker/src/cron/sync-yield-data.ts:522`, the `computeApyVarianceScore` result is used in `computePYS`. Handle null:

```typescript
// BEFORE:
const apyVarianceScore = computeApyVarianceScore(samples);

// AFTER:
const apyVarianceScore = computeApyVarianceScore(samples) ?? 0;
```

This preserves existing PYS behavior for coins with insufficient samples (they get variance=0, sustainability=1.0, same as before). The improvement is that `yieldStability` (computed from `computeYieldStability`) will now correctly be null for near-zero means instead of misleadingly 1.0.

- [ ] **Step 5: Update existing tests that expect 0 for insufficient samples**

In `worker/src/cron/__tests__/yield-helpers.test.ts`, update the `computeApyVarianceScore` tests:

```typescript
// BEFORE:
it("returns 0 for fewer than 2 samples", () => {
  expect(computeApyVarianceScore([])).toBe(0);
  expect(computeApyVarianceScore([5])).toBe(0);
});

// AFTER:
it("returns null for fewer than 2 samples", () => {
  expect(computeApyVarianceScore([])).toBeNull();
  expect(computeApyVarianceScore([5])).toBeNull();
});
```

- [ ] **Step 6: Run tests, commit**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-helpers.test.ts --reporter=verbose`

```bash
git add worker/src/cron/yield-helpers.ts worker/src/cron/sync-yield-data.ts worker/src/cron/__tests__/yield-helpers.test.ts
git commit -m "fix(yield): return null variance/stability for near-zero APY means

Near-zero APY coins were incorrectly showing perfect stability (1.0)
and zero variance. Now returns null (insufficient data). PYS caller
defaults null variance to 0 to preserve scoring behavior."
```

---

### Task 4: Add warning signal absolute floors

Low-APY coins trigger spurious `yield-spike` and `negative-trend` warnings from tiny absolute changes.

**Files:**
- Modify: `worker/src/cron/yield-helpers.ts:69-79`
- Modify: `worker/src/cron/__tests__/yield-helpers.test.ts`

- [ ] **Step 1: Add threshold constants**

In `worker/src/cron/yield-helpers.ts`, after existing thresholds (line 15):

```typescript
const YIELD_SPIKE_MIN_APY = 2.0; // only flag spike if currentApy > 2%
const NEGATIVE_TREND_MIN_APY = 1.0; // only flag negative trend if apy30d > 1%
```

- [ ] **Step 2: Write failing tests**

```typescript
it("does not flag yield-spike for low-APY coins below absolute floor", () => {
  // 0.5% → 1.1% is a 2.2x ratio but too small to matter
  const signals = detectWarningSignals({ ...base, currentApy: 1.1, apy30d: 0.5, medianApy: 5 });
  expect(signals).not.toContain("yield-spike");
});

it("still flags yield-spike for meaningful APY levels above floor", () => {
  const signals = detectWarningSignals({ ...base, currentApy: 11, apy30d: 5, medianApy: 5 });
  expect(signals).toContain("yield-spike");
});

it("does not flag negative-trend for very low baseline APY", () => {
  // 0.8% → 0.5% is a 37.5% drop but too small to matter
  const signals = detectWarningSignals({ ...base, currentApy: 0.5, apy30d: 0.8, medianApy: 5 });
  expect(signals).not.toContain("negative-trend");
});
```

- [ ] **Step 3: Update `detectWarningSignals` implementation**

In `worker/src/cron/yield-helpers.ts:71-73`, update:

```typescript
// BEFORE:
if (input.apy30d > 0 && input.currentApy / input.apy30d > YIELD_SPIKE_THRESHOLD) signals.push("yield-spike");
// ...
if (input.apy30d > 0 && input.currentApy < input.apy30d * NEGATIVE_TREND_THRESHOLD) signals.push("negative-trend");

// AFTER:
if (input.apy30d > 0 && input.currentApy > YIELD_SPIKE_MIN_APY && input.currentApy / input.apy30d > YIELD_SPIKE_THRESHOLD) signals.push("yield-spike");
// ...
if (input.apy30d > NEGATIVE_TREND_MIN_APY && input.currentApy < input.apy30d * NEGATIVE_TREND_THRESHOLD) signals.push("negative-trend");
```

- [ ] **Step 4: Run tests, commit**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-helpers.test.ts --reporter=verbose`

```bash
git add worker/src/cron/yield-helpers.ts worker/src/cron/__tests__/yield-helpers.test.ts
git commit -m "fix(yield): add absolute APY floors to warning signal thresholds

Prevents spurious yield-spike and negative-trend warnings on low-APY
coins where small absolute changes cross relative thresholds."
```

---

### Task 5: Add missing test coverage

Add tests for `computeTvlWeightedMedianApy`, warning signal boundary conditions, and fix the integration test mock.

**Files:**
- Modify: `worker/src/cron/__tests__/yield-helpers.test.ts`

- [ ] **Step 1: Add `computeTvlWeightedMedianApy` tests**

First add the import at the top of the test file:

```typescript
import { computeTvlWeightedMedianApy } from "../yield-sync/rankings";
```

Then add a new describe block:

```typescript
describe("computeTvlWeightedMedianApy", () => {
  it("returns 0 for empty input", () => {
    expect(computeTvlWeightedMedianApy([])).toBe(0);
  });

  it("returns 0 when all rows have null TVL", () => {
    expect(computeTvlWeightedMedianApy([
      { apy_30d: 5, source_tvl_usd: null },
      { apy_30d: 3, source_tvl_usd: null },
    ])).toBe(0);
  });

  it("returns 0 when all rows have zero TVL", () => {
    expect(computeTvlWeightedMedianApy([
      { apy_30d: 5, source_tvl_usd: 0 },
    ])).toBe(0);
  });

  it("returns the APY of a single valid row", () => {
    expect(computeTvlWeightedMedianApy([
      { apy_30d: 5, source_tvl_usd: 1_000_000 },
    ])).toBe(5);
  });

  it("returns TVL-weighted median, not simple median", () => {
    // Two pools: small TVL high APY vs large TVL low APY
    // Large TVL dominates so median should be low APY
    const result = computeTvlWeightedMedianApy([
      { apy_30d: 10, source_tvl_usd: 100_000 },    // tiny
      { apy_30d: 3, source_tvl_usd: 10_000_000 },  // dominant
    ]);
    expect(result).toBe(3);
  });

  it("filters out rows with zero or negative APY", () => {
    const result = computeTvlWeightedMedianApy([
      { apy_30d: 0, source_tvl_usd: 100_000_000 },
      { apy_30d: 5, source_tvl_usd: 1_000_000 },
    ]);
    expect(result).toBe(5);
  });

  it("picks median from sorted valid rows for balanced TVL", () => {
    const result = computeTvlWeightedMedianApy([
      { apy_30d: 2, source_tvl_usd: 1_000_000 },
      { apy_30d: 5, source_tvl_usd: 1_000_000 },
      { apy_30d: 8, source_tvl_usd: 1_000_000 },
    ]);
    // Equal TVL: cumulative hits 50% at second row (APY=5)
    expect(result).toBe(5);
  });
});
```

- [ ] **Step 2: Add warning signal boundary condition tests**

```typescript
it("does not flag yield-spike at exact 2x threshold (requires exceeding)", () => {
  // currentApy = 10, apy30d = 5 → ratio = 2.0 exactly. Threshold is >2.0, so no flag
  const signals = detectWarningSignals({ ...base, currentApy: 10, apy30d: 5 });
  expect(signals).not.toContain("yield-spike");
});

it("flags yield-spike just above 2x threshold", () => {
  const signals = detectWarningSignals({ ...base, currentApy: 10.01, apy30d: 5 });
  expect(signals).toContain("yield-spike");
});

it("handles negative currentApy without crashing", () => {
  const signals = detectWarningSignals({ ...base, currentApy: -1, apy30d: 5 });
  expect(signals).toContain("negative-trend");
  expect(signals).not.toContain("yield-spike");
});

it("returns exact expected signals for all-trigger input", () => {
  const signals = detectWarningSignals({
    currentApy: 50,
    apy30d: 5,
    apyReward: 45,
    medianApy: 5,
    sourceTvlUsd: 50_000_000,
    prevTvlUsd: 100_000_000,
  });
  expect(signals).toEqual(
    expect.arrayContaining(["yield-spike", "yield-divergence", "reward-heavy", "tvl-outflow"]),
  );
  // negative-trend should NOT fire: 50 > 5*0.7
  expect(signals).not.toContain("negative-trend");
});
```

- [ ] **Step 3: Run all tests, commit**

Run: `npm test`

```bash
git add worker/src/cron/__tests__/yield-helpers.test.ts
git commit -m "test(yield): add coverage for computeTvlWeightedMedianApy and warning boundaries

Covers zero TVL, null TVL, single row, weighted vs simple median,
boundary conditions at exact thresholds, and negative APY inputs."
```

---

### Task 5b: Fix incorrect mock in integration test

The integration test mocks `computeApyVarianceScore` to return `90`, but the real function returns values in [0, 1] (or null after Task 3). This prevents the integration test from catching bugs with out-of-range variance scores.

**Files:**
- Modify: `worker/src/cron/__tests__/sync-yield-data.test.ts:168`

- [ ] **Step 1: Fix the mock value**

In `worker/src/cron/__tests__/sync-yield-data.test.ts:168`, change:

```typescript
// BEFORE:
computeApyVarianceScore: vi.fn(() => 90),

// AFTER:
computeApyVarianceScore: vi.fn(() => 0.1),
```

- [ ] **Step 2: Run integration tests to verify they still pass**

Run: `cd worker && npx vitest run src/cron/__tests__/sync-yield-data.test.ts --reporter=verbose`

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/__tests__/sync-yield-data.test.ts
git commit -m "fix(test): correct computeApyVarianceScore mock from 90 to 0.1

The mock returned 90 but the function returns [0, 1]. This prevented
the integration test from catching out-of-range variance score bugs."
```

---

## Chunk 2: Worker Reliability Fixes

### Task 6: Degrade yield sync when risk-free rate is retained after fetch failure

The `handleDegradedFallback` in `fetch-tbill-rate.ts` retains the previous rate with `isFallback: false` when FRED fails. We cannot simply flip it to `true` because that would break the multi-failure retention chain: the next failure would see `previous.isFallback === true`, skip retention, and jump to the hardcoded fallback after just 2 consecutive failures.

Instead, fix the consumer: `shouldDegradeForRiskFreeRate` in `sync-yield-data.ts` should also degrade when `fallbackMode` contains `"retained"`.

**Files:**
- Modify: `worker/src/cron/sync-yield-data.ts:242-246`

- [ ] **Step 1: Update `shouldDegradeForRiskFreeRate` to catch retained rates**

In `worker/src/cron/sync-yield-data.ts`, change the function at line 242:

```typescript
// BEFORE:
function shouldDegradeForRiskFreeRate(meta: Awaited<ReturnType<typeof loadRiskFreeRateSnapshot>>): boolean {
  if (!meta.fallbackMode) return false;
  if (meta.isFallback) return true;
  return meta.ageSeconds == null || meta.ageSeconds > MAX_RETAINED_RISK_FREE_RATE_AGE_SEC;
}

// AFTER:
function shouldDegradeForRiskFreeRate(meta: Awaited<ReturnType<typeof loadRiskFreeRateSnapshot>>): boolean {
  if (!meta.fallbackMode) return false;
  if (meta.isFallback) return true;
  if (typeof meta.fallbackMode === "string" && meta.fallbackMode.includes("retained")) return true;
  return meta.ageSeconds == null || meta.ageSeconds > MAX_RETAINED_RISK_FREE_RATE_AGE_SEC;
}
```

This catches all retained-rate scenarios (e.g. `"fred-api-error-retained"`, `"circuit-open-retained"`) without changing the upstream `isFallback` flag that controls the multi-failure retention chain.

- [ ] **Step 2: Run build and tests**

Run: `npm run build && npm test`

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/sync-yield-data.ts
git commit -m "fix(yield): degrade yield sync when risk-free rate is retained after fetch failure

shouldDegradeForRiskFreeRate now also triggers on fallbackMode containing
'retained', without changing the upstream isFallback flag that controls
the multi-failure retention chain in fetch-tbill-rate."
```

---

### Task 7: Add DL pool cache age validation

Reject cached DL pools older than 6 hours to prevent silently using stale data.

**Files:**
- Modify: `worker/src/cron/yield-sync/sources.ts:40-51`

- [ ] **Step 1: Add the age guard**

In `worker/src/cron/yield-sync/sources.ts`, after line 37, add the constant:

```typescript
const MAX_DL_CACHE_AGE_SEC = 6 * 3600; // 6 hours (3× the expected 2-hour DEX sync refresh)
```

Then modify the cache parsing block (lines 40-51) to add age validation:

```typescript
const cachedPools = await getCache(db, "dl-stablecoin-pools");
if (cachedPools) {
  const parsed = parseDlStablecoinPoolsCache(cachedPools.value, cachedPools.updatedAt, nowSec);
  if (parsed) {
    const cacheAgeSec = parsed.meta.ageSeconds ?? 0;
    if (cacheAgeSec > MAX_DL_CACHE_AGE_SEC) {
      console.warn(
        `[sync-yield-data] DL pools cache too old (${Math.round(cacheAgeSec / 3600)}h), falling through to direct fetch`,
      );
      fallbackMode = "cache-too-old";
    } else {
      dlPools = parsed.pools;
      console.log(`[sync-yield-data] Using ${dlPools.length} cached stablecoin pools from DEX sync`);
      return parsed;
    }
  } else {
    console.warn("[sync-yield-data] Failed to parse cached DL pools, falling back to direct fetch");
    fallbackMode = "cache-parse-failed";
  }
}
```

- [ ] **Step 2: Run build and tests**

Run: `npm run build && npm test`

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/yield-sync/sources.ts
git commit -m "fix(yield): reject DL pool cache older than 6 hours

Prevents silently using arbitrarily old DL pool data when the DEX
sync cron fails. Falls through to direct DL Yields API fetch."
```

---

### Task 8: Add on-chain rate failure logging

Log specific warnings when Tier 1 on-chain reads return null.

**Files:**
- Modify: `worker/src/cron/yield-sync/sources.ts:98-128`

- [ ] **Step 1: Add logging for null results**

In `worker/src/cron/yield-sync/sources.ts`, in the `fetchOnChainRates` function, change line 119:

```typescript
// BEFORE:
if (raw == null) continue;

// AFTER:
if (raw == null) {
  console.warn(`[yield] On-chain rate returned null for ${config.stablecoinId} (${config.chain}:${config.contract})`);
  continue;
}
```

- [ ] **Step 2: Run build and tests**

Run: `npm run build && npm test`

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/yield-sync/sources.ts
git commit -m "fix(yield): log warning when on-chain rate reads return null

Makes Tier 1 degradation visible in logs when vault contracts fail
silently (timeout, upgrade, RPC issue)."
```

---

### Task 9: Add legacy history age guard

Reject legacy history rows older than 35 days.

**Files:**
- Modify: `worker/src/cron/sync-yield-data.ts:285-317`

- [ ] **Step 1: Add age filter**

In `worker/src/cron/sync-yield-data.ts`, in the `pickHistoryRowsForSource` function, add an age guard after the `legacyMatchesCurrentSourceFamily` check. Add a `startSec` parameter to the function.

First update the function signature at line 285:

```typescript
function pickHistoryRowsForSource(
  stablecoinId: string,
  sourceKey: string,
  dataSource: string,
  sourceHistory: Map<string, YieldHistorySnapshotRow[]>,
  legacyHistoryById: Map<string, YieldHistorySnapshotRow[]>,
  resolvedCountByCoin: Map<string, number>,
  startSec: number,
): { rows: YieldHistorySnapshotRow[]; usedLegacyHistory: boolean } {
```

Then add the age guard after line 306 (inside the legacy section):

```typescript
const LEGACY_MAX_AGE_SEC = 35 * 86400; // 30d window + 5d buffer
const legacyCutoff = startSec - LEGACY_MAX_AGE_SEC;
const freshLegacyRows = legacyRows.filter((row) => row.recorded_at >= legacyCutoff);
```

And use `freshLegacyRows` instead of `legacyRows` in the condition:

```typescript
if (
  freshLegacyRows.length > 0 &&
  (resolvedCountByCoin.get(stablecoinId) ?? 0) <= 1 &&
  legacyMatchesCurrentSourceFamily
) {
  return { rows: freshLegacyRows, usedLegacyHistory: true };
}
```

- [ ] **Step 2: Update all call sites to pass `startSec`**

In sync-yield-data.ts, find the call to `pickHistoryRowsForSource` (~line 503) and add `startSec`:

```typescript
const historySelection = pickHistoryRowsForSource(
  stablecoinId,
  sourceKey,
  y.dataSource,
  sourceHistory,
  legacyHistoryById,
  resolvedCountByCoin,
  startSec,
);
```

- [ ] **Step 3: Run build and tests**

Run: `npm run build && npm test`

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/sync-yield-data.ts
git commit -m "fix(yield): add 35-day age guard for legacy history fallback

Prevents 60+ day old legacy-best rows from distorting 30d trailing
metrics when used as fallback for source-specific history."
```

---

### Task 10: Fix cross-source divergence detection

Add bidirectional check and flag when deterministic source reads 0% but curated source reads >1%.

**Files:**
- Modify: `worker/src/cron/sync-yield-data.ts:597-614`

- [ ] **Step 1: Add zero-vs-positive divergence detection**

In `worker/src/cron/sync-yield-data.ts`, after the existing divergence block (~line 614), add:

```typescript
// Flag when canonical (deterministic) source reads 0 but a lower-confidence source has positive APY
if (
  canonicalReference &&
  canonicalReference.currentApy === 0 &&
  candidate.currentApy > 1 &&
  getConfidencePriority(canonicalReference.confidenceTier) > getConfidencePriority(candidate.confidenceTier)
) {
  anomalies.push("canonical-zero-vs-positive");
}
```

- [ ] **Step 2: Run build and tests**

Run: `npm run build && npm test`

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/sync-yield-data.ts
git commit -m "fix(yield): detect divergence when deterministic source reads 0%

Flags when a high-confidence source reads 0% but a lower-confidence
source has positive APY, indicating possible contract/data issues."
```

---

## Chunk 3: Threshold & Config Tuning

### Task 11: Update hardcoded thresholds and constants

**Files:**
- Modify: `worker/src/lib/constants.ts:105`
- Modify: `worker/src/cron/sync-yield-data.ts:40,44`
- Modify: `worker/src/cron/yield-config.ts` (allowlist)

- [ ] **Step 1: Update `RISK_FREE_RATE_FALLBACK` from 4.25 to 3.75**

In `worker/src/lib/constants.ts:105`:

```typescript
// BEFORE:
export const RISK_FREE_RATE_FALLBACK = 4.25;

// AFTER:
export const RISK_FREE_RATE_FALLBACK = 3.75;
```

- [ ] **Step 2: Raise `MIN_SAFETY_SCORE_COVERAGE_RATIO` from 0.5 to 0.75**

In `worker/src/cron/sync-yield-data.ts:40`:

```typescript
// BEFORE:
const MIN_SAFETY_SCORE_COVERAGE_RATIO = 0.5;

// AFTER:
const MIN_SAFETY_SCORE_COVERAGE_RATIO = 0.75;
```

- [ ] **Step 3: Lower `CROSS_SOURCE_DIVERGENCE_THRESHOLD` from 0.5 to 0.35**

In `worker/src/cron/sync-yield-data.ts:44`:

```typescript
// BEFORE:
const CROSS_SOURCE_DIVERGENCE_THRESHOLD = 0.5;

// AFTER:
const CROSS_SOURCE_DIVERGENCE_THRESHOLD = 0.35;
```

- [ ] **Step 4: Add `morpho-blue` to lending protocol allowlist**

In `worker/src/cron/yield-config.ts`, after `"morpho-v1",` (line 420):

```typescript
"morpho-blue", // $1B+ TVL, rapidly growing modular lending
```

And in `LENDING_PROTOCOL_LABELS` (after `"morpho-v1": "Morpho"` at line 452):

```typescript
"morpho-blue": "Morpho Blue",
```

- [ ] **Step 5: Run build and tests**

Run: `npm run build && npm test`

- [ ] **Step 6: Commit**

```bash
git add worker/src/lib/constants.ts worker/src/cron/sync-yield-data.ts worker/src/cron/yield-config.ts
git commit -m "chore(yield): tune thresholds and expand lending protocol allowlist

- Update RISK_FREE_RATE_FALLBACK from 4.25% to 3.75% (matches current T-bill)
- Raise MIN_SAFETY_SCORE_COVERAGE_RATIO from 0.5 to 0.75
- Lower CROSS_SOURCE_DIVERGENCE_THRESHOLD from 0.5 to 0.35
- Add morpho-blue to lending protocol allowlist"
```

---

## Chunk 4: Documentation Update

### Task 12: Update yield-intelligence.md

**Files:**
- Modify: `docs/yield-intelligence.md`

- [ ] **Step 1: Update docs to reflect all changes**

Key sections to update:
1. **Warning Signals table**: Add `zero-yield` row: `| zero-yield | currentApy === 0 AND apy30d > 0.5% | Yield dropped to zero but had recent activity |`
2. **Warning Signals table**: Update `yield-spike` description to mention absolute floor: `currentApy > 2% AND currentApy / apy30d > 2.0`
3. **Warning Signals table**: Update `negative-trend` description: `apy30d > 1% AND currentApy < apy30d * 0.7`
4. **Constants table**: Update `RISK_FREE_RATE_FALLBACK` value to `3.75`
5. **Yield Types table**: Fix `governance-set` label from `Native` to `Gov. Set`
6. **Layer 2 description**: Note exact match instead of includes
7. **Risk-Free Rate section**: Note that retained rates now trigger yield sync degradation via `fallbackMode` containing `"retained"`, while `isFallback` remains `false` to preserve the multi-failure retention chain
8. **Lending Protocol Allowlist**: Add `morpho-blue` to Tier 2

- [ ] **Step 2: Commit**

```bash
git add docs/yield-intelligence.md
git commit -m "docs(yield): update yield-intelligence.md for audit remediation changes"
```

---

## Summary

| # | Task | Priority | Files Changed |
|---|------|----------|---------------|
| 1 | Fix Layer 2 `.includes()` → exact match | P0 | yield-helpers.ts, test |
| 2 | Fix governance-set label + add zero-yield signal | P1 | classification.ts, yield-helpers.ts, yield-constants.ts, test |
| 3 | Fix variance/stability near-zero handling | P2 | yield-helpers.ts, sync-yield-data.ts, test |
| 4 | Add warning signal absolute floors | P2 | yield-helpers.ts, test |
| 5 | Add missing test coverage (median, boundaries) | P2 | test |
| 5b | Fix incorrect integration test mock (90 → 0.1) | P2 | sync-yield-data.test.ts |
| 6 | Degrade yield sync on retained risk-free rate | P1 | sync-yield-data.ts |
| 7 | Add DL pool cache age validation | P1 | sources.ts |
| 8 | Add on-chain rate failure logging | P1 | sources.ts |
| 9 | Add legacy history age guard | P2 | sync-yield-data.ts |
| 10 | Fix cross-source divergence detection | P2 | sync-yield-data.ts |
| 11 | Update thresholds + add Morpho Blue | P3 | constants.ts, sync-yield-data.ts, yield-config.ts |
| 12 | Update documentation | P3 | yield-intelligence.md |
