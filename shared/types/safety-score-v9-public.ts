import { z } from "zod";
import { issue } from "./safety-schema-primitives";
import { scoreToGrade } from "./safety-score-v9-grade";
import { V9DependencyEconomicRoleSchema, DependencyTypeSchema } from "./dependency-types";
import {
  V9EvidenceLevelSchema,
  V9GradeSchema,
  V9QualityPillarSchema,
  V9ReasonCodeSchema,
} from "./safety-score-v9";
import { V9FailureDomainRefSchema } from "./safety-score-v9-fact-primitives";
import {
  isUniqueSorted,
  numbersAgree,
  SafetyScoreV9AccessPostureSchema,
  SafetyScoreV9CapSchema,
  SafetyScoreV9EvidenceFreshnessSchema,
  SafetyScoreV9NrReasonSchema,
  SafetyScoreV9PillarSchema,
  SafetyScoreV9PublicReasonListSchema,
  ScoreSchema,
} from "./safety-score-v9-public-facts";
import { refineCard } from "./safety-score-v9-public-internal";
import { computeV9UnknownPricedWeightShare, SafetyScoreV9BreakdownsSchema, SafetyScoreV9HistoricalBreakdownsSchema, SafetyScoreV9HistoricalTypedBreakdownsSchema } from "./safety-score-v9-public-breakdowns";
import { SafetyScoreV9ScoreTraceSchema, SafetyScoreV9HistoricalScoreTraceSchema, SafetyScoreV9WitnessScoreTraceSchema } from "./safety-score-v9-public-trace";
import { SafetyScoreV9HistoricalCapSchema } from "./safety-score-v9-public-historical";
import { V9WrapperFormSchema } from "./safety-score-v9-wrapper";
import { V9EffectiveDependenciesV3Schema } from "./safety-score-v9-facts";
import { ReserveSliceSchema } from "./reserves";
import { causeGapRefs, V9RatingStatusSchema, V9PartialEvidenceSchema, V9DependencyCauseShape, refineV9RatingStatusFields, refineV9PublicGapReferences } from "./safety-score-v9-public-causes";
import {
  resolveV9PublicWitnessTexts,
  validateV9PublicWitnessTexts,
  validateV9ResolvedWitnessViews,
  V9PublicWitnessTextTableSchema,
  V9WitnessTextIdentityArraySchema,
} from "./safety-score-v9-public-witness-texts";

export const SafetyScoreV9DependencyProvenanceSchema = z.object({
  source: V9EffectiveDependenciesV3Schema.shape.source,
  evidenceAsOf: z.string().min(1).nullable(),
  intermediary: ReserveSliceSchema.shape.intermediary.unwrap().nullable(),
}).strict();

const SafetyScoreV9DependencyCoverageSchema = z.object({
  upstreamLabel: z.string().min(1),
  upstreamAssetId: z.string().min(1).nullable(),
  share: z.number().finite().min(0).max(1).nullable(),
  reason: z.string().min(1),
  sourceAsOf: z.string().min(1).nullable(),
  identityVerified: z.boolean(),
}).strict().superRefine((row, ctx) => {
  if (!row.identityVerified && row.upstreamAssetId !== null) {
    ctx.addIssue({ code: "custom", path: ["upstreamAssetId"], message: "Unverified identities cannot name a tracked upstream" });
  }
});

/**
 * Planner groups with at least two distinct assets. Optional pricedEffects
 * contain only nonempty references to prices already published on the card.
 * pricedEffectsIncomplete marks an evaluated cap/adjustment missing its reference.
 */
