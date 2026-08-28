import { logWorkerEventArgs } from "../../lib/structured-log";
import type { CronResult } from "../../lib/cron-logger";
import { getCache } from "../../lib/db-cache";
import { readCachedJson } from "../../lib/api-cache-read";
import { readPreviousYieldRankingsCount } from "./publication";

const MIN_YIELD_COVERAGE_RATIO = 0.6;
const MIN_YIELD_COINS_FOR_GUARD = 10;
const MIN_DIRECT_CURATED_QUALITY_RATIO = 0.6;
const MIN_FALLBACK_MODELED_INCREASE = 3;
const FALLBACK_MODELED_INCREASE_RATIO = 0.2;
const QUALITY_MIX_REASON_LIMIT = 2;

interface YieldQualityMixRanking {
  dataSource?: unknown;
  provenance?: unknown;
}

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

export function detectYieldQualityMixRegression(
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

async function readPreviousYieldQualityMix(db: D1Database): Promise<YieldPublicationQualityMix | null> {
  const previousCache = await getCache(db, "yield-rankings");
  const parsed = readCachedJson<{ rankings?: YieldQualityMixRanking[] }>(
    "yield-sync-quality-guard",
    "yield-rankings",
    previousCache,
  );
  if (parsed.status !== "ok" || !Array.isArray(parsed.data.rankings)) return null;
  return summarizeYieldPublicationQualityMix(parsed.data.rankings);
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
}): CronResult {
  return {
    status: "degraded",
    itemCount: params.itemCount,
    metadata: JSON.stringify({
      reason: params.reason,
      previousPublishedYieldBearingCount: params.previousPublishedYieldBearingCount,
      currentPublishedYieldBearingCount: params.currentPublishedYieldBearingCount,
      previousPublishedOpportunityCount: params.previousPublishedOpportunityCount,
      currentPublishedOpportunityCount: params.currentPublishedOpportunityCount,
      previousPublishedRankingCount: params.previousPublishedRankingCount,
      currentPublishedRankingCount: params.currentPublishedRankingCount,
      publishedRankingCountDelta: params.currentPublishedRankingCount - params.previousPublishedRankingCount,
    }),
  };
}

export function guardTrackedYieldCoverage(params: {
  resolvedYieldBearingCount: number;
  expectedYieldBearingCount: number;
}): CronResult | null {
  const yieldCoverageRatio =
    params.expectedYieldBearingCount > 0
      ? params.resolvedYieldBearingCount / params.expectedYieldBearingCount
      : 1;

  if (
    params.expectedYieldBearingCount < MIN_YIELD_COINS_FOR_GUARD ||
    yieldCoverageRatio >= MIN_YIELD_COVERAGE_RATIO
  ) {
    return null;
  }

  logWorkerEventArgs("handler", "error",
    `[sync-yield-data] Yield coverage regression: ${params.resolvedYieldBearingCount}/${params.expectedYieldBearingCount} ` +
    `(${(yieldCoverageRatio * 100).toFixed(1)}%) — skipping persistence`,
  );

  return {
    status: "degraded",
    itemCount: params.resolvedYieldBearingCount,
    metadata: JSON.stringify({
      reason: "coverage-regression",
      coverage: yieldCoverageRatio,
      resolvedCount: params.resolvedYieldBearingCount,
      totalCount: params.expectedYieldBearingCount,
    }),
  };
}

