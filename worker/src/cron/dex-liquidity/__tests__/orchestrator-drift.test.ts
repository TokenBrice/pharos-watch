import { describe, expect, it } from "vitest";
import { DexLiquidityCronMetadataSchema } from "../../../lib/schemas";
import {
  computeDexLiquidityDriftSummary,
  DRIFT_REBASELINE_RUNS,
  REVIEWED_CHAIN_TVL_DISPOSITIONS,
  REVIEWED_SOURCE_FAMILY_DISPOSITIONS,
  readPreviousDexLiquidityDriftCandidates,
  type DexLiquidityDriftCandidate,
  type DexLiquidityDriftSummary,
} from "../orchestrator-drift";
import type { FullScoreResult } from "../types";
import { makeCompleteVolumeAvailability } from "../../__tests__/dex-liquidity-persistence.test-support";

function scoreResult(tvl: number, poolCount = 1): FullScoreResult {
  return {
    tvl, effectiveTvl: tvl, vol24h: tvl / 10,
    volumeAvailability: makeCompleteVolumeAvailability(tvl / 10, tvl), score: 46, hhi: 0.1, durability: 0.8,
    components: { tvlDepth: 16, volumeActivity: 20, poolQuality: 20, durability: 20, pairDiversity: 20 }, weightedBalanceRatio: 0.98,
    organicFrac: 0.9, avgStress: 5, lockedLiqPct: 0.2, coverageClass: "primary", coverageConfidence: 0.9,
    sourceMix: { dl: { poolCount, tvlUsd: tvl } }, balanceMeasuredTvlUsd: tvl, organicMeasuredTvlUsd: tvl * 0.9,
  };
}

function drift(input: Partial<Parameters<typeof computeDexLiquidityDriftSummary>[0]>) {
  return computeDexLiquidityDriftSummary({
    previousSummary: null, previousCandidates: [], priceObservations: new Map(),
    stagedMergedCount: 0, stagedSkippedCount: 0, weakCoverageCoinsBeforeFallback: 0,
    measuredBalanceCoveragePct: 1, watchlistPreviousById: new Map(), scoreResults: new Map(), previousMajorTvlById: new Map(), ...input,
  });
}

function cliff(input: {
    previousTvl: number | null;
  currentTvl: number;
  previousCandidates?: DexLiquidityDriftCandidate[];
  hasScoreRow?: boolean;
}): DexLiquidityDriftSummary {
  return drift({
    previousCandidates: input.previousCandidates ?? [],
    scoreResults:
      input.hasScoreRow === false ? new Map() : new Map([["usds-sky", scoreResult(input.currentTvl)]]),
    previousMajorTvlById: new Map<string, number>(input.previousTvl == null ? [] : [["usds-sky", input.previousTvl]]),
  });
}

function persist(summary: DexLiquidityDriftSummary) {
  return DexLiquidityCronMetadataSchema.parse(JSON.parse(JSON.stringify({ sourceCoverage: summary })));
}

function readCandidates(summary: DexLiquidityDriftSummary) {
  return readPreviousDexLiquidityDriftCandidates(persist(summary));
}

