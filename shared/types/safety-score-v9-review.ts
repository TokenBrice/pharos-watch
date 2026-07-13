import { z } from "zod";

export const SAFETY_SCORE_V9_MOVEMENT_REVIEW_SCHEMA_VERSION = 1;

const NonEmptyTextSchema = z.string().trim().min(1);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const UnixSecondsSchema = z.number().int().nonnegative();

export const SafetyScoreV9MovementReviewDispositionSchema = z.enum([
  "intended-methodology-change",
  "evidence-correction",
  "producer-data-gap",
  "defect",
]);
export type SafetyScoreV9MovementReviewDisposition = z.infer<
  typeof SafetyScoreV9MovementReviewDispositionSchema
>;

export const SafetyScoreV9MovementReviewRequestSchema = z
  .object({
    schemaVersion: z.literal(SAFETY_SCORE_V9_MOVEMENT_REVIEW_SCHEMA_VERSION),
    reviewKey: Sha256Schema,
    assetId: NonEmptyTextSchema,
    sourceDiffReportDigest: Sha256Schema,
    disposition: SafetyScoreV9MovementReviewDispositionSchema,
    reviewerId: NonEmptyTextSchema.max(160),
    rationale: NonEmptyTextSchema.max(2_000),
  })
  .strict();
export type SafetyScoreV9MovementReviewRequest = z.infer<
  typeof SafetyScoreV9MovementReviewRequestSchema
>;

export const SafetyScoreV9MovementReviewRecordSchema = z
  .object({
    schemaVersion: z.literal(SAFETY_SCORE_V9_MOVEMENT_REVIEW_SCHEMA_VERSION),
    reviewKey: Sha256Schema,
    assetId: NonEmptyTextSchema,
    sourceDiffReportDigest: Sha256Schema,
    candidateId: NonEmptyTextSchema,
    sourcePublicationGenerationId: NonEmptyTextSchema,
    policyDigest: Sha256Schema,
    evaluationBuildDigest: Sha256Schema,
    v8MethodologyVersion: NonEmptyTextSchema,
    disposition: SafetyScoreV9MovementReviewDispositionSchema,
    reviewerId: NonEmptyTextSchema.max(160),
    rationale: NonEmptyTextSchema.max(2_000),
    reviewedAtSec: UnixSecondsSchema,
    reviewDigest: Sha256Schema,
  })
  .strict();
export type SafetyScoreV9MovementReviewRecord = z.infer<
  typeof SafetyScoreV9MovementReviewRecordSchema
>;

export const SafetyScoreV9MovementReviewResponseSchema = z
  .object({
    schemaVersion: z.literal(SAFETY_SCORE_V9_MOVEMENT_REVIEW_SCHEMA_VERSION),
    status: z.enum(["recorded", "unchanged"]),
    review: SafetyScoreV9MovementReviewRecordSchema,
  })
  .strict();
export type SafetyScoreV9MovementReviewResponse = z.infer<
  typeof SafetyScoreV9MovementReviewResponseSchema
>;
