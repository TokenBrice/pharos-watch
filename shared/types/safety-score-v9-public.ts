import { z } from "zod";
import { scoreToV9Grade } from "./safety-score-v9-grade";
import { V9DependencyEconomicRoleSchema } from "./dependency-types";
import {
  V9AssetPremiumKindSchema,
  V9CapSourceSchema,
  V9EvidenceLevelSchema,
  V9GradeSchema,
  V9QualityPillarSchema,
  V9ReasonCodeSchema,
  type V9ReasonCode,
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
const V9PolicyVersionSchema = z.string().regex(/^\d+\.\d+$/);
const AccessPostureFieldSchema = z.enum(["transfer", "freezeExposure", "primaryExit", "governance"]);
const RESPONSIBILITIES = [
  "integration-missing",
  "issuer-undisclosed",
  "measured-adverse",
  "method-unsupported",
  "producer-failed",
] as const;
const SCORE_TOLERANCE = 0.0002;
const EXIT_SCORE_TOLERANCE = 0.03;
const PUBLIC_SCORE_ROUNDING_HEADROOM = 0.5;
const C_MINUS_MIN_SCORE = 50;
const DANGER_PEG_MULTIPLIER_FLOOR = 0.9;
export const V9_BOUNDED_ATTRIBUTION_REASON_CODES = [
  "bounded-mechanism-review",
  "bounded-unknown-reserve-exposure",
  "incomparable-route-requests",
  "incomplete-dex-route-coverage",
  "incomplete-oracle-liquidation-branch",
  "material-bridge-supply-unmatched",
  "material-dependency-unavailable",
  "material-reserve-slice-unstructured",
  "material-unknown-reserve-exposure",
  "mint-control-question",
  "missing-applicable-peg",
  "missing-bridge-route-rows",
  "missing-bridge-routes",
  "missing-custody-profile",
  "missing-implementation-date",
  "missing-latest-assurance-report",
  "missing-mint-authority",
  "missing-oracle-profile",
  "missing-peg-input",
  "missing-required-oracle-branches",
  "missing-reserve-composition",
  "missing-runtime-route-evidence",
  "missing-same-notional-route",
  "missing-upgrade-control",
  "missing-upgradeability-review",
  "partial-reserve-review",
  "runtime-bridge-materiality-unavailable",
  "selected-bridge-route-missing",
  "selected-bridge-route-unresolved",
  "unknown-control-cap-authority",
  "unknown-control-mint-ability",
  "unknown-upgrade-authority",
  "unresolved-control-identity",
  "unresolved-mint-authority",
  "unresolved-oracle-branch-applicability",
  "unsupported-same-notional-route",
  "unreviewed-dependency-relationships",
  "unreviewed-oracle-profile",
  "unreviewed-reserve-envelope",
] as const satisfies readonly V9ReasonCode[];
const V9_BOUNDED_ATTRIBUTION_REASON_CODE_SET =
  new Set<V9ReasonCode>(V9_BOUNDED_ATTRIBUTION_REASON_CODES);

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

function roundAttributionValue(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(Number((value * factor).toPrecision(15))) / factor;
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
      "wrapper-local",
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

export const SafetyScoreV9BoundedUncertaintyAttributionItemSchema = z
  .object({
    source: z.enum(["parent-score", "reason", "wrapper-local"]),
    code: V9ReasonCodeSchema,
    path: z.string().min(1),
    message: z.string().min(1),
    responsibility: z.enum([
      "integration-missing",
      "issuer-undisclosed",
      "method-unsupported",
      "producer-failed",
    ]),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (!V9_BOUNDED_ATTRIBUTION_REASON_CODE_SET.has(item.code)) {
      ctx.addIssue({
        code: "custom",
        path: ["code"],
        message: "V9 bounded-uncertainty attribution requires a policy-bounded reason code",
      });
    }
    if (item.source === "parent-score" && !item.path.startsWith("parent:")) {
      ctx.addIssue({
        code: "custom",
        path: ["path"],
        message: "V9 parent bounded-uncertainty attribution requires a parent-prefixed path",
      });
    }
    if (item.source === "wrapper-local" && !item.path.startsWith("wrapper-local:")) {
      ctx.addIssue({
        code: "custom",
        path: ["path"],
        message: "V9 wrapper bounded-uncertainty attribution requires a wrapper-local path",
      });
    }
  });
export type SafetyScoreV9BoundedUncertaintyAttributionItem = z.infer<
  typeof SafetyScoreV9BoundedUncertaintyAttributionItemSchema
>;

export const SafetyScoreV9BoundedUncertaintyAttributionTraceSchema = z
  .object({
    semantics: z.literal("causal-bounded-uncertainty-v1"),
    items: z.array(SafetyScoreV9BoundedUncertaintyAttributionItemSchema),
  })
  .strict()
  .superRefine((attribution, ctx) => {
    const keys = attribution.items.map((item) =>
      [
        item.source,
        item.code,
        item.path,
        item.message,
        item.responsibility,
      ].join("\u0000"),
    );
    if (!isUniqueSorted(keys)) {
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: "V9 bounded-uncertainty attribution must be unique and sorted",
      });
    }
  });
export type SafetyScoreV9BoundedUncertaintyAttributionTrace = z.infer<
  typeof SafetyScoreV9BoundedUncertaintyAttributionTraceSchema
>;

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

