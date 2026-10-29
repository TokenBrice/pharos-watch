import { z } from "zod";
import { issue, UnixSecondsSchema } from "./safety-schema-primitives";
import { scoreToGrade } from "./safety-score-v9-grade";
import { V9DependencyEconomicRoleSchema, DependencyTypeSchema } from "./dependency-types";
import {
  V9DocumentationReasonSchema,
  V9EvidenceLevelSchema,
  V9GradeSchema,
  V9QualityPillarSchema,
  V9ReasonCodeSchema,
} from "./safety-score-v9";
import { V9EvidenceResponsibilitySchema, V9FailureDomainRefSchema } from "./safety-score-v9-fact-primitives";
import {
  BaseInputGenerationIdSchema,
  isUniqueSorted,
  numbersAgree,
  RESPONSIBILITIES,
  SafetyScoreV9AccessPostureSchema,
  SafetyScoreV9CapSchema,
  SafetyScoreV9EvidenceFreshnessSchema,
  SafetyScoreV9PillarFreshnessSchema,
  refineSafetyScoreV9PillarFreshness,
  SafetyScoreV9NrReasonSchema,
  SafetyScoreV9PillarSchema,
  SafetyScoreV9PublicReasonListSchema,
  ScoreSchema,
  Sha256Schema,
  V9PolicyVersionSchema,
} from "./safety-score-v9-public-facts";
import { refineCard } from "./safety-score-v9-public-internal";
import { findSafetyScoreV9ParentAttributionIssues } from "./safety-score-v9-public-attribution";
import { computeV9UnknownPricedWeightShare, SafetyScoreV9BreakdownsSchema, SafetyScoreV9HistoricalBreakdownsSchema, SafetyScoreV9HistoricalTypedBreakdownsSchema } from "./safety-score-v9-public-breakdowns";
import { SafetyScoreV9ScoreTraceSchema, SafetyScoreV9HistoricalScoreTraceSchema, SafetyScoreV9WitnessScoreTraceSchema } from "./safety-score-v9-public-trace";
import { SafetyScoreV9HistoricalCapSchema } from "./safety-score-v9-public-historical";
import { V9WrapperFormSchema } from "./safety-score-v9-wrapper";
import { V9EffectiveDependenciesV3Schema } from "./safety-score-v9-facts";
import { ReserveSliceSchema } from "./reserves";
import { causeGapRefs, V9RatingStatusSchema, V9PartialEvidenceSchema, V9DependencyCauseShape, refineV9RatingStatusFields, refineV9PublicGapReferences, refineV9PublicGapContext } from "./safety-score-v9-public-causes";
import { canonicalTextArray } from "./safety-score-v9-fact-primitives";
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
  if ((hasExcludedAB && !hasExcludedCauses) ||
      (hasExcludedCauses && ((card.partialEvidence?.causeGapRefs.length ?? 0) === 0 ||
        (card.partialEvidence?.excludedComponentKeys.length ?? 0) === 0))) {
    ctx.addIssue({ code: "custom", path: ["partialEvidence", "causes"], message: "A/B exclusions require partial-evidence causes, component keys, and gap references" });
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

/** Published open-evidence counting semantics; a definition change renames this literal. */
export const V9_OPEN_EVIDENCE_SEMANTICS = "open-question-v1" as const;

/** The three disjoint published question buckets; they sum to `totals.questions`. */
export const V9_OPEN_QUESTION_BUCKETS = ["documentation", "issuer", "open"] as const;
export const V9OpenQuestionBucketSchema = z.enum(V9_OPEN_QUESTION_BUCKETS);
export type V9OpenQuestionBucket = z.infer<typeof V9OpenQuestionBucketSchema>;

/** Scope kinds a question key dispatches on. */
export const V9_OPEN_QUESTION_SCOPE_KINDS = [
  "route", "control", "reserve-exposure", "component", "peg", "dependency", "path",
] as const;
export const V9OpenQuestionScopeKindSchema = z.enum(V9_OPEN_QUESTION_SCOPE_KINDS);
export type V9OpenQuestionScopeKind = z.infer<typeof V9OpenQuestionScopeKindSchema>;

/**
 * Open-question identity `<rootAssetId>|<scopeKind>|<scopeIdentity>`, derived at
 * publication build time and never stored. Route identities keep their own
 * `<lane>|<tail>` separator, so only the first two separators are structural.
 */
export const V9QuestionKeySchema = z.string().superRefine((value, ctx) => {
  const rootEnd = value.indexOf("|");
  const kindEnd = rootEnd < 0 ? -1 : value.indexOf("|", rootEnd + 1);
  if (value.trim() !== value || rootEnd <= 0 || kindEnd <= rootEnd + 1 || kindEnd === value.length - 1) {
    issue(ctx, undefined, "Open-question keys must be <rootAssetId>|<scopeKind>|<scopeIdentity>");
    return;
  }
  if (!V9OpenQuestionScopeKindSchema.safeParse(value.slice(rootEnd + 1, kindEnd)).success) {
    issue(ctx, undefined, "Open-question keys must name a supported scope kind");
  }
});
export type V9QuestionKey = z.infer<typeof V9QuestionKeySchema>;

/** The annotated pillar vocabulary is the single `V9QualityPillarSchema`; never restate it. */

const V9OpenEvidenceCountSchema = z.number().int().nonnegative();

export const V9OpenEvidenceTotalsSchema = z
  .object({
    questions: V9OpenEvidenceCountSchema,
    open: V9OpenEvidenceCountSchema,
    issuer: V9OpenEvidenceCountSchema,
    documentation: V9OpenEvidenceCountSchema,
    obligations: V9OpenEvidenceCountSchema,
  })
  .strict()
  .superRefine((totals, ctx) => {
    if (totals.questions !== totals.open + totals.issuer + totals.documentation) {
      issue(ctx, undefined, "Open-evidence buckets must sum to the question total");
    }
  });
export type V9OpenEvidenceTotals = z.infer<typeof V9OpenEvidenceTotalsSchema>;

/** Headline owner of a question; `mixed` is the multi-owner remainder, not a responsibility. */
export const V9_OPEN_EVIDENCE_MIXED_OWNER = "mixed" as const;

const V9OpenEvidenceOwnerSchema = z
  .object({
    responsibility: z.union([V9EvidenceResponsibilitySchema, z.literal(V9_OPEN_EVIDENCE_MIXED_OWNER)]),
    questions: V9OpenEvidenceCountSchema,
    obligations: V9OpenEvidenceCountSchema,
  })
  .strict();

const V9OpenEvidenceReasonSchema = z
  .object({
    code: V9ReasonCodeSchema,
    /**
     * Bucket whose questions the row counts. Documentation rows are the
     * documentation inventory only: they never enter the headline or issuer
     * number, which are read from `totals`.
     */
    bucket: V9OpenQuestionBucketSchema,
    questions: V9OpenEvidenceCountSchema,
    obligations: V9OpenEvidenceCountSchema,
  })
  .strict();

const V9OpenEvidenceDocumentationSchema = z
  .object({
    questions: V9OpenEvidenceCountSchema,
    datums: V9OpenEvidenceCountSchema,
    facts: V9OpenEvidenceCountSchema,
    reasons: z
      .array(
        z
          .object({
            reason: V9DocumentationReasonSchema,
            datums: V9OpenEvidenceCountSchema,
          })
          .strict(),
      ),
  })
  .strict()
  .superRefine((documentation, ctx) => {
    if (documentation.facts > documentation.datums) {
      issue(ctx, ["facts"], "Documentation facts cannot exceed its datum count");
    }
    if (!isUniqueSorted(documentation.reasons.map((row) => row.reason))) {
      issue(ctx, ["reasons"], "Documentation reason rows must be unique and sorted");
    }
    if (documentation.reasons.reduce((sum, row) => sum + row.datums, 0) !== documentation.datums) {
      issue(ctx, ["reasons"], "Every documentation datum carries exactly one reason");
    }
  });

const V9OpenEvidenceIssuerSchema = z
  .object({
    questions: V9OpenEvidenceCountSchema,
    assets: V9OpenEvidenceCountSchema,
    oldestReviewedAtSec: UnixSecondsSchema.nullable(),
    newestReviewedAtSec: UnixSecondsSchema.nullable(),
  })
  .strict()
  .superRefine((issuer, ctx) => {
    if (issuer.assets > issuer.questions) {
      issue(ctx, ["assets"], "Issuer-reviewed assets cannot outnumber issuer questions");
    }
    if ((issuer.oldestReviewedAtSec === null) !== (issuer.newestReviewedAtSec === null)) {
      issue(ctx, ["oldestReviewedAtSec"], "Issuer review dates publish together or not at all");
    } else if (
      issuer.oldestReviewedAtSec !== null &&
      issuer.newestReviewedAtSec !== null &&
      issuer.oldestReviewedAtSec > issuer.newestReviewedAtSec
    ) {
      issue(ctx, ["oldestReviewedAtSec"], "Issuer review windows cannot start after they end");
    }
  });

export const V9OpenEvidenceByCardSchema = z
  .object({
    id: z.string().min(1),
    /** Questions carried on this card that landed in the headline "open" bucket only. */
    openBucketQuestionsCarried: V9OpenEvidenceCountSchema,
    /** Open-bucket questions whose root asset is not this card (inherited from a parent). */
    inheritedOpenBucketQuestionsCarried: V9OpenEvidenceCountSchema,
    /** Obligations behind this card's open-bucket questions; excludes issuer and documentation ones. */
    openBucketObligationsCarried: V9OpenEvidenceCountSchema,
    /** Documentation-classed obligations this card carries, from any bucket. */
    documentationObligationsCarried: V9OpenEvidenceCountSchema,
    /**
     * Pillars this card limits only through documentation gaps: the pillar is
     * `limited`, its witnesses are non-empty, and every witness is
     * documentation-classed. Absent means plain limited — never publish `[]`.
     */
    documentationOnlyLimited: canonicalTextArray(1).pipe(z.array(V9QualityPillarSchema).max(3)).optional(),
    /** Earliest recorded issuer review behind this card's issuer-bucket questions; absent when none is dated. */
    issuerNondisclosureReviewedAtSec: UnixSecondsSchema.optional(),
  })
  .strict()
  .superRefine((card, ctx) => {
    if (card.inheritedOpenBucketQuestionsCarried > card.openBucketQuestionsCarried) {
      issue(ctx, ["inheritedOpenBucketQuestionsCarried"], "Inherited open questions cannot exceed open questions carried");
    }
  });
export type V9OpenEvidenceByCard = z.infer<typeof V9OpenEvidenceByCardSchema>;

/**
 * Server-computed three-number block; `open-questions.ts` is its only authority.
 * A card omitted from `byCard` carries zero obligations whenever the block
 * itself is present; a present card's counts are measured, never inferred.
 */
export const V9OpenEvidenceSchema = z
  .object({
    semantics: z.literal(V9_OPEN_EVIDENCE_SEMANTICS),
    totals: V9OpenEvidenceTotalsSchema,
    owners: z.array(V9OpenEvidenceOwnerSchema),
    reasons: z.array(V9OpenEvidenceReasonSchema),
    documentation: V9OpenEvidenceDocumentationSchema,
    issuer: V9OpenEvidenceIssuerSchema,
    byCard: z.array(V9OpenEvidenceByCardSchema),
  })
  .strict()
  .superRefine((evidence, ctx) => {
    if (evidence.documentation.questions !== evidence.totals.documentation) {
      issue(ctx, ["documentation", "questions"], "Documentation detail must match its bucket");
    }
    if (evidence.documentation.datums > evidence.totals.obligations) {
      issue(ctx, ["documentation", "datums"], "Documentation datums cannot exceed published obligations");
    }
    if (evidence.byCard.reduce((sum, card) => sum + card.documentationObligationsCarried, 0) <
        evidence.documentation.datums) {
      issue(ctx, ["byCard"], "Per-card documentation obligations cannot undercount the documentation datums");
    }
    // Canonical order keeps replay bytes stable: canonical responsibilities, `mixed` last.
    const ownerOrder = new Map<string, number>([
      ...RESPONSIBILITIES.map((responsibility, index) => [responsibility, index] as const),
      [V9_OPEN_EVIDENCE_MIXED_OWNER, RESPONSIBILITIES.length] as const,
    ]);
    const ownerRanks = evidence.owners.map((owner) => ownerOrder.get(owner.responsibility)!);
    if (ownerRanks.some((rank, index) => index > 0 && ownerRanks[index - 1]! >= rank)) {
      issue(ctx, ["owners"], "Owner rows must be unique and in canonical responsibility order");
    }
    if (evidence.owners.reduce((sum, owner) => sum + owner.questions, 0) !== evidence.totals.open) {
      issue(ctx, ["owners"], "Headline owner counts must partition the open bucket");
    }
    const reasonIdentities = evidence.reasons.map((row) => `${row.bucket}\u0000${row.code}`);
    if (!isUniqueSorted(reasonIdentities)) {
      issue(ctx, ["reasons"], "Reason rows must be unique and sorted by bucket and code");
    }
    if (!isUniqueSorted(evidence.byCard.map((card) => card.id))) {
      issue(ctx, ["byCard"], "Open-evidence card IDs must be unique and sorted");
    }
    if (evidence.totals.questions > 0 && evidence.byCard.length === 0) {
      issue(ctx, ["byCard"], "Published questions require a carrying card");
    }
  });
export type V9OpenEvidence = z.infer<typeof V9OpenEvidenceSchema>;

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
  foreignCauseGaps: canonicalTextArray(),
  commonModeGroups: SafetyScoreV9CommonModeGroupsSchema.optional(),
  pillarFreshness: SafetyScoreV9PillarFreshnessSchema.optional(),
} as const;
function refineResponse(
  response: {
    asOfSec: number;
    publishedAtSec: number;
    completeness: z.infer<typeof SafetyScoreV9CompletenessSchema>;
    cards: readonly SafetyScoreV9CurrentCard[];
    foreignCauseGaps: readonly string[];
    sourceGenerations: Readonly<Record<string, string>>;
    pillarFreshness?: z.infer<typeof SafetyScoreV9PillarFreshnessSchema>;
  },
  ctx: { addIssue: (issue: { code: "custom"; path?: PropertyKey[]; message: string }) => void },
): void {
  refineV9PublicGapContext(response, ctx);
  refineSafetyScoreV9PillarFreshness(response, ctx);
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
  const pipelineGapIds = response.cards.filter((card) => card.ratingStatus === "pipeline-gap").map((card) => card.id);
  if (JSON.stringify(pipelineGapIds) !== JSON.stringify(response.completeness.pipelineGapIds) ||
      response.cards.filter((card) => card.ratingStatus === "rated").length !== response.completeness.ratedCount) {
    ctx.addIssue({ code: "custom", path: ["completeness"], message: "V9 rated and pipeline-gap membership does not reconcile" });
  }
  for (const finding of findSafetyScoreV9ParentAttributionIssues(response)) {
    issue(ctx, ["cards"], `${finding.cardId}: ${finding.message}`);
  }
}

/** Current schema-7 envelope: proof-derived availability and exact typed exit-route identity. */
export const SafetyScoreV9CurrentResponseSchema = z
  .object({
    ...SafetyScoreV9ResponseShape,
    schemaVersion: z.literal(7),
    cards: z.array(SafetyScoreV9CurrentCardSchema),
  })
  .strict()
  .superRefine((response, ctx) => refineResponse(response, ctx));
export type SafetyScoreV9CurrentResponse = z.infer<typeof SafetyScoreV9CurrentResponseSchema>;

export const SafetyScoreV9ResponseSchema = SafetyScoreV9CurrentResponseSchema;
