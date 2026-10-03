import "../../test-helpers/reviewed-deployment-catalog.test-support";
import { describe, expect, it } from "vitest";
import { makeWorkerSafetyScoreV9Publication } from "../../test-helpers/report-cards-v9";
import { makeV9FixedInput, withV9WmReviewedDeploymentAttribution } from "../../test-helpers/v9-fixed-input";
import { SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY } from "../safety-score-v9/publication-codec";
import {
  buildSafetyScoreV9PublicationReplayCapture,
  parseSafetyScoreV9PublicationReplayCapture,
  SafetyScoreV9ReplayCaptureIdentityError,
} from "../safety-score-v9/publication-replay-capture";
import { createRuntimeGapVerdict } from "../safety-score-v9/fact-set-context";
import { normalizeSafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";
import { buildFixedInputCacheEntry } from "../report-cards-fixed-input-cache-codec";

const base = makeV9FixedInput({ assetId: "wm-m0", clockSec: 1_800_000_000, aggregateCirculating: { peggedUSD: 87_020_618.58982982 } });
const enriched = withV9WmReviewedDeploymentAttribution(base);
const publication = makeWorkerSafetyScoreV9Publication({
  baseInputGenerationId: enriched.baseInputGenerationId,
  publishedAtSec: enriched.clockSec,
  publicationGenerationId: "report-cards:v9:accepted",
});

describe("Safety Score V9 accepted-publication replay capture", () => {
  it("restores the compute-time enrichment the stripped base cache lacks", async () => {
    expect(base.safetyScoreV9SupplyAttributionById["wm-m0"]).toBeUndefined();
    const entry = await buildSafetyScoreV9PublicationReplayCapture(publication, enriched, null);
    expect(entry.key).toBe(SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY);

    const capture = await parseSafetyScoreV9PublicationReplayCapture(entry.value, base);
    expect(capture.publicationGenerationId).toBe("report-cards:v9:accepted");
    expect(capture.transferMaterialityGeneration).toBeNull();
    expect(capture.fixedInput.safetyScoreV9SupplyAttributionById).toEqual(enriched.safetyScoreV9SupplyAttributionById);
    expect(capture.fixedInput.baseInputGenerationId).toBe(enriched.baseInputGenerationId);
  });

  it.each([
    ["base input generation", { baseInputGenerationId: `report-cards-input:v1:${"e".repeat(64)}` }],
    ["publication clock", { publishedAtSec: enriched.clockSec + 1 }],
  ] as const)("refuses to bind a delta whose %s differs from the compiled input", async (_label, override) => {
    await expect(buildSafetyScoreV9PublicationReplayCapture({ ...publication, ...override }, enriched, null))
      .rejects.toBeInstanceOf(SafetyScoreV9ReplayCaptureIdentityError);
  });

  it("rejects pairing the delta with a different retained base generation", async () => {
    const entry = await buildSafetyScoreV9PublicationReplayCapture(publication, enriched, null);
    const otherBase = makeV9FixedInput({ assetId: "wm-m0", clockSec: base.clockSec + 1800 });
    await expect(parseSafetyScoreV9PublicationReplayCapture(entry.value, otherBase))
      .rejects.toThrow("accepted-publication-replay-base-generation-mismatch");
  });

  it("reads a historical delta without inventing pipeline evidence for its retained base", async () => {
    const entry = await buildFixedInputCacheEntry({
      schemaVersion: 2, sourceGeneration: publication.publicationGenerationId,
      payload: { schemaVersion: 1, publicationGenerationId: publication.publicationGenerationId,
        baseInputGenerationId: base.baseInputGenerationId,
        enrichment: { safetyScoreV9SupplyAttributionById: base.safetyScoreV9SupplyAttributionById,
          evidenceJournalById: base.evidenceJournalById, supplyAttributionJournalById: base.supplyAttributionJournalById, pegProvenanceById: base.pegProvenanceById },
        transferMaterialityGeneration: null },
      label: "Historical enrichment-only delta",
    });
    const restored = await parseSafetyScoreV9PublicationReplayCapture(entry.value, base);
    expect(restored.fixedInput.pipelineGapByAssetId).toBeUndefined();
  });

  it("preserves base-bound pipeline proofs and refuses proof substitution under the accepted identity", async () => {
    const failure = createRuntimeGapVerdict({
      assetId: "wm-m0",
      scope: { pillar: "backing", componentKey: "reserve-composition", factorKey: null, routeKey: null, exposureId: null, requiredDatum: "reserve-composition" },
      sourceId: "fixture:reserve-reader", sourceGenerationId: "attempt:failed",
      observedAtSec: base.clockSec, asOfSec: base.clockSec, producerState: "producer-failed",
      rejectionCode: "read-failed", reason: "The captured reserve read failed.",
    });
    const captured = normalizeSafetyScoreV9CompilerInput({
      ...base, baseInputGenerationId: undefined, pipelineGapByAssetId: { "wm-m0": [failure] },
    });
    const accepted = { ...publication, baseInputGenerationId: captured.baseInputGenerationId };
    const entry = await buildSafetyScoreV9PublicationReplayCapture(accepted, captured, null);
    const restored = await parseSafetyScoreV9PublicationReplayCapture(entry.value, captured);
    expect(restored.fixedInput.pipelineGapByAssetId).toEqual(captured.pipelineGapByAssetId);
    const substituted = structuredClone(captured);
    substituted.pipelineGapByAssetId!["wm-m0"]![0]!.evidence.rejection!.reason = "A different failure.";
    await expect(parseSafetyScoreV9PublicationReplayCapture(entry.value, substituted))
      .rejects.toThrow("accepted-publication-replay-pipeline-gap-identity-mismatch");
  });
});
