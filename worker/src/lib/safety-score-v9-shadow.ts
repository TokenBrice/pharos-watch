import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { ReportCardGradeSchema } from "@shared/types/report-cards";
import { SafetyScoreV9ResponseSchema, type SafetyScoreV9Response } from "@shared/types/safety-score-v9-public";
import {
  SafetyScoreV9MovementReviewDispositionSchema,
  type SafetyScoreV9MovementReviewDisposition,
} from "@shared/types/safety-score-v9-review";
import { z } from "zod";

export const SAFETY_SCORE_V9_SHADOW_SCHEMA_VERSION = 1;
export const SAFETY_SCORE_V9_DIFF_ABSOLUTE_REVIEW_DELTA = 5;
export const SAFETY_SCORE_V9_DIFF_TOP_CUTOFF_REVIEW_DELTA = 2;

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

export function safetyScoreV9ActiveIdsDigest(ids: readonly string[]): string {
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

export const SafetyScoreV9CoverageFloorSchema = z
  .object({
    id: NonEmptyTextSchema,
    status: z.enum(["pass", "fail"]),
    observed: z.number().finite().nullable(),
    required: NonEmptyTextSchema,
    detail: NonEmptyTextSchema,
  })
  .strict();
export type SafetyScoreV9CoverageFloor = z.infer<typeof SafetyScoreV9CoverageFloorSchema>;

export const SafetyScoreV9ShadowCoverageSchema = z
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

export const SafetyScoreV9ShadowQualificationBlockerSchema = z.enum([
  "active-id-bijection-failed",
  "compiler-exception",
  "future-dated-evidence",
  "coverage-floor-failed",
  "replay-artifact-missing",
  "replay-artifact-unverified",
  "publication-regression",
  "unresolved-release-blocker",
  "unresolved-critical-movement",
]);
export type SafetyScoreV9ShadowQualificationBlocker = z.infer<typeof SafetyScoreV9ShadowQualificationBlockerSchema>;

export const SafetyScoreV9ShadowQualificationSchema = z
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
  const requiredArtifactKinds = SafetyScoreV9ReplayArtifactKindSchema.options;
  const artifactsByKind = new Map(envelope.replayArtifacts.map((artifact) => [artifact.kind, artifact]));
  if (requiredArtifactKinds.some((kind) => !artifactsByKind.has(kind))) {
    blockers.add("replay-artifact-missing");
  }
  if (requiredArtifactKinds.some((kind) => artifactsByKind.get(kind)?.verification.status !== "verified")) {
    blockers.add("replay-artifact-unverified");
  }
  if (coverage.publicationRegression) blockers.add("publication-regression");
  if (coverage.unresolvedReleaseBlockers.length > 0) {
    blockers.add("unresolved-release-blocker");
  }
  if (coverage.unresolvedCriticalMovementIds.length > 0) {
    blockers.add("unresolved-critical-movement");
  }
  const canonicalBlockers = [...blockers].sort(compareText);
  return SafetyScoreV9ShadowQualificationSchema.parse({
    qualifies: canonicalBlockers.length === 0,
    blockers: canonicalBlockers,
  });
}

export function computeSafetyScoreV9ShadowEnvelopeDigest(envelope: SafetyScoreV9ShadowEnvelope): string {
  return sha256Hex(
    stableJsonStringifyV1({
      domain: "safety-score-v9.shadow-envelope.v1",
      envelope: SafetyScoreV9ShadowEnvelopeSchema.parse(envelope),
    }),
  );
}

const SafetyScoreV9ShadowAttemptIdentitySchema = z
  .object({
    candidateId: NonEmptyTextSchema,
    policyVersion: NonEmptyTextSchema,
    publicationGenerationId: NonEmptyTextSchema,
    publicationEpoch: z.number().int().nonnegative(),
    baseInputGenerationId: BaseInputGenerationIdSchema,
    factSetDigest: Sha256Schema,
    policyId: NonEmptyTextSchema,
    policyDigest: Sha256Schema,
    evaluationBuildDigest: Sha256Schema,
    resultDigest: Sha256Schema,
    compilerFactSchemaDigest: Sha256Schema,
    producerCapabilityDigest: Sha256Schema,
    envelopeDigest: Sha256Schema,
    sourceGenerations: z.record(NonEmptyTextSchema, NonEmptyTextSchema),
  })
  .strict();

