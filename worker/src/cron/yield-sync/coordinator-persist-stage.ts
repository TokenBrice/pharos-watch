import { safetyScorePublicationIdentitiesAreComparable } from "@shared/lib/safety-score-publication";
import type { CronResult } from "../../lib/cron-logger";
import { loadActiveSafetyScoreIdentity } from "../../lib/safety-score-active-source";
import { logWorkerEvent } from "../../lib/structured-log";
import { ON_CHAIN_RATE_CONFIGS } from "../../lib/yield-config/yield-config";
import {
  buildComparisonAnchorFreshnessMeta,
  buildYieldSyncMetadata,
  type YieldSafetyIdentityChangeMeta,
} from "./coordinator-metadata";
import { publishYieldCoordinatorResults } from "./coordinator-persist";
import type { YieldCoordinatorFetchContext } from "./coordinator-fetch-stage";
import type { YieldCoordinatorHealthTelemetryContext } from "./coordinator-health-telemetry-stage";
import type { YieldCoordinatorNormalizeContext } from "./coordinator-normalize-stage";

export interface YieldCoordinatorPersistStageParams {
  db: D1Database;
  signal?: AbortSignal;
  fetched: YieldCoordinatorFetchContext;
  normalized: YieldCoordinatorNormalizeContext;
  health: YieldCoordinatorHealthTelemetryContext;
}

