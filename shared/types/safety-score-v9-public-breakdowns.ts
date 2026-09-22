import { z } from "zod";
import { ExitRouteFamilySchema } from "./exit-route";
import { RedemptionCapacityScoringHorizonSchema } from "./redemption";
import { V9ReasonCodeSchema } from "./safety-score-v9";
import {
  EXIT_SCORE_TOLERANCE,
  isUniqueSorted,
  numbersAgree,
  V9_NEUTRAL_CONTROL_SCORE,
  ScoreSchema,
} from "./safety-score-v9-public-facts";

const SafetyScoreV9PillarAdjustmentSchema = z
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

const SafetyScoreV9BackingBreakdownSchema = z
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

const SafetyScoreV9ExitBreakdownSchema = z
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
        routeFamily: ExitRouteFamilySchema,
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
        capacity: z
          .object({
            executableUsd: z.number().finite().nonnegative(),
            requestedNotionalUsd: z.number().finite().positive(),
            completionRatio: z.number().finite().min(0).max(1),
            maxCostBps: z.number().finite().nonnegative(),
            executionCostBps: z.number().finite().nonnegative(),
            settlementDelaySec: z.number().finite().nonnegative(),
            capacityScoringHorizon: RedemptionCapacityScoringHorizonSchema,
            chain: z.string().min(1).nullable(),
            protocol: z.string().min(1).nullable(),
            poolId: z.string().min(1).nullable(),
            evidenceKind: z.string().min(1),
            observedAtSec: z.number().int().nonnegative().nullable(),
          })
          .strict()
          .nullable()
          .optional(),
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
          routeFamily: ExitRouteFamilySchema,
          score: ScoreSchema.nullable(),
          included: z.boolean(),
          exclusionReason: V9ReasonCodeSchema.nullable(),
          confidenceFactor: z.number().finite().min(0).max(1).nullable().optional(),
          capacityScoringHorizon: RedemptionCapacityScoringHorizonSchema.optional(),
          settlementDelaySec: z.number().finite().nonnegative().optional(),
          capacity: z
            .object({
              executableUsd: z.number().finite().nonnegative(),
              requestedNotionalUsd: z.number().finite().positive(),
              completionRatio: z.number().finite().min(0).max(1),
            })
            .strict()
            .nullable()
            .optional(),
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

const SafetyScoreV9ControlBreakdownSchema = z
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
    const bindingScoreReconciles =
      binding.length === 0
        ? numbersAgree(breakdown.evaluatedScore, V9_NEUTRAL_CONTROL_SCORE)
        : numbersAgree(
            Math.min(...binding.map((component) => component.score)),
            breakdown.evaluatedScore,
          );
    if (!bindingScoreReconciles) {
      ctx.addIssue({
        code: "custom",
        path: ["components"],
        message: "V9 binding controls, or the neutral empty set, must reconcile the evaluated score",
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
