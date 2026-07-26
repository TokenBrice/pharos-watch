import {
  buildSafetyScoreV8PublicationIdentity,
  safetyScoreV8PublicationIdentitiesMatch,
} from "@shared/lib/safety-score-v8-publication";
import { throwIfAborted } from "../lib/abort";
import { getCaches } from "../lib/db-cache";
import type {
  CronProgressReporter,
  CronResult,
} from "../lib/cron-logger";
import { loadReportCardEvidenceJournalByIdV1 } from "../lib/report-card-evidence-journal-store";
import { buildReportCardPublicationPlan } from "../lib/report-card-publication";
import {
  buildReportCardsSnapshotFromFixedInput,
  parseReportCardsFixedInputCacheArtifact,
  REPORT_CARDS_FIXED_INPUT_CACHE_KEY,
  type ReportCardsFixedInputCacheArtifact,
} from "../lib/report-cards-fixed-input";
import {
  parseSafetyScoreV9PegProvenanceSeed,
  SAFETY_SCORE_V9_PEG_PROVENANCE_SEED_CACHE_KEY,
  type SafetyScoreV9PegProvenanceSeed,
} from "../lib/safety-score-v9-peg-provenance";
import { runSafetyScoreV9ShadowAfterV8Publication } from "../lib/safety-score-v9-shadow-runner";
import {
  SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_ASSET_IDS,
} from "../lib/safety-score-v9-supply-attribution";
import {
  applySafetyScoreV9SupplyAttributionGeneration,
  parseSafetyScoreV9SupplyAttributionGeneration,
  SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY,
} from "../lib/safety-score-v9-supply-attribution-generation";
import { loadSupplyAttributionJournalByIdV1 } from "../lib/safety-score-v9-supply-attribution-journal-store";

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
      reason: "v9-shadow-source-unavailable",
    },
  };
}

export async function computeSafetyScoreV9Shadow(
  db: D1Database,
  signal?: AbortSignal,
  reportProgress?: CronProgressReporter,
): Promise<CronResult> {
  throwIfAborted(signal);
  await reportProgress?.({
    stage: "input-load",
    message: "Loading publication-exact V8 and V9 seed inputs",
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

  let v8Artifact: ReportCardsFixedInputCacheArtifact;
  let v9Seed: SafetyScoreV9PegProvenanceSeed;
  try {
    v9Seed = parseSafetyScoreV9PegProvenanceSeed(
      caches.get(
        SAFETY_SCORE_V9_PEG_PROVENANCE_SEED_CACHE_KEY,
      )!.value,
    );
    caches.delete(SAFETY_SCORE_V9_PEG_PROVENANCE_SEED_CACHE_KEY);
    v8Artifact = await parseReportCardsFixedInputCacheArtifact(
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

  const fixedInput = v8Artifact.input;
  const v9SeedInput = {
    ...fixedInput,
    pegProvenanceById: v9Seed.pegProvenanceById,
  };
  const expectedIdentity = buildSafetyScoreV8PublicationIdentity({
    methodologyVersion: fixedInput.methodologyVersion,
    baseInputGenerationId: fixedInput.baseInputGenerationId,
    publicationGenerationId: fixedInput.sourceGeneration,
  });
  if (
    !v8Artifact.safetyScoreIdentity ||
    !safetyScoreV8PublicationIdentitiesMatch(
      v8Artifact.safetyScoreIdentity,
      expectedIdentity,
    ) ||
    !safetyScoreV8PublicationIdentitiesMatch(
      v9Seed.safetyScoreIdentity,
      expectedIdentity,
    ) ||
    v9Seed.sourceGeneration !== fixedInput.sourceGeneration ||
    v9Seed.clockSec !== fixedInput.clockSec
  ) {
    return unavailable("v8-v9-exact-identity-mismatch");
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

  const activeIds = new Set(fixedInput.activeAssetIds);
  const replay = buildReportCardsSnapshotFromFixedInput(fixedInput);
  const publication = buildReportCardPublicationPlan(
    replay.cards.filter((card) => activeIds.has(card.id)),
    fixedInput.methodologyVersion,
    fixedInput.updatedAt,
  );
  if (
    publication.completeness.generationId !==
    fixedInput.sourceGeneration
  ) {
    return unavailable("v8-replay-generation-mismatch", {
      replayGenerationId: publication.completeness.generationId,
      fixedInputGenerationId: fixedInput.sourceGeneration,
    });
  }

  let supplyAttributionGenerationState:
    Record<string, unknown> = { status: "not-due" };
  const shadow = await runSafetyScoreV9ShadowAfterV8Publication({
    db,
    fixedInput: v9SeedInput,
    prepareFixedInput: async (seedInput, shadowSignal) => {
      await reportProgress?.({
        stage: "supply-generation",
        message: "Applying bounded V9 supply attribution",
      });
      const generationCache = caches.get(
        SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY,
      );
      caches.delete(
        SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY,
      );
      let generation = null;
      let generationParseError = false;
      if (generationCache) {
        try {
          generation =
            parseSafetyScoreV9SupplyAttributionGeneration(
              generationCache.value,
            );
        } catch {
          generationParseError = true;
        }
      }
      const generationApplication =
        applySafetyScoreV9SupplyAttributionGeneration(
          seedInput,
          generation,
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
            shadowSignal,
          ),
          loadSupplyAttributionJournalByIdV1(
            db,
            SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_ASSET_IDS.filter(
              (assetId) =>
                supplyFixedInput.activeAssetIds.includes(assetId),
            ),
            supplyFixedInput.clockSec,
            shadowSignal,
          ),
        ]);
      const v9FixedInput = {
        ...supplyFixedInput,
        evidenceJournalById,
        supplyAttributionJournalById,
      };
      await reportProgress?.({
        stage: "fixed-input-prepared",
        message: "Prepared exact V9 shadow input for publication assessment",
      });
      return v9FixedInput;
    },
    v8Cards: publication.activeCards,
    v8Publication: publication.completeness,
    v8MethodologyVersion: fixedInput.methodologyVersion,
    signal,
  });
  throwIfAborted(signal);
  await reportProgress?.({
    stage: "shadow-settled",
    message: `V9 shadow ${shadow.status}`,
  });

  return {
    status:
      shadow.status === "published"
        ? "ok"
        : shadow.status === "skipped"
          ? "skipped_neutral"
          : "degraded",
    itemCount:
      shadow.status === "published"
        ? publication.completeness.expectedCount
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
      shadow,
    }),
    productivity: {
      productive: shadow.status === "published",
      reason:
        shadow.status === "published"
          ? "v9-shadow-published"
          : shadow.status === "skipped"
            ? shadow.reason
            : shadow.status === "held"
              ? "v9-shadow-held"
              : "v9-shadow-failed",
    },
  };
}
