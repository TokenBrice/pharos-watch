import { sha256Hex } from "@shared/lib/sha256";
import {
  V9_CONSUMER_SCORE_THRESHOLD_REGISTRY_DIGEST,
  V9_SHADOW_DIFF_ABSOLUTE_REVIEW_DELTA,
  V9_SHADOW_DIFF_TOP_CUTOFF_REVIEW_DELTA,
  V9_SHADOW_MINIMUM_QUALIFYING_DAYS,
  V9_SHADOW_MOVEMENT_REVIEW_CARRY_SCORE_DRIFT,
  V9_SHADOW_RELEASE_COVERAGE_POLICY_DIGEST,
  V9_SHADOW_REQUIRED_COVERAGE_FLOOR_IDS,
} from "@shared/lib/safety-score-v9/operational-gate";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { ReportCardGradeSchema } from "@shared/types/report-cards";
import { SafetyScoreV9ResponseSchema, type SafetyScoreV9Response } from "@shared/types/safety-score-v9-public";
import {
  SafetyScoreV9MovementReviewDispositionSchema,
  type SafetyScoreV9MovementReviewDisposition,
} from "@shared/types/safety-score-v9-review";
import { z } from "zod";

const SAFETY_SCORE_V9_SHADOW_SCHEMA_VERSION = 1;
export const SAFETY_SCORE_V9_SHADOW_MINIMUM_QUALIFYING_DAYS = V9_SHADOW_MINIMUM_QUALIFYING_DAYS;
export const SAFETY_SCORE_V9_REQUIRED_SHADOW_COVERAGE_FLOOR_IDS = V9_SHADOW_REQUIRED_COVERAGE_FLOOR_IDS;
const SAFETY_SCORE_V9_DIFF_ABSOLUTE_REVIEW_DELTA = V9_SHADOW_DIFF_ABSOLUTE_REVIEW_DELTA;
const SAFETY_SCORE_V9_DIFF_TOP_CUTOFF_REVIEW_DELTA = V9_SHADOW_DIFF_TOP_CUTOFF_REVIEW_DELTA;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const BaseInputGenerationIdSchema = z.string().regex(/^report-cards-input:v1:[a-f0-9]{64}$/);
const NonEmptyTextSchema = z.string().trim().min(1);
const UnixSecondsSchema = z.number().int().nonnegative();
const ScoreSchema = z.number().finite().min(0).max(100);
const UtcDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function isSortedUnique(values: readonly string[]): boolean {
  return (
    values.length === new Set(values).size &&
    values.every((value, index) => index === 0 || compareText(values[index - 1]!, value) < 0)
  );
}

function addCanonicalArrayIssue(values: readonly string[], ctx: z.RefinementCtx, path: PropertyKey[]): void {
  if (!isSortedUnique(values)) {
    ctx.addIssue({ code: "custom", path, message: "Values must be sorted and unique" });
  }
}

export function safetyScoreV9UtcDay(timestampSec: number): string {
  if (!Number.isInteger(timestampSec) || timestampSec < 0 || timestampSec > 8_640_000_000_000) {
    throw new Error("Invalid Safety Score v9 shadow timestamp");
  }
  return new Date(timestampSec * 1_000).toISOString().slice(0, 10);
}

function safetyScoreV9ActiveIdsDigest(ids: readonly string[]): string {
  const canonicalIds = sortedUnique(ids);
  if (canonicalIds.length !== ids.length || canonicalIds.some((id) => id.length === 0)) {
    throw new Error("Safety Score v9 active IDs must be non-empty and unique");
  }
  return sha256Hex(
    stableJsonStringifyV1({
      domain: "safety-score-v9.shadow-active-ids.v1",
      ids: canonicalIds,
    }),
  );
}

export const SafetyScoreV9ReplayArtifactKindSchema = z.enum([
  "base-input",
  "fact-set",
  "policy",
  "evaluation-build",
  "result",
]);
export type SafetyScoreV9ReplayArtifactKind = z.infer<typeof SafetyScoreV9ReplayArtifactKindSchema>;

export const SafetyScoreV9ReplayArtifactSchema = z
  .object({
    kind: SafetyScoreV9ReplayArtifactKindSchema,
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
  .strict()
  .superRefine((artifact, ctx) => {
    const verification = artifact.verification;
    if (verification.status === "verified") {
      if (verification.observedContentSha256 !== artifact.contentSha256 || verification.verifiedAtSec === null) {
        ctx.addIssue({
          code: "custom",
          path: ["verification"],
          message: "Verified replay artifacts require a matching checksum and verification time",
        });
      }
    } else if (verification.status === "checksum-mismatch") {
      if (
        verification.observedContentSha256 === null ||
        verification.observedContentSha256 === artifact.contentSha256 ||
        verification.verifiedAtSec === null
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["verification"],
          message: "Checksum mismatches require a differing observed checksum and verification time",
        });
      }
    } else if (verification.status === "pending") {
      if (verification.observedContentSha256 !== null || verification.verifiedAtSec !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["verification"],
          message: "Pending replay verification cannot claim an observed checksum or time",
        });
      }
    }
  });
export type SafetyScoreV9ReplayArtifact = z.infer<typeof SafetyScoreV9ReplayArtifactSchema>;

const SafetyScoreV9CoverageFloorSchema = z
  .object({
    id: NonEmptyTextSchema,
    status: z.enum(["pass", "fail"]),
    observed: z.number().finite().nullable(),
    required: NonEmptyTextSchema,
    detail: NonEmptyTextSchema,
  })
  .strict();
export type SafetyScoreV9CoverageFloor = z.infer<typeof SafetyScoreV9CoverageFloorSchema>;

const SafetyScoreV9ShadowCoverageSchema = z
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
    coverageFloors: z.array(SafetyScoreV9CoverageFloorSchema),
    publicationRegression: z.boolean(),
    unresolvedReleaseBlockers: z.array(NonEmptyTextSchema),
    unresolvedCriticalMovementIds: z.array(NonEmptyTextSchema),
  })
  .strict()
  .superRefine((coverage, ctx) => {
    if (coverage.presentExpectedCount + coverage.missingIds.length !== coverage.expectedActiveCount) {
      ctx.addIssue({
        code: "custom",
        path: ["presentExpectedCount"],
        message: "Expected active-ID coverage does not reconcile",
      });
    }
    if (coverage.ratedResultCount + coverage.notRatedResultCount !== coverage.observedResultCount) {
      ctx.addIssue({
        code: "custom",
        path: ["ratedResultCount"],
        message: "Rated and not-rated result counts do not reconcile",
      });
    }
    for (const key of [
      "missingIds",
      "unexpectedIds",
      "duplicateIds",
      "compilerExceptions",
      "futureDatedEvidenceIds",
      "unresolvedReleaseBlockers",
      "unresolvedCriticalMovementIds",
    ] as const) {
      addCanonicalArrayIssue(coverage[key], ctx, [key]);
    }
    const floorIds = coverage.coverageFloors.map((floor) => floor.id);
    addCanonicalArrayIssue(floorIds, ctx, ["coverageFloors"]);
  });
export type SafetyScoreV9ShadowCoverage = z.infer<typeof SafetyScoreV9ShadowCoverageSchema>;