const SafetyScoreV9ScoreAdjustmentSchema = z
  .object({
    source: z.literal("asset-premium"),
    kind: V9AssetPremiumKindSchema,
    label: z.string().min(1),
    configuredPoints: z.number().finite().positive().max(20),
    appliedPoints: z.number().finite().positive().max(20),
    scoreBefore: ScoreSchema,
    scoreAfter: ScoreSchema,
    publishedScoreBefore: ScoreSchema,
    publishedScoreAfter: ScoreSchema,
    capRelief: z
      .object({
        source: z.literal("structural"),
        kind: z.string().min(1),
        fromLimit: ScoreSchema,
        toLimit: ScoreSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((adjustment, ctx) => {
    if (!numbersAgree(adjustment.scoreAfter - adjustment.scoreBefore, adjustment.appliedPoints)) {
      ctx.addIssue({
        code: "custom",
        path: ["appliedPoints"],
        message: "V9 score adjustment points must reconcile its score stages",
      });
    }
    if (adjustment.appliedPoints > adjustment.configuredPoints + SCORE_TOLERANCE) {
      ctx.addIssue({
        code: "custom",
        path: ["appliedPoints"],
        message: "V9 score adjustment cannot exceed its configured points",
      });
    }
    if (adjustment.capRelief.fromLimit >= adjustment.capRelief.toLimit) {
      ctx.addIssue({
        code: "custom",
        path: ["capRelief"],
        message: "V9 score adjustment cap relief must increase the named limit",
      });
    }
    if (
      adjustment.publishedScoreBefore >
      adjustment.scoreBefore + PUBLIC_SCORE_ROUNDING_HEADROOM + SCORE_TOLERANCE
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["publishedScoreBefore"],
        message: "V9 ordinary published score exceeds its permitted rounding headroom",
      });
    }
    if (adjustment.publishedScoreBefore > adjustment.capRelief.fromLimit + SCORE_TOLERANCE) {
      ctx.addIssue({
        code: "custom",
        path: ["publishedScoreBefore"],
        message: "V9 ordinary published score cannot exceed the original cap limit",
      });
    }
    if (adjustment.publishedScoreAfter + SCORE_TOLERANCE < adjustment.publishedScoreBefore) {
      ctx.addIssue({
        code: "custom",
        path: ["publishedScoreAfter"],
        message: "V9 score adjustment cannot reduce the published score",
      });
    }
    if (adjustment.publishedScoreAfter > adjustment.capRelief.toLimit + SCORE_TOLERANCE) {
      ctx.addIssue({
        code: "custom",
        path: ["publishedScoreAfter"],
        message: "V9 score adjustment cannot publish above its relieved cap",
      });
    }
  });

const SafetyScoreV9ScoreTraceCommonSchema = z
  .object({
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
  .strict();
type SafetyScoreV9ScoreTraceCommon = z.infer<typeof SafetyScoreV9ScoreTraceCommonSchema>;
const SafetyScoreV9AdjustedScoreTraceCommonSchema =
  SafetyScoreV9ScoreTraceCommonSchema
    .extend({
      scoreAdjustments: z.array(SafetyScoreV9ScoreAdjustmentSchema).max(1),
    })
    .strict();
type SafetyScoreV9AdjustedScoreTraceCommon = z.infer<
  typeof SafetyScoreV9AdjustedScoreTraceCommonSchema
>;

function refineScoreTraceBaseStages(
  trace: SafetyScoreV9ScoreTraceCommon,
  ctx: z.RefinementCtx,
): void {
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
}

function refineUnadjustedScoreTrace(
  trace: SafetyScoreV9ScoreTraceCommon,
  ctx: z.RefinementCtx,
): void {
  refineScoreTraceBaseStages(trace, ctx);
  if (!numbersAgree(trace.stages.deploymentAdjustedScore, trace.stages.preCapScore)) {
    ctx.addIssue({
      code: "custom",
      path: ["stages", "preCapScore"],
      message: "V9 pre-cap score must match the post-deployment score",
    });
  }
}

function refineAdjustedScoreTrace(
  trace: SafetyScoreV9AdjustedScoreTraceCommon,
  ctx: z.RefinementCtx,
): void {
  refineScoreTraceBaseStages(trace, ctx);
  let expectedPreCapScore = trace.stages.deploymentAdjustedScore;
  for (const [index, adjustment] of trace.scoreAdjustments.entries()) {
    if (!numbersAgree(expectedPreCapScore, adjustment.scoreBefore)) {
      ctx.addIssue({
        code: "custom",
        path: ["scoreAdjustments", index, "scoreBefore"],
        message: "V9 score adjustment must start from the preceding score stage",
      });
    }
    expectedPreCapScore = adjustment.scoreAfter;
  }
  if (!numbersAgree(expectedPreCapScore, trace.stages.preCapScore)) {
    ctx.addIssue({
      code: "custom",
      path: ["stages", "preCapScore"],
      message: "V9 pre-cap score must match the final score-adjustment stage",
    });
  }
  const finalAdjustment =
    trace.scoreAdjustments[trace.scoreAdjustments.length - 1];
  if (
    finalAdjustment !== undefined &&
    !numbersAgree(trace.stages.publishedScore, finalAdjustment.publishedScoreAfter)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["stages", "publishedScore"],
      message: "V9 published score must match the final score adjustment",
    });
  }
}

function refineBoundedUncertaintyTrace(
  trace: {
    boundedUncertaintyAttribution: z.infer<
      typeof SafetyScoreV9BoundedUncertaintyAttributionTraceSchema
    >;
    evidenceResponsibility: z.infer<
      typeof SafetyScoreV9EvidenceResponsibilityTraceSchema
    >;
  },
  ctx: z.RefinementCtx,
): void {
  const responsibilityByName = new Map(
    trace.evidenceResponsibility.summaries.map((summary) => [
      summary.responsibility,
      summary,
    ]),
  );
  for (const item of trace.boundedUncertaintyAttribution.items) {
    if (item.source !== "reason") continue;
    const summary = responsibilityByName.get(item.responsibility);
    if (
      summary === undefined ||
      summary.factCount === 0 ||
      !summary.reasonCodes.includes(item.code)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["boundedUncertaintyAttribution", "items"],
        message:
          "V9 direct bounded-uncertainty attribution must reconcile to an owned unresolved fact",
      });
    }
  }
}

/** Strict reader for schema-v1 traces persisted before bounded D attribution. */
export const SafetyScoreV9PreviousScoreTraceSchema =
  SafetyScoreV9ScoreTraceCommonSchema
    .extend({ schemaVersion: z.literal(1) })
    .strict()
    .superRefine(refineUnadjustedScoreTrace);
export type SafetyScoreV9PreviousScoreTrace = z.infer<
  typeof SafetyScoreV9PreviousScoreTraceSchema
>;

