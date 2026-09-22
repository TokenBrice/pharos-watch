import { z } from "zod";
import {
  V9AssetPremiumKindSchema,
  V9QualityPillarSchema,
  V9ReasonCodeSchema,
} from "./safety-score-v9";
import { V9EvidenceResponsibilitySchema } from "./safety-score-v9-fact-primitives";
import {
  V9_WRAPPER_LOCAL_FACT_KEYS,
  V9WrapperFactDispositionSchema,
  V9WrapperFormSchema,
  V9WrapperLocalFactKeySchema,
  V9WrapperRiskAssessmentSchema,
  V9WrapperRiskTransferMechanismSchema,
} from "./safety-score-v9-wrapper";
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

const SafetyScoreV9AggregationTraceSchema = z
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
    if (!isUniqueSorted(signal.failureDomainKeys)) {
      ctx.addIssue({
        code: "custom",
        path: ["failureDomainKeys"],
        message: "V9 unresolved deployment failure domains must be unique and sorted",
      });
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

const SafetyScoreV9AdverseAttributionItemSchema = z
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

const SafetyScoreV9AdverseAttributionTraceSchema = z
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

const SafetyScoreV9BoundedUncertaintyAttributionItemSchema = z
  .object({
    source: z.enum(["parent-score", "reason", "wrapper-local"]),
    code: V9ReasonCodeSchema,
    path: z.string().min(1),
    message: z.string().min(1),
    responsibility: V9BoundedEvidenceResponsibilitySchema,
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

const SafetyScoreV9BoundedUncertaintyAttributionTraceSchema = z
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

const SafetyScoreV9EvidenceResponsibilityItemSchema = z
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

const SafetyScoreV9EvidenceResponsibilityFactSchema = z
  .object({
    reasonCode: V9ReasonCodeSchema,
    exactFactPath: z.string().min(1),
    sourceGapId: z.string().min(1).nullable(),
    responsibility: V9EvidenceResponsibilitySchema,
    critical: z.boolean(),
  })
  .strict();

const SafetyScoreV9EvidenceResponsibilityTraceSchema = z
  .object({
    semantics: z.literal("limiting-fact-owner-v1"),
    totalFactCount: z.number().int().nonnegative(),
    // Publications written before methodology 9.19 do not carry the
    // per-fact disclosure paths. Keep the reader compatible with those
    // already-authenticated last-known-good snapshots; newly generated
    // publications always include this field.
    facts: z.array(SafetyScoreV9EvidenceResponsibilityFactSchema).optional(),
    summaries: z
      .array(SafetyScoreV9EvidenceResponsibilityItemSchema)
      .min(RESPONSIBILITIES.length - 1)
      .max(RESPONSIBILITIES.length),
  })
  .strict()
  .superRefine((evidence, ctx) => {
    const actualResponsibilities = evidence.summaries.map((summary) => summary.responsibility);
    // Two independent compatibility dimensions, deliberately not conflated:
    // per-fact disclosure paths arrived in 9.19, and the sixth owner
    // (`published-evidence-expired`) arrived in 9.4. A stored publication can
    // therefore carry per-fact paths and still predate the sixth owner, so the
    // legacy order stays readable whatever `facts` says. Newly written
    // publications are held to the full order by the codec's version gate,
    // which is where a write-time contract belongs.
    const legacyResponsibilities = RESPONSIBILITIES.slice(0, -1);
    const supportedResponsibilities = [legacyResponsibilities, RESPONSIBILITIES];
    if (
      !supportedResponsibilities.some(
        (expected) => JSON.stringify(actualResponsibilities) === JSON.stringify(expected),
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["summaries"],
        message: "V9 evidence responsibility summaries must preserve a supported canonical owner order",
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

const SafetyScoreV9WrapperMissingFactClassSchema = z.union([
  V9WrapperLocalFactKeySchema,
  z.enum(["riskTransfer", "wrapperForm"]),
]);

const SafetyScoreV9WrapperParentLimitSchema = z
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