export const SafetyScoreV9ShadowEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(SAFETY_SCORE_V9_SHADOW_SCHEMA_VERSION),
    candidate: SafetyScoreV9ResponseSchema,
    compilerFactSchemaDigest: Sha256Schema,
    producerCapabilityDigest: Sha256Schema,
    releaseCoveragePolicyDigest: Sha256Schema,
    consumerThresholdRegistryDigest: Sha256Schema,
    coverage: SafetyScoreV9ShadowCoverageSchema,
    replayArtifacts: z.array(SafetyScoreV9ReplayArtifactSchema),
  })
  .strict()
  .superRefine((envelope, ctx) => {
    if (envelope.candidate.lifecycle !== "candidate") {
      ctx.addIssue({
        code: "custom",
        path: ["candidate", "lifecycle"],
        message: "A V9 shadow envelope must remain candidate-only",
      });
    }
    if (envelope.coverage.observedResultCount !== envelope.candidate.cards.length) {
      ctx.addIssue({
        code: "custom",
        path: ["coverage", "observedResultCount"],
        message: "Observed result count does not match compact results",
      });
    }
    if (
      envelope.coverage.ratedResultCount !== envelope.candidate.completeness.ratedCount ||
      envelope.coverage.notRatedResultCount !== envelope.candidate.completeness.notRatedCount
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["coverage"],
        message: "Coverage rateability does not match candidate completeness",
      });
    }

    const expectedArtifactIdentities: Record<SafetyScoreV9ReplayArtifactKind, string> = {
      "base-input": envelope.candidate.baseInputGenerationId,
      "fact-set": envelope.candidate.factSetDigest,
      policy: envelope.candidate.policy.semanticDigest,
      "evaluation-build": envelope.candidate.evaluationBuildDigest,
      result: envelope.candidate.resultDigest,
    };
    const seenKinds = new Set<SafetyScoreV9ReplayArtifactKind>();
    for (const [index, artifact] of envelope.replayArtifacts.entries()) {
      if (seenKinds.has(artifact.kind)) {
        ctx.addIssue({
          code: "custom",
          path: ["replayArtifacts", index, "kind"],
          message: "Replay artifact kinds must be unique",
        });
      }
      seenKinds.add(artifact.kind);
      if (artifact.identity !== expectedArtifactIdentities[artifact.kind]) {
        ctx.addIssue({
          code: "custom",
          path: ["replayArtifacts", index, "identity"],
          message: "Replay artifact identity does not match the candidate envelope",
        });
      }
    }
    const orderedKinds = envelope.replayArtifacts.map((artifact) => artifact.kind);
    if (orderedKinds.some((kind, index) => index > 0 && compareText(orderedKinds[index - 1]!, kind) >= 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["replayArtifacts"],
        message: "Replay artifacts must be sorted by kind",
      });
    }
  });
export type SafetyScoreV9ShadowEnvelope = z.infer<typeof SafetyScoreV9ShadowEnvelopeSchema>;

/**
 * The non-self-referential part of a retained shadow envelope. The result
 * artifact stores this core; the full envelope is recovered by attaching the
 * five content-addressed artifact references loaded from D1.
 */
export const SafetyScoreV9ShadowEnvelopeCoreSchema = z
  .object({
    schemaVersion: z.literal(SAFETY_SCORE_V9_SHADOW_SCHEMA_VERSION),
    compilerFactSchemaDigest: Sha256Schema,
    producerCapabilityDigest: Sha256Schema,
    releaseCoveragePolicyDigest: Sha256Schema,
    consumerThresholdRegistryDigest: Sha256Schema,
    coverage: SafetyScoreV9ShadowCoverageSchema,
  })
  .strict();
export type SafetyScoreV9ShadowEnvelopeCore = z.infer<typeof SafetyScoreV9ShadowEnvelopeCoreSchema>;

export function projectSafetyScoreV9ShadowEnvelopeCore(
  envelopeInput: SafetyScoreV9ShadowEnvelope,
): SafetyScoreV9ShadowEnvelopeCore {
  const envelope = SafetyScoreV9ShadowEnvelopeSchema.parse(envelopeInput);
  return SafetyScoreV9ShadowEnvelopeCoreSchema.parse({
    schemaVersion: envelope.schemaVersion,
    compilerFactSchemaDigest: envelope.compilerFactSchemaDigest,
    producerCapabilityDigest: envelope.producerCapabilityDigest,
    releaseCoveragePolicyDigest: envelope.releaseCoveragePolicyDigest,
    consumerThresholdRegistryDigest: envelope.consumerThresholdRegistryDigest,
    coverage: envelope.coverage,
  });
}

export function rebuildSafetyScoreV9ShadowEnvelope(args: {
  candidate: SafetyScoreV9Response;
  core: SafetyScoreV9ShadowEnvelopeCore;
  replayArtifacts: readonly SafetyScoreV9ReplayArtifact[];
}): SafetyScoreV9ShadowEnvelope {
  const core = SafetyScoreV9ShadowEnvelopeCoreSchema.parse(args.core);
  return SafetyScoreV9ShadowEnvelopeSchema.parse({
    ...core,
    candidate: args.candidate,
    replayArtifacts: [...args.replayArtifacts].sort((left, right) => compareText(left.kind, right.kind)),
  });
}

export interface BuildSafetyScoreV9ShadowEnvelopeInput {
  candidate: SafetyScoreV9Response;
  expectedActiveIds: readonly string[];
  compilerFactSchemaDigest: string;
  producerCapabilityDigest: string;
  duplicateIds?: readonly string[];
  compilerExceptions?: readonly string[];
  futureDatedEvidenceIds?: readonly string[];
  coverageFloors: readonly SafetyScoreV9CoverageFloor[];
  publicationRegression?: boolean;
  unresolvedReleaseBlockers?: readonly string[];
  unresolvedCriticalMovementIds?: readonly string[];
  replayArtifacts?: readonly SafetyScoreV9ReplayArtifact[];
}

