# Liquidity Score v4 Enhancement — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recalibrate the liquidity scoring model to v4.0 — log-scale volume, remove cross-chain component, rework durability sub-weights.

**Architecture:** Three changes to `computeLiquidityScore()` and `computeDurabilityScore()` in `pool-helpers.ts`, with type updates, test rewrites, frontend/methodology page updates, and a version bump. No schema changes. The `crossChain` key is removed from the `ScoreComponents` type and all consumers.

**Tech Stack:** TypeScript, Vitest, React (methodology page + two component files)

**Design spec:** `agents/plans/2026-03-10-liquidity-score-v4-enhancement.md`

---

## Task 1: Update ScoreComponents type — remove `crossChain`

**Files:**
- Modify: `worker/src/cron/dex-liquidity/types.ts:149-156`
- Modify: `shared/types/index.ts:608-614`

- [ ] **Step 1: Remove `crossChain` from the worker `ScoreComponents` interface**

In `worker/src/cron/dex-liquidity/types.ts`, change lines 149-156 from:

```ts
export interface ScoreComponents {
  tvlDepth: number;
  volumeActivity: number;
  poolQuality: number;
  durability: number;
  pairDiversity: number;
  crossChain: number;
}
```

to:

```ts
export interface ScoreComponents {
  tvlDepth: number;
  volumeActivity: number;
  poolQuality: number;
  durability: number;
  pairDiversity: number;
}
```

- [ ] **Step 2: Update the shared zod schema**

In `shared/types/index.ts`, change lines 608-613 from:

```ts
      tvlDepth: z.number(),
      volumeActivity: z.number(),
      poolQuality: z.number(),
      durability: z.number(),
      pairDiversity: z.number(),
      crossChain: z.number(),
```

to:

```ts
      tvlDepth: z.number(),
      volumeActivity: z.number(),
      poolQuality: z.number(),
      durability: z.number(),
      pairDiversity: z.number(),
      crossChain: z.number().optional(),
```

Keep `crossChain` as optional rather than removing it — cached/historical D1 rows still contain it in `score_components_json`, and the zod schema parses those rows. Removing it entirely would cause parse failures on old data.

