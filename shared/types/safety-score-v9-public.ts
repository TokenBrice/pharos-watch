import { z } from "zod";
import { V9DependencyEconomicRoleSchema } from "./dependency-types";
import {
  V9CapSourceSchema,
  V9EvidenceLevelSchema,
  V9GradeSchema,
  V9QualityPillarSchema,
  V9ReasonCodeSchema,
} from "./safety-score-v9";
import {
  V9EvidenceResponsibilitySchema,
  V9FailureDomainRefSchema,
} from "./safety-score-v9-fact-primitives";
import {
  V9_WRAPPER_LOCAL_FACT_KEYS,
  V9WrapperFactDispositionSchema,
  V9WrapperFormSchema,
  V9WrapperLocalFactKeySchema,
  V9WrapperRiskAssessmentSchema,
  V9WrapperRiskTransferMechanismSchema,
} from "./safety-score-v9-wrapper";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const BaseInputGenerationIdSchema = z.string().regex(/^report-cards-input:v1:[a-f0-9]{64}$/);
const ScoreSchema = z.number().finite().min(0).max(100);
const CandidatePolicyVersionSchema = z.string().regex(/^candidate-[a-z0-9][a-z0-9._-]*$/);
const AccessPostureFieldSchema = z.enum(["transfer", "freezeExposure", "primaryExit", "governance"]);
const RESPONSIBILITIES = [
  "integration-missing",
  "issuer-undisclosed",
  "measured-adverse",
  "method-unsupported",
  "producer-failed",
] as const;
const SCORE_TOLERANCE = 0.0002;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isUniqueSorted(values: readonly string[]): boolean {
  return (
    new Set(values).size === values.length && values.every((value, index) => index === 0 || values[index - 1]! < value)
  );
}

function numbersAgree(left: number | null, right: number | null): boolean {
  return left === null || right === null ? left === right : Math.abs(left - right) <= SCORE_TOLERANCE;
}

export const SafetyScoreV9PublicReasonSchema = z
  .object({
    code: V9ReasonCodeSchema,
    message: z.string().min(1),
    path: z.string().min(1).nullable(),
  })
  .strict();
export type SafetyScoreV9PublicReason = z.infer<typeof SafetyScoreV9PublicReasonSchema>;

export const SafetyScoreV9NrReasonSchema = z
  .object({
    code: V9ReasonCodeSchema,
    message: z.string().min(1),
    field: z.string().min(1).nullable(),
    origin: z.enum(["asset", "upstream"]),
  })
  .strict();
export type SafetyScoreV9NrReason = z.infer<typeof SafetyScoreV9NrReasonSchema>;

export const SafetyScoreV9EvidenceFreshnessSchema = z.enum(["current", "stale", "unknown"]);
export type SafetyScoreV9EvidenceFreshness = z.infer<typeof SafetyScoreV9EvidenceFreshnessSchema>;

export const SafetyScoreV9PillarSchema = z
  .object({
    score: ScoreSchema.nullable(),
    evidenceLevel: V9EvidenceLevelSchema,
    freshness: SafetyScoreV9EvidenceFreshnessSchema,
    components: z.array(z.string().min(1)),
    reasons: z.array(SafetyScoreV9PublicReasonSchema),
  })
  .strict()
  .superRefine((pillar, ctx) => {
    if (!isUniqueSorted(pillar.components)) {
      ctx.addIssue({ code: "custom", path: ["components"], message: "V9 pillar components must be unique and sorted" });
    }
  });
export type SafetyScoreV9Pillar = z.infer<typeof SafetyScoreV9PillarSchema>;

export const SafetyScoreV9CapSchema = z
  .object({
    kind: z.string().min(1),
    limit: ScoreSchema,
    source: V9CapSourceSchema,
    reason: z.string().min(1),
    binding: z.boolean(),
  })
  .strict();
export type SafetyScoreV9Cap = z.infer<typeof SafetyScoreV9CapSchema>;

export const SafetyScoreV9AccessPostureSchema = z
  .object({
    transfer: z.enum(["permissionless", "restrictable", "permissioned", "unknown"]),
    freezeExposure: z.enum(["none-known", "upstream", "direct", "possible", "unknown"]),
    primaryExit: z.enum(["permissionless", "eligibility-gated", "issuer-discretionary", "none", "unknown"]),
    governance: z.enum(["immutable", "distributed", "concentrated", "single-entity", "unknown"]),
    unknownFields: z.array(AccessPostureFieldSchema),
    signals: z.array(z.string().min(1)),
    reasons: z.array(SafetyScoreV9PublicReasonSchema),
  })
  .strict()
  .superRefine((posture, ctx) => {
    const expectedUnknown = (["transfer", "freezeExposure", "primaryExit", "governance"] as const)
      .filter((field) => posture[field] === "unknown")
      .sort(compareText);
    if (JSON.stringify(posture.unknownFields) !== JSON.stringify(expectedUnknown)) {
      ctx.addIssue({
        code: "custom",
        path: ["unknownFields"],
        message: "V9 access unknown fields must exactly match unknown posture values",
      });
    }
    if (!isUniqueSorted(posture.signals)) {
      ctx.addIssue({ code: "custom", path: ["signals"], message: "V9 access signals must be unique and sorted" });
    }
  });
