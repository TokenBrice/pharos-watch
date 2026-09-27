import { logWorkerEventArgs } from "../../lib/structured-log";
import type { CronResult } from "../../lib/cron-logger";
import { createCronResult, type CronMetadataRecord } from "../../lib/cron-result";
import {
  derivePreviousYieldRankingsCount,
  type PreviousYieldPublicationRanking,
  type PreviousYieldPublicationSnapshot,
} from "./publication";

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
  previousPublishedYieldBearingCount: number;
  currentPublishedYieldBearingCount: number;
  previousPublishedOpportunityCount: number;
  currentPublishedOpportunityCount: number;
  previousPublishedRankingCount: number;
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
      publishedRankingCountDelta: params.currentPublishedRankingCount - params.previousPublishedRankingCount,
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
  previousPublishedYieldBearingCount: number;
  currentPublishedYieldBearingCount: number;
  previousPublishedOpportunityCount: number;
  currentPublishedOpportunityCount: number;
  previousPublishedRankingCount: number;
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

  if (previousRankingsState.malformed) {
    return {
      qualityReasons: [],
      result: createCronResult({
        status: "degraded",
        itemCount: currentPublishedYieldBearingCount,
        metadata: {
          reason: "previous-yield-rankings-cache-invalid",
          ...(params.inputDiagnostics ? { inputDiagnostics: params.inputDiagnostics } : {}),
        },
      }),
      previousPublishedYieldBearingCount: 0,
      currentPublishedYieldBearingCount,
      previousPublishedOpportunityCount: 0,
      currentPublishedOpportunityCount,
      previousPublishedRankingCount: 0,
      currentPublishedRankingCount,
    };
  }

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
      previousPublishedYieldBearingCount,
      currentPublishedYieldBearingCount,
      previousPublishedOpportunityCount,
      currentPublishedOpportunityCount,
      previousPublishedRankingCount,
      currentPublishedRankingCount,
      inputDiagnostics: params.inputDiagnostics,
    }),
    previousPublishedYieldBearingCount,
    currentPublishedYieldBearingCount,
    previousPublishedOpportunityCount,
    currentPublishedOpportunityCount,
    previousPublishedRankingCount,
    currentPublishedRankingCount,
  };
}
