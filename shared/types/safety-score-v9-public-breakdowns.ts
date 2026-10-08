import { z } from "zod";
import { ExitExecutionPublicCertificateSchema, ExitRouteFamilySchema, ExitRouteCapacityEvidenceTierSchema, PhysicalToUsdTraceSchema } from "./exit-route";
import { RedemptionCapacityScoringHorizonSchema, RedemptionRouteSuspensionSchema } from "./redemption";
import { V9ReasonCodeSchema } from "./safety-score-v9";
import { V9DeploymentControlFactBaseSchema, V9IssuanceGovernanceObjectSchema, V1005IssuanceProcessObjectSchema, V1005ProcessDiagnosticObjectSchema } from "./safety-score-v9-facts";
import { V9ControlExecutionScopeSchema, V9ControlExecutionScopeObjectSchema, V9ExactControlPolicySchema } from "./safety-score-v9-control-scope";
import {
  EXIT_SCORE_TOLERANCE,
  isUniqueSorted,
  numbersAgree,
  V9_NEUTRAL_CONTROL_SCORE,
  ScoreSchema,
} from "./safety-score-v9-public-facts";
import { V9CauseContributionShape, V9BreakdownCauseShape, V9ConfidenceDimensionsSchema, refineV9CauseContribution, resolveV9EffectiveScoringWeight } from "./safety-score-v9-public-causes";

const SafetyScoreV9PillarAdjustmentSchema = z
  .object({
    kind: z.enum(["unresolved-deployment-share", "operational-resilience-credit", "dependency-limit"]),
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
    if (adjustment.kind !== "operational-resilience-credit" && adjustment.delta >= 0) {
      ctx.addIssue({
        code: "custom",
        path: ["delta"],
        message: "V9 deployment-share and dependency adjustments must reduce the pillar score",
      });
    }
  });
export type SafetyScoreV9PillarAdjustment = z.infer<
  typeof SafetyScoreV9PillarAdjustmentSchema
>;

const SafetyScoreV9BreakdownPillarBaseShape = {
  evaluatedScore: ScoreSchema.nullable(),
  publishedScore: ScoreSchema.nullable(),
  ...V9BreakdownCauseShape,
  aggregationWeight: z.number().finite().min(0).max(1),
  adjustments: z.array(SafetyScoreV9PillarAdjustmentSchema).max(3),
} as const;

