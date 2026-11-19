import { getYieldHistorySampleAt, usesYieldObservationHistoryClock } from "@shared/lib/yield-source-history";
import { yieldStabilityToApyVarianceScore } from "@shared/lib/yield-scoring";
import { SLOW_NAV_SOURCE_KEYS, USYC_NAV_FUTURE_SKEW_SEC } from "@shared/lib/yield-source-cadence";
import type { ResolvedYield } from "./types";
import { type YieldHistorySnapshotRow } from "./history-repository";
import { weightedMedian } from "@shared/lib/stats";
import { DAY_SECONDS, THIRTY_DAYS_SECONDS } from "@shared/lib/time-constants";
import { isOnChainBootstrapYieldSeed } from "../../lib/yield-utils";
import type { YieldSourceFreshness } from "../../lib/yield-ranking-helpers";
import { computeYieldStability } from "../yield-helpers";
import { requiresYieldProviderObservationClock } from "./family-registry";

function hasReportClock(observedAt: number | null | undefined): observedAt is number {
  return typeof observedAt === "number" && Number.isSafeInteger(observedAt) && observedAt > 0;
}

export function computeYieldCandidateStatistics(
  y: ResolvedYield,
  historyRows: YieldHistorySnapshotRow[],
  usedLegacyHistory: boolean,
  startSec: number,
  sevenDaysAgoSec: number,
  sourceFreshness: YieldSourceFreshness,
) {
  const sourceKey = y.sourceKey;
  const usesReportClock = SLOW_NAV_SOURCE_KEYS.has(sourceKey);
  const requiresProviderClock = requiresYieldProviderObservationClock(y);
  const earliestReportAt = startSec - THIRTY_DAYS_SECONDS;
  const latestReportAt = startSec + USYC_NAV_FUTURE_SKEW_SEC;
  const hasWindowClock = (at: number | null | undefined): at is number =>
    hasReportClock(at) && at >= earliestReportAt && at <= latestReportAt;
  const providerObservationAt = requiresProviderClock && sourceFreshness === "fresh" && hasWindowClock(y.sourceObservedAt)
    ? y.sourceObservedAt : null;
  const currentSampleAt = usesReportClock
    ? (hasWindowClock(y.sourceObservedAt) ? y.sourceObservedAt : null)
    : getYieldHistorySampleAt(sourceKey, y.sourceObservedAt, startSec);
  // B26 — `isOnChainBootstrapYieldSeed` is lane-agnostic: the Tier-1 `onchain`
  // lane and the `protocol-api` NAV oracles (Ondo, Midas) both write the
  // anchor-without-yield seed shape, so a seed row must stay out of
  // apy7d/apy30d and the variance samples regardless of which lane recorded it.
  const historyRowsForStats = historyRows.filter((row) => !isOnChainBootstrapYieldSeed(row)
    && !(usesYieldObservationHistoryClock(sourceKey) && !usedLegacyHistory && y.sourceObservedAt != null
      && row.recorded_at === y.sourceObservedAt));
  const reports = new Map<number, YieldHistorySnapshotRow>();
  if (usesReportClock && !usedLegacyHistory) {
    for (const row of historyRowsForStats) {
      const reportAt = row.source_observed_at;
      if (!hasWindowClock(reportAt) || reportAt === currentSampleAt
        || !Number.isFinite(row.apy)) continue;
      const previous = reports.get(reportAt);
      if (!previous || row.recorded_at > previous.recorded_at) reports.set(reportAt, row);
    }
  }
  const samples: number[] = [];
  const apy7dSamples: number[] = [];
  const observationDays = new Set<number>();
  for (const row of usesReportClock ? reports.values() : historyRowsForStats) {
    const sampleAt = usesReportClock ? row.source_observed_at : row.recorded_at;
    if (sampleAt == null || !Number.isFinite(row.apy)) continue;
    const evidenceAt = requiresProviderClock
      ? (!usedLegacyHistory && row.source_observation_verified === 1 && hasWindowClock(row.source_observed_at)
        ? row.source_observed_at : null)
      : sampleAt;
    if (evidenceAt != null) observationDays.add(Math.floor(evidenceAt / DAY_SECONDS));
    samples.push(row.apy);
    if (sampleAt >= sevenDaysAgoSec) {
      apy7dSamples.push(row.apy);
    }
  }
  samples.push(y.currentApy);
  const currentEvidenceAt = requiresProviderClock ? providerObservationAt : currentSampleAt;
  if (currentEvidenceAt != null) observationDays.add(Math.floor(currentEvidenceAt / DAY_SECONDS));
  if (!usesReportClock || (currentSampleAt != null && currentSampleAt >= sevenDaysAgoSec) || apy7dSamples.length === 0) {
    apy7dSamples.push(y.currentApy);
  }

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
  const distinctObservationDays30d =
    (usedLegacyHistory && !requiresProviderClock) || observationDays.size === 0 ? null : observationDays.size;

  return {
    apy7d, apy30d, yieldStability, apyVarianceScore, stdDev30d, apyMin30d, apyMax30d,
    distinctObservationDays30d, sourceObservationVerified: providerObservationAt != null,
  };
}

export function computeTvlWeightedMedianApy(
  rows: Array<{ apy_30d: number; source_tvl_usd: number | null }>,
  minRows = 1,
): number | null {
  const validRows = rows.filter(
    (row) => row.source_tvl_usd != null && Number.isFinite(row.source_tvl_usd)
      && row.source_tvl_usd > 0 && Number.isFinite(row.apy_30d) && row.apy_30d > 0,
  );
  if (validRows.length < minRows) return null;

  return weightedMedian(
    validRows.map((row) => ({ value: row.apy_30d, weight: row.source_tvl_usd! })),
  );
}
