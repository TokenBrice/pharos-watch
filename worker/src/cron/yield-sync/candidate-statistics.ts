import { getYieldHistorySampleAt, usesYieldObservationHistoryClock } from "@shared/lib/yield-source-history";
import { yieldStabilityToApyVarianceScore } from "@shared/lib/yield-scoring";
import { SLOW_NAV_SOURCE_KEYS, USYC_NAV_FUTURE_SKEW_SEC } from "@shared/lib/yield-source-cadence";
import type { ResolvedYield } from "./types";
import { type YieldHistorySnapshotRow } from "./history-repository";
import { weightedMedian } from "@shared/lib/stats";
import { DAY_SECONDS, THIRTY_DAYS_SECONDS } from "@shared/lib/time-constants";
import { isOnChainBootstrapYieldSeed } from "../../lib/yield-utils";
import type { YieldSourceFreshness } from "../../lib/yield-ranking-helpers";
import { computeApyFromRate, computeYieldStability, isDeterministicApyWithinSanityBounds } from "../yield-helpers";
import { requiresYieldProviderObservationClock } from "./family-registry";

function hasReportClock(observedAt: number | null | undefined): observedAt is number {
  return typeof observedAt === "number" && Number.isSafeInteger(observedAt) && observedAt > 0;
}

/**
 * 30-day APY of an on-chain rate source, measured from its share price (yield
 * v8.57). Each sample on this lane is already a trailing-7-day annualized rate
 * change, so their mean lags the share price and spans about 37 days. The
 * anchor is the oldest rate this source published in the window, at least as
 * old as the lane's own comparison anchor; a bootstrap seed is a valid one.
 * Null keeps the sample mean: another lane, a reward leg, legacy history, no
 * anchor that old, or a result outside the deterministic sanity bound.
 */
function resolveSharePriceApy30d(
  y: ResolvedYield,
  historyRows: YieldHistorySnapshotRow[],
  usedLegacyHistory: boolean,
  startSec: number,
  sevenDaysAgoSec: number,
): { apy: number; anchorObservedAt: number } | null {
  if (y.dataSource !== "onchain" || usedLegacyHistory || y.apyReward || y.exchangeRate == null) return null;
  let anchor: { rate: number; at: number } | null = null;
  for (const row of historyRows) {
    const rate = row.exchange_rate;
    if (row.source_key !== y.sourceKey || row.data_source !== "onchain" || rate == null
      || !Number.isFinite(rate) || rate <= 0 || row.recorded_at > sevenDaysAgoSec
      || row.recorded_at < startSec - THIRTY_DAYS_SECONDS) continue;
    if (!anchor || row.recorded_at < anchor.at) anchor = { rate, at: row.recorded_at };
  }
  if (!anchor) return null;
  const apy = computeApyFromRate(y.exchangeRate, anchor.rate, (startSec - anchor.at) / DAY_SECONDS);
  return typeof apy === "number" && isDeterministicApyWithinSanityBounds(apy) ? { apy, anchorObservedAt: anchor.at } : null;
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
  // Warnings, the zero-yield rejection and the standard deviation keep the
  // sample mean, so a share-price figure never changes what they compare.
  const apy30dSampleMean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const sharePrice = resolveSharePriceApy30d(y, historyRows, usedLegacyHistory, startSec, sevenDaysAgoSec);
  const apy30d = sharePrice?.apy ?? apy30dSampleMean;
  // B5: score the same variance the read path re-derives from the 2-dp rounded
  // `yieldStability` (computeYieldStability rounds), so the served PYS cannot
  // diverge from the published one and emit a phantom ±1 `pysDelta`.
  const yieldStability = computeYieldStability(samples);
  const apyVarianceScore = yieldStabilityToApyVarianceScore(yieldStability);
  const stdDev30d =
    samples.length >= 2
      ? Math.sqrt(samples.reduce((sum, value) => sum + (value - apy30dSampleMean) ** 2, 0) / samples.length)
      : null;
  const apyMin30d = samples.length > 0 ? samples.reduce((min, value) => Math.min(min, value), Infinity) : null;
  const apyMax30d = samples.length > 0 ? samples.reduce((max, value) => Math.max(max, value), -Infinity) : null;
  const distinctObservationDays30d =
    (usedLegacyHistory && !requiresProviderClock) || observationDays.size === 0 ? null : observationDays.size;

  return {
    apy7d, apy30d, apy30dSampleMean, apy30dAnchorObservedAt: sharePrice?.anchorObservedAt ?? null,
    yieldStability, apyVarianceScore, stdDev30d, apyMin30d, apyMax30d,
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
