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
import type { CronResult } from "../../lib/cron-logger";
import { createCronResult } from "../../lib/cron-result";
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
    }
> {
  throwIfAborted(params.signal);
  const generationId = buildYieldPublicationGenerationId(params.startSec);
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

  const previewPublishability = await validateYieldRankingsPayloadForPublish(
    stagedRankingsPayload,
    params.previousYieldPublicationSnapshot,
  );
  if (!previewPublishability.ok) {
    params.degradationReasons.push(previewPublishability.reason ?? "schema-validation-failed");
    await finalizeYieldPublicationGeneration(params.db, {
      generationId,
      state: "failed",
      timestamp: params.startSec,
      reason: previewPublishability.reason ?? "schema-validation-failed",
    });
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
  let publicationWrite: Awaited<ReturnType<typeof persistEvaluatedYieldSources>>;
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
    await finalizeYieldPublicationGeneration(params.db, {
      generationId,
      state: "failed",
      timestamp: params.startSec,
      reason,
    }).catch((finalizeError: unknown) => {
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
    await finalizeYieldPublicationGeneration(params.db, {
      generationId,
      state: "failed",
      timestamp: params.startSec,
      reason,
    });
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
    };
  }

  updatedCount = publicationWrite.updatedCount;
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
  };
}