const SafetyScoreV9ShadowAttemptFailureSchema = z
  .object({
    stage: z.enum([
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
    ]),
    code: NonEmptyTextSchema,
    message: NonEmptyTextSchema,
  })
  .strict();

export const SafetyScoreV9ShadowAttemptSchema = z
  .object({
    schemaVersion: z.literal(SAFETY_SCORE_V9_SHADOW_SCHEMA_VERSION),
    attemptId: NonEmptyTextSchema,
    trigger: z.enum(["scheduled", "retry"]),
    retryOfAttemptId: NonEmptyTextSchema.nullable(),
    scheduledForSec: UnixSecondsSchema,
    utcDay: UtcDaySchema,
    startedAtSec: UnixSecondsSchema.nullable(),
    completedAtSec: UnixSecondsSchema.nullable(),
    recordedAtSec: UnixSecondsSchema,
    outcome: z.enum(["missed", "aborted", "failed", "succeeded"]),
    identity: SafetyScoreV9ShadowAttemptIdentitySchema.nullable(),
    qualification: SafetyScoreV9ShadowQualificationSchema.nullable(),
    failure: SafetyScoreV9ShadowAttemptFailureSchema.nullable(),
  })
  .strict()
  .superRefine((attempt, ctx) => {
    if (attempt.utcDay !== safetyScoreV9UtcDay(attempt.scheduledForSec)) {
      ctx.addIssue({
        code: "custom",
        path: ["utcDay"],
        message: "Attempt UTC day must derive from its scheduled time",
      });
    }
    if ((attempt.trigger === "retry") !== (attempt.retryOfAttemptId !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["retryOfAttemptId"],
        message: "Retry attempts require one parent attempt",
      });
    }
    if (
      attempt.startedAtSec !== null &&
      attempt.completedAtSec !== null &&
      attempt.completedAtSec < attempt.startedAtSec
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["completedAtSec"],
        message: "Attempt completion cannot predate its start",
      });
    }
    if (attempt.completedAtSec !== null && attempt.recordedAtSec < attempt.completedAtSec) {
      ctx.addIssue({
        code: "custom",
        path: ["recordedAtSec"],
        message: "Attempt record cannot predate completion",
      });
    }
    if (attempt.outcome === "succeeded") {
      if (
        attempt.startedAtSec === null ||
        attempt.completedAtSec === null ||
        attempt.identity === null ||
        attempt.qualification === null ||
        attempt.failure !== null
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["outcome"],
          message: "Successful attempts require timing, identity, and qualification without failure",
        });
      }
    } else {
      if (attempt.identity !== null || attempt.qualification !== null || attempt.failure === null) {
        ctx.addIssue({
          code: "custom",
          path: ["outcome"],
          message: "Non-successful attempts require one failure and no candidate identity",
        });
      }
      if (attempt.outcome === "missed" && (attempt.startedAtSec !== null || attempt.completedAtSec !== null)) {
        ctx.addIssue({
          code: "custom",
          path: ["startedAtSec"],
          message: "Missed attempts cannot claim execution timing",
        });
      }
    }
  });
export type SafetyScoreV9ShadowAttempt = z.infer<typeof SafetyScoreV9ShadowAttemptSchema>;

interface SafetyScoreV9ShadowAttemptBaseInput {
  attemptId: string;
  trigger: "scheduled" | "retry";
  retryOfAttemptId: string | null;
  scheduledForSec: number;
  recordedAtSec: number;
}

export type BuildSafetyScoreV9ShadowAttemptInput =
  | (SafetyScoreV9ShadowAttemptBaseInput & {
      outcome: "succeeded";
      startedAtSec: number;
      completedAtSec: number;
      envelope: SafetyScoreV9ShadowEnvelope;
    })
  | (SafetyScoreV9ShadowAttemptBaseInput & {
      outcome: "missed" | "aborted" | "failed";
      startedAtSec: number | null;
      completedAtSec: number | null;
      failure: z.infer<typeof SafetyScoreV9ShadowAttemptFailureSchema>;
    });

