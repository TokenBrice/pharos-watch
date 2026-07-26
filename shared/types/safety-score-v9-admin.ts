import { SafetyScoreV9ResponseSchema } from "./safety-score-v9-public";
import { V9PublicationHealthSchema } from "./report-cards-v9";
import { SafetyScoreV9MovementReviewRecordSchema } from "./safety-score-v9-review";
import { z } from "zod";

export const SAFETY_SCORE_V9_ADMIN_RESPONSE_SCHEMA_VERSION = 1;

const NonEmptyTextSchema = z.string().trim().min(1);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const BaseInputGenerationIdSchema = z.string().regex(/^report-cards-input:v1:[a-f0-9]{64}$/);
const UnixSecondsSchema = z.number().int().nonnegative();
const ScoreSchema = z.number().finite().min(0).max(100);
const UtcDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const ReplayArtifactSchema = z
  .object({
    kind: z.enum(["base-input", "fact-set", "policy", "evaluation-build", "result"]),
    identity: NonEmptyTextSchema,
    artifactRef: NonEmptyTextSchema,
    contentSha256: Sha256Schema,
    byteLength: z.number().int().positive(),
    compression: z.enum(["none", "gzip", "zstd"]),
    verification: z
      .object({
        status: z.enum(["pending", "verified", "checksum-mismatch", "unreadable"]),
        observedContentSha256: Sha256Schema.nullable(),
        verifiedAtSec: UnixSecondsSchema.nullable(),
      })
      .strict(),
  })
  .strict();

const CoverageFloorSchema = z
  .object({
    id: NonEmptyTextSchema,
    status: z.enum(["pass", "fail"]),
    observed: z.number().finite().nullable(),
    required: NonEmptyTextSchema,
    detail: NonEmptyTextSchema,
  })
  .strict();

const ShadowCoverageSchema = z
  .object({
    expectedActiveCount: z.number().int().nonnegative(),
    observedResultCount: z.number().int().nonnegative(),
    presentExpectedCount: z.number().int().nonnegative(),
    ratedResultCount: z.number().int().nonnegative(),
    notRatedResultCount: z.number().int().nonnegative(),
    expectedActiveIdsDigest: Sha256Schema,
    presentExpectedIdsDigest: Sha256Schema,
    missingIds: z.array(NonEmptyTextSchema),
    unexpectedIds: z.array(NonEmptyTextSchema),
    duplicateIds: z.array(NonEmptyTextSchema),
    compilerExceptions: z.array(NonEmptyTextSchema),
    futureDatedEvidenceIds: z.array(NonEmptyTextSchema),
    coverageFloors: z.array(CoverageFloorSchema),
    publicationRegression: z.boolean(),
    unresolvedReleaseBlockers: z.array(NonEmptyTextSchema),
    unresolvedCriticalMovementIds: z.array(NonEmptyTextSchema),
  })
  .strict();

export const SafetyScoreV9AdminShadowEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    candidate: SafetyScoreV9ResponseSchema,
    compilerFactSchemaDigest: Sha256Schema,
    producerCapabilityDigest: Sha256Schema,
    releaseCoveragePolicyDigest: Sha256Schema,
    consumerThresholdRegistryDigest: Sha256Schema,
    coverage: ShadowCoverageSchema,
    replayArtifacts: z.array(ReplayArtifactSchema),
  })
  .strict();

const ShadowQualificationSchema = z
  .object({
    qualifies: z.boolean(),
    blockers: z.array(
      z.enum([
        "active-id-bijection-failed",
        "compiler-exception",
        "future-dated-evidence",
        "coverage-floor-failed",
        "publication-regression",
        "unresolved-release-blocker",
        "unresolved-critical-movement",
      ]),
    ),
  })
  .strict();

