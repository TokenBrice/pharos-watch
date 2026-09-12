import { logWorkerEventArgs } from "../../lib/structured-log";
import { toYieldBenchmarkRegistry, type ParsedYieldBenchmarkRegistry } from "./benchmarks";
import { type EvaluatedYieldSource } from "./evaluation";
import {
  buildYieldPublicationViews,
  type YieldCoinPublicationView,
} from "./publication-view";
import { toErrorMessage } from "@shared/lib/error-utils";
import {
  attachYieldPublicationMetadata,
  buildYieldPublicationGenerationId,
  buildYieldRankingsPayloadFromEvaluatedSources,
  finalizeYieldPublicationGeneration,
  persistEvaluatedYieldSources,
  pruneYieldTables,
  repairPublishedYieldGenerationFromCache,
  stageYieldPublicationGeneration,
  validateYieldRankingsPayloadForPublish,
  type PreviousYieldPublicationSnapshot,
} from "./publication";
import type { YieldBenchmarkMeta, YieldSourceInputMeta } from "@shared/types/yield";
import type { PreviousPublicationForAttribution } from "./publication-ranking-payload";
import type { CronResult } from "../../lib/cron-logger";
import { createCronResult } from "../../lib/cron-result";
import type { YieldRowsWriteStats } from "./publication-atomic-batch";
import type { YieldEvaluatedSourcesWriteResult } from "./publication-decision-persistence";
import { writeFreshnessSentinel } from "../../lib/db-cache";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";

function getD1FailureReason(prefix: string, error: unknown): string {
  const message = toErrorMessage(error);
  return message ? `${prefix}:${message.slice(0, 120)}` : prefix;
}

export function buildPreviewYieldRankingsArtifacts(params: {
  evaluatedSources: EvaluatedYieldSource[];
  bestSourceKeyByCoin: Map<string, string>;
  riskFreeRate: number;
  riskFreeRateMeta: YieldBenchmarkMeta;
  riskFreeRates: ParsedYieldBenchmarkRegistry;
  dlPoolsMeta: YieldSourceInputMeta;
  safetySnapshot: Parameters<typeof buildYieldRankingsPayloadFromEvaluatedSources>[0]["safetySnapshot"];
  medianApy: number;
  startSec: number;
  /**
   * B7/B31: previous publication, so the preview payload carries publish-time
   * rank-change attribution (`rankChangeAttribution`). Absent → no attribution.
   */
  previousPublication?: PreviousPublicationForAttribution | null;
}): {
  previewRankingsPayload: ReturnType<typeof buildYieldRankingsPayloadFromEvaluatedSources>;
  publicationViews: Map<string, YieldCoinPublicationView>;
} {
  const { provenanceByKey, viewsByCoinId } = buildYieldPublicationViews({
    evaluatedSources: params.evaluatedSources,
    bestSourceKeyByCoin: params.bestSourceKeyByCoin,
    startSec: params.startSec,
    dlPoolsMeta: params.dlPoolsMeta,
  });

  return {
    publicationViews: viewsByCoinId,
    previewRankingsPayload: buildYieldRankingsPayloadFromEvaluatedSources({
      evaluatedSources: params.evaluatedSources,
      publicationViews: viewsByCoinId,
      rankingProvenanceByKey: provenanceByKey,
      riskFreeRate: params.riskFreeRate,
      riskFreeRateMeta: params.riskFreeRateMeta,
      riskFreeRateRegistry: toYieldBenchmarkRegistry(params.riskFreeRates),
      dlPoolsMeta: params.dlPoolsMeta,
      safetySnapshot: params.safetySnapshot,
      medianApy: params.medianApy,
      startSec: params.startSec,
      previousPublication: params.previousPublication,
    }),
  };
}

export async function publishYieldCoordinatorResults(params: {
  db: D1Database;
  signal?: AbortSignal;
  previewRankingsPayload: ReturnType<typeof buildYieldRankingsPayloadFromEvaluatedSources>;
  evaluatedSources: EvaluatedYieldSource[];
  publicationViews: Map<string, YieldCoinPublicationView>;
  startSec: number;
  degradationReasons: string[];
  resolvedCount: number;
  rowsRejected: number;
  divergenceFlags: number;
  sourceSwitches: number;
  previousYieldPublicationSnapshot: PreviousYieldPublicationSnapshot;
}): Promise<
  | { ok: false; result: CronResult }
  | {
      ok: true;
      updatedCount: number;
      degradationReasons: string[];
      validationFailures: number;
      cacheWriteSkipped: boolean;
      casSkipped: boolean;
      /** Why the atomic write did not apply, when it did not. */
      skipReason: string | null;
      publicationStats: YieldRowsWriteStats | null;
    }
