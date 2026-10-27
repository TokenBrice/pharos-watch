import { z } from "zod";
import { buildFixedInputCacheEntry, FixedInputCacheEnvelopeFields, parseFixedInputCacheEntry } from "../report-cards-fixed-input-cache-codec";
import { normalizeSafetyScoreV9CompilerInput, type SafetyScoreV9CompilerInput } from "./native-input";
import { parseSafetyScoreV9TransferMaterialityGeneration, type SafetyScoreV9TransferMaterialityGeneration } from "./transfer-materiality";
import type { SafetyScoreV9CurrentResponse } from "@shared/types/safety-score-v9-public";
import { SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY, SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY } from "./publication-codec";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { sha256Hex } from "@shared/lib/sha256";
import { AcceptedPublicationBaselineSchema, type SafetyScoreV9AcceptedPublicationBaseline } from "./publication-assessment";

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
const pipelineGapDigest = z.string().regex(/^[a-f0-9]{64}$/u).nullable();
const payloadSchema = z.object({ schemaVersion: z.literal(2), ...payloadFields, pipelineGapDigest }).strict();
const SourceAdmissionBaselineSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  baseline: AcceptedPublicationBaselineSchema,
}).strict().nullable();
// v3 (10.35) writer: hysteresis and measured-route quarantine replay need the baseline.
const baselinePayloadSchema = z.object({
  schemaVersion: z.literal(3), ...payloadFields, pipelineGapDigest,
  sourceAdmissionBaseline: SourceAdmissionBaselineSchema,
}).strict();

export interface SafetyScoreV9SourceAdmissionBaseline {
  sha256: string;
  baseline: SafetyScoreV9AcceptedPublicationBaseline;
}

/**
 * The prior accepted baseline the publication-time grade hysteresis consumed.
 * Null is a genuine bootstrap; v1/v2 captures carry no field and stay unknown.
 */
export function parseSafetyScoreV9SourceAdmissionBaseline(value: unknown, captureClockSec: number): SafetyScoreV9SourceAdmissionBaseline | null {
  const parsed = SourceAdmissionBaselineSchema.parse(value);
  if (parsed === null) return null;
  if (parsed.sha256 !== sha256Hex(stableJsonStringifyV1(parsed.baseline))) throw new Error("accepted-publication-replay-baseline-checksum-mismatch");
  if (parsed.baseline.publishedAtSec > captureClockSec) throw new Error("accepted-publication-replay-baseline-clock-after-capture");
  return parsed;
}

/** Both retained rows must come from one D1 SELECT, never separate live reads. */
export function parseSafetyScoreV9PublicationReplayCacheRows(value: unknown) {
  const result = z.array(z.object({
    success: z.literal(true),
    results: z.array(z.object({
      key: z.string(),
      value: z.string().min(1),
      updated_at: z.number().int().nonnegative(),
    })),
  })).length(1).parse(value)[0]!;
  const baseRows = result.results.filter((row) => row.key === SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY);
  const deltaRows = result.results.filter((row) => row.key === SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY);
  if (baseRows.length !== 1 || deltaRows.length !== 1) {
    throw new Error("accepted-publication-replay-requires-one-base-and-delta");
  }
  const base = baseRows[0]!;
  const delta = deltaRows[0]!;
  if (base.updated_at !== delta.updated_at) {
    throw new Error("accepted-publication-replay-retention-clock-mismatch");
  }
  return { baseValue: base.value, deltaValue: delta.value, retainedAtSec: base.updated_at };
}

export class SafetyScoreV9ReplayCaptureIdentityError extends Error {
  constructor() {
    super("Accepted replay capture input identity mismatch");
    this.name = "SafetyScoreV9ReplayCaptureIdentityError";
  }
}

