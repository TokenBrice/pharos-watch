import { SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST } from "@shared/data/safety-score-v9/evaluation-build-manifest-v1";
import { V9_HOLDOUT_VALIDATION_REPORT_DIGEST_DOMAIN } from "@shared/lib/safety-score-v9/validation";
import { V9_RELEASE_COVERAGE_REPORT_DIGEST_DOMAIN } from "@shared/lib/safety-score-v9/coverage";
import { computeV9ReleaseCandidateSealDigest } from "@shared/lib/safety-score-v9/validation";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  V9ReleaseCoverageReportV1Schema,
  type V9ReleaseCoverageReportV1,
} from "@shared/types/safety-score-v9-coverage";
import {
  V9HistoricalHoldoutValidationReportSchema,
  V9ReleaseCandidateSealPayloadSchema,
  V9ReleaseCandidateSealSchema,
  type V9HistoricalHoldoutValidationReport,
  type V9ReleaseCandidateSeal,
} from "@shared/types/safety-score-v9-validation";
import { z } from "zod";
import {
  SafetyScoreV9ShadowDaySchema,
  type SafetyScoreV9ShadowAttempt,
  type SafetyScoreV9ShadowDay,
} from "./safety-score-v9-shadow";

export const SAFETY_SCORE_V9_RELEASE_WINDOW_DAYS = 30;
export const SAFETY_SCORE_V9_RELEASE_WINDOW_SCHEMA_VERSION = 2;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const UtcDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const NonEmptyTextSchema = z.string().trim().min(1);

export const SafetyScoreV9ReleaseWindowBlockerCodeSchema = z.enum([
  "candidate-seal-missing",
  "candidate-seal-invalid",
  "candidate-seal-digest-mismatch",
  "historical-validation-missing",
  "historical-validation-invalid",
  "historical-validation-digest-mismatch",
  "independent-validation-not-passed",
  "release-coverage-missing",
  "release-coverage-invalid",
  "release-coverage-digest-mismatch",
  "release-coverage-not-passed",
  "release-evidence-identity-mismatch",
  "release-snapshot-identity-mismatch",
  "policy-not-frozen",
  "evaluation-build-not-locked",
  "day-count-mismatch",
  "duplicate-day",
  "calendar-gap",
  "day-nonqualifying",
  "canonical-attempt-missing",
  "release-candidate-mismatch",
  "policy-version-drift",
  "policy-id-drift",
  "policy-digest-drift",
  "evaluation-build-drift",
  "compiler-fact-schema-drift",
  "producer-capability-drift",
  "publication-epoch-drift",
]);
export type SafetyScoreV9ReleaseWindowBlockerCode = z.infer<
  typeof SafetyScoreV9ReleaseWindowBlockerCodeSchema
>;

export const SafetyScoreV9ReleaseWindowIdentitySchema = z
  .object({
    candidateId: z.string().regex(/^v9-rc-[1-9][0-9]*$/),
    policyVersion: NonEmptyTextSchema,
    policyId: NonEmptyTextSchema,
    policyDigest: Sha256Schema,
    evaluationBuildDigest: Sha256Schema,
    compilerFactSchemaDigest: Sha256Schema,
    producerCapabilityDigest: Sha256Schema,
    publicationEpoch: z.number().int().nonnegative(),
    candidateSealDigest: Sha256Schema,
    historicalValidationReportDigest: Sha256Schema,
    releaseCoverageReportDigest: Sha256Schema,
  })
  .strict();
export type SafetyScoreV9ReleaseWindowIdentity = z.infer<
  typeof SafetyScoreV9ReleaseWindowIdentitySchema
>;

export interface SafetyScoreV9ReleaseEvidenceInput {
  candidateSeal: unknown | null;
  historicalValidationReport: unknown | null;
  /** Canonical, digest-bound series with one exact coverage report per counted UTC day. */
  releaseCoverageReport: unknown | null;
}

const SafetyScoreV9DailyCoverageEntrySchema = z
  .object({
    utcDay: UtcDaySchema,
    report: V9ReleaseCoverageReportV1Schema,
  })
  .strict();

