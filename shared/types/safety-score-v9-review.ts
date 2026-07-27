import { z } from "zod";

export const SAFETY_SCORE_V9_MOVEMENT_REVIEW_SCHEMA_VERSION = 2;

const NonEmptyTextSchema = z.string().trim().min(1);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const UnixSecondsSchema = z.number().int().nonnegative();
const ReviewedScoreSchema = z.number().finite().min(0).max(100).nullable();

export const SafetyScoreV9MovementReviewDispositionSchema = z.enum([
  "intended-methodology-change",
  "evidence-correction",
  "producer-data-gap",
  "defect",
]);
export type SafetyScoreV9MovementReviewDisposition = z.infer<
  typeof SafetyScoreV9MovementReviewDispositionSchema
>;

export const SafetyScoreV9MovementReviewRecordSchema = z
  .object({
    schemaVersion: z.literal(SAFETY_SCORE_V9_MOVEMENT_REVIEW_SCHEMA_VERSION),
    reviewKey: Sha256Schema,
    /**
     * Class of the exact movement that was adjudicated. A recorded disposition carries
     * forward to later runs while this class is unchanged; a class change expires the carry
     * and re-pends the movement. Derived server-side from the diff card, never client-supplied.
     */
    reviewClassKey: Sha256Schema,
    /** Score anchors that bound how far a carried disposition may drift from what was reviewed. */
    reviewedV8Score: ReviewedScoreSchema,
    reviewedV9Score: ReviewedScoreSchema,
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
