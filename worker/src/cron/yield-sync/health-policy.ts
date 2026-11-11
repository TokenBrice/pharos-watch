import type { YieldBenchmarkMeta, YieldSourceInputMeta } from "@shared/types/yield";
import { classifyYieldBenchmarkFreshness } from "@shared/lib/yield-benchmark-freshness";
import { STATUS_YIELD_HEALTH_THRESHOLDS } from "@shared/lib/status-thresholds";
import type { EvaluatedYieldSource } from "./evaluation";
import {
  buildNextDeterministicOnChainHealthState,
  persistDeterministicOnChainHealthState,
  type StablecoinSupplyMapState,
  type YieldSupplementalCacheMeta,
} from "./state";
import {
  derivePreviousYieldRankingsCount,
  type PreviousYieldPublicationRanking,
  type PreviousYieldPublicationSnapshot,
} from "./publication";
import { REQUIRED_SUPPLEMENTAL_SOURCE_FAMILY_KEYS } from "./family-registry";
import { ON_CHAIN_RATE_CONFIGS } from "../../lib/yield-config/yield-config-rate-sources";
import type { CronResult } from "../../lib/cron-logger";
import { createCronResult, type CronMetadataRecord } from "../../lib/cron-result";
import { logWorkerEventArgs } from "../../lib/structured-log";

export function buildYieldDegradationReasons(params: {
  safetyCoverageRatio: number | null;
  defaultBenchmarkMeta: YieldBenchmarkMeta;
  riskFreeRateRegistryCacheState?: string;
  selectedSources: readonly EvaluatedYieldSource[];
  dlPoolsMeta: YieldSourceInputMeta;
  supplementalMeta: YieldSupplementalCacheMeta;
  stablecoinSupplyMapState: StablecoinSupplyMapState;
  allDeterministicFailed: boolean;
  maskedAllDeterministicFailure: boolean;
  onChainSkippedDueToCooldown: boolean;
  onChainAlternativeCoverageMissingIds: string[];
  previousTvlRowsTruncated: boolean;
}): string[] {
  const degradationReasons: string[] = [];
  // All-rejected arbitration retains a diagnostic winner, never a public row.
  const selectedSources = params.selectedSources.filter((source) => !source.rejected);

  if (params.safetyCoverageRatio == null) {
    degradationReasons.push("safety-snapshot-unavailable");
  } else if (params.safetyCoverageRatio < STATUS_YIELD_HEALTH_THRESHOLDS.safetyCoverageRatio) {
    degradationReasons.push("safety-snapshot-coverage");
  }
  if (params.riskFreeRateRegistryCacheState === "invalid") {
    degradationReasons.push("yield-benchmarks:registry-invalid");
  }
  const defaultBenchmarkFreshness = classifyYieldBenchmarkFreshness(params.defaultBenchmarkMeta);
  if (defaultBenchmarkFreshness !== "healthy") {
    degradationReasons.push(
      `risk-free-rate:${params.defaultBenchmarkMeta.fallbackMode ?? defaultBenchmarkFreshness}`,
    );
  }
  const benchmarkByKey = new Map(
    selectedSources
      .filter((source) => source.benchmarkKey !== "USD")
      .map((source) => [source.benchmarkKey, source] as const),
  );
  for (const [key, source] of benchmarkByKey) {
    if (source.benchmarkFreshness === "healthy") continue;
    const reason = source.benchmarkFallbackMode ?? source.benchmarkFreshness;
    degradationReasons.push(`risk-free-rate:${key}:${reason}`);
  }
  const staleSelectedSource = selectedSources.find((source) => source.sourceFreshness === "stale");
  if (staleSelectedSource) {
    degradationReasons.push(`yield-source:expired-selected:${staleSelectedSource.sourceKey}`);
  }
  if (params.dlPoolsMeta.mode === "unavailable" || params.dlPoolsMeta.fallbackMode === "cache-parse-failed") {
    degradationReasons.push(`dl-pools:${params.dlPoolsMeta.fallbackMode ?? params.dlPoolsMeta.mode}`);
  }
  if (params.stablecoinSupplyMapState !== "ok") {
    degradationReasons.push(`yield-supply-map:${params.stablecoinSupplyMapState}`);
  }
  // The aggregate coverage floor (60%) cannot see the supplemental lane's share
  // of published rows, so its own cache state and retained-degraded families are
  // reported directly instead of waiting for the floor to trip.
  const supplemental = params.supplementalMeta;
  // The chained supplemental job (A4/C16) writes these family caches earlier in
  // the same slot, so `missing-cache` means the lane was never provisioned
  // rather than lost; the coverage guards own any actual published-row loss.
  // Every other required-lane state is input quality, not a failed publication.
  const supplementalLaneUnprovisioned =
    supplemental.fallbackMode === "missing-cache" && supplemental.sourceCount === 0;
  const pendleOnlyCacheLoss = supplemental.unavailableRequiredFamilies?.length === 1
    && supplemental.unavailableRequiredFamilies[0] === "pendle";
  if (supplemental.fallbackMode === "partial-family-cache" && !pendleOnlyCacheLoss) {
    degradationReasons.push("yield-supplemental:partial-family-cache");
  } else if (!supplementalLaneUnprovisioned && (supplemental.mode !== "cache" || supplemental.sourceCount === 0)) {
    degradationReasons.push(`yield-supplemental:${supplemental.fallbackMode ?? supplemental.mode}`);
  }
  for (const family of supplemental.degradedFamilies) {
    if (!REQUIRED_SUPPLEMENTAL_SOURCE_FAMILY_KEYS.some((key) => key === family)) continue;
    // The quota-bound daily Pendle lane is advisory; freshness tracks publication.
    // Its warning is retained separately in quality metadata.
    if (family === "pendle") continue;
    // Preserve the required family's concrete machine-readable failure cause.
    const familyReason = supplemental.degradedFamilyReasons?.[family];
    degradationReasons.push(
      familyReason
        ? `yield-supplemental:family-degraded:${family}:${familyReason}`
        : `yield-supplemental:family-degraded:${family}`,
    );
  }
  // B15 optional-family failures deliberately do not appear here: a coin whose
  // optional read failed still publishes from its other coverage, and the
  // tracked/published coverage guards already defer publication when a failure
  // leaves a coin with none. The failures stay observable through the run
  // metadata (`buildYieldSyncMetadata`) and the source-resolution progress row.
  if (params.allDeterministicFailed && !params.maskedAllDeterministicFailure) {
    degradationReasons.push("onchain-rates:all-deterministic-failed");
  }
  if (params.onChainSkippedDueToCooldown && params.onChainAlternativeCoverageMissingIds.length > 0) {
    degradationReasons.push("onchain-rates:cooldown-coverage-gap");
  }
  if (params.previousTvlRowsTruncated) {
    degradationReasons.push("yield-history:previous-tvl-row-cap");
  }

  return degradationReasons;
}