export type SafetyScoreV9AccessPosture = z.infer<typeof SafetyScoreV9AccessPostureSchema>;

const SafetyScoreV9SerialDependencySchema = z
  .object({
    upstreamAssetId: z.string().min(1),
    score: ScoreSchema.nullable(),
    blocked: z.boolean(),
  })
  .strict();

const SafetyScoreV9BasketDependencySchema = z
  .object({
    upstreamAssetId: z.string().min(1),
    weight: z.number().finite().min(0).max(1),
    score: ScoreSchema.nullable(),
    boundedUnknown: z.boolean(),
  })
  .strict();

const SafetyScoreV9RoleDependencySchema = z
  .object({
    edgeKey: z.string().min(1),
    exposureKey: z.string().min(1),
    riskEventKey: z.string().min(1),
    upstreamAssetId: z.string().min(1),
    role: V9DependencyEconomicRoleSchema,
    weight: z.number().finite().min(0).max(1),
    targetPillar: z.enum(["exit", "control"]).nullable(),
    propagationEventEdgeKeys: z.array(z.string().min(1)),
    propagationEventExposureKey: z.string().min(1).nullable(),
    propagationEventRiskEventKey: z.string().min(1).nullable(),
    propagationEventNominalExposureShare: z.number().finite().min(0).max(1).nullable(),
    propagationEventExposureShare: z.number().finite().min(0).max(1).nullable(),
    propagationEventInheritedScore: ScoreSchema.nullable(),
    propagationEventModeledLossPoints: ScoreSchema.nullable(),
    inheritedDimensions: z.array(z.enum(["final", "backing", "exit", "access", "control", "oracle-nav"])),
    unavailableDimensions: z.array(z.enum(["final", "backing", "exit", "access", "control", "oracle-nav"])),
    score: ScoreSchema.nullable(),
    boundedUnknown: z.boolean(),
    cycleBlocked: z.boolean(),
    evidenceRefIds: z.array(z.string().min(1)),
    failureDomains: z.array(V9FailureDomainRefSchema),
  })
  .strict()
  .superRefine((dependency, ctx) => {
    if (!isUniqueSorted(dependency.propagationEventEdgeKeys)) {
      ctx.addIssue({
        code: "custom",
        path: ["propagationEventEdgeKeys"],
        message: "V9 role dependency propagation event keys must be unique and sorted",
      });
    }
    if (!isUniqueSorted(dependency.evidenceRefIds)) {
      ctx.addIssue({
        code: "custom",
        path: ["evidenceRefIds"],
        message: "V9 role dependency evidence references must be unique and sorted",
      });
    }
    const failureDomainKeys = dependency.failureDomains.map((domain) => `${domain.kind}:${domain.key}`);
    if (!isUniqueSorted(failureDomainKeys)) {
      ctx.addIssue({
        code: "custom",
        path: ["failureDomains"],
        message: "V9 role dependency failure domains must be unique and sorted",
      });
    }
  });

const SafetyScoreV9RolePillarLimitSchema = z
  .object({
    limit: ScoreSchema.nullable(),
    knownLossPoints: ScoreSchema,
    boundedUnknownLossPoints: ScoreSchema,
    unresolvedExposureShare: z.number().finite().min(0).max(1),
    materialUnresolvedExposure: z.boolean(),
  })
  .strict();

export const SafetyScoreV9DependencySummarySchema = z
  .object({
    serial: z.array(SafetyScoreV9SerialDependencySchema),
    basket: z.array(SafetyScoreV9BasketDependencySchema),
    roles: z.array(SafetyScoreV9RoleDependencySchema).optional(),
    rolePillarLimits: z
      .object({
        exit: SafetyScoreV9RolePillarLimitSchema,
        control: SafetyScoreV9RolePillarLimitSchema,
      })
      .strict()
      .optional(),
    cycleBlocked: z.boolean(),
    reasonCodes: z.array(V9ReasonCodeSchema),
  })
  .strict()
  .superRefine((summary, ctx) => {
    for (const field of ["serial", "basket"] as const) {
      const ids = summary[field].map((dependency) => dependency.upstreamAssetId);
      if (!isUniqueSorted(ids)) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `V9 ${field} dependencies must have unique, sorted upstream IDs`,
        });
      }
    }
    const roleKeys = (summary.roles ?? []).map(
      (dependency) => `${dependency.role}:${dependency.upstreamAssetId}:${dependency.edgeKey}`,
    );
    if (!isUniqueSorted(roleKeys)) {
      ctx.addIssue({
        code: "custom",
        path: ["roles"],
        message: "V9 role dependencies must have unique, sorted role/upstream/edge keys",
      });
    }
    if (!isUniqueSorted(summary.reasonCodes)) {
      ctx.addIssue({
        code: "custom",
        path: ["reasonCodes"],
        message: "V9 dependency reasons must be unique and sorted",
      });
    }
  });
