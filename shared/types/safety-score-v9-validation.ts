import { z } from "zod";
import { MECHANISM_ARCHETYPE_VALUES } from "./stablecoin-taxonomy";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const IsoTimestampSchema = z.string().datetime({ offset: true });
const IdentifierSchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]*$/);
const ScoreSchema = z.number().finite().min(0).max(100);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addCanonicalStringArrayIssues(values: readonly string[], ctx: z.RefinementCtx, path: PropertyKey[]): void {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: "custom", path, message: "Values must be unique" });
  }
  if (values.some((value, index) => index > 0 && compareText(values[index - 1]!, value) >= 0)) {
    ctx.addIssue({ code: "custom", path, message: "Values must be in canonical ascending order" });
  }
}

const CanonicalReviewerIdsSchema = z
  .array(IdentifierSchema)
  .min(1)
  .superRefine((values, ctx) => addCanonicalStringArrayIssues(values, ctx, []));

const CanonicalFactReviewerIdsSchema = z
  .array(IdentifierSchema)
  .min(2)
  .superRefine((values, ctx) => addCanonicalStringArrayIssues(values, ctx, []));

const CanonicalReasonStringsSchema = z
  .array(z.string().min(1))
  .superRefine((values, ctx) => addCanonicalStringArrayIssues(values, ctx, []));

export const V9_HOLDOUT_VALIDATION_THRESHOLDS = {
  minimumCaseCount: 24,
  minimumAdverseCount: 12,
  minimumResilientCount: 12,
  minimumClassRateabilityBps: 8_000,
  catastrophicAdverseScoreExclusiveMaximum: 50,
  adverseScoreExclusiveMaximum: 70,
  resilientLowScoreThreshold: 50,
  maximumResilientLowScoreBps: 2_000,
  minimumMedianSeparation: 15,
  minimumMatchedPairCount: 8,
  minimumMatchedPairArchetypeCount: 4,
  minimumMatchedPairFailurePathFamilyCount: 3,
  minimumMatchedPairScoreGap: 10,
  minimumMatchedPairOrderingBps: 8_000,
} as const;

export const V9HoldoutValidationThresholdsSchema = z
  .object({
    minimumCaseCount: z.literal(V9_HOLDOUT_VALIDATION_THRESHOLDS.minimumCaseCount),
    minimumAdverseCount: z.literal(V9_HOLDOUT_VALIDATION_THRESHOLDS.minimumAdverseCount),
    minimumResilientCount: z.literal(V9_HOLDOUT_VALIDATION_THRESHOLDS.minimumResilientCount),
    minimumClassRateabilityBps: z.literal(V9_HOLDOUT_VALIDATION_THRESHOLDS.minimumClassRateabilityBps),
    catastrophicAdverseScoreExclusiveMaximum: z.literal(
      V9_HOLDOUT_VALIDATION_THRESHOLDS.catastrophicAdverseScoreExclusiveMaximum,
    ),
    adverseScoreExclusiveMaximum: z.literal(V9_HOLDOUT_VALIDATION_THRESHOLDS.adverseScoreExclusiveMaximum),
    resilientLowScoreThreshold: z.literal(V9_HOLDOUT_VALIDATION_THRESHOLDS.resilientLowScoreThreshold),
    maximumResilientLowScoreBps: z.literal(V9_HOLDOUT_VALIDATION_THRESHOLDS.maximumResilientLowScoreBps),
    minimumMedianSeparation: z.literal(V9_HOLDOUT_VALIDATION_THRESHOLDS.minimumMedianSeparation),
    minimumMatchedPairCount: z.literal(V9_HOLDOUT_VALIDATION_THRESHOLDS.minimumMatchedPairCount),
    minimumMatchedPairArchetypeCount: z.literal(V9_HOLDOUT_VALIDATION_THRESHOLDS.minimumMatchedPairArchetypeCount),
    minimumMatchedPairFailurePathFamilyCount: z.literal(
      V9_HOLDOUT_VALIDATION_THRESHOLDS.minimumMatchedPairFailurePathFamilyCount,
    ),
    minimumMatchedPairScoreGap: z.literal(V9_HOLDOUT_VALIDATION_THRESHOLDS.minimumMatchedPairScoreGap),
    minimumMatchedPairOrderingBps: z.literal(V9_HOLDOUT_VALIDATION_THRESHOLDS.minimumMatchedPairOrderingBps),
  })
  .strict();
