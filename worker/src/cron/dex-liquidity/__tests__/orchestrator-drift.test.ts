import { describe, expect, it } from "vitest";
import {
  computeDexLiquidityDriftSummary,
  type DexLiquidityDriftCandidate,
  type DexLiquidityDriftSummary,
} from "../orchestrator-drift";
import type { FullScoreResult } from "../types";

// The aggregate guards in orchestrator-analysis abort the run only when global
// or top-10 TVL lands below 60% of the prior publication. On 2026-08-20 USDS
// shed roughly 91% of its measured TVL to a partial pool inventory while both
// aggregates stayed inside every bound, so the run published normally and the
// next digest read the hole as news. This flag makes the per-coin hole visible,
// but only once a second productive run confirms it: one hour of measurement
// noise fires and self-silences a single-generation diff, because the collapsed
// value becomes the next baseline as soon as it publishes.

function scoreResult(tvl: number, poolCount = 1): FullScoreResult {
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
    sourceMix: { dl: { poolCount, tvlUsd: tvl } },
    balanceMeasuredTvlUsd: tvl,
    organicMeasuredTvlUsd: tvl * 0.9,
  };
}

function cliff(input: {
  previousTvl: number;
  currentTvl: number;
  previousCandidates?: DexLiquidityDriftCandidate[];
  hasScoreRow?: boolean;
}): DexLiquidityDriftSummary {
  return computeDexLiquidityDriftSummary({
    previousSummary: null,
    previousCandidates: input.previousCandidates ?? [],
    priceObservations: new Map(),
    stagedMergedCount: 0,
    stagedSkippedCount: 0,
    weakCoverageCoinsBeforeFallback: 0,
    measuredBalanceCoveragePct: 1,
    watchlistPreviousById: new Map(),
    scoreResults:
      input.hasScoreRow === false ? new Map() : new Map([["usds-sky", scoreResult(input.currentTvl)]]),
    previousMajorTvlById: new Map([["usds-sky", input.previousTvl]]),
  });
}

describe("computeDexLiquidityDriftSummary major TVL cliffs", () => {
  it("holds a first-run cliff as a candidate instead of reporting it", () => {
    const first = cliff({ previousTvl: 152_000_000, currentTvl: 13_720_000 });

    expect(first.qualityDriftFlags).toEqual([]);
    expect(first.qualityDriftSeverity).toBe("none");
    expect(first.majorTvlCliffs[0]?.tvlPctDelta).toBeCloseTo(-0.9097, 4);
    expect(first.qualityDriftCandidates).toEqual([
      {
        flag: "major-tvl-cliff:usds-sky",
        consecutiveRuns: 1,
        baselineValue: 152_000_000,
        observedValue: 13_720_000,
      },
    ]);
  });

  it("confirms the cliff on the second run and keeps it after the baseline row is overwritten", () => {
    const first = cliff({ previousTvl: 152_000_000, currentTvl: 13_720_000 });
    const second = cliff({
      previousTvl: 152_000_000,
      currentTvl: 13_700_000,
      previousCandidates: first.qualityDriftCandidates,
    });

    expect(second.qualityDriftFlags).toEqual(["major-tvl-cliff:usds-sky"]);
    expect(second.qualityDriftSeverity).toBe("high");
    expect(second.qualityDriftCandidates).toEqual([
      {
        flag: "major-tvl-cliff:usds-sky",
        consecutiveRuns: 2,
        baselineValue: 152_000_000,
        observedValue: 13_700_000,
      },
    ]);

    // The third run publishes on top of the collapsed value, so the per-coin
    // baseline row no longer carries the pre-event TVL.
    const third = cliff({
      previousTvl: 13_700_000,
      currentTvl: 13_600_000,
      previousCandidates: second.qualityDriftCandidates,
    });

    expect(third.qualityDriftFlags).toEqual(["major-tvl-cliff:usds-sky"]);
    expect(third.majorTvlCliffs[0]?.previousTvlUsd).toBe(152_000_000);
    expect(third.qualityDriftCandidates[0]?.consecutiveRuns).toBe(3);
  });

  it("clears a confirmed cliff once the value recovers against the pre-event baseline", () => {
    const confirmed = cliff({
      previousTvl: 152_000_000,
      currentTvl: 13_700_000,
      previousCandidates: [{ flag: "major-tvl-cliff:usds-sky", consecutiveRuns: 2, baselineValue: 152_000_000, observedValue: 13_720_000 }],
    });
    const recovered = cliff({
      previousTvl: 13_700_000,
      currentTvl: 150_000_000,
      previousCandidates: confirmed.qualityDriftCandidates,
    });

    expect(confirmed.qualityDriftFlags).toEqual(["major-tvl-cliff:usds-sky"]);
    expect(recovered.qualityDriftFlags).toEqual([]);
    expect(recovered.qualityDriftCandidates).toEqual([]);
    expect(recovered.majorTvlCliffs).toEqual([]);
  });

  it("does not confirm a drop inside the documented methodology-recompute range", () => {
    // v6.0's Raydium de-duplication moved individual coins 2-35%.
    const first = cliff({ previousTvl: 152_000_000, currentTvl: 99_000_000 });
    const second = cliff({
      previousTvl: 99_000_000,
      currentTvl: 96_000_000,
      previousCandidates: first.qualityDriftCandidates,
    });

    expect(first.qualityDriftCandidates).toEqual([]);
    expect(second.qualityDriftFlags).toEqual([]);
    expect(second.qualityDriftCandidates).toEqual([]);
  });

  it("ignores coins too small for their swings to mean anything", () => {
    const summary = cliff({ previousTvl: 2_000_000, currentTvl: 10_000 });

    expect(summary.qualityDriftCandidates).toEqual([]);
    expect(summary.majorTvlCliffs).toEqual([]);
  });

  it("treats a vanished score row as a total cliff", () => {
    const first = cliff({ previousTvl: 152_000_000, currentTvl: 0, hasScoreRow: false });
    const second = cliff({
      previousTvl: 152_000_000,
      currentTvl: 0,
      hasScoreRow: false,
      previousCandidates: first.qualityDriftCandidates,
    });

    expect(first.qualityDriftFlags).toEqual([]);
    expect(second.qualityDriftFlags).toEqual(["major-tvl-cliff:usds-sky"]);
    expect(second.majorTvlCliffs[0]?.currentTvlUsd).toBe(0);
  });
});

