import { guardPublishedYieldCoverage, guardTrackedYieldCoverage } from "./coordinator-guards";
import { computeDeterministicOnChainHealth, logYieldApyDivergences } from "./coordinator-health";
import {
  buildYieldDegradationReasons,
  buildYieldSafetySnapshotMeta,
} from "./coordinator-metadata";
import { buildPreviewYieldRankingsArtifacts } from "./coordinator-persist";
import type { YieldCoordinatorFetchContext } from "./coordinator-fetch-stage";
import type { YieldCoordinatorNormalizeContext } from "./coordinator-normalize-stage";

export interface YieldCoordinatorHealthTelemetryStageParams {
  db: D1Database;
  fetched: YieldCoordinatorFetchContext;
  normalized: YieldCoordinatorNormalizeContext;
}

export async function runYieldCoordinatorHealthTelemetryStage(
  params: YieldCoordinatorHealthTelemetryStageParams,
) {
  const { fetched, normalized } = params;
  const onChainHealth = await computeDeterministicOnChainHealth({
    db: params.db,
    startSec: fetched.startSec,
    evaluatedSources: normalized.evaluatedSources,
    onChainHealthState: fetched.onChainHealthState,
    onChainCooldownActive: fetched.onChainCooldownActive,
    onChainSkippedDueToCooldown: fetched.onChainSkippedDueToCooldown,
    onChainAttemptedCount: fetched.onChainAttemptedCount,
    onChainRatesResolved: fetched.onChainRates.size,
    allDeterministicFailed: fetched.allDeterministicFailed,
  });

  logYieldApyDivergences(normalized.evaluatedSources);

  const trackedCoverageGuard = guardTrackedYieldCoverage({
    resolvedYieldBearingCount: normalized.resolvedYieldBearingIds.size,
    expectedYieldBearingCount: fetched.yieldCoins.length,
  });
  if (trackedCoverageGuard) {
    await fetched.reportYieldProgress("coverage-guard", "Yield tracked coverage guard deferred publication", "yield", {
      itemsDone: normalized.resolvedYieldBearingIds.size,
      metadata: {
        guard: "tracked-coverage",
        countTotals: {
          resolvedYieldBearingCoins: normalized.resolvedYieldBearingIds.size,
          expectedYieldBearingCoins: fetched.yieldCoins.length,
        },
      },
    });
    return { ok: false as const, result: trackedCoverageGuard };
  }

  const safetySnapshotMeta = buildYieldSafetySnapshotMeta({
    kind: fetched.safetySnapshot.kind,
    coverageRatio: fetched.safetyCoverageRatio,
    coveredCount: fetched.safetySnapshot.coveredCount,
    trackedCount: fetched.safetySnapshot.trackedCount,
    reason: fetched.safetySnapshot.reason ?? null,
    source: fetched.safetySnapshot.source,
    publicationGenerationId: fetched.safetySnapshot.publicationGenerationId,
    methodologyVersion: fetched.safetySnapshot.methodologyVersion,
    publishedAt: fetched.safetySnapshot.publishedAt,
  });
  const { previewRankingsPayload } = buildPreviewYieldRankingsArtifacts({
    evaluatedSources: normalized.evaluatedSources,
    bestSourceKeyByCoin: normalized.bestSourceKeyByCoin,
    riskFreeRate: fetched.riskFreeRate,
    riskFreeRateMeta: fetched.riskFreeRateMeta,
    riskFreeRates: fetched.riskFreeRates,
    dlPoolsMeta: fetched.dlPoolsMeta,
    safetySnapshot: safetySnapshotMeta,
    medianApy: normalized.medianApy,
    startSec: fetched.startSec,
  });
  const publishedCoverageGuard = await guardPublishedYieldCoverage({
    db: params.db,
    previewRankingsPayload,
    yieldCoinIdSet: fetched.yieldCoinIdSet,
    opportunityCoinIdSet: fetched.opportunityCoinIdSet,
  });
  if (publishedCoverageGuard.result) {
    await fetched.reportYieldProgress(
      "coverage-guard",
      "Yield published coverage guard deferred publication",
      "yield-publication",
      {
        itemsDone: previewRankingsPayload.rankings.length,
        metadata: {
          guard: "published-coverage",
          countTotals: { previewRankings: previewRankingsPayload.rankings.length },
        },
      },
    );
    return { ok: false as const, result: publishedCoverageGuard.result };
  }

  const degradationReasons = buildYieldDegradationReasons({
    safetySnapshotDegraded: fetched.safetySnapshotDegraded,
    safetySnapshotReason: fetched.safetySnapshot.reason ?? null,
    defaultBenchmarkMeta: fetched.riskFreeRateMeta,
    selectedSources: normalized.evaluatedSources.filter(
      (source) => normalized.bestSourceKeyByCoin.get(source.id) === source.sourceKey,
    ),
    dlPoolsMeta: fetched.dlPoolsMeta,
    allDeterministicFailed: fetched.allDeterministicFailed,
    maskedAllDeterministicFailure: onChainHealth.maskedAllDeterministicFailure,
    onChainSkippedDueToCooldown: fetched.onChainSkippedDueToCooldown,
    onChainAlternativeCoverageMissingIds: onChainHealth.onChainAlternativeCoverageMissingIds,
    previousTvlRowsTruncated: normalized.historySnapshots.previousTvlRowsTruncated,
  });
  await fetched.reportYieldProgress("publication", "Publishing yield rankings generation", "yield-publication", {
    itemsDone: 0,
    itemsTotal: previewRankingsPayload.rankings.length,
    metadata: {
      countTotals: {
        previewRankings: previewRankingsPayload.rankings.length,
        evaluatedSources: normalized.evaluatedSources.length,
      },
      degradationReasons,
    },
  });

  return {
    ok: true as const,
    context: {
      ...onChainHealth,
      safetySnapshotMeta,
      previewRankingsPayload,
      degradationReasons,
      previousPublishedYieldBearingCount: publishedCoverageGuard.previousPublishedYieldBearingCount,
      currentPublishedYieldBearingCount: publishedCoverageGuard.currentPublishedYieldBearingCount,
      previousPublishedOpportunityCount: publishedCoverageGuard.previousPublishedOpportunityCount,
      currentPublishedOpportunityCount: publishedCoverageGuard.currentPublishedOpportunityCount,
      previousPublishedRankingCount: publishedCoverageGuard.previousPublishedRankingCount,
      currentPublishedRankingCount: publishedCoverageGuard.currentPublishedRankingCount,
    },
  };
}

export type YieldCoordinatorHealthTelemetryContext = Extract<
  Awaited<ReturnType<typeof runYieldCoordinatorHealthTelemetryStage>>,
  { ok: true }
>["context"];