export type V9HoldoutValidationThresholds = z.infer<typeof V9HoldoutValidationThresholdsSchema>;

export const V9ValidationPrerequisiteStatusSchema = z.enum(["passed", "failed", "not-run"]);
export type V9ValidationPrerequisiteStatus = z.infer<typeof V9ValidationPrerequisiteStatusSchema>;

export const V9HoldoutCaseManifestEntrySchema = z
  .object({
    caseId: IdentifierSchema,
    archetype: z.enum(MECHANISM_ARCHETYPE_VALUES),
    clusterId: IdentifierSchema,
    failurePathFamily: IdentifierSchema,
    evidenceCutoff: IsoTimestampSchema,
    factDigest: Sha256Schema,
    sourceDigest: Sha256Schema,
    factReviewerIds: CanonicalFactReviewerIdsSchema,
  })
  .strict();
export type V9HoldoutCaseManifestEntry = z.infer<typeof V9HoldoutCaseManifestEntrySchema>;

export const V9HoldoutMatchedPairManifestEntrySchema = z
  .object({
    pairId: IdentifierSchema,
    caseIds: z.tuple([IdentifierSchema, IdentifierSchema]),
    archetype: z.enum(MECHANISM_ARCHETYPE_VALUES),
    failurePathFamily: IdentifierSchema,
  })
  .strict()
  .superRefine((pair, ctx) => {
    if (pair.caseIds[0] === pair.caseIds[1]) {
      ctx.addIssue({ code: "custom", path: ["caseIds"], message: "A matched pair requires two distinct cases" });
    }
    if (compareText(pair.caseIds[0], pair.caseIds[1]) >= 0) {
      ctx.addIssue({ code: "custom", path: ["caseIds"], message: "Matched-pair case IDs must be canonical" });
    }
  });
export type V9HoldoutMatchedPairManifestEntry = z.infer<typeof V9HoldoutMatchedPairManifestEntrySchema>;

const V9ReleaseCandidateSealShape = {
  schemaVersion: z.literal(1),
  releaseCandidateId: z.string().regex(/^v9-rc-[1-9][0-9]*$/),
  methodologyRoundId: IdentifierSchema,
  holdoutId: IdentifierSchema,
  lifecycle: z.literal("sealed-candidate"),
  sealedAt: IsoTimestampSchema,
  sealedBy: IdentifierSchema,
  outcomeAccess: z.literal("withheld"),
  digests: z
    .object({
      factSetDigest: Sha256Schema,
      sourceArchiveDigest: Sha256Schema,
      policySemanticDigest: Sha256Schema,
      evaluationBuildDigest: Sha256Schema,
      holdoutManifestDigest: Sha256Schema,
      preregistrationDigest: Sha256Schema,
      outcomeCommitmentDigest: Sha256Schema,
    })
    .strict(),
  thresholds: V9HoldoutValidationThresholdsSchema,
  attemptBudget: z
    .object({
      maximumAttempts: z.literal(1),
      attemptNumber: z.literal(1),
      attemptsUsedBeforeSeal: z.literal(0),
      priorAttemptIds: z.array(IdentifierSchema).length(0),
      sequentialTestingRule: z.literal("one-shot-no-holdout-reuse"),
    })
    .strict(),
  prerequisites: z
    .object({
      producerCapabilityFreeze: V9ValidationPrerequisiteStatusSchema,
      developmentStabilityGate: V9ValidationPrerequisiteStatusSchema,
      sourceRetrievalAudit: V9ValidationPrerequisiteStatusSchema,
      factAbstractionReliabilityAudit: V9ValidationPrerequisiteStatusSchema,
    })
    .strict(),
  reviewers: z
    .object({
      selectionOwnerId: IdentifierSchema,
      calibrationOwnerIds: CanonicalReviewerIdsSchema,
      outcomeReviewerIds: CanonicalReviewerIdsSchema,
      unsealAuthorityIds: CanonicalReviewerIdsSchema,
    })
    .strict(),
  cases: z.array(V9HoldoutCaseManifestEntrySchema).min(1),
  matchedPairs: z.array(V9HoldoutMatchedPairManifestEntrySchema),
} as const;