export type SafetyScoreV9DependencySummary = z.infer<typeof SafetyScoreV9DependencySummarySchema>;

export const SafetyScoreV9EvidenceSummarySchema = z
  .object({
    level: V9EvidenceLevelSchema,
    freshness: SafetyScoreV9EvidenceFreshnessSchema,
    reasons: z.array(SafetyScoreV9PublicReasonSchema),
  })
  .strict();
export type SafetyScoreV9EvidenceSummary = z.infer<typeof SafetyScoreV9EvidenceSummarySchema>;

export const SafetyScoreV9AggregationTraceSchema = z
  .object({
    method: z.literal("smooth-bounded-headroom"),
    score: ScoreSchema,
    weightedPillarMean: ScoreSchema,
    weakestPillar: V9QualityPillarSchema,
    weakestScore: ScoreSchema,
    headroom: z.number().finite().positive().max(100),
  })
  .strict()
  .superRefine((aggregation, ctx) => {
    if (
      aggregation.weakestScore > aggregation.weightedPillarMean + SCORE_TOLERANCE ||
      aggregation.score < aggregation.weakestScore - SCORE_TOLERANCE ||
      aggregation.score > aggregation.weightedPillarMean + SCORE_TOLERANCE
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["score"],
        message: "V9 aggregation score must remain between the weakest pillar and weighted pillar mean",
      });
    }
  });
export type SafetyScoreV9AggregationTrace = z.infer<typeof SafetyScoreV9AggregationTraceSchema>;

export const SafetyScoreV9DeploymentAdjustmentSchema = z
  .object({
    signalKey: z.string().min(1),
    sourceSignalKeys: z.array(z.string().min(1)).min(1),
    exposureKey: z.string().min(1),
    riskEventKey: z.string().min(1),
    failureDomainKey: z.string().min(1),
    nominalExposureShare: z.number().finite().min(0).max(1),
    exposureShare: z.number().finite().min(0).max(1),
    exposedScore: ScoreSchema,
    scoreBefore: ScoreSchema,
    scoreAfter: ScoreSchema,
    adjustmentPoints: z.number().finite().min(0).max(100),
    modeledLossPoints: z.number().finite().min(0).max(100),
    reason: z.string().min(1),
  })
  .strict()
  .superRefine((adjustment, ctx) => {
    if (!isUniqueSorted(adjustment.sourceSignalKeys)) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceSignalKeys"],
        message: "V9 deployment source signals must be unique and sorted",
      });
    }
    if (
      adjustment.scoreAfter > adjustment.scoreBefore + SCORE_TOLERANCE ||
      !numbersAgree(adjustment.scoreBefore - adjustment.scoreAfter, adjustment.adjustmentPoints) ||
      !numbersAgree(
        adjustment.scoreAfter,
        Math.max(0, adjustment.scoreBefore - adjustment.modeledLossPoints),
      ) ||
      adjustment.exposureShare > adjustment.nominalExposureShare + SCORE_TOLERANCE
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["adjustmentPoints"],
        message: "V9 deployment adjustment must reconcile its modeled loss, applied points, and score stages",
      });
    }
  });
export type SafetyScoreV9DeploymentAdjustment = z.infer<typeof SafetyScoreV9DeploymentAdjustmentSchema>;

export const SafetyScoreV9UnresolvedDeploymentExposureSchema = z
  .object({
    signalKey: z.string().min(1),
    exposureKey: z.string().min(1),
    riskEventKey: z.string().min(1),
    failureDomainKeys: z.array(z.string().min(1)).min(1),
    economicLossScope: z.literal("deployment"),
    exposedScore: ScoreSchema,
    exposureShare: z.null(),
    reason: z.string().min(1),
  })
  .strict()
  .superRefine((signal, ctx) => {
    if (!isUniqueSorted(signal.failureDomainKeys)) {
      ctx.addIssue({
        code: "custom",
        path: ["failureDomainKeys"],
        message: "V9 unresolved deployment failure domains must be unique and sorted",
      });
    }
  });
export type SafetyScoreV9UnresolvedDeploymentExposure = z.infer<
  typeof SafetyScoreV9UnresolvedDeploymentExposureSchema
>;