- [ ] **Step 3: Verify types compile**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/dex-liquidity/types.ts shared/types/index.ts
git commit -m "refactor: remove crossChain from ScoreComponents, keep optional in zod for historical data"
```

---

## Task 2: Rewrite `computeDurabilityScore()` — remove locked liq, rebalance weights, sqrt organic

> **Note:** Tasks 2 and 3 both modify `pool-helpers.ts` and the same test file. Line numbers below refer to the *original* file before Task 2 edits. After Task 2, line numbers shift. Find functions by name (`computeDurabilityScore`, `computeLiquidityScore`) rather than relying on line offsets.

**Files:**
- Modify: `worker/src/cron/dex-liquidity/pool-helpers.ts` — replace the `computeDurabilityScore()` function
- Test: `worker/src/cron/__tests__/dex-liquidity-pool-helpers.test.ts`

- [ ] **Step 1: Write the failing tests for new durability behavior**

In `worker/src/cron/__tests__/dex-liquidity-pool-helpers.test.ts`, replace the existing durability test assertions inside the `"computes durability and liquidity scores for default and healthy cases"` test (lines 60-71).

Replace:

```ts
  it("computes durability and liquidity scores for default and healthy cases", () => {
    const empty = initMetrics("usdt-tether", "USDT");
    expect(computeDurabilityScore(empty, null, null)).toBe(44);

    const rich = initMetrics("usdc-circle", "USDC");
    rich.organicTvlWeightedSum = 80;
    rich.totalTvlForOrganic = 100;
    rich.oldestPoolDays = 730;
    rich.lockedLiqWeightedSum = 60;
    rich.totalTvlForLocked = 100;

    expect(computeDurabilityScore(rich, 0.9, 0.8)).toBe(92);
```

With:

```ts
  it("computes durability and liquidity scores for default and healthy cases", () => {
    // Default durability: organic defaults to 0.5 -> sqrt(0.5)*100=70.7,
    // tvlStab/volConsist default to 50 each, maturity=0, no locked liq
    // 70.7*0.15 + 50*0.35 + 50*0.25 + 0*0.25 = 10.6+17.5+12.5+0 = 41
    const empty = initMetrics("usdt-tether", "USDT");
    expect(computeDurabilityScore(empty, null, null)).toBe(41);

    const rich = initMetrics("usdc-circle", "USDC");
    rich.organicTvlWeightedSum = 80;
    rich.totalTvlForOrganic = 100;
    rich.oldestPoolDays = 730;
    // lockedLiq fields ignored now — set them to verify they don't affect score
    rich.lockedLiqWeightedSum = 60;
    rich.totalTvlForLocked = 100;

    // organic=0.8 -> sqrt(0.8)*100=89.4, tvlStab=0.9*100=90, volConsist=0.8*100=80, maturity=min(100,730/365*100)=100
    // 89.4*0.15 + 90*0.35 + 80*0.25 + 100*0.25 = 13.4+31.5+20+25 = 90
    expect(computeDurabilityScore(rich, 0.9, 0.8)).toBe(90);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run worker/src/cron/__tests__/dex-liquidity-pool-helpers.test.ts`
Expected: FAIL — durability scores still use old weights.

- [ ] **Step 3: Implement the new `computeDurabilityScore()`**

In `worker/src/cron/dex-liquidity/pool-helpers.ts`, replace lines 52-89:

```ts
/**
 * Compute durability score for a stablecoin (0-100).
 * 15% organic fraction (sqrt curve), 35% TVL stability, 25% volume consistency, 25% maturity.
 */
export function computeDurabilityScore(
  m: LiquidityMetrics,
  tvlStability: number | null,
  volumeStability: number | null,
): number {
  // Organic fraction sub-score (sqrt curve — less punishing at low end)
  const organicFraction = m.totalTvlForOrganic > 0
    ? m.organicTvlWeightedSum / m.totalTvlForOrganic
    : 0.5;
  const organicScore = Math.min(100, Math.sqrt(organicFraction) * 100);

  // TVL stability sub-score (from depth_stability, 0-1)
  const tvlStabilityScore = tvlStability != null ? tvlStability * 100 : 50;

  // Volume consistency sub-score
  const volumeConsistencyScore = volumeStability != null ? volumeStability * 100 : 50;

  // Maturity sub-score
  const maturityScore = Math.min(100, (m.oldestPoolDays / 365) * 100);

  return Math.max(0, Math.min(100, Math.round(
    organicScore * 0.15 +
    tvlStabilityScore * 0.35 +
    volumeConsistencyScore * 0.25 +
    maturityScore * 0.25
  )));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run worker/src/cron/__tests__/dex-liquidity-pool-helpers.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/dex-liquidity/pool-helpers.ts worker/src/cron/__tests__/dex-liquidity-pool-helpers.test.ts
git commit -m "feat(liquidity): rework durability — remove locked liq, rebalance weights, sqrt organic"
```

---

## Task 3: Rewrite `computeLiquidityScore()` — log-scale volume, remove cross-chain, new weights

**Files:**
- Modify: `worker/src/cron/dex-liquidity/pool-helpers.ts` — replace the `computeLiquidityScore()` function (follows `computeDurabilityScore()`)
- Test: `worker/src/cron/__tests__/dex-liquidity-pool-helpers.test.ts`

- [ ] **Step 1: Update the liquidity score test assertions**

In the same `"computes durability and liquidity scores..."` test, replace the `zeroLiquidity` and `healthyLiquidity` assertions (the part after the durability assertions, from the existing `const zeroLiquidity = computeLiquidityScore(empty, 44);` onward). Replace with:

```ts
    const zeroLiquidity = computeLiquidityScore(empty, 41);
    expect(zeroLiquidity.score).toBe(6);
    expect(zeroLiquidity.components).toEqual({
      tvlDepth: 0,
      volumeActivity: 0,
      poolQuality: 0,
      durability: 41,
      pairDiversity: 0,
    });

    rich.effectiveTvl = 10_000_000;
    rich.totalTvlUsd = 5_000_000;
    rich.totalVolume24hUsd = 1_000_000;
    rich.qualityAdjustedTvl = 8_000_000;
    rich.poolCount = 8;
    rich.chains = new Set(["Ethereum", "Base", "Arbitrum"]);

    // V/T = 1M/5M = 0.2 -> log-scale: 33.3*log10(0.2/0.005) = 33.3*log10(40) = 33.3*1.602 = 53.3
    const healthyLiquidity = computeLiquidityScore(rich, 90);
    expect(healthyLiquidity.score).toBeGreaterThan(60);
    expect(healthyLiquidity.components.pairDiversity).toBe(40);
    // crossChain should not be present
    expect("crossChain" in healthyLiquidity.components).toBe(false);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run worker/src/cron/__tests__/dex-liquidity-pool-helpers.test.ts`
Expected: FAIL — still uses old formula.

- [ ] **Step 3: Implement the new `computeLiquidityScore()`**

In `worker/src/cron/dex-liquidity/pool-helpers.ts`, replace the entire `computeLiquidityScore()` function (immediately after `computeDurabilityScore`):

```ts
export function computeLiquidityScore(
  m: LiquidityMetrics,
  durabilityScore: number,
): { score: number; components: ScoreComponents } {
  // Component 1: TVL depth (35%) — uses effectiveTvl
  const tvlInput = m.effectiveTvl > 0 ? m.effectiveTvl : m.totalTvlUsd;
  const tvlDepth = Math.min(
    100,
    Math.max(0, 20 * Math.log10(Math.max(tvlInput, 1) / 100_000) + 20),
  );

  // Component 2: Volume activity (20%) — log-scale
  const vtRatio = m.totalTvlUsd > 0 ? m.totalVolume24hUsd / m.totalTvlUsd : 0;
  const volumeActivity = vtRatio <= 0
    ? 0
    : Math.min(100, Math.max(0, 33.3 * Math.log10(vtRatio / 0.005)));

  // Component 3: Pool quality (22.5%) — quality-adjusted TVL on same log scale
  const poolQuality = Math.min(
    100,
    Math.max(0, 20 * Math.log10(Math.max(m.qualityAdjustedTvl, 1) / 100_000) + 20),
  );

  // Component 4: Durability (15%) — passed in from durability computation
  const durability = durabilityScore;

  // Component 5: Pair diversity (7.5%)
  const pairDiversity = Math.min(100, m.poolCount * 5);

  const raw =
    tvlDepth * 0.35 +
    volumeActivity * 0.20 +
    poolQuality * 0.225 +
    durability * 0.15 +
    pairDiversity * 0.075;

  const components: ScoreComponents = {
    tvlDepth: Math.round(tvlDepth),
    volumeActivity: Math.round(volumeActivity),
    poolQuality: Math.round(poolQuality),
    durability: Math.round(durability),
    pairDiversity: Math.round(pairDiversity),
  };

  return {
    score: Math.max(0, Math.min(100, Math.round(raw))),
    components,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run worker/src/cron/__tests__/dex-liquidity-pool-helpers.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/dex-liquidity/pool-helpers.ts worker/src/cron/__tests__/dex-liquidity-pool-helpers.test.ts
git commit -m "feat(liquidity): log-scale volume, remove cross-chain, rebalance composite weights to v4"
```

---

## Task 4: Update scoring.ts — remove locked-liq accumulation from `rebuildMetricsFromPools()`

**Files:**
- Modify: `worker/src/cron/dex-liquidity/scoring.ts:22-119` and lines 253-255

The `rebuildMetricsFromPools()` function accumulates `lockedLiqWeightedSum` and `totalTvlForLocked` and these are copied back into metrics. These fields can stay in the type (still used by persistence for the D1 column) but the durability scorer no longer reads them, so the accumulation is harmless. **No code change needed in scoring.ts** — the locked-liq fields remain populated for the D1 `locked_liquidity_pct` column, which we keep as-is.

- [ ] **Step 1: Verify no functional changes needed in scoring.ts**

Read `worker/src/cron/dex-liquidity/scoring.ts` lines 278-310 to confirm `lockedLiqPct` is computed independently for the `FullScoreResult` (it's a stored metric, not a scoring input anymore). No change required.

- [ ] **Step 2: Update the scoring integration test**

In `worker/src/cron/__tests__/dex-liquidity-scoring.test.ts`, the main test at line 296 asserts `lockedLiqPct: 0.5` — this should remain unchanged since the metric is still computed and stored. But scores will shift due to the new formulas. The test uses pre-filter aggregates that get rebuilt from pools, so the final score depends on the test fixture pools.

The key fixture pool (line 120-141) has `tvlUsd: 100_000`, `volumeUsd1d: 50_000`, giving V/T = `50000/290000 = 0.172` after rebuild (total TVL from all retained pools).

Rather than computing exact expected scores from the fixture (which would be brittle), relax the score assertion to a range check:

In the test at line 296, the `toMatchObject` call already doesn't assert `score` directly — it asserts `tvl`, `vol24h`, `weightedBalanceRatio`, `organicFrac`, `avgStress`, `lockedLiqPct`. These are all unaffected. No change needed for this test.

Verify by running the test.

Run: `npm test -- --run worker/src/cron/__tests__/dex-liquidity-scoring.test.ts`
Expected: PASS (the `toMatchObject` assertions don't check `score` or `components`).

- [ ] **Step 3: Commit** (only if test changes were needed)

---

## Task 5: Update persistence test — remove `crossChain` from fixture components

**Files:**
- Modify: `worker/src/cron/__tests__/dex-liquidity-persistence.test.ts:88-94` and `143-149`

- [ ] **Step 1: Update the fixture components object**

In `worker/src/cron/__tests__/dex-liquidity-persistence.test.ts`, change the components object at lines 88-95:

From:
```ts
            components: {
              tvlDepth: 70,
              volumeActivity: 60,
              poolQuality: 80,
              durability: 81,
              pairDiversity: 10,
              crossChain: 27,
            },
```

To:
```ts
            components: {
              tvlDepth: 70,
              volumeActivity: 60,
              poolQuality: 80,
              durability: 81,
              pairDiversity: 10,
            },
```

Also update the expected serialized JSON at lines 143-150:

From:
```ts
      JSON.stringify({
        tvlDepth: 70,
        volumeActivity: 60,
        poolQuality: 80,
        durability: 81,
        pairDiversity: 10,
        crossChain: 27,
      }),
```

To:
```ts
      JSON.stringify({
        tvlDepth: 70,
        volumeActivity: 60,
        poolQuality: 80,
        durability: 81,
        pairDiversity: 10,
      }),
```

- [ ] **Step 2: Run the persistence test**

Run: `npm test -- --run worker/src/cron/__tests__/dex-liquidity-persistence.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/__tests__/dex-liquidity-persistence.test.ts
git commit -m "test: remove crossChain from persistence test fixtures"
```

---

## Task 6: Update frontend components — remove cross-chain display, update weights

**Files:**
- Modify: `src/components/dex-liquidity-card.tsx:313-319`
- Modify: `src/components/report-card.tsx:29` and `195-200`

- [ ] **Step 1: Update dex-liquidity-card.tsx score breakdown**

In `src/components/dex-liquidity-card.tsx`, remove the Cross-chain entry from the `bars` array (lines 314-319) and update the weights for TVL Depth, Pool Quality:

Replace the bars array (lines 286-320 approximately — the full `bars` definition) with:

```ts
  const bars = [
    {
      label: "TVL Depth",
      value: components.tvlDepth,
      weight: "35%",
      tooltip: "Log-scale effective TVL (quality-adjusted, metapool-deduped)",
    },
    {
      label: "Volume",
      value: components.volumeActivity,
      weight: "20%",
      tooltip: "Log-scale volume/TVL ratio",
    },
    {
      label: "Pool Quality",
      value: components.poolQuality,
      weight: "22.5%",
      tooltip: "Mechanism quality \u00d7 balance health \u00d7 pair quality",
    },
    {
      label: "Durability",
      value: components.durability,
      weight: "15%",
      tooltip: "TVL stability, volume consistency, maturity, organic fees",
    },
    {
      label: "Diversity",
      value: components.pairDiversity,
      weight: "7.5%",
      tooltip: "Number of distinct liquidity pools",
    },
  ];
```

- [ ] **Step 2: Update report-card.tsx liquidity component display**

In `src/components/report-card.tsx`, update the component weight list at lines 195-200:

From:
```ts
                        {[
                          { label: "TVL Depth", key: "tvlDepth" as const, weight: 30 },
                          { label: "Volume Activity", key: "volumeActivity" as const, weight: 20 },
                          { label: "Pool Quality", key: "poolQuality" as const, weight: 20 },
                          { label: "Durability", key: "durability" as const, weight: 15 },
                          { label: "Pair Diversity", key: "pairDiversity" as const, weight: 7.5 },
                          { label: "Cross-chain", key: "crossChain" as const, weight: 7.5 },
                        ].map(({ label, key: k, weight }) => {
```

To:
```ts
                        {[
                          { label: "TVL Depth", key: "tvlDepth" as const, weight: 35 },
                          { label: "Volume Activity", key: "volumeActivity" as const, weight: 20 },
                          { label: "Pool Quality", key: "poolQuality" as const, weight: 22.5 },
                          { label: "Durability", key: "durability" as const, weight: 15 },
                          { label: "Pair Diversity", key: "pairDiversity" as const, weight: 7.5 },
                        ].map(({ label, key: k, weight }) => {
```

Also update the inline `liquidityComponents` type in `src/components/report-card.tsx`. The `ReportCardDetailProps` interface (around line 21-31) has:

```ts
  liquidityComponents?: {
    tvlDepth: number;
    volumeActivity: number;
    poolQuality: number;
    durability: number;
    pairDiversity: number;
    crossChain: number;
  } | null;
```

Remove the `crossChain: number;` line from this inline type.

- [ ] **Step 3: Verify frontend builds**

Run: `npm run build`
Expected: Build succeeds with no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/dex-liquidity-card.tsx src/components/report-card.tsx
git commit -m "feat(ui): update liquidity score breakdown — remove cross-chain, show v4 weights"
```

---

## Task 7: Update methodology page

**Files:**
- Modify: `src/app/methodology/page.tsx:1026-1098`

- [ ] **Step 1: Update the worked example**

In `src/app/methodology/page.tsx`, update the worked example at lines 1026-1034.

Replace:
```tsx
          <WorkedExample summary="Worked example (verified against computeLiquidityScore)">
            <p className="font-mono">
              Inputs: effectiveTVL=$25M, TVL=$20M, volume24h=$8M, qualityTVL=$18M, durability=68, pools=12, chains=4
            </p>
            <p className="font-mono">tvlDepth=67.96, volume=80, quality=65.11, pair=60, crossChain=51</p>
            <p className="font-mono">score=round(0.30*67.96+0.20*80+0.20*65.11+0.15*68+0.075*60+0.075*51)=68</p>
            <p>
              Result: <span className="text-foreground">Liquidity score 68</span>.
            </p>
          </WorkedExample>
```

With (recomputed using v4 formulas):
- V/T = 8M/20M = 0.4 -> volumeActivity = 33.3 * log10(0.4/0.005) = 33.3 * log10(80) = 33.3 * 1.903 = 63.4
- tvlDepth = 20 * log10(25M/100K) + 20 = 20 * 2.398 + 20 = 67.96
- poolQuality = 20 * log10(18M/100K) + 20 = 20 * 2.255 + 20 = 65.11
- score = round(0.35*67.96 + 0.20*63.4 + 0.225*65.11 + 0.15*68 + 0.075*60) = round(23.79 + 12.68 + 14.65 + 10.2 + 4.5) = round(65.82) = 66

```tsx
          <WorkedExample summary="Worked example (verified against computeLiquidityScore)">
            <p className="font-mono">
              Inputs: effectiveTVL=$25M, TVL=$20M, volume24h=$8M, qualityTVL=$18M, durability=68, pools=12
            </p>
            <p className="font-mono">tvlDepth=67.96, volume=63.37, quality=65.11, pair=60</p>
            <p className="font-mono">score=round(0.35*67.96+0.20*63.37+0.225*65.11+0.15*68+0.075*60)=66</p>
            <p>
              Result: <span className="text-foreground">Liquidity score 66</span>.
            </p>
          </WorkedExample>
```

- [ ] **Step 2: Update the component diagram — desktop (lines 1039-1065)**

Replace the 3x2 grid with a layout showing 5 components. Change to:

```tsx
            <div className="hidden md:flex flex-col items-center gap-3">
              <div className="grid grid-cols-5 gap-3 w-full">
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium">TVL Depth</p>
                  <p className="text-xs text-muted-foreground mt-0.5">35%</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium">Volume Activity</p>
                  <p className="text-xs text-muted-foreground mt-0.5">20%</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium">Pool Quality</p>
                  <p className="text-xs text-muted-foreground mt-0.5">22.5%</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium">Durability</p>
                  <p className="text-xs text-muted-foreground mt-0.5">15%</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium">Pair Diversity</p>
                  <p className="text-xs text-muted-foreground mt-0.5">7.5%</p>
                </div>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="rounded-lg border p-3 text-center w-64">
                <p className="text-foreground font-medium">Liquidity Score</p>
                <p className="text-xs text-muted-foreground mt-0.5">0&ndash;100</p>
              </div>
            </div>
```

- [ ] **Step 3: Update the component diagram — mobile (lines 1074-1098)**

Replace the 2-col mobile grid to remove the Cross-chain box and update weights. The grid will have 5 items (last one spans full width or sits alone). Replace with:

```tsx
            <div className="flex flex-col items-center gap-3 md:hidden">
              <div className="grid grid-cols-2 gap-2 w-full">
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">TVL Depth</p>
                  <p className="text-xs text-muted-foreground">35%</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Vol. Activity</p>
                  <p className="text-xs text-muted-foreground">20%</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Pool Quality</p>
                  <p className="text-xs text-muted-foreground">22.5%</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Durability</p>
                  <p className="text-xs text-muted-foreground">15%</p>
                </div>
                <div className="rounded-lg border p-3 text-center col-span-2">
                  <p className="text-foreground font-medium text-xs">Pair Diversity</p>
                  <p className="text-xs text-muted-foreground">7.5%</p>
                </div>
              </div>
```

- [ ] **Step 4: Verify frontend builds**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/app/methodology/page.tsx
git commit -m "docs(methodology): update liquidity score section for v4 formula changes"
```

---

## Task 8: Add v4.0 changelog entry

**Files:**
- Modify: `shared/lib/liquidity-score-version.ts:5-8`

- [ ] **Step 1: Update version and add changelog entry**

In `shared/lib/liquidity-score-version.ts`, change `currentVersion: "3.4"` to `currentVersion: "4.0"` on line 6, and add a new entry at the top of the `changelog` array (after line 8):

Run `date +%s` first to get the current Unix timestamp, then use it as the `effectiveAt` value:

```ts
  {
    version: "4.0",
    title: "Log-scale volume, cross-chain removal, durability rebalance",
    date: "2026-03-10",
    effectiveAt: <PASTE_TIMESTAMP_HERE>,
    summary:
      "Volume activity switched from linear to log-scale. Cross-chain component removed and weight redistributed to TVL depth and pool quality. Durability sub-weights rebalanced: locked liquidity removed, organic fraction reduced to 15% with sqrt curve, history-measured signals raised to 85%.",
    impact: [
      "Volume activity now uses log-scale (33.3*log10(V/T/0.005)) — median score rises from 5 to ~35",
      "Cross-chain component removed; TVL Depth raised to 35%, Pool Quality to 22.5%",
      "Durability: organic 15% (sqrt curve), TVL stability 35%, volume consistency 25%, maturity 25%",
      "Locked liquidity sub-component removed from durability (no reliable data source)",
    ],
    commits: [],
    reconstructed: false,
  },
```

- [ ] **Step 2: Verify types compile**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add shared/lib/liquidity-score-version.ts
git commit -m "feat(liquidity): bump methodology version to 4.0"
```

---

## Task 9: Update dex-liquidity.md documentation

**Files:**
- Modify: `docs/dex-liquidity.md:15-22` (component table) and `docs/dex-liquidity.md:127-131` (durability section)

- [ ] **Step 1: Update the component weight table**

In `docs/dex-liquidity.md`, replace the component table at lines 15-22:

```markdown
| Component           | Weight | Source                     | How Computed                                                                                                           |
| ------------------- | ------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **TVL Depth**       | 35%    | DeFiLlama Yields           | Log-scale using effective TVL (quality-adjusted, metapool-deduped): $100K->20, $1M->40, $10M->60, $100M->80, $1B+->100 |
| **Volume Activity** | 20%    | DeFiLlama Yields           | Log-scale V/T ratio: 33.3*log10(vtRatio/0.005). ~0.5%->13, ~5%->56, ~50%->100                                         |
| **Pool Quality**    | 22.5%  | Curve API + DeFiLlama      | Quality-adjusted TVL using mechanism x balance health x pair quality multipliers (see below)                           |
| **Durability**      | 15%    | DeFiLlama Yields + History | 35% TVL stability, 25% volume consistency, 25% maturity, 15% organic fraction (sqrt curve)                             |
| **Pair Diversity**  | 7.5%   | DeFiLlama Yields           | Pool count, diminishing returns: min(100, poolCount x 5)                                                               |
```

- [ ] **Step 2: Update the durability section**

In `docs/dex-liquidity.md`, replace the Durability Score section at lines 129-131:

```markdown
### Durability Score (0-100)

Per-stablecoin durability metric combining: TVL stability from 30-day CV (35%), volume consistency from 30-day CV (25%), oldest pool maturity (25%), and organic fee fraction with sqrt curve (15%). Locked liquidity removed — no reliable data source. Stored as `durability_score`.
```

- [ ] **Step 3: Commit**

```bash
git add docs/dex-liquidity.md
git commit -m "docs: update dex-liquidity.md for v4 scoring changes"
```

---

## Task 10: Run full test suite and build

- [ ] **Step 1: Run all tests**

Run: `npm test`
Expected: All tests pass. If any test references `crossChain` as a required field or asserts old score values, fix those tests.

- [ ] **Step 2: Run full build + type-check**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: Clean build, no type errors.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: No lint errors.

- [ ] **Step 4: Final commit if any remaining fixes were needed**
