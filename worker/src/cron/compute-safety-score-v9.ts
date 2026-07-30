import {
  buildSafetyScoreV9InputIdentity,
  safetyScoreV9InputIdentitiesMatch,
} from "@shared/lib/safety-score-v9-input-identity";
import { throwIfAborted } from "../lib/abort";
import { getCaches } from "../lib/db-cache";
import type {
  CronProgressReporter,
  CronResult,
} from "../lib/cron-logger";
import { loadReportCardEvidenceJournalByIdV1 } from "../lib/report-card-evidence-journal-store";
import {
  parseReportCardsFixedInputCacheArtifact,
  REPORT_CARDS_FIXED_INPUT_CACHE_KEY,
  type ReportCardsFixedInputCacheArtifact,
} from "../lib/report-cards-fixed-input";
import {
  parseSafetyScoreV9PegProvenanceSeed,
  SAFETY_SCORE_V9_PEG_PROVENANCE_SEED_CACHE_KEY,
  type SafetyScoreV9PegProvenanceSeed,
} from "../lib/safety-score-v9-peg-provenance";
import { runSafetyScoreV9Publication } from "../lib/safety-score-v9-publication-runner";
import {
  SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_ASSET_IDS,
} from "../lib/safety-score-v9-supply-attribution";
import {
  applySafetyScoreV9SupplyAttributionGeneration,
  isSafetyScoreV9SupplyAttributionGenerationCadenceDeferred,
  parseSafetyScoreV9SupplyAttributionGeneration,
  SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY,
  type SafetyScoreV9SupplyAttributionGeneration,
} from "../lib/safety-score-v9-supply-attribution-generation";
import { loadSupplyAttributionJournalByIdV1 } from "../lib/safety-score-v9-supply-attribution-journal-store";
import { loadExactDexPublicationGeneration } from "../lib/report-cards-snapshot";

function unavailable(
  reason: string,
  metadata: Record<string, unknown> = {},
): CronResult {
  return {
    status: "degraded",
    itemCount: 0,
    metadata: JSON.stringify({
      stage: "input-load",
      reason,
      ...metadata,
    }),
    productivity: {
      productive: false,
      reason: "v9-publication-source-unavailable",
    },
  };
}

export async function computeSafetyScoreV9(
  db: D1Database,
  signal?: AbortSignal,
  reportProgress?: CronProgressReporter,
): Promise<CronResult> {
  throwIfAborted(signal);
  await reportProgress?.({
    stage: "input-load",
    message: "Loading publication-exact base and V9 seed inputs",
  });
  const caches = await getCaches(db, [
    REPORT_CARDS_FIXED_INPUT_CACHE_KEY,
    SAFETY_SCORE_V9_PEG_PROVENANCE_SEED_CACHE_KEY,
    SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY,
  ]);
  throwIfAborted(signal);

  if (!caches.has(REPORT_CARDS_FIXED_INPUT_CACHE_KEY)) {
    return unavailable("fixed-input-missing");
  }
  if (!caches.has(SAFETY_SCORE_V9_PEG_PROVENANCE_SEED_CACHE_KEY)) {
    return unavailable("v9-exact-seed-missing");
  }

  let baseArtifact: ReportCardsFixedInputCacheArtifact;
  let v9Seed: SafetyScoreV9PegProvenanceSeed;
  try {
    v9Seed = parseSafetyScoreV9PegProvenanceSeed(
      caches.get(
        SAFETY_SCORE_V9_PEG_PROVENANCE_SEED_CACHE_KEY,
      )!.value,
    );
    caches.delete(SAFETY_SCORE_V9_PEG_PROVENANCE_SEED_CACHE_KEY);
    baseArtifact = await parseReportCardsFixedInputCacheArtifact(
      caches.get(REPORT_CARDS_FIXED_INPUT_CACHE_KEY)!.value,
    );
    caches.delete(REPORT_CARDS_FIXED_INPUT_CACHE_KEY);
  } catch (error) {
    return unavailable("exact-input-invalid", {
      code:
        error instanceof Error && error.name
          ? error.name.slice(0, 160)
          : "Error",
    });
  }

  const fixedInput = baseArtifact.input;
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
    methodologyVersion: fixedInput.methodologyVersion,
    baseInputGenerationId: fixedInput.baseInputGenerationId,
    publicationGenerationId: fixedInput.sourceGeneration,
  });
  if (
    !baseArtifact.safetyScoreIdentity ||
    !safetyScoreV9InputIdentitiesMatch(
      baseArtifact.safetyScoreIdentity,
      expectedIdentity,
    ) ||
    !safetyScoreV9InputIdentitiesMatch(
      v9Seed.safetyScoreIdentity,
      expectedIdentity,
    ) ||
    v9Seed.sourceGeneration !== fixedInput.sourceGeneration ||
    v9Seed.clockSec !== fixedInput.clockSec
  ) {
    return unavailable("base-v9-exact-identity-mismatch");
  }
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
  if (
    parsedSupplyAttributionGeneration &&
    isSafetyScoreV9SupplyAttributionGenerationCadenceDeferred(
      v9SeedInput,
      parsedSupplyAttributionGeneration,
    )
  ) {
    return {
      status: "skipped_neutral",
      itemCount:
        parsedSupplyAttributionGeneration.acceptedAssetIds.length,
      metadata: JSON.stringify({
        stage: "supply-generation",
        reason: "supply-attribution-generation-cadence-deferred",
        sourceGenerationId: fixedInput.sourceGeneration,
        baseInputGenerationId: fixedInput.baseInputGenerationId,
        fixedInputClockSec: fixedInput.clockSec,
        generationId:
          parsedSupplyAttributionGeneration.generationId,
        generationSourceClockSec:
          parsedSupplyAttributionGeneration.sourceClockSec,
        generationCaptureClockSec:
          parsedSupplyAttributionGeneration.captureClockSec,
        generationCapturedAtSec:
          parsedSupplyAttributionGeneration.capturedAtSec,
        acceptedCount:
          parsedSupplyAttributionGeneration.acceptedAssetIds.length,
        rejectedCount:
          parsedSupplyAttributionGeneration.rejectedAssetIds.length,
      }),
      productivity: {
        productive: false,
        reason: "supply-attribution-generation-cadence-deferred",
      },
    };
  }

  let supplyAttributionGenerationState:
    Record<string, unknown> = { status: "not-due" };
  const publication = await runSafetyScoreV9Publication({
    db,
    fixedInput: v9SeedInput,
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
  throwIfAborted(signal);
  await reportProgress?.({
    stage: "publication-settled",
    message: `V9 publication ${publication.status}`,
  });

  return {
    status:
      publication.status === "published" &&
      publication.outcome === "clean"
        ? "ok"
        : "degraded",
    itemCount:
      publication.status === "published"
        ? fixedInput.activeAssetIds.length
        : 0,
    metadata: JSON.stringify({
      sourceGenerationId: fixedInput.sourceGeneration,
      baseInputGenerationId: fixedInput.baseInputGenerationId,
      pegProvenance: {
        status: "applied",
        assetCount: Object.keys(
          v9SeedInput.pegProvenanceById,
        ).length,
      },
      supplyAttributionGeneration: supplyAttributionGenerationState,
      publication,
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
