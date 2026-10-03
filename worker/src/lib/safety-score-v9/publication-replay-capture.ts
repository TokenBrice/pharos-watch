import { z } from "zod";
import { buildFixedInputCacheEntry, FixedInputCacheEnvelopeFields, parseFixedInputCacheEntry } from "../report-cards-fixed-input-cache-codec";
import { normalizeSafetyScoreV9CompilerInput, type SafetyScoreV9CompilerInput } from "./native-input";
import { parseSafetyScoreV9TransferMaterialityGeneration, type SafetyScoreV9TransferMaterialityGeneration } from "./transfer-materiality";
import type { SafetyScoreV9CurrentResponse } from "@shared/types/safety-score-v9-public";
import { SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY } from "./publication-codec";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { sha256Hex } from "@shared/lib/sha256";

const envelopeSchema = z.object({ schemaVersion: z.literal(2), ...FixedInputCacheEnvelopeFields }).strict();
const payloadFields = {
  publicationGenerationId: z.string().min(1),
  baseInputGenerationId: z.string().min(1),
  enrichment: z.object({
    safetyScoreV9SupplyAttributionById: z.unknown(),
    evidenceJournalById: z.unknown(),
    supplyAttributionJournalById: z.unknown(),
    pegProvenanceById: z.unknown(),
  }).strict(),
  transferMaterialityGeneration: z.unknown(),
};
const historicalPayloadSchema = z.object({ schemaVersion: z.literal(1), ...payloadFields }).strict();
const payloadSchema = z.object({
  schemaVersion: z.literal(2),
  ...payloadFields,
  pipelineGapDigest: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
}).strict();

export class SafetyScoreV9ReplayCaptureIdentityError extends Error {
  constructor() {
    super("Accepted replay capture input identity mismatch");
    this.name = "SafetyScoreV9ReplayCaptureIdentityError";
  }
}

/** Serialize only existing enrichment projections, never a second full capture. */
export async function buildSafetyScoreV9PublicationReplayCapture(
  publication: Readonly<SafetyScoreV9CurrentResponse>,
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  transferMaterialityGeneration: SafetyScoreV9TransferMaterialityGeneration | null,
) {
  if (publication.baseInputGenerationId !== fixedInput.baseInputGenerationId || publication.publishedAtSec !== fixedInput.clockSec) {
    throw new SafetyScoreV9ReplayCaptureIdentityError();
  }
  const { safetyScoreV9SupplyAttributionById, evidenceJournalById, supplyAttributionJournalById, pegProvenanceById } = fixedInput;
  const entry = await buildFixedInputCacheEntry({
    schemaVersion: 2,
    sourceGeneration: publication.publicationGenerationId,
    payload: {
      schemaVersion: 2, publicationGenerationId: publication.publicationGenerationId,
      pipelineGapDigest: fixedInput.pipelineGapByAssetId === undefined ? null : sha256Hex(stableJsonStringifyV1(fixedInput.pipelineGapByAssetId)),
      baseInputGenerationId: fixedInput.baseInputGenerationId,
      enrichment: { safetyScoreV9SupplyAttributionById, evidenceJournalById, supplyAttributionJournalById, pegProvenanceById },
      transferMaterialityGeneration,
    },
    label: "Accepted Safety Score V9 replay delta",
  });
  return { ...entry, key: SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY };
}

export async function parseSafetyScoreV9PublicationReplayCapture(value: unknown, baseInput: SafetyScoreV9CompilerInput) {
  const { envelope, payload } = await parseFixedInputCacheEntry({
    value, envelopeSchema,
    malformedEnvelopeLabel: "Accepted replay envelope",
    malformedPayloadLabel: "Accepted replay payload",
    artifactLabel: "Accepted Safety Score V9 replay delta",
  });
  // Historical deltas restore enrichment only; they never infer missing cause proofs.
  const parsed = payload !== null && typeof payload === "object" && "schemaVersion" in payload && payload.schemaVersion === 1
    ? historicalPayloadSchema.parse(payload) : payloadSchema.parse(payload);
  if (parsed.publicationGenerationId !== envelope.sourceGeneration) throw new Error("accepted-publication-replay-delta-generation-mismatch");
  if (parsed.baseInputGenerationId !== baseInput.baseInputGenerationId) throw new Error("accepted-publication-replay-base-generation-mismatch");
  if ("pipelineGapDigest" in parsed && parsed.pipelineGapDigest !==
    (baseInput.pipelineGapByAssetId === undefined ? null : sha256Hex(stableJsonStringifyV1(baseInput.pipelineGapByAssetId)))) {
    throw new Error("accepted-publication-replay-pipeline-gap-identity-mismatch");
  }
  return {
    kind: "safety-score-v9-accepted-publication-capture" as const,
    publicationGenerationId: parsed.publicationGenerationId,
    fixedInput: normalizeSafetyScoreV9CompilerInput({ ...baseInput, ...parsed.enrichment }),
    transferMaterialityGeneration: parsed.transferMaterialityGeneration === null ? null : parseSafetyScoreV9TransferMaterialityGeneration(parsed.transferMaterialityGeneration),
  };
}