export function buildSafetyScoreV9ShadowAttempt(
  input: BuildSafetyScoreV9ShadowAttemptInput,
): SafetyScoreV9ShadowAttempt {
  if (input.outcome === "succeeded") {
    const envelope = SafetyScoreV9ShadowEnvelopeSchema.parse(input.envelope);
    const candidate = envelope.candidate;
    return SafetyScoreV9ShadowAttemptSchema.parse({
      schemaVersion: SAFETY_SCORE_V9_SHADOW_SCHEMA_VERSION,
      attemptId: input.attemptId,
      trigger: input.trigger,
      retryOfAttemptId: input.retryOfAttemptId,
      scheduledForSec: input.scheduledForSec,
      utcDay: safetyScoreV9UtcDay(input.scheduledForSec),
      startedAtSec: input.startedAtSec,
      completedAtSec: input.completedAtSec,
      recordedAtSec: input.recordedAtSec,
      outcome: input.outcome,
      identity: {
        candidateId: candidate.candidateId,
        policyVersion: candidate.policyVersion,
        publicationGenerationId: candidate.publicationGenerationId,
        publicationEpoch: candidate.publicationEpoch,
        baseInputGenerationId: candidate.baseInputGenerationId,
        factSetDigest: candidate.factSetDigest,
        policyId: candidate.policy.id,
        policyDigest: candidate.policy.semanticDigest,
        evaluationBuildDigest: candidate.evaluationBuildDigest,
        resultDigest: candidate.resultDigest,
        compilerFactSchemaDigest: envelope.compilerFactSchemaDigest,
        producerCapabilityDigest: envelope.producerCapabilityDigest,
        envelopeDigest: computeSafetyScoreV9ShadowEnvelopeDigest(envelope),
        sourceGenerations: Object.fromEntries(
          Object.entries(candidate.sourceGenerations).sort(([left], [right]) => compareText(left, right)),
        ),
      },
      qualification: assessSafetyScoreV9ShadowQualification(envelope),
      failure: null,
    });
  }

  return SafetyScoreV9ShadowAttemptSchema.parse({
    schemaVersion: SAFETY_SCORE_V9_SHADOW_SCHEMA_VERSION,
    attemptId: input.attemptId,
    trigger: input.trigger,
    retryOfAttemptId: input.retryOfAttemptId,
    scheduledForSec: input.scheduledForSec,
    utcDay: safetyScoreV9UtcDay(input.scheduledForSec),
    startedAtSec: input.startedAtSec,
    completedAtSec: input.completedAtSec,
    recordedAtSec: input.recordedAtSec,
    outcome: input.outcome,
    identity: null,
    qualification: null,
    failure: input.failure,
  });
}

export const SafetyScoreV9ShadowDayBlockerSchema = z.enum([
  "expected-scheduled-attempt-missing",
  "unexpected-scheduled-attempt",
  "attempt-missed",
  "attempt-aborted",
  "attempt-failed",
  "generation-nonqualifying",
  "qualifying-generation-missing",
]);

const SafetyScoreV9ShadowDayProjectionSchema = z
  .object({
    expectedScheduledAttemptIds: z.array(NonEmptyTextSchema),
    missingScheduledAttemptIds: z.array(NonEmptyTextSchema),
    unexpectedScheduledAttemptIds: z.array(NonEmptyTextSchema),
    outcomeCounts: z
      .object({
        missed: z.number().int().nonnegative(),
        aborted: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        succeeded: z.number().int().nonnegative(),
      })
      .strict(),
    canonicalQualifyingGenerationId: NonEmptyTextSchema.nullable(),
    blockingAttemptIds: z.array(NonEmptyTextSchema),
    blockers: z.array(SafetyScoreV9ShadowDayBlockerSchema),
    qualifies: z.boolean(),
  })
  .strict();