> {
  throwIfAborted(params.signal);
  const generationId = buildYieldPublicationGenerationId(params.startSec);
  let generationFinalized = false;
  let publicationApplied = false;
  const finalizeFailedGeneration = async (reason: string): Promise<void> => {
    generationFinalized = true;
    await finalizeYieldPublicationGeneration(params.db, {
      generationId,
      state: "failed",
      timestamp: params.startSec,
      reason,
    });
  };
  const stagedRankingsPayload = attachYieldPublicationMetadata(params.previewRankingsPayload, {
    generationId,
    startSec: params.startSec,
    status: "staged",
  });
  await stageYieldPublicationGeneration(params.db, {
    generationId,
    startSec: params.startSec,
    rankingCount: params.previewRankingsPayload.rankings.length,
    sourceRowCount: params.evaluatedSources.length,
    // Views own the selection: one per coin with a selected best row.
    // Equivalent to the construction-time bestSourceKeyByCoin.size because
    // evaluation only records winners drawn from the evaluated rows.
    bestRowCount: params.publicationViews.size,
    rowsRejected: params.rowsRejected,
    divergenceFlags: params.divergenceFlags,
    sourceSwitches: params.sourceSwitches,
  });
  throwIfAborted(params.signal);

  // Every exit from here must leave the generation in a terminal state: a
  // generation left `staged` reads as a live candidate on the publication
  // surface, so an abort mid-publication has to mark it failed (C11).
  try {
    const previewPublishability = await validateYieldRankingsPayloadForPublish(
      stagedRankingsPayload,
      params.previousYieldPublicationSnapshot,
    );
    if (!previewPublishability.ok) {
      params.degradationReasons.push(previewPublishability.reason ?? "schema-validation-failed");
      await finalizeFailedGeneration(previewPublishability.reason ?? "schema-validation-failed");
      return {
        ok: false,
        result: createCronResult({
          status: "degraded",
          itemCount: params.resolvedCount,
          metadata: {
            reason: "yield-rankings-preflight-failed",
            publishFailure: previewPublishability.reason ?? "schema-validation-failed",
            validationFailures: previewPublishability.validationFailures,
            rowsRejected: params.rowsRejected,
            divergenceFlags: params.divergenceFlags,
            sourceSwitches: params.sourceSwitches,
          },
        }),
      };
    }

    let updatedCount = 0;
    const publishedRankingsPayload = attachYieldPublicationMetadata(params.previewRankingsPayload, {
      generationId,
      startSec: params.startSec,
      status: "published",
    });
    let publicationWrite: YieldEvaluatedSourcesWriteResult;
    try {
      throwIfAborted(params.signal);
      publicationWrite = await persistEvaluatedYieldSources(params.db, {
        signal: params.signal,
        evaluatedSources: params.evaluatedSources,
        publicationViews: params.publicationViews,
        startSec: params.startSec,
        generationId,
        rankingsPayload: publishedRankingsPayload,
        previousYieldPublicationSnapshot: params.previousYieldPublicationSnapshot,
      });
    } catch (error) {
      rethrowIfAborted(error, params.signal);
      const reason = getD1FailureReason("yield-publication-transaction-failed", error);
      params.degradationReasons.push(reason);
      await finalizeFailedGeneration(reason).catch((finalizeError: unknown) => {
        logWorkerEventArgs("handler", "warn", "[sync-yield-data] Failed to mark yield generation failed after publication transaction failure:", finalizeError);
      });
      return {
        ok: false,
        result: createCronResult({
          status: "degraded",
          itemCount: params.resolvedCount,
          metadata: {
            reason: "yield-publication-transaction-failed",
            publishFailure: reason,
            validationFailures: 0,
            rowsRejected: params.rowsRejected,
            divergenceFlags: params.divergenceFlags,
            sourceSwitches: params.sourceSwitches,
          },
        }),
      };
    }
    if (!publicationWrite.ok) {
      const reason = publicationWrite.reason ?? "schema-validation-failed";
      params.degradationReasons.push(reason);
      await finalizeFailedGeneration(reason);
      await pruneYieldTables(params.db, params.startSec, {
        allowDestructiveCleanup: false,
        signal: params.signal,
      });
      return {
        ok: true,
        updatedCount,
        degradationReasons: params.degradationReasons,
        validationFailures: publicationWrite.validationFailures,
        cacheWriteSkipped: true,
        casSkipped: publicationWrite.cacheWrite?.skippedBecauseNewer === true,
        skipReason: reason,
        publicationStats: publicationWrite.cacheWrite?.publicationStats ?? null,
      };
    }

    updatedCount = publicationWrite.updatedCount;
    publicationApplied = true;
    const publicationStats = publicationWrite.cacheWrite.publicationStats;
    if (publicationStats?.oversize) {
      params.degradationReasons.push("yield-publication:payload-oversize");
    }
    throwIfAborted(params.signal);
    try {
      await writeFreshnessSentinel(params.db, "yield-data", params.startSec, params.signal);
    } catch (error) {
      rethrowIfAborted(error, params.signal);
      const reason = getD1FailureReason("yield-data-freshness-sentinel-failed", error);
      params.degradationReasons.push(reason);
      await repairPublishedYieldGenerationFromCache(params.db, params.startSec).catch((repairError: unknown) => {
        logWorkerEventArgs("handler", "warn", "[sync-yield-data] Failed to repair published yield generation after freshness sentinel failure:", repairError);
      });
    }

    throwIfAborted(params.signal);
    await pruneYieldTables(params.db, params.startSec, {
      allowDestructiveCleanup: params.degradationReasons.length === 0,
      signal: params.signal,
    });

    return {
      ok: true,
      updatedCount,
      degradationReasons: params.degradationReasons,
      validationFailures: publicationWrite.validationFailures,
      cacheWriteSkipped: false,
      casSkipped: publicationWrite.cacheWrite.skippedBecauseNewer,
      skipReason: null,
      publicationStats,
    };
  } catch (error) {
    if (!publicationApplied && !generationFinalized) {
      const reason = params.signal?.aborted ? "aborted" : getD1FailureReason("yield-publication-failed", error);
      await finalizeFailedGeneration(reason).catch((finalizeError: unknown) => {
        logWorkerEventArgs("handler", "warn", "[sync-yield-data] Failed to mark yield generation failed after an aborted publication step:", finalizeError);
      });
    }
    throw error;
  }
}