describe("computeDexLiquidityDriftSummary watchlist pool counts", () => {
  const watchlistPreviousById = new Map([
    [
      "usdc-circle",
      {
        stablecoin_id: "usdc-circle",
        pool_count: 151,
        coverage_confidence: 0.9,
        total_tvl_usd: 1_000_000,
        balance_measured_tvl_usd: 1_000_000,
      },
    ],
  ]);

  function watchlist(currentPublishedPools: number, previousCandidates: DexLiquidityDriftCandidate[] = []) {
    return computeDexLiquidityDriftSummary({
      previousSummary: null,
      previousCandidates,
      priceObservations: new Map(),
      stagedMergedCount: 0,
      stagedSkippedCount: 0,
      weakCoverageCoinsBeforeFallback: 0,
      measuredBalanceCoveragePct: 1,
      watchlistPreviousById,
      scoreResults: new Map([["usdc-circle", scoreResult(1_000_000, currentPublishedPools)]]),
      previousMajorTvlById: new Map(),
    });
  }

  it("measures the delta on the published pool count instead of a curated subset", () => {
    const flat = watchlist(151);

    expect(flat.topAssetCoverageDeltas[0]?.currentPoolCount).toBe(151);
    expect(flat.topAssetCoverageDeltas[0]?.poolCountPctDelta).toBe(0);
    expect(flat.qualityDriftCandidates).toEqual([]);
  });

  it("requires a second run before reporting a watchlist pool drop", () => {
    const dropped = watchlist(120);

    expect(dropped.qualityDriftFlags).toEqual([]);
    expect(dropped.topAssetCoverageDeltas[0]?.poolCountPctDelta).toBeCloseTo(-0.2053, 4);

    const confirmed = watchlist(119, dropped.qualityDriftCandidates);

    expect(confirmed.qualityDriftFlags).toEqual(["watchlist-pool-drop:usdc-circle"]);
    expect(confirmed.qualityDriftSeverity).toBe("high");
    expect(confirmed.qualityDriftCandidates[0]).toEqual({
      flag: "watchlist-pool-drop:usdc-circle",
      consecutiveRuns: 2,
      baselineValue: 151,
      observedValue: 119,
    });
  });
});

describe("computeDexLiquidityDriftSummary global counters", () => {
  const previousSummary = {
    stagedPoolsMerged: 1_352,
    stagedPoolsSkipped: 0,
    priceObservationCoins: 0,
    measuredBalanceCoveragePct: 0,
    weakCoverageCoins: 0,
  };

  function merged(stagedMergedCount: number, previousCandidates: DexLiquidityDriftCandidate[] = []) {
    return computeDexLiquidityDriftSummary({
      previousSummary,
      previousCandidates,
      priceObservations: new Map(),
      stagedMergedCount,
      stagedSkippedCount: 0,
      weakCoverageCoinsBeforeFallback: 0,
      measuredBalanceCoveragePct: 0,
      watchlistPreviousById: new Map(),
      scoreResults: new Map(),
      previousMajorTvlById: new Map(),
    });
  }

  it("keeps a global counter flag against its pre-event baseline until recovery", () => {
    const first = merged(623);

    expect(first.qualityDriftFlags).toEqual([]);
    expect(first.qualityDriftCandidates).toContainEqual({
      flag: "staged-merge-drop",
      consecutiveRuns: 1,
      baselineValue: 1_352,
      observedValue: 623,
    });

    const confirmed = merged(700, first.qualityDriftCandidates);

    expect(confirmed.qualityDriftFlags).toEqual(["staged-merge-drop"]);
    expect(confirmed.qualityDriftSeverity).toBe("medium");
    expect(confirmed.qualityDriftCandidates[0]?.baselineValue).toBe(1_352);

    const recovered = merged(1_300, confirmed.qualityDriftCandidates);

    expect(recovered.qualityDriftFlags).toEqual([]);
    expect(recovered.qualityDriftCandidates).toEqual([]);
  });
});