const SafetyScoreV9DailyCoverageSeriesPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    releaseCandidateId: z.string().regex(/^v9-rc-[1-9][0-9]*$/),
    entries: z.array(SafetyScoreV9DailyCoverageEntrySchema).length(SAFETY_SCORE_V9_RELEASE_WINDOW_DAYS),
  })
  .strict();

export type SafetyScoreV9DailyCoverageSeriesPayload = z.infer<
  typeof SafetyScoreV9DailyCoverageSeriesPayloadSchema
>;

export function computeSafetyScoreV9DailyCoverageSeriesDigest(
  payload: SafetyScoreV9DailyCoverageSeriesPayload,
): string {
  return sha256Hex(
    stableJsonStringifyV1({
      domain: "safety-score-v9.daily-release-coverage-series.v1",
      series: SafetyScoreV9DailyCoverageSeriesPayloadSchema.parse(payload),
    }),
  );
}

export const SafetyScoreV9DailyCoverageSeriesSchema =
  SafetyScoreV9DailyCoverageSeriesPayloadSchema.extend({ seriesDigest: Sha256Schema })
    .strict()
    .superRefine((series, ctx) => {
      const { seriesDigest: _seriesDigest, ...payload } = series;
      if (series.seriesDigest !== computeSafetyScoreV9DailyCoverageSeriesDigest(payload)) {
        ctx.addIssue({ code: "custom", path: ["seriesDigest"], message: "Daily coverage series digest mismatch" });
      }
      for (let index = 0; index < series.entries.length; index += 1) {
        const entry = series.entries[index]!;
        if (index > 0 && entry.utcDay !== nextUtcDay(series.entries[index - 1]!.utcDay)) {
          ctx.addIssue({
            code: "custom",
            path: ["entries", index, "utcDay"],
            message: "Daily coverage entries must be consecutive and canonically ordered",
          });
        }
        if (entry.report.releaseCandidateId !== series.releaseCandidateId) {
          ctx.addIssue({
            code: "custom",
            path: ["entries", index, "report", "releaseCandidateId"],
            message: "Daily coverage report candidate does not match the series",
          });
        }
      }
    });
export type SafetyScoreV9DailyCoverageSeries = z.infer<
  typeof SafetyScoreV9DailyCoverageSeriesSchema
>;

const SafetyScoreV9ReleaseWindowBlockerSchema = z
  .object({
    code: SafetyScoreV9ReleaseWindowBlockerCodeSchema,
    utcDay: UtcDaySchema.nullable(),
    detail: NonEmptyTextSchema,
  })
  .strict();
export type SafetyScoreV9ReleaseWindowBlocker = z.infer<
  typeof SafetyScoreV9ReleaseWindowBlockerSchema
>;

const SafetyScoreV9ReleaseWindowDaySchema = z
  .object({
    utcDay: UtcDaySchema,
    dayDigest: Sha256Schema,
    qualifies: z.boolean(),
    canonicalAttemptId: NonEmptyTextSchema.nullable(),
    publicationGenerationId: NonEmptyTextSchema.nullable(),
    envelopeDigest: Sha256Schema.nullable(),
  })
  .strict();

const ReleasePrerequisitesSchema = z
  .object({
    candidateSealVerified: z.boolean(),
    policyFrozen: z.boolean(),
    evaluationBuildLocked: z.boolean(),
    independentValidationPassed: z.boolean(),
    releaseCoveragePassed: z.boolean(),
    evidenceIdentityCrossBound: z.boolean(),
  })
  .strict();

const ReleaseEvidenceDigestsSchema = z
  .object({
    candidateSealDigest: Sha256Schema.nullable(),
    historicalValidationReportDigest: Sha256Schema.nullable(),
    releaseCoverageReportDigest: Sha256Schema.nullable(),
  })
  .strict();