const MIN_YIELD_COVERAGE_RATIO = 0.6;
const MIN_YIELD_COINS_FOR_GUARD = 10;
const MIN_DIRECT_CURATED_QUALITY_RATIO = 0.6;
const MIN_FALLBACK_MODELED_INCREASE = 3;
const FALLBACK_MODELED_INCREASE_RATIO = 0.2;
const QUALITY_MIX_REASON_LIMIT = 2;

type YieldQualityMixRanking = Pick<PreviousYieldPublicationRanking, "dataSource" | "provenance">;

export interface YieldPublicationQualityMix {
  directCuratedCount: number;
  fallbackModeledCount: number;
  unclassifiedCount: number;
  totalCount: number;
}

interface YieldQualityMixRegression {
  reasons: string[];
  minimumDirectCuratedCount: number;
  minimumFallbackModeledIncrease: number;
}

function classifyQualityMixRanking(ranking: YieldQualityMixRanking): "direct-curated" | "fallback-modeled" | null {
  const dataSource = typeof ranking.dataSource === "string" ? ranking.dataSource : null;
  const provenance =
    ranking.provenance != null && typeof ranking.provenance === "object" && !Array.isArray(ranking.provenance)
      ? (ranking.provenance as Record<string, unknown>)
      : null;
  const confidenceTier = provenance && typeof provenance.confidenceTier === "string" ? provenance.confidenceTier : null;

  if (dataSource === "price-derived" || dataSource === "rate-derived" || confidenceTier === "fallback") {
    return "fallback-modeled";
  }
  if (
    confidenceTier === "deterministic" ||
    confidenceTier === "curated" ||
    dataSource === "onchain" ||
    dataSource === "defillama" ||
    dataSource === "protocol-api"
  ) {
    return "direct-curated";
  }
  return null;
}