export const SafetyScoreV9CommonModeGroupsSchema = z.array(z.object({
  id: z.string().min(1),
  kind: V9FailureDomainRefSchema.shape.kind,
  key: V9FailureDomainRefSchema.shape.key,
  memberAssetIds: z.array(z.string().min(1)).min(2),
  pricedEffectsIncomplete: z.literal(true).optional(),
  pricedEffects: z.array(z.object({
    assetId: z.string().min(1),
    capIndices: z.array(z.number().int().nonnegative()),
    deploymentAdjustmentIndices: z.array(z.number().int().nonnegative()),
  }).strict()).min(1).optional(),
}).strict().superRefine((group, ctx) => {
  if (group.id !== `${group.kind}:${group.key}`) {
    ctx.addIssue({ code: "custom", path: ["id"], message: "Common-mode ID must match its canonical failure domain" });
  }
  if (!isUniqueSorted(group.memberAssetIds)) {
    ctx.addIssue({ code: "custom", path: ["memberAssetIds"], message: "Common-mode member IDs must be unique and sorted" });
  }
  if (!isUniqueSorted((group.pricedEffects ?? []).map((effect) => effect.assetId))) {
    ctx.addIssue({ code: "custom", path: ["pricedEffects"], message: "Common-mode effects must have unique, sorted asset IDs" });
  }
  group.pricedEffects?.forEach((effect, index) => {
    if (!group.memberAssetIds.includes(effect.assetId)) {
      ctx.addIssue({ code: "custom", path: ["pricedEffects", index], message: "Common-mode effects must belong to group members" });
    }
    for (const field of ["capIndices", "deploymentAdjustmentIndices"] as const) {
      if (!effect[field].every((value, i, values) => i === 0 || values[i - 1]! < value)) {
        ctx.addIssue({ code: "custom", path: ["pricedEffects", index, field], message: "Common-mode effect references must be unique and sorted" });
      }
    }
    if (effect.capIndices.length === 0 && effect.deploymentAdjustmentIndices.length === 0) {
      ctx.addIssue({ code: "custom", path: ["pricedEffects", index], message: "Common-mode priced effects require a nonempty reference list" });
    }
  });
})).superRefine((groups, ctx) => {
  if (!isUniqueSorted(groups.map((group) => group.id))) {
    ctx.addIssue({ code: "custom", message: "Common-mode groups must have unique, sorted IDs" });
  }
});
export type SafetyScoreV9CommonModeGroups = z.infer<typeof SafetyScoreV9CommonModeGroupsSchema>;

export {
  findSafetyScoreV9ParentAttributionIssues,
} from "./safety-score-v9-public-attribution";

export {
  SafetyScoreV9AccessPostureSchema,
  SafetyScoreV9PillarSchema,
} from "./safety-score-v9-public-facts";
export type { SafetyScoreV9Cap, SafetyScoreV9EvidenceFreshness, SafetyScoreV9NrReason, SafetyScoreV9PublicReason } from "./safety-score-v9-public-facts";
const SafetyScoreV9SerialDependencySchema = z
  .object({
    upstreamAssetId: z.string().min(1),
    score: ScoreSchema.nullable(),
    ...V9DependencyCauseShape,
    blocked: z.boolean(),
    dependencyType: DependencyTypeSchema.optional(),
    wrapperForm: V9WrapperFormSchema.nullable().optional(),
    provenance: SafetyScoreV9DependencyProvenanceSchema.optional(),
  })
  .strict().superRefine((parent, ctx) => {
    if ((parent.ratingStatus === "rated") !== (parent.score !== null) ||
        (parent.ratingStatus === "pipeline-gap" && parent.blocked) ||
        (parent.ratingStatus === "not-rated" && (parent.limitedEvidenceCauses?.length ?? 0) === 0)) {
      ctx.addIssue({ code: "custom", message: "Serial parent availability must preserve its actual status and cause, not inherit technical NR" });
    }
  });

const SafetyScoreV9BasketDependencySchema = z
  .object({
    upstreamAssetId: z.string().min(1),
    weight: z.number().finite().min(0).max(1),
    score: ScoreSchema.nullable(),
    /** Premium-free whole-card score, distinct from the Backing-only basket score. */
    collateralParentScore: ScoreSchema.optional(),
    ...V9DependencyCauseShape,
    boundedUnknown: z.boolean(),
    dependencyType: DependencyTypeSchema.optional(),
    wrapperForm: z.null().optional(),
    provenance: SafetyScoreV9DependencyProvenanceSchema.optional(),
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
    inheritedDimensions: z.array(z.enum(["final", "backing", "exit", "access", "control", "oracle-nav"])),
    unavailableDimensions: z.array(z.enum(["final", "backing", "exit", "access", "control", "oracle-nav"])),
    score: ScoreSchema.nullable(),
    ...V9DependencyCauseShape,
    boundedUnknown: z.boolean(),
    cycleBlocked: z.boolean(),
    evidenceRefIds: z.array(z.string().min(1)),
    failureDomains: z.array(V9FailureDomainRefSchema),
  })
  .strict()
  .superRefine((dependency, ctx) => {
    if (!isUniqueSorted(dependency.evidenceRefIds)) {
      issue(ctx, ["evidenceRefIds"], "V9 role dependency evidence references must be unique and sorted");
    }
    const failureDomainKeys = dependency.failureDomains.map((domain) => `${domain.kind}:${domain.key}`);
    if (!isUniqueSorted(failureDomainKeys)) {
      issue(ctx, ["failureDomains"], "V9 role dependency failure domains must be unique and sorted");
    }
  });


