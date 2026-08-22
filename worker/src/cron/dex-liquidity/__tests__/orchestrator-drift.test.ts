import { describe, expect, it } from "vitest";
import { computeDexLiquidityDriftSummary } from "../orchestrator-drift";
import type { FullScoreResult } from "../types";

// The aggregate guards in orchestrator-analysis abort the run only when global
// or top-10 TVL lands below 60% of the prior publication. On 2026-08-20 USDS
// shed roughly 91% of its measured TVL to a partial pool inventory while both
// aggregates stayed inside every bound, so the run published normally and the
// next digest read the hole as news. This flag makes the per-coin hole visible.

function scoreResult(tvl: number): FullScoreResult {
  return {
    tvl,
    effectiveTvl: tvl,
    vol24h: tvl / 10,
    score: 46,
    hhi: 0.1,
    durability: 0.8,
    components: { tvlDepth: 16, volumeActivity: 20, poolQuality: 20, durability: 20, pairDiversity: 20 },
    weightedBalanceRatio: 0.98,
    organicFrac: 0.9,
    avgStress: 5,
    lockedLiqPct: 0.2,
    coverageClass: "primary",
    coverageConfidence: 0.9,
    sourceMix: { dl: { poolCount: 1, tvlUsd: tvl } },
    balanceMeasuredTvlUsd: tvl,
    organicMeasuredTvlUsd: tvl * 0.9,
  };
}

function summarize(previousTvl: number, currentTvl: number) {
  return computeDexLiquidityDriftSummary({
    previousSummary: null,
    priceObservations: new Map(),
    stagedMergedCount: 0,
    stagedSkippedCount: 0,
    weakCoverageCoinsBeforeFallback: 0,
    measuredBalanceCoveragePct: 1,
    watchlistPreviousById: new Map(),
    scoreResults: new Map([["usds-sky", scoreResult(currentTvl)]]),
    retainedPoolsByStablecoin: new Map(),
    previousMajorTvlById: new Map([["usds-sky", previousTvl]]),
  });
}

describe("computeDexLiquidityDriftSummary major TVL cliffs", () => {
  it("flags a major coin whose TVL collapsed past the hard aggregate bound", () => {
    const summary = summarize(152_000_000, 13_720_000);

    expect(summary.qualityDriftFlags).toContain("major-tvl-cliff:usds-sky");
    expect(summary.qualityDriftSeverity).toBe("high");
    expect(summary.majorTvlCliffs[0]?.tvlPctDelta).toBeCloseTo(-0.9097, 4);
  });

  it("does not flag a drop inside the documented methodology-recompute range", () => {
    // v6.0's Raydium de-duplication moved individual coins 2-35%.
    const summary = summarize(152_000_000, 99_000_000);

    expect(summary.qualityDriftFlags).toEqual([]);
    expect(summary.majorTvlCliffs).toEqual([]);
  });

  it("ignores coins too small for their swings to mean anything", () => {
    const summary = summarize(2_000_000, 10_000);

    expect(summary.majorTvlCliffs).toEqual([]);
  });

  it("treats a vanished score row as a total cliff", () => {
    const summary = computeDexLiquidityDriftSummary({
      previousSummary: null,
      priceObservations: new Map(),
      stagedMergedCount: 0,
      stagedSkippedCount: 0,
      weakCoverageCoinsBeforeFallback: 0,
      measuredBalanceCoveragePct: 1,
      watchlistPreviousById: new Map(),
      scoreResults: new Map(),
      retainedPoolsByStablecoin: new Map(),
      previousMajorTvlById: new Map([["usds-sky", 152_000_000]]),
    });

    expect(summary.qualityDriftFlags).toContain("major-tvl-cliff:usds-sky");
    expect(summary.majorTvlCliffs[0]?.currentTvlUsd).toBe(0);
  });
});
