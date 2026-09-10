import { round4 } from "@shared/lib/math";
import { DexLiquidityCronMetadataSchema } from "../../lib/schemas";
import type { DexPriceObs, FullScoreResult } from "./types";

// Re-exported so existing `./orchestrator-drift` consumers keep their import path.
export { round4 };

export const DRIFT_WATCHLIST = ["usdc-circle", "usdt-tether", "dai-makerdao", "usds-sky", "usde-ethena"] as const;

/**
 * A drift condition has to hold for this many consecutive productive runs,
 * measured against the same pre-event baseline, before it becomes a reported
 * flag. A single-generation diff both fires and self-silences on one noisy
 * hour, because the collapsed value becomes the next baseline as soon as it
 * publishes. Confirmation removes every one-hour blip and, in exchange, keeps
 * a real loss visible until the value recovers.
 */
export const DRIFT_CONFIRMATION_RUNS = 2;

export type PreviousDexLiquiditySummary = {
  stagedPoolsMerged: number;
  stagedPoolsSkipped: number;
  priceObservationCoins: number;
  measuredBalanceCoveragePct: number;
  weakCoverageCoins: number;
};

/**
 * Pending or confirmed drift condition carried between runs. `baselineValue`
 * is the pre-event baseline — the last run whose value was not itself flagged —
 * and never the previous run's already-collapsed value, so a condition that is
 * still present stays reported after the publication that overwrote the row it
 * was first measured against.
 */
export interface DexLiquidityDriftCandidate {
  flag: string;
  consecutiveRuns: number;
  baselineValue: number;
  observedValue: number;
}

type DexLiquidityCronMetadata = ReturnType<typeof DexLiquidityCronMetadataSchema.parse>;

function pctDelta(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return round4((current - previous) / previous);
}

export function readPreviousDexLiquiditySummary(parsed: DexLiquidityCronMetadata | null): PreviousDexLiquiditySummary | null {
  if (!parsed) return null;
  return {
    stagedPoolsMerged: parsed.stagedPoolsMerged ?? 0,
    stagedPoolsSkipped: parsed.stagedPoolsSkipped ?? 0,
    priceObservationCoins: parsed.sourceCoverage.priceObservationCoins ?? 0,
    measuredBalanceCoveragePct: parsed.sourceCoverage.measuredBalanceCoveragePct ?? 0,
    weakCoverageCoins: parsed.sourceCoverage.weakCoverageCoins ?? 0,
  };
}

export function readPreviousDexLiquidityDriftCandidates(
  parsed: DexLiquidityCronMetadata | null,
): DexLiquidityDriftCandidate[] {
  const candidates = parsed?.sourceCoverage.qualityDriftCandidates;
  if (!candidates) return [];
  return candidates.filter((candidate) => Number.isFinite(candidate.baselineValue));
}

/**
 * A previously-major coin whose TVL lands below this fraction of its prior
 * published value is reported as a per-coin cliff. Same bound as
 * `hardValueGuard`/`hardMajorCoverageGuard`, which abort the run on the same
 * ratio in aggregate. Those aggregate guards cannot see a single coin's hole:
 * USDS shed ~91% of its measured TVL on 2026-08-20 while global and top-10
 * totals stayed inside every bound, and edition #179 published the hole as news.
 */
const MAJOR_TVL_CLIFF_RATIO = 0.6;

/** Prior TVL below this is dust oscillation, not a cliff worth flagging. */
const MAJOR_TVL_CLIFF_MIN_PREVIOUS_USD = 5_000_000;

const MAJOR_TVL_CLIFF_FLAG_PREFIX = "major-tvl-cliff:";

export interface DexLiquidityDriftWatchlistDelta {
  stablecoinId: string;
  previousPoolCount: number;
  currentPoolCount: number;
  poolCountPctDelta: number | null;
  previousCoverageConfidence: number | null;
  currentCoverageConfidence: number | null;
  previousMeasuredShare: number | null;
  currentMeasuredShare: number | null;
}