export const SafetyScoreV9DeploymentRiskTraceSchema = z
  .object({
    method: z.literal("holder-slice-exposure-weighted-v2"),
    totalAdjustmentPoints: z.number().finite().min(0).max(100).nullable(),
    adjustments: z.array(SafetyScoreV9DeploymentAdjustmentSchema),
    unresolvedExposures: z.array(SafetyScoreV9UnresolvedDeploymentExposureSchema),
  })
  .strict()
  .superRefine((deployment, ctx) => {
    const adjustmentKeys = deployment.adjustments.map(
      (adjustment) =>
        `${adjustment.exposureKey}\u0000${adjustment.riskEventKey}\u0000${adjustment.signalKey}`,
    );
    if (!isUniqueSorted(adjustmentKeys)) {
      ctx.addIssue({
        code: "custom",
        path: ["adjustments"],
        message: "V9 deployment adjustments must have unique, sorted failure-domain attribution",
      });
    }
    const unresolvedKeys = deployment.unresolvedExposures.map(
      (signal) =>
        `${signal.exposureKey}\u0000${signal.riskEventKey}\u0000${signal.failureDomainKeys.join("+")}\u0000${signal.signalKey}`,
    );
    if (!isUniqueSorted(unresolvedKeys)) {
      ctx.addIssue({
        code: "custom",
        path: ["unresolvedExposures"],
        message: "V9 unresolved deployment exposures must have unique, sorted exposure attribution",
      });
    }
    const expectedTotal = deployment.adjustments.reduce(
      (sum, adjustment) => sum + adjustment.adjustmentPoints,
      0,
    );
    const effectiveExposureShare = deployment.adjustments.reduce(
      (sum, adjustment) => sum + adjustment.exposureShare,
      0,
    );
    if (effectiveExposureShare > 1 + SCORE_TOLERANCE) {
      ctx.addIssue({
        code: "custom",
        path: ["adjustments"],
        message: "V9 deployment adjustment exposure shares must form a bounded holder partition",
      });
    }
    if (
      deployment.totalAdjustmentPoints !== null &&
      !numbersAgree(deployment.totalAdjustmentPoints, expectedTotal)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["totalAdjustmentPoints"],
        message: "V9 total deployment adjustment must equal its attributed adjustments",
      });
    }
  });
export type SafetyScoreV9DeploymentRiskTrace = z.infer<typeof SafetyScoreV9DeploymentRiskTraceSchema>;

export const SafetyScoreV9AdverseAttributionItemSchema = z
  .object({
    source: z.enum([
      "active-depeg",
      "parent-score",
      "peg-performance",
      "pillar-score",
      "reason",
      "structural-signal",
      "track-record",
    ]),
    path: z.string().min(1),
    message: z.string().min(1),
    responsibility: z.literal("measured-adverse"),
  })
  .strict();
export type SafetyScoreV9AdverseAttributionItem = z.infer<typeof SafetyScoreV9AdverseAttributionItemSchema>;

export const SafetyScoreV9AdverseAttributionTraceSchema = z
  .object({
    semantics: z.literal("causal-measured-adverse-v1"),
    items: z.array(SafetyScoreV9AdverseAttributionItemSchema),
  })
  .strict()
  .superRefine((attribution, ctx) => {
    const keys = attribution.items.map((item) => `${item.source}\u0000${item.path}\u0000${item.message}`);
    if (!isUniqueSorted(keys)) {
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: "V9 adverse attribution must be unique and sorted",
      });
    }
  });
export type SafetyScoreV9AdverseAttributionTrace = z.infer<typeof SafetyScoreV9AdverseAttributionTraceSchema>;

export const SafetyScoreV9EvidenceResponsibilityItemSchema = z
  .object({
    responsibility: V9EvidenceResponsibilitySchema,
    factCount: z.number().int().nonnegative(),
    criticalFactCount: z.number().int().nonnegative(),
    reasonCodes: z.array(V9ReasonCodeSchema),
  })
  .strict()
  .superRefine((summary, ctx) => {
    if (summary.criticalFactCount > summary.factCount) {
      ctx.addIssue({
        code: "custom",
        path: ["criticalFactCount"],
        message: "V9 critical responsibility count cannot exceed its fact count",
      });
    }
    if (!isUniqueSorted(summary.reasonCodes)) {
      ctx.addIssue({
        code: "custom",
        path: ["reasonCodes"],
        message: "V9 responsibility reason codes must be unique and sorted",
      });
    }
  });
export type SafetyScoreV9EvidenceResponsibilityItem = z.infer<
  typeof SafetyScoreV9EvidenceResponsibilityItemSchema
>;