export function buildSafetyScoreV9ShadowEnvelope(
  input: BuildSafetyScoreV9ShadowEnvelopeInput,
): SafetyScoreV9ShadowEnvelope {
  const candidate = SafetyScoreV9ResponseSchema.parse({
    ...input.candidate,
    cards: [...input.candidate.cards].sort((left, right) => compareText(left.id, right.id)),
    completeness: {
      ...input.candidate.completeness,
      notRatedIds: sortedUnique(input.candidate.completeness.notRatedIds),
    },
  });
  if (candidate.lifecycle !== "candidate") {
    throw new Error("Safety Score v9 shadow publication requires candidate lifecycle");
  }
  const expectedActiveIds = sortedUnique(input.expectedActiveIds);
  if (expectedActiveIds.length !== input.expectedActiveIds.length || expectedActiveIds.some((id) => id.length === 0)) {
    throw new Error("Safety Score v9 expected active IDs must be non-empty and unique");
  }
  const expectedSet = new Set(expectedActiveIds);
  const candidateIds = candidate.cards.map((card) => card.id);
  const candidateSet = new Set(candidateIds);
  const presentExpectedIds = expectedActiveIds.filter((id) => candidateSet.has(id));
  const missingIds = expectedActiveIds.filter((id) => !candidateSet.has(id));
  const unexpectedIds = sortedUnique(candidateIds.filter((id) => !expectedSet.has(id)));
  const canonicalCandidate: SafetyScoreV9Response = {
    ...candidate,
    cards: [...candidate.cards].sort((left, right) => compareText(left.id, right.id)),
    completeness: {
      ...candidate.completeness,
      notRatedIds: sortedUnique(candidate.completeness.notRatedIds),
    },
  };

  return SafetyScoreV9ShadowEnvelopeSchema.parse({
    schemaVersion: SAFETY_SCORE_V9_SHADOW_SCHEMA_VERSION,
    candidate: canonicalCandidate,
    compilerFactSchemaDigest: input.compilerFactSchemaDigest,
    producerCapabilityDigest: input.producerCapabilityDigest,
    releaseCoveragePolicyDigest: V9_SHADOW_RELEASE_COVERAGE_POLICY_DIGEST,
    consumerThresholdRegistryDigest: V9_CONSUMER_SCORE_THRESHOLD_REGISTRY_DIGEST,
    coverage: {
      expectedActiveCount: expectedActiveIds.length,
      observedResultCount: candidate.cards.length,
      presentExpectedCount: presentExpectedIds.length,
      ratedResultCount: candidate.completeness.ratedCount,
      notRatedResultCount: candidate.completeness.notRatedCount,
      expectedActiveIdsDigest: safetyScoreV9ActiveIdsDigest(expectedActiveIds),
      presentExpectedIdsDigest: safetyScoreV9ActiveIdsDigest(presentExpectedIds),
      missingIds,
      unexpectedIds,
      duplicateIds: sortedUnique(input.duplicateIds ?? []),
      compilerExceptions: sortedUnique(input.compilerExceptions ?? []),
      futureDatedEvidenceIds: sortedUnique(input.futureDatedEvidenceIds ?? []),
      coverageFloors: [...input.coverageFloors].sort((left, right) => compareText(left.id, right.id)),
      publicationRegression: input.publicationRegression ?? false,
      unresolvedReleaseBlockers: sortedUnique(input.unresolvedReleaseBlockers ?? []),
      unresolvedCriticalMovementIds: sortedUnique(input.unresolvedCriticalMovementIds ?? []),
    },
    replayArtifacts: [...(input.replayArtifacts ?? [])].sort((left, right) => compareText(left.kind, right.kind)),
  });
}

const SafetyScoreV9ShadowQualificationBlockerSchema = z.enum([
  "active-id-bijection-failed",
  "compiler-exception",
  "future-dated-evidence",
  "coverage-floor-failed",
  "publication-regression",
  "unresolved-release-blocker",
  "unresolved-critical-movement",
]);
export type SafetyScoreV9ShadowQualificationBlocker = z.infer<typeof SafetyScoreV9ShadowQualificationBlockerSchema>;

const SafetyScoreV9ShadowQualificationSchema = z
  .object({
    qualifies: z.boolean(),
    blockers: z.array(SafetyScoreV9ShadowQualificationBlockerSchema),
  })
  .strict()
  .superRefine((qualification, ctx) => {
    addCanonicalArrayIssue(qualification.blockers, ctx, ["blockers"]);
    if (qualification.qualifies !== (qualification.blockers.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["qualifies"],
        message: "Qualification must agree with its blocker set",
      });
    }
  });
export type SafetyScoreV9ShadowQualification = z.infer<typeof SafetyScoreV9ShadowQualificationSchema>;

export function assessSafetyScoreV9ShadowQualification(
  envelopeInput: SafetyScoreV9ShadowEnvelope,
): SafetyScoreV9ShadowQualification {
  const envelope = SafetyScoreV9ShadowEnvelopeSchema.parse(envelopeInput);
  const blockers = new Set<SafetyScoreV9ShadowQualificationBlocker>();
  const coverage = envelope.coverage;
  if (
    coverage.expectedActiveCount !== coverage.observedResultCount ||
    coverage.missingIds.length > 0 ||
    coverage.unexpectedIds.length > 0 ||
    coverage.duplicateIds.length > 0
  ) {
    blockers.add("active-id-bijection-failed");
  }
  if (coverage.compilerExceptions.length > 0) blockers.add("compiler-exception");
  if (coverage.futureDatedEvidenceIds.length > 0) blockers.add("future-dated-evidence");
  if (coverage.coverageFloors.some((floor) => floor.status === "fail")) {
    blockers.add("coverage-floor-failed");
  }
  if (coverage.publicationRegression) blockers.add("publication-regression");
  if (coverage.unresolvedReleaseBlockers.length > 0) {
    blockers.add("unresolved-release-blocker");
  }
  // Movement adjudication is deliberately NOT a daily blocker. Whether V9's treatment of an
  // asset is correct is a one-time question about the methodology transition, not evidence that
  // the pipeline ran stably today; re-adjudicating because a score moved a point measures
  // neither. `unresolvedCriticalMovementIds` stays recorded on every run and is enforced once,
  // at window end, by the offline gate. Every pipeline-stability floor above still gates daily.
  const canonicalBlockers = [...blockers].sort(compareText);
  return SafetyScoreV9ShadowQualificationSchema.parse({
    qualifies: canonicalBlockers.length === 0,
    blockers: canonicalBlockers,
  });
}

export function computeSafetyScoreV9ShadowEnvelopeDigest(envelope: SafetyScoreV9ShadowEnvelope): string {
  const parsed = SafetyScoreV9ShadowEnvelopeSchema.parse(envelope);
  const { replayArtifacts: _replayArtifacts, ...candidateEvidence } = parsed;
  void _replayArtifacts;
  return sha256Hex(
    stableJsonStringifyV1({
      domain: "safety-score-v9.shadow-envelope.v2",
      envelope: candidateEvidence,
    }),
  );
}

const SafetyScoreV9ShadowIdentitySchema = z
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
export type SafetyScoreV9ShadowIdentity = z.infer<typeof SafetyScoreV9ShadowIdentitySchema>;

const SafetyScoreV9DiffReviewDispositionSchema = SafetyScoreV9MovementReviewDispositionSchema;
export type SafetyScoreV9DiffReviewDisposition = SafetyScoreV9MovementReviewDisposition;

const SafetyScoreV8ComparableCardSchema = z
  .object({
    id: NonEmptyTextSchema,
    score: ScoreSchema.nullable(),
    grade: ReportCardGradeSchema,
    bindingCap: z
      .object({
        kind: NonEmptyTextSchema,
        limit: ScoreSchema,
        source: NonEmptyTextSchema.nullable(),
      })
      .strict()
      .nullable(),
    reasonCodes: z.array(NonEmptyTextSchema),
  })
  .strict();
export type SafetyScoreV8ComparableCard = z.infer<typeof SafetyScoreV8ComparableCardSchema>;

const SafetyScoreV8ComparableSnapshotSchema = z
  .object({
    model: z.literal("v8"),
    publicationGenerationId: NonEmptyTextSchema,
    baseInputGenerationId: BaseInputGenerationIdSchema,
    methodologyVersion: NonEmptyTextSchema,
    evaluationBuildDigest: Sha256Schema,
    cards: z.array(SafetyScoreV8ComparableCardSchema),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const ids = snapshot.cards.map((card) => card.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", path: ["cards"], message: "V8 comparison IDs must be unique" });
    }
  });
export type SafetyScoreV8ComparableSnapshot = z.infer<typeof SafetyScoreV8ComparableSnapshotSchema>;

