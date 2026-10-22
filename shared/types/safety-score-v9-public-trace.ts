import { z } from "zod";
import { issue } from "./safety-schema-primitives";
import { isV9WitnessTextReference } from "./safety-score-v9-public-witness-texts";
import { SafetyScoreV9HistoricalWrapperParentLimitSchema } from "./safety-score-v9-public-historical";
import { AdmittedProviderRowExclusionSchema } from "./safety-score-v9-supply-attribution";
import {
  V9AssetPremiumKindSchema,
  V9QualityPillarSchema,
  V9ReasonCodeSchema,
} from "./safety-score-v9";
import { V9EvidenceResponsibilitySchema } from "./safety-score-v9-fact-primitives";
import { V9WrapperFormSchema } from "./safety-score-v9-wrapper";
import {
  isUniqueSorted,
  numbersAgree,
  PUBLIC_SCORE_ROUNDING_HEADROOM,
  RESPONSIBILITIES,
  SCORE_TOLERANCE,
  ScoreSchema,
  V9_BOUNDED_ATTRIBUTION_REASON_CODE_SET,
} from "./safety-score-v9-public-facts";
import { V9BoundedEvidenceResponsibilitySchema } from "./safety-score-v9-vocabulary";
import { causeGapRefs, V9EvidenceCauseSchema } from "./safety-score-v9-public-causes";
import { canonicalTextArray } from "./safety-score-v9-fact-primitives";
import { countV9EvidenceObligations, V9PublicEvidencePathSchema, refineEvidenceFactPathPrefixes, V9PublicFactReasonCodeSchema, V9PublicFactResponsibilitySchema, resolveEvidenceFactResponsibility, V9PublicFactCauseSchema, resolveEvidenceFactCause } from "./safety-score-v9-public-evidence-facts";

const SafetyScoreV9AggregationTraceSchema = z
  .object({
    method: z.literal("smooth-bounded-headroom"),
    score: ScoreSchema,
    weightedPillarMean: ScoreSchema,
    weakestPillar: V9QualityPillarSchema,
    weakestScore: ScoreSchema,
    headroom: z.number().finite().positive().max(100),
    includedPillars: canonicalTextArray(2).pipe(z.array(V9QualityPillarSchema).max(3)),
    excludedPillars: canonicalTextArray().pipe(z.array(V9QualityPillarSchema).max(1)),
    // Optional only for historical traces predating priced unavailable pillars.
    pricedUnknownPillars: z.array(z.object({
      pillar: V9QualityPillarSchema,
      score: ScoreSchema,
      cause: z.enum(["C", "U"]),
      causeGapRefs: causeGapRefs(),
    }).strict()).max(1).optional(),
    effectiveScoringWeights: z.object({
      backing: z.number().finite().min(0).max(1), exit: z.number().finite().min(0).max(1),
      control: z.number().finite().min(0).max(1),
    }).strict(),
    supportCeiling: ScoreSchema,
  })
  .strict()
  .superRefine((aggregation, ctx) => {
    if (aggregation.includedPillars.length + aggregation.excludedPillars.length !== 3 ||
        aggregation.includedPillars.some((pillar) => aggregation.excludedPillars.includes(pillar)) ||
        (!aggregation.includedPillars.includes(aggregation.weakestPillar) &&
          !aggregation.pricedUnknownPillars?.some((item) => item.pillar === aggregation.weakestPillar)) ||
        aggregation.excludedPillars.some((pillar) =>
          aggregation.pricedUnknownPillars?.some((item) => item.pillar === pillar)
            ? aggregation.effectiveScoringWeights[pillar] <= 0
            : aggregation.effectiveScoringWeights[pillar] !== 0) ||
        (aggregation.pricedUnknownPillars?.some((item) => !aggregation.excludedPillars.includes(item.pillar)) ?? false) ||
        Math.abs(Object.values(aggregation.effectiveScoringWeights).reduce((sum, weight) => sum + weight, 0) - 1) > 1e-9 ||
        !numbersAgree(aggregation.supportCeiling, aggregation.weightedPillarMean)) {
      ctx.addIssue({ code: "custom", message: "Aggregation evidence coverage, priced unknowns, weights and support ceiling must reconcile" });
    }
    if (
      aggregation.weakestScore > aggregation.weightedPillarMean + SCORE_TOLERANCE ||
      aggregation.score < aggregation.weakestScore - SCORE_TOLERANCE ||
      aggregation.score > aggregation.weightedPillarMean + SCORE_TOLERANCE
    ) {
      issue(ctx, ["score"], "V9 aggregation score must remain between the weakest pillar and weighted pillar mean");
    }
  });

