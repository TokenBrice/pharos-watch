import { getYieldHistorySampleAt, usesYieldObservationHistoryClock } from "@shared/lib/yield-source-history";
import { yieldStabilityToApyVarianceScore } from "@shared/lib/yield-scoring";
import type { ResolvedYield } from "./types";
import { type YieldHistorySnapshotRow } from "./history-repository";
import { weightedMedian } from "@shared/lib/stats";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { isOnChainBootstrapYieldSeed } from "../../lib/yield/yield-utils";
import { computeYieldStability } from "./yield-helpers";

export function computeYieldCandidateStatistics(
  y: ResolvedYield,
  historyRows: YieldHistorySnapshotRow[],
  usedLegacyHistory: boolean,
  startSec: number,
  sevenDaysAgoSec: number,
) {
  const sourceKey = y.sourceKey;
  // B26 — `isOnChainBootstrapYieldSeed` is lane-agnostic: the Tier-1 `onchain`
  // lane and the `protocol-api` NAV oracles (Ondo, Midas) both write the
  // anchor-without-yield seed shape, so a seed row must stay out of
  // apy7d/apy30d and the variance samples regardless of which lane recorded it.
  const historyRowsForStats = historyRows.filter((row) => !isOnChainBootstrapYieldSeed(row)
    && !(usesYieldObservationHistoryClock(sourceKey) && !usedLegacyHistory && y.sourceObservedAt != null
      && row.recorded_at === y.sourceObservedAt));
  const samples: number[] = [];
  const apy7dSamples: number[] = [];
  for (const row of historyRowsForStats) {
    if (!Number.isFinite(row.apy)) continue;
    samples.push(row.apy);
    if (row.recorded_at >= sevenDaysAgoSec) {
      apy7dSamples.push(row.apy);
    }
  }
  samples.push(y.currentApy);
  apy7dSamples.push(y.currentApy);

  const apy7d = apy7dSamples.reduce((sum, value) => sum + value, 0) / apy7dSamples.length;
  const apy30d = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  // B5: score the same variance the read path re-derives from the 2-dp rounded
  // `yieldStability` (computeYieldStability rounds), so the served PYS cannot
  // diverge from the published one and emit a phantom ±1 `pysDelta`.
  const yieldStability = computeYieldStability(samples);
  const apyVarianceScore = yieldStabilityToApyVarianceScore(yieldStability);
  const stdDev30d =
    samples.length >= 2
      ? Math.sqrt(samples.reduce((sum, value) => sum + (value - apy30d) ** 2, 0) / samples.length)
      : null;
  const apyMin30d = samples.length > 0 ? samples.reduce((min, value) => Math.min(min, value), Infinity) : null;
  const apyMax30d = samples.length > 0 ? samples.reduce((max, value) => Math.max(max, value), -Infinity) : null;
  const distinctObservationDays30d = usedLegacyHistory
    ? null
    : new Set([
        ...historyRowsForStats.map((row) => Math.floor(row.recorded_at / DAY_SECONDS)),
        Math.floor(getYieldHistorySampleAt(sourceKey, y.sourceObservedAt, startSec) / DAY_SECONDS),
      ]).size;

  return { apy7d, apy30d, yieldStability, apyVarianceScore, stdDev30d, apyMin30d, apyMax30d, distinctObservationDays30d };
}

export function computeTvlWeightedMedianApy(
  rows: Array<{ apy_30d: number; source_tvl_usd: number | null }>,
): number | null {
  const validRows = rows.filter(
    (row) => row.source_tvl_usd != null && Number.isFinite(row.source_tvl_usd)
      && row.source_tvl_usd > 0 && Number.isFinite(row.apy_30d) && row.apy_30d > 0,
  );
  if (validRows.length === 0) return null;

  return weightedMedian(
    validRows.map((row) => ({ value: row.apy_30d, weight: row.source_tvl_usd! })),
  );
}