export type SafetyScoreV9ReplayCaptureInput = Pick<SafetyScoreV9CompilerInput,
  "baseInputGenerationId" | "clockSec" | "safetyScoreV9SupplyAttributionById" | "evidenceJournalById" |
  "supplyAttributionJournalById" | "pegProvenanceById" | "pipelineGapByAssetId">;

/** Serialize only existing enrichment projections, never a second full capture. */
export async function buildSafetyScoreV9PublicationReplayCapture(
  publication: Readonly<SafetyScoreV9CurrentResponse>,
  fixedInput: Readonly<SafetyScoreV9ReplayCaptureInput>,
  transferMaterialityGeneration: SafetyScoreV9TransferMaterialityGeneration | null,
  sourceAdmissionBaseline: SafetyScoreV9AcceptedPublicationBaseline | null,
) {
  if (publication.baseInputGenerationId !== fixedInput.baseInputGenerationId || publication.publishedAtSec !== fixedInput.clockSec ||
    publication.cards.some((card) => card.gradeHold !== undefined &&
      card.gradeHold.heldFromGenerationId !== sourceAdmissionBaseline?.publicationGenerationId) ||
    (sourceAdmissionBaseline !== null && (sourceAdmissionBaseline.publicationGenerationId === publication.publicationGenerationId ||
      sourceAdmissionBaseline.publishedAtSec > fixedInput.clockSec))) {
    throw new SafetyScoreV9ReplayCaptureIdentityError();
  }
  const { safetyScoreV9SupplyAttributionById, evidenceJournalById, supplyAttributionJournalById, pegProvenanceById } = fixedInput;
  const entry = await buildFixedInputCacheEntry({
    schemaVersion: 2,
    sourceGeneration: publication.publicationGenerationId,
    payload: {
      schemaVersion: 3, publicationGenerationId: publication.publicationGenerationId,
      sourceAdmissionBaseline: sourceAdmissionBaseline === null ? null
        : { sha256: sha256Hex(stableJsonStringifyV1(sourceAdmissionBaseline)), baseline: sourceAdmissionBaseline },
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
  const version = payload !== null && typeof payload === "object" && "schemaVersion" in payload ? payload.schemaVersion : undefined;
  const parsed = version === 1 ? historicalPayloadSchema.parse(payload)
    : version === 3 ? baselinePayloadSchema.parse(payload) : payloadSchema.parse(payload);
  if (parsed.publicationGenerationId !== envelope.sourceGeneration) throw new Error("accepted-publication-replay-delta-generation-mismatch");
  if (parsed.baseInputGenerationId !== baseInput.baseInputGenerationId) throw new Error("accepted-publication-replay-base-generation-mismatch");
  if ("pipelineGapDigest" in parsed && parsed.pipelineGapDigest !==
    (baseInput.pipelineGapByAssetId === undefined ? null : sha256Hex(stableJsonStringifyV1(baseInput.pipelineGapByAssetId)))) {
    throw new Error("accepted-publication-replay-pipeline-gap-identity-mismatch");
  }
  const sourceAdmissionBaseline = "sourceAdmissionBaseline" in parsed
    ? parseSafetyScoreV9SourceAdmissionBaseline(parsed.sourceAdmissionBaseline, baseInput.clockSec) : undefined;
  if (sourceAdmissionBaseline?.baseline.publicationGenerationId === parsed.publicationGenerationId) {
    throw new Error("accepted-publication-replay-source-baseline-identity-mismatch");
  }
  return {
    kind: "safety-score-v9-accepted-publication-capture" as const,
    publicationGenerationId: parsed.publicationGenerationId,
    fixedInput: normalizeSafetyScoreV9CompilerInput({ ...baseInput, ...parsed.enrichment }),
    transferMaterialityGeneration: parsed.transferMaterialityGeneration === null ? null : parseSafetyScoreV9TransferMaterialityGeneration(parsed.transferMaterialityGeneration),
    ...(sourceAdmissionBaseline === undefined ? {} : { sourceAdmissionBaseline }),
  };
}
