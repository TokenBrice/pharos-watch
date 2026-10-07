import type { ChainRpcConfig } from "../lib/chain-registry";
import type { CronResult } from "../lib/cron-logger";
import { createCronResult } from "../lib/cron-result";
import { throwIfAborted } from "../lib/abort";
import type { V9ExecutionWindow } from "../lib/v9-slot-window";
import {
  getCaches,
  prepareCacheUpsert,
} from "../lib/db-cache";
import {
  appendSupplyAttributionJournalV1,
} from "../lib/safety-score-v9/supply-attribution-journal-store";
import {
  captureSafetyScoreV9SupplyAttribution,
} from "../lib/safety-score-v9/supply-attribution";
import {
  parseSafetyScoreV9SupplyAttributionSource,
  SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_SOURCE_CACHE_KEY,
  SOURCE_FIXED_INPUT_MAX_AGE_SEC,
  type SafetyScoreV9SupplyAttributionSource,
} from "../lib/safety-score-v9/supply-attribution-source";
import {
  createSafetyScoreV9SupplyAttributionGeneration,
  isSafetyScoreV9SupplyAttributionGenerationCompatible,
  nextSafetyScoreV9SupplyAttributionDueAtSec,
  parseSafetyScoreV9SupplyAttributionGeneration,
  SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY,
  serializeSafetyScoreV9SupplyAttributionGeneration,
  type SafetyScoreV9SupplyAttributionGeneration,
} from "../lib/safety-score-v9/supply-attribution-generation";

import {
  captureTupleMatchesSource, parseSafetyScoreV9CaptureControl, prepareAttributionSettlement,
  SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY, settleAttribution,
} from "../lib/safety-score-v9/capture-control";
import { batchExecute } from "../lib/d1-primitives";
import { buildResourcePressure } from "../lib/cron-resource-pressure";
import { ECONOMIC_SUPPLY_BODY_CAPS } from "../lib/safety-score-v9/economic-supply-observer";

function diagnosticRejectedAssetIds(
  generation: SafetyScoreV9SupplyAttributionGeneration,
): string[] {
  return generation.rejectedAssetIds.filter((assetId) => {
    const outcome = generation.outcomesById[assetId];
    return (
      outcome?.status === "rejected" &&
      outcome.rejectionCode === "transparency-stale"
    );
  });
}

function classifyRejectedAssets(generation: SafetyScoreV9SupplyAttributionGeneration) {
  const diagnostic = diagnosticRejectedAssetIds(generation);
  const progress = generation.rejectedAssetIds.filter(assetId => {
    const outcome = generation.outcomesById[assetId];
    if (outcome?.status !== "rejected" ||
      !["deployment-observation-window-insufficient", "deployment-state-unavailable"].includes(outcome.rejectionCode)) return false;
    const diagnostics = outcome.diagnostics ?? [];
    return diagnostics.some(attempt => attempt.incompleteBootstrap &&
      attempt.authenticatedCursorAdvanced && attempt.persisted) &&
      !diagnostics.some(attempt => attempt.hardEvidenceFailure);
  });
  const nonblocking = new Set([...diagnostic, ...progress]);
  return { diagnostic, progress, blocking: generation.rejectedAssetIds.filter(assetId => !nonblocking.has(assetId)) };
}