const SafetyScoreV9DependencySummarySchema = z
  .object({
    serial: z.array(SafetyScoreV9SerialDependencySchema),
    basket: z.array(SafetyScoreV9BasketDependencySchema),
    roles: z.array(SafetyScoreV9RoleDependencySchema).optional(),
    cycleBlocked: z.boolean(),
    reasonCodes: z.array(V9ReasonCodeSchema),
  })
  .strict()
  .superRefine((summary, ctx) => {
    for (const field of ["serial", "basket"] as const) {
      const ids = summary[field].map((dependency) => dependency.upstreamAssetId);
      if (!isUniqueSorted(ids)) {
        issue(ctx, [field], `V9 ${field} dependencies must have unique, sorted upstream IDs`);
      }
    }
    const roleKeys = (summary.roles ?? []).map(
      (dependency) => `${dependency.role}:${dependency.upstreamAssetId}:${dependency.edgeKey}`,
    );
    if (!isUniqueSorted(roleKeys)) {
      issue(ctx, ["roles"], "V9 role dependencies must have unique, sorted role/upstream/edge keys");
    }
    if (!isUniqueSorted(summary.reasonCodes)) {
      issue(ctx, ["reasonCodes"], "V9 dependency reasons must be unique and sorted");
    }
  });

/** Retained publications record the former role calculation; current cards do not emit it. */
const SafetyScoreV9HistoricalRoleDependencySchema = SafetyScoreV9RoleDependencySchema.safeExtend({
  propagationEventEdgeKeys: z.array(z.string().min(1)),
  propagationEventExposureKey: z.string().min(1).nullable(),
  propagationEventRiskEventKey: z.string().min(1).nullable(),
  propagationEventNominalExposureShare: z.number().finite().min(0).max(1).nullable(),
  propagationEventExposureShare: z.number().finite().min(0).max(1).nullable(),
  propagationEventInheritedScore: ScoreSchema.nullable(),
  propagationEventModeledLossPoints: ScoreSchema.nullable(),
}).superRefine((dependency, ctx) => {
  if (!isUniqueSorted(dependency.propagationEventEdgeKeys)) {
    issue(ctx, ["propagationEventEdgeKeys"], "Historical role propagation keys must be unique and sorted");
  }
});
const SafetyScoreV9HistoricalRolePillarLimitSchema = z.object({
  limit: ScoreSchema.nullable(),
  knownLossPoints: ScoreSchema,
  boundedUnknownLossPoints: ScoreSchema,
  unresolvedExposureShare: z.number().finite().min(0).max(1),
  materialUnresolvedExposure: z.boolean(),
}).strict();
const SafetyScoreV9HistoricalDependencySummarySchema = SafetyScoreV9DependencySummarySchema.safeExtend({
  roles: z.array(SafetyScoreV9HistoricalRoleDependencySchema).optional(),
  rolePillarLimits: z.object({
    exit: SafetyScoreV9HistoricalRolePillarLimitSchema,
    control: SafetyScoreV9HistoricalRolePillarLimitSchema,
  }).strict().optional(),
});

export const SafetyScoreV9EvidenceSummarySchema = z
  .object({
    level: V9EvidenceLevelSchema,
    freshness: SafetyScoreV9EvidenceFreshnessSchema,
    reasons: SafetyScoreV9PublicReasonListSchema,
  })
  .strict();