export const SafetyScoreV9EvidenceResponsibilityTraceSchema = z
  .object({
    semantics: z.literal("limiting-fact-owner-v1"),
    totalFactCount: z.number().int().nonnegative(),
    summaries: z.array(SafetyScoreV9EvidenceResponsibilityItemSchema).length(RESPONSIBILITIES.length),
  })
  .strict()
  .superRefine((evidence, ctx) => {
    const actualResponsibilities = evidence.summaries.map((summary) => summary.responsibility);
    if (JSON.stringify(actualResponsibilities) !== JSON.stringify(RESPONSIBILITIES)) {
      ctx.addIssue({
        code: "custom",
        path: ["summaries"],
        message: "V9 evidence responsibility summaries must cover every owner in canonical order",
      });
    }
    const expectedTotal = evidence.summaries.reduce((sum, summary) => sum + summary.factCount, 0);
    if (evidence.totalFactCount !== expectedTotal) {
      ctx.addIssue({
        code: "custom",
        path: ["totalFactCount"],
        message: "V9 evidence responsibility total must reconcile its summaries",
      });
    }
  });
export type SafetyScoreV9EvidenceResponsibilityTrace = z.infer<
  typeof SafetyScoreV9EvidenceResponsibilityTraceSchema
>;

const SafetyScoreV9WrapperMissingFactClassSchema = z.union([
  V9WrapperLocalFactKeySchema,
  z.enum(["riskTransfer", "wrapperForm"]),
]);