describe("computeDexLiquidityDriftSummary major TVL cliffs", () => {
  it.each([true, false])("drops archived cliffs even with carried candidates (prior row: %s)", (hasPriorRow) => {
    const summary = drift({
      previousCandidates: [{ flag: "major-tvl-cliff:cdxusd-cod3x", consecutiveRuns: 2, baselineValue: 86_583_463, observedValue: 0 }],
      previousMajorTvlById: new Map(hasPriorRow ? [["cdxusd-cod3x", 86_583_463]] : []),
    });
    expect(summary.majorTvlCliffs).toEqual([]);
    expect(summary.qualityDriftCandidates).toEqual([]);
    expect(summary.qualityDriftFlags).toEqual([]);
    expect(summary.qualityDriftSeverity).toBe("none");
  });

  it("clears a confirmed cliff once the value recovers against the pre-event baseline", () => {
    const confirmed = cliff({
      previousTvl: 152e6, currentTvl: 137e5,
      previousCandidates: [{ flag: "major-tvl-cliff:usds-sky", consecutiveRuns: 2, baselineValue: 152e6, observedValue: 1372e4 }],
    });
    const recovered = cliff({
      previousTvl: 137e5, currentTvl: 15e7, previousCandidates: confirmed.qualityDriftCandidates,
    });
    expect(confirmed.qualityDriftFlags).toEqual(["major-tvl-cliff:usds-sky"]);
    expect(recovered.qualityDriftFlags).toEqual([]);
    expect(recovered.qualityDriftCandidates).toEqual([]);
    expect(recovered.majorTvlCliffs).toEqual([]);
  });

  it("does not confirm a drop inside the documented methodology-recompute range", () => {
    const first = cliff({ previousTvl: 152e6, currentTvl: 99e6 });
    const second = cliff({
      previousTvl: 99e6, currentTvl: 96e6, previousCandidates: first.qualityDriftCandidates,
    });
    expect(first.qualityDriftCandidates).toEqual([]);
    expect(second.qualityDriftFlags).toEqual([]);
    expect(second.qualityDriftCandidates).toEqual([]);
  });

  it("ignores coins too small for their swings to mean anything", () => {
    const summary = cliff({ previousTvl: 2e6, currentTvl: 1e4 });
    expect(summary.qualityDriftCandidates).toEqual([]);
    expect(summary.majorTvlCliffs).toEqual([]);
  });

  it("treats a vanished score row as a total cliff", () => {
    const first = cliff({ previousTvl: 152e6, currentTvl: 0, hasScoreRow: false });
    const second = cliff({
      previousTvl: 152e6, currentTvl: 0, hasScoreRow: false, previousCandidates: first.qualityDriftCandidates,
    });
    expect(first.qualityDriftFlags).toEqual([]);
    expect(second.qualityDriftFlags).toEqual(["major-tvl-cliff:usds-sky"]);
    expect(second.majorTvlCliffs[0]?.currentTvlUsd).toBe(0);
  });
});

describe("computeDexLiquidityDriftSummary rebaseline of lasting drift", () => {
  function runCliffs(runCount: number): DexLiquidityDriftSummary[] {
    const summaries: DexLiquidityDriftSummary[] = [];
    let previousCandidates: DexLiquidityDriftCandidate[] = [];
    for (let run = 1; run <= runCount; run += 1) {
      const summary = cliff({ previousTvl: run === 1 ? 152e6 : null, currentTvl: 137e5, previousCandidates });
      summaries.push(summary);
      previousCandidates = readCandidates(summary);
    }
    return summaries;
  }

  it("reports a lasting cliff on runs 2 through 6 and accepts it as the new level on run 7", () => {
    const summaries = runCliffs(DRIFT_REBASELINE_RUNS + 1);
    const flaggedRuns = summaries.flatMap((summary, index) => (summary.qualityDriftFlags.length > 0 ? [index + 1] : []));
    expect(flaggedRuns).toEqual([2, 3, 4, 5, 6]);
    expect(summaries[DRIFT_REBASELINE_RUNS - 1]?.qualityDriftCandidates).toEqual([
      { flag: "major-tvl-cliff:usds-sky", consecutiveRuns: DRIFT_REBASELINE_RUNS, baselineValue: 152e6, observedValue: 137e5 },
    ]);
    expect(summaries.slice(0, DRIFT_REBASELINE_RUNS).every((summary) => summary.qualityDriftRebaselined.length === 0)).toBe(true);

    const accepted = summaries[DRIFT_REBASELINE_RUNS];
    expect(accepted?.qualityDriftFlags).toEqual([]);
    expect(accepted?.qualityDriftSeverity).toBe("none");
    expect(accepted?.qualityDriftCandidates).toEqual([]);
    expect(accepted?.majorTvlCliffs).toEqual([]);
    const evidence = [
      { flag: "major-tvl-cliff:usds-sky", baselineValue: 152e6, acceptedValue: 137e5, runs: 7 },
    ];
    expect(accepted?.qualityDriftRebaselined).toEqual(evidence);
    expect(accepted && persist(accepted).sourceCoverage.qualityDriftRebaselined).toEqual(evidence);
  });

  it("stays silent at the accepted level and detects a later step from it", () => {
    const accepted = runCliffs(DRIFT_REBASELINE_RUNS + 1)[DRIFT_REBASELINE_RUNS];
    const acceptedCandidates = accepted ? readCandidates(accepted) : [];

    const steady = cliff({ previousTvl: null, currentTvl: 1365e4, previousCandidates: acceptedCandidates });
    expect(steady.qualityDriftCandidates).toEqual([]);
    expect(steady.qualityDriftRebaselined).toEqual([]);

    const furtherDrop = cliff({ previousTvl: 1365e4, currentTvl: 6e6, previousCandidates: steady.qualityDriftCandidates });
    expect(furtherDrop.qualityDriftFlags).toEqual([]);
    expect(furtherDrop.qualityDriftCandidates).toEqual([
      { flag: "major-tvl-cliff:usds-sky", consecutiveRuns: 1, baselineValue: 1365e4, observedValue: 6e6 },
    ]);
    const confirmed = cliff({ previousTvl: null, currentTvl: 6e6, previousCandidates: furtherDrop.qualityDriftCandidates });
    expect(confirmed.qualityDriftFlags).toEqual(["major-tvl-cliff:usds-sky"]);
  });
});