export async function syncSafetyScoreV9SupplyAttribution(
  db: D1Database,
  chainRpcs?: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
  executionWindow?: V9ExecutionWindow,
): Promise<CronResult> {
  const startedAtSec = Math.floor(Date.now() / 1_000);
  throwIfAborted(signal);
  const caches = await getCaches(db, [
    SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_SOURCE_CACHE_KEY,
    SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY,
    SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY,
  ]);
  const controlCache = caches.get(SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY);
  const control = controlCache ? parseSafetyScoreV9CaptureControl(controlCache.value) : null;
  const sourceCache = caches.get(
    SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_SOURCE_CACHE_KEY,
  );
  if (!sourceCache) {
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: { stage: "source-fixed-input", reason: "source-fixed-input-missing" },
      productivity: {
        productive: false,
        reason: "source-fixed-input-missing",
      },
    });
  }

  let fixedInput: SafetyScoreV9SupplyAttributionSource;
  try {
    fixedInput = parseSafetyScoreV9SupplyAttributionSource(sourceCache.value);
  } catch (error) {
    // A malformed payload can still identify the exact source whose request failed.
    let failedSource: unknown;
    try { failedSource = JSON.parse(sourceCache.value); } catch { failedSource = null; }
    if (control && failedSource !== null && typeof failedSource === "object" &&
      "baseInputGenerationId" in failedSource && failedSource.baseInputGenerationId === control.capture.baseInputGenerationId &&
      "sourceGeneration" in failedSource && failedSource.sourceGeneration === control.capture.sourceGeneration &&
      "clockSec" in failedSource && failedSource.clockSec === control.capture.clockSec &&
      "registryFingerprint" in failedSource && failedSource.registryFingerprint === control.capture.registryFingerprint) {
      await settleAttribution(db, control, control.capture, executionWindow?.slotStartedAtSec, "degraded", null);
    }
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: {
        stage: "source-fixed-input",
        reason: "source-fixed-input-invalid",
        code:
          error instanceof Error && error.name
            ? error.name.slice(0, 160)
            : "Error",
      },
      productivity: {
        productive: false,
        reason: "source-fixed-input-invalid",
      },
    });
  }
  if (
    fixedInput.clockSec > startedAtSec ||
    startedAtSec - fixedInput.clockSec > SOURCE_FIXED_INPUT_MAX_AGE_SEC
  ) {
    await settleAttribution(db, control, fixedInput, executionWindow?.slotStartedAtSec, "degraded", null);
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: {
        stage: "source-fixed-input",
        reason: "source-fixed-input-stale",
        sourceClockSec: fixedInput.clockSec,
        ageSec: startedAtSec - fixedInput.clockSec,
      },
      productivity: {
        productive: false,
        reason: "source-fixed-input-stale",
      },
    });
  }

  let priorGenerationStatus:
    | "missing"
    | "malformed"
    | "due"
    | "fresh" = "missing";
  const priorCache = caches.get(
    SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY,
  );
  let priorGeneration: SafetyScoreV9SupplyAttributionGeneration | null = null;
  if (priorCache) {
    try {
      priorGeneration = parseSafetyScoreV9SupplyAttributionGeneration(priorCache.value);
      priorGenerationStatus = "due";
    } catch {
      priorGenerationStatus = "malformed";
    }
  }
  if (priorGeneration &&
    isSafetyScoreV9SupplyAttributionGenerationCompatible(fixedInput, priorGeneration, startedAtSec) &&
    startedAtSec < nextSafetyScoreV9SupplyAttributionDueAtSec(priorGeneration)) {
    priorGenerationStatus = "fresh";
    if (control && captureTupleMatchesSource(control.capture, {
      baseInputGenerationId: priorGeneration.sourceBaseInputGenerationId,
      sourceGeneration: priorGeneration.sourceGeneration,
      clockSec: priorGeneration.sourceClockSec,
      registryFingerprint: priorGeneration.registryFingerprint,
    })) {
      const blocking = classifyRejectedAssets(priorGeneration).blocking.length;
      await settleAttribution(db, control, fixedInput, executionWindow?.slotStartedAtSec,
        blocking > 0 ? "degraded" : "ok", priorGeneration.generationId);
    }
    return createCronResult({
      status: "skipped_neutral",
      itemCount: priorGeneration.acceptedAssetIds.length,
      metadata: {
        reason: "supply-attribution-generation-fresh", stage: "cooldown",
        generationId: priorGeneration.generationId,
        acceptedCount: priorGeneration.acceptedAssetIds.length,
        rejectedCount: priorGeneration.rejectedAssetIds.length,
        nextDueAtSec: nextSafetyScoreV9SupplyAttributionDueAtSec(priorGeneration),
      },
      productivity: { productive: false, reason: "supply-attribution-generation-fresh" },
    });
  }

  const resourcePressure = buildResourcePressure({
    phase: "supply-attribution-capture", bodyCapBytes: Math.max(...Object.values(ECONOMIC_SUPPLY_BODY_CAPS)),
  });
  try {
  const capture = await captureSafetyScoreV9SupplyAttribution(
    fixedInput,
    chainRpcs,
    signal,
    {
      clockMode: "wall",
      notBeforeSec: startedAtSec,
      executionWindow,
      db,
      onBodyRead: evidence => {
        resourcePressure.observedAt = Math.floor(Date.now() / 1_000);
        if (evidence.intakeBytes !== null) {
          resourcePressure.intakeBytes = (resourcePressure.intakeBytes ?? 0) + evidence.intakeBytes;
          resourcePressure.intakeBasis = "actual-stream";
        }
        resourcePressure.rejectedBodies = (resourcePressure.rejectedBodies ?? 0) + (evidence.outcome === "rejected" ? 1 : 0);
        resourcePressure.guard = resourcePressure.rejectedBodies > 0 ? "resource-budget-exceeded" : "within-policy";
      },
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
  const { diagnostic: diagnosticRejected, progress, blocking: blockingRejectedAssetIds } = classifyRejectedAssets(generation);
  const complete = blockingRejectedAssetIds.length === 0;
  const qualityReasons = [
    ...(progress.length ? ["supply-attribution-bootstrap-in-progress"] : []),
    ...(diagnosticRejected.length ? ["supply-attribution-diagnostic-rejections"] : []),
  ];
  const publication = {
    key: SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY,
    value: serializeSafetyScoreV9SupplyAttributionGeneration(generation),
    updatedAt: startedAtSec,
  };
  const settlement = control ? prepareAttributionSettlement(db, control, fixedInput,
    executionWindow?.slotStartedAtSec, complete ? "ok" : "degraded", generation.generationId, publication) : null;
  const changes = await batchExecute(db, [
    prepareCacheUpsert(db, publication, "if-newer"),
    ...(settlement ? [settlement] : []),
  ], { chunkSize: 2, signal });
  const cacheWrite = { written: changes > 0 };
  if (!cacheWrite.written) {
    return createCronResult({
      status: "skipped_neutral",
      itemCount: 0,
      metadata: { stage: "publication", reason: "newer-generation-present", generationId: generation.generationId },
      productivity: {
        productive: false,
        reason: "newer-supply-attribution-generation-present",
      },
    });
  }

  return createCronResult({
    status: complete ? "ok" : "degraded",
    itemCount: generation.acceptedAssetIds.length,
    metadata: {
      reason: complete ? "supply-attribution-generation-published" : "supply-attribution-blocking-rejections",
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
      bootstrapProgressAssetIds: progress,
      captureFailureReasonsById: capture.failureReasonById ?? {},
      resourcePressure,
      ...(qualityReasons.length ? { quality: {
        reason: qualityReasons[0], reasons: qualityReasons,
        sources: { bootstrapProgressAssetIds: progress, diagnosticRejectedAssetIds: diagnosticRejected, blockingRejectedAssetIds },
      } } : {}),
    },
    productivity: {
      productive: true,
      reason: complete
        ? progress.length ? "supply-attribution-generation-published-with-bootstrap-progress"
          : generation.rejectedAssetIds.length > 0
          ? "supply-attribution-generation-published-with-diagnostic-rejections"
          : "supply-attribution-generation-published"
        : "supply-attribution-generation-published-with-blocking-rejections",
    },
  });
  } catch (error) {
    // Persistence after cancellation revokes provenance; the original run still fails.
    await settleAttribution(db, control, fixedInput, executionWindow?.slotStartedAtSec, "error", null);
    throw error;
  }
}