/**
 * Since 10.26 a rated letter-grade change publishes only once two consecutive
 * publications compute the same new band. Until then the card keeps the
 * previously published grade beside its raw score and names the computed band
 * and the accepted publication whose grade it retains.
 */
const V9LetterGradeSchema = V9GradeSchema.exclude(["NR"]);
const SafetyScoreV9GradeHoldSchema = z.object({
  rawGrade: V9LetterGradeSchema,
  heldFromGenerationId: z.string().min(1),
}).strict();
export type SafetyScoreV9GradeHold = z.infer<typeof SafetyScoreV9GradeHoldSchema>;

/** Display-only local authority exposure, not an effective Control pillar. */
const V9LocalAuthorityExposureSchema = z.object({
  worstQuality: ScoreSchema,
  coveredShare: z.number().finite().positive().max(1).nullable(),
  slices: z.array(z.object({
    deploymentLabel: z.string().min(1).max(120),
    share: z.number().finite().positive().max(1),
    quality: ScoreSchema,
  }).strict()).min(1).max(3),
  moreCount: z.number().int().nonnegative(),
}).strict();
export type V9LocalAuthorityExposure = z.infer<typeof V9LocalAuthorityExposureSchema>;

const SafetyScoreV9CardShape = {
  id: z.string().min(1),
  localCauseGaps: V9WitnessTextIdentityArraySchema,
  foreignCauseGapRefs: causeGapRefs(),
  witnessTexts: V9PublicWitnessTextTableSchema.optional(),
  /**
   * True when the exact V9 fact set compiled this asset's Backing reserve
   * exposures from an accepted live-reserve snapshot. Optional only so a new
   * Worker can continue reading the last pre-field publication during rollout.
   */
  backingFromLiveReserves: z.boolean().optional(),
  supply: z.object({
    circulatingUsdAtEvaluation: z.number().finite().nonnegative().nullable(),
    asOfSec: z.number().int().nonnegative().nullable(),
    generationId: z.string().min(1).nullable(),
  }).strict().optional(),
  sharedBookId: z.string().min(1).nullable().optional(),
  dependencyCoverage: z.array(SafetyScoreV9DependencyCoverageSchema).optional(),
  score: ScoreSchema.nullable(),
  grade: V9GradeSchema.nullable(),
  gradeHold: SafetyScoreV9GradeHoldSchema.optional(),
  /** Display-only; older archived publications omit both fields. */
  provisional: z.literal(true).optional(),
  unknownPricedWeightShare: z.number().finite().gt(0.5).max(1).optional(),
  localAuthorityExposure: V9LocalAuthorityExposureSchema.optional(),
  ratingStatus: V9RatingStatusSchema,
  partialEvidence: V9PartialEvidenceSchema.nullable(),
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
} as const;
type HistoricalCap = z.infer<typeof SafetyScoreV9HistoricalCapSchema>;
type SafetyScoreV9CardBase = Omit<z.infer<z.ZodObject<typeof SafetyScoreV9CardShape>>, "caps" | "bindingCap"> & {
  caps: (z.infer<typeof SafetyScoreV9CapSchema> | HistoricalCap)[];
  bindingCap: z.infer<typeof SafetyScoreV9CapSchema> | HistoricalCap | null;
};