describe("computeDexLiquidityDriftSummary watchlist pool counts", () => {
  const watchlistPreviousById = new Map([["usdc-circle", {
    stablecoin_id: "usdc-circle", pool_count: 151, coverage_confidence: 0.9, total_tvl_usd: 1e6, balance_measured_tvl_usd: 1e6,
  }]]);

  function watchlist(currentPublishedPools: number, previousCandidates: DexLiquidityDriftCandidate[] = []) {
    return drift({
      previousCandidates,
      watchlistPreviousById,
      scoreResults: new Map([["usdc-circle", scoreResult(1e6, currentPublishedPools)]]),
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
      flag: "watchlist-pool-drop:usdc-circle", consecutiveRuns: 2, baselineValue: 151, observedValue: 119,
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
    stagedMergedCount: number, previousCandidates: DexLiquidityDriftCandidate[] = [],
    previousStagedPoolsMerged = 1_352,
  ) {
    return drift({
      previousSummary: {
        stagedPoolsMerged: previousStagedPoolsMerged, stagedPoolsSkipped: 0, priceObservationCoins: 0, measuredBalanceCoveragePct: 0,
        weakCoverageCoins: 0, retainedPoolCountBySourceFamily: null,
      },
      previousCandidates,
      stagedMergedCount,
      measuredBalanceCoveragePct: 0,
    });
  }

  it("keeps a global counter flag against its pre-event baseline until recovery", () => {
    const first = merged(623);
    expect(first.qualityDriftFlags).toEqual([]);
    expect(first.qualityDriftCandidates).toContainEqual({
      flag: "staged-merge-drop", consecutiveRuns: 1, baselineValue: 1_352, observedValue: 623,
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

describe("computeDexLiquidityDriftSummary cohort drops", () => {
  it.each([
    [0, "2026-11-08", 1, 1, true], [0, "2026-11-07", 1, 1, false],
    [0, "2026-11-21T20:31:00Z", 1, 1, false], [0, "2026-11-08", 1.01, 1, false], [0, "2026-11-08", 1, 0.9, true], [1, "2026-11-08", 1, 0.9, false],
    [0, "2026-11-08", 1, 1.019, true], [0, "2026-11-08", 1, 1.021, false],
    [1, "2026-11-08", 1, 1, true],
    [2, "2026-11-08", 1, 1, true], [2, "2026-11-08", 1, 0.979, false], [2, "2026-11-08", 1.01, 1, false],
    [2, "2026-11-21T21:04:19Z", 1, 1, false],
    [3, "2026-11-09", 1, 1, true], [3, "2026-11-09", 1, 1.019, true], [4, "2026-11-09", 1, 1, true], [5, "2026-11-09", 1, 1, true],
  ] as const)("bounds chain review %s at %s (%s, %s)", (index, date, baselineScale, observedScale, accepted) => {
    const review = REVIEWED_CHAIN_TVL_DISPOSITIONS[index];
    const { flag, baselineValue, observedValue, reviewedAt, expiresAt, evidenceUrls, reason } = review;
    const level = observedValue * observedScale;
    const rebase = accepted && "acceptsLevel" in review;
    const summary = drift({
      nowSec: Date.parse(date) / 1000,
      previousCandidates: [{ flag: flag, baselineValue: baselineValue * baselineScale, observedValue: observedValue, consecutiveRuns: 122 }],
      currentChainTvl: { [flag.split(":")[1]]: level },
    });
    expect(summary.cohortDriftFlags).toEqual(accepted ? [] : [flag]);
    expect(summary.qualityDriftFlags).toEqual(summary.cohortDriftFlags);
    expect(summary.qualityDriftCandidates[0]?.consecutiveRuns).toBe(rebase ? undefined : 123);
    const persisted = persist(summary).sourceCoverage;
    expect(persisted.qualityDriftAccepted).toEqual(accepted ? [expect.objectContaining({
      flag: flag, expiresAt: expiresAt, evidenceUrls: [...evidenceUrls],
    })] : []);
    if (!accepted) return;
    const chain = flag.split(":")[1];
    const run = (value: number, previous: number, previousCandidates: DexLiquidityDriftCandidate[], date: string = rebase ? reviewedAt : expiresAt) => drift({
      nowSec: Date.parse(date) / 1000, previousCandidates, previousChainTvl: { [chain]: previous }, currentChainTvl: { [chain]: value },
    });
    expect(persisted.qualityDriftRebaselined).toEqual(rebase ? [{
      flag, baselineValue, acceptedValue: level, runs: 123, reviewedAt, expiresAt, evidenceUrls, reason,
    }] : []);
    const next = run(level, level, readCandidates(summary), expiresAt);
    expect(next.qualityDriftCandidates.map((c) => c.flag)).toEqual(rebase ? [] : [flag]);
    expect(next.qualityDriftRebaselined).toEqual([]);
    const drop = run(observedValue * 0.8, level, next.qualityDriftCandidates);
    expect(drop.cohortDriftFlags.includes(flag)).toBe(!rebase);
    expect(drop.qualityDriftCandidates[0]?.baselineValue).toBe(rebase ? level : baselineValue);
    expect(run(observedValue * 0.8, observedValue * 0.8, drop.qualityDriftCandidates).cohortDriftFlags).toEqual([flag]);
  });

  it.each<{ previousChainTvl: Record<string, number> | null; current: number }>([
    { previousChainTvl: { base: 8e6 }, current: 78e5 },
    { previousChainTvl: { base: 5e5 }, current: 5e5 },
    { previousChainTvl: { ethereum: 2e7 }, current: 0 },
    { previousChainTvl: null, current: 5e5 },
  ])("confirms chain loss with overwritten baseline $previousChainTvl", ({ previousChainTvl, current }) => {
    const first = drift({
      previousChainTvl: { base: 1e7, ethereum: 2e7 }, currentChainTvl: { base: current, ethereum: 2e7 },
    });
    expect(first.cohortDriftFlags).toEqual([]);
    expect(first.qualityDriftCandidates).toEqual([
      { flag: "chain-tvl-drop:base", consecutiveRuns: 1, baselineValue: 1e7, observedValue: current },
    ]);
    const confirmed = drift({
      previousCandidates: readCandidates(first),
      previousChainTvl,
      currentChainTvl: { base: current, ethereum: 2e7 },
    });
    expect(confirmed.qualityDriftFlags).toEqual(["chain-tvl-drop:base"]);
    expect(confirmed.cohortDriftFlags).toEqual(["chain-tvl-drop:base"]);
    expect(confirmed.qualityDriftSeverity).toBe("high");
  });

  it("keeps a lasting chain loss flagged instead of rebaselining it", () => {
    const first = drift({
      previousChainTvl: { base: 5e6 }, currentChainTvl: { base: 3e6 },
    });
    let previousCandidates = first.qualityDriftCandidates;
    let summary = first;
    for (let run = 1; run <= DRIFT_REBASELINE_RUNS + 2; run += 1) {
      summary = drift({
        previousCandidates,
        previousChainTvl: { base: 3e6 }, currentChainTvl: { base: 3e6 },
      });
      expect(summary.cohortDriftFlags).toEqual(["chain-tvl-drop:base"]);
      previousCandidates = summary.qualityDriftCandidates;
    }
    expect(summary.qualityDriftRebaselined).toEqual([]);
  });

  const mix = (tvlUsd: number, other = 1744e4) => ({
    dexscreener: { poolCount: 21, tvlUsd }, cg_onchain: { poolCount: 595, tvlUsd: other },
  });
  const flag = "source-family-drop:dexscreener";
  it.each([
    ["dust", 449.57, 0, 0, false, false, 21],
    ["USD1 re-attribution", 2309e4, 5e4, 2314e4, false, false, 21],
    ["real loss at materiality floor", 1e6, 0, 0, false, true, 21],
    ["exact 10% unexplained loss", 1e6, 9e5, 0, false, true, 21],
    ["below 10% unexplained loss", 1e6, 900_001, 0, false, false, 21],
    ["gains on another coin", 2309e4, 5e4, 2314e4, true, true, 21],
    ["too few pools", 1e6, 0, 0, false, false, 3],
  ] as const)("screens new candidates: %s", (_, baseline, current, gain, otherCoin, admitted, pools) => {
    const summary = drift({
      previousSourceFamilyPools: { dexscreener: pools }, currentSourceFamilyPools: { dexscreener: 0 },
      previousSourceMixById: new Map([["usd1", mix(baseline)], ["other", mix(0)]]), scoreResults: new Map([
        ["usd1", { ...scoreResult(current), sourceMix: mix(current, 1744e4 + (otherCoin ? 0 : gain)) }],
        ["other", { ...scoreResult(gain), sourceMix: mix(0, 1744e4 + (otherCoin ? gain : 0)) }],
      ]),
    });
    expect(summary.qualityDriftCandidates.map((candidate) => candidate.flag)).toEqual(admitted ? [flag] : []);
    expect(summary.cohortDriftFlags).toEqual([]);
  });

  it("persists real loss evidence, confirms after two runs, stays until pool recovery", () => {
    let previousCandidates: DexLiquidityDriftCandidate[] = [];
    for (let run = 1; run <= DRIFT_REBASELINE_RUNS + 2; run++) {
      const summary = drift({
        previousCandidates,
        previousSourceFamilyPools: { dexscreener: run === 1 ? 21 : 0 }, currentSourceFamilyPools: {},
        previousSourceMixById: new Map([["usd1", mix(run === 1 ? 2309e4 : 0)]]),
      });
      expect(summary.cohortDriftFlags).toEqual(run === 1 ? [] : [flag]);
      expect(summary.qualityDriftRebaselined).toEqual([]);
      previousCandidates = readCandidates(summary);
      expect(previousCandidates[0]).toMatchObject({
        baselineValue: 21, observedValue: 0, consecutiveRuns: run,
        sourceFamilyTvlEvidence: { explanation: "evaluated", baselineTvlUsd: 2309e4, currentTvlUsd: 0, unexplainedLossUsd: 2309e4 },
      });
    }
    const recovered = drift({ previousCandidates, currentSourceFamilyPools: { dexscreener: 21 } });
    expect(recovered.qualityDriftCandidates).toEqual([]);
    expect(recovered.qualityDriftFlags).toEqual([]);
  });

  it.each([
    ["dexscreener", 338, true, false], ["gecko_terminal", 23, true, false],
    ["dexscreener", 339, false, false], ["gecko_terminal", 338, false, false], ["dexscreener", 338, false, true],
  ] as const)("accepts only reviewed legacy %s baseline %s", (family, baselineValue, accepted, withEvidence) => {
    const flag = `source-family-drop:${family}`;
    const sourceFamilyTvlEvidence = { explanation: "evaluated", baselineTvlUsd: 9e6, currentTvlUsd: 0, unexplainedLossUsd: 9e6 } as const;
    const summary = drift({
      previousCandidates: [{ flag, baselineValue, observedValue: 0, consecutiveRuns: 7, ...(withEvidence ? { sourceFamilyTvlEvidence } : {}) }],
      currentSourceFamilyPools: {}, previousSourceMixById: new Map(),
    });
    expect(summary.cohortDriftFlags).toEqual(accepted ? [] : [flag]);
    expect(summary.qualityDriftCandidates.map((candidate) => candidate.consecutiveRuns)).toEqual(accepted ? [] : [8]);
    expect(persist(summary).sourceCoverage.qualityDriftAccepted).toEqual(
      accepted ? [REVIEWED_SOURCE_FAMILY_DISPOSITIONS.find((entry) => entry.flag === flag)] : [],
    );
  });

  it("allocates one coin's gains across both losing families once", () => {
    const first = drift({
      previousSourceFamilyPools: { dl: 10, dexscreener: 10 }, currentSourceFamilyPools: {},
      previousSourceMixById: new Map([["usd1", { dl: { poolCount: 10, tvlUsd: 1e7 }, ...mix(1e7, 0) }]]),
      scoreResults: new Map([["usd1", { ...scoreResult(1e7), sourceMix: mix(0, 1e7) }]]),
    });
    expect(first.qualityDriftCandidates.map((candidate) => candidate.sourceFamilyTvlEvidence?.unexplainedLossUsd)).toEqual([5e6, 5e6]);
    const second = drift({ previousCandidates: first.qualityDriftCandidates, currentSourceFamilyPools: {} });
    expect(second.cohortDriftFlags).toEqual(["source-family-drop:dl", flag]);
  });

  it("skips the comparison when prior evidence is unavailable", () => {
    const summary = drift({
      previousChainTvl: null, currentChainTvl: { ethereum: 1 }, previousSourceFamilyPools: null, currentSourceFamilyPools: {},
    });
    expect(summary.qualityDriftCandidates).toEqual([]);
    expect(summary.cohortDriftFlags).toEqual([]);
  });
});
