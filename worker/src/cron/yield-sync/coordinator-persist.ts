import { toYieldBenchmarkRegistry, type ParsedYieldBenchmarkRegistry } from "./benchmarks";
import { buildHistoryKey, type EvaluatedYieldSource } from "./evaluation";
import { buildYieldSourceProvenance } from "./provenance";
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
  writeYieldRankingsCache,
} from "./publication";
import type { YieldBenchmarkMeta, YieldSourceInputMeta } from "@shared/types/yield";
import type { CronResult } from "../../lib/cron-logger";
import { writeFreshnessSentinel } from "../../lib/db-cache";

function getPublicationFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message ? `cache-write-failed:${message.slice(0, 120)}` : "cache-write-failed";
}

function getD1FailureReason(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
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
  previewRankingProvenanceByKey: Map<string, Record<string, unknown>>;
} {
  const previewRankingProvenanceByKey = new Map<string, Record<string, unknown>>();
  for (const source of params.evaluatedSources) {
    previewRankingProvenanceByKey.set(
      buildHistoryKey(source.id, source.sourceKey),
      buildYieldSourceProvenance({
        source,
        isBest: params.bestSourceKeyByCoin.get(source.id) === source.sourceKey,
        evaluatedSources: params.evaluatedSources,
        startSec: params.startSec,
        dlPoolsMeta: params.dlPoolsMeta,
      }),
    );
  }

  return {
    previewRankingProvenanceByKey,
    previewRankingsPayload: buildYieldRankingsPayloadFromEvaluatedSources({
      evaluatedSources: params.evaluatedSources,
      bestSourceKeyByCoin: params.bestSourceKeyByCoin,
      rankingProvenanceByKey: previewRankingProvenanceByKey,
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
  previewRankingsPayload: ReturnType<typeof buildYieldRankingsPayloadFromEvaluatedSources>;
  evaluatedSources: EvaluatedYieldSource[];
  bestSourceKeyByCoin: Map<string, string>;
  startSec: number;
  medianApy: number;
  dlPoolsMeta: YieldSourceInputMeta;
  degradationReasons: string[];
  resolvedCount: number;
  rowsRejected: number;
  divergenceFlags: number;
  sourceSwitches: number;
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
    bestRowCount: params.bestSourceKeyByCoin.size,
    rowsRejected: params.rowsRejected,
    divergenceFlags: params.divergenceFlags,
    sourceSwitches: params.sourceSwitches,
  });

  const previewPublishability = await validateYieldRankingsPayloadForPublish(params.db, stagedRankingsPayload);
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
      result: {
        status: "degraded",
        itemCount: params.resolvedCount,
        metadata: JSON.stringify({
          reason: "yield-rankings-preflight-failed",
          publishFailure: previewPublishability.reason ?? "schema-validation-failed",
          validationFailures: previewPublishability.validationFailures,
          rowsRejected: params.rowsRejected,
          divergenceFlags: params.divergenceFlags,
          sourceSwitches: params.sourceSwitches,
        }),
      },
    };
  }

  let updatedCount = 0;
  const publishedRankingsPayload = attachYieldPublicationMetadata(params.previewRankingsPayload, {
    generationId,
    startSec: params.startSec,
    status: "published",
  });
  const cacheWrite = await writeYieldRankingsCache(params.db, publishedRankingsPayload, params.startSec).catch((error: unknown) => {
    const reason = getPublicationFailureReason(error);
    console.warn("[sync-yield-data] Failed to publish yield-rankings cache after preflight:", error);
    return {
      ok: false,
      validationFailures: 0,
      reason,
    };
  });
  if (!cacheWrite.ok) {
    params.degradationReasons.push(cacheWrite.reason ?? "schema-validation-failed");
    await finalizeYieldPublicationGeneration(params.db, {
      generationId,
      state: "failed",
      timestamp: params.startSec,
      reason: cacheWrite.reason ?? "schema-validation-failed",
    });
    await pruneYieldTables(params.db, params.startSec, {
      allowDestructiveCleanup: false,
    });
    return {
      ok: true,
      updatedCount,
      degradationReasons: params.degradationReasons,
      validationFailures: cacheWrite.validationFailures,
      cacheWriteSkipped: true,
      casSkipped: "cacheWrite" in cacheWrite && cacheWrite.cacheWrite?.skippedBecauseNewer === true,
    };
  }

  let d1PublishSucceeded = false;
  try {
    ({ updatedCount } = await persistEvaluatedYieldSources(params.db, {
      evaluatedSources: params.evaluatedSources,
      bestSourceKeyByCoin: params.bestSourceKeyByCoin,
      startSec: params.startSec,
      medianApy: params.medianApy,
      dlPoolsMeta: params.dlPoolsMeta,
      generationId,
      publicationState: "published",
    }));
    d1PublishSucceeded = true;
  } catch (error) {
    const reason = getD1FailureReason("d1-published-write-failed", error);
    params.degradationReasons.push(reason);
    await finalizeYieldPublicationGeneration(params.db, {
      generationId,
      state: "failed",
      timestamp: params.startSec,
      reason,
    }).catch((finalizeError: unknown) => {
      console.warn("[sync-yield-data] Failed to mark published-cache yield generation failed:", finalizeError);
    });
  }

  if (d1PublishSucceeded) {
    try {
      await finalizeYieldPublicationGeneration(params.db, {
        generationId,
        state: "published",
        timestamp: params.startSec,
      });
      await writeFreshnessSentinel(params.db, "yield-data", params.startSec);
    } catch (error) {
      const reason = getD1FailureReason("published-generation-finalization-failed", error);
      params.degradationReasons.push(reason);
      await repairPublishedYieldGenerationFromCache(params.db, params.startSec).catch((repairError: unknown) => {
        console.warn("[sync-yield-data] Failed to repair published yield generation after cache write:", repairError);
      });
    }
  }

  await pruneYieldTables(params.db, params.startSec, {
    allowDestructiveCleanup: params.degradationReasons.length === 0,
  });

  return {
    ok: true,
    updatedCount,
    degradationReasons: params.degradationReasons,
    validationFailures: cacheWrite.validationFailures,
    cacheWriteSkipped: !cacheWrite.ok,
    casSkipped: "cacheWrite" in cacheWrite && cacheWrite.cacheWrite?.skippedBecauseNewer === true,
  };
}