export const SafetyScoreV9ShadowDaySchema = z
  .object({
    schemaVersion: z.literal(SAFETY_SCORE_V9_SHADOW_SCHEMA_VERSION),
    utcDay: UtcDaySchema,
    attempts: z.array(SafetyScoreV9ShadowAttemptSchema),
    projection: SafetyScoreV9ShadowDayProjectionSchema,
  })
  .strict()
  .superRefine((day, ctx) => {
    addCanonicalArrayIssue(day.projection.expectedScheduledAttemptIds, ctx, [
      "projection",
      "expectedScheduledAttemptIds",
    ]);
    const attemptIds = day.attempts.map((attempt) => attempt.attemptId);
    if (new Set(attemptIds).size !== attemptIds.length) {
      ctx.addIssue({ code: "custom", path: ["attempts"], message: "Attempt IDs must be unique" });
    }
    for (const [index, attempt] of day.attempts.entries()) {
      if (attempt.utcDay !== day.utcDay) {
        ctx.addIssue({
          code: "custom",
          path: ["attempts", index, "utcDay"],
          message: "Every attempt must belong to the history UTC day",
        });
      }
      if (attempt.retryOfAttemptId !== null && !attemptIds.includes(attempt.retryOfAttemptId)) {
        ctx.addIssue({
          code: "custom",
          path: ["attempts", index, "retryOfAttemptId"],
          message: "Retry parent must be present in the same daily history",
        });
      }
    }
    const derived = deriveSafetyScoreV9ShadowDayProjection(day.projection.expectedScheduledAttemptIds, day.attempts);
    if (stableJsonStringifyV1(day.projection) !== stableJsonStringifyV1(derived)) {
      ctx.addIssue({
        code: "custom",
        path: ["projection"],
        message: "Daily shadow projection does not match its attempts",
      });
    }
  });
export type SafetyScoreV9ShadowDay = z.infer<typeof SafetyScoreV9ShadowDaySchema>;

function deriveSafetyScoreV9ShadowDayProjection(
  expectedScheduledAttemptIdsInput: readonly string[],
  attempts: readonly SafetyScoreV9ShadowAttempt[],
): z.infer<typeof SafetyScoreV9ShadowDayProjectionSchema> {
  const expectedScheduledAttemptIds = sortedUnique(expectedScheduledAttemptIdsInput);
  const expectedSet = new Set(expectedScheduledAttemptIds);
  const actualScheduledIds = sortedUnique(
    attempts.filter((attempt) => attempt.trigger === "scheduled").map((attempt) => attempt.attemptId),
  );
  const actualSet = new Set(actualScheduledIds);
  const missingScheduledAttemptIds = expectedScheduledAttemptIds.filter((id) => !actualSet.has(id));
  const unexpectedScheduledAttemptIds = actualScheduledIds.filter((id) => !expectedSet.has(id));
  const outcomeCounts = { missed: 0, aborted: 0, failed: 0, succeeded: 0 };
  const blockers = new Set<z.infer<typeof SafetyScoreV9ShadowDayBlockerSchema>>();
  const blockingAttemptIds = new Set<string>();

  if (missingScheduledAttemptIds.length > 0) blockers.add("expected-scheduled-attempt-missing");
  if (unexpectedScheduledAttemptIds.length > 0) blockers.add("unexpected-scheduled-attempt");
  const qualifyingAttempts: SafetyScoreV9ShadowAttempt[] = [];
  for (const attempt of attempts) {
    outcomeCounts[attempt.outcome] += 1;
    if (attempt.outcome === "succeeded") {
      if (attempt.qualification?.qualifies) {
        qualifyingAttempts.push(attempt);
      } else {
        blockers.add("generation-nonqualifying");
        blockingAttemptIds.add(attempt.attemptId);
      }
    } else {
      blockers.add(
        attempt.outcome === "missed"
          ? "attempt-missed"
          : attempt.outcome === "aborted"
            ? "attempt-aborted"
            : "attempt-failed",
      );
      blockingAttemptIds.add(attempt.attemptId);
    }
  }
  qualifyingAttempts.sort(
    (left, right) =>
      (left.completedAtSec ?? Number.MAX_SAFE_INTEGER) - (right.completedAtSec ?? Number.MAX_SAFE_INTEGER) ||
      compareText(left.identity?.publicationGenerationId ?? "", right.identity?.publicationGenerationId ?? ""),
  );
  const canonicalQualifyingGenerationId = qualifyingAttempts[0]?.identity?.publicationGenerationId ?? null;
  if (canonicalQualifyingGenerationId === null) blockers.add("qualifying-generation-missing");
  const canonicalBlockers = [...blockers].sort(compareText);

  return {
    expectedScheduledAttemptIds,
    missingScheduledAttemptIds,
    unexpectedScheduledAttemptIds,
    outcomeCounts,
    canonicalQualifyingGenerationId,
    blockingAttemptIds: [...blockingAttemptIds].sort(compareText),
    blockers: canonicalBlockers,
    qualifies: canonicalBlockers.length === 0,
  };
}