export async function guardPublishedYieldCoverage(params: {
  db: D1Database;
  previewRankingsPayload: {
    rankings: Array<{
      id: string;
      dataSource?: unknown;
      provenance?: unknown;
    }>;
  };
  yieldCoinIdSet: Set<string>;
  opportunityCoinIdSet: Set<string>;
}): Promise<{
  result: CronResult | null;
  previousPublishedYieldBearingCount: number;
  currentPublishedYieldBearingCount: number;
  previousPublishedOpportunityCount: number;
  currentPublishedOpportunityCount: number;
  previousPublishedRankingCount: number;
  currentPublishedRankingCount: number;
}> {
  const previousRankingsState = await readPreviousYieldRankingsCount(params.db, {
    allowedIds: params.yieldCoinIdSet,
  });
  const previousOpportunityState = await readPreviousYieldRankingsCount(params.db, {
    allowedIds: params.opportunityCoinIdSet,
  });
  const previousTotalState = await readPreviousYieldRankingsCount(params.db, {
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
      result: {
        status: "degraded",
        itemCount: currentPublishedYieldBearingCount,
        metadata: JSON.stringify({
          reason: "previous-yield-rankings-cache-invalid",
        }),
      },
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

  if (
    previousPublishedYieldBearingCount >= MIN_YIELD_COINS_FOR_GUARD &&
    currentPublishedYieldBearingCount < Math.ceil(previousPublishedYieldBearingCount * MIN_YIELD_COVERAGE_RATIO)
  ) {
    return {
      result: buildPublishedCoverageRegressionResult({
        reason: "published-yield-coverage-regression",
        itemCount: currentPublishedYieldBearingCount,
        previousPublishedYieldBearingCount,
        currentPublishedYieldBearingCount,
        previousPublishedOpportunityCount,
        currentPublishedOpportunityCount,
        previousPublishedRankingCount,
        currentPublishedRankingCount,
      }),
      previousPublishedYieldBearingCount,
      currentPublishedYieldBearingCount,
      previousPublishedOpportunityCount,
      currentPublishedOpportunityCount,
      previousPublishedRankingCount,
      currentPublishedRankingCount,
    };
  }

  if (
    previousPublishedOpportunityCount >= MIN_YIELD_COINS_FOR_GUARD &&
    currentPublishedOpportunityCount < Math.ceil(previousPublishedOpportunityCount * MIN_YIELD_COVERAGE_RATIO)
  ) {
    return {
      result: buildPublishedCoverageRegressionResult({
        reason: "published-lending-opportunity-coverage-regression",
        itemCount: currentPublishedRankingCount,
        previousPublishedYieldBearingCount,
        currentPublishedYieldBearingCount,
        previousPublishedOpportunityCount,
        currentPublishedOpportunityCount,
        previousPublishedRankingCount,
        currentPublishedRankingCount,
      }),
      previousPublishedYieldBearingCount,
      currentPublishedYieldBearingCount,
      previousPublishedOpportunityCount,
      currentPublishedOpportunityCount,
      previousPublishedRankingCount,
      currentPublishedRankingCount,
    };
  }

  if (
    previousPublishedRankingCount >= MIN_YIELD_COINS_FOR_GUARD &&
    currentPublishedRankingCount < Math.ceil(previousPublishedRankingCount * MIN_YIELD_COVERAGE_RATIO)
  ) {
    return {
      result: buildPublishedCoverageRegressionResult({
        reason: "published-total-coverage-regression",
        itemCount: currentPublishedRankingCount,
        previousPublishedYieldBearingCount,
        currentPublishedYieldBearingCount,
        previousPublishedOpportunityCount,
        currentPublishedOpportunityCount,
        previousPublishedRankingCount,
        currentPublishedRankingCount,
      }),
      previousPublishedYieldBearingCount,
      currentPublishedYieldBearingCount,
      previousPublishedOpportunityCount,
      currentPublishedOpportunityCount,
      previousPublishedRankingCount,
      currentPublishedRankingCount,
    };
  }

  if (previousPublishedRankingCount >= MIN_YIELD_COINS_FOR_GUARD) {
    const previousQualityMix = await readPreviousYieldQualityMix(params.db);
    if (previousQualityMix) {
      const currentQualityMix = summarizeYieldPublicationQualityMix(params.previewRankingsPayload.rankings);
      const qualityMixRegression = detectYieldQualityMixRegression(previousQualityMix, currentQualityMix);
      if (qualityMixRegression) {
        return {
          result: {
            status: "degraded",
            itemCount: currentPublishedRankingCount,
            metadata: JSON.stringify({
              reason: "published-source-quality-mix-regression",
              qualityMixReasons: qualityMixRegression.reasons,
              previousPublishedDirectCuratedCount: previousQualityMix.directCuratedCount,
              currentPublishedDirectCuratedCount: currentQualityMix.directCuratedCount,
              publishedDirectCuratedCountDelta:
                currentQualityMix.directCuratedCount - previousQualityMix.directCuratedCount,
              minimumDirectCuratedCount: qualityMixRegression.minimumDirectCuratedCount,
              previousPublishedFallbackModeledCount: previousQualityMix.fallbackModeledCount,
              currentPublishedFallbackModeledCount: currentQualityMix.fallbackModeledCount,
              publishedFallbackModeledCountDelta:
                currentQualityMix.fallbackModeledCount - previousQualityMix.fallbackModeledCount,
              minimumFallbackModeledIncrease: qualityMixRegression.minimumFallbackModeledIncrease,
              previousPublishedRankingCount,
              currentPublishedRankingCount,
              publishedRankingCountDelta: currentPublishedRankingCount - previousPublishedRankingCount,
            }),
          },
          previousPublishedYieldBearingCount,
          currentPublishedYieldBearingCount,
          previousPublishedOpportunityCount,
          currentPublishedOpportunityCount,
          previousPublishedRankingCount,
          currentPublishedRankingCount,
        };
      }
    }
  }

  return {
    result: null,
    previousPublishedYieldBearingCount,
    currentPublishedYieldBearingCount,
    previousPublishedOpportunityCount,
    currentPublishedOpportunityCount,
    previousPublishedRankingCount,
    currentPublishedRankingCount,
  };
}
