import {
  buildSafetyScoreV9InputIdentity,
  diagnoseSafetyScoreV9InputIdentityMismatch,
  safetyScoreV9InputIdentitiesMatch,
} from "@shared/lib/safety-score-v9-input-identity";
import { throwIfAborted } from "../lib/abort";
import { getCaches, getCacheUpdatedAt } from "../lib/db-cache";
import type {
  CronProgressReporter,
  CronResult,
} from "../lib/cron-logger";
import { createCronResult, type CronMetadataRecord } from "../lib/cron-result";
import { loadReportCardEvidenceJournalByIdV1 } from "../lib/report-card-evidence-journal-store";
import {
  NATIVE_V9_INPUT_CACHE_KEY,
  parseNativeV9InputCacheArtifact,
  type NativeV9InputCacheArtifact,
} from "../lib/safety-score-v9/native-input";
import {
  parseSafetyScoreV9PegProvenanceSeed,
  SAFETY_SCORE_V9_PEG_PROVENANCE_SEED_CACHE_KEY,
  type SafetyScoreV9PegProvenanceSeed,
} from "../lib/safety-score-v9/peg-provenance";
import { runSafetyScoreV9Publication } from "../lib/safety-score-v9/publication-runner";
import {
  SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_ASSET_IDS,
} from "../lib/safety-score-v9/supply-attribution";
import {
  applySafetyScoreV9SupplyAttributionGeneration,
  parseSafetyScoreV9SupplyAttributionGeneration,
  SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY,
  type SafetyScoreV9SupplyAttributionGeneration,
} from "../lib/safety-score-v9/supply-attribution-generation";
import { loadSupplyAttributionJournalByIdV1 } from "../lib/safety-score-v9/supply-attribution-journal-store";
import { loadExactDexPublicationGeneration } from "../lib/report-cards-snapshot";
import type { SafetyScoreV9BridgeJoinDiagnostic } from "../lib/safety-score-v9/candidate";
import {
  parseSafetyScoreV9TransferMaterialityGeneration,
  SAFETY_SCORE_V9_TRANSFER_MATERIALITY_CACHE_KEY,
  type SafetyScoreV9TransferMaterialityGeneration,
} from "../lib/safety-score-v9/transfer-materiality";
import type { V9PublicationHoldReason } from "@shared/types/report-cards-v9";
import type { V9PublicationCoverageFloor } from "../lib/safety-score-v9/publication-assessment";
import { computeReportCardsRegistryFingerprint } from "@shared/lib/report-cards-fixed-input-identity";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import {
  captureTupleMatchesSource, hasPendingAttribution, parseSafetyScoreV9CaptureControl,
  requestRecapture, SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY, v9WorkerProvenance, type V9WorkerProvenance,
} from "../lib/safety-score-v9/capture-control";
import type { SafetyScoreV9CaptureControl } from "@shared/types/safety-score-v9-capture-control";
import type { V9ExecutionWindow } from "../lib/v9-slot-window";
import { TRACKED_SOURCE_COINS } from "@shared/lib/stablecoins/registry";
import { assessSafetyScoreV9ResourceBudget } from "../lib/safety-score-v9/resource-budget";

/**
 * A held attempt is only attributable if the numbers it was decided on reach
 * `cron_runs.metadata`. The metadata compactor reduces every array diagnostic to
 * a `<key>Count` scalar once the payload crosses the 64 KiB cap — which this
 * producer always does — so `coverageFloors` and `reasons` arrive as bare counts
 * and a `coverage-floor-failed` hold shows no observed-vs-required value at all.
 * These two formatters mirror the same verdicts as bounded scalars that survive
 * compaction.
 */
function summarizeCoverageFloors(
  floors: readonly V9PublicationCoverageFloor[],
): string {
  return floors
    .map(
      (floor) =>
        `${floor.id}:${floor.status}:observed=${floor.observed ?? "null"},required=${floor.required}`,
    )
    .join(";");
}