export function buildSafetyScoreV9ShadowDay(input: {
  utcDay: string;
  expectedScheduledAttemptIds: readonly string[];
  attempts: readonly SafetyScoreV9ShadowAttempt[];
}): SafetyScoreV9ShadowDay {
  const attempts = input.attempts
    .map((attempt) => SafetyScoreV9ShadowAttemptSchema.parse(attempt))
    .sort(
      (left, right) =>
        left.scheduledForSec - right.scheduledForSec ||
        (left.startedAtSec ?? Number.MAX_SAFE_INTEGER) - (right.startedAtSec ?? Number.MAX_SAFE_INTEGER) ||
        compareText(left.attemptId, right.attemptId),
    );
  return SafetyScoreV9ShadowDaySchema.parse({
    schemaVersion: SAFETY_SCORE_V9_SHADOW_SCHEMA_VERSION,
    utcDay: input.utcDay,
    attempts,
    projection: deriveSafetyScoreV9ShadowDayProjection(input.expectedScheduledAttemptIds, attempts),
  });
}

export const SafetyScoreV9DiffReviewDispositionSchema = SafetyScoreV9MovementReviewDispositionSchema;
export type SafetyScoreV9DiffReviewDisposition = SafetyScoreV9MovementReviewDisposition;

export const SafetyScoreV8ComparableCardSchema = z
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

export const SafetyScoreV8ComparableSnapshotSchema = z
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

export const SafetyScoreV9DownstreamThresholdSchema = z
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

export const SafetyScoreV9DiffCardSchema = SafetyScoreV9DiffMovementSchema.extend({
  review: z
    .object({
      key: Sha256Schema.nullable(),
      status: z.enum(["not-required", "pending", "classified"]),
      disposition: SafetyScoreV9DiffReviewDispositionSchema.nullable(),
    })
    .strict(),
})
  .strict()
  .superRefine((card, ctx) => {
    if (!card.flags.requiresReview) {
      if (card.review.key !== null || card.review.status !== "not-required" || card.review.disposition !== null) {
        ctx.addIssue({ code: "custom", path: ["review"], message: "Non-material movements cannot carry a review" });
      }
      return;
    }
    if (card.review.key === null || card.review.status === "not-required") {
      ctx.addIssue({ code: "custom", path: ["review"], message: "Material movements require a review key" });
    }
    if ((card.review.status === "classified") !== (card.review.disposition !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["review", "disposition"],
        message: "Classified review status must agree with its disposition",
      });
    }
  });
export type SafetyScoreV9DiffCard = z.infer<typeof SafetyScoreV9DiffCardSchema>;

export function computeSafetyScoreV9DiffReviewKey(input: {
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
    v9Identity: SafetyScoreV9ShadowAttemptIdentitySchema.omit({
      compilerFactSchemaDigest: true,
      producerCapabilityDigest: true,
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
    summary: z
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
      .strict(),
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

export function computeSafetyScoreV9DiffReportDigest(report: SafetyScoreV9DiffReportPayload): string {
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
    const reviewKey = requiresReview
      ? computeSafetyScoreV9DiffReviewKey({
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
          movement,
        })
      : null;
    const disposition = reviewKey ? (input.reviewDispositionsByKey?.[reviewKey] ?? null) : null;
    return SafetyScoreV9DiffCardSchema.parse({
      ...movement,
      review: {
        key: reviewKey,
        status: !requiresReview ? "not-required" : disposition ? "classified" : "pending",
        disposition,
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
      publicationEpoch: v9.candidate.publicationEpoch,
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