const SafetyScoreV9DownstreamThresholdSchema = z
  .object({
    id: NonEmptyTextSchema,
    label: NonEmptyTextSchema,
    score: ScoreSchema,
    comparison: z.enum(["at-least", "at-most"]),
  })
  .strict();
export type SafetyScoreV9DownstreamThreshold = z.infer<typeof SafetyScoreV9DownstreamThresholdSchema>;

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

const SafetyScoreV9DiffMovementSchema = z
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
  })
  .strict();
type SafetyScoreV9DiffMovement = z.infer<typeof SafetyScoreV9DiffMovementSchema>;

const SafetyScoreV9DiffCardSchema = SafetyScoreV9DiffMovementSchema.extend({
  review: z
    .object({
      key: Sha256Schema.nullable(),
      classKey: Sha256Schema.nullable(),
      status: z.enum(["not-required", "pending", "classified"]),
      disposition: SafetyScoreV9DiffReviewDispositionSchema.nullable(),
      /**
       * Non-null when the disposition was carried from a review of a different exact movement
       * in the same class. Retains the exact movement that was actually adjudicated so a
       * reviewer can always separate what was ruled on from what was carried.
       */
      carriedFrom: z
        .object({
          reviewKey: Sha256Schema,
          reviewedV8Score: ScoreSchema.nullable(),
          reviewedV9Score: ScoreSchema.nullable(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
})
  .strict()
  .superRefine((card, ctx) => {
    if (!card.flags.requiresReview) {
      if (
        card.review.key !== null ||
        card.review.classKey !== null ||
        card.review.status !== "not-required" ||
        card.review.disposition !== null ||
        card.review.carriedFrom !== null
      ) {
        ctx.addIssue({ code: "custom", path: ["review"], message: "Non-material movements cannot carry a review" });
      }
      return;
    }
    if (card.review.key === null || card.review.classKey === null || card.review.status === "not-required") {
      ctx.addIssue({ code: "custom", path: ["review"], message: "Material movements require a review key" });
    }
    if ((card.review.status === "classified") !== (card.review.disposition !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["review", "disposition"],
        message: "Classified review status must agree with its disposition",
      });
    }
    if (card.review.carriedFrom !== null && card.review.status !== "classified") {
      ctx.addIssue({
        code: "custom",
        path: ["review", "carriedFrom"],
        message: "A carried disposition must resolve to a classified review",
      });
    }
    if (card.review.carriedFrom !== null && card.review.carriedFrom.reviewKey === card.review.key) {
      ctx.addIssue({
        code: "custom",
        path: ["review", "carriedFrom"],
        message: "An exact-key review is not a carry",
      });
    }
  });
export type SafetyScoreV9DiffCard = z.infer<typeof SafetyScoreV9DiffCardSchema>;

function computeSafetyScoreV9DiffReviewKey(input: {
  v8Identity: { methodologyVersion: string; evaluationBuildDigest: string };
  v9Identity: {
    candidateId: string;
    policyVersion: string;
    policyId: string;
    policyDigest: string;
    evaluationBuildDigest: string;
  };
  movement: SafetyScoreV9DiffMovement;
}): string {
  const movement = SafetyScoreV9DiffMovementSchema.parse(input.movement);
  const { supplyUsd: _supplyUsd, supplyWeightedImpact: _supplyWeightedImpact, ...semanticMovement } = movement;
  void [_supplyUsd, _supplyWeightedImpact];
  return sha256Hex(
    stableJsonStringifyV1({
      domain: "safety-score-v9.movement-review-key.v2",
      v8Identity: input.v8Identity,
      v9Identity: input.v9Identity,
      movement: semanticMovement,
    }),
  );
}

/**
 * Class of a movement: everything that states *what kind of change this is*, with exact
 * magnitude removed. Magnitude is not dropped — it is delegated to the reviewed-score anchor,
 * which bounds drift at `V9_SHADOW_MOVEMENT_REVIEW_CARRY_SCORE_DRIFT` for the whole window
 * rather than bucketing it (buckets would reintroduce boundary oscillation).
 *
 * Retained, deliberately: full V8 and V9 reason-code sets plus the new/removed sets. Cause must
 * stay in the class, otherwise a movement could swap a benign reason code for a defect-class one
 * at the same score and silently inherit a benign disposition.
 *
 * Dropped, and why it is safe:
 * - `v8.score`, `v9.score`, `scoreDelta`, `absoluteScoreDelta` — bounded by the anchor.
 * - `v9WeakestPillar.score` — continuous and unquantised, so it has no rounding deadband; the
 *   pillar *name* is retained, and the score is bounded by the anchor.
 * - `bindingCap.limit` — a cap retune is a policy change, which moves `policyDigest` and so
 *   breaks the frozen window identity outright.
 * - `flags.absoluteScoreDeltaAtLeast5`, `flags.topCutoffScoreDeltaAtLeast2` — pure restatements
 *   of magnitude against a fixed threshold, already bounded by the anchor.
 */
function safetyScoreV9DiffReviewClassProjection(movement: SafetyScoreV9DiffMovement) {
  const classCard = (card: SafetyScoreV9DiffMovement["v8"]) =>
    card === null
      ? null
      : {
          grade: card.grade,
          bindingCapKind: card.bindingCap === null ? null : card.bindingCap.kind,
          reasonCodes: card.reasonCodes,
        };
  return {
    id: movement.id,
    transition: movement.transition,
    v8: classCard(movement.v8),
    v9: classCard(movement.v9),
    v9WeakestPillar: movement.v9WeakestPillar === null ? null : { pillar: movement.v9WeakestPillar.pillar },
    newReasonCodes: movement.newReasonCodes,
    removedReasonCodes: movement.removedReasonCodes,
    flags: {
      inputMissing: movement.flags.inputMissing,
      gradeOrNrTransition: movement.flags.gradeOrNrTransition,
      bindingCapChanged: movement.flags.bindingCapChanged,
      downstreamThresholdCrossingIds: movement.flags.downstreamThresholdCrossingIds,
      requiresReview: movement.flags.requiresReview,
    },
  };
}

function computeSafetyScoreV9DiffReviewClassKey(input: {
  v8Identity: { methodologyVersion: string; evaluationBuildDigest: string };
  v9Identity: {
    candidateId: string;
    policyVersion: string;
    policyId: string;
    policyDigest: string;
    evaluationBuildDigest: string;
  };
  movement: SafetyScoreV9DiffMovement;
}): string {
  const movement = SafetyScoreV9DiffMovementSchema.parse(input.movement);
  return sha256Hex(
    stableJsonStringifyV1({
      domain: "safety-score-v9.movement-review-class-key.v1",
      v8Identity: input.v8Identity,
      v9Identity: input.v9Identity,
      movementClass: safetyScoreV9DiffReviewClassProjection(movement),
    }),
  );
}

/** A recorded disposition offered for carry into a later run of the same movement class. */
export interface SafetyScoreV9DiffReviewCarry {
  reviewKey: string;
  disposition: SafetyScoreV9DiffReviewDisposition;
  reviewedV8Score: number | null;
  reviewedV9Score: number | null;
}

function withinCarryAnchor(reviewed: number | null, current: number | null): boolean {
  if (reviewed === null || current === null) return reviewed === current;
  return Math.abs(current - reviewed) <= V9_SHADOW_MOVEMENT_REVIEW_CARRY_SCORE_DRIFT;
}

const SafetyScoreV9DiffSummarySchema = z
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
export type SafetyScoreV9DiffSummary = z.infer<typeof SafetyScoreV9DiffSummarySchema>;

const SafetyScoreV9DiffReportPayloadSchema = z
  .object({
    schemaVersion: z.literal(SAFETY_SCORE_V9_SHADOW_SCHEMA_VERSION),
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
    v9Identity: SafetyScoreV9ShadowIdentitySchema.omit({
      compilerFactSchemaDigest: true,
      producerCapabilityDigest: true,
      releaseCoveragePolicyDigest: true,
      consumerThresholdRegistryDigest: true,
      envelopeDigest: true,
      sourceGenerations: true,
    }),
    thresholds: z
      .object({
        absoluteScoreDelta: z.literal(SAFETY_SCORE_V9_DIFF_ABSOLUTE_REVIEW_DELTA),
        topCutoffScoreDelta: z.literal(SAFETY_SCORE_V9_DIFF_TOP_CUTOFF_REVIEW_DELTA),
        downstream: z.array(SafetyScoreV9DownstreamThresholdSchema),
      })
      .strict(),
    summary: SafetyScoreV9DiffSummarySchema,
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
    cards: z.array(SafetyScoreV9DiffCardSchema),
  })
  .strict();

export const SafetyScoreV9DiffReportSchema = SafetyScoreV9DiffReportPayloadSchema.extend({
  reportDigest: Sha256Schema,
})
  .strict()
  .superRefine((report, ctx) => {
    const { reportDigest: _reportDigest, ...payload } = report;
    const expectedDigest = computeSafetyScoreV9DiffReportDigest(payload);
    if (report.reportDigest !== expectedDigest) {
      ctx.addIssue({
        code: "custom",
        path: ["reportDigest"],
        message: "V9 diff report digest does not match its canonical payload",
      });
    }
    const ids = report.cards.map((card) => card.id);
    if (!isSortedUnique(ids)) {
      ctx.addIssue({ code: "custom", path: ["cards"], message: "Diff cards must be sorted and unique" });
    }
  });
export type SafetyScoreV9DiffReport = z.infer<typeof SafetyScoreV9DiffReportSchema>;

type SafetyScoreV9DiffReportPayload = z.infer<typeof SafetyScoreV9DiffReportPayloadSchema>;

function computeSafetyScoreV9DiffReportDigest(report: SafetyScoreV9DiffReportPayload): string {
  return sha256Hex(
    stableJsonStringifyV1({
      domain: "safety-score-v9.shadow-diff.v1",
      report: SafetyScoreV9DiffReportPayloadSchema.parse(report),
    }),
  );
}

function thresholdState(score: number | null, threshold: SafetyScoreV9DownstreamThreshold): boolean {
  if (score === null) return false;
  return threshold.comparison === "at-least" ? score >= threshold.score : score <= threshold.score;
}

function normalizedV8Card(card: SafetyScoreV8ComparableCard | null) {
  return card
    ? {
        score: card.score,
        grade: card.grade,
        bindingCap: card.bindingCap,
        reasonCodes: sortedUnique(card.reasonCodes),
      }
    : null;
}

function normalizedV9Card(card: SafetyScoreV9Response["cards"][number] | null) {
  return card
    ? {
        score: card.score,
        grade: card.grade,
        bindingCap: card.bindingCap
          ? {
              kind: card.bindingCap.kind,
              limit: card.bindingCap.limit,
              source: card.bindingCap.source,
            }
          : null,
        reasonCodes: sortedUnique(card.reasonCodes),
      }
    : null;
}

function diffTransition(
  v8: ReturnType<typeof normalizedV8Card>,
  v9: ReturnType<typeof normalizedV9Card>,
): SafetyScoreV9DiffCard["transition"] {
  if (!v8) return "missing-v8";
  if (!v9) return "missing-v9";
  if (v8.score === null && v9.score === null) return "both-nr";
  if (v8.score === null) return "v8-nr-v9-rated";
  if (v9.score === null) return "v8-rated-v9-nr";
  return "both-rated";
}

export interface BuildSafetyScoreV9DiffReportInput {
  generatedAtSec: number;
  expectedActiveIds: readonly string[];
  v8: SafetyScoreV8ComparableSnapshot;
  v9: SafetyScoreV9ShadowEnvelope;
  topCutoffIds: ReadonlySet<string>;
  downstreamThresholds: readonly SafetyScoreV9DownstreamThreshold[];
  supplyUsdById: Readonly<Record<string, number>>;
  reviewDispositionsByKey?: Readonly<Record<string, SafetyScoreV9DiffReviewDisposition>>;
  /** Recorded dispositions eligible to carry, indexed by the class key they were recorded under. */
  reviewCarriesByClassKey?: Readonly<Record<string, SafetyScoreV9DiffReviewCarry>>;
  topMovementLimit?: number;
}

export function buildSafetyScoreV9DiffReport(input: BuildSafetyScoreV9DiffReportInput): SafetyScoreV9DiffReport {
  const v8 = SafetyScoreV8ComparableSnapshotSchema.parse(input.v8);
  const v9 = SafetyScoreV9ShadowEnvelopeSchema.parse(input.v9);
  if (v8.baseInputGenerationId !== v9.candidate.baseInputGenerationId) {
    throw new Error("V8/V9 diff requires one exact base input generation");
  }
  const expectedActiveIds = sortedUnique(input.expectedActiveIds);
  if (expectedActiveIds.length !== input.expectedActiveIds.length) {
    throw new Error("V8/V9 diff expected IDs must be unique");
  }
  const downstreamThresholds = input.downstreamThresholds
    .map((threshold) => SafetyScoreV9DownstreamThresholdSchema.parse(threshold))
    .sort((left, right) => compareText(left.id, right.id));
  if (new Set(downstreamThresholds.map((threshold) => threshold.id)).size !== downstreamThresholds.length) {
    throw new Error("V8/V9 downstream threshold IDs must be unique");
  }
  const v8ById = new Map(v8.cards.map((card) => [card.id, card]));
  const v9ById = new Map(v9.candidate.cards.map((card) => [card.id, card]));
  const cards: SafetyScoreV9DiffCard[] = expectedActiveIds.map((id) => {
    const v8Card = normalizedV8Card(v8ById.get(id) ?? null);
    const rawV9Card = v9ById.get(id) ?? null;
    const v9Card = normalizedV9Card(rawV9Card);
    const transition = diffTransition(v8Card, v9Card);
    const scoreDelta = v8Card?.score != null && v9Card?.score != null ? v9Card.score - v8Card.score : null;
    const absoluteScoreDelta = scoreDelta === null ? null : Math.abs(scoreDelta);
    const inputMissing = v8Card === null || v9Card === null;
    const gradeOrNrTransition =
      !inputMissing && (v8Card.grade !== v9Card.grade || (v8Card.score === null) !== (v9Card.score === null));
    const bindingCapChanged =
      !inputMissing && stableJsonStringifyV1(v8Card.bindingCap) !== stableJsonStringifyV1(v9Card.bindingCap);
    const absoluteScoreDeltaAtLeast5 =
      absoluteScoreDelta !== null && absoluteScoreDelta >= SAFETY_SCORE_V9_DIFF_ABSOLUTE_REVIEW_DELTA;
    const topCutoffScoreDeltaAtLeast2 =
      input.topCutoffIds.has(id) &&
      absoluteScoreDelta !== null &&
      absoluteScoreDelta >= SAFETY_SCORE_V9_DIFF_TOP_CUTOFF_REVIEW_DELTA;
    const downstreamThresholdCrossingIds = downstreamThresholds
      .filter(
        (threshold) =>
          !inputMissing && thresholdState(v8Card.score, threshold) !== thresholdState(v9Card.score, threshold),
      )
      .map((threshold) => threshold.id);
    const requiresReview =
      inputMissing ||
      gradeOrNrTransition ||
      bindingCapChanged ||
      absoluteScoreDeltaAtLeast5 ||
      topCutoffScoreDeltaAtLeast2 ||
      downstreamThresholdCrossingIds.length > 0;
    const v8Reasons = new Set(v8Card?.reasonCodes ?? []);
    const v9Reasons = new Set(v9Card?.reasonCodes ?? []);
    const supplyUsd = input.supplyUsdById[id] ?? 0;
    if (!Number.isFinite(supplyUsd) || supplyUsd < 0) {
      throw new Error(`Invalid V8/V9 diff supply for ${id}`);
    }

    const movement = SafetyScoreV9DiffMovementSchema.parse({
      id,
      v8: v8Card,
      v9: v9Card,
      v9WeakestPillar: rawV9Card?.weakestPillar ?? null,
      transition,
      scoreDelta,
      absoluteScoreDelta,
      newReasonCodes: sortedUnique([...v9Reasons].filter((reason) => !v8Reasons.has(reason))),
      removedReasonCodes: sortedUnique([...v8Reasons].filter((reason) => !v9Reasons.has(reason))),
      supplyUsd,
      supplyWeightedImpact: absoluteScoreDelta === null ? null : absoluteScoreDelta * supplyUsd,
      flags: {
        inputMissing,
        gradeOrNrTransition,
        bindingCapChanged,
        absoluteScoreDeltaAtLeast5,
        topCutoffScoreDeltaAtLeast2,
        downstreamThresholdCrossingIds,
        requiresReview,
      },
    });
    const keyIdentity = {
      v8Identity: {
        methodologyVersion: v8.methodologyVersion,
        evaluationBuildDigest: v8.evaluationBuildDigest,
      },
      v9Identity: {
        candidateId: v9.candidate.candidateId,
        policyVersion: v9.candidate.policyVersion,
        policyId: v9.candidate.policy.id,
        policyDigest: v9.candidate.policy.semanticDigest,
        evaluationBuildDigest: v9.candidate.evaluationBuildDigest,
      },
    };
    const reviewKey = requiresReview ? computeSafetyScoreV9DiffReviewKey({ ...keyIdentity, movement }) : null;
    const reviewClassKey = requiresReview
      ? computeSafetyScoreV9DiffReviewClassKey({ ...keyIdentity, movement })
      : null;

    // Exact-key dispositions win. A carry only applies when no review exists for this exact
    // movement, the class is unchanged, and both score anchors are still inside the drift cap.
    const exactDisposition = reviewKey ? (input.reviewDispositionsByKey?.[reviewKey] ?? null) : null;
    const offeredCarry =
      exactDisposition === null && reviewClassKey ? (input.reviewCarriesByClassKey?.[reviewClassKey] ?? null) : null;
    const carry =
      offeredCarry !== null &&
      offeredCarry.reviewKey !== reviewKey &&
      withinCarryAnchor(offeredCarry.reviewedV8Score, v8Card?.score ?? null) &&
      withinCarryAnchor(offeredCarry.reviewedV9Score, v9Card?.score ?? null)
        ? offeredCarry
        : null;
    const disposition = exactDisposition ?? carry?.disposition ?? null;
    return SafetyScoreV9DiffCardSchema.parse({
      ...movement,
      review: {
        key: reviewKey,
        classKey: reviewClassKey,
        status: !requiresReview ? "not-required" : disposition ? "classified" : "pending",
        disposition,
        carriedFrom:
          carry === null
            ? null
            : {
                reviewKey: carry.reviewKey,
                reviewedV8Score: carry.reviewedV8Score,
                reviewedV9Score: carry.reviewedV9Score,
              },
      },
    });
  });

  const comparable = cards.filter((card) => card.absoluteScoreDelta !== null && card.supplyWeightedImpact !== null);
  const comparableSupplyUsd = comparable.reduce((sum, card) => sum + card.supplyUsd, 0);
  const totalSupplyWeightedImpact = comparable.reduce((sum, card) => sum + (card.supplyWeightedImpact ?? 0), 0);
  const topMovementLimit = input.topMovementLimit ?? 20;
  if (!Number.isInteger(topMovementLimit) || topMovementLimit < 0) {
    throw new Error("V8/V9 diff top movement limit must be a non-negative integer");
  }
  const topSupplyWeightedMovements = comparable
    .filter((card) => (card.supplyWeightedImpact ?? 0) > 0)
    .sort(
      (left, right) =>
        (right.supplyWeightedImpact ?? 0) - (left.supplyWeightedImpact ?? 0) || compareText(left.id, right.id),
    )
    .slice(0, topMovementLimit)
    .map((card) => ({
      id: card.id,
      absoluteScoreDelta: card.absoluteScoreDelta!,
      supplyUsd: card.supplyUsd,
      supplyWeightedImpact: card.supplyWeightedImpact!,
    }));

  const payload = SafetyScoreV9DiffReportPayloadSchema.parse({
    schemaVersion: SAFETY_SCORE_V9_SHADOW_SCHEMA_VERSION,
    generatedAtSec: input.generatedAtSec,
    expectedActiveIdsDigest: safetyScoreV9ActiveIdsDigest(expectedActiveIds),
    v8Identity: {
      publicationGenerationId: v8.publicationGenerationId,
      baseInputGenerationId: v8.baseInputGenerationId,
      methodologyVersion: v8.methodologyVersion,
      evaluationBuildDigest: v8.evaluationBuildDigest,
    },
    v9Identity: {
      candidateId: v9.candidate.candidateId,
      policyVersion: v9.candidate.policyVersion,
      publicationGenerationId: v9.candidate.publicationGenerationId,
      baseInputGenerationId: v9.candidate.baseInputGenerationId,
      factSetDigest: v9.candidate.factSetDigest,
      policyId: v9.candidate.policy.id,
      policyDigest: v9.candidate.policy.semanticDigest,
      evaluationBuildDigest: v9.candidate.evaluationBuildDigest,
      resultDigest: v9.candidate.resultDigest,
    },
    thresholds: {
      absoluteScoreDelta: SAFETY_SCORE_V9_DIFF_ABSOLUTE_REVIEW_DELTA,
      topCutoffScoreDelta: SAFETY_SCORE_V9_DIFF_TOP_CUTOFF_REVIEW_DELTA,
      downstream: downstreamThresholds,
    },
    summary: {
      expectedCount: expectedActiveIds.length,
      comparedCount: cards.filter((card) => !card.flags.inputMissing).length,
      missingInputCount: cards.filter((card) => card.flags.inputMissing).length,
      gradeOrNrTransitionCount: cards.filter((card) => card.flags.gradeOrNrTransition).length,
      bindingCapChangeCount: cards.filter((card) => card.flags.bindingCapChanged).length,
      largeScoreMovementCount: cards.filter((card) => card.flags.absoluteScoreDeltaAtLeast5).length,
      topCutoffMovementCount: cards.filter((card) => card.flags.topCutoffScoreDeltaAtLeast2).length,
      downstreamCrossingCount: cards.filter((card) => card.flags.downstreamThresholdCrossingIds.length > 0).length,
      requiresReviewCount: cards.filter((card) => card.flags.requiresReview).length,
      pendingReviewCount: cards.filter((card) => card.review.status === "pending").length,
      comparableSupplyUsd,
      supplyWeightedMeanAbsoluteDelta:
        comparableSupplyUsd === 0 ? null : totalSupplyWeightedImpact / comparableSupplyUsd,
    },
    topSupplyWeightedMovements,
    cards,
  });
  return SafetyScoreV9DiffReportSchema.parse({
    ...payload,
    reportDigest: computeSafetyScoreV9DiffReportDigest(payload),
  });
}

const SafetyScoreV9ShadowFailureStageSchema = z.enum([
  "scheduler",
  "base-input",
  "v8-publication",
  "v9-enrichment",
  "compile",
  "score",
  "serialize",
  "artifact-retention",
  "shadow-write",
  "aborted",
]);
export type SafetyScoreV9ShadowFailureStage = z.infer<typeof SafetyScoreV9ShadowFailureStageSchema>;

const SafetyScoreV9ShadowArchiveSelectionReasonSchema = z.enum(["anomaly", "final", "first"]);
export type SafetyScoreV9ShadowArchiveSelectionReason = z.infer<typeof SafetyScoreV9ShadowArchiveSelectionReasonSchema>;

const SafetyScoreV9ShadowLatestErrorSchema = z
  .object({
    atSec: UnixSecondsSchema,
    stage: SafetyScoreV9ShadowFailureStageSchema,
    code: NonEmptyTextSchema.max(160),
    message: NonEmptyTextSchema.max(500),
  })
  .strict();

const ReplayArtifactKeySchema = z.string().regex(/^(base-input|evaluation-build|fact-set|policy|result):[a-f0-9]{64}$/);

const SafetyScoreV9ShadowSelectedRunSchema = z
  .object({
    selectedAtSec: UnixSecondsSchema,
    identity: SafetyScoreV9ShadowIdentitySchema,
    coverage: SafetyScoreV9ShadowCoverageSchema,
    movement: SafetyScoreV9DiffSummarySchema,
    qualification: SafetyScoreV9ShadowQualificationSchema,
    diffReportDigest: Sha256Schema,
    archiveSelectionReasons: z.array(SafetyScoreV9ShadowArchiveSelectionReasonSchema),
    artifactKeys: z.array(ReplayArtifactKeySchema),
  })
  .strict()
  .superRefine((selected, ctx) => {
    addCanonicalArrayIssue(selected.archiveSelectionReasons, ctx, ["archiveSelectionReasons"]);
    addCanonicalArrayIssue(selected.artifactKeys, ctx, ["artifactKeys"]);
    if (selected.coverage.expectedActiveCount !== selected.movement.expectedCount) {
      ctx.addIssue({
        code: "custom",
        path: ["movement", "expectedCount"],
        message: "Movement and coverage active counts must agree",
      });
    }
    const selectedKinds = selected.artifactKeys.map((key) => key.slice(0, key.indexOf(":")));
    const expectedKinds = [...SafetyScoreV9ReplayArtifactKindSchema.options].sort(compareText);
    if (selected.archiveSelectionReasons.length === 0) {
      if (selected.artifactKeys.length !== 0) {
        ctx.addIssue({
          code: "custom",
          path: ["artifactKeys"],
          message: "Unselected daily runs cannot retain replay artifacts",
        });
      }
    } else if (stableJsonStringifyV1(selectedKinds) !== stableJsonStringifyV1(expectedKinds)) {
      ctx.addIssue({
        code: "custom",
        path: ["artifactKeys"],
        message: "Selected daily runs require one replay artifact of every kind",
      });
    }
  });
export type SafetyScoreV9ShadowSelectedRun = z.infer<typeof SafetyScoreV9ShadowSelectedRunSchema>;

export const SafetyScoreV9ShadowDailySchema = z
  .object({
    schemaVersion: z.literal(SAFETY_SCORE_V9_SHADOW_SCHEMA_VERSION),
    utcDay: UtcDaySchema,
    updatedAtSec: UnixSecondsSchema,
    attemptCounts: z
      .object({
        successful: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
      })
      .strict(),
    selectedRun: SafetyScoreV9ShadowSelectedRunSchema.nullable(),
    latestError: SafetyScoreV9ShadowLatestErrorSchema.nullable(),
  })
  .strict()
  .superRefine((daily, ctx) => {
    const attemptCount = daily.attemptCounts.successful + daily.attemptCounts.failed;
    if (attemptCount === 0) {
      ctx.addIssue({ code: "custom", path: ["attemptCounts"], message: "A daily row requires one attempt" });
    }
    if (daily.attemptCounts.successful > 0 !== (daily.selectedRun !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["selectedRun"],
        message: "A successful daily attempt requires one selected run",
      });
    }
    if (daily.selectedRun !== null && daily.selectedRun.selectedAtSec > daily.updatedAtSec) {
      ctx.addIssue({
        code: "custom",
        path: ["selectedRun", "selectedAtSec"],
        message: "Selected run cannot postdate the daily update",
      });
    }
    if (daily.latestError !== null && daily.latestError.atSec > daily.updatedAtSec) {
      ctx.addIssue({
        code: "custom",
        path: ["latestError", "atSec"],
        message: "Latest error cannot postdate the daily update",
      });
    }
  });
export type SafetyScoreV9ShadowDaily = z.infer<typeof SafetyScoreV9ShadowDailySchema>;

/** Coverage-floor ID proving the day's selected run started inside the preregistered 00:30–01:30 UTC window. */
export const SAFETY_SCORE_V9_SHADOW_START_LATENCY_FLOOR_ID = "scheduled-start-latency";

function selectedRunStartedInWindow(selectedRun: SafetyScoreV9ShadowSelectedRun): boolean {
  return selectedRun.coverage.coverageFloors.some(
    (floor) => floor.id === SAFETY_SCORE_V9_SHADOW_START_LATENCY_FLOOR_ID && floor.status === "pass",
  );
}

/**
 * Latest same-day success time derivable from the compact daily row. A failed
 * attempt stamps latestError.atSec === updatedAtSec, so any row whose latest
 * activity was a success has updatedAtSec ahead of its latest error. Pinned
 * rows keep their in-window selected run while refreshes advance updatedAtSec,
 * which is exactly the signal the refresh throttle needs.
 */
export function safetyScoreV9ShadowLastSuccessfulAttemptAtSec(daily: SafetyScoreV9ShadowDaily): number | null {
  const parsed = SafetyScoreV9ShadowDailySchema.parse(daily);
  if (parsed.selectedRun === null) return null;
  if (parsed.latestError !== null && parsed.latestError.atSec >= parsed.updatedAtSec) {
    return parsed.selectedRun.selectedAtSec;
  }
  return parsed.updatedAtSec;
}

function selectedRunIdentity(envelope: SafetyScoreV9ShadowEnvelope): SafetyScoreV9ShadowIdentity {
  const candidate = envelope.candidate;
  return SafetyScoreV9ShadowIdentitySchema.parse({
    candidateId: candidate.candidateId,
    policyVersion: candidate.policyVersion,
    publicationGenerationId: candidate.publicationGenerationId,
    baseInputGenerationId: candidate.baseInputGenerationId,
    factSetDigest: candidate.factSetDigest,
    policyId: candidate.policy.id,
    policyDigest: candidate.policy.semanticDigest,
    evaluationBuildDigest: candidate.evaluationBuildDigest,
    resultDigest: candidate.resultDigest,
    compilerFactSchemaDigest: envelope.compilerFactSchemaDigest,
    producerCapabilityDigest: envelope.producerCapabilityDigest,
    releaseCoveragePolicyDigest: envelope.releaseCoveragePolicyDigest,
    consumerThresholdRegistryDigest: envelope.consumerThresholdRegistryDigest,
    envelopeDigest: computeSafetyScoreV9ShadowEnvelopeDigest(envelope),
    sourceGenerations: Object.fromEntries(
      Object.entries(candidate.sourceGenerations).sort(([left], [right]) => compareText(left, right)),
    ),
  });
}

function assertDailyPredecessor(
  previous: SafetyScoreV9ShadowDaily | null | undefined,
  utcDay: string,
  updatedAtSec: number,
): SafetyScoreV9ShadowDaily | null {
  if (previous == null) return null;
  const parsed = SafetyScoreV9ShadowDailySchema.parse(previous);
  if (parsed.utcDay !== utcDay) throw new Error("Safety Score v9 daily update cannot cross UTC days");
  if (updatedAtSec < parsed.updatedAtSec) throw new Error("Safety Score v9 daily update cannot move backward");
  return parsed;
}

export function buildSafetyScoreV9ShadowDailySuccess(input: {
  utcDay: string;
  selectedAtSec: number;
  updatedAtSec: number;
  previous?: SafetyScoreV9ShadowDaily | null;
  envelope: SafetyScoreV9ShadowEnvelope;
  diff: SafetyScoreV9DiffReport;
  archiveSelectionReasons?: readonly SafetyScoreV9ShadowArchiveSelectionReason[];
  artifactKeys?: readonly string[];
}): SafetyScoreV9ShadowDaily {
  const previous = assertDailyPredecessor(input.previous, input.utcDay, input.updatedAtSec);
  // Intra-day refreshes re-select while no in-window run exists: the day's
  // selected run is the LATEST success, so the compact daily row, the retained
  // latest candidate/diff rows, and any evidence-day artifacts stay coherent
  // while the candidate iterates during the day. The gate still counts the day
  // once. A re-selection older than the current selected run fails closed.
  if (
    previous?.selectedRun !== null &&
    previous?.selectedRun !== undefined &&
    input.selectedAtSec < previous.selectedRun.selectedAtSec
  ) {
    throw new Error("Safety Score v9 daily re-selection cannot move the selected run backwards");
  }
  const envelope = SafetyScoreV9ShadowEnvelopeSchema.parse(input.envelope);
  const diff = SafetyScoreV9DiffReportSchema.parse(input.diff);
  const identity = selectedRunIdentity(envelope);
  if (
    diff.v9Identity.candidateId !== identity.candidateId ||
    diff.v9Identity.policyVersion !== identity.policyVersion ||
    diff.v9Identity.publicationGenerationId !== identity.publicationGenerationId ||
    diff.v9Identity.baseInputGenerationId !== identity.baseInputGenerationId ||
    diff.v9Identity.factSetDigest !== identity.factSetDigest ||
    diff.v9Identity.policyId !== identity.policyId ||
    diff.v9Identity.policyDigest !== identity.policyDigest ||
    diff.v9Identity.evaluationBuildDigest !== identity.evaluationBuildDigest ||
    diff.v9Identity.resultDigest !== identity.resultDigest
  ) {
    throw new Error("Safety Score v9 daily diff identity does not match the selected candidate");
  }
  // Start-latency pin: once the day has a selected success whose own
  // scheduled-start-latency floor passes (the preregistered 00:30-01:30 UTC
  // start window), that EARLIEST in-window run stays selected for the rest of
  // the UTC day. Later refreshes still record attempts and advance the daily
  // metadata, but they must not steal selection, because re-selecting a late
  // run is what made every day's selected run fail the start-latency floor.
  if (previous?.selectedRun !== null && previous?.selectedRun !== undefined && selectedRunStartedInWindow(previous.selectedRun)) {
    if ((input.archiveSelectionReasons?.length ?? 0) > 0 || (input.artifactKeys?.length ?? 0) > 0) {
      throw new Error("Safety Score v9 archive evidence requires the attempt to become the day's selected run");
    }
    return SafetyScoreV9ShadowDailySchema.parse({
      schemaVersion: SAFETY_SCORE_V9_SHADOW_SCHEMA_VERSION,
      utcDay: input.utcDay,
      updatedAtSec: input.updatedAtSec,
      attemptCounts: {
        successful: previous.attemptCounts.successful + 1,
        failed: previous.attemptCounts.failed,
      },
      selectedRun: previous.selectedRun,
      latestError: previous.latestError,
    });
  }
  return SafetyScoreV9ShadowDailySchema.parse({
    schemaVersion: SAFETY_SCORE_V9_SHADOW_SCHEMA_VERSION,
    utcDay: input.utcDay,
    updatedAtSec: input.updatedAtSec,
    attemptCounts: {
      successful: (previous?.attemptCounts.successful ?? 0) + 1,
      failed: previous?.attemptCounts.failed ?? 0,
    },
    selectedRun: {
      selectedAtSec: input.selectedAtSec,
      identity,
      coverage: envelope.coverage,
      movement: diff.summary,
      qualification: assessSafetyScoreV9ShadowQualification(envelope),
      diffReportDigest: diff.reportDigest,
      archiveSelectionReasons: sortedUnique(input.archiveSelectionReasons ?? []),
      artifactKeys: sortedUnique(input.artifactKeys ?? []),
    },
    latestError: previous?.latestError ?? null,
  });
}

export function buildSafetyScoreV9ShadowDailyFailure(input: {
  utcDay: string;
  updatedAtSec: number;
  previous?: SafetyScoreV9ShadowDaily | null;
  failure: {
    atSec: number;
    stage: SafetyScoreV9ShadowFailureStage;
    code: string;
    message: string;
  };
}): SafetyScoreV9ShadowDaily {
  const previous = assertDailyPredecessor(input.previous, input.utcDay, input.updatedAtSec);
  return SafetyScoreV9ShadowDailySchema.parse({
    schemaVersion: SAFETY_SCORE_V9_SHADOW_SCHEMA_VERSION,
    utcDay: input.utcDay,
    updatedAtSec: input.updatedAtSec,
    attemptCounts: {
      successful: previous?.attemptCounts.successful ?? 0,
      failed: (previous?.attemptCounts.failed ?? 0) + 1,
    },
    selectedRun: previous?.selectedRun ?? null,
    latestError: input.failure,
  });
}
