import { z } from "zod";
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
  BaseInputGenerationIdSchema,
  isUniqueSorted,
  numbersAgree,
  SafetyScoreV9AccessPostureSchema,
  SafetyScoreV9CapSchema,
  SafetyScoreV9EvidenceFreshnessSchema,
  SafetyScoreV9NrReasonSchema,
  SafetyScoreV9PillarSchema,
  SafetyScoreV9PublicReasonListSchema,
  ScoreSchema,
  Sha256Schema,
  V9PolicyVersionSchema,
} from "./safety-score-v9-public-facts";
import { refineCard } from "./safety-score-v9-public-internal";
import { findSafetyScoreV9ParentAttributionIssues } from "./safety-score-v9-public-attribution";
import { SafetyScoreV9BreakdownsSchema, SafetyScoreV9HistoricalBreakdownsSchema } from "./safety-score-v9-public-breakdowns";
import { SafetyScoreV9ScoreTraceSchema, SafetyScoreV9WitnessScoreTraceSchema } from "./safety-score-v9-public-trace";
import { V9WrapperFormSchema } from "./safety-score-v9-wrapper";
import { V9EffectiveDependenciesV3Schema } from "./safety-score-v9-facts";
import { ReserveSliceSchema } from "./reserves";
import { causeGapRefs, V9RatingStatusSchema, V9PartialEvidenceSchema, V9DependencyCauseShape, refineV9RatingStatusFields, refineV9PublicGapReferences, refineV9PublicGapContext } from "./safety-score-v9-public-causes";
import { canonicalTextArray } from "./safety-score-v9-fact-primitives";

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
    ...V9DependencyCauseShape,
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

const SafetyScoreV9DependencySummarySchema = z
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

export const SafetyScoreV9EvidenceSummarySchema = z
  .object({
    level: V9EvidenceLevelSchema,
    freshness: SafetyScoreV9EvidenceFreshnessSchema,
    reasons: SafetyScoreV9PublicReasonListSchema,
  })
  .strict();
const SafetyScoreV9CardShape = {
  id: z.string().min(1),
  localCauseGaps: canonicalTextArray(),
  foreignCauseGapRefs: causeGapRefs(),
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
type SafetyScoreV9CardBase = z.infer<z.ZodObject<typeof SafetyScoreV9CardShape>>;

function refineCardBase(
  card: SafetyScoreV9CardBase,
  ctx: { addIssue: (issue: { code: "custom"; path?: PropertyKey[]; message: string }) => void },
): void {
  refineV9PublicGapReferences(card, ctx);
  refineV9RatingStatusFields(card, ctx);
  const excludedPillars = (["backing", "exit", "control"] as const).filter((pillar) => card.pillars[pillar].aggregationDisposition === "excluded-a-b").sort();
  if (JSON.stringify(excludedPillars) !== JSON.stringify(card.partialEvidence?.excludedPillars ?? [])) {
    ctx.addIssue({ code: "custom", path: ["partialEvidence"], message: "Partial evidence must reconcile excluded pillars" });
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
  if (card.score !== null && card.grade !== scoreToGrade(card.score)) {
    ctx.addIssue({
      code: "custom",
      path: ["grade"],
      message: "V9 numeric score and grade band must agree",
    });
  }
  if (card.ratingStatus === "rated" && Object.values(card.pillars).filter((pillar) => pillar.aggregationDisposition !== "excluded-a-b" && pillar.score !== null).length < 2) {
    ctx.addIssue({ code: "custom", path: ["pillars"], message: "A rated result requires at least two included pillars" });
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
    ctx.addIssue({
      code: "custom",
      path: ["bindingCap"],
      message: "An NR result cannot carry a binding cap",
    });
  }
  if (card.score === null && bindingCaps.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["caps"],
      message: "An NR result cannot carry a binding cap candidate",
    });
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

export const SafetyScoreV9CurrentCardBaseSchema = z
  .object({
    ...SafetyScoreV9CardShape,
    scoreTrace: SafetyScoreV9ScoreTraceSchema,
    breakdowns: SafetyScoreV9BreakdownsSchema.nullable(),
  })
  .strict();

type CardRefinementInput = Omit<z.infer<typeof SafetyScoreV9CurrentCardBaseSchema>, "breakdowns"> & {
  breakdowns: z.infer<typeof SafetyScoreV9HistoricalBreakdownsSchema> | null;
};

function refineCurrentCard(card: CardRefinementInput, ctx: z.RefinementCtx): void {
    refineCardBase(card, ctx);
    refineCard(card, ctx);
    if (card.ratingStatus === "pipeline-gap" && (card.scoreTrace.aggregation !== null ||
        Object.values(card.scoreTrace.stages).some((value) => value !== null) ||
        card.scoreTrace.scoreAdjustments.length > 0 || card.bindingCap !== null)) {
      ctx.addIssue({ code: "custom", path: ["scoreTrace"], message: "Pipeline gaps cannot publish an aggregate, grade stage, adjustment or binding cap" });
    }
    if ((card.breakdowns === null) !== (card.ratingStatus === "not-rated")) {
      ctx.addIssue({
        code: "custom",
        path: ["breakdowns"],
        message: "V9 component breakdowns are required exactly when a card is rateable",
      });
    }
    if (card.breakdowns !== null) {
      for (const pillar of ["backing", "exit", "control"] as const) {
        if ((card.breakdowns[pillar].aggregationDisposition ?? "included") !== (card.pillars[pillar].aggregationDisposition ?? "included") ||
            !numbersAgree(card.breakdowns[pillar].aggregationWeight, card.scoreTrace.aggregation?.effectiveScoringWeights[pillar] ?? 0)) {
          ctx.addIssue({ code: "custom", path: ["breakdowns", pillar], message: "Diagnostic breakdown dispositions and included aggregate weights must agree" });
        }
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
}

export const SafetyScoreV9CurrentCardSchema = SafetyScoreV9CurrentCardBaseSchema.superRefine(refineCurrentCard);

/** Report7/breakdown6 retain strict pre-10.11 route shapes. */
const SafetyScoreV9HistoricalCardBaseSchema = SafetyScoreV9CurrentCardBaseSchema.extend({
  breakdowns: SafetyScoreV9HistoricalBreakdownsSchema.nullable(),
});
export const SafetyScoreV9HistoricalCardSchema = SafetyScoreV9HistoricalCardBaseSchema.superRefine(refineCurrentCard);
export const SafetyScoreV9WitnessHistoricalCardSchema = SafetyScoreV9HistoricalCardBaseSchema.extend({
  scoreTrace: SafetyScoreV9WitnessScoreTraceSchema,
}).superRefine(refineCurrentCard);
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
} as const;
function refineResponse(
  response: {
    asOfSec: number;
    publishedAtSec: number;
    completeness: z.infer<typeof SafetyScoreV9CompletenessSchema>;
    cards: readonly SafetyScoreV9CurrentCard[];
    foreignCauseGaps: readonly string[];
  },
  ctx: { addIssue: (issue: { code: "custom"; path?: PropertyKey[]; message: string }) => void },
): void {
  refineV9PublicGapContext(response, ctx);
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
  for (const issue of findSafetyScoreV9ParentAttributionIssues(response)) {
    ctx.addIssue({
      code: "custom",
      path: ["cards"],
      message: `${issue.cardId}: ${issue.message}`,
    });
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