const SafetyScoreV9DeploymentAdjustmentSchema = z
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
      issue(ctx, ["sourceSignalKeys"], "V9 deployment source signals must be unique and sorted");
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
      issue(ctx, ["adjustmentPoints"], "V9 deployment adjustment must reconcile its modeled loss, applied points, and score stages");
    }
  });

const SafetyScoreV9UnresolvedDeploymentExposureSchema = z
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
    if (!signal.failureDomainKeys.some(isV9WitnessTextReference) && !isUniqueSorted(signal.failureDomainKeys)) {
      issue(ctx, ["failureDomainKeys"], "V9 unresolved deployment failure domains must be unique and sorted");
    }
  });

const SafetyScoreV9DeploymentRiskTraceSchema = z
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
    if (!deployment.adjustments.some((row) => [row.exposureKey, row.riskEventKey, row.signalKey].some(isV9WitnessTextReference)) && !isUniqueSorted(adjustmentKeys)) {
      issue(ctx, ["adjustments"], "V9 deployment adjustments must have unique, sorted failure-domain attribution");
    }
    const unresolvedKeys = deployment.unresolvedExposures.map(
      (signal) =>
        `${signal.exposureKey}\u0000${signal.riskEventKey}\u0000${signal.failureDomainKeys.join("+")}\u0000${signal.signalKey}`,
    );
    if (!deployment.unresolvedExposures.some((row) => [row.exposureKey, row.riskEventKey, row.signalKey, ...row.failureDomainKeys].some(isV9WitnessTextReference)) && !isUniqueSorted(unresolvedKeys)) {
      issue(ctx, ["unresolvedExposures"], "V9 unresolved deployment exposures must have unique, sorted exposure attribution");
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
      issue(ctx, ["adjustments"], "V9 deployment adjustment exposure shares must form a bounded holder partition");
    }
    if (
      deployment.totalAdjustmentPoints !== null &&
      !numbersAgree(deployment.totalAdjustmentPoints, expectedTotal)
    ) {
      issue(ctx, ["totalAdjustmentPoints"], "V9 total deployment adjustment must equal its attributed adjustments");
    }
  });

const SafetyScoreV9AdverseAttributionItemSchema = z
  .object({
    source: z.enum([
      "active-depeg",
      "parent-score",
      "peg-performance",
      "pillar-score",
      "reason",
      "structural-signal",
      "realized-holder-loss",
    ]),
    path: z.string().min(1),
    message: z.string().min(1),
    responsibility: z.literal("measured-adverse"),
  })
  .strict();

const SafetyScoreV9AdverseAttributionTraceSchema = z
  .object({
    semantics: z.literal("causal-measured-adverse-v1"),
    items: z.array(SafetyScoreV9AdverseAttributionItemSchema),
  })
  .strict()
  .superRefine((attribution, ctx) => {
    if (attribution.items.some((item) => isV9WitnessTextReference(item.path) || isV9WitnessTextReference(item.message))) return;
    const keys = attribution.items.map((item) => `${item.source}\u0000${item.path}\u0000${item.message}`);
    if (!isUniqueSorted(keys)) {
      issue(ctx, ["items"], "V9 adverse attribution must be unique and sorted");
    }
  });