function summarizeHoldReasons(
  reasons: readonly V9PublicationHoldReason[],
): string {
  return reasons
    .map((reason) => {
      if (reason.code === "coverage-floor-failed") {
        return `${reason.code}:${reason.floorIds.join("|")}`;
      }
      if (reason.code === "producer-failed-pipeline-gap") {
        return `${reason.code}:${reason.assetId}:${reason.reasonCode}:${reason.effect}`;
      }
      if (reason.code === "assessment-failed") {
        return `${reason.code}:${reason.detail}`;
      }
      return reason.code;
    })
    .join(",");
}

/**
 * Per-asset bridge-join diagnostics are the largest field this producer emits
 * (~240 assets carrying nested join arrays) and alone hold the row past the
 * 64 KiB persistence cap — where the compactor rewrote the whole array as a
 * single count anyway and stamped the run `cron-metadata-over-64-kib`,
 * masking its real degradation reason. Emit the bounded aggregate eagerly so
 * the counts survive under the cap; per-asset detail stays replayable from the
 * publication candidate.
 */
function summarizeBridgeJoinDiagnostics(
  diagnostics: readonly SafetyScoreV9BridgeJoinDiagnostic[],
): {
  assetCount: number;
  applicableAssetCount: number;
  unmatchedRowIdentityCount: number;
  unprovenRouteJoinCount: number;
} {
  let applicableAssetCount = 0;
  let unmatchedRowIdentityCount = 0;
  let unprovenRouteJoinCount = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.applicabilityBranch === "applicable") {
      applicableAssetCount += 1;
    }
    unmatchedRowIdentityCount += diagnostic.unmatchedRowIdentities.length;
    unprovenRouteJoinCount += diagnostic.unprovenRouteJoins.length;
  }
  return {
    assetCount: diagnostics.length,
    applicableAssetCount,
    unmatchedRowIdentityCount,
    unprovenRouteJoinCount,
  };
}

function unavailable(
  reason: string,
  metadata: CronMetadataRecord = {},
): CronResult {
  return createCronResult({
    status: "degraded",
    itemCount: 0,
    metadata: {
      stage: "input-load",
      reason,
      ...metadata,
    },
    productivity: {
      productive: false,
      reason: "v9-publication-source-unavailable",
    },
  });
}

