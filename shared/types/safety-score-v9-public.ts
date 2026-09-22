import { z } from "zod";
import { scoreToGrade } from "./safety-score-v9-grade";
import { V9DependencyEconomicRoleSchema } from "./dependency-types";
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
import { SafetyScoreV9BreakdownsSchema } from "./safety-score-v9-public-breakdowns";
import { SafetyScoreV9ScoreTraceSchema } from "./safety-score-v9-public-trace";

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
  /**
   * True when the exact V9 fact set compiled this asset's Backing reserve
   * exposures from an accepted live-reserve snapshot. Optional only so a new
   * Worker can continue reading the last pre-field publication during rollout.
   */
  backingFromLiveReserves: z.boolean().optional(),
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
} as const;
type SafetyScoreV9CardBase = z.infer<z.ZodObject<typeof SafetyScoreV9CardShape>>;

function refineCardBase(
  card: SafetyScoreV9CardBase,
  ctx: { addIssue: (issue: { code: "custom"; path?: PropertyKey[]; message: string }) => void },
): void {
  if ((card.score === null) !== (card.grade === "NR")) {
    ctx.addIssue({ code: "custom", path: ["grade"], message: "NR grade and null score must agree" });
  }
  if (card.score !== null && card.grade !== scoreToGrade(card.score)) {
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

export const SafetyScoreV9CurrentCardSchema = SafetyScoreV9CurrentCardBaseSchema
  .superRefine((card, ctx) => {
    refineCardBase(card, ctx);
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

export type SafetyScoreV9Card = SafetyScoreV9CurrentCard;

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
function refineResponse(
  response: {
    asOfSec: number;
    publishedAtSec: number;
    completeness: z.infer<typeof SafetyScoreV9CompletenessSchema>;
    cards: readonly SafetyScoreV9CurrentCard[];
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
  for (const issue of findSafetyScoreV9ParentAttributionIssues(response.cards)) {
    ctx.addIssue({
      code: "custom",
      path: ["cards"],
      message: `${issue.cardId}: ${issue.message}`,
    });
  }
}

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

// Arms v1–v4 were deleted on 2026-08-10 after retained-store evidence showed
// only v5 publications and component breakdowns on every V9 snapshot; see
// agents/legacy-cleanup-wave3/gate-evidence.md (G4–G5).
export const SafetyScoreV9ResponseSchema = SafetyScoreV9CurrentResponseSchema;