const SafetyScoreV9BoundedUncertaintyAttributionItemSchema = z
  .object({
    source: z.enum(["parent-score", "reason"]),
    code: V9ReasonCodeSchema,
    path: z.string().min(1),
    message: z.string().min(1),
    responsibility: V9BoundedEvidenceResponsibilitySchema,
    cause: V9EvidenceCauseSchema.extract(["C", "U"]),
    causeGapRefs: causeGapRefs(1),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (!V9_BOUNDED_ATTRIBUTION_REASON_CODE_SET.has(item.code)) {
      issue(ctx, ["code"], "V9 bounded-uncertainty attribution requires a policy-bounded reason code");
    }
    if (item.source === "parent-score" && !isV9WitnessTextReference(item.path) && !item.path.startsWith("parent:")) {
      issue(ctx, ["path"], "V9 parent bounded-uncertainty attribution requires a parent-prefixed path");
    }
  });

const SafetyScoreV9BoundedUncertaintyAttributionTraceSchema = z
  .object({
    semantics: z.literal("causal-bounded-uncertainty-v1"),
    items: z.array(SafetyScoreV9BoundedUncertaintyAttributionItemSchema),
  })
  .strict()
  .superRefine((attribution, ctx) => {
    if (attribution.items.some((item) => isV9WitnessTextReference(item.path) || isV9WitnessTextReference(item.message))) return;
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
      issue(ctx, ["items"], "V9 bounded-uncertainty attribution must be unique and sorted");
    }
  });

const SafetyScoreV9EvidenceResponsibilityItemSchema = z
  .object({
    responsibility: V9EvidenceResponsibilitySchema,
    factCount: z.number().int().nonnegative().optional().describe("Defaults to zero"),
    criticalFactCount: z.number().int().nonnegative().optional().describe("Defaults to zero"),
    reasonCodes: z.array(V9ReasonCodeSchema).optional().describe("Defaults to no reason codes"),
  })
  .strict()
  .superRefine((summary, ctx) => {
    if ((summary.criticalFactCount ?? 0) > (summary.factCount ?? 0)) {
      issue(ctx, ["criticalFactCount"], "V9 critical responsibility count cannot exceed its fact count");
    }
    if (summary.reasonCodes !== undefined && !isUniqueSorted(summary.reasonCodes)) {
      issue(ctx, ["reasonCodes"], "V9 responsibility reason codes must be unique and sorted");
    }
  });

const SafetyScoreV9EvidenceResponsibilityFactSchema = z.tuple([
  V9PublicFactReasonCodeSchema, V9PublicEvidencePathSchema, z.number().int().nonnegative().nullable(),
  V9PublicFactResponsibilitySchema, z.union([z.boolean(), z.number().int().min(0).max(1)]), V9PublicFactCauseSchema, z.union([causeGapRefs(), z.number().int().nonnegative()]),
]).superRefine(([, path, sourceGapRef, ownerRef, critical, causeRef, gapRefs], ctx) => {
  const responsibility = resolveEvidenceFactResponsibility(ownerRef), cause = resolveEvidenceFactCause(causeRef);
  const refs = typeof gapRefs === "number" ? [gapRefs] : gapRefs;
  if (Array.isArray(path) && path.length === 1 && sourceGapRef === null && refs.length === 0) {
    ctx.addIssue({ code: "custom", message: "Causal fact path requires a source or causal reference" });
  }
  const owner = cause === "B" ? "public-data-uncurated" : cause === "C" ? "issuer-undisclosed"
    : cause === "U" ? "unresearched" : cause === "D" ? "measured-adverse" : null;
  if ((owner !== null && responsibility !== owner) ||
      (cause === "A" && !["producer-failed", "integration-missing", "method-unsupported"].includes(responsibility)) ||
      ((cause === "A" || cause === "B") && critical) ||
      (sourceGapRef !== null && !refs.includes(sourceGapRef))) {
    ctx.addIssue({ code: "custom", message: "Evidence fact cause, responsibility and causal gap identity must agree" });
  }
});
export type V9PublicEvidenceFactWire = z.infer<typeof SafetyScoreV9EvidenceResponsibilityFactSchema>;

const SafetyScoreV9EvidenceResponsibilityTraceBaseSchema = z.object({
  semantics: z.literal("limiting-fact-cause-v2"),
  totalFactCount: z.number().int().nonnegative(),
  facts: z.array(SafetyScoreV9EvidenceResponsibilityFactSchema),
  factPathPrefixes: canonicalTextArray().optional().describe("No interned fact prefixes when omitted"),
  summaries: z.array(SafetyScoreV9EvidenceResponsibilityItemSchema).length(RESPONSIBILITIES.length),
}).strict();