function refineBreakdownAdjustments(
  breakdown: {
    evaluatedScore: number | null;
    publishedScore: number | null;
    adjustments: readonly SafetyScoreV9PillarAdjustment[];
    aggregationDisposition?: "included" | "excluded-a-b"; aggregationWeight: number;
    causeGapRefs?: readonly number[]; limitedEvidenceCauses?: readonly string[];
  },
  ctx: z.RefinementCtx,
): void {
  if (breakdown.aggregationDisposition === "excluded-a-b" && (breakdown.evaluatedScore !== null ||
      breakdown.publishedScore !== null || breakdown.aggregationWeight !== 0 || (breakdown.causeGapRefs?.length ?? 0) === 0 ||
      (breakdown.limitedEvidenceCauses?.length ?? 0) > 0)) {
    ctx.addIssue({ code: "custom", message: "Excluded pillars preserve null diagnostic scores and zero aggregate weight" });
  }
  if (breakdown.evaluatedScore === null && breakdown.adjustments.length > 0) {
    ctx.addIssue({ code: "custom", path: ["adjustments"], message: "Excluded diagnostic pillars cannot receive score adjustments" });
  }
  const kinds = breakdown.adjustments.map((adjustment) => adjustment.kind);
  const canonicalKinds = [
    "unresolved-deployment-share",
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
          score: ScoreSchema.nullable(),
          ...V9CauseContributionShape,
        })
        .strict().superRefine(refineV9CauseContribution),
    ),
    components: z.array(
      z
        .object({
          key: z.string().min(1),
          label: z.string().min(1).max(160),
          source: z.enum(["reserve-exposure", "reserve-residual", "reserve-concentration", "mechanism"]),
          score: ScoreSchema.nullable(),
          ...V9CauseContributionShape,
          wholeAssetWeight: z.number().finite().min(0).max(1).nullable().optional().describe("Defaults to the effective scoring weight; null remains unavailable"),
          weightedContribution: ScoreSchema,
          observationState: z.enum(["known", "missing", "stale", "unsupported", "bounded-unknown"]),
          factors: z.array(z.object({
            componentKey: z.string().min(1),
            score: ScoreSchema.nullable(),
            normalizedWeight: z.number().finite().min(0).max(1).optional().describe("Defaults to zero"),
            ...V9CauseContributionShape,
          }).strict().superRefine(refineV9CauseContribution)).optional(),
        })
        .strict().superRefine(refineV9CauseContribution),
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
      (sum, component) => sum + resolveV9EffectiveScoringWeight(component),
      0,
    );
    const totalContribution = breakdown.components.reduce(
      (sum, component) => sum + component.weightedContribution,
      0,
    );
    if (
      !numbersAgree(totalWeight, breakdown.evaluatedScore === null ? 0 : 1) ||
      !numbersAgree(totalContribution, breakdown.evaluatedScore ?? 0)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["components"],
        message: "V9 backing components must reconcile effective weights and evaluated score",
      });
    }
    breakdown.components.forEach((component, index) => {
      if (component.score === null && (resolveV9EffectiveScoringWeight(component) !== 0 ||
          component.weightedContribution !== 0 || !["excluded-pipeline", "excluded-uncurated", "not-applicable"].includes(component.scoringDisposition ?? "included"))) {
        ctx.addIssue({ code: "custom", path: ["components", index], message: "Excluded reserve factors must remain null and zero-weight diagnostics" });
      }
      if (
        !numbersAgree(
          component.weightedContribution,
          (component.score ?? 0) * resolveV9EffectiveScoringWeight(component),
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
        routeId: z.string().min(1),
        lane: z.enum(["dex", "redemption"]),
        label: z.string().min(1).max(160),
        routeFamily: ExitRouteFamilySchema,
        feeEvidence: z.enum(["undisclosed-reviewed", "disclosed-unquantified"]).optional(),
        score: ScoreSchema.nullable(),
        physicalToUsd: PhysicalToUsdTraceSchema.optional(),
        executionCertificate: ExitExecutionPublicCertificateSchema.optional(),
        components: z.array(
          z
            .object({
              key: z.enum(EXIT_COMPONENT_KEYS),
              label: z.string().min(1).max(120),
              score: ScoreSchema.nullable(),
              ...V9CauseContributionShape,
              weight: z.number().finite().min(0).max(1),
              weightedContribution: ScoreSchema,
            })
            .strict().superRefine(refineV9CauseContribution),
        ).length(EXIT_COMPONENT_KEYS.length),
        confidenceFactor: z.number().finite().min(0).max(1),
        confidenceDimensions: V9ConfidenceDimensionsSchema,
        capacityEvidenceTier: ExitRouteCapacityEvidenceTierSchema,
        rawSameNotionalCostBps: z.number().finite().nonnegative().nullable(),
        supportedComponentCeiling: ScoreSchema.nullable(),
        eligibilityMultiplier: z.number().finite().min(0).max(1),
        capsApplied: z.array(z.string().min(1)),
        capacity: z
          .object({
            executableUsd: z.number().finite().nonnegative(),
            requestedNotionalUsd: z.number().finite().positive(),
            completionRatio: z.number().finite().min(0).max(1),
            maxCostBps: z.number().finite().nonnegative(),
            executionCostBps: z.number().finite().nonnegative().nullable(),
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
          routeId: z.string().min(1),
          lane: z.enum(["dex", "redemption"]),
          label: z.string().min(1).max(160),
          routeFamily: ExitRouteFamilySchema,
          score: ScoreSchema.nullable(),
          included: z.boolean(),
          exclusionReason: V9ReasonCodeSchema.nullable(),
          physicalToUsd: PhysicalToUsdTraceSchema.optional(),
          routeSuspension: RedemptionRouteSuspensionSchema.optional(),
          executionCertificate: ExitExecutionPublicCertificateSchema.optional(),
          confidenceFactor: z.number().finite().min(0).max(1).nullable().optional(),
          confidenceDimensions: V9ConfidenceDimensionsSchema.nullable(),
          capacityEvidenceTier: ExitRouteCapacityEvidenceTierSchema,
          rawSameNotionalCostBps: z.number().finite().nonnegative().nullable(),
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
      (sum, component) => sum + resolveV9EffectiveScoringWeight(component),
      0,
    );
    if (!numbersAgree(totalWeight, breakdown.primaryRoute.score === null ? 0 : 1)) {
      ctx.addIssue({
        code: "custom",
        path: ["primaryRoute", "components"],
        message: "V9 exit component weights must sum to one",
      });
    }
    breakdown.primaryRoute.components.forEach((component, index) => {
      if (!numbersAgree(component.weightedContribution, (component.score ?? 0) * resolveV9EffectiveScoringWeight(component))) {
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
    if (breakdown.primaryRoute.score === null) {
      if (breakdown.evaluatedScore !== null || breakdown.diversification !== null ||
          breakdown.primaryRoute.supportedComponentCeiling !== null) {
        ctx.addIssue({ code: "custom", path: ["primaryRoute"], message: "Excluded route diagnostics cannot publish a score, ceiling or diversification credit" });
      }
      return;
    }
    const weightedComponentScore = breakdown.primaryRoute.components.reduce(
      (sum, component) => sum + component.weightedContribution,
      0,
    );
    if (breakdown.primaryRoute.supportedComponentCeiling === null) {
      ctx.addIssue({ code: "custom", path: ["primaryRoute", "supportedComponentCeiling"], message: "A scored route requires its supported-component ceiling" });
      return;
    }
    const confidence = Math.min(...Object.values(breakdown.primaryRoute.confidenceDimensions).map((value) => value.factor));
    if (!numbersAgree(confidence, breakdown.primaryRoute.confidenceFactor) ||
        !numbersAgree(weightedComponentScore, breakdown.primaryRoute.supportedComponentCeiling)) {
      ctx.addIssue({ code: "custom", path: ["primaryRoute"], message: "Route confidence dimensions and supported-component ceiling must reconcile" });
    }
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
      Math.min(100, breakdown.primaryRoute.score + (breakdown.diversification?.bonus ?? 0));
    if (breakdown.evaluatedScore === null || Math.abs(breakdown.evaluatedScore - expectedEvaluatedScore) > EXIT_SCORE_TOLERANCE) {
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

const ProcessCount = z.number().finite().int().nonnegative().safe();
const SafetyScoreV9VotingControlSummarySchema = z.object({
  observationState: z.enum(["known", "unknown"]), qualified: z.boolean(),
  largestSingleControllerShareBps: z.number().int().min(0).max(10000).nullable(),
  affiliatedAggregateShareBps: z.number().int().min(0).max(10000).nullable(),
  affiliatedUnilateralRouteCount: ProcessCount,
  unknownAboveThresholdVoteOwnershipControllerCount: ProcessCount,
  otherHolderVoteOperatorControllerCount: ProcessCount,
  privilegedVoteCreation: z.enum(["none", "governor-only", "independent", "unknown"]),
  forcedDelegation: z.enum(["none", "governor-only", "independent", "unknown"]),
  censusReconciliationCount: ProcessCount.refine((count) => count > 0), unreconciledCensusCount: ProcessCount,
}).strict().superRefine((row, ctx) => {
  if (row.unreconciledCensusCount > row.censusReconciliationCount ||
      (row.qualified && (row.observationState !== "known" || row.unreconciledCensusCount !== 0 ||
        row.affiliatedUnilateralRouteCount !== 0 || row.unknownAboveThresholdVoteOwnershipControllerCount !== 0 ||
        row.otherHolderVoteOperatorControllerCount !== 0 || !["none", "governor-only"].includes(row.privilegedVoteCreation) ||
        !["none", "governor-only"].includes(row.forcedDelegation)))) {
    ctx.addIssue({ code: "custom", message: "Voting qualification and census counts must reconcile" });
  }
});
const SafetyScoreV9IssuanceGovernanceSummarySchema = V9IssuanceGovernanceObjectSchema.omit({
  incompleteReasons: true, nonGovernorUnboundedPathKeys: true, diagnostics: true,
}).extend({
  votingControl: SafetyScoreV9VotingControlSummarySchema,
  incompleteReasonCount: ProcessCount, nonGovernorUnboundedPathCount: ProcessCount, diagnosticCount: ProcessCount,
  incompleteReasonCounts: z.array(z.object({ code: z.string().min(1), count: ProcessCount.refine((count) => count > 0) }).strict()),
}).strict().superRefine((row, ctx) => {
  if ((row.coverage === "complete") !== (row.incompleteReasonCount === 0) ||
      row.incompleteReasonCounts.reduce((total, reason) => total + reason.count, 0) !== row.incompleteReasonCount ||
      new Set(row.incompleteReasonCounts.map((reason) => reason.code)).size !== row.incompleteReasonCounts.length ||
      (row.decisionRule === "affirmative-vote") !== (row.vetoQuorumBps === null) ||
      (row.decisionRule === "affirmative-vote") !== (row.vetoOverride === null)) {
    ctx.addIssue({ code: "custom", message: "Governance coverage, reason counts and decision-rule fields must reconcile" });
  }
});
const SafetyScoreV9IssuanceProcessSummarySchema = V1005IssuanceProcessObjectSchema.omit({
  nonGovernorDiscretionaryPathKeys: true, unclassifiedExpansionPathKeys: true, unknownRecipientPathKeys: true,
  votingControl: true, diagnostics: true, evidenceRefIds: true,
}).extend({
  nonGovernorDiscretionaryPathCount: ProcessCount, unclassifiedExpansionPathCount: ProcessCount,
  unknownRecipientPathCount: ProcessCount, evidenceRefCount: ProcessCount, diagnosticCount: ProcessCount,
}).strict().superRefine((row, ctx) => {
  if (row.matchedMemberCount + row.unknownMemberCount !== row.memberCount ||
      row.formulaPathCount + row.keeperInitialPathCount + row.keeperRecurringPathCount + row.otherOperationalPathCount !== row.operationalPathCount ||
      row.fundedKeeperRecurringPathCount > row.keeperRecurringPathCount ||
      (row.fundedKeeperRecurringPathCount === 0 && row.minKeeperRecurringIntervalSec !== null) ||
      (row.envelopeTransitionPathCount === 0 && row.minEnvelopeRaisePublicDelaySec !== null)) {
    ctx.addIssue({ code: "custom", message: "Operational member, path and clock summaries must reconcile" });
  }
});
const SafetyScoreV9ProcessDiagnosticExemplarSchema = V1005ProcessDiagnosticObjectSchema.omit({ issuanceFactsRef: true }).extend({
  evidenceRefIds: V1005ProcessDiagnosticObjectSchema.shape.evidenceRefIds.max(3),
  evidenceRefCount: ProcessCount,
}).strict().superRefine((row, ctx) => {
  if (row.evidenceRefCount < row.evidenceRefIds.length ||
      (row.evidenceRefCount === 0) !== (row.evidenceRefIds.length === 0)) {
    ctx.addIssue({ code: "custom", path: ["evidenceRefCount"], message: "Evidence counts must retain bounded nonempty exemplars" });
  }
});
const SafetyScoreV9ProcessDiagnosticSummarySchema = V1005ProcessDiagnosticObjectSchema.pick({
  code: true, gate: true, classId: true, field: true,
}).extend({
  count: ProcessCount.refine((count) => count > 0),
  /** Complete sparse control identities; path/member/evidence details are bounded exemplars. */
  controlRefs: z.array(V1005ProcessDiagnosticObjectSchema.shape.controlRef).min(1),
  exemplars: z.array(SafetyScoreV9ProcessDiagnosticExemplarSchema).min(1).max(3),
}).strict().superRefine((row, ctx) => {
  if (row.count < row.exemplars.length || row.count < row.controlRefs.length ||
      new Set(row.controlRefs).size !== row.controlRefs.length || row.exemplars.some((exemplar) =>
    exemplar.code !== row.code || exemplar.gate !== row.gate || !row.controlRefs.includes(exemplar.controlRef) ||
    exemplar.classId !== row.classId || exemplar.field !== row.field)) {
    ctx.addIssue({ code: "custom", path: ["exemplars"], message: "Diagnostic counts and sampled identities must match their group" });
  }
});
export const SafetyScoreV9IssuanceSummarySchema = z.object({
  governance: SafetyScoreV9IssuanceGovernanceSummarySchema.optional(),
  process: SafetyScoreV9IssuanceProcessSummarySchema.optional(),
  diagnostics: z.array(SafetyScoreV9ProcessDiagnosticSummarySchema),
}).strict();
export type SafetyScoreV9IssuanceSummary = z.output<typeof SafetyScoreV9IssuanceSummarySchema>;

const SafetyScoreV9ControlBreakdownSchema = z
  .object({
    ...SafetyScoreV9BreakdownPillarBaseShape,
    method: z.literal("minimum-binding-component"),
    issuanceSummary: SafetyScoreV9IssuanceSummarySchema.optional(),
    components: z.array(
      z
        .object({
          key: z.string().min(1),
          label: z.string().min(1).max(160),
          kind: z.enum(["mint", "oracle", "bridge", "inventory"]),
          score: ScoreSchema.nullable(),
          ...V9CauseContributionShape,
          binding: z.boolean(),
          posture: z.string().min(1).max(120),
          controlDetails: z.array(z.object({
            controlKey: z.string().min(1),
            controlRef: V9ControlExecutionScopeObjectSchema.shape.controllerDeployment.nullable().optional(),
            authority: V9DeploymentControlFactBaseSchema.shape.authority,
            minimumCryptographicSignatures: z.number().int().positive().nullable(),
            executionScopeComplete: z.boolean().nullable(),
            moduleImpact: V9ExactControlPolicySchema.shape.moduleImpactStates.element,
            diagnostics: z.array(z.string()),
            // Component-local paths for split facts; unsplit controls retain their certificate/contributor census.
            executionPaths: z.array(V9ControlExecutionScopeSchema.shape.paths.element.pick({
              id: true, targetDeployment: true, entrypointKind: true, entrypoints: true,
              activation: true, reach: true, capabilities: true,
            })),
          }).strict()).optional(),
        })
        .strict().superRefine((component, ctx) => {
          refineV9CauseContribution(component, ctx);
          if (component.score === null && component.binding) {
            ctx.addIssue({ code: "custom", message: "Excluded control diagnostics cannot be binding" });
          }
        }),
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
    const binding = breakdown.components.filter((component) => component.binding && component.score !== null);
    const bindingScoreReconciles =
      binding.length === 0
        ? numbersAgree(breakdown.evaluatedScore, breakdown.aggregationDisposition === "excluded-a-b" ? null : V9_NEUTRAL_CONTROL_SCORE)
        : numbersAgree(
            Math.min(...binding.map((component) => component.score!)),
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