function addSealManifestIssues(
  seal: {
    sealedAt: string;
    cases: readonly V9HoldoutCaseManifestEntry[];
    matchedPairs: readonly V9HoldoutMatchedPairManifestEntry[];
  },
  ctx: z.RefinementCtx,
): void {
  const caseById = new Map<string, V9HoldoutCaseManifestEntry>();
  seal.cases.forEach((entry, index) => {
    if (caseById.has(entry.caseId)) {
      ctx.addIssue({ code: "custom", path: ["cases", index, "caseId"], message: "Duplicate holdout case ID" });
    }
    caseById.set(entry.caseId, entry);
    if (index > 0 && compareText(seal.cases[index - 1]!.caseId, entry.caseId) >= 0) {
      ctx.addIssue({ code: "custom", path: ["cases", index, "caseId"], message: "Case IDs must be canonical" });
    }
    if (Date.parse(entry.evidenceCutoff) > Date.parse(seal.sealedAt)) {
      ctx.addIssue({
        code: "custom",
        path: ["cases", index, "evidenceCutoff"],
        message: "Holdout evidence cutoff cannot follow the candidate seal",
      });
    }
  });

  const pairIds = new Set<string>();
  const pairedCaseIds = new Set<string>();
  seal.matchedPairs.forEach((pair, index) => {
    if (pairIds.has(pair.pairId)) {
      ctx.addIssue({ code: "custom", path: ["matchedPairs", index, "pairId"], message: "Duplicate pair ID" });
    }
    pairIds.add(pair.pairId);
    if (index > 0 && compareText(seal.matchedPairs[index - 1]!.pairId, pair.pairId) >= 0) {
      ctx.addIssue({ code: "custom", path: ["matchedPairs", index, "pairId"], message: "Pair IDs must be canonical" });
    }
    for (const caseId of pair.caseIds) {
      const manifestCase = caseById.get(caseId);
      if (!manifestCase) {
        ctx.addIssue({
          code: "custom",
          path: ["matchedPairs", index, "caseIds"],
          message: `Matched pair references unknown case ${caseId}`,
        });
        continue;
      }
      if (pairedCaseIds.has(caseId)) {
        ctx.addIssue({
          code: "custom",
          path: ["matchedPairs", index, "caseIds"],
          message: `Holdout case ${caseId} cannot be reused across matched pairs`,
        });
      }
      pairedCaseIds.add(caseId);
      if (manifestCase.archetype !== pair.archetype || manifestCase.failurePathFamily !== pair.failurePathFamily) {
        ctx.addIssue({
          code: "custom",
          path: ["matchedPairs", index],
          message: "Matched-pair strata must agree with both case manifests",
        });
      }
    }
  });
}

const V9ReleaseCandidateSealPayloadBaseSchema = z.object(V9ReleaseCandidateSealShape).strict();

export const V9ReleaseCandidateSealPayloadSchema =
  V9ReleaseCandidateSealPayloadBaseSchema.superRefine(addSealManifestIssues);
export type V9ReleaseCandidateSealPayload = z.infer<typeof V9ReleaseCandidateSealPayloadSchema>;

export const V9ReleaseCandidateSealSchema = V9ReleaseCandidateSealPayloadBaseSchema.extend({
  sealDigest: Sha256Schema,
})
  .strict()
  .superRefine(addSealManifestIssues);
export type V9ReleaseCandidateSeal = z.infer<typeof V9ReleaseCandidateSealSchema>;