function refineCardBase(
  card: SafetyScoreV9CardBase,
  ctx: { addIssue: (issue: { code: "custom"; path?: PropertyKey[]; message: string }) => void },
): void {
  refineV9PublicGapReferences(card, ctx);
  refineV9RatingStatusFields(card, ctx);
  if (card.localAuthorityExposure !== undefined && card.ratingStatus !== "rated") {
    ctx.addIssue({ code: "custom", path: ["localAuthorityExposure"], message: "Local authority exposure is only shown on rated cards" });
  }
  const excludedPillars = (["backing", "exit", "control"] as const).filter((pillar) => (card.pillars[pillar].aggregationDisposition ?? "included") !== "included").sort();
  if (JSON.stringify(excludedPillars) !== JSON.stringify(card.partialEvidence?.excludedPillars ?? [])) {
    ctx.addIssue({ code: "custom", path: ["partialEvidence"], message: "Partial evidence must reconcile excluded pillars" });
  }
  const hasExcludedAB = excludedPillars.some((pillar) => card.pillars[pillar].aggregationDisposition === "excluded-a-b");
  const hasExcludedCauses = (card.partialEvidence?.causes.length ?? 0) > 0;
  // A/B exclusions can affect a subcomponent, constraint, or parent while
  // leaving every pillar usable; they do not require a whole-pillar exclusion.
  // Every published A/B cause names its causal gaps (R4). The component
  // inventory stays optional: a mixed-cause status on a component that remains
  // scored, a pillar-level status gap that owns no component, and an unscored
  // Exit admission or confidence factor all exclude A/B evidence without a
  // priced component, and the model never manufactures one.
  if ((hasExcludedAB && !hasExcludedCauses) ||
      (hasExcludedCauses && (card.partialEvidence?.causeGapRefs.length ?? 0) === 0)) {
    ctx.addIssue({ code: "custom", path: ["partialEvidence", "causes"], message: "A/B exclusions require partial-evidence causes and gap references" });
  }
  if (excludedPillars.some((pillar) => card.pillars[pillar].causeGapRefs?.some((ref) => !card.partialEvidence?.causeGapRefs.includes(ref)))) {
    ctx.addIssue({ code: "custom", path: ["partialEvidence"], message: "Excluded pillar gaps must remain visible in partial evidence" });
  }
  if (card.ratingStatus === "pipeline-gap") {
    const reason = excludedPillars.length === 3 ? "all-pillars-pipeline-gap" : "single-pillar-pipeline-gap";
    if (!card.reasonCodes.includes(reason) || card.nrReasons.length > 0 ||
        card.qualityScore !== null || card.pegAdjustedScore !== null || card.pegMultiplier !== null || card.weakestPillar !== null) {
      ctx.addIssue({ code: "custom", message: "Pipeline gaps require their distinct availability reason and null card score stages, never NR" });
    }
  }
  if (card.gradeHold !== undefined) {
    if (card.ratingStatus !== "rated" || card.score === null || card.grade === null || card.grade === "NR" ||
        card.gradeHold.rawGrade !== scoreToGrade(card.score) || card.gradeHold.rawGrade === card.grade) {
      issue(ctx, ["gradeHold"], "A grade hold retains a different rated letter grade beside the raw score band");
    }
  } else if (card.score !== null && card.grade !== scoreToGrade(card.score)) {
    issue(ctx, ["grade"], "V9 numeric score and grade band must agree");
  }
  if (card.ratingStatus === "rated" && Object.values(card.pillars).filter((pillar) => (pillar.aggregationDisposition ?? "included") === "included" && pillar.score !== null).length < 2) {
    ctx.addIssue({ code: "custom", path: ["pillars"], message: "A rated result requires at least two included pillars" });
  }
  if (
    card.score !== null &&
    (card.qualityScore === null || card.pegAdjustedScore === null || card.pegMultiplier === null)
  ) {
    issue(ctx, ["qualityScore"], "A rated result requires quality and peg-adjusted scores");
  }
  if (card.ratingStatus === "not-rated" && card.nrReasons.length === 0) {
    ctx.addIssue({ code: "custom", path: ["nrReasons"], message: "An NR result requires an explicit reason" });
  }
  if (card.score !== null && card.nrReasons.length > 0) {
    ctx.addIssue({ code: "custom", path: ["nrReasons"], message: "A rated result cannot carry NR reasons" });
  }
  const bindingCaps = card.caps.filter((cap) => cap.binding);
  if (bindingCaps.length > 1) {
    ctx.addIssue({ code: "custom", path: ["caps"], message: "At most one V9 cap candidate may bind" });
  }
  if (card.score === null && card.bindingCap !== null) {
    issue(ctx, ["bindingCap"], "An NR result cannot carry a binding cap");
  }
  if (card.score === null && bindingCaps.length > 0) {
    issue(ctx, ["caps"], "An NR result cannot carry a binding cap candidate");
  }
  if (
    card.bindingCap === null
      ? bindingCaps.length !== 0
      : JSON.stringify(bindingCaps) !== JSON.stringify([card.bindingCap])
  ) {
    issue(ctx, ["bindingCap"], "V9 binding cap must match the binding cap candidate");
  }
  if (!isUniqueSorted(card.reasonCodes)) {
    ctx.addIssue({ code: "custom", path: ["reasonCodes"], message: "V9 reason codes must be unique and sorted" });
  }
}