/** Retained trace-v2 reader for causal bounded-D attribution. */
export const SafetyScoreV9CausalScoreTraceSchema =
  SafetyScoreV9ScoreTraceCommonSchema
    .extend({
      schemaVersion: z.literal(2),
      boundedUncertaintyAttribution:
        SafetyScoreV9BoundedUncertaintyAttributionTraceSchema,
    })
    .strict()
    .superRefine((trace, ctx) => {
      refineUnadjustedScoreTrace(trace, ctx);
      refineBoundedUncertaintyTrace(trace, ctx);
    });
export type SafetyScoreV9CausalScoreTrace = z.infer<
  typeof SafetyScoreV9CausalScoreTraceSchema
>;

/** Current trace. Schema v3 adds explicit policy-defined score adjustments. */
export const SafetyScoreV9ScoreTraceSchema =
  SafetyScoreV9AdjustedScoreTraceCommonSchema
    .extend({
      schemaVersion: z.literal(3),
      boundedUncertaintyAttribution:
        SafetyScoreV9BoundedUncertaintyAttributionTraceSchema,
    })
    .strict()
    .superRefine((trace, ctx) => {
      refineAdjustedScoreTrace(trace, ctx);
      refineBoundedUncertaintyTrace(trace, ctx);
    });
export type SafetyScoreV9ScoreTrace = z.infer<typeof SafetyScoreV9ScoreTraceSchema>;

export const SafetyScoreV9PillarAdjustmentSchema = z
  .object({
    kind: z.enum(["operational-resilience-credit", "dependency-limit"]),
    scoreBefore: ScoreSchema,
    scoreAfter: ScoreSchema,
    delta: z.number().finite().min(-100).max(100),
  })
  .strict()
  .superRefine((adjustment, ctx) => {
    if (!numbersAgree(adjustment.scoreAfter - adjustment.scoreBefore, adjustment.delta)) {
      ctx.addIssue({
        code: "custom",
        path: ["delta"],
        message: "V9 pillar adjustment delta must reconcile its score stages",
      });
    }
    if (
      adjustment.kind === "operational-resilience-credit" &&
      adjustment.delta <= 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["delta"],
        message: "V9 operational-resilience credit must increase the pillar score",
      });
    }
    if (adjustment.kind === "dependency-limit" && adjustment.delta >= 0) {
      ctx.addIssue({
        code: "custom",
        path: ["delta"],
        message: "V9 dependency limit must reduce the pillar score",
      });
    }
  });
export type SafetyScoreV9PillarAdjustment = z.infer<
  typeof SafetyScoreV9PillarAdjustmentSchema
>;

const SafetyScoreV9BreakdownPillarBaseShape = {
  evaluatedScore: ScoreSchema,
  publishedScore: ScoreSchema,
  aggregationWeight: z.number().finite().min(0).max(1),
  adjustments: z.array(SafetyScoreV9PillarAdjustmentSchema).max(2),
} as const;

function refineBreakdownAdjustments(
  breakdown: {
    evaluatedScore: number;
    publishedScore: number;
    adjustments: readonly {
      kind: "operational-resilience-credit" | "dependency-limit";
      scoreBefore: number;
      scoreAfter: number;
      delta: number;
    }[];
  },
  ctx: z.RefinementCtx,
): void {
  const kinds = breakdown.adjustments.map((adjustment) => adjustment.kind);
  const canonicalKinds = [
    "operational-resilience-credit",
    "dependency-limit",
  ].filter((kind) => kinds.includes(kind as (typeof kinds)[number]));
  if (
    new Set(kinds).size !== kinds.length ||
    JSON.stringify(kinds) !== JSON.stringify(canonicalKinds)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["adjustments"],
      message: "V9 pillar adjustments must be unique and in score-stage order",
    });
  }
  let expectedScore = breakdown.evaluatedScore;
  for (const [index, adjustment] of breakdown.adjustments.entries()) {
    if (!numbersAgree(expectedScore, adjustment.scoreBefore)) {
      ctx.addIssue({
        code: "custom",
        path: ["adjustments", index, "scoreBefore"],
        message: "V9 pillar adjustment must begin at the preceding score stage",
      });
    }
    expectedScore = adjustment.scoreAfter;
  }
  if (!numbersAgree(expectedScore, breakdown.publishedScore)) {
    ctx.addIssue({
      code: "custom",
      path: ["publishedScore"],
      message: "V9 pillar adjustments must reconcile evaluated and published scores",
    });
  }
}

export const SafetyScoreV9BackingBreakdownSchema = z
  .object({
    ...SafetyScoreV9BreakdownPillarBaseShape,
    groups: z.array(
      z
        .object({
          key: z.enum(["reserves", "mechanism"]),
          label: z.string().min(1).max(120),
          score: ScoreSchema,
          effectiveWeight: z.number().finite().min(0).max(1),
        })
        .strict(),
    ),
    components: z.array(
      z
        .object({
          key: z.string().min(1),
          label: z.string().min(1).max(160),
          source: z.enum(["reserve-exposure", "reserve-concentration", "mechanism"]),
          score: ScoreSchema,
          effectiveWeight: z.number().finite().min(0).max(1),
          weightedContribution: ScoreSchema,
          observationState: z.enum(["known", "missing", "stale", "unsupported", "bounded-unknown"]),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((breakdown, ctx) => {
    refineBreakdownAdjustments(breakdown, ctx);
    const groupKeys = breakdown.groups.map((group) => group.key);
    const expectedGroupKeys = ["reserves", "mechanism"].filter((key) =>
      groupKeys.includes(key as (typeof groupKeys)[number]),
    );
    if (
      new Set(groupKeys).size !== groupKeys.length ||
      JSON.stringify(groupKeys) !== JSON.stringify(expectedGroupKeys)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["groups"],
        message: "V9 backing groups must be unique and in canonical order",
      });
    }
    const componentKeys = breakdown.components.map((component) => component.key);
    if (!isUniqueSorted(componentKeys)) {
      ctx.addIssue({
        code: "custom",
        path: ["components"],
        message: "V9 backing components must be unique and sorted",
      });
    }
    const totalWeight = breakdown.components.reduce(
      (sum, component) => sum + component.effectiveWeight,
      0,
    );
    const totalContribution = breakdown.components.reduce(
      (sum, component) => sum + component.weightedContribution,
      0,
    );
    if (
      !numbersAgree(totalWeight, 1) ||
      !numbersAgree(totalContribution, breakdown.evaluatedScore)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["components"],
        message: "V9 backing components must reconcile effective weights and evaluated score",
      });
    }
    breakdown.components.forEach((component, index) => {
      if (
        !numbersAgree(
          component.weightedContribution,
          component.score * component.effectiveWeight,
        )
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["components", index, "weightedContribution"],
          message: "V9 backing weighted contribution must equal score times effective weight",
        });
      }
    });
  });