function evidenceResponsibilityTraceSchema(accounting: "witnesses" | "obligations") {
  return SafetyScoreV9EvidenceResponsibilityTraceBaseSchema.superRefine((evidence, ctx) => {
  if (!refineEvidenceFactPathPrefixes(evidence, ctx)) return;
  if (JSON.stringify(evidence.summaries.map((summary) => summary.responsibility)) !== JSON.stringify(RESPONSIBILITIES)) {
    ctx.addIssue({ code: "custom", path: ["summaries"], message: "V9 evidence responsibility summaries must preserve a supported canonical owner order" });
  }
  const summariesAgree = evidence.summaries.every((summary) => {
    const facts = evidence.facts.filter((fact) => resolveEvidenceFactResponsibility(fact[3]) === summary.responsibility);
    const counts = accounting === "witnesses"
      ? { factCount: facts.length, criticalFactCount: facts.filter((fact) => fact[4]).length }
      : countV9EvidenceObligations(facts, (fact) => fact[2], (fact) => typeof fact[6] === "number" ? [fact[6]] : fact[6], (fact) => Boolean(fact[4]));
    return (summary.factCount ?? 0) === counts.factCount &&
      (summary.criticalFactCount ?? 0) === counts.criticalFactCount;
  });
  if (evidence.facts.length !== evidence.totalFactCount || !summariesAgree) {
    ctx.addIssue({ code: "custom", path: ["facts"], message: "Cause witnesses and distinct obligation counts must reconcile; A/B never directly withholds" });
  }
  });
}

const SafetyScoreV9EvidenceResponsibilityTraceSchema = evidenceResponsibilityTraceSchema("obligations");