export const V9HoldoutOutcomeClassSchema = z.enum(["adverse", "stress-exposed-resilient", "censored"]);
export type V9HoldoutOutcomeClass = z.infer<typeof V9HoldoutOutcomeClassSchema>;

export const V9HoldoutCaseEvaluationSchema = z
  .object({
    caseId: IdentifierSchema,
    factDigest: Sha256Schema,
    sourceDigest: Sha256Schema,
    resultDigest: Sha256Schema,
    score: ScoreSchema.nullable(),
    notRatedReasons: CanonicalReasonStringsSchema,
    outcome: z
      .object({
        classification: V9HoldoutOutcomeClassSchema,
        catastrophicOrClaimImpairing: z.boolean(),
        comparableStressVerified: z.boolean(),
        stressFamily: IdentifierSchema,
        observedFrom: IsoTimestampSchema,
        observedThrough: IsoTimestampSchema,
        outcomeReviewerId: IdentifierSchema,
        censorReason: z.string().min(1).nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if ((entry.score === null) !== entry.notRatedReasons.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["notRatedReasons"],
        message: "A not-rated case requires reasons, while a rated case cannot carry them",
      });
    }
    if (Date.parse(entry.outcome.observedThrough) < Date.parse(entry.outcome.observedFrom)) {
      ctx.addIssue({ code: "custom", path: ["outcome", "observedThrough"], message: "Outcome window is reversed" });
    }
    const censored = entry.outcome.classification === "censored";
    if (censored !== (entry.outcome.censorReason !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["outcome", "censorReason"],
        message: "Only censored outcomes carry a censor reason",
      });
    }
    if (entry.outcome.classification !== "adverse" && entry.outcome.catastrophicOrClaimImpairing) {
      ctx.addIssue({
        code: "custom",
        path: ["outcome", "catastrophicOrClaimImpairing"],
        message: "Only an adverse case can be catastrophic or claim-impairing",
      });
    }
  });
export type V9HoldoutCaseEvaluation = z.infer<typeof V9HoldoutCaseEvaluationSchema>;

/** Exact score/result/outcome payload committed before a sealed holdout is unblinded. */
export const V9HoldoutOutcomeCommitmentEntrySchema = z
  .object({
    caseId: IdentifierSchema,
    resultDigest: Sha256Schema,
    score: ScoreSchema.nullable(),
    notRatedReasons: CanonicalReasonStringsSchema,
    outcome: V9HoldoutCaseEvaluationSchema.shape.outcome,
  })
  .strict();
export type V9HoldoutOutcomeCommitmentEntry = z.infer<typeof V9HoldoutOutcomeCommitmentEntrySchema>;

export const V9HoldoutOutcomeSetCommitmentPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    cases: z.array(V9HoldoutOutcomeCommitmentEntrySchema).min(1),
  })
  .strict()
  .superRefine((payload, ctx) => {
    payload.cases.forEach((entry, index) => {
      if (index > 0 && compareText(payload.cases[index - 1]!.caseId, entry.caseId) >= 0) {
        ctx.addIssue({
          code: "custom",
          path: ["cases", index, "caseId"],
          message: "Outcome commitment case IDs must be unique and in canonical ascending order",
        });
      }
    });
  });
export type V9HoldoutOutcomeSetCommitmentPayload = z.infer<typeof V9HoldoutOutcomeSetCommitmentPayloadSchema>;

export const V9HoldoutDigestBindingSchema = z
  .object({
    factSetDigest: Sha256Schema,
    sourceArchiveDigest: Sha256Schema,
    policySemanticDigest: Sha256Schema,
    evaluationBuildDigest: Sha256Schema,
    holdoutManifestDigest: Sha256Schema,
  })
  .strict();
export type V9HoldoutDigestBinding = z.infer<typeof V9HoldoutDigestBindingSchema>;