export function summarizeYieldPublicationQualityMix(
  rankings: readonly YieldQualityMixRanking[],
): YieldPublicationQualityMix {
  let directCuratedCount = 0;
  let fallbackModeledCount = 0;
  for (const ranking of rankings) {
    const cohort = classifyQualityMixRanking(ranking);
    if (cohort === "direct-curated") directCuratedCount += 1;
    if (cohort === "fallback-modeled") fallbackModeledCount += 1;
  }
  return {
    directCuratedCount,
    fallbackModeledCount,
    unclassifiedCount: rankings.length - directCuratedCount - fallbackModeledCount,
    totalCount: rankings.length,
  };
}

function detectYieldQualityMixRegression(
  previous: YieldPublicationQualityMix,
  current: YieldPublicationQualityMix,
): YieldQualityMixRegression | null {
  if (previous.directCuratedCount < MIN_YIELD_COINS_FOR_GUARD) return null;

  const minimumDirectCuratedCount = Math.ceil(previous.directCuratedCount * MIN_DIRECT_CURATED_QUALITY_RATIO);
  const minimumFallbackModeledIncrease = Math.max(
    MIN_FALLBACK_MODELED_INCREASE,
    Math.ceil(previous.directCuratedCount * FALLBACK_MODELED_INCREASE_RATIO),
  );
  const fallbackModeledIncrease = current.fallbackModeledCount - previous.fallbackModeledCount;
  if (
    current.directCuratedCount >= minimumDirectCuratedCount ||
    fallbackModeledIncrease < minimumFallbackModeledIncrease
  ) {
    return null;
  }

  return {
    reasons: ["direct-curated-collapse", "fallback-modeled-substitution"].slice(0, QUALITY_MIX_REASON_LIMIT),
    minimumDirectCuratedCount,
    minimumFallbackModeledIncrease,
  };
}

function countPreviewRankings(
  payload: { rankings: Array<{ id: string }> },
  allowedIds?: Set<string>,
): number {
  return allowedIds
    ? payload.rankings.filter((ranking) => allowedIds.has(ranking.id)).length
    : payload.rankings.length;
}

function buildPublishedCoverageRegressionResult(params: {
  reason: string;
  itemCount: number;
  previousPublishedYieldBearingCount: number | null;
  currentPublishedYieldBearingCount: number;
  previousPublishedOpportunityCount: number | null;
  currentPublishedOpportunityCount: number;
  previousPublishedRankingCount: number | null;
  currentPublishedRankingCount: number;
  inputDiagnostics?: CronMetadataRecord;
}): CronResult {
  return createCronResult({
    status: "degraded",
    itemCount: params.itemCount,
    metadata: {
      reason: params.reason,
      previousPublishedYieldBearingCount: params.previousPublishedYieldBearingCount,
      currentPublishedYieldBearingCount: params.currentPublishedYieldBearingCount,
      previousPublishedOpportunityCount: params.previousPublishedOpportunityCount,
      currentPublishedOpportunityCount: params.currentPublishedOpportunityCount,
      previousPublishedRankingCount: params.previousPublishedRankingCount,
      currentPublishedRankingCount: params.currentPublishedRankingCount,
      publishedRankingCountDelta: params.previousPublishedRankingCount == null
        ? null
        : params.currentPublishedRankingCount - params.previousPublishedRankingCount,
      // A regression guard result replaces the run metadata, so without the
      // input diagnostics a collapsed count cannot be attributed to an empty
      // input from cron history alone.
      ...(params.inputDiagnostics ? { inputDiagnostics: params.inputDiagnostics } : {}),
    },
  });
}