const SafetyScoreV9WrapperParentLimitSchema = z
  .object({
    schemaVersion: z.literal(1),
    parentKind: z.enum(["serial", "concentrated-collateral"]).optional(),
    parentAssetId: z.string().min(1).optional(),
    parentScore: ScoreSchema,
    form: V9WrapperFormSchema,
    appliedDiscount: z.number().finite().min(0).max(100),
    limit: ScoreSchema,
  })
  .strict()
  .superRefine((limit, ctx) => {
    const concentrated = limit.parentKind === "concentrated-collateral";
    if (concentrated !== (limit.parentAssetId !== undefined) ||
        (concentrated && (limit.form !== "pure" || limit.appliedDiscount !== 3))) {
      issue(ctx, ["parentKind"], "Concentrated collateral must identify its scored parent and use the pure three-point deduction");
    }
    const expectedLimit = Math.max(0, Math.floor(limit.parentScore - limit.appliedDiscount));
    if (!numbersAgree(limit.limit, expectedLimit)) {
      issue(ctx, ["limit"], "Wrapper limit must apply its form deduction to the parent once");
    }
  });

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
  })
  .strict()
  .superRefine((adjustment, ctx) => {
    if (!numbersAgree(adjustment.scoreAfter - adjustment.scoreBefore, adjustment.appliedPoints)) {
      issue(ctx, ["appliedPoints"], "V9 score adjustment points must reconcile its score stages");
    }
    if (adjustment.appliedPoints > adjustment.configuredPoints + SCORE_TOLERANCE) {
      issue(ctx, ["appliedPoints"], "V9 score adjustment cannot exceed its configured points");
    }
    if (
      adjustment.publishedScoreBefore >
      adjustment.scoreBefore + PUBLIC_SCORE_ROUNDING_HEADROOM + SCORE_TOLERANCE
    ) {
      issue(ctx, ["publishedScoreBefore"], "V9 ordinary published score exceeds its permitted rounding headroom");
    }
    if (adjustment.publishedScoreAfter + SCORE_TOLERANCE < adjustment.publishedScoreBefore) {
      issue(ctx, ["publishedScoreAfter"], "V9 score adjustment cannot reduce the published score");
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
  trace: Pick<SafetyScoreV9ScoreTraceCommon, "aggregation" | "stages" | "deploymentRisk">,
  ctx: z.RefinementCtx,
): void {
  const aggregationScore = trace.aggregation?.score ?? null;
  if ((trace.aggregation === null) !== (trace.stages.weightedPillarMean === null)) {
    issue(ctx, ["aggregation"], "V9 score-bearing pillars require an explicit aggregation method and trace");
  }
  if (!numbersAgree(trace.stages.aggregatedQualityScore, aggregationScore)) {
    issue(ctx, ["stages", "aggregatedQualityScore"], "V9 aggregated quality stage must match the aggregation trace");
  }
  const expectedDeploymentAdjustment =
    trace.stages.baseAssetScore === null || trace.stages.deploymentAdjustedScore === null
      ? null
      : trace.stages.baseAssetScore - trace.stages.deploymentAdjustedScore;
  if (!numbersAgree(trace.stages.deploymentAdjustmentPoints, expectedDeploymentAdjustment)) {
    issue(ctx, ["stages", "deploymentAdjustmentPoints"], "V9 deployment stage delta must reconcile base and post-deployment scores");
  }
  if (!numbersAgree(trace.stages.deploymentAdjustmentPoints, trace.deploymentRisk.totalAdjustmentPoints)) {
    issue(ctx, ["deploymentRisk", "totalAdjustmentPoints"], "V9 deployment trace total must match the score-stage adjustment");
  }
}

function refineAdjustedScoreTrace(
  trace: Pick<SafetyScoreV9AdjustedScoreTraceCommon, "aggregation" | "stages" | "deploymentRisk" | "scoreAdjustments">,
  ctx: z.RefinementCtx,
): void {
  refineScoreTraceBaseStages(trace, ctx);
  let expectedPreCapScore = trace.stages.deploymentAdjustedScore;
  for (const [index, adjustment] of trace.scoreAdjustments.entries()) {
    if (!numbersAgree(expectedPreCapScore, adjustment.scoreBefore)) {
      issue(ctx, ["scoreAdjustments", index, "scoreBefore"], "V9 score adjustment must start from the preceding score stage");
    }
    expectedPreCapScore = adjustment.scoreAfter;
  }
  if (!numbersAgree(expectedPreCapScore, trace.stages.preCapScore)) {
    issue(ctx, ["stages", "preCapScore"], "V9 pre-cap score must match the final score-adjustment stage");
  }
  const finalAdjustment =
    trace.scoreAdjustments[trace.scoreAdjustments.length - 1];
  if (
    finalAdjustment !== undefined &&
    !numbersAgree(trace.stages.publishedScore, finalAdjustment.publishedScoreAfter)
  ) {
    issue(ctx, ["stages", "publishedScore"], "V9 published score must match the final score adjustment");
  }
}

function refineBoundedUncertaintyTrace(
  trace: {
    boundedUncertaintyAttribution: {
      items: readonly (Omit<z.infer<typeof SafetyScoreV9BoundedUncertaintyAttributionItemSchema>, "source"> & { source: string })[];
    };
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
      (summary.factCount ?? 0) === 0 ||
      !summary.reasonCodes?.includes(item.code)
    ) {
      issue(ctx, ["boundedUncertaintyAttribution", "items"], "V9 direct bounded-uncertainty attribution must reconcile to an owned unresolved fact");
    }
  }
}

/** Current trace4 carries explicit causal coverage and effective scoring weights. */
export const SafetyScoreV9ScoreTraceSchema =
  SafetyScoreV9AdjustedScoreTraceCommonSchema
    .extend({
      schemaVersion: z.literal(4),
      boundedUncertaintyAttribution:
        SafetyScoreV9BoundedUncertaintyAttributionTraceSchema,
      providerRowExclusions: z.array(AdmittedProviderRowExclusionSchema).min(1).optional(),
    })
    .strict()
    .superRefine((trace, ctx) => {
      refineAdjustedScoreTrace(trace, ctx);
      refineBoundedUncertaintyTrace(trace, ctx);
    });

const HistoricalAdverseAttributionSchema = z.object({
  semantics: z.literal("causal-measured-adverse-v1"),
  items: z.array(SafetyScoreV9AdverseAttributionItemSchema.extend({
    source: z.enum(["active-depeg", "parent-score", "peg-performance", "pillar-score", "reason", "structural-signal", "track-record", "wrapper-local"]),
  })),
}).strict().superRefine((attribution, ctx) => {
  const keys = attribution.items.map(item => `${item.source}\u0000${item.path}\u0000${item.message}`);
  if (!isUniqueSorted(keys)) issue(ctx, ["items"], "V9 adverse attribution must be unique and sorted");
});
const HistoricalBoundedAttributionSchema = z.object({
  semantics: z.literal("causal-bounded-uncertainty-v1"),
  items: z.array(z.object({
    ...SafetyScoreV9BoundedUncertaintyAttributionItemSchema.shape,
    source: z.enum(["parent-score", "reason", "wrapper-local"]),
  }).strict().superRefine((item, ctx) => {
    if (!V9_BOUNDED_ATTRIBUTION_REASON_CODE_SET.has(item.code)) {
      issue(ctx, ["code"], "V9 bounded-uncertainty attribution requires a policy-bounded reason code");
    }
    if (item.source === "parent-score" && !item.path.startsWith("parent:")) {
      issue(ctx, ["path"], "V9 parent bounded-uncertainty attribution requires a parent-prefixed path");
    }
  })),
}).strict().superRefine((attribution, ctx) => {
  const keys = attribution.items.map(item => [item.source, item.code, item.path, item.message, item.responsibility].join("\u0000"));
  if (!isUniqueSorted(keys)) issue(ctx, ["items"], "V9 bounded-uncertainty attribution must be unique and sorted");
});

const HistoricalScoreAdjustmentSchema = SafetyScoreV9ScoreAdjustmentSchema.safeExtend({
  capRelief: z.object({
    source: z.literal("structural"), kind: z.string().min(1),
    fromLimit: ScoreSchema, toLimit: ScoreSchema,
  }).strict(),
}).superRefine((adjustment, ctx) => {
  if (adjustment.capRelief.fromLimit >= adjustment.capRelief.toLimit) {
    issue(ctx, ["capRelief"], "V9 score adjustment cap relief must increase the named limit");
  }
  if (adjustment.publishedScoreBefore > adjustment.capRelief.fromLimit + SCORE_TOLERANCE) {
    issue(ctx, ["publishedScoreBefore"], "V9 ordinary published score cannot exceed the original cap limit");
  }
  if (adjustment.publishedScoreAfter > adjustment.capRelief.toLimit + SCORE_TOLERANCE) {
    issue(ctx, ["publishedScoreAfter"], "V9 score adjustment cannot publish above its relieved cap");
  }
});

/** Archive-only trace retains the recorded wrapper calculation and vocabulary. */
const HistoricalScoreTraceBaseSchema = SafetyScoreV9AdjustedScoreTraceCommonSchema.extend({
  schemaVersion: z.literal(4),
  scoreAdjustments: z.array(HistoricalScoreAdjustmentSchema).max(1),
  wrapperParentLimit: SafetyScoreV9HistoricalWrapperParentLimitSchema.nullable(),
  adverseAttribution: HistoricalAdverseAttributionSchema,
  boundedUncertaintyAttribution: HistoricalBoundedAttributionSchema,
  providerRowExclusions: z.array(AdmittedProviderRowExclusionSchema).min(1).optional(),
});
const refineHistoricalScoreTrace = (trace: z.infer<typeof HistoricalScoreTraceBaseSchema>, ctx: z.RefinementCtx): void => {
  refineAdjustedScoreTrace(trace, ctx);
  refineBoundedUncertaintyTrace(trace, ctx);
};
export const SafetyScoreV9HistoricalScoreTraceSchema = HistoricalScoreTraceBaseSchema.superRefine(refineHistoricalScoreTrace);

/** Immutable pre-accounting-cutover publications counted causal witnesses. */
export const SafetyScoreV9WitnessScoreTraceSchema = HistoricalScoreTraceBaseSchema.extend({
  evidenceResponsibility: evidenceResponsibilityTraceSchema("witnesses"),
}).superRefine(refineHistoricalScoreTrace);
