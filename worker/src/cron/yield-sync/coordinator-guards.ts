import type { CronResult } from "../../lib/cron-logger";
import { readPreviousYieldRankingsCount } from "./publication";

const MIN_YIELD_COVERAGE_RATIO = 0.6;
const MIN_YIELD_COINS_FOR_GUARD = 10;

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

  console.error(
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
  previewRankingsPayload: { rankings: Array<{ id: string }> };
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