export async function guardPublishedYieldCoverage(params: {
  previousYieldPublicationSnapshot: PreviousYieldPublicationSnapshot;
  previewRankingsPayload: {
    rankings: Array<{
      id: string;
      dataSource?: unknown;
      provenance?: unknown;
    }>;
  };
  yieldCoinIdSet: Set<string>;
  opportunityCoinIdSet: Set<string>;
  /**
   * Input/cohort counters from the run that produced the preview payload. The
   * guard's result replaces the run metadata, so a blocked publication keeps
   * these to stay attributable from cron history.
   */
  inputDiagnostics?: CronMetadataRecord;
}): Promise<{
  result: CronResult | null;
  qualityReasons: string[];
  previousPublishedYieldBearingCount: number | null;
  currentPublishedYieldBearingCount: number;
  previousPublishedOpportunityCount: number | null;
  currentPublishedOpportunityCount: number;
  previousPublishedRankingCount: number | null;
  currentPublishedRankingCount: number;
}> {
  const previousRankingsState = derivePreviousYieldRankingsCount(params.previousYieldPublicationSnapshot, {
    allowedIds: params.yieldCoinIdSet,
  });
  const previousOpportunityState = derivePreviousYieldRankingsCount(params.previousYieldPublicationSnapshot, {
    allowedIds: params.opportunityCoinIdSet,
  });
  const previousTotalState = derivePreviousYieldRankingsCount(params.previousYieldPublicationSnapshot, {
    allowMalformedRecovery: true,
  });
  const currentPublishedYieldBearingCount = countPreviewRankings(params.previewRankingsPayload, params.yieldCoinIdSet);
  const currentPublishedOpportunityCount = countPreviewRankings(
    params.previewRankingsPayload,
    params.opportunityCoinIdSet,
  );
  const currentPublishedRankingCount = countPreviewRankings(params.previewRankingsPayload);

  // An unreadable prior generation is an unavailable observation, not a
  // measured zero; recovery may still publish a valid replacement (R1/R2).
  const previousCountsUnavailable = params.previousYieldPublicationSnapshot.malformed;
  const previousPublishedYieldBearingCount = previousRankingsState.count;
  const previousPublishedOpportunityCount = previousOpportunityState.count;
  const previousPublishedRankingCount = previousTotalState.count;

  const qualityReasons: string[] = [];
  for (const [cohort, previous, current] of [
    ["tracked", previousPublishedYieldBearingCount, currentPublishedYieldBearingCount],
    ["opportunity", previousPublishedOpportunityCount, currentPublishedOpportunityCount],
    ["total", previousPublishedRankingCount, currentPublishedRankingCount],
  ] as const) {
    if (previous >= MIN_YIELD_COINS_FOR_GUARD && current < Math.ceil(previous * MIN_YIELD_COVERAGE_RATIO)) {
      qualityReasons.push(`yield-publication:coverage-regression:${cohort}`);
    }
  }
  const expectedTracked = params.inputDiagnostics?.expectedYieldBearingCount;
  if (typeof expectedTracked === "number" && expectedTracked >= MIN_YIELD_COINS_FOR_GUARD &&
      currentPublishedYieldBearingCount < Math.ceil(expectedTracked * MIN_YIELD_COVERAGE_RATIO) &&
      !qualityReasons.includes("yield-publication:coverage-regression:tracked")) {
    qualityReasons.push("yield-publication:coverage-regression:tracked");
  }
  const previousMix = summarizeYieldPublicationQualityMix(params.previousYieldPublicationSnapshot.rankings);
  if (detectYieldQualityMixRegression(previousMix, summarizeYieldPublicationQualityMix(params.previewRankingsPayload.rankings)) &&
      !qualityReasons.includes("yield-publication:coverage-regression:total")) {
    qualityReasons.push("yield-publication:coverage-regression:total");
  }
  // Retain the existing absolute safety net in one place. Cohort loss alone
  // cannot hold unrelated validated assets.
  const hardFloorFailed = currentPublishedRankingCount === 0 ||
    (previousPublishedRankingCount >= 5 && currentPublishedRankingCount < Math.ceil(previousPublishedRankingCount * 0.4));
  const reason = params.inputDiagnostics?.safetySnapshotAvailable === false
    ? "safety-snapshot-unavailable"
    : hardFloorFailed ? "rankings-payload-shrunk" : null;
  if (qualityReasons.length > 0) {
    logWorkerEventArgs("handler", "error", "[sync-yield-data] Publication coverage regression", qualityReasons);
  }
  return {
    qualityReasons,
    result: reason == null ? null : buildPublishedCoverageRegressionResult({
      reason,
      itemCount: currentPublishedRankingCount,
      previousPublishedYieldBearingCount:
        previousCountsUnavailable ? null : previousPublishedYieldBearingCount,
      currentPublishedYieldBearingCount,
      previousPublishedOpportunityCount:
        previousCountsUnavailable ? null : previousPublishedOpportunityCount,
      currentPublishedOpportunityCount,
      previousPublishedRankingCount:
        previousCountsUnavailable ? null : previousPublishedRankingCount,
      currentPublishedRankingCount,
      inputDiagnostics: params.inputDiagnostics,
    }),
    previousPublishedYieldBearingCount: previousCountsUnavailable ? null : previousPublishedYieldBearingCount,
    currentPublishedYieldBearingCount,
    previousPublishedOpportunityCount: previousCountsUnavailable ? null : previousPublishedOpportunityCount,
    currentPublishedOpportunityCount,
    previousPublishedRankingCount: previousCountsUnavailable ? null : previousPublishedRankingCount,
    currentPublishedRankingCount,
  };
}

