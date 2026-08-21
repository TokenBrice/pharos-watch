import type { ChainRpcConfig } from "../lib/chain-registry";
import type { CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";
import {
  getCaches,
  setCacheIfNewer,
} from "../lib/db-cache";
import {
  appendSupplyAttributionJournalV1,
} from "../lib/safety-score-v9-supply-attribution-journal-store";
import {
  captureSafetyScoreV9SupplyAttribution,
} from "../lib/safety-score-v9-supply-attribution";
import {
  parseSafetyScoreV9SupplyAttributionSource,
  SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_SOURCE_CACHE_KEY,
  type SafetyScoreV9SupplyAttributionSource,
} from "../lib/safety-score-v9-supply-attribution-source";
import {
  createSafetyScoreV9SupplyAttributionGeneration,
  isSafetyScoreV9SupplyAttributionGenerationCompatible,
  nextSafetyScoreV9SupplyAttributionDueAtSec,
  parseSafetyScoreV9SupplyAttributionGeneration,
  SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY,
  serializeSafetyScoreV9SupplyAttributionGeneration,
} from "../lib/safety-score-v9-supply-attribution-generation";

const SOURCE_FIXED_INPUT_MAX_AGE_SEC = 30 * 60;

function diagnosticRejectedAssetIds(
  generation: ReturnType<typeof createSafetyScoreV9SupplyAttributionGeneration>,
): string[] {
  return generation.rejectedAssetIds.filter((assetId) => {
    const outcome = generation.outcomesById[assetId];
    return (
      outcome?.status === "rejected" &&
      outcome.rejectionCode === "transparency-stale"
    );
  });
}

export async function syncSafetyScoreV9SupplyAttribution(
  db: D1Database,
  chainRpcs?: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
): Promise<CronResult> {
  const startedAtSec = Math.floor(Date.now() / 1_000);
  throwIfAborted(signal);
  const caches = await getCaches(db, [
    SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_SOURCE_CACHE_KEY,
    SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY,
  ]);
  const sourceCache = caches.get(
    SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_SOURCE_CACHE_KEY,
  );
  if (!sourceCache) {
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        stage: "source-fixed-input",
        reason: "source-fixed-input-missing",
      }),
      productivity: {
        productive: false,
        reason: "source-fixed-input-missing",
      },
    };
  }

  let fixedInput: SafetyScoreV9SupplyAttributionSource;
  try {
    fixedInput = parseSafetyScoreV9SupplyAttributionSource(sourceCache.value);
  } catch (error) {
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        stage: "source-fixed-input",
        reason: "source-fixed-input-invalid",
        code:
          error instanceof Error && error.name
            ? error.name.slice(0, 160)
            : "Error",
      }),
      productivity: {
        productive: false,
        reason: "source-fixed-input-invalid",
      },
    };
  }
  if (
    fixedInput.clockSec > startedAtSec ||
    startedAtSec - fixedInput.clockSec > SOURCE_FIXED_INPUT_MAX_AGE_SEC
  ) {
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        stage: "source-fixed-input",
        reason: "source-fixed-input-stale",
        sourceClockSec: fixedInput.clockSec,
        ageSec: startedAtSec - fixedInput.clockSec,
      }),
      productivity: {
        productive: false,
        reason: "source-fixed-input-stale",
      },
    };
  }

  let priorGenerationStatus:
    | "missing"
    | "malformed"
    | "due"
    | "fresh" = "missing";
  const priorCache = caches.get(
    SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY,
  );
  if (priorCache) {
    try {
      const priorGeneration =
        parseSafetyScoreV9SupplyAttributionGeneration(priorCache.value);
      if (
        isSafetyScoreV9SupplyAttributionGenerationCompatible(
          fixedInput,
          priorGeneration,
          startedAtSec,
        ) &&
        startedAtSec <
          nextSafetyScoreV9SupplyAttributionDueAtSec(priorGeneration)
      ) {
        priorGenerationStatus = "fresh";
        return {
          status: "skipped_neutral",
          itemCount: priorGeneration.acceptedAssetIds.length,
          metadata: JSON.stringify({
            stage: "cooldown",
            generationId: priorGeneration.generationId,
            acceptedCount: priorGeneration.acceptedAssetIds.length,
            rejectedCount: priorGeneration.rejectedAssetIds.length,
            nextDueAtSec:
              nextSafetyScoreV9SupplyAttributionDueAtSec(
                priorGeneration,
              ),
          }),
          productivity: {
            productive: false,
            reason: "supply-attribution-generation-fresh",
          },
        };
      }
      priorGenerationStatus = "due";
    } catch {
      priorGenerationStatus = "malformed";
    }
  }

  const capture = await captureSafetyScoreV9SupplyAttribution(
    fixedInput,
    chainRpcs,
    signal,
    {
      clockMode: "wall",
      notBeforeSec: startedAtSec,
    },
  );
  throwIfAborted(signal);
  const capturedAtSec = Math.max(
    startedAtSec,
    Math.floor(Date.now() / 1_000),
    ...capture.journalRecords.map((record) => record.completedAtSec),
  );
  const generation =
    createSafetyScoreV9SupplyAttributionGeneration({
      fixedInput,
      capture,
      capturedAtSec,
    });

  if (capture.journalRecords.length > 0) {
    await appendSupplyAttributionJournalV1(
      db,
      capture.journalRecords,
      capturedAtSec,
      signal,
    );
  }
  const cacheWrite = await setCacheIfNewer(
    db,
    SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY,
    serializeSafetyScoreV9SupplyAttributionGeneration(generation),
    startedAtSec,
    signal,
  );
  if (!cacheWrite.written) {
    return {
      status: "skipped_neutral",
      itemCount: 0,
      metadata: JSON.stringify({
        stage: "publication",
        reason: "newer-generation-present",
        generationId: generation.generationId,
      }),
      productivity: {
        productive: false,
        reason: "newer-supply-attribution-generation-present",
      },
    };
  }

  const diagnosticRejected = diagnosticRejectedAssetIds(generation);
  const diagnosticRejectedSet = new Set(diagnosticRejected);
  const blockingRejectedAssetIds = generation.rejectedAssetIds.filter(
    (assetId) => !diagnosticRejectedSet.has(assetId),
  );
  const complete = blockingRejectedAssetIds.length === 0;
  return {
    status: complete ? "ok" : "degraded",
    itemCount: generation.acceptedAssetIds.length,
    metadata: JSON.stringify({
      stage: "published",
      generationId: generation.generationId,
      sourceBaseInputGenerationId:
        generation.sourceBaseInputGenerationId,
      sourceClockSec: generation.sourceClockSec,
      captureClockSec: generation.captureClockSec,
      capturedAtSec: generation.capturedAtSec,
      expectedCount: generation.expectedAssetIds.length,
      observedCount: generation.observedAssetIds.length,
      acceptedCount: generation.acceptedAssetIds.length,
      rejectedCount: generation.rejectedAssetIds.length,
      rejectedAssetIds: generation.rejectedAssetIds,
      diagnosticRejectedCount: diagnosticRejected.length,
      diagnosticRejectedAssetIds: diagnosticRejected,
      blockingRejectedCount: blockingRejectedAssetIds.length,
      blockingRejectedAssetIds,
      priorGenerationStatus,
    }),
    productivity: {
      productive: true,
      reason: complete
        ? generation.rejectedAssetIds.length > 0
          ? "supply-attribution-generation-published-with-diagnostic-rejections"
          : "supply-attribution-generation-published"
        : "supply-attribution-generation-published-with-blocking-rejections",
    },
  };
}
