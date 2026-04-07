import { toYieldBenchmarkRegistry, type ParsedYieldBenchmarkRegistry } from "./benchmarks";
import { buildHistoryKey, type EvaluatedYieldSource } from "./evaluation";
import { buildYieldSourceProvenance } from "./provenance";
import {
  buildYieldRankingsPayloadFromEvaluatedSources,
  persistEvaluatedYieldSources,
  pruneYieldTables,
  validateYieldRankingsPayloadForPublish,
  writeYieldRankingsCache,
} from "./publication";
import type { YieldBenchmarkMeta, YieldSourceInputMeta } from "@shared/types/yield";
import type { CronResult } from "../../lib/cron-logger";

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
    }
> {
  const previewPublishability = await validateYieldRankingsPayloadForPublish(params.db, params.previewRankingsPayload);
  if (!previewPublishability.ok) {
    params.degradationReasons.push(previewPublishability.reason ?? "schema-validation-failed");
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

  const { updatedCount } = await persistEvaluatedYieldSources(params.db, {
    evaluatedSources: params.evaluatedSources,
    bestSourceKeyByCoin: params.bestSourceKeyByCoin,
    startSec: params.startSec,
    medianApy: params.medianApy,
    dlPoolsMeta: params.dlPoolsMeta,
  });

  const cacheWrite = await writeYieldRankingsCache(params.db, params.previewRankingsPayload);
  if (!cacheWrite.ok) {
    params.degradationReasons.push(cacheWrite.reason ?? "schema-validation-failed");
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
  };
}