export type SafetyScoreV9BackingBreakdown = z.infer<
  typeof SafetyScoreV9BackingBreakdownSchema
>;

const EXIT_COMPONENT_KEYS = [
  "access",
  "settlement",
  "executionCertainty",
  "capacity",
  "outputAssetQuality",
  "cost",
] as const;

export const SafetyScoreV9ExitBreakdownSchema = z
  .object({
    ...SafetyScoreV9BreakdownPillarBaseShape,
    stressRequest: z
      .object({
        requestedNotionalUsd: z.number().finite().positive(),
        maxCostBps: z.number().finite().nonnegative(),
        comparisonWindowSec: z.number().finite().positive(),
      })
      .strict()
      .nullable(),
    primaryRoute: z
      .object({
        key: z.string().min(1),
        label: z.string().min(1).max(160),
        routeFamily: z.enum([
          "dex-amm",
          "dex-orderbook",
          "issuer-redemption",
          "protocol-redemption",
          "eventual-redemption",
        ]),
        score: ScoreSchema,
        components: z.array(
          z
            .object({
              key: z.enum(EXIT_COMPONENT_KEYS),
              label: z.string().min(1).max(120),
              score: ScoreSchema,
              weight: z.number().finite().min(0).max(1),
              weightedContribution: ScoreSchema,
            })
            .strict(),
        ).length(EXIT_COMPONENT_KEYS.length),
        confidenceFactor: z.number().finite().min(0).max(1),
        eligibilityMultiplier: z.number().finite().min(0).max(1),
        capsApplied: z.array(z.string().min(1)),
      })
      .strict()
      .nullable(),
    diversification: z
      .object({
        routeKey: z.string().min(1),
        routeLabel: z.string().min(1).max(160),
        bonus: ScoreSchema,
      })
      .strict()
      .nullable(),
    alternatives: z.array(
      z
        .object({
          key: z.string().min(1),
          label: z.string().min(1).max(160),
          routeFamily: z.enum([
            "dex-amm",
            "dex-orderbook",
            "issuer-redemption",
            "protocol-redemption",
            "eventual-redemption",
          ]),
          score: ScoreSchema.nullable(),
          included: z.boolean(),
          exclusionReason: V9ReasonCodeSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((breakdown, ctx) => {
    refineBreakdownAdjustments(breakdown, ctx);
    if (breakdown.primaryRoute === null) return;
    const keys = breakdown.primaryRoute.components.map((component) => component.key);
    if (JSON.stringify(keys) !== JSON.stringify(EXIT_COMPONENT_KEYS)) {
      ctx.addIssue({
        code: "custom",
        path: ["primaryRoute", "components"],
        message: "V9 exit components must use canonical policy order",
      });
    }
    const totalWeight = breakdown.primaryRoute.components.reduce(
      (sum, component) => sum + component.weight,
      0,
    );
    if (!numbersAgree(totalWeight, 1)) {
      ctx.addIssue({
        code: "custom",
        path: ["primaryRoute", "components"],
        message: "V9 exit component weights must sum to one",
      });
    }
    breakdown.primaryRoute.components.forEach((component, index) => {
      if (!numbersAgree(component.weightedContribution, component.score * component.weight)) {
        ctx.addIssue({
          code: "custom",
          path: ["primaryRoute", "components", index, "weightedContribution"],
          message: "V9 exit weighted contribution must equal score times weight",
        });
      }
    });
    if (!isUniqueSorted(breakdown.primaryRoute.capsApplied)) {
      ctx.addIssue({
        code: "custom",
        path: ["primaryRoute", "capsApplied"],
        message: "V9 primary-route caps must be unique and sorted",
      });
    }
    const weightedComponentScore = breakdown.primaryRoute.components.reduce(
      (sum, component) => sum + component.weightedContribution,
      0,
    );
    const preCapRouteScore =
      weightedComponentScore *
      breakdown.primaryRoute.confidenceFactor *
      breakdown.primaryRoute.eligibilityMultiplier;
    const routeScoreReconciles =
      breakdown.primaryRoute.capsApplied.length === 0
        ? Math.abs(breakdown.primaryRoute.score - preCapRouteScore) <= EXIT_SCORE_TOLERANCE
        : breakdown.primaryRoute.score <= preCapRouteScore + EXIT_SCORE_TOLERANCE;
    if (!routeScoreReconciles) {
      ctx.addIssue({
        code: "custom",
        path: ["primaryRoute", "score"],
        message: "V9 primary-route score must reconcile its components, multipliers, and caps",
      });
    }
    const expectedEvaluatedScore =
      breakdown.primaryRoute.score + (breakdown.diversification?.bonus ?? 0);
    if (Math.abs(breakdown.evaluatedScore - expectedEvaluatedScore) > EXIT_SCORE_TOLERANCE) {
      ctx.addIssue({
        code: "custom",
        path: ["evaluatedScore"],
        message: "V9 exit score must reconcile its primary route and diversification bonus",
      });
    }
    const alternativeKeys = breakdown.alternatives.map((route) => route.key);
    if (!isUniqueSorted(alternativeKeys) || alternativeKeys.includes(breakdown.primaryRoute.key)) {
      ctx.addIssue({
        code: "custom",
        path: ["alternatives"],
        message: "V9 alternative exit routes must be unique, sorted, and exclude the primary route",
      });
    }
  });
export type SafetyScoreV9ExitBreakdown = z.infer<
  typeof SafetyScoreV9ExitBreakdownSchema
>;

export const SafetyScoreV9ControlBreakdownSchema = z
  .object({
    ...SafetyScoreV9BreakdownPillarBaseShape,
    method: z.literal("minimum-binding-component"),
    components: z.array(
      z
        .object({
          key: z.string().min(1),
          label: z.string().min(1).max(160),
          kind: z.enum(["mint", "oracle", "bridge"]),
          score: ScoreSchema,
          binding: z.boolean(),
          posture: z.string().min(1).max(120),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((breakdown, ctx) => {
    refineBreakdownAdjustments(breakdown, ctx);
    const keys = breakdown.components.map((component) => component.key);
    if (!isUniqueSorted(keys)) {
      ctx.addIssue({
        code: "custom",
        path: ["components"],
        message: "V9 control components must be unique and sorted",
      });
    }
    const binding = breakdown.components.filter((component) => component.binding);
    if (
      binding.length === 0 ||
      !numbersAgree(
        Math.min(...binding.map((component) => component.score)),
        breakdown.evaluatedScore,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["components"],
        message: "V9 binding controls must reconcile the minimum-component evaluated score",
      });
    }
  });
export type SafetyScoreV9ControlBreakdown = z.infer<
  typeof SafetyScoreV9ControlBreakdownSchema
>;

export const SafetyScoreV9BreakdownsSchema = z
  .object({
    backing: SafetyScoreV9BackingBreakdownSchema,
    exit: SafetyScoreV9ExitBreakdownSchema,
    control: SafetyScoreV9ControlBreakdownSchema,
  })
  .strict();
export type SafetyScoreV9Breakdowns = z.infer<typeof SafetyScoreV9BreakdownsSchema>;

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

function attributedSerialParent(
  card: SafetyScoreV9CardBase,
  path: string,
  message: string,
): SafetyScoreV9CardBase["dependencies"]["serial"][number] | null {
  const parent = [...card.dependencies.serial]
    .sort((left, right) => right.upstreamAssetId.length - left.upstreamAssetId.length)
    .find((dependency) => {
      const pathPrefix = `parent:${dependency.upstreamAssetId}:`;
      const messagePrefix = `Required parent ${dependency.upstreamAssetId}: `;
      return path.startsWith(pathPrefix) && message.startsWith(messagePrefix);
    });
  return parent ?? null;
}

function refineCard(
  card: SafetyScoreV9CardBase & {
    scoreTrace?: SafetyScoreV9ScoreTrace | SafetyScoreV9CausalScoreTrace;
  },
  ctx: { addIssue: (issue: { code: "custom"; path?: PropertyKey[]; message: string }) => void },
): void {
  const scoreTrace = card.scoreTrace;
  if (scoreTrace !== undefined) {
    const stages = scoreTrace.stages;
    const serialParents = card.dependencies.serial;
    const serialParentsResolved =
      serialParents.length > 0 &&
      !card.dependencies.cycleBlocked &&
      serialParents.every((dependency) => !dependency.blocked && dependency.score !== null);
    const rawParentScore = serialParentsResolved
      ? Math.min(...serialParents.map((dependency) => dependency.score!))
      : null;
    const wrapperParentLimit = scoreTrace.wrapperParentLimit;
    const parentCaps = card.caps.filter((cap) => cap.source === "parent");
    if (
      wrapperParentLimit !== null &&
      (
        rawParentScore === null ||
        !numbersAgree(wrapperParentLimit.parentScore, rawParentScore) ||
        parentCaps.length !== 1 ||
        parentCaps[0]!.kind !== "parent" ||
        !numbersAgree(parentCaps[0]!.limit, wrapperParentLimit.limit)
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["scoreTrace", "wrapperParentLimit"],
        message: "V9 wrapper parent limit must reconcile to the resolved minimum serial parent and parent cap",
      });
    }
    if (
      card.bindingCap?.source === "parent" &&
      (
        card.bindingCap.kind !== "parent" ||
        rawParentScore === null ||
        !numbersAgree(
          card.bindingCap.limit,
          wrapperParentLimit?.limit ?? rawParentScore,
        )
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["bindingCap"],
        message: "V9 binding parent cap must reconcile to the resolved minimum serial parent",
      });
    }
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
    if ("scoreAdjustments" in scoreTrace) {
      for (const [index, adjustment] of scoreTrace.scoreAdjustments.entries()) {
        const relievedCaps = card.caps.filter(
          (cap) =>
            cap.source === adjustment.capRelief.source &&
            cap.kind === adjustment.capRelief.kind,
        );
        if (
          relievedCaps.length !== 1 ||
          !numbersAgree(relievedCaps[0]!.limit, adjustment.capRelief.toLimit)
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "scoreAdjustments", index, "capRelief"],
            message: "V9 score adjustment cap relief must match exactly one current card cap",
          });
        }
        const unchangedCaps = card.caps.filter(
          (cap) =>
            cap.source !== adjustment.capRelief.source ||
            cap.kind !== adjustment.capRelief.kind,
        );
        if (
          unchangedCaps.some(
            (cap) => adjustment.publishedScoreBefore > cap.limit + SCORE_TOLERANCE,
          )
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "scoreAdjustments", index, "publishedScoreBefore"],
            message: "V9 ordinary published score cannot exceed an unchanged card cap",
          });
        }
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
    for (const item of scoreTrace.adverseAttribution.items) {
      if (
        item.source === "active-depeg" &&
        (card.bindingCap?.source !== "active-depeg" || item.path !== "peg:active-depeg")
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["scoreTrace", "adverseAttribution", "items"],
          message: "V9 active-depeg attribution requires its canonical path and a binding active-depeg cap",
        });
      }
      if (item.source === "parent-score") {
        const parent = attributedSerialParent(card, item.path, item.message);
        if (
          card.bindingCap?.source !== "parent" ||
          parent === null ||
          parent.blocked ||
          parent.score === null ||
          parent.score >= C_MINUS_MIN_SCORE ||
          rawParentScore === null ||
          !numbersAgree(parent.score, rawParentScore)
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "adverseAttribution", "items"],
            message: "V9 parent attribution requires the binding low minimum serial parent",
          });
        }
      }
      if (item.source === "peg-performance") {
        const pegMultiplier = stages.pegMultiplier;
        const expectedMessage =
          pegMultiplier === null
            ? null
            : `Measured peg multiplier is ${roundAttributionValue(pegMultiplier, 6)}.`;
        if (
          pegMultiplier === null ||
          pegMultiplier >= DANGER_PEG_MULTIPLIER_FLOOR ||
          item.path !== "peg:historical-performance" ||
          item.message !== expectedMessage
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "adverseAttribution", "items"],
            message: "V9 peg-performance attribution must match the measured danger multiplier",
          });
        }
      }
      if (item.source === "pillar-score") {
        const match = /^pillar:(backing|exit|control):/.exec(item.path);
        const pillarScore =
          match === null
            ? null
            : card.pillars[match[1] as "backing" | "exit" | "control"].score;
        if (
          match === null ||
          pillarScore === null ||
          ((card.grade === "D" || card.grade === "F") &&
            pillarScore >= C_MINUS_MIN_SCORE)
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "adverseAttribution", "items"],
            message: "V9 pillar attribution must name a score-bearing causal pillar",
          });
        }
      }
      if (item.source === "reason") {
        const matchingPillarReasonCodes = Object.values(card.pillars).flatMap(
          (pillar) =>
            pillar.score !== null && pillar.score < C_MINUS_MIN_SCORE
              ? pillar.reasons
                  .filter(
                    (reason) =>
                      reason.path === item.path &&
                      reason.message === item.message,
                  )
                  .map((reason) => reason.code)
              : [],
        );
        const bindingReasonCode =
          card.bindingCap?.source === "evidence" &&
          card.bindingCap.kind.startsWith("reason:") &&
          card.bindingCap.reason === item.message
            ? V9ReasonCodeSchema.safeParse(
                card.bindingCap.kind.slice("reason:".length),
              )
            : null;
        const matchingReasonCodes = [
          ...new Set([
            ...matchingPillarReasonCodes,
            ...(bindingReasonCode?.success ? [bindingReasonCode.data] : []),
          ]),
        ];
        if (matchingReasonCodes.length === 0) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "adverseAttribution", "items"],
            message: "V9 reason attribution must match a low pillar reason or binding evidence cap",
          });
        }
        if (
          matchingReasonCodes.length > 0 &&
          matchingReasonCodes.every((code) =>
            V9_BOUNDED_ATTRIBUTION_REASON_CODE_SET.has(code),
          )
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "adverseAttribution", "items"],
            message: "V9 measured-adverse reason attribution requires a non-bounded policy reason code",
          });
        }
        const conflictsWithBoundedAttribution =
          scoreTrace.boundedUncertaintyAttribution.items.some(
            (candidate) =>
              candidate.path === item.path &&
              candidate.message === item.message,
          );
        if (conflictsWithBoundedAttribution) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "adverseAttribution", "items"],
            message: "V9 measured-adverse reason attribution cannot also be declared as bounded uncertainty",
          });
        }
        const measuredSummary =
          scoreTrace.evidenceResponsibility.summaries.find(
            (summary) => summary.responsibility === "measured-adverse",
          );
        if (
          measuredSummary === undefined ||
          measuredSummary.factCount === 0 ||
          !matchingReasonCodes.some((code) =>
            measuredSummary.reasonCodes.includes(code),
          )
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "adverseAttribution", "items"],
            message: "V9 reason attribution must reconcile to a measured-adverse evidence reason code",
          });
        }
      }
      if (
        item.source === "structural-signal" &&
        !/^structural:[a-z0-9-]+:(low|moderate|high|critical)$/.test(item.path) &&
        !/^scenario-(cap|pillar):/.test(item.path)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["scoreTrace", "adverseAttribution", "items"],
          message: "V9 structural attribution requires a canonical structural or scenario path",
        });
      }
      if (item.source === "track-record") {
        ctx.addIssue({
          code: "custom",
          path: ["scoreTrace", "adverseAttribution", "items"],
          message: "V9 track-record ceilings cannot authorize measured-adverse attribution",
        });
      }
      if (item.source === "wrapper-local") {
        const limit = scoreTrace.wrapperParentLimit;
        const adjustment = limit?.adjustments.find(
          (candidate) =>
            item.path === `wrapper-local:${candidate.factKey}` &&
            candidate.discountPoints > 0,
        );
        const expectedMessage =
          adjustment === undefined
            ? null
            : `Reviewed wrapper-local ${adjustment.factKey} risk contributes ` +
              `${adjustment.discountPoints} discount points.`;
        if (
          card.bindingCap?.source !== "parent" ||
          limit === null ||
          (!limit.factsComplete &&
            limit.localRiskDiscount < limit.fallbackDiscount) ||
          adjustment === undefined ||
          item.message !== expectedMessage
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "adverseAttribution", "items"],
            message: "V9 wrapper adverse attribution must reconcile to a binding reviewed local-risk discount",
          });
        }
      }
    }
    for (const item of scoreTrace.boundedUncertaintyAttribution.items) {
      if (item.source === "reason") {
        const matchesPillarReason = Object.values(card.pillars).some((pillar) =>
          pillar.score !== null &&
          pillar.score < C_MINUS_MIN_SCORE &&
          pillar.reasons.some(
            (reason) =>
              reason.code === item.code &&
              reason.path === item.path &&
              reason.message === item.message,
          ),
        );
        const matchesBindingReasonCap =
          card.bindingCap?.source === "evidence" &&
          card.bindingCap.kind === `reason:${item.code}` &&
          card.bindingCap.reason === item.message;
        if (!matchesPillarReason && !matchesBindingReasonCap) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "boundedUncertaintyAttribution", "items"],
            message: "V9 direct bounded attribution must match a low pillar reason or binding reason cap",
          });
        }
      } else if (item.source === "parent-score") {
        const parent = attributedSerialParent(card, item.path, item.message);
        if (
          card.bindingCap?.source !== "parent" ||
          parent === null ||
          parent.blocked ||
          parent.score === null ||
          parent.score >= C_MINUS_MIN_SCORE ||
          rawParentScore === null ||
          !numbersAgree(parent.score, rawParentScore)
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "boundedUncertaintyAttribution", "items"],
            message: "V9 parent bounded attribution requires the binding low minimum serial parent",
          });
        }
      } else {
        const limit = scoreTrace.wrapperParentLimit;
        const missingFact = limit?.missingFacts.find(
          (candidate) =>
            item.path === `wrapper-local:${candidate.factClass}` &&
            item.responsibility === candidate.disposition,
        );
        const expectedMessage =
          missingFact === undefined || limit === null
            ? null
            : `Wrapper-local ${missingFact.factClass} is ${missingFact.disposition}; ` +
              `the ${limit.form} fallback discount bounds the unresolved local layer.`;
        if (
          item.code !== "bounded-mechanism-review" ||
          card.bindingCap?.source !== "parent" ||
          limit === null ||
          limit.factsComplete ||
          limit.fallbackDiscount <= limit.localRiskDiscount ||
          missingFact === undefined ||
          item.message !== expectedMessage
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["scoreTrace", "boundedUncertaintyAttribution", "items"],
            message: "V9 wrapper bounded attribution must reconcile to a binding fallback discount",
          });
        }
      }
    }
    if (
      card.score !== null &&
      scoreTrace.evidenceResponsibility.summaries.some(
        (summary) => summary.criticalFactCount > 0,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["scoreTrace", "evidenceResponsibility"],
        message: "A rated V9 card cannot retain critical unresolved facts",
      });
    }
    if (
      card.grade === "D" &&
      scoreTrace.adverseAttribution.items.length === 0 &&
      scoreTrace.boundedUncertaintyAttribution.items.length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["scoreTrace", "boundedUncertaintyAttribution"],
        message: "A V9 D card requires causal measured-adverse or bounded-uncertainty attribution",
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
  if (card.score !== null && card.grade !== scoreToV9Grade(card.score)) {
    ctx.addIssue({
      code: "custom",
      path: ["grade"],
      message: "V9 numeric score and grade band must agree",
    });
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

export const SafetyScoreV9PreviousCardSchema = z
  .object({
    ...SafetyScoreV9CardShape,
    scoreTrace: SafetyScoreV9PreviousScoreTraceSchema,
  })
  .strict()
  .superRefine((card, ctx) => refineLegacyCard(card, ctx));
export type SafetyScoreV9PreviousCard = z.infer<
  typeof SafetyScoreV9PreviousCardSchema
>;

export const SafetyScoreV9CausalCardSchema = z
  .object({
    ...SafetyScoreV9CardShape,
    scoreTrace: SafetyScoreV9CausalScoreTraceSchema,
  })
  .strict()
  .superRefine((card, ctx) => {
    refineLegacyCard(card, ctx);
    refineCard(card, ctx);
  });
export type SafetyScoreV9CausalCard = z.infer<
  typeof SafetyScoreV9CausalCardSchema
>;

/** Retained reader for candidate-v4/report-v3 cards emitted before component breakdowns. */
export const SafetyScoreV9PreBreakdownCardSchema = z
  .object({
    ...SafetyScoreV9CardShape,
    scoreTrace: SafetyScoreV9ScoreTraceSchema,
  })
  .strict()
  .superRefine((card, ctx) => {
    refineLegacyCard(card, ctx);
    refineCard(card, ctx);
  });
export type SafetyScoreV9PreBreakdownCard = z.infer<
  typeof SafetyScoreV9PreBreakdownCardSchema
>;

export const SafetyScoreV9CurrentCardSchema = z
  .object({
    ...SafetyScoreV9CardShape,
    scoreTrace: SafetyScoreV9ScoreTraceSchema,
    breakdowns: SafetyScoreV9BreakdownsSchema.nullable(),
  })
  .strict()
  .superRefine((card, ctx) => {
    refineLegacyCard(card, ctx);
    refineCard(card, ctx);
    if ((card.breakdowns === null) !== (card.grade === "NR")) {
      ctx.addIssue({
        code: "custom",
        path: ["breakdowns"],
        message: "V9 component breakdowns are required exactly when a card is rateable",
      });
    }
    if (card.breakdowns !== null) {
      for (const pillar of ["backing", "exit", "control"] as const) {
        if (
          !numbersAgree(card.breakdowns[pillar].publishedScore, card.pillars[pillar].score)
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["breakdowns", pillar, "publishedScore"],
            message: "V9 breakdown published score must match the public pillar",
          });
        }
      }
    }
  });