const SafetyScoreV9ReleaseWindowReportPayloadSchema = z
  .object({
    schemaVersion: z.literal(SAFETY_SCORE_V9_RELEASE_WINDOW_SCHEMA_VERSION),
    requiredDayCount: z.literal(SAFETY_SCORE_V9_RELEASE_WINDOW_DAYS),
    windowStartUtcDay: UtcDaySchema.nullable(),
    windowEndUtcDay: UtcDaySchema.nullable(),
    prerequisites: ReleasePrerequisitesSchema,
    evidenceDigests: ReleaseEvidenceDigestsSchema,
    identity: SafetyScoreV9ReleaseWindowIdentitySchema,
    decision: z.enum(["gate-passed", "no-go"]),
    days: z.array(SafetyScoreV9ReleaseWindowDaySchema),
    blockers: z.array(SafetyScoreV9ReleaseWindowBlockerSchema),
  })
  .strict();

export const SafetyScoreV9ReleaseWindowReportSchema =
  SafetyScoreV9ReleaseWindowReportPayloadSchema.extend({ reportDigest: Sha256Schema })
    .strict()
    .superRefine((report, ctx) => {
      const { reportDigest: _reportDigest, ...payload } = report;
      const expected = computeSafetyScoreV9ReleaseWindowReportDigest(payload);
      if (report.reportDigest !== expected) {
        ctx.addIssue({ code: "custom", path: ["reportDigest"], message: "Release-window digest mismatch" });
      }
      if ((report.decision === "gate-passed") !== (report.blockers.length === 0)) {
        ctx.addIssue({ code: "custom", path: ["decision"], message: "Decision must agree with blockers" });
      }
    });
export type SafetyScoreV9ReleaseWindowReport = z.infer<
  typeof SafetyScoreV9ReleaseWindowReportSchema
>;

type SafetyScoreV9ReleaseWindowReportPayload = z.infer<
  typeof SafetyScoreV9ReleaseWindowReportPayloadSchema
>;

export interface EvaluateSafetyScoreV9ReleaseWindowInput {
  identity: SafetyScoreV9ReleaseWindowIdentity;
  evidence: SafetyScoreV9ReleaseEvidenceInput;
  days: readonly SafetyScoreV9ShadowDay[];
}

export interface SafetyScoreV9ReleaseEvidenceAssessment {
  prerequisites: z.infer<typeof ReleasePrerequisitesSchema>;
  evidenceDigests: z.infer<typeof ReleaseEvidenceDigestsSchema>;
  blockers: SafetyScoreV9ReleaseWindowBlocker[];
  candidateSeal: V9ReleaseCandidateSeal | null;
  historicalValidationReport: V9HistoricalHoldoutValidationReport | null;
  releaseCoverageReport: SafetyScoreV9DailyCoverageSeries | null;
}

const REQUIRED_COVERAGE_IDENTITY_CHECKS = [
  "factSetDigest",
  "baseInputGenerationId",
  "policyId",
  "policyDigest",
  "evaluationBuildDigest",
  "producerCapabilityDigest",
  "evaluationBuildCurrent",
  "evaluatedSetDigest",
  "scoreResultDigest",
  "evaluationProjectionDigest",
  "registryDigest",
  "weightDigest",
  "asOf",
  "sourceGenerations",
] as const;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nextUtcDay(utcDay: string): string {
  const timestamp = Date.parse(`${utcDay}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid UTC day ${utcDay}`);
  return new Date(timestamp + 86_400_000).toISOString().slice(0, 10);
}

function canonicalAttempt(day: SafetyScoreV9ShadowDay): SafetyScoreV9ShadowAttempt | null {
  const generationId = day.projection.canonicalQualifyingGenerationId;
  if (generationId === null) return null;
  return (
    day.attempts.find(
      (attempt) =>
        attempt.outcome === "succeeded" &&
        attempt.qualification?.qualifies === true &&
        attempt.identity?.publicationGenerationId === generationId,
    ) ?? null
  );
}

function dayDigest(day: SafetyScoreV9ShadowDay): string {
  return sha256Hex(
    stableJsonStringifyV1({ domain: "safety-score-v9.shadow-day.v1", day }),
  );
}