const ShadowIdentitySchema = z
  .object({
    candidateId: NonEmptyTextSchema,
    policyVersion: NonEmptyTextSchema,
    publicationGenerationId: NonEmptyTextSchema,
    baseInputGenerationId: BaseInputGenerationIdSchema,
    factSetDigest: Sha256Schema,
    policyId: NonEmptyTextSchema,
    policyDigest: Sha256Schema,
    evaluationBuildDigest: Sha256Schema,
    resultDigest: Sha256Schema,
    compilerFactSchemaDigest: Sha256Schema,
    producerCapabilityDigest: Sha256Schema,
    releaseCoveragePolicyDigest: Sha256Schema,
    consumerThresholdRegistryDigest: Sha256Schema,
    envelopeDigest: Sha256Schema,
    sourceGenerations: z.record(NonEmptyTextSchema, NonEmptyTextSchema),
  })
  .strict();

const DiffSummarySchema = z
  .object({
    expectedCount: z.number().int().nonnegative(),
    comparedCount: z.number().int().nonnegative(),
    missingInputCount: z.number().int().nonnegative(),
    gradeOrNrTransitionCount: z.number().int().nonnegative(),
    bindingCapChangeCount: z.number().int().nonnegative(),
    largeScoreMovementCount: z.number().int().nonnegative(),
    topCutoffMovementCount: z.number().int().nonnegative(),
    downstreamCrossingCount: z.number().int().nonnegative(),
    requiresReviewCount: z.number().int().nonnegative(),
    pendingReviewCount: z.number().int().nonnegative(),
    comparableSupplyUsd: z.number().finite().nonnegative(),
    supplyWeightedMeanAbsoluteDelta: z.number().finite().nonnegative().nullable(),
  })
  .strict();

export const SafetyScoreV9AdminShadowDaySchema = z
  .object({
    schemaVersion: z.literal(1),
    utcDay: UtcDaySchema,
    updatedAtSec: UnixSecondsSchema,
    attemptCounts: z
      .object({
        successful: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
      })
      .strict(),
    selectedRun: z
      .object({
        selectedAtSec: UnixSecondsSchema,
        identity: ShadowIdentitySchema,
        coverage: ShadowCoverageSchema,
        movement: DiffSummarySchema,
        qualification: ShadowQualificationSchema,
        diffReportDigest: Sha256Schema,
        archiveSelectionReasons: z.array(z.enum(["anomaly", "final", "first"])),
        artifactKeys: z.array(z.string().regex(/^(base-input|evaluation-build|fact-set|policy|result):[a-f0-9]{64}$/)),
      })
      .strict()
      .nullable(),
    latestError: z
      .object({
        atSec: UnixSecondsSchema,
        stage: z.enum([
          "scheduler",
          "base-input",
          "v8-publication",
          "v9-enrichment",
          "compile",
          "score",
          "serialize",
          "publication-gate",
          "artifact-retention",
          "shadow-write",
          "aborted",
        ]),
        code: NonEmptyTextSchema.max(160),
        message: NonEmptyTextSchema.max(500),
      })
      .strict()
      .nullable(),
  })
  .strict();

const DiffBindingCapSchema = z
  .object({
    kind: NonEmptyTextSchema,
    limit: ScoreSchema,
    source: NonEmptyTextSchema.nullable(),
  })
  .strict();

const DiffModelCardSchema = z
  .object({
    score: ScoreSchema.nullable(),
    grade: NonEmptyTextSchema,
    bindingCap: DiffBindingCapSchema.nullable(),
    reasonCodes: z.array(NonEmptyTextSchema),
  })
  .strict();