type DeterministicOnChainHealthState = Parameters<
  typeof buildNextDeterministicOnChainHealthState
>[0]["previous"];

export function logYieldApyDivergences(evaluatedSources: EvaluatedYieldSource[]): void {
  const nativeApyByCoin = new Map<string, number>();
  const lendingApyByCoin = new Map<string, number>();

  for (const source of evaluatedSources) {
    if (source.yieldType === "lending-opportunity" || source.yieldType === "fixed-yield") {
      lendingApyByCoin.set(source.id, source.currentApy);
    } else {
      nativeApyByCoin.set(source.id, source.currentApy);
    }
  }

  for (const [coinId, nativeApy] of nativeApyByCoin) {
    const lendingApy = lendingApyByCoin.get(coinId);
    if (lendingApy == null || nativeApy <= 0 || lendingApy <= 0) continue;

    const divergence = Math.abs(nativeApy - lendingApy) / Math.max(Math.abs(nativeApy), Math.abs(lendingApy), 1e-9);
    if (divergence <= 0.35) continue;

    logWorkerEventArgs("handler", "warn",
      `[yield-sync] APY divergence for ${coinId}: native=${nativeApy.toFixed(1)}% vs lending=${lendingApy.toFixed(1)}%`,
    );
  }
}

export function getPublishableNonOnchainCoverageIds(
  evaluatedSources: readonly EvaluatedYieldSource[],
): Set<string> {
  return new Set(
    evaluatedSources
      .filter((source) => source.dataSource !== "onchain" && !source.rejected)
      .map((source) => source.id),
  );
}

export async function computeDeterministicOnChainHealth(params: {
  db: D1Database;
  startSec: number;
  evaluatedSources: EvaluatedYieldSource[];
  onChainHealthState: DeterministicOnChainHealthState;
  onChainSkippedDueToCooldown: boolean;
  onChainAttemptedCount: number;
  onChainRatesResolved: number;
  allDeterministicFailed: boolean;
}): Promise<{
  maskedAllDeterministicFailure: boolean;
  onChainAlternativeCoverageMissingIds: string[];
  nextOnChainHealthState: DeterministicOnChainHealthState;
  onChainCooldownTriggered: boolean;
}> {
  const deterministicSourceIds = Array.from(
    new Set(ON_CHAIN_RATE_CONFIGS.map((config) => config.stablecoinId)),
  );
  const nonOnchainEvaluatedIds = getPublishableNonOnchainCoverageIds(params.evaluatedSources);
  const onChainAlternativeCoverageMissingIds = deterministicSourceIds.filter(
    (id) => !nonOnchainEvaluatedIds.has(id),
  );
  const maskedAllDeterministicFailure =
    params.allDeterministicFailed &&
    deterministicSourceIds.length > 0 &&
    onChainAlternativeCoverageMissingIds.length === 0;
  const nextOnChainHealthState = buildNextDeterministicOnChainHealthState({
    deterministicConfigCount: deterministicSourceIds.length,
    previous: params.onChainHealthState,
    startSec: params.startSec,
    onChainAttemptedCount: params.onChainAttemptedCount,
    onChainRatesResolved: params.onChainRatesResolved,
    allDeterministicFailed: params.allDeterministicFailed,
    maskedAllDeterministicFailure,
    onChainAlternativeCoverageMissingIds,
    onChainSkippedDueToCooldown: params.onChainSkippedDueToCooldown,
  });
  const onChainCooldownTriggered =
    !params.onChainSkippedDueToCooldown &&
    nextOnChainHealthState.cooldownUntil != null &&
    nextOnChainHealthState.cooldownUntil > params.startSec;

  await persistDeterministicOnChainHealthState(params.db, params.startSec, nextOnChainHealthState);

  if (params.allDeterministicFailed && maskedAllDeterministicFailure) {
    logWorkerEventArgs("handler", "warn",
      "[sync-yield-data] Deterministic on-chain lane failed, but all configured coins retained non-onchain yield coverage",
    );
  }

  return {
    maskedAllDeterministicFailure,
    onChainAlternativeCoverageMissingIds,
    nextOnChainHealthState,
    onChainCooldownTriggered,
  };
}

