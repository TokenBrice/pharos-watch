import { describe, expect, it } from "vitest";

import {
  computeDurabilityScore,
  computeLiquidityScore,
  initLiquidityFallbackCounters,
} from "../pool-helpers";
import { filterRetainedPools, rebuildMetricsFromPools } from "../scoring-helpers";
import type { LiquidityMetrics } from "../types";
import { initMetrics } from "./scoring-test-builders";

function makeMetrics(overrides: Partial<LiquidityMetrics> = {}): LiquidityMetrics {
  return { ...initMetrics("usdc-circle", "USDC"), ...overrides };
}

function makePoolEntry(
  overrides: Partial<LiquidityMetrics["topPools"][number]> = {},
): LiquidityMetrics["topPools"][number] {
  return {
    poolId: "pool-1",
    project: "uniswap-v3",
    chain: "Ethereum",
    tvlUsd: 100_000,
    symbol: "USDC-USDT",
    volumeUsd1d: 10_000,
    volumeUsd7d: 70_000,
    poolType: "uniswap-v3-5bp",
    source: "dl",
    ...overrides,
  };
}

describe("computeDurabilityScore fallback counters", () => {
  it("counts each neutral default exactly once when inputs are unmeasured", () => {
    const counters = initLiquidityFallbackCounters();
    const m = makeMetrics({ totalTvlForOrganic: 0, oldestPoolDays: 365 });
    const withCounters = computeDurabilityScore(m, null, null, counters);
    expect(counters.durabilityOrganicFractionDefault).toBe(1);
    expect(counters.durabilityTvlStabilityDefault).toBe(1);
    expect(counters.durabilityVolumeConsistencyDefault).toBe(1);
    // Counting must not change the score.
    expect(withCounters).toBe(computeDurabilityScore(m, null, null));
  });

  it("stays at zero when all inputs are measured", () => {
    const counters = initLiquidityFallbackCounters();
    const m = makeMetrics({
      totalTvlForOrganic: 1_000_000,
      organicTvlWeightedSum: 600_000,
      oldestPoolDays: 365,
    });
    const withCounters = computeDurabilityScore(m, 0.8, 0.7, counters);
    expect(counters.durabilityOrganicFractionDefault).toBe(0);
    expect(counters.durabilityTvlStabilityDefault).toBe(0);
    expect(counters.durabilityVolumeConsistencyDefault).toBe(0);
    expect(withCounters).toBe(computeDurabilityScore(m, 0.8, 0.7));
  });
});

describe("computeLiquidityScore TVL-depth branch counters", () => {
  it("counts the absolute mcap fallback when circulating supply is missing", () => {
    const counters = initLiquidityFallbackCounters();
    const m = makeMetrics({ totalTvlUsd: 5_000_000, effectiveTvl: 4_000_000, poolCount: 4 });
    const withCounters = computeLiquidityScore(m, 50, undefined, counters);
    expect(counters.tvlDepthMcapFallback).toBe(1);
    expect(counters.tvlDepthRelative).toBe(0);
    expect(withCounters).toEqual(computeLiquidityScore(m, 50, undefined));
  });

  it("counts the relative branch when circulating supply is measured", () => {
    const counters = initLiquidityFallbackCounters();
    const m = makeMetrics({ totalTvlUsd: 5_000_000, effectiveTvl: 4_000_000, poolCount: 4 });
    const withCounters = computeLiquidityScore(m, 50, 1_000_000_000, counters);
    expect(counters.tvlDepthMcapFallback).toBe(0);
    expect(counters.tvlDepthRelative).toBe(1);
    expect(withCounters).toEqual(computeLiquidityScore(m, 50, 1_000_000_000));
  });
});

describe("filterRetainedPools exclusion counters", () => {
  it("counts each exclusion reason and leaves the retained set unchanged", () => {
    const counters = initLiquidityFallbackCounters();
    const retained = makePoolEntry({ poolId: "keep" });
    const blocked = makePoolEntry({ poolId: "blocked", project: "bunni" });
    const churny = makePoolEntry({ poolId: "churn", tvlUsd: 1_000, volumeUsd1d: 60_000 });
    const stale = makePoolEntry({ poolId: "stale", tvlUsd: 150_000_000, volumeUsd1d: 1_000 });
    const pools = [retained, blocked, churny, stale];

    const result = filterRetainedPools(pools, counters);
    expect(result).toEqual(filterRetainedPools(pools));
    expect(result.map((pool) => pool.poolId)).toEqual(["keep"]);
    expect(counters.retainedExclusionBlockedDex).toBe(1);
    expect(counters.retainedExclusionVolTvlRatio).toBe(1);
    expect(counters.retainedExclusionLargePoolLowVolume).toBe(1);
  });

});

describe("rebuildMetricsFromPools TVL fallback counters", () => {
  it("counts pools whose quality/effective TVL fall back to raw tvlUsd", () => {
    const counters = initLiquidityFallbackCounters();
    const bare = makePoolEntry({ poolId: "bare" });
    const measured = makePoolEntry({
      poolId: "measured",
      extra: { qualityAdjustedTvl: 80_000, effectiveTvl: 70_000 },
    });
    const rebuilt = rebuildMetricsFromPools([bare, measured], counters);
    expect(counters.rebuildQualityAdjustedTvlFallback).toBe(1);
    expect(counters.rebuildEffectiveTvlFallback).toBe(1);
    // Counting must not change the rebuilt totals.
    expect(rebuilt.qualityAdjustedTvl).toBe(180_000);
    expect(rebuilt.effectiveTvl).toBe(170_000);
  });

});