export interface DexLiquidityMajorTvlCliff {
  stablecoinId: string;
  previousTvlUsd: number;
  currentTvlUsd: number;
  tvlPctDelta: number | null;
}

export interface DexLiquidityDriftSummary {
  qualityDriftFlags: string[];
  qualityDriftCandidates: DexLiquidityDriftCandidate[];
  qualityDriftSeverity: "none" | "medium" | "high";
  qualityDriftMetrics: {
    previousPriceObservationCoins: number | null;
    currentPriceObservationCoins: number;
    priceObservationPctDelta: number | null;
    previousMeasuredBalanceCoveragePct: number | null;
    currentMeasuredBalanceCoveragePct: number;
    measuredBalanceCoverageDelta: number | null;
    previousStagedPoolsMerged: number | null;
    currentStagedPoolsMerged: number;
    stagedPoolsMergedPctDelta: number | null;
    previousStagedPoolsSkipped: number | null;
    currentStagedPoolsSkipped: number;
    stagedPoolsSkippedPctDelta: number | null;
    previousWeakCoverageCoins: number | null;
    currentWeakCoverageCoins: number;
    weakCoverageDelta: number | null;
  };
  topAssetCoverageDeltas: DexLiquidityDriftWatchlistDelta[];
  majorTvlCliffs: DexLiquidityMajorTvlCliff[];
}

/**
 * Advances one pending condition by a run. The pre-event baseline from a
 * previous candidate wins over this run's own previous value; a condition that
 * no longer holds against that baseline clears the candidate, which is how a
 * confirmed flag ends.
 */
function advanceDriftCandidate(
  previous: DexLiquidityDriftCandidate | undefined,
  naturalBaseline: number,
  conditionHolds: (baselineValue: number) => boolean,
): Pick<DexLiquidityDriftCandidate, "baselineValue" | "consecutiveRuns"> | null {
  const baselineValue =
    previous && Number.isFinite(previous.baselineValue) ? previous.baselineValue : naturalBaseline;
  if (!Number.isFinite(baselineValue) || !conditionHolds(baselineValue)) return null;
  const previousRuns = previous && Number.isFinite(previous.consecutiveRuns) ? previous.consecutiveRuns : 0;
  return { baselineValue, consecutiveRuns: Math.max(0, previousRuns) + 1 };
}