export const SafetyScoreV9WrapperParentLimitSchema = z
  .object({
    schemaVersion: z.literal(1),
    parentScore: ScoreSchema,
    form: V9WrapperFormSchema,
    treatment: z.enum(["local-facts", "fallback-discount", "documented-risk-transfer"]),
    localRiskDiscount: z.number().finite().min(0).max(100),
    fallbackDiscount: z.number().finite().min(0).max(100),
    appliedDiscount: z.number().finite().min(0).max(100),
    riskTransfer: z
      .object({
        disposition: V9WrapperFactDispositionSchema,
        mechanism: V9WrapperRiskTransferMechanismSchema,
        requestedCredit: z.number().finite().min(0).max(100),
        appliedCredit: z.number().finite().min(0).max(100),
      })
      .strict(),
    limit: ScoreSchema,
    factsComplete: z.boolean(),
    missingFacts: z.array(
      z
        .object({
          factClass: SafetyScoreV9WrapperMissingFactClassSchema,
          disposition: V9WrapperFactDispositionSchema.exclude(["reviewed", "not-applicable"]),
        })
        .strict(),
    ),
    adjustments: z.array(
      z
        .object({
          factKey: V9WrapperLocalFactKeySchema,
          disposition: V9WrapperFactDispositionSchema,
          assessment: V9WrapperRiskAssessmentSchema.nullable(),
          maximumDiscountPoints: z.number().finite().positive().max(100),
          discountPoints: z.number().finite().min(0).max(100),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((limit, ctx) => {
    const missingKeys = limit.missingFacts.map((fact) => `${fact.factClass}:${fact.disposition}`);
    if (!isUniqueSorted(missingKeys)) {
      ctx.addIssue({ code: "custom", path: ["missingFacts"], message: "V9 wrapper missing facts must be unique and sorted" });
    }
    const adjustmentKeys = limit.adjustments.map((adjustment) => adjustment.factKey);
    const expectedAdjustmentKeys = [...V9_WRAPPER_LOCAL_FACT_KEYS];
    if (JSON.stringify(adjustmentKeys) !== JSON.stringify(expectedAdjustmentKeys)) {
      ctx.addIssue({
        code: "custom",
        path: ["adjustments"],
        message: "V9 wrapper adjustments must cover every local fact in canonical order",
      });
    }
    const expectedLocalRiskDiscount = limit.adjustments.reduce(
      (sum, adjustment) => sum + adjustment.discountPoints,
      0,
    );
    if (!numbersAgree(limit.localRiskDiscount, expectedLocalRiskDiscount)) {
      ctx.addIssue({
        code: "custom",
        path: ["localRiskDiscount"],
        message: "V9 wrapper local-risk discount must reconcile its fact adjustments",
      });
    }
    if (limit.factsComplete !== (limit.missingFacts.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["factsComplete"],
        message: "V9 wrapper completeness must exactly match its missing facts",
      });
    }
    const expectedAppliedDiscount = limit.factsComplete
      ? limit.localRiskDiscount
      : Math.max(limit.localRiskDiscount, limit.fallbackDiscount);
    if (!numbersAgree(limit.appliedDiscount, expectedAppliedDiscount)) {
      ctx.addIssue({
        code: "custom",
        path: ["appliedDiscount"],
        message: "V9 wrapper discount must use local risk when complete and the conservative maximum when incomplete",
      });
    }
    if (limit.riskTransfer.appliedCredit > limit.riskTransfer.requestedCredit + SCORE_TOLERANCE) {
      ctx.addIssue({
        code: "custom",
        path: ["riskTransfer", "appliedCredit"],
        message: "V9 wrapper cannot apply more risk-transfer credit than documented",
      });
    }
    const expectedLimit =
      Math.max(0, limit.parentScore - limit.appliedDiscount) + limit.riskTransfer.appliedCredit;
    if (!numbersAgree(limit.limit, expectedLimit)) {
      ctx.addIssue({
        code: "custom",
        path: ["limit"],
        message: "V9 wrapper limit must apply parent risk, local discount, and documented credit exactly once",
      });
    }
    if (
      (limit.treatment === "fallback-discount") !== !limit.factsComplete ||
      (limit.treatment === "documented-risk-transfer") !== (limit.riskTransfer.appliedCredit > 0)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["treatment"],
        message: "V9 wrapper treatment does not match completeness and risk-transfer credit",
      });
    }
  });
export type SafetyScoreV9WrapperParentLimit = z.infer<typeof SafetyScoreV9WrapperParentLimitSchema>;

export const SafetyScoreV9ScoreTraceSchema = z
  .object({
    schemaVersion: z.literal(1),
    legacyAliases: z
      .object({
        qualityScore: z.literal("weighted-pillar-mean"),
        pegAdjustedScore: z.literal("post-deployment-pre-cap-score"),
        score: z.literal("post-cap-public-score"),
      })
      .strict(),
    aggregation: SafetyScoreV9AggregationTraceSchema.nullable(),
    stages: z
      .object({
        weightedPillarMean: ScoreSchema.nullable(),
        aggregatedQualityScore: ScoreSchema.nullable(),
        pegMultiplier: z.number().finite().min(0).max(1).nullable(),
        baseAssetScore: ScoreSchema.nullable(),
        deploymentAdjustedScore: ScoreSchema.nullable(),
        deploymentAdjustmentPoints: z.number().finite().min(0).max(100).nullable(),
        preCapScore: ScoreSchema.nullable(),
        publishedScore: ScoreSchema.nullable(),
      })
      .strict(),
    deploymentRisk: SafetyScoreV9DeploymentRiskTraceSchema,
    adverseAttribution: SafetyScoreV9AdverseAttributionTraceSchema,
    evidenceResponsibility: SafetyScoreV9EvidenceResponsibilityTraceSchema,
    wrapperParentLimit: SafetyScoreV9WrapperParentLimitSchema.nullable(),
  })
  .strict()
  .superRefine((trace, ctx) => {
    const aggregationScore = trace.aggregation?.score ?? null;
    if ((trace.aggregation === null) !== (trace.stages.weightedPillarMean === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["aggregation"],
        message: "V9 score-bearing pillars require an explicit aggregation method and trace",
      });
    }
    if (!numbersAgree(trace.stages.aggregatedQualityScore, aggregationScore)) {
      ctx.addIssue({
        code: "custom",
        path: ["stages", "aggregatedQualityScore"],
        message: "V9 aggregated quality stage must match the aggregation trace",
      });
    }
    const expectedDeploymentAdjustment =
      trace.stages.baseAssetScore === null || trace.stages.deploymentAdjustedScore === null
        ? null
        : trace.stages.baseAssetScore - trace.stages.deploymentAdjustedScore;
    if (!numbersAgree(trace.stages.deploymentAdjustmentPoints, expectedDeploymentAdjustment)) {
      ctx.addIssue({
        code: "custom",
        path: ["stages", "deploymentAdjustmentPoints"],
        message: "V9 deployment stage delta must reconcile base and post-deployment scores",
      });
    }
    if (!numbersAgree(trace.stages.deploymentAdjustmentPoints, trace.deploymentRisk.totalAdjustmentPoints)) {
      ctx.addIssue({
        code: "custom",
        path: ["deploymentRisk", "totalAdjustmentPoints"],
        message: "V9 deployment trace total must match the score-stage adjustment",
      });
    }
    if (!numbersAgree(trace.stages.deploymentAdjustedScore, trace.stages.preCapScore)) {
      ctx.addIssue({
        code: "custom",
        path: ["stages", "preCapScore"],
        message: "V9 pre-cap score must match the post-deployment score",
      });
    }
  });
export type SafetyScoreV9ScoreTrace = z.infer<typeof SafetyScoreV9ScoreTraceSchema>;

const SafetyScoreV9CardShape = {
  id: z.string().min(1),
  score: ScoreSchema.nullable(),
  grade: V9GradeSchema,
  qualityScore: ScoreSchema.nullable(),
  pegMultiplier: z.number().finite().min(0).max(1).nullable(),
  pegAdjustedScore: ScoreSchema.nullable(),
  pillars: z
    .object({
      backing: SafetyScoreV9PillarSchema,
      exit: SafetyScoreV9PillarSchema,
      control: SafetyScoreV9PillarSchema,
    })
    .strict(),
  weakestPillar: z.object({ pillar: V9QualityPillarSchema, score: ScoreSchema }).strict().nullable(),
  caps: z.array(SafetyScoreV9CapSchema),
  bindingCap: SafetyScoreV9CapSchema.nullable(),
  nrReasons: z.array(SafetyScoreV9NrReasonSchema),
  reasonCodes: z.array(V9ReasonCodeSchema),
  evidence: SafetyScoreV9EvidenceSummarySchema,
  accessPosture: SafetyScoreV9AccessPostureSchema,
  dependencies: SafetyScoreV9DependencySummarySchema,
  stressStateDigest: Sha256Schema.nullable(),
} as const;
const SafetyScoreV9CardObjectSchema = z.object(SafetyScoreV9CardShape).strict();
type SafetyScoreV9CardBase = z.infer<typeof SafetyScoreV9CardObjectSchema>;

function refineCard(
  card: SafetyScoreV9CardBase & { scoreTrace?: SafetyScoreV9ScoreTrace },
  ctx: { addIssue: (issue: { code: "custom"; path?: PropertyKey[]; message: string }) => void },
): void {
  const scoreTrace = card.scoreTrace;
  if (scoreTrace !== undefined) {
    const stages = scoreTrace.stages;
    for (const [field, legacy, explicit] of [
      ["weightedPillarMean", card.qualityScore, stages.weightedPillarMean],
      ["pegMultiplier", card.pegMultiplier, stages.pegMultiplier],
      ["preCapScore", card.pegAdjustedScore, stages.preCapScore],
      ["publishedScore", card.score, stages.publishedScore],
    ] as const) {
      if (!numbersAgree(legacy, explicit)) {
        ctx.addIssue({
          code: "custom",
          path: ["scoreTrace", "stages", field],
          message: `V9 explicit ${field} must match its retained card field`,
        });
      }
    }
    if (
      scoreTrace.aggregation !== null &&
      (
        card.weakestPillar === null ||
        scoreTrace.aggregation.weakestPillar !== card.weakestPillar.pillar ||
        !numbersAgree(scoreTrace.aggregation.weakestScore, card.weakestPillar.score) ||
        !numbersAgree(scoreTrace.aggregation.weightedPillarMean, card.qualityScore)
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["scoreTrace", "aggregation"],
        message: "V9 aggregation trace must match the card's pillar summary",
      });
    }
    if (card.grade === "F" && scoreTrace.adverseAttribution.items.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["scoreTrace", "adverseAttribution"],
        message: "A V9 F card requires causal measured-adverse attribution",
      });
    }
  }
}