export async function computeSafetyScoreV9(
  db: D1Database,
  signal?: AbortSignal,
  reportProgress?: CronProgressReporter,
  options: { retainAcceptedReplay?: boolean; captureArchiveBucket?: R2Bucket; captureArchiveContext?: ExecutionContext; workerMetadata?: V9WorkerProvenance; executionWindow?: V9ExecutionWindow } = {},
): Promise<CronResult> {
  throwIfAborted(signal);
  const catalogAdmission = assessSafetyScoreV9ResourceBudget({
    catalogAssets: TRACKED_SOURCE_COINS.length, activeAssets: 0, inputBytes: null,
  });
  if (!catalogAdmission.admitted) return unavailable("resource-budget-exceeded", {
    stage: "compile-admission", resourcePressure: catalogAdmission.resourcePressure,
  });
  await reportProgress?.({
    stage: "input-load",
    message: "Loading publication-exact base and V9 seed inputs",
    metadata: { resourcePressure: catalogAdmission.resourcePressure },
  });
  const caches = await getCaches(db, [
    NATIVE_V9_INPUT_CACHE_KEY,
    SAFETY_SCORE_V9_PEG_PROVENANCE_SEED_CACHE_KEY,
    SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY,
    SAFETY_SCORE_V9_TRANSFER_MATERIALITY_CACHE_KEY,
    SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY,
  ]);
  throwIfAborted(signal);

  if (!caches.has(NATIVE_V9_INPUT_CACHE_KEY)) {
    return unavailable("fixed-input-missing");
  }
  if (!caches.has(SAFETY_SCORE_V9_PEG_PROVENANCE_SEED_CACHE_KEY)) {
    return unavailable("v9-exact-seed-missing");
  }
  // Read one declared scalar without copying the large base64 transport. Full
  // envelope, checksum and expanded-byte admission still belong to the codec.
  const byteHeader = caches.get(NATIVE_V9_INPUT_CACHE_KEY)!.value.match(/"uncompressedBytes"\s*:\s*(\d+)/);
  const inputBytes = byteHeader ? Number(byteHeader[1]) : null;
  const byteAdmission = assessSafetyScoreV9ResourceBudget({
    catalogAssets: TRACKED_SOURCE_COINS.length, activeAssets: 0, inputBytes,
  });
  if (!byteAdmission.admitted) return unavailable("resource-budget-exceeded", {
    stage: "compile-admission", resourcePressure: byteAdmission.resourcePressure,
  });

  let baseArtifact: NativeV9InputCacheArtifact;
  const fixedInputCacheValue = options.retainAcceptedReplay === false
    ? undefined
    : caches.get(NATIVE_V9_INPUT_CACHE_KEY)!.value;
  let v9Seed: SafetyScoreV9PegProvenanceSeed;
  try {
    v9Seed = parseSafetyScoreV9PegProvenanceSeed(
      caches.get(
        SAFETY_SCORE_V9_PEG_PROVENANCE_SEED_CACHE_KEY,
      )!.value,
    );
    caches.delete(SAFETY_SCORE_V9_PEG_PROVENANCE_SEED_CACHE_KEY);
    baseArtifact = await parseNativeV9InputCacheArtifact(
      caches.get(NATIVE_V9_INPUT_CACHE_KEY)!.value,
    );
    caches.delete(NATIVE_V9_INPUT_CACHE_KEY);
  } catch (error) {
    return unavailable("exact-input-invalid", {
      code:
        error instanceof Error && error.name
          ? error.name.slice(0, 160)
          : "Error",
    });
  }

  const fixedInput = baseArtifact.input;
  const resourceAdmission = assessSafetyScoreV9ResourceBudget({
    catalogAssets: TRACKED_SOURCE_COINS.length, activeAssets: fixedInput.activeAssetIds.length, inputBytes,
  });
  if (!resourceAdmission.admitted) return unavailable("resource-budget-exceeded", {
    stage: "compile-admission", activeAssets: fixedInput.activeAssetIds.length,
    resourcePressure: resourceAdmission.resourcePressure,
  });
  await reportProgress?.({ stage: "compile-admission", metadata: { resourcePressure: resourceAdmission.resourcePressure } });
  let latestStablecoinsUpdatedAt: number | null;
  try {
    latestStablecoinsUpdatedAt = await getCacheUpdatedAt(
      db,
      "stablecoins",
    );
  } catch (error) {
    return unavailable("latest-stablecoins-generation-unavailable", {
      code: error instanceof Error ? error.name : "Error",
    });
  }
  if (latestStablecoinsUpdatedAt === null) {
    return unavailable("latest-stablecoins-generation-unavailable");
  }
  if (fixedInput.updatedAt !== latestStablecoinsUpdatedAt) {
    return unavailable("stablecoins-generation-mismatch", {
      fixedInputStablecoinsUpdatedAt: fixedInput.updatedAt,
      latestStablecoinsUpdatedAt,
    });
  }
  let latestDexGenerationId: string;
  try {
    latestDexGenerationId = (
      await loadExactDexPublicationGeneration(db)
    ).generationId;
  } catch (error) {
    return unavailable("latest-dex-generation-unavailable", {
      code: error instanceof Error ? error.name : "Error",
    });
  }
  if (fixedInput.dexGenerationId !== latestDexGenerationId) {
    return unavailable("dex-generation-advanced", {
      fixedInputDexGenerationId: fixedInput.dexGenerationId,
      latestDexGenerationId,
    });
  }
  const v9SeedInput = {
    ...fixedInput,
    pegProvenanceById: v9Seed.pegProvenanceById,
  };
  const expectedIdentity = buildSafetyScoreV9InputIdentity({
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    baseInputGenerationId: fixedInput.baseInputGenerationId,
    publicationGenerationId: fixedInput.sourceGeneration,
  });
  const expectedProvenanceIds = Object.keys(
    fixedInput.pegDataById,
  ).sort();
  const presentProvenanceIds = Object.keys(
    v9SeedInput.pegProvenanceById,
  ).sort();
  if (
    expectedProvenanceIds.length !== presentProvenanceIds.length ||
    expectedProvenanceIds.some(
      (assetId, index) => assetId !== presentProvenanceIds[index],
    )
  ) {
    return unavailable("v9-peg-provenance-incomplete", {
      expectedCount: expectedProvenanceIds.length,
      presentCount: presentProvenanceIds.length,
    });
  }
  let control: SafetyScoreV9CaptureControl | null = null;
  const controlCache = caches.get(SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY);
  if (controlCache) {
    try {
      control = parseSafetyScoreV9CaptureControl(controlCache.value);
    } catch {
      return unavailable("v9-capture-control-invalid");
    }
  }
  const registryFingerprint = computeReportCardsRegistryFingerprint();
  const worker = v9WorkerProvenance(options.workerMetadata);
  const pairedCaptureValid =
    fixedInput.schemaVersion === 4 && fixedInput.captureKind === "native-v9-inputs" &&
    fixedInput.methodologyVersion === SAFETY_SCORE_METHODOLOGY_VERSION &&
    safetyScoreV9InputIdentitiesMatch(baseArtifact.safetyScoreIdentity, v9Seed.safetyScoreIdentity) &&
    v9Seed.sourceGeneration === fixedInput.sourceGeneration && v9Seed.clockSec === fixedInput.clockSec &&
    control !== null && captureTupleMatchesSource(control.capture, fixedInput) &&
    safetyScoreV9InputIdentitiesMatch(control.capture.safetyScoreIdentity, baseArtifact.safetyScoreIdentity);
  if (
    !safetyScoreV9InputIdentitiesMatch(baseArtifact.safetyScoreIdentity, expectedIdentity) ||
    !safetyScoreV9InputIdentitiesMatch(v9Seed.safetyScoreIdentity, expectedIdentity) ||
    v9Seed.sourceGeneration !== fixedInput.sourceGeneration || v9Seed.clockSec !== fixedInput.clockSec ||
    fixedInput.registryFingerprint !== registryFingerprint
  ) {
    const identityMismatch = diagnoseSafetyScoreV9InputIdentityMismatch({
      expected: expectedIdentity, actual: baseArtifact.safetyScoreIdentity,
      expectedRegistryFingerprint: registryFingerprint, actualRegistryFingerprint: fixedInput.registryFingerprint,
      expectedWorkerVersion: worker.workerVersion, actualWorkerVersion: control?.capture.workerVersion ?? null,
      expectedWorkerUploadedAtSec: worker.workerUploadedAtSec, actualWorkerUploadedAtSec: control?.capture.workerUploadedAtSec ?? null,
      pairedCaptureValid,
    });
    if (identityMismatch.deploymentOnly && control && worker.workerVersion !== null && worker.workerUploadedAtSec !== null) {
      const disposition = await requestRecapture(db, control.capture, {
        workerVersion: worker.workerVersion, workerUploadedAtSec: worker.workerUploadedAtSec,
        evaluationBuildDigest: expectedIdentity.evaluationBuildDigest, registryFingerprint,
      }, signal);
      const reason = disposition === "advanced" ? "v9-capture-advanced" : "v9-evaluator-changed-recapture-pending";
      return createCronResult({
        status: "skipped_neutral", itemCount: 0,
        metadata: { stage: "input-identity", reason, identityMismatch },
        productivity: { productive: false, reason },
      });
    }
    return unavailable("base-v9-exact-identity-mismatch", { identityMismatch });
  }

  const generationCache = caches.get(
    SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY,
  );
  let parsedSupplyAttributionGeneration:
    SafetyScoreV9SupplyAttributionGeneration | null = null;
  let generationParseError = false;
  if (generationCache) {
    try {
      parsedSupplyAttributionGeneration =
        parseSafetyScoreV9SupplyAttributionGeneration(
          generationCache.value,
        );
    } catch {
      generationParseError = true;
    }
  }
  let transferMaterialityGeneration: SafetyScoreV9TransferMaterialityGeneration | null = null;
  const transferMaterialityCache = caches.get(SAFETY_SCORE_V9_TRANSFER_MATERIALITY_CACHE_KEY);
  if (transferMaterialityCache) {
    try {
      transferMaterialityGeneration = parseSafetyScoreV9TransferMaterialityGeneration(
        transferMaterialityCache.value,
      );
    } catch {
      transferMaterialityGeneration = null;
    }
  }

  let supplyAttributionGenerationState:
    Record<string, unknown> = { status: "not-due" };
  const publication = await runSafetyScoreV9Publication({
    db,
    captureArchiveBucket: options.captureArchiveBucket,
    captureArchiveContext: options.captureArchiveContext,
    publicationDeadlineMs: options.executionWindow?.deadlineMs,
    fixedInput: v9SeedInput,
    fixedInputCacheValue,
    fixedInputAlreadyNormalized: true,
    // `prepareFixedInput` below spreads this normalized input and adds the two
    // loader-validated journal projections, so the runner must not re-normalize
    // the whole payload a second time on this hot path.
    preparedFixedInputAlreadyNormalized: true,
    transferMaterialityGeneration,
    prepareFixedInput: async (seedInput, publicationSignal) => {
      await reportProgress?.({
        stage: "supply-generation",
        message: "Applying bounded V9 supply attribution",
      });
      caches.delete(
        SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY,
      );
      const generationApplication =
        applySafetyScoreV9SupplyAttributionGeneration(
          seedInput,
          parsedSupplyAttributionGeneration,
        );
      supplyAttributionGenerationState = generationParseError
        ? {
            status: "incompatible",
            generationId: null,
            reason: "generation-malformed",
          }
        : generationApplication.status === "applied"
          ? {
              status: generationApplication.status,
              generationId: generationApplication.generationId,
              acceptedCount:
                generationApplication.acceptedAssetIds.length,
              sourceCaptureTuple: {
                baseInputGenerationId: parsedSupplyAttributionGeneration!.sourceBaseInputGenerationId,
                sourceGeneration: parsedSupplyAttributionGeneration!.sourceGeneration,
                clockSec: parsedSupplyAttributionGeneration!.sourceClockSec,
                registryFingerprint: parsedSupplyAttributionGeneration!.registryFingerprint,
              },
              targetBaseInputGenerationId: seedInput.baseInputGenerationId,
              rejectedCount:
                generationApplication.rejectedAssetIds.length,
              invalidAssetIds:
                generationApplication.invalidAssetIds,
            }
          : {
              status: generationApplication.status,
              generationId: generationApplication.generationId,
              reason: generationApplication.reason,
            };
      if (!generationParseError && pairedCaptureValid && generationApplication.status !== "applied" &&
        hasPendingAttribution(control, seedInput, Math.floor(Date.now() / 1_000))) {
        supplyAttributionGenerationState = {
          status: "pending", reason: "attribution-pending",
          pendingUntilSec: control!.attribution.pendingUntilSec,
          sourceCaptureTuple: control!.capture,
          targetBaseInputGenerationId: seedInput.baseInputGenerationId,
          generationId: generationApplication.generationId,
        };
      }
      const supplyFixedInput = generationApplication.fixedInput;

      await reportProgress?.({
        stage: "evidence-load",
        message: "Loading bounded V9 evidence journals",
      });
      const [evidenceJournalById, supplyAttributionJournalById] =
        await Promise.all([
          loadReportCardEvidenceJournalByIdV1(
            db,
            supplyFixedInput.activeAssetIds,
            supplyFixedInput.clockSec,
            publicationSignal,
          ),
          loadSupplyAttributionJournalByIdV1(
            db,
            SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_ASSET_IDS.filter(
              (assetId) =>
                supplyFixedInput.activeAssetIds.includes(assetId),
            ),
            supplyFixedInput.clockSec,
            publicationSignal,
          ),
        ]);
      const v9FixedInput = {
        ...supplyFixedInput,
        evidenceJournalById,
        supplyAttributionJournalById,
      };
      const currentDexGeneration = await loadExactDexPublicationGeneration(db);
      if (currentDexGeneration.generationId !== v9FixedInput.dexGenerationId) {
        throw new Error(
          `V9 candidate DEX dependency ${v9FixedInput.dexGenerationId} is older than current ${currentDexGeneration.generationId}`,
        );
      }
      await reportProgress?.({
        stage: "fixed-input-prepared",
        message: "Prepared exact V9 input for publication assessment",
      });
      return v9FixedInput;
    },
    signal,
  });
  // Caller cancellation during best-effort post-commit archiving cannot erase
  // the already accepted publication or its captureArchive outcome metadata.
  if (publication.status !== "published") throwIfAborted(signal);
  if (!signal?.aborted) await reportProgress?.({
    stage: "publication-settled",
    message: `V9 publication ${publication.status}`,
  });
  const supplyAttributionGenerationDegraded =
    supplyAttributionGenerationState.status === "incompatible" ||
    supplyAttributionGenerationState.status === "unavailable";

  // LV01-08: name the first degradation reason as a bounded top-level key so it
  // survives the 64 KiB metadata cap and lands in `cron_runs.degraded_reason`.
  const degradationReasons = [
    ...(publication.status === "published"
      ? []
      : [
          publication.status === "failed"
            ? `v9-publication-failed:${publication.code}`
            : `v9-publication-${publication.status}`,
        ]),
    ...(supplyAttributionGenerationDegraded
      ? [`supply-attribution-generation-${supplyAttributionGenerationState.status}`]
      : []),
  ];
  const publicationDiagnostics =
    publication.status === "published"
      ? {
          ...publication,
          bridgeJoinDiagnostics: summarizeBridgeJoinDiagnostics(
            publication.bridgeJoinDiagnostics,
          ),
        }
      : publication.status === "held"
        ? {
            ...publication,
            // Compaction drops array diagnostics to counts; keep the verdict and the
            // reason codes readable from the run row itself.
            coverageFloorVerdicts: summarizeCoverageFloors(publication.coverageFloors),
            holdReasonCodes: summarizeHoldReasons(publication.reasons),
            bridgeJoinDiagnostics: summarizeBridgeJoinDiagnostics(
              publication.bridgeJoinDiagnostics,
            ),
          }
        : publication;

  return {
    status: degradationReasons.length === 0 ? "ok" : "degraded",
    itemCount:
      publication.status === "published"
        ? fixedInput.activeAssetIds.length
        : 0,
    metadata: JSON.stringify({
      ...(degradationReasons.length > 0
        ? { reason: degradationReasons[0], degradationReasons }
        : {}),
      sourceGenerationId: fixedInput.sourceGeneration,
      baseInputGenerationId: fixedInput.baseInputGenerationId,
      pegProvenance: {
        status: "applied",
        assetCount: Object.keys(
          v9SeedInput.pegProvenanceById,
        ).length,
      },
      supplyAttributionGeneration: supplyAttributionGenerationState,
      resourcePressure: resourceAdmission.resourcePressure,
      publication: publicationDiagnostics,
      journal: publication.journal,
      captureArchive: publication.captureArchive,
    }),
    productivity: {
      productive: publication.status === "published",
      reason:
        publication.status === "published"
          ? publication.outcome === "partial"
            ? "v9-publication-published-partial"
            : "v9-publication-published"
          : publication.status === "held"
            ? "v9-publication-held"
            : "v9-publication-failed",
      ...(publication.status === "published"
        ? {
            publications: [
              {
                surface: "safety-score-v9" as const,
                generationId:
                  publication.publicationGenerationId,
                publishedAt: fixedInput.clockSec,
                candidateRows: fixedInput.activeAssetIds.length,
                publishedRows: fixedInput.activeAssetIds.length,
                expectedRows: fixedInput.activeAssetIds.length,
                artifactCacheKey: "report-cards:v9",
                validationSummary: {
                  outcome: publication.outcome,
                  quarantinedAssetCount:
                    publication.quarantines.length,
                  affectedAssetCount:
                    publication.affectedAssetIds.length,
                },
              },
            ],
          }
        : {}),
    },
  };
}