const DiffCardSchema = z
  .object({
    id: NonEmptyTextSchema,
    v8: DiffModelCardSchema.nullable(),
    v9: DiffModelCardSchema.nullable(),
    v9WeakestPillar: z.object({ pillar: NonEmptyTextSchema, score: ScoreSchema }).strict().nullable(),
    transition: z.enum(["both-rated", "v8-rated-v9-nr", "v8-nr-v9-rated", "both-nr", "missing-v8", "missing-v9"]),
    scoreDelta: z.number().finite().nullable(),
    absoluteScoreDelta: z.number().finite().nonnegative().nullable(),
    newReasonCodes: z.array(NonEmptyTextSchema),
    removedReasonCodes: z.array(NonEmptyTextSchema),
    supplyUsd: z.number().finite().nonnegative(),
    supplyWeightedImpact: z.number().finite().nonnegative().nullable(),
    flags: z
      .object({
        inputMissing: z.boolean(),
        gradeOrNrTransition: z.boolean(),
        bindingCapChanged: z.boolean(),
        absoluteScoreDeltaAtLeast5: z.boolean(),
        topCutoffScoreDeltaAtLeast2: z.boolean(),
        downstreamThresholdCrossingIds: z.array(NonEmptyTextSchema),
        requiresReview: z.boolean(),
      })
      .strict(),
    review: z
      .object({
        key: Sha256Schema.nullable(),
        classKey: Sha256Schema.nullable(),
        status: z.enum(["not-required", "pending", "classified"]),
        disposition: z
          .enum(["intended-methodology-change", "evidence-correction", "producer-data-gap", "defect"])
          .nullable(),
        carriedFrom: z
          .object({
            reviewKey: Sha256Schema,
            reviewedV8Score: z.number().finite().min(0).max(100).nullable(),
            reviewedV9Score: z.number().finite().min(0).max(100).nullable(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict();

export const SafetyScoreV9AdminDiffReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAtSec: UnixSecondsSchema,
    expectedActiveIdsDigest: Sha256Schema,
    v8Identity: z
      .object({
        publicationGenerationId: NonEmptyTextSchema,
        baseInputGenerationId: BaseInputGenerationIdSchema,
        methodologyVersion: NonEmptyTextSchema,
        evaluationBuildDigest: Sha256Schema,
      })
      .strict(),
    v9Identity: ShadowIdentitySchema.omit({
      compilerFactSchemaDigest: true,
      producerCapabilityDigest: true,
      releaseCoveragePolicyDigest: true,
      consumerThresholdRegistryDigest: true,
      envelopeDigest: true,
      sourceGenerations: true,
    }),
    thresholds: z
      .object({
        absoluteScoreDelta: z.literal(5),
        topCutoffScoreDelta: z.literal(2),
        downstream: z.array(
          z
            .object({
              id: NonEmptyTextSchema,
              label: NonEmptyTextSchema,
              score: ScoreSchema,
              comparison: z.enum(["at-least", "at-most"]),
            })
            .strict(),
        ),
      })
      .strict(),
    summary: DiffSummarySchema,
    topSupplyWeightedMovements: z.array(
      z
        .object({
          id: NonEmptyTextSchema,
          absoluteScoreDelta: z.number().finite().nonnegative(),
          supplyUsd: z.number().finite().nonnegative(),
          supplyWeightedImpact: z.number().finite().nonnegative(),
        })
        .strict(),
    ),
    cards: z.array(DiffCardSchema),
    reportDigest: Sha256Schema,
  })
  .strict();

export const SafetyScoreV9AdminUnavailableReasonSchema = z.enum([
  "shadow-envelope-unavailable",
  "shadow-diff-unavailable",
  "shadow-history-unavailable",
  "shadow-generation-mismatch",
  "stored-shadow-invalid",
]);

export const SafetyScoreV9AdminResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      schemaVersion: z.literal(SAFETY_SCORE_V9_ADMIN_RESPONSE_SCHEMA_VERSION),
      status: z.literal("available"),
      publicationHealth: V9PublicationHealthSchema,
      envelope: SafetyScoreV9AdminShadowEnvelopeSchema,
      diff: SafetyScoreV9AdminDiffReportSchema,
      movementReviews: z.array(SafetyScoreV9MovementReviewRecordSchema),
      history: z.array(SafetyScoreV9AdminShadowDaySchema),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(SAFETY_SCORE_V9_ADMIN_RESPONSE_SCHEMA_VERSION),
      status: z.literal("unavailable"),
      reason: SafetyScoreV9AdminUnavailableReasonSchema,
    })
    .strict(),
]);

export type SafetyScoreV9AdminResponse = z.infer<typeof SafetyScoreV9AdminResponseSchema>;
