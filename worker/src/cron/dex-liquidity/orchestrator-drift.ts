import { DexLiquidityCronMetadataSchema } from "../../lib/schemas";
import type { DexPriceObs, FullScoreResult, LiquidityMetrics } from "./types";

export const DRIFT_WATCHLIST = ["usdc-circle", "usdt-tether", "dai-makerdao", "usds-sky", "usde-ethena"] as const;

export type PreviousDexLiquiditySummary = {
  stagedPoolsMerged: number;
  stagedPoolsSkipped: number;
  priceObservationCoins: number;
  measuredBalanceCoveragePct: number;
  weakCoverageCoins: number;
};

type DexLiquidityCronMetadata = ReturnType<typeof DexLiquidityCronMetadataSchema.parse>;

export function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

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

export interface DexLiquidityDriftSummary {
  qualityDriftFlags: string[];
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
}

export function computeDexLiquidityDriftSummary(params: {
  previousSummary: PreviousDexLiquiditySummary | null;
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
  retainedPoolsByStablecoin: Map<string, LiquidityMetrics["topPools"]>;
}): DexLiquidityDriftSummary {
  const watchlistDeltas = DRIFT_WATCHLIST.map((stablecoinId) => {
    const previous = params.watchlistPreviousById.get(stablecoinId);
    const currentScore = params.scoreResults.get(stablecoinId);
    const currentPools = params.retainedPoolsByStablecoin.get(stablecoinId)?.length ?? 0;
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
      currentPoolCount: currentPools,
      poolCountPctDelta: pctDelta(currentPools, previous?.pool_count ?? 0),
      previousCoverageConfidence: previous?.coverage_confidence ?? null,
      currentCoverageConfidence: currentScore?.coverageConfidence ?? null,
      previousMeasuredShare: previous ? round4(previousMeasuredShare) : null,
      currentMeasuredShare: currentScore ? round4(currentMeasuredShare) : null,
    };
  });

  const priceObservationPctDelta = params.previousSummary
    ? pctDelta(params.priceObservations.size, params.previousSummary.priceObservationCoins)
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

  const qualityDriftFlags: string[] = [];
  if (priceObservationPctDelta != null && priceObservationPctDelta <= -0.1) {
    qualityDriftFlags.push("price-observation-drop");
  }
  if (stagedPoolsMergedPctDelta != null && stagedPoolsMergedPctDelta <= -0.1) {
    qualityDriftFlags.push("staged-merge-drop");
  }
  if (measuredBalanceCoverageDelta != null && measuredBalanceCoverageDelta <= -0.08) {
    qualityDriftFlags.push("measured-balance-drop");
  }
  if (weakCoverageDelta != null && weakCoverageDelta >= 5) {
    qualityDriftFlags.push("weak-coverage-rise");
  }
  for (const delta of watchlistDeltas) {
    if (delta.poolCountPctDelta != null && delta.poolCountPctDelta <= -0.2) {
      qualityDriftFlags.push(`watchlist-pool-drop:${delta.stablecoinId}`);
    }
  }
  const qualityDriftSeverity: DexLiquidityDriftSummary["qualityDriftSeverity"] =
    qualityDriftFlags.length === 0
      ? "none"
      : qualityDriftFlags.some((flag) => flag === "measured-balance-drop" || flag.startsWith("watchlist-pool-drop:"))
        ? "high"
        : "medium";

  return {
    qualityDriftFlags,
    qualityDriftSeverity,
    qualityDriftMetrics: {
      previousPriceObservationCoins: params.previousSummary?.priceObservationCoins ?? null,
      currentPriceObservationCoins: params.priceObservations.size,
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
  };
}