export const V9HoldoutUnsealEventSchema = z
  .object({
    eventId: IdentifierSchema,
    releaseCandidateId: z.string().regex(/^v9-rc-[1-9][0-9]*$/),
    holdoutId: IdentifierSchema,
    sealDigest: Sha256Schema,
    outcomeSetDigest: Sha256Schema,
    unsealedAt: IsoTimestampSchema,
    authorizedBy: IdentifierSchema,
    attemptNumber: z.number().int().positive(),
    priorUnsealEventCount: z.number().int().nonnegative(),
    outcomeAccessBeforeEvent: z.literal("withheld"),
    outcomeAccessAfterEvent: z.literal("unsealed"),
  })
  .strict();
export type V9HoldoutUnsealEvent = z.infer<typeof V9HoldoutUnsealEventSchema>;

export const V9HistoricalHoldoutEvaluationInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    evaluatedAt: IsoTimestampSchema,
    seal: V9ReleaseCandidateSealSchema,
    bindings: V9HoldoutDigestBindingSchema,
    unseal: V9HoldoutUnsealEventSchema,
    cases: z.array(V9HoldoutCaseEvaluationSchema),
  })
  .strict()
  .superRefine((input, ctx) => {
    const ids = new Set<string>();
    input.cases.forEach((entry, index) => {
      if (ids.has(entry.caseId)) {
        ctx.addIssue({ code: "custom", path: ["cases", index, "caseId"], message: "Duplicate case evaluation" });
      }
      ids.add(entry.caseId);
    });
  });
export type V9HistoricalHoldoutEvaluationInput = z.infer<typeof V9HistoricalHoldoutEvaluationInputSchema>;

export const V9_HOLDOUT_NO_GO_REASON_CODES = [
  "candidate-seal-digest-mismatch",
  "fact-set-digest-mismatch",
  "source-archive-digest-mismatch",
  "policy-semantic-digest-mismatch",
  "evaluation-build-digest-mismatch",
  "holdout-manifest-digest-mismatch",
  "outcome-commitment-digest-mismatch",
  "case-manifest-mismatch",
  "case-fact-digest-mismatch",
  "case-source-digest-mismatch",
  "unseal-identity-mismatch",
  "unseal-before-seal",
  "evaluation-before-unseal",
  "unseal-attempt-budget-violated",
  "unseal-event-repeated",
  "unseal-authority-not-registered",
  "producer-capability-freeze-incomplete",
  "development-stability-gate-incomplete",
  "source-retrieval-audit-incomplete",
  "fact-abstraction-reliability-incomplete",
  "reviewer-independence-failed",
  "case-count-below-24",
  "adverse-count-below-12",
  "resilient-count-below-12",
  "adverse-rateability-below-80-percent",
  "resilient-rateability-below-80-percent",
  "resilient-stress-evidence-incomplete",
  "catastrophic-adverse-score-not-below-50",
  "adverse-score-at-or-above-70",
  "resilient-below-50-rate-above-20-percent",
  "median-separation-below-15",
  "matched-pair-count-below-8",
  "matched-pair-archetype-coverage-below-4",
  "matched-pair-failure-path-coverage-below-3",
  "matched-pair-outcome-class-mismatch",
  "matched-pair-ordering-below-80-percent",
] as const;
export const V9HoldoutNoGoReasonCodeSchema = z.enum(V9_HOLDOUT_NO_GO_REASON_CODES);
export type V9HoldoutNoGoReasonCode = z.infer<typeof V9HoldoutNoGoReasonCodeSchema>;

const V9ClassRateabilityMetricsSchema = z
  .object({
    denominator: z.number().int().nonnegative(),
    rated: z.number().int().nonnegative(),
    notRated: z.number().int().nonnegative(),
    rateabilityBps: z.number().int().min(0).max(10_000),
  })
  .strict()
  .superRefine((metrics, ctx) => {
    if (metrics.denominator !== metrics.rated + metrics.notRated) {
      ctx.addIssue({ code: "custom", message: "Class rateability counts do not reconcile" });
    }
  });

export const V9HistoricalHoldoutValidationReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    releaseCandidateId: z.string().regex(/^v9-rc-[1-9][0-9]*$/),
    methodologyRoundId: IdentifierSchema,
    holdoutId: IdentifierSchema,
    sealDigest: Sha256Schema,
    reportDigest: Sha256Schema,
    evaluatedAt: IsoTimestampSchema,
    claimScope: z.literal("diverse-release-regression-not-an-error-rate-estimate"),
    decision: z.enum(["gate-passed", "no-go"]),
    thresholds: V9HoldoutValidationThresholdsSchema,
    digests: z
      .object({
        factSetDigest: Sha256Schema,
        sourceArchiveDigest: Sha256Schema,
        policySemanticDigest: Sha256Schema,
        evaluationBuildDigest: Sha256Schema,
        holdoutManifestDigest: Sha256Schema,
        outcomeSetDigest: Sha256Schema,
      })
      .strict(),
    bindings: z
      .object({
        sealDigest: z.boolean(),
        factSetDigest: z.boolean(),
        sourceArchiveDigest: z.boolean(),
        policySemanticDigest: z.boolean(),
        evaluationBuildDigest: z.boolean(),
        holdoutManifestDigest: z.boolean(),
        outcomeCommitmentDigest: z.boolean(),
        caseFactDigests: z.boolean(),
        caseSourceDigests: z.boolean(),
      })
      .strict(),
    governance: z
      .object({
        sealedBeforeUnseal: z.boolean(),
        evaluatedAfterUnseal: z.boolean(),
        oneShotAttemptBudget: z.boolean(),
        oneTimeUnseal: z.boolean(),
        registeredUnsealAuthority: z.boolean(),
        reviewerIndependence: z.boolean(),
        prerequisitesPassed: z.boolean(),
      })
      .strict(),
    corpus: z
      .object({
        registeredCases: z.number().int().nonnegative(),
        reportedCases: z.number().int().nonnegative(),
        adverseCases: z.number().int().nonnegative(),
        resilientCases: z.number().int().nonnegative(),
        censoredCases: z.number().int().nonnegative(),
        manifestReconciled: z.boolean(),
      })
      .strict(),
    rateability: z
      .object({ adverse: V9ClassRateabilityMetricsSchema, resilient: V9ClassRateabilityMetricsSchema })
      .strict(),
    absoluteAnchors: z
      .object({
        catastrophicAdverseCases: z.number().int().nonnegative(),
        catastrophicAdversePassing: z.number().int().nonnegative(),
        adverseAtOrAbove70: z.number().int().nonnegative(),
        adverseNotRated: z.number().int().nonnegative(),
        resilientBelow50: z.number().int().nonnegative(),
        resilientBelow50Bps: z.number().int().min(0).max(10_000),
      })
      .strict(),
    separation: z
      .object({
        adverseMedian: ScoreSchema.nullable(),
        resilientMedian: ScoreSchema.nullable(),
        medianGap: z.number().finite().min(-100).max(100).nullable(),
      })
      .strict(),
    matchedPairs: z
      .object({
        registered: z.number().int().nonnegative(),
        passing: z.number().int().nonnegative(),
        notRated: z.number().int().nonnegative(),
        outcomeClassMismatch: z.number().int().nonnegative(),
        orderingBps: z.number().int().min(0).max(10_000),
        archetypeCount: z.number().int().nonnegative(),
        failurePathFamilyCount: z.number().int().nonnegative(),
      })
      .strict(),
    noGoReasons: z.array(V9HoldoutNoGoReasonCodeSchema),
  })
  .strict()
  .superRefine((report, ctx) => {
    addCanonicalStringArrayIssues(report.noGoReasons, ctx, ["noGoReasons"]);
    if ((report.decision === "gate-passed") !== (report.noGoReasons.length === 0)) {
      ctx.addIssue({ code: "custom", path: ["decision"], message: "Decision and no-go reasons must agree" });
    }
    if (
      report.corpus.reportedCases !==
      report.corpus.adverseCases + report.corpus.resilientCases + report.corpus.censoredCases
    ) {
      ctx.addIssue({ code: "custom", path: ["corpus"], message: "Holdout outcome counts do not reconcile" });
    }
  });
export type V9HistoricalHoldoutValidationReport = z.infer<typeof V9HistoricalHoldoutValidationReportSchema>;