export async function runYieldCoordinatorPersistStage(
  params: YieldCoordinatorPersistStageParams,
): Promise<CronResult> {
  const { fetched, normalized, health } = params;
  const loadedSafetyIdentity = health.safetySnapshotMeta.safetyScoreIdentity ?? null;
  let safetyIdentityChangedBeforePublish: YieldSafetyIdentityChangeMeta | null = null;
  if (loadedSafetyIdentity) {
    const currentSafetySource = await loadActiveSafetyScoreIdentity(params.db);
    const currentSafetyIdentity = currentSafetySource.safetyScoreIdentity;
    if (
      currentSafetySource.kind === "v9" &&
      currentSafetyIdentity &&
      !safetyScorePublicationIdentitiesAreComparable(loadedSafetyIdentity, currentSafetyIdentity)
    ) {
      // The run still publishes: its results are coherent under the identity it
      // loaded, and the read path serves them as a publish-time snapshot until
      // the next run re-aligns. Withholding the publish would only pin an
      // older, equally mismatched cache (2026-08-19 incident).
      safetyIdentityChangedBeforePublish = {
        reason: "yield-safety-identity-changed-before-publish",
        loadedPublicationGenerationId: loadedSafetyIdentity.publicationGenerationId,
        currentPublicationGenerationId: currentSafetyIdentity.publicationGenerationId,
        loadedEvaluationBuildDigest: loadedSafetyIdentity.evaluationBuildDigest,
        currentEvaluationBuildDigest: currentSafetyIdentity.evaluationBuildDigest,
      };
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: safetyIdentityChangedBeforePublish.reason,
        job: "sync-yield-data",
        message:
          "Safety Score V9 identity changed after yield inputs were loaded; publishing the coherent loaded-identity results",
        metadata: {
          loadedPublicationGenerationId: loadedSafetyIdentity.publicationGenerationId,
          currentPublicationGenerationId: currentSafetyIdentity.publicationGenerationId,
          loadedEvaluationBuildDigest: loadedSafetyIdentity.evaluationBuildDigest,
          currentEvaluationBuildDigest: currentSafetyIdentity.evaluationBuildDigest,
        },
      });
    }
  }
  const publicationResult = await publishYieldCoordinatorResults({
    db: params.db,
    signal: params.signal,
    previewRankingsPayload: health.previewRankingsPayload,
    evaluatedSources: normalized.evaluatedSources,
    publicationViews: health.publicationViews,
    startSec: fetched.startSec,
    degradationReasons: health.degradationReasons,
    resolvedCount: normalized.resolvedIds.length,
    rowsRejected: normalized.rowsRejected,
    divergenceFlags: normalized.divergenceFlags,
    sourceSwitches: normalized.sourceSwitches,
    previousYieldPublicationSnapshot: health.previousYieldPublicationSnapshot,
  });
  if (!publicationResult.ok) {
    await fetched.reportYieldProgress(
      "publication-blocked",
      "Yield publication was blocked",
      "yield-publication",
      {
        itemsDone: 0,
        itemsTotal: health.previewRankingsPayload.rankings.length,
        metadata: {
          countTotals: { previewRankings: health.previewRankingsPayload.rankings.length },
        },
      },
    );
    return publicationResult.result;
  }

  logWorkerEvent({
    scope: "lib",
    level: "info",
    event: "yield-publication-complete",
    job: "sync-yield-data",
    message: "Yield source rows and rankings publication completed",
    metadata: {
      updatedCount: publicationResult.updatedCount,
      yieldBearingCoins: fetched.yieldCoins.length,
    },
  });
  await fetched.reportYieldProgress(
    "publication-complete",
    "Published yield rankings generation",
    "yield-publication",
    {
      itemsDone: publicationResult.updatedCount,
      itemsTotal: health.previewRankingsPayload.rankings.length,
      metadata: {
        countTotals: {
          rowsWritten: publicationResult.updatedCount,
          publishedRankingCount: health.currentPublishedRankingCount,
          previousPublishedRankingCount: health.previousPublishedRankingCount,
        },
        degradationReasons: publicationResult.degradationReasons,
        cacheWriteSkipped: publicationResult.cacheWriteSkipped,
      },
    },
  );
  const status = publicationResult.degradationReasons.length > 0 ? "degraded" : "ok";
  return {
    itemCount: publicationResult.updatedCount,
    ...(status === "degraded" ? { status: "degraded" as const } : {}),
    metadata: buildYieldSyncMetadata({
      rowsRead: fetched.yieldCoins.length,
      rowsWritten: publicationResult.updatedCount,
      rowsRejected: normalized.rowsRejected,
      divergenceFlags: normalized.divergenceFlags,
      sourceSwitches: normalized.sourceSwitches,
      defaultSafetyCoinCount: normalized.defaultSafetyIds.size,
      safetySnapshot: health.safetySnapshotMeta,
      resolvedYieldBearingCount: normalized.resolvedYieldBearingIds.size,
      expectedYieldBearingCount: fetched.yieldCoins.length,
      publishedYieldBearingCount: health.currentPublishedYieldBearingCount,
      previousPublishedYieldBearingCount: health.previousPublishedYieldBearingCount,
      publishedOpportunityCount: health.currentPublishedOpportunityCount,
      previousPublishedOpportunityCount: health.previousPublishedOpportunityCount,
      publishedRankingCount: health.currentPublishedRankingCount,
      previousPublishedRankingCount: health.previousPublishedRankingCount,
      dlPoolsMeta: fetched.dlPoolsMeta,
      supplementalMeta: fetched.supplementalMeta,
      onChain: {
        ratesResolved: fetched.onChainRates.size,
        ratesConfigured: ON_CHAIN_RATE_CONFIGS.length,
        envelopeRejections: normalized.envelopeRejections,
        attempted: fetched.onChainAttemptedCount,
        allDeterministicFailed: fetched.allDeterministicFailed,
        explorerAttempted: fetched.onChainExplorerAttemptedCount,
        explorerResolved: fetched.onChainExplorerResolvedCount,
        failureMaskedByAlternativeCoverage: health.maskedAllDeterministicFailure,
        alternativeCoverageMissingIds: health.onChainAlternativeCoverageMissingIds,
        failures: fetched.onChainFailures,
        skippedDueToCooldown: fetched.onChainSkippedDueToCooldown,
        cooldownActive: fetched.onChainCooldownActive,
        cooldownTriggered: health.onChainCooldownTriggered,
        cooldownUntil: health.nextOnChainHealthState.cooldownUntil,
        cooldownRemainingSec: fetched.onChainCooldownRemainingSec,
        consecutiveAllFailRuns: health.nextOnChainHealthState.consecutiveAllFailRuns,
        consecutiveMaskedAllFailRuns: health.nextOnChainHealthState.consecutiveMaskedAllFailRuns,
      },
      fallbackMode:
        publicationResult.degradationReasons.length > 0 ? publicationResult.degradationReasons.join(",") : null,
      validationFailures: publicationResult.validationFailures,
      riskFreeRate: fetched.riskFreeRate,
      cacheWriteSkipped: publicationResult.cacheWriteSkipped,
      comparisonAnchorFreshness: buildComparisonAnchorFreshnessMeta({
        evaluatedSources: normalized.evaluatedSources,
        startSec: fetched.startSec,
      }),
      previousTvlRowsTruncated: normalized.historySnapshots.previousTvlRowsTruncated,
      safetyIdentityChangedBeforePublish,
    }),
  };
}