function refineLegacyCard(
  card: SafetyScoreV9CardBase,
  ctx: { addIssue: (issue: { code: "custom"; path?: PropertyKey[]; message: string }) => void },
): void {
  if ((card.score === null) !== (card.grade === "NR")) {
    ctx.addIssue({ code: "custom", path: ["grade"], message: "NR grade and null score must agree" });
  }
  if (card.score !== null && Object.values(card.pillars).some((pillar) => pillar.score === null)) {
    ctx.addIssue({ code: "custom", path: ["pillars"], message: "A rated result requires all three pillars" });
  }
  if (
    card.score !== null &&
    (card.qualityScore === null || card.pegAdjustedScore === null || card.pegMultiplier === null)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["qualityScore"],
      message: "A rated result requires quality and peg-adjusted scores",
    });
  }
  if (card.score === null && card.nrReasons.length === 0) {
    ctx.addIssue({ code: "custom", path: ["nrReasons"], message: "An NR result requires an explicit reason" });
  }
  if (card.score !== null && card.nrReasons.length > 0) {
    ctx.addIssue({ code: "custom", path: ["nrReasons"], message: "A rated result cannot carry NR reasons" });
  }
  const bindingCaps = card.caps.filter((cap) => cap.binding);
  if (bindingCaps.length > 1) {
    ctx.addIssue({ code: "custom", path: ["caps"], message: "At most one V9 cap candidate may bind" });
  }
  if (
    card.bindingCap === null
      ? bindingCaps.length !== 0
      : JSON.stringify(bindingCaps) !== JSON.stringify([card.bindingCap])
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["bindingCap"],
      message: "V9 binding cap must match the binding cap candidate",
    });
  }
  if (!isUniqueSorted(card.reasonCodes)) {
    ctx.addIssue({ code: "custom", path: ["reasonCodes"], message: "V9 reason codes must be unique and sorted" });
  }
}

export const SafetyScoreV9LegacyCardSchema = SafetyScoreV9CardObjectSchema
  .superRefine((card, ctx) => refineLegacyCard(card, ctx));
export type SafetyScoreV9LegacyCard = z.infer<typeof SafetyScoreV9LegacyCardSchema>;

export const SafetyScoreV9CardSchema = z
  .object({ ...SafetyScoreV9CardShape, scoreTrace: SafetyScoreV9ScoreTraceSchema.optional() })
  .strict()
  .superRefine((card, ctx) => {
    refineLegacyCard(card, ctx);
    refineCard(card, ctx);
  });
export type SafetyScoreV9Card = z.infer<typeof SafetyScoreV9CardSchema>;