export function computeV9HistoricalValidationReportDigest(
  reportInput: V9HistoricalHoldoutValidationReport,
): string {
  const report = V9HistoricalHoldoutValidationReportSchema.parse(reportInput);
  const { reportDigest: _reportDigest, ...payload } = report;
  return sha256Hex(
    stableJsonStringifyV1({ domain: V9_HOLDOUT_VALIDATION_REPORT_DIGEST_DOMAIN, report: payload }),
  );
}

export function computeV9ReleaseCoverageReportDigest(
  reportInput: V9ReleaseCoverageReportV1,
): string {
  const report = V9ReleaseCoverageReportV1Schema.parse(reportInput);
  const { reportDigest: _reportDigest, ...payload } = report;
  return sha256Hex(
    stableJsonStringifyV1({ domain: V9_RELEASE_COVERAGE_REPORT_DIGEST_DOMAIN, report: payload }),
  );
}

function firstIssueDetail(result: { error: z.ZodError }, label: string): string {
  const issue = result.error.issues[0];
  return issue ? `${label}: ${issue.path.join(".") || "root"}: ${issue.message}` : `${label} is invalid.`;
}

/** Derive all external prerequisites from content-digested evidence. */
export function assessSafetyScoreV9ReleaseEvidence(
  identityInput: SafetyScoreV9ReleaseWindowIdentity,
  evidence: SafetyScoreV9ReleaseEvidenceInput,
): SafetyScoreV9ReleaseEvidenceAssessment {
  const identity = SafetyScoreV9ReleaseWindowIdentitySchema.parse(identityInput);
  const blockers: SafetyScoreV9ReleaseWindowBlocker[] = [];
  const add = (code: SafetyScoreV9ReleaseWindowBlockerCode, detail: string): void => {
    blockers.push({ code, utcDay: null, detail });
  };

  const sealResult = evidence.candidateSeal === null
    ? null
    : V9ReleaseCandidateSealSchema.safeParse(evidence.candidateSeal);
  const validationResult = evidence.historicalValidationReport === null
    ? null
    : V9HistoricalHoldoutValidationReportSchema.safeParse(evidence.historicalValidationReport);
  const coverageResult = evidence.releaseCoverageReport === null
    ? null
    : SafetyScoreV9DailyCoverageSeriesSchema.safeParse(evidence.releaseCoverageReport);

  if (sealResult === null) add("candidate-seal-missing", "No sealed release-candidate manifest is attached.");
  else if (!sealResult.success) add("candidate-seal-invalid", firstIssueDetail(sealResult, "Candidate seal"));
  if (validationResult === null) {
    add("historical-validation-missing", "No independently reviewed historical validation report is attached.");
  } else if (!validationResult.success) {
    add("historical-validation-invalid", firstIssueDetail(validationResult, "Historical validation report"));
  }
  if (coverageResult === null) add("release-coverage-missing", "No all-active release coverage report is attached.");
  else if (!coverageResult.success) add("release-coverage-invalid", firstIssueDetail(coverageResult, "Coverage report"));

  const seal = sealResult?.success ? sealResult.data : null;
  const validation = validationResult?.success ? validationResult.data : null;
  const coverage = coverageResult?.success ? coverageResult.data : null;
  const observedSealDigest = seal?.sealDigest ?? null;
  const observedValidationDigest = validation?.reportDigest ?? null;
  const observedCoverageDigest = coverage?.seriesDigest ?? null;

  const sealPayload = seal === null
    ? null
    : V9ReleaseCandidateSealPayloadSchema.parse(
        Object.fromEntries(Object.entries(seal).filter(([key]) => key !== "sealDigest")),
      );
  const sealDigestVerified =
    seal !== null &&
    sealPayload !== null &&
    seal.sealDigest === computeV9ReleaseCandidateSealDigest(sealPayload);
  if (seal !== null && !sealDigestVerified) {
    add("candidate-seal-digest-mismatch", "The release-candidate seal does not match its canonical payload.");
  }

  const validationDigestVerified =
    validation !== null && validation.reportDigest === computeV9HistoricalValidationReportDigest(validation);
  if (validation !== null && !validationDigestVerified) {
    add("historical-validation-digest-mismatch", "The historical validation report digest is forged or stale.");
  }

  const coverageDigestVerified =
    coverage !== null &&
    coverage.seriesDigest === identity.releaseCoverageReportDigest &&
    coverage.entries.every(
      (entry) => entry.report.reportDigest === computeV9ReleaseCoverageReportDigest(entry.report),
    );
  if (coverage !== null && !coverageDigestVerified) {
    add("release-coverage-digest-mismatch", "The daily release coverage series or one of its reports is forged or stale.");
  }

  const sealIdentityBound =
    seal !== null &&
    seal.releaseCandidateId === identity.candidateId &&
    seal.sealDigest === identity.candidateSealDigest &&
    seal.digests.policySemanticDigest === identity.policyDigest &&
    seal.digests.evaluationBuildDigest === identity.evaluationBuildDigest;
  const validationIdentityBound =
    seal !== null &&
    validation !== null &&
    validation.releaseCandidateId === identity.candidateId &&
    validation.releaseCandidateId === seal.releaseCandidateId &&
    validation.methodologyRoundId === seal.methodologyRoundId &&
    validation.holdoutId === seal.holdoutId &&
    validation.sealDigest === seal.sealDigest &&
    validation.reportDigest === identity.historicalValidationReportDigest &&
    validation.digests.factSetDigest === seal.digests.factSetDigest &&
    validation.digests.sourceArchiveDigest === seal.digests.sourceArchiveDigest &&
    validation.digests.policySemanticDigest === identity.policyDigest &&
    validation.digests.policySemanticDigest === seal.digests.policySemanticDigest &&
    validation.digests.evaluationBuildDigest === identity.evaluationBuildDigest &&
    validation.digests.evaluationBuildDigest === seal.digests.evaluationBuildDigest &&
    validation.digests.holdoutManifestDigest === seal.digests.holdoutManifestDigest &&
    validation.digests.outcomeSetDigest === seal.digests.outcomeCommitmentDigest &&
    stableJsonStringifyV1(validation.thresholds) === stableJsonStringifyV1(seal.thresholds);
  const coverageIdentityBound =
    coverage !== null &&
    coverage.releaseCandidateId === identity.candidateId &&
    coverage.seriesDigest === identity.releaseCoverageReportDigest &&
    coverage.entries.every(
      ({ report }) =>
        report.releaseCandidateId === identity.candidateId &&
        report.identities.policyId === identity.policyId &&
        report.identities.policyDigest === identity.policyDigest &&
        report.identities.evaluationBuildDigest === identity.evaluationBuildDigest &&
        report.identities.producerCapabilityDigest === identity.producerCapabilityDigest &&
        report.producerCapabilityDigest === identity.producerCapabilityDigest,
    );

  if ((seal !== null || validation !== null || coverage !== null) &&
      !(sealIdentityBound && validationIdentityBound && coverageIdentityBound)) {
    add(
      "release-evidence-identity-mismatch",
      "The seal, validation report, coverage report, and release-candidate identity are not fully cross-bound.",
    );
  }

  const policyFrozen = sealDigestVerified && sealIdentityBound;
  if (seal !== null && !policyFrozen) add("policy-not-frozen", "The sealed candidate does not bind the frozen policy.");
  const evaluationBuildLocked =
    identity.evaluationBuildDigest === SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST &&
    sealIdentityBound &&
    validationIdentityBound &&
    coverageIdentityBound;
  if (!evaluationBuildLocked) {
    add(
      "evaluation-build-not-locked",
      `The release evidence does not bind the current evaluation build ${SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST}.`,
    );
  }

  const validationChecksPassed =
    validation !== null &&
    Object.values(validation.bindings).every(Boolean) &&
    Object.values(validation.governance).every(Boolean);
  const independentValidationPassed =
    validationDigestVerified &&
    validationIdentityBound &&
    validationChecksPassed &&
    validation?.decision === "gate-passed" &&
    validation.noGoReasons.length === 0;
  if (validation !== null && !independentValidationPassed) {
    add(
      "independent-validation-not-passed",
      "The independently reviewed historical report is not a fully bound gate pass.",
    );
  }

  const coverageIdentityChecksPassed =
    coverage !== null &&
    coverage.entries.every(({ report }) =>
      REQUIRED_COVERAGE_IDENTITY_CHECKS.every((key) => report.identityChecks[key] === true),
    );
  const coverageFloorsPassed =
    coverage !== null &&
    coverage.entries.every(
      ({ report }) =>
        report.activeSet.exactBijection &&
        report.rateability.passed &&
        report.weights.passed &&
        report.topCutoff.passed &&
        report.calibration.passed &&
        report.nrReviews.passed &&
        report.exit.passed &&
        report.archetypes.every((entry) => entry.passed),
    );
  const releaseCoveragePassed =
    coverageDigestVerified &&
    coverageIdentityBound &&
    coverageIdentityChecksPassed &&
    coverageFloorsPassed &&
    coverage?.entries.every(
      ({ report }) => report.decision === "gate-passed" && report.blockers.length === 0,
    );
  if (coverage !== null && !releaseCoveragePassed) {
    add("release-coverage-not-passed", "The exact-identity release coverage report is not a full gate pass.");
  }

  const evidenceIdentityCrossBound = sealIdentityBound && validationIdentityBound && coverageIdentityBound;
  blockers.sort(
    (left, right) => compareText(left.code, right.code) || compareText(left.detail, right.detail),
  );
  return {
    prerequisites: {
      candidateSealVerified: sealDigestVerified,
      policyFrozen,
      evaluationBuildLocked,
      independentValidationPassed,
      releaseCoveragePassed,
      evidenceIdentityCrossBound,
    },
    evidenceDigests: {
      candidateSealDigest: observedSealDigest,
      historicalValidationReportDigest: observedValidationDigest,
      releaseCoverageReportDigest: observedCoverageDigest,
    },
    blockers,
    candidateSeal: seal,
    historicalValidationReport: validation,
    releaseCoverageReport: coverage,
  };
}