export const SafetyScoreV9CurrentCardBaseSchema = z
  .object({
    ...SafetyScoreV9CardShape,
    scoreTrace: SafetyScoreV9ScoreTraceSchema,
    breakdowns: SafetyScoreV9BreakdownsSchema.nullable(),
  })
  .strict();

/** Report7/breakdown6 preserve the strict recorded, pre-simplification contract. */
const SafetyScoreV9HistoricalCardBaseSchema = SafetyScoreV9CurrentCardBaseSchema.extend({
  caps: z.array(SafetyScoreV9HistoricalCapSchema),
  bindingCap: SafetyScoreV9HistoricalCapSchema.nullable(),
  scoreTrace: SafetyScoreV9HistoricalScoreTraceSchema,
  breakdowns: SafetyScoreV9HistoricalBreakdownsSchema.nullable(),
  dependencies: SafetyScoreV9HistoricalDependencySummarySchema,
});
const SafetyScoreV9HistoricalTypedCardBaseSchema = SafetyScoreV9HistoricalCardBaseSchema.extend({
  breakdowns: SafetyScoreV9HistoricalTypedBreakdownsSchema.nullable(),
});
export type SafetyScoreV9CardValidationInput =
  | z.infer<typeof SafetyScoreV9CurrentCardBaseSchema>
  | z.infer<typeof SafetyScoreV9HistoricalCardBaseSchema>
  | z.infer<typeof SafetyScoreV9HistoricalTypedCardBaseSchema>;
type CardRefinementInput = SafetyScoreV9CardValidationInput;

function refineCurrentCard(card: CardRefinementInput, ctx: z.RefinementCtx, resolved = false, historical: false | "report7" | "report8" = false): void {
    try {
      if (resolved) validateV9ResolvedWitnessViews(card);
      else validateV9PublicWitnessTexts(card);
      if (!resolved && card.witnessTexts !== undefined) {
        card = resolveV9PublicWitnessTexts(card);
        validateV9ResolvedWitnessViews(card);
        const schema = historical === "report8" ? SafetyScoreV9HistoricalTypedCardBaseSchema
          : historical === "report7" ? SafetyScoreV9HistoricalCardBaseSchema : SafetyScoreV9CurrentCardBaseSchema;
        const semantic = schema.safeParse(card);
        if (!semantic.success) for (const issue of semantic.error.issues) {
          ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
        }
      }
    } catch (error) {
      ctx.addIssue({ code: "custom", path: ["witnessTexts"], message: error instanceof Error ? error.message : "Invalid witness text table" });
      return;
    }
    refineCardBase(card, ctx);
    refineCard(card, ctx);
    if (card.provisional !== undefined || card.unknownPricedWeightShare !== undefined) {
      const share = computeV9UnknownPricedWeightShare(card.breakdowns, card.scoreTrace.aggregation);
      if (card.ratingStatus !== "rated" || card.provisional !== true ||
          card.unknownPricedWeightShare === undefined || share <= 0.5 ||
          !numbersAgree(card.unknownPricedWeightShare, share)) {
        issue(ctx, ["provisional"], "Provisional labels require more than half the scoring weight to be priced as unknown, with its reconciled share");
      }
    }
    if (card.ratingStatus === "pipeline-gap" && (card.scoreTrace.aggregation !== null ||
        Object.values(card.scoreTrace.stages).some((value) => value !== null) ||
        card.scoreTrace.scoreAdjustments.length > 0 || card.bindingCap !== null)) {
      ctx.addIssue({ code: "custom", path: ["scoreTrace"], message: "Pipeline gaps cannot publish an aggregate, grade stage, adjustment or binding cap" });
    }
    if ((card.breakdowns === null) !== (card.ratingStatus === "not-rated")) {
      issue(ctx, ["breakdowns"], "V9 component breakdowns are required exactly when a card is rateable");
    }
    if (card.breakdowns !== null) {
      for (const pillar of ["backing", "exit", "control"] as const) {
        if ((card.breakdowns[pillar].aggregationDisposition ?? "included") !== (card.pillars[pillar].aggregationDisposition ?? "included") ||
            !numbersAgree(card.breakdowns[pillar].aggregationWeight,
              (card.pillars[pillar].aggregationDisposition ?? "included") === "included"
                ? card.scoreTrace.aggregation?.effectiveScoringWeights[pillar] ?? 0 : 0)) {
          ctx.addIssue({ code: "custom", path: ["breakdowns", pillar], message: "Diagnostic breakdown dispositions and included aggregate weights must agree" });
        }
        if (
          !numbersAgree(card.breakdowns[pillar].publishedScore, card.pillars[pillar].score)
        ) {
          issue(ctx, ["breakdowns", pillar, "publishedScore"], "V9 breakdown published score must match the public pillar");
        }
      }
    }
}