export type SafetyScoreV9CurrentCard = z.infer<typeof SafetyScoreV9CurrentCardSchema>;

export const SafetyScoreV9CardSchema = z.union([
  SafetyScoreV9CurrentCardSchema,
  SafetyScoreV9PreBreakdownCardSchema,
  SafetyScoreV9CausalCardSchema,
  SafetyScoreV9PreviousCardSchema,
  SafetyScoreV9LegacyCardSchema,
]);
export type SafetyScoreV9Card = z.infer<typeof SafetyScoreV9CardSchema>;

export interface SafetyScoreV9ParentAttributionIssue {
  cardId: string;
  message: string;
}

export function findSafetyScoreV9ParentAttributionIssues(
  cards: readonly (SafetyScoreV9CurrentCard | SafetyScoreV9CausalCard)[],
): SafetyScoreV9ParentAttributionIssue[] {
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  const issues: SafetyScoreV9ParentAttributionIssue[] = [];
  for (const card of cards) {
    for (const item of card.scoreTrace.adverseAttribution.items) {
      if (item.source !== "parent-score") continue;
      const parent = attributedSerialParent(card, item.path, item.message);
      if (parent === null) continue;
      const pathPrefix = `parent:${parent.upstreamAssetId}:`;
      const messagePrefix = `Required parent ${parent.upstreamAssetId}: `;
      const upstream = cardsById.get(parent.upstreamAssetId);
      const matches = upstream?.scoreTrace.adverseAttribution.items.some(
        (candidate) =>
          candidate.path === item.path.slice(pathPrefix.length) &&
          candidate.message === item.message.slice(messagePrefix.length),
      );
      if (!matches) {
        issues.push({
          cardId: card.id,
          message: `Parent adverse attribution does not reconcile to ${parent.upstreamAssetId}`,
        });
      }
    }
    for (const item of card.scoreTrace.boundedUncertaintyAttribution.items) {
      if (item.source !== "parent-score") continue;
      const parent = attributedSerialParent(card, item.path, item.message);
      if (parent === null) continue;
      const pathPrefix = `parent:${parent.upstreamAssetId}:`;
      const messagePrefix = `Required parent ${parent.upstreamAssetId}: `;
      const upstream = cardsById.get(parent.upstreamAssetId);
      const matches = upstream?.scoreTrace.boundedUncertaintyAttribution.items.some(
        (candidate) =>
          candidate.code === item.code &&
          candidate.path === item.path.slice(pathPrefix.length) &&
          candidate.message === item.message.slice(messagePrefix.length) &&
          candidate.responsibility === item.responsibility,
      );
      if (!matches) {
        issues.push({
          cardId: card.id,
          message: `Parent bounded attribution does not reconcile to ${parent.upstreamAssetId}`,
        });
      }
    }
  }
  return issues;
}

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
  lifecycle: z.literal("active"),
  candidateId: z.string().min(1),
  policyVersion: V9PolicyVersionSchema,
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
const SafetyScoreV9HistoricalResponseShape = {
  ...SafetyScoreV9ResponseShape,
  lifecycle: z.literal("candidate"),
  policyVersion: CandidatePolicyVersionSchema,
} as const;