export function computeSafetyScoreV9ReleaseWindowReportDigest(
  payload: SafetyScoreV9ReleaseWindowReportPayload,
): string {
  return sha256Hex(
    stableJsonStringifyV1({
      domain: "safety-score-v9.release-window.v2",
      report: SafetyScoreV9ReleaseWindowReportPayloadSchema.parse(payload),
    }),
  );
}

/**
 * Evaluate a prospective window from schema-checked daily histories and the
 * actual sealed validation/coverage evidence. No caller-provided pass flag is
 * accepted by this boundary.
 */
export function evaluateSafetyScoreV9ReleaseWindow(
  input: EvaluateSafetyScoreV9ReleaseWindowInput,
): SafetyScoreV9ReleaseWindowReport {
  const identity = SafetyScoreV9ReleaseWindowIdentitySchema.parse(input.identity);
  const evidence = assessSafetyScoreV9ReleaseEvidence(identity, input.evidence);
  const parsedDays = input.days.map((day) => SafetyScoreV9ShadowDaySchema.parse(day));
  const days = [...parsedDays].sort((left, right) => compareText(left.utcDay, right.utcDay));
  const blockers: SafetyScoreV9ReleaseWindowReportPayload["blockers"] = [...evidence.blockers];
  const add = (
    code: SafetyScoreV9ReleaseWindowBlockerCode,
    detail: string,
    utcDay: string | null = null,
  ): void => {
    blockers.push({ code, utcDay, detail });
  };

  if (days.length !== SAFETY_SCORE_V9_RELEASE_WINDOW_DAYS) {
    add(
      "day-count-mismatch",
      `Expected ${SAFETY_SCORE_V9_RELEASE_WINDOW_DAYS} UTC days; received ${days.length}.`,
    );
  }
  if (new Set(days.map((day) => day.utcDay)).size !== days.length) {
    add("duplicate-day", "The release window contains duplicate UTC days.");
  }
  for (let index = 1; index < days.length; index += 1) {
    if (days[index]!.utcDay !== nextUtcDay(days[index - 1]!.utcDay)) {
      add(
        "calendar-gap",
        `Expected ${nextUtcDay(days[index - 1]!.utcDay)} after ${days[index - 1]!.utcDay}.`,
        days[index]!.utcDay,
      );
    }
  }

  const dayRows = days.map((day) => {
    const attempt = canonicalAttempt(day);
    if (!day.projection.qualifies) {
      add(
        "day-nonqualifying",
        `Shadow day blockers: ${day.projection.blockers.join(", ") || "unknown"}.`,
        day.utcDay,
      );
    }
    if (attempt?.identity === undefined || attempt.identity === null) {
      add("canonical-attempt-missing", "The canonical qualifying attempt is unavailable.", day.utcDay);
      return {
        utcDay: day.utcDay,
        dayDigest: dayDigest(day),
        qualifies: false,
        canonicalAttemptId: null,
        publicationGenerationId: null,
        envelopeDigest: null,
      };
    }
    const actual = attempt.identity;
    for (const [code, label, value, expected] of [
      ["release-candidate-mismatch", "release candidate", actual.candidateId, identity.candidateId],
      ["policy-version-drift", "policy version", actual.policyVersion, identity.policyVersion],
      ["policy-id-drift", "policy ID", actual.policyId, identity.policyId],
      ["policy-digest-drift", "policy digest", actual.policyDigest, identity.policyDigest],
      ["evaluation-build-drift", "evaluation build", actual.evaluationBuildDigest, identity.evaluationBuildDigest],
      [
        "compiler-fact-schema-drift",
        "compiler/fact schema",
        actual.compilerFactSchemaDigest,
        identity.compilerFactSchemaDigest,
      ],
      [
        "producer-capability-drift",
        "producer capability",
        actual.producerCapabilityDigest,
        identity.producerCapabilityDigest,
      ],
      [
        "publication-epoch-drift",
        "publication epoch",
        String(actual.publicationEpoch),
        String(identity.publicationEpoch),
      ],
    ] as const) {
      if (value !== expected) add(code, `${label} ${value} does not match ${expected}.`, day.utcDay);
    }
    const coverageEntry = evidence.releaseCoverageReport?.entries.find((entry) => entry.utcDay === day.utcDay);
    if (
      coverageEntry === undefined ||
      actual.baseInputGenerationId !== coverageEntry.report.identities.baseInputGenerationId ||
      actual.factSetDigest !== coverageEntry.report.identities.factSetDigest ||
      actual.resultDigest !== coverageEntry.report.identities.scoreResultDigest
    ) {
      add(
        "release-snapshot-identity-mismatch",
        "The counted day does not match its exact base, fact-set, and result identities in the canonical V9-9 daily coverage series.",
        day.utcDay,
      );
    }
    return {
      utcDay: day.utcDay,
      dayDigest: dayDigest(day),
      qualifies: day.projection.qualifies,
      canonicalAttemptId: attempt.attemptId,
      publicationGenerationId: actual.publicationGenerationId,
      envelopeDigest: actual.envelopeDigest,
    };
  });

  blockers.sort(
    (left, right) =>
      compareText(left.utcDay ?? "", right.utcDay ?? "") ||
      compareText(left.code, right.code) ||
      compareText(left.detail, right.detail),
  );
  const payload = SafetyScoreV9ReleaseWindowReportPayloadSchema.parse({
    schemaVersion: SAFETY_SCORE_V9_RELEASE_WINDOW_SCHEMA_VERSION,
    requiredDayCount: SAFETY_SCORE_V9_RELEASE_WINDOW_DAYS,
    windowStartUtcDay: days[0]?.utcDay ?? null,
    windowEndUtcDay: days.length > 0 ? days[days.length - 1]!.utcDay : null,
    prerequisites: evidence.prerequisites,
    evidenceDigests: evidence.evidenceDigests,
    identity,
    decision: blockers.length === 0 ? "gate-passed" : "no-go",
    days: dayRows,
    blockers,
  });
  return SafetyScoreV9ReleaseWindowReportSchema.parse({
    ...payload,
    reportDigest: computeSafetyScoreV9ReleaseWindowReportDigest(payload),
  });
}
