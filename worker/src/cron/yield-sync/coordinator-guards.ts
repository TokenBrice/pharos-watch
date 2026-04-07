import type { CronResult } from "../../lib/cron-logger";
import { readPreviousYieldRankingsCount } from "./publication";

const MIN_YIELD_COVERAGE_RATIO = 0.6;
const MIN_YIELD_COINS_FOR_GUARD = 10;

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
}): Promise<{
  result: CronResult | null;
  previousPublishedYieldBearingCount: number;
  currentPublishedYieldBearingCount: number;
}> {
  const previousRankingsState = await readPreviousYieldRankingsCount(params.db, {
    allowedIds: params.yieldCoinIdSet,
  });
  if (previousRankingsState.malformed) {
    return {
      result: {
        status: "degraded",
        itemCount: params.previewRankingsPayload.rankings.filter((ranking) => params.yieldCoinIdSet.has(ranking.id)).length,
        metadata: JSON.stringify({
          reason: "previous-yield-rankings-cache-invalid",
        }),
      },
      previousPublishedYieldBearingCount: 0,
      currentPublishedYieldBearingCount: params.previewRankingsPayload.rankings.filter((ranking) => params.yieldCoinIdSet.has(ranking.id)).length,
    };
  }

  const previousPublishedYieldBearingCount = previousRankingsState.count;
  const currentPublishedYieldBearingCount = params.previewRankingsPayload.rankings
    .filter((ranking) => params.yieldCoinIdSet.has(ranking.id))
    .length;

  if (
    previousPublishedYieldBearingCount >= MIN_YIELD_COINS_FOR_GUARD &&
    currentPublishedYieldBearingCount < Math.ceil(previousPublishedYieldBearingCount * MIN_YIELD_COVERAGE_RATIO)
  ) {
    return {
      result: {
        status: "degraded",
        itemCount: currentPublishedYieldBearingCount,
        metadata: JSON.stringify({
          reason: "published-yield-coverage-regression",
          previousPublishedYieldBearingCount,
          currentPublishedYieldBearingCount,
        }),
      },
      previousPublishedYieldBearingCount,
      currentPublishedYieldBearingCount,
    };
  }

  return {
    result: null,
    previousPublishedYieldBearingCount,
    currentPublishedYieldBearingCount,
  };
}
