import { z } from "zod";
import { issue } from "./safety-schema-primitives";
import methodologyPolicy from "../data/safety-score-v9/methodology-policy-candidate-v1.json";
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
import { normalizeDeploymentId } from "./deployment-id";
import { isV9WitnessTextReference } from "./safety-score-v9-public-witness-texts";

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
      issue(ctx, ["delta"], "V9 pillar adjustment delta must reconcile its score stages");
    }
    if (
      adjustment.kind === "operational-resilience-credit" &&
      adjustment.delta <= 0
    ) {
      issue(ctx, ["delta"], "V9 operational-resilience credit must increase the pillar score");
    }
    if (adjustment.kind !== "operational-resilience-credit" && adjustment.delta >= 0) {
      issue(ctx, ["delta"], "V9 deployment-share and dependency adjustments must reduce the pillar score");
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
    aggregationDisposition?: "included" | "excluded-a-b" | "unavailable"; aggregationWeight: number;
    causeGapRefs?: readonly number[]; limitedEvidenceCauses?: readonly string[];
  },
  ctx: z.RefinementCtx,
): void {
  if ((breakdown.aggregationDisposition ?? "included") !== "included" && (breakdown.evaluatedScore !== null ||
      breakdown.publishedScore !== null || breakdown.aggregationWeight !== 0 ||
      (breakdown.limitedEvidenceCauses?.length ?? 0) > 0)) {
    ctx.addIssue({ code: "custom", message: "Excluded or unavailable pillars preserve null diagnostic scores and zero aggregate weight" });
  }
  if (breakdown.aggregationDisposition === "excluded-a-b" && (breakdown.causeGapRefs?.length ?? 0) === 0) {
    ctx.addIssue({ code: "custom", message: "A/B-excluded pillars require their proved causal gaps" });
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
    issue(ctx, ["adjustments"], "V9 pillar adjustments must be unique and in score-stage order");
  }
  let expectedScore = breakdown.evaluatedScore;
  for (const [index, adjustment] of breakdown.adjustments.entries()) {
    if (!numbersAgree(expectedScore, adjustment.scoreBefore)) {
      issue(ctx, ["adjustments", index, "scoreBefore"], "V9 pillar adjustment must begin at the preceding score stage");
    }
    expectedScore = adjustment.scoreAfter;
  }
  if (!numbersAgree(expectedScore, breakdown.publishedScore)) {
    issue(ctx, ["publishedScore"], "V9 pillar adjustments must reconcile evaluated and published scores");
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
      issue(ctx, ["groups"], "V9 backing groups must be unique and in canonical order");
    }
    const componentKeys = breakdown.components.map((component) => component.key);
    if (!isUniqueSorted(componentKeys)) {
      issue(ctx, ["components"], "V9 backing components must be unique and sorted");
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
      issue(ctx, ["components"], "V9 backing components must reconcile effective weights and evaluated score");
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
        issue(ctx, ["components", index, "weightedContribution"], "V9 backing weighted contribution must equal score times effective weight");
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

const SafetyScoreV9ExitBreakdownBaseSchema = z
  .object({
    ...SafetyScoreV9BreakdownPillarBaseShape,
    stressRequest: z
      .object({
        requestedNotionalUsd: z.number().finite().positive(),
        maxCostBps: z.number().finite().nonnegative(),
        comparisonWindowSec: z.number().finite().positive(),
        supplyObservedAtSec: z.number().int().nonnegative().nullable().optional(),
        sizingUncertaintyReason: z.enum(["missing-supply", "stale-supply", "unusable-supply"]).nullable().optional(),
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
  .strict();

type ExitBreakdownRefinementInput = Omit<z.infer<typeof SafetyScoreV9ExitBreakdownBaseSchema>, "primaryRoute" | "alternatives"> & {
  primaryRoute: Omit<NonNullable<z.infer<typeof SafetyScoreV9ExitBreakdownBaseSchema>["primaryRoute"]>, "routeId" | "lane"> | null;
  alternatives: readonly Omit<z.infer<typeof SafetyScoreV9ExitBreakdownBaseSchema>["alternatives"][number], "routeId" | "lane">[];
};

function refineExitBreakdown(breakdown: ExitBreakdownRefinementInput, ctx: z.RefinementCtx, recordedEligibilityMultiplier = 1): void {
    refineBreakdownAdjustments(breakdown, ctx);
    if (breakdown.primaryRoute === null) return;
    const keys = breakdown.primaryRoute.components.map((component) => component.key);
    if (JSON.stringify(keys) !== JSON.stringify(EXIT_COMPONENT_KEYS)) {
      issue(ctx, ["primaryRoute", "components"], "V9 exit components must use canonical policy order");
    }
    const totalWeight = breakdown.primaryRoute.components.reduce(
      (sum, component) => sum + resolveV9EffectiveScoringWeight(component),
      0,
    );
    if (!numbersAgree(totalWeight, breakdown.primaryRoute.score === null ? 0 : 1)) {
      issue(ctx, ["primaryRoute", "components"], "V9 exit component weights must sum to one");
    }
    breakdown.primaryRoute.components.forEach((component, index) => {
      if (!numbersAgree(component.weightedContribution, (component.score ?? 0) * resolveV9EffectiveScoringWeight(component))) {
        issue(ctx, ["primaryRoute", "components", index, "weightedContribution"], "V9 exit weighted contribution must equal score times weight");
      }
    });
    if (!isUniqueSorted(breakdown.primaryRoute.capsApplied)) {
      issue(ctx, ["primaryRoute", "capsApplied"], "V9 primary-route caps must be unique and sorted");
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
      breakdown.primaryRoute.confidenceFactor * recordedEligibilityMultiplier;
    const routeScoreReconciles =
      breakdown.primaryRoute.capsApplied.length === 0
        ? Math.abs(breakdown.primaryRoute.score - preCapRouteScore) <= EXIT_SCORE_TOLERANCE
        : breakdown.primaryRoute.score <= preCapRouteScore + EXIT_SCORE_TOLERANCE;
    if (!routeScoreReconciles) {
      issue(ctx, ["primaryRoute", "score"], "V9 primary-route score must reconcile its components, multipliers, and caps");
    }
    const expectedEvaluatedScore =
      Math.min(100, breakdown.primaryRoute.score + (breakdown.diversification?.bonus ?? 0));
    if (breakdown.evaluatedScore === null || Math.abs(breakdown.evaluatedScore - expectedEvaluatedScore) > EXIT_SCORE_TOLERANCE) {
      issue(ctx, ["evaluatedScore"], "V9 exit score must reconcile its primary route and diversification bonus");
    }
    const alternativeKeys = breakdown.alternatives.map((route) => route.key);
    if (!isUniqueSorted(alternativeKeys) || alternativeKeys.includes(breakdown.primaryRoute.key)) {
      issue(ctx, ["alternatives"], "V9 alternative exit routes must be unique, sorted, and exclude the primary route");
    }
}

const SafetyScoreV9ExitBreakdownSchema = SafetyScoreV9ExitBreakdownBaseSchema.superRefine(refineExitBreakdown);

/** Breakdown6 predates typed route IDs/lanes; retain its exact strict shape. */
const SafetyScoreV9HistoricalExitBreakdownSchema = SafetyScoreV9ExitBreakdownBaseSchema.extend({
  primaryRoute: SafetyScoreV9ExitBreakdownBaseSchema.shape.primaryRoute.unwrap()
    .omit({ routeId: true, lane: true })
    .extend({ eligibilityMultiplier: z.number().finite().min(0).max(1) }).nullable(),
  alternatives: z.array(SafetyScoreV9ExitBreakdownBaseSchema.shape.alternatives.element
    .omit({ routeId: true, lane: true })),
}).superRefine((breakdown, ctx) => refineExitBreakdown(breakdown, ctx, breakdown.primaryRoute?.eligibilityMultiplier ?? 1));
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

const SafetyScoreV9ControlDetailSchema = z.object({
  controlKey: z.string().min(1),
  authority: V9DeploymentControlFactBaseSchema.shape.authority,
  minimumCryptographicSignatures: z.number().int().positive().optional().describe("Absent means unresolved"),
  executionScopeComplete: z.boolean().optional().describe("Absent means unresolved"),
  moduleImpact: V9ExactControlPolicySchema.shape.moduleImpactStates.element.exclude(["unresolved"]).optional().describe("Absent means unresolved"),
  diagnostics: z.array(z.string()).min(1).optional(),
  executionPaths: z.array(V9ControlExecutionScopeSchema.shape.paths.element.pick({
    id: true, targetDeployment: true, entrypointKind: true, entrypoints: true,
    activation: true, reach: true, capabilities: true,
  })).min(1).optional(),
}).strict();
const SafetyScoreV9LegacyControlDetailSchema = SafetyScoreV9ControlDetailSchema.extend({
  controlRef: V9ControlExecutionScopeObjectSchema.shape.controllerDeployment.nullable().optional(),
  minimumCryptographicSignatures: z.number().int().positive().nullable(),
  executionScopeComplete: z.boolean().nullable(),
  moduleImpact: V9ExactControlPolicySchema.shape.moduleImpactStates.element,
  diagnostics: z.array(z.string()),
  executionPaths: z.array(SafetyScoreV9ControlDetailSchema.shape.executionPaths.unwrap().element),
});
const SafetyScoreV9ControlComponentSchema = z.object({
  key: z.string().min(1), label: z.string().min(1).max(160),
  kind: z.enum(["mint", "oracle", "bridge", "inventory"]),
  score: ScoreSchema.nullable(), ...V9CauseContributionShape,
  binding: z.boolean(), posture: z.string().min(1).max(120),
  controlDetailRefs: z.array(z.number().int().nonnegative()).min(1).optional(),
}).strict();
const SafetyScoreV9ControlBreakdownBaseSchema = z.object({
  ...SafetyScoreV9BreakdownPillarBaseShape,
  method: z.literal("minimum-binding-component"),
  issuanceSummary: SafetyScoreV9IssuanceSummarySchema.optional(),
  controlDetails: z.array(SafetyScoreV9ControlDetailSchema).min(1).optional(),
  components: z.array(SafetyScoreV9ControlComponentSchema),
}).strict();
function refineControlBreakdown(breakdown: z.infer<typeof SafetyScoreV9ControlBreakdownBaseSchema>, ctx: z.RefinementCtx) {
  refineBreakdownAdjustments(breakdown, ctx);
  const keys = breakdown.components.map((component) => component.key);
  // Canonical witness tokens are checked after card-local resolution as well.
  if (!keys.some(isV9WitnessTextReference) && !isUniqueSorted(keys)) {
    issue(ctx, ["components"], "V9 control components must be unique and sorted");
  }
  for (const component of breakdown.components) {
    refineV9CauseContribution(component, ctx);
    if (component.score === null && component.binding) issue(ctx, ["components"], "Excluded control diagnostics cannot be binding");
  }
  const binding = breakdown.components.filter((component) => component.binding && component.score !== null);
  const minimum = binding.length === 0
    ? (breakdown.aggregationDisposition ?? "included") !== "included" ? null : V9_NEUTRAL_CONTROL_SCORE
    : Math.min(...binding.map((component) => component.score!));
  // Retained pre-R4 cards record the raw minimum; new cards clamp the pillar
  // at 90 while keeping their component diagnostics unchanged.
  if (!numbersAgree(minimum, breakdown.evaluatedScore) &&
      !numbersAgree(minimum === null ? null : Math.min(methodologyPolicy.semantic.control.authorityLadder.immutableNoPower, minimum), breakdown.evaluatedScore)) {
    issue(ctx, ["components"], "V9 binding controls must reconcile the raw or 90-clamped evaluated score");
  }
}
const SafetyScoreV9ControlBreakdownSchema = SafetyScoreV9ControlBreakdownBaseSchema.superRefine((breakdown, ctx) => {
  refineControlBreakdown(breakdown, ctx);
  const details = breakdown.controlDetails ?? [];
  const keys = details.map((detail) => detail.controlKey);
  if (!keys.some(isV9WitnessTextReference) && !isUniqueSorted(keys)) issue(ctx, ["controlDetails"], "Control details must have unique sorted identities");
  const used = new Uint8Array(details.length);
  for (const component of breakdown.components) {
    const refs = component.controlDetailRefs ?? [];
    for (const [index, ref] of refs.entries()) {
      if (ref >= details.length || index > 0 && refs[index - 1]! >= ref) {
        issue(ctx, ["components"], "Control detail references must be in range, unique and sorted");
      } else used[ref] = 1;
    }
  }
  if (used.some((value) => value === 0)) issue(ctx, ["controlDetails"], "Every control detail must be referenced");
});
const SafetyScoreV9HistoricalControlBreakdownSchema = z.union([
  SafetyScoreV9ControlBreakdownSchema,
  SafetyScoreV9ControlBreakdownBaseSchema.omit({ controlDetails: true }).extend({
    components: z.array(SafetyScoreV9ControlComponentSchema.omit({ controlDetailRefs: true }).extend({
      controlDetails: z.array(SafetyScoreV9LegacyControlDetailSchema).optional(),
    })),
  }).superRefine(refineControlBreakdown),
]);

/** Resolve only the requested component; shared facts stay shared on the canonical card. */
export function resolveV9PublicControlDetails(
  breakdown: z.infer<typeof SafetyScoreV9HistoricalControlBreakdownSchema>,
  component: z.infer<typeof SafetyScoreV9HistoricalControlBreakdownSchema>["components"][number],
) {
  if ("controlDetails" in component) return component.controlDetails ?? [];
  if (!("controlDetailRefs" in component) || !("controlDetails" in breakdown)) return [];
  return (component.controlDetailRefs ?? []).map((ref) => {
    const detail = breakdown.controlDetails?.[ref];
    if (!detail) throw new Error("Control detail reference is outside the breakdown table");
    return {
      ...detail, controlRef: normalizeDeploymentId(detail.authority?.authorityKey ?? "") || null,
      minimumCryptographicSignatures: detail.minimumCryptographicSignatures ?? null,
      executionScopeComplete: detail.executionScopeComplete ?? null, moduleImpact: detail.moduleImpact ?? "unresolved",
      diagnostics: detail.diagnostics ?? [], executionPaths: detail.executionPaths ?? [],
    };
  });
}
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

export const SafetyScoreV9HistoricalBreakdownsSchema = SafetyScoreV9BreakdownsSchema.extend({
  exit: SafetyScoreV9HistoricalExitBreakdownSchema,
  control: SafetyScoreV9HistoricalControlBreakdownSchema,
});

/** Report8 before v10.29 retains typed route identity and the recorded access charge. */
export const SafetyScoreV9HistoricalTypedBreakdownsSchema = SafetyScoreV9HistoricalBreakdownsSchema.extend({
  exit: SafetyScoreV9HistoricalExitBreakdownSchema.safeExtend({
    primaryRoute: SafetyScoreV9HistoricalExitBreakdownSchema.shape.primaryRoute.unwrap().extend({
      routeId: z.string().min(1), lane: z.enum(["dex", "redemption"]),
    }).nullable(),
    alternatives: z.array(SafetyScoreV9HistoricalExitBreakdownSchema.shape.alternatives.element.extend({
      routeId: z.string().min(1), lane: z.enum(["dex", "redemption"]),
    })),
  }),
});

type UnknownPricedComponent = Pick<SafetyScoreV9BackingBreakdown["components"][number],
  "score" | "cause" | "scoringDisposition" | "effectiveScoringWeight">;
type UnknownPricedBreakdowns = {
  backing: {
    aggregationWeight: number;
    components: readonly (UnknownPricedComponent & {
      source: string; factors?: readonly UnknownPricedComponent[];
    })[];
  };
  exit: {
    aggregationWeight: number;
    evaluatedScore: number | null;
    limitedEvidenceCauses?: readonly string[];
    primaryRoute: { components: readonly UnknownPricedComponent[] } | null;
  };
  control: {
    aggregationWeight: number;
    components: readonly (UnknownPricedComponent & { binding: boolean; posture: string })[];
  };
};

/** Display-only weight accounting, never an input to score aggregation. */
export function computeV9UnknownPricedWeightShare(
  breakdowns: UnknownPricedBreakdowns | null,
  aggregation: {
    effectiveScoringWeights: { backing: number; exit: number; control: number };
    pricedUnknownPillars?: readonly { pillar: "backing" | "exit" | "control" }[];
  } | null,
): number {
  if (breakdowns === null || aggregation === null) return 0;
  const isUnknown = (component: UnknownPricedComponent): boolean =>
    component.score !== null && (component.cause === "C" || component.cause === "U") &&
    component.scoringDisposition === "bounded-uncertainty";
  const unknownWeight = (component: UnknownPricedComponent): number =>
    isUnknown(component) ? resolveV9EffectiveScoringWeight(component) : 0;
  let share = 0;
  for (const pillar of ["backing", "exit", "control"] as const) {
    const weight = aggregation.effectiveScoringWeights[pillar];
    if (aggregation.pricedUnknownPillars?.some((item) => item.pillar === pillar)) {
      share += weight;
      continue;
    }
    if (pillar === "backing") {
      for (const component of breakdowns.backing.components) {
        // Reserve rows blend factors; mechanism constraints already publish
        // the controlling minimum's cause on their parent component.
        const factors = component.source === "reserve-exposure" ? component.factors : undefined;
        const fraction = factors?.length
          ? factors.reduce((sum, factor) => sum + unknownWeight(factor), 0)
          : isUnknown(component) ? 1 : 0;
        share += weight * resolveV9EffectiveScoringWeight(component) * fraction;
      }
    } else if (pillar === "exit") {
      const exit = breakdowns.exit;
      if (exit.primaryRoute !== null) {
        share += weight * exit.primaryRoute.components.reduce((sum, component) => sum + unknownWeight(component), 0);
      } else if (exit.limitedEvidenceCauses?.some((cause) => cause === "A" || cause === "C" || cause === "U")) {
        // No-route covered-share Exit=(1-z)*50: verified pool-less supply is
        // measured zero, not unknown-priced weight. Pipeline-A gaps price at U.
        const cause = exit.limitedEvidenceCauses.includes("C") ? "C" : "U";
        share += weight * Math.min(1, (exit.evaluatedScore ?? 0) / methodologyPolicy.semantic.unknownQuality.exit[cause]);
      }
    } else {
      let minimum = Infinity;
      let unknownMinimum = false;
      for (const component of breakdowns.control.components) {
        if (!component.binding || component.score === null || resolveV9EffectiveScoringWeight(component) === 0) continue;
        // A known authority can retain a C/U reconciliation question without
        // its measured topology being priced at an unknown constant.
        const unknown = isUnknown(component) &&
          (component.posture === "unknown" || component.posture === "opaque-or-unknown");
        if (component.score < minimum) {
          minimum = component.score;
          unknownMinimum = unknown;
        } else if (component.score === minimum && !unknown) {
          // An equally restrictive measured path still binds without the gap.
          unknownMinimum = false;
        }
      }
      if (unknownMinimum) share += weight;
    }
  }
  return Math.min(1, Math.max(0, share));
}
