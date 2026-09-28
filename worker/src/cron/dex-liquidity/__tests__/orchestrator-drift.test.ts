import { describe, expect, it } from "vitest";
import { DexLiquidityCronMetadataSchema, type DexLiquidityCronMetadata } from "../../../lib/schemas";
import {
  computeDexLiquidityDriftSummary,
  DRIFT_REBASELINE_RUNS,
  readPreviousDexLiquidityDriftCandidates,
  type DexLiquidityDriftCandidate,
  type DexLiquidityDriftSummary,
} from "../orchestrator-drift";
import type { FullScoreResult } from "../types";
import { makeCompleteVolumeAvailability } from "../../__tests__/dex-liquidity-persistence.test-support";

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
    volumeAvailability: makeCompleteVolumeAvailability(tvl / 10, tvl),
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
  /** `null` when the coin is no longer among the previous run's ten largest. */
  previousTvl: number | null;
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
    previousMajorTvlById: new Map<string, number>(input.previousTvl == null ? [] : [["usds-sky", input.previousTvl]]),
  });
}

/** Writes the drift fields to cron metadata JSON and reads them back the way the next run does. */
function persistDriftSummary(summary: DexLiquidityDriftSummary): DexLiquidityCronMetadata {
  const json = JSON.stringify({
    sourceCoverage: {
      qualityDriftFlags: summary.qualityDriftFlags,
      qualityDriftCandidates: summary.qualityDriftCandidates,
      qualityDriftRebaselined: summary.qualityDriftRebaselined,
      qualityDriftSeverity: summary.qualityDriftSeverity,
    },
  });
  return DexLiquidityCronMetadataSchema.parse(JSON.parse(json));
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

describe("computeDexLiquidityDriftSummary rebaseline of lasting drift", () => {
  // A confirmed condition is reported on runs 2 through DRIFT_REBASELINE_RUNS
  // (6). The run that finds it holding a seventh consecutive time accepts the
  // lasting step as the new level, so an explained change cannot warn forever.
  // Each run reads its candidates back from persisted metadata, the same path
  // the cron takes between hourly runs.
  function runLastingCliff(runCount: number): DexLiquidityDriftSummary[] {
    const summaries: DexLiquidityDriftSummary[] = [];
    let previousCandidates: DexLiquidityDriftCandidate[] = [];
    for (let run = 1; run <= runCount; run += 1) {
      // After the first collapsed publication the coin drops out of the
      // previous top ten, so only the carried candidate keeps its baseline.
      const summary = cliff({ previousTvl: run === 1 ? 152_000_000 : null, currentTvl: 13_700_000, previousCandidates });
      summaries.push(summary);
      previousCandidates = readPreviousDexLiquidityDriftCandidates(persistDriftSummary(summary));
    }
    return summaries;
  }

  it("reports a lasting cliff on runs 2 through 6 and accepts it as the new level on run 7", () => {
    const summaries = runLastingCliff(DRIFT_REBASELINE_RUNS + 1);
    const flaggedRuns = summaries.flatMap((summary, index) => (summary.qualityDriftFlags.length > 0 ? [index + 1] : []));

    expect(flaggedRuns).toEqual([2, 3, 4, 5, 6]);
    expect(summaries[DRIFT_REBASELINE_RUNS - 1]?.qualityDriftCandidates).toEqual([
      {
        flag: "major-tvl-cliff:usds-sky",
        consecutiveRuns: DRIFT_REBASELINE_RUNS,
        baselineValue: 152_000_000,
        observedValue: 13_700_000,
      },
    ]);
    expect(summaries.slice(0, DRIFT_REBASELINE_RUNS).every((summary) => summary.qualityDriftRebaselined.length === 0)).toBe(true);

    const accepted = summaries[DRIFT_REBASELINE_RUNS];
    expect(accepted?.qualityDriftFlags).toEqual([]);
    expect(accepted?.qualityDriftSeverity).toBe("none");
    expect(accepted?.qualityDriftCandidates).toEqual([]);
    expect(accepted?.majorTvlCliffs).toEqual([]);
    const evidence = [
      { flag: "major-tvl-cliff:usds-sky", baselineValue: 152_000_000, acceptedValue: 13_700_000, runs: 7 },
    ];
    expect(accepted?.qualityDriftRebaselined).toEqual(evidence);
    expect(accepted && persistDriftSummary(accepted).sourceCoverage.qualityDriftRebaselined).toEqual(evidence);
  });

  it("stays silent at the accepted level and detects a later step from it", () => {
    const accepted = runLastingCliff(DRIFT_REBASELINE_RUNS + 1)[DRIFT_REBASELINE_RUNS];
    const acceptedCandidates = accepted ? readPreviousDexLiquidityDriftCandidates(persistDriftSummary(accepted)) : [];

    const steady = cliff({ previousTvl: null, currentTvl: 13_650_000, previousCandidates: acceptedCandidates });
    expect(steady.qualityDriftCandidates).toEqual([]);
    expect(steady.qualityDriftRebaselined).toEqual([]);

    const furtherDrop = cliff({ previousTvl: 13_650_000, currentTvl: 6_000_000, previousCandidates: steady.qualityDriftCandidates });
    expect(furtherDrop.qualityDriftFlags).toEqual([]);
    expect(furtherDrop.qualityDriftCandidates).toEqual([
      { flag: "major-tvl-cliff:usds-sky", consecutiveRuns: 1, baselineValue: 13_650_000, observedValue: 6_000_000 },
    ]);
    const confirmed = cliff({ previousTvl: null, currentTvl: 6_000_000, previousCandidates: furtherDrop.qualityDriftCandidates });
    expect(confirmed.qualityDriftFlags).toEqual(["major-tvl-cliff:usds-sky"]);
  });

  it("detects the same hole again after the accepted level recovers", () => {
    const accepted = runLastingCliff(DRIFT_REBASELINE_RUNS + 1)[DRIFT_REBASELINE_RUNS];

    const recovered = cliff({
      previousTvl: null,
      currentTvl: 150_000_000,
      previousCandidates: accepted?.qualityDriftCandidates ?? [],
    });
    expect(recovered.qualityDriftFlags).toEqual([]);
    expect(recovered.qualityDriftCandidates).toEqual([]);

    const collapsed = cliff({ previousTvl: 150_000_000, currentTvl: 13_700_000 });
    const reconfirmed = cliff({ previousTvl: null, currentTvl: 13_700_000, previousCandidates: collapsed.qualityDriftCandidates });
    expect(collapsed.qualityDriftCandidates[0]?.consecutiveRuns).toBe(1);
    expect(reconfirmed.qualityDriftFlags).toEqual(["major-tvl-cliff:usds-sky"]);
    expect(reconfirmed.majorTvlCliffs[0]?.previousTvlUsd).toBe(150_000_000);
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

  it("accepts a watchlist pool drop that outlives the rebaseline window", () => {
    let previousCandidates: DexLiquidityDriftCandidate[] = [];
    let summary = watchlist(119);
    for (let run = 1; run <= DRIFT_REBASELINE_RUNS + 1; run += 1) {
      summary = watchlist(119, previousCandidates);
      previousCandidates = summary.qualityDriftCandidates;
      if (run === DRIFT_REBASELINE_RUNS) expect(summary.qualityDriftFlags).toEqual(["watchlist-pool-drop:usdc-circle"]);
    }

    expect(summary.qualityDriftFlags).toEqual([]);
    expect(summary.qualityDriftCandidates).toEqual([]);
    expect(summary.qualityDriftRebaselined).toEqual([
      { flag: "watchlist-pool-drop:usdc-circle", baselineValue: 151, acceptedValue: 119, runs: 7 },
    ]);
  });
});

describe("computeDexLiquidityDriftSummary global counters", () => {
  function merged(
    stagedMergedCount: number,
    previousCandidates: DexLiquidityDriftCandidate[] = [],
    previousStagedPoolsMerged = 1_352,
  ) {
    return computeDexLiquidityDriftSummary({
      previousSummary: {
        stagedPoolsMerged: previousStagedPoolsMerged,
        stagedPoolsSkipped: 0,
        priceObservationCoins: 0,
        measuredBalanceCoveragePct: 0,
        weakCoverageCoins: 0,
      },
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

  it("accepts a lasting global counter drop and measures later runs from the accepted value", () => {
    let previousCandidates: DexLiquidityDriftCandidate[] = [];
    const flaggedRuns: number[] = [];
    let summary = merged(623);
    for (let run = 1; run <= DRIFT_REBASELINE_RUNS + 1; run += 1) {
      // The published summary moves to the collapsed value after run 1; the
      // carried candidate keeps the pre-event baseline until acceptance.
      summary = merged(623, previousCandidates, run === 1 ? 1_352 : 623);
      if (summary.qualityDriftFlags.length > 0) flaggedRuns.push(run);
      previousCandidates = summary.qualityDriftCandidates;
    }

    expect(flaggedRuns).toEqual([2, 3, 4, 5, 6]);
    expect(summary.qualityDriftSeverity).toBe("none");
    expect(summary.qualityDriftRebaselined).toEqual([
      { flag: "staged-merge-drop", baselineValue: 1_352, acceptedValue: 623, runs: 7 },
    ]);

    expect(merged(620, summary.qualityDriftCandidates, 623).qualityDriftCandidates).toEqual([]);
    expect(merged(500, summary.qualityDriftCandidates, 623).qualityDriftCandidates).toEqual([
      { flag: "staged-merge-drop", consecutiveRuns: 1, baselineValue: 623, observedValue: 500 },
    ]);
  });
});