export const SafetyScoreV9CurrentCardSchema = z
  .object({
    ...SafetyScoreV9CardShape,
    scoreTrace: SafetyScoreV9ScoreTraceSchema,
  })
  .strict()
  .superRefine((card, ctx) => {
    refineLegacyCard(card, ctx);
    refineCard(card, ctx);
  });
export type SafetyScoreV9CurrentCard = z.infer<typeof SafetyScoreV9CurrentCardSchema>;

export const SafetyScoreV9CompletenessSchema = z
  .object({
    expectedCount: z.number().int().nonnegative(),
    ratedCount: z.number().int().nonnegative(),
    notRatedCount: z.number().int().nonnegative(),
    notRatedIds: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.expectedCount !== value.ratedCount + value.notRatedCount) {
      ctx.addIssue({ code: "custom", message: "V9 completeness counts do not reconcile" });
    }
    if (value.notRatedIds.length !== value.notRatedCount || !isUniqueSorted(value.notRatedIds)) {
      ctx.addIssue({ code: "custom", path: ["notRatedIds"], message: "V9 not-rated IDs do not reconcile" });
    }
  });

const SafetyScoreV9ResponseShape = {
  model: z.literal("v9-critical-path"),
  lifecycle: z.literal("candidate"),
  candidateId: z.string().min(1),
  policyVersion: CandidatePolicyVersionSchema,
  publicationGenerationId: z.string().min(1),
  baseInputGenerationId: BaseInputGenerationIdSchema,
  factSetDigest: Sha256Schema,
  resultDigest: Sha256Schema,
  policy: z.object({ id: z.string().min(1), semanticDigest: Sha256Schema }).strict(),
  evaluationBuildDigest: Sha256Schema,
  sourceGenerations: z.record(z.string().min(1), z.string().min(1)),
  asOfSec: z.number().int().nonnegative(),
  publishedAtSec: z.number().int().nonnegative(),
  completeness: SafetyScoreV9CompletenessSchema,
} as const;

function refineResponse(
  response: {
    asOfSec: number;
    publishedAtSec: number;
    completeness: z.infer<typeof SafetyScoreV9CompletenessSchema>;
    cards: readonly SafetyScoreV9CardBase[];
  },
  ctx: { addIssue: (issue: { code: "custom"; path?: PropertyKey[]; message: string }) => void },
): void {
  if (response.publishedAtSec < response.asOfSec) {
    ctx.addIssue({ code: "custom", path: ["publishedAtSec"], message: "Publication cannot predate evidence" });
  }
  if (response.cards.length !== response.completeness.expectedCount) {
    ctx.addIssue({ code: "custom", path: ["cards"], message: "V9 card set is not complete" });
  }
  const ids = response.cards.map((card) => card.id);
  if (!isUniqueSorted(ids)) {
    ctx.addIssue({ code: "custom", path: ["cards"], message: "V9 card IDs must be unique and sorted" });
  }
  const notRatedIds = response.cards.filter((card) => card.grade === "NR").map((card) => card.id);
  if (JSON.stringify(notRatedIds) !== JSON.stringify(response.completeness.notRatedIds)) {
    ctx.addIssue({ code: "custom", path: ["completeness"], message: "V9 NR membership does not reconcile" });
  }
}

/** Retained reader for persisted candidate/shadow artifacts emitted before the trace contract. */
export const SafetyScoreV9LegacyResponseSchema = z
  .object({
    ...SafetyScoreV9ResponseShape,
    schemaVersion: z.literal(1),
    cards: z.array(SafetyScoreV9LegacyCardSchema),
  })
  .strict()
  .superRefine((response, ctx) => refineResponse(response, ctx));
export type SafetyScoreV9LegacyResponse = z.infer<typeof SafetyScoreV9LegacyResponseSchema>;

/** Current pre-release envelope. Active V9 is deliberately not part of this contract. */
export const SafetyScoreV9CurrentResponseSchema = z
  .object({
    ...SafetyScoreV9ResponseShape,
    schemaVersion: z.literal(2),
    cards: z.array(SafetyScoreV9CurrentCardSchema),
  })
  .strict()
  .superRefine((response, ctx) => refineResponse(response, ctx));
export type SafetyScoreV9CurrentResponse = z.infer<typeof SafetyScoreV9CurrentResponseSchema>;

/**
 * Compatibility reader for stored shadow artifacts. New candidate production
 * must use SafetyScoreV9CurrentResponseSchema and always emits schema version 2.
 */
export const SafetyScoreV9ResponseSchema = z.union([
  SafetyScoreV9CurrentResponseSchema,
  SafetyScoreV9LegacyResponseSchema,
]);
export type SafetyScoreV9Response = Omit<
  SafetyScoreV9LegacyResponse,
  "schemaVersion" | "cards"
> & {
  schemaVersion: 1 | 2;
  cards: SafetyScoreV9Card[];
};