export const SafetyScoreV9CurrentCardSchema = SafetyScoreV9CurrentCardBaseSchema.superRefine(refineCurrentCard);

/** Wire cards contain literal evidence, never canonical card-local references. */
export const SafetyScoreV9ResolvedCurrentCardSchema = SafetyScoreV9CurrentCardBaseSchema
  .omit({ witnessTexts: true })
  .extend({ witnessTexts: z.undefined().optional() })
  .superRefine((card, ctx) => refineCurrentCard(card, ctx, true));
export type SafetyScoreV9ResolvedCurrentCard = z.infer<typeof SafetyScoreV9ResolvedCurrentCardSchema>;

export const SafetyScoreV9HistoricalCardSchema = SafetyScoreV9HistoricalCardBaseSchema
  .superRefine((card, ctx) => refineCurrentCard(card, ctx, false, "report7"));
export const SafetyScoreV9WitnessHistoricalCardSchema = SafetyScoreV9HistoricalCardBaseSchema.extend({
  scoreTrace: SafetyScoreV9WitnessScoreTraceSchema,
}).superRefine((card, ctx) => refineCurrentCard(card, ctx, false, "report7"));
export const SafetyScoreV9HistoricalTypedCardSchema = SafetyScoreV9HistoricalTypedCardBaseSchema
  .superRefine((card, ctx) => refineCurrentCard(card, ctx, false, "report8"));
export type SafetyScoreV9CurrentCard = z.infer<typeof SafetyScoreV9CurrentCardSchema>;

export type SafetyScoreV9Card = SafetyScoreV9CurrentCard;

export const SafetyScoreV9CompletenessSchema = z
  .object({
    expectedCount: z.number().int().nonnegative(),
    ratedCount: z.number().int().nonnegative(),
    notRatedCount: z.number().int().nonnegative(),
    notRatedIds: z.array(z.string().min(1)),
    pipelineGapCount: z.number().int().nonnegative(),
    pipelineGapIds: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.expectedCount !== value.ratedCount + value.notRatedCount + value.pipelineGapCount) {
      ctx.addIssue({ code: "custom", message: "V9 completeness counts do not reconcile" });
    }
    if (value.notRatedIds.length !== value.notRatedCount || !isUniqueSorted(value.notRatedIds)) {
      ctx.addIssue({ code: "custom", path: ["notRatedIds"], message: "V9 not-rated IDs do not reconcile" });
    }
    if (value.pipelineGapIds.length !== value.pipelineGapCount || !isUniqueSorted(value.pipelineGapIds) ||
        value.pipelineGapIds.some((id) => value.notRatedIds.includes(id))) {
      ctx.addIssue({ code: "custom", path: ["pipelineGapIds"], message: "Pipeline-gap and NR membership must reconcile disjointly" });
    }
  });

/**
 * The open-evidence block lives in `safety-score-v9-open-evidence.ts` and the
 * publication 7/8 envelopes in `safety-score-v9-publication-response.ts`; both
 * were split out so browser readers of this module never ship their validators.
 * Their types stay available here (type-only re-exports are erased) so existing
 * type imports keep resolving without pulling a runtime dependency.
 */
export type {
  V9OpenEvidence,
} from "./safety-score-v9-open-evidence";
export type {
  SafetyScoreV9CurrentResponse,
  SafetyScoreV9PreviousResponse,
} from "./safety-score-v9-publication-response";