export function computeDexLiquidityDriftSummary(params: {
  previousSummary: PreviousDexLiquiditySummary | null;
  previousCandidates: DexLiquidityDriftCandidate[];
  priceObservations: Map<string, DexPriceObs[]>;
  stagedMergedCount: number;
  stagedSkippedCount: number;
  weakCoverageCoinsBeforeFallback: number;
  measuredBalanceCoveragePct: number;
  watchlistPreviousById: Map<string, {
    stablecoin_id: string;
    pool_count: number;
    coverage_confidence: number | null;
    total_tvl_usd: number;
    balance_measured_tvl_usd: number;
  }>;
  scoreResults: Map<string, FullScoreResult>;
  /**
   * Prior published TVL for the coins that were the largest by TVL last run.
   * Reuses the rows the major-coverage guard already loads: a per-coin cliff
   * only matters for coins big enough to be part of the market's exit capacity.
   */
  previousMajorTvlById: Map<string, number>;
}): DexLiquidityDriftSummary {
  const previousCandidatesByFlag = new Map(params.previousCandidates.map((candidate) => [candidate.flag, candidate]));
  const candidates: DexLiquidityDriftCandidate[] = [];
  const qualityDriftFlags: string[] = [];

  const confirmCondition = (
    flag: string,
    naturalBaseline: number,
    observedValue: number,
    conditionHolds: (baselineValue: number) => boolean,
  ): DexLiquidityDriftCandidate | null => {
    const advanced = advanceDriftCandidate(previousCandidatesByFlag.get(flag), naturalBaseline, conditionHolds);
    if (!advanced) return null;
    const candidate: DexLiquidityDriftCandidate = { flag, ...advanced, observedValue };
    candidates.push(candidate);
    if (advanced.consecutiveRuns >= DRIFT_CONFIRMATION_RUNS) qualityDriftFlags.push(flag);
    return candidate;
  };

  const watchlistDeltas = DRIFT_WATCHLIST.map((stablecoinId) => {
    const previous = params.watchlistPreviousById.get(stablecoinId);
    const currentScore = params.scoreResults.get(stablecoinId);
    // The coin's published pool count — the quantity persistence writes to
    // `dex_liquidity.pool_count` — instead of a curated subset of the same pool
    // set, so the delta always compares like with like.
    const currentPoolCount = Object.values(currentScore?.sourceMix ?? {}).reduce(
      (sum, entry) => sum + (entry?.poolCount ?? 0),
      0,
    );
    const currentMeasuredShare =
      currentScore && currentScore.tvl > 0
        ? Math.max(0, Math.min(1, currentScore.balanceMeasuredTvlUsd / currentScore.tvl))
        : 0;
    const previousMeasuredShare =
      previous && previous.total_tvl_usd > 0
        ? Math.max(0, Math.min(1, (previous.balance_measured_tvl_usd ?? 0) / previous.total_tvl_usd))
        : 0;
    return {
      stablecoinId,
      previousPoolCount: previous?.pool_count ?? 0,
      currentPoolCount,
      poolCountPctDelta: pctDelta(currentPoolCount, previous?.pool_count ?? 0),
      previousCoverageConfidence: previous?.coverage_confidence ?? null,
      currentCoverageConfidence: currentScore?.coverageConfidence ?? null,
      previousMeasuredShare: previous ? round4(previousMeasuredShare) : null,
      currentMeasuredShare: currentScore ? round4(currentMeasuredShare) : null,
    };
  });

  const cliffBaselines = new Map<string, number>();
  for (const [stablecoinId, previousTvlUsd] of params.previousMajorTvlById) {
    if (previousTvlUsd < MAJOR_TVL_CLIFF_MIN_PREVIOUS_USD) continue;
    cliffBaselines.set(stablecoinId, previousTvlUsd);
  }
  // A confirmed cliff keeps its pre-event baseline even once the coin drops out
  // of the previous top ten, which is exactly when the overwritten baseline
  // would otherwise hide it.
  for (const candidate of params.previousCandidates) {
    if (!candidate.flag.startsWith(MAJOR_TVL_CLIFF_FLAG_PREFIX)) continue;
    const stablecoinId = candidate.flag.slice(MAJOR_TVL_CLIFF_FLAG_PREFIX.length);
    if (stablecoinId.length === 0 || !Number.isFinite(candidate.baselineValue)) continue;
    if (!cliffBaselines.has(stablecoinId)) cliffBaselines.set(stablecoinId, candidate.baselineValue);
  }

  const majorTvlCliffs: DexLiquidityMajorTvlCliff[] = [];
  for (const [stablecoinId, naturalBaseline] of cliffBaselines) {
    const currentTvlUsd = params.scoreResults.get(stablecoinId)?.tvl ?? 0;
    const candidate = confirmCondition(
      `${MAJOR_TVL_CLIFF_FLAG_PREFIX}${stablecoinId}`,
      naturalBaseline,
      currentTvlUsd,
      (baselineValue) => currentTvlUsd < baselineValue * MAJOR_TVL_CLIFF_RATIO,
    );
    if (!candidate) continue;
    majorTvlCliffs.push({
      stablecoinId,
      previousTvlUsd: candidate.baselineValue,
      currentTvlUsd,
      tvlPctDelta: pctDelta(currentTvlUsd, candidate.baselineValue),
    });
  }

  const priceObservationCoins = params.priceObservations.size;
  const priceObservationPctDelta = params.previousSummary
    ? pctDelta(priceObservationCoins, params.previousSummary.priceObservationCoins)
    : null;
  const stagedPoolsMergedPctDelta = params.previousSummary
    ? pctDelta(params.stagedMergedCount, params.previousSummary.stagedPoolsMerged)
    : null;
  const stagedPoolsSkippedPctDelta = params.previousSummary
    ? pctDelta(params.stagedSkippedCount, params.previousSummary.stagedPoolsSkipped)
    : null;
  const measuredBalanceCoverageDelta = params.previousSummary
    ? round4(params.measuredBalanceCoveragePct - params.previousSummary.measuredBalanceCoveragePct)
    : null;
  const weakCoverageDelta = params.previousSummary
    ? params.weakCoverageCoinsBeforeFallback - params.previousSummary.weakCoverageCoins
    : null;

  if (params.previousSummary) {
    const previous = params.previousSummary;
    confirmCondition("price-observation-drop", previous.priceObservationCoins, priceObservationCoins, (baselineValue) => {
      const delta = pctDelta(priceObservationCoins, baselineValue);
      return delta != null && delta <= -0.1;
    });
    confirmCondition("staged-merge-drop", previous.stagedPoolsMerged, params.stagedMergedCount, (baselineValue) => {
      const delta = pctDelta(params.stagedMergedCount, baselineValue);
      return delta != null && delta <= -0.1;
    });
    confirmCondition(
      "measured-balance-drop",
      previous.measuredBalanceCoveragePct,
      params.measuredBalanceCoveragePct,
      (baselineValue) => round4(params.measuredBalanceCoveragePct - baselineValue) <= -0.08,
    );
    confirmCondition(
      "weak-coverage-rise",
      previous.weakCoverageCoins,
      params.weakCoverageCoinsBeforeFallback,
      (baselineValue) => params.weakCoverageCoinsBeforeFallback - baselineValue >= 5,
    );
  }

  for (const delta of watchlistDeltas) {
    confirmCondition(
      `watchlist-pool-drop:${delta.stablecoinId}`,
      delta.previousPoolCount,
      delta.currentPoolCount,
      (baselineValue) => {
        const change = pctDelta(delta.currentPoolCount, baselineValue);
        return change != null && change <= -0.2;
      },
    );
  }

  const qualityDriftSeverity: DexLiquidityDriftSummary["qualityDriftSeverity"] =
    qualityDriftFlags.length === 0
      ? "none"
      : qualityDriftFlags.some(
            (flag) =>
              flag === "measured-balance-drop" ||
              flag.startsWith("watchlist-pool-drop:") ||
              flag.startsWith(MAJOR_TVL_CLIFF_FLAG_PREFIX),
          )
        ? "high"
        : "medium";

  return {
    qualityDriftFlags,
    qualityDriftCandidates: candidates,
    qualityDriftSeverity,
    qualityDriftMetrics: {
      previousPriceObservationCoins: params.previousSummary?.priceObservationCoins ?? null,
      currentPriceObservationCoins: priceObservationCoins,
      priceObservationPctDelta,
      previousMeasuredBalanceCoveragePct: params.previousSummary?.measuredBalanceCoveragePct ?? null,
      currentMeasuredBalanceCoveragePct: params.measuredBalanceCoveragePct,
      measuredBalanceCoverageDelta,
      previousStagedPoolsMerged: params.previousSummary?.stagedPoolsMerged ?? null,
      currentStagedPoolsMerged: params.stagedMergedCount,
      stagedPoolsMergedPctDelta,
      previousStagedPoolsSkipped: params.previousSummary?.stagedPoolsSkipped ?? null,
      currentStagedPoolsSkipped: params.stagedSkippedCount,
      stagedPoolsSkippedPctDelta,
      previousWeakCoverageCoins: params.previousSummary?.weakCoverageCoins ?? null,
      currentWeakCoverageCoins: params.weakCoverageCoinsBeforeFallback,
      weakCoverageDelta,
    },
    topAssetCoverageDeltas: watchlistDeltas,
    majorTvlCliffs,
  };
}