function refineResponse(
  response: {
    asOfSec: number;
    publishedAtSec: number;
    completeness: z.infer<typeof SafetyScoreV9CompletenessSchema>;
    cards: readonly (SafetyScoreV9CardBase & {
      scoreTrace?:
        | SafetyScoreV9ScoreTrace
        | SafetyScoreV9CausalScoreTrace
        | SafetyScoreV9PreviousScoreTrace;
    })[];
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
  const currentCards = response.cards.filter(
    (
      card,
    ): card is SafetyScoreV9CurrentCard | SafetyScoreV9CausalCard =>
      card.scoreTrace?.schemaVersion === 2 ||
      card.scoreTrace?.schemaVersion === 3,
  );
  for (const issue of findSafetyScoreV9ParentAttributionIssues(currentCards)) {
    ctx.addIssue({
      code: "custom",
      path: ["cards"],
      message: `${issue.cardId}: ${issue.message}`,
    });
  }
}

/** Retained reader for persisted candidate/shadow artifacts emitted before the trace contract. */
export const SafetyScoreV9LegacyResponseSchema = z
  .object({
    ...SafetyScoreV9HistoricalResponseShape,
    schemaVersion: z.literal(1),
    cards: z.array(SafetyScoreV9LegacyCardSchema),
  })
  .strict()
  .superRefine((response, ctx) => refineResponse(response, ctx));
export type SafetyScoreV9LegacyResponse = z.infer<typeof SafetyScoreV9LegacyResponseSchema>;

/** Compatibility reader for schema-v2 envelopes carrying schema-v1 traces. */
export const SafetyScoreV9PreviousResponseSchema = z
  .object({
    ...SafetyScoreV9HistoricalResponseShape,
    schemaVersion: z.literal(2),
    cards: z.array(SafetyScoreV9PreviousCardSchema),
  })
  .strict()
  .superRefine((response, ctx) => refineResponse(response, ctx));
export type SafetyScoreV9PreviousResponse = z.infer<
  typeof SafetyScoreV9PreviousResponseSchema
>;

/** Compatibility reader for schema-v3 envelopes carrying causal trace-v2 cards. */
export const SafetyScoreV9CausalResponseSchema = z
  .object({
    ...SafetyScoreV9HistoricalResponseShape,
    schemaVersion: z.literal(3),
    cards: z.array(SafetyScoreV9CausalCardSchema),
  })
  .strict()
  .superRefine((response, ctx) => refineResponse(response, ctx));
export type SafetyScoreV9CausalResponse = z.infer<
  typeof SafetyScoreV9CausalResponseSchema
>;

/** Retained reader for schema-v4 candidates emitted before component breakdowns. */
export const SafetyScoreV9PreBreakdownResponseSchema = z
  .object({
    ...SafetyScoreV9HistoricalResponseShape,
    schemaVersion: z.literal(4),
    cards: z.array(SafetyScoreV9PreBreakdownCardSchema),
  })
  .strict()
  .superRefine((response, ctx) => refineResponse(response, ctx));
export type SafetyScoreV9PreBreakdownResponse = z.infer<
  typeof SafetyScoreV9PreBreakdownResponseSchema
>;

/** Current V9 envelope. Schema v5 adds compact component breakdowns. */
export const SafetyScoreV9CurrentResponseSchema = z
  .object({
    ...SafetyScoreV9ResponseShape,
    schemaVersion: z.literal(5),
    cards: z.array(SafetyScoreV9CurrentCardSchema),
  })
  .strict()
  .superRefine((response, ctx) => refineResponse(response, ctx));
export type SafetyScoreV9CurrentResponse = z.infer<typeof SafetyScoreV9CurrentResponseSchema>;

/**
 * Compatibility reader for stored shadow artifacts. New V9 production
 * must use SafetyScoreV9CurrentResponseSchema and always emits schema version 5.
 */
export const SafetyScoreV9ResponseSchema = z.union([
  SafetyScoreV9CurrentResponseSchema,
  SafetyScoreV9PreBreakdownResponseSchema,
  SafetyScoreV9CausalResponseSchema,
  SafetyScoreV9PreviousResponseSchema,
  SafetyScoreV9LegacyResponseSchema,
]);
export type SafetyScoreV9Response = Omit<
  SafetyScoreV9LegacyResponse,
  "schemaVersion" | "cards" | "lifecycle" | "policyVersion"
> & {
  schemaVersion: 1 | 2 | 3 | 4 | 5;
  lifecycle: "candidate" | "active";
  policyVersion: string;
  cards: SafetyScoreV9Card[];
};
