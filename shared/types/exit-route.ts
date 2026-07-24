import { z } from "zod";

export const DexExitEvidenceKindSchema = z.enum([
  "measured-executable-depth",
  "reserve-based-amm-simulation",
  "direct-orderbook-depth",
  "generic-tvl-proxy",
  "synthetic-or-fallback",
  "unobserved",
]);
export type DexExitEvidenceKind = z.infer<typeof DexExitEvidenceKindSchema>;

export const ExitRouteFamilySchema = z.enum([
  "dex-amm",
  "dex-orderbook",
  "issuer-redemption",
  "protocol-redemption",
  "eventual-redemption",
]);
export type ExitRouteFamily = z.infer<typeof ExitRouteFamilySchema>;

export const ExitRouteEvidenceKindSchema = z.union([
  DexExitEvidenceKindSchema,
  z.enum(["documented-terms", "live-reserve-state", "onchain-contract-state", "manual-review"]),
]);
export type ExitRouteEvidenceKind = z.infer<typeof ExitRouteEvidenceKindSchema>;

const RedemptionExitEvidenceKindSchema = z.enum([
  "documented-terms",
  "live-reserve-state",
  "onchain-contract-state",
  "manual-review",
]);
export type RedemptionExitEvidenceKind = z.infer<typeof RedemptionExitEvidenceKindSchema>;

export const ExitRouteConfidenceSchema = z.enum(["high", "medium", "low", "unknown"]);
export type ExitRouteConfidence = z.infer<typeof ExitRouteConfidenceSchema>;

export const ExitRouteScopeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("chain-contract"),
    chain: z.string().min(1),
    contractOrPoolId: z.string().min(1),
    protocol: z.string().min(1),
  }),
  z.object({
    kind: z.literal("venue"),
    venue: z.string().min(1),
    protocol: z.string().min(1),
  }),
  z.object({
    kind: z.literal("issuer"),
    issuerId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("protocol"),
    protocol: z.string().min(1),
    chain: z.string().min(1).optional(),
  }),
]);
export type ExitRouteScope = z.infer<typeof ExitRouteScopeSchema>;

export const ExitRouteOutputKindSchema = z.enum([
  "tracked-stablecoin",
  "fiat",
  "collateral",
  "unresolved-asset",
  "unresolved-basket",
  "unknown",
]);
export type ExitRouteOutputKind = z.infer<typeof ExitRouteOutputKindSchema>;

export const ExitRouteOutputSchema = z.object({
  kind: ExitRouteOutputKindSchema,
  currency: z.string().min(1).optional(),
  trackedAssetIds: z.array(z.string().min(1)).optional(),
  assetKeys: z.array(z.string().min(1)).min(1).max(16).optional(),
  basketWeights: z
    .array(
      z.object({
        assetId: z.string().min(1).optional(),
        symbol: z.string().min(1).optional(),
        weight: z.number().finite().min(0).max(1),
      }),
    )
    .optional(),
});
export type ExitRouteOutput = z.infer<typeof ExitRouteOutputSchema>;

export const ExitRouteCapacityPointSchema = z
  .object({
    requestedNotionalUsd: z.number().finite().positive(),
    maxCostBps: z.number().finite().nonnegative(),
    executableUsd: z.number().finite().nonnegative(),
    completionRatio: z.number().finite().min(0).max(1),
    /** Realized cost of the defining passing quote; absent on legacy or zero-capacity points. */
    executionCostBps: z.number().finite().nonnegative().optional(),
  })
  .superRefine((point, ctx) => {
    if (point.executionCostBps != null && point.executionCostBps > point.maxCostBps) {
      ctx.addIssue({
        code: "custom",
        path: ["executionCostBps"],
        message: "Realized execution cost exceeds the request limit",
      });
    }
  });
export type ExitRouteCapacityPoint = z.infer<typeof ExitRouteCapacityPointSchema>;

export const ExitRouteObservationHistorySchema = z
  .object({
    completeProducerCycleCount: z.number().int().positive(),
    successfulObservationCount: z.number().int().positive(),
    consecutiveSuccessCount: z.number().int().nonnegative(),
    observationWindowStartedAt: z.number().int().nonnegative(),
    observationWindowEndedAt: z.number().int().nonnegative(),
    latestOperationalFailureAt: z.number().int().nonnegative().nullable(),
    conservativeStatistic: z.literal("pointwise-minimum"),
    conservativeCapacityCurve: z.array(ExitRouteCapacityPointSchema).min(1).max(16),
  })
  .strict()
  .superRefine((history, ctx) => {
    if (history.successfulObservationCount > history.completeProducerCycleCount) {
      ctx.addIssue({
        code: "custom",
        path: ["successfulObservationCount"],
        message: "Successful observations cannot exceed complete producer cycles",
      });
    }
    if (history.consecutiveSuccessCount > history.successfulObservationCount) {
      ctx.addIssue({
        code: "custom",
        path: ["consecutiveSuccessCount"],
        message: "Consecutive successes cannot exceed successful observations",
      });
    }
    if (history.observationWindowEndedAt < history.observationWindowStartedAt) {
      ctx.addIssue({
        code: "custom",
        path: ["observationWindowEndedAt"],
        message: "Observation window cannot end before it starts",
      });
    }
    if (
      history.latestOperationalFailureAt !== null &&
      (history.latestOperationalFailureAt < history.observationWindowStartedAt ||
        history.latestOperationalFailureAt > history.observationWindowEndedAt)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["latestOperationalFailureAt"],
        message: "Operational failure must fall inside the observation window",
      });
    }
  });
export type ExitRouteObservationHistory = z.infer<typeof ExitRouteObservationHistorySchema>;

export const MAX_EXIT_ROUTE_COMMON_MODE_KEYS = 16;
export const MAX_DEX_EXIT_ROUTE_OBSERVATIONS = 10;

const ExitRouteObservationBaseSchema = z.object({
  routeId: z.string().min(1),
  routeFamily: ExitRouteFamilySchema,
  scope: ExitRouteScopeSchema,
  requestedNotionalUsd: z.number().finite().positive(),
  settlementHorizonSec: z.number().int().positive(),
  maxCostBps: z.number().finite().nonnegative(),
  executableUsd: z.number().finite().nonnegative(),
  completionRatio: z.number().finite().min(0).max(1),
  output: ExitRouteOutputSchema,
  evidenceKind: ExitRouteEvidenceKindSchema,
  /** Exact measured-adapter identity when a DEX observation came from a reviewed runtime adapter. */
  adapterProfileId: z.string().min(1).optional(),
  /** Set when the route's reviewed fee is the undisclosed-reviewed class: capacity is modeled but cost is unbounded. */
  feeEvidence: z.literal("undisclosed-reviewed").optional(),
  /** Fee/slippage cost before valuing the received output asset. */
  executionCostBps: z.number().finite().nonnegative().optional(),
  /** Pinned USD unit value of the received output asset. */
  outputUnitValueUsd: z.number().finite().positive().optional(),
  /** Total input-value loss after execution cost and output-asset valuation. */
  allInCostBps: z.number().finite().nonnegative().optional(),
  /** Confidence in the route execution model, distinct from observation freshness/confidence. */
  modelConfidence: z.enum(["high", "medium", "low"]).optional(),
  confidence: ExitRouteConfidenceSchema,
  scoreEligible: z.boolean(),
  observedAt: z.number().int().nonnegative(),
  freshnessSeconds: z.number().int().nonnegative(),
  commonModeKeys: z.array(z.string().min(1)).max(MAX_EXIT_ROUTE_COMMON_MODE_KEYS),
  capacityCurve: z.array(ExitRouteCapacityPointSchema).min(1).max(16).optional(),
  observationHistory: ExitRouteObservationHistorySchema.optional(),
});

const DEX_EXIT_ROUTE_FAMILIES = new Set<ExitRouteFamily>(["dex-amm", "dex-orderbook"]);
const REDEMPTION_EXIT_ROUTE_FAMILIES = new Set<ExitRouteFamily>([
  "issuer-redemption",
  "protocol-redemption",
  "eventual-redemption",
]);
const DEX_EXIT_EVIDENCE_KINDS = new Set<string>(DexExitEvidenceKindSchema.options);
const REDEMPTION_EXIT_EVIDENCE_KINDS = new Set<string>(RedemptionExitEvidenceKindSchema.options);

function enforceDexExitRouteLane(observation: z.infer<typeof ExitRouteObservationBaseSchema>, ctx: z.RefinementCtx) {
  if (!DEX_EXIT_ROUTE_FAMILIES.has(observation.routeFamily)) {
    ctx.addIssue({ code: "custom", path: ["routeFamily"], message: "DEX observations require a DEX route family" });
  }
  if (!DEX_EXIT_EVIDENCE_KINDS.has(observation.evidenceKind)) {
    ctx.addIssue({ code: "custom", path: ["evidenceKind"], message: "DEX observations require DEX evidence" });
  }
  if (
    observation.adapterProfileId !== undefined &&
    observation.evidenceKind !== "measured-executable-depth"
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["adapterProfileId"],
      message: "Measured adapter identity requires measured executable-depth evidence",
    });
  }
  if (observation.observationHistory && observation.evidenceKind !== "measured-executable-depth") {
    ctx.addIssue({
      code: "custom",
      path: ["observationHistory"],
      message: "Producer-cycle history requires measured executable-depth evidence",
    });
  }
  if (observation.observationHistory) {
    const curve = observation.capacityCurve;
    const historyCurve = observation.observationHistory.conservativeCapacityCurve;
    const curveByPoint = new Map(
      (curve ?? []).map((point) => [`${point.requestedNotionalUsd}:${point.maxCostBps}`, point] as const),
    );
    const historyMatchesScoredCurve =
      curve?.length === historyCurve.length &&
      historyCurve.every((point) => {
        const scored = curveByPoint.get(`${point.requestedNotionalUsd}:${point.maxCostBps}`);
        return (
          scored?.executableUsd === point.executableUsd &&
          scored.completionRatio === point.completionRatio &&
          scored.executionCostBps === point.executionCostBps
        );
      });
    if (!historyMatchesScoredCurve) {
      ctx.addIssue({
        code: "custom",
        path: ["capacityCurve"],
        message: "Measured route capacity must use the conservative history curve",
      });
    }
    if (
      observation.observationHistory.observationWindowEndedAt >
      observation.observedAt + observation.freshnessSeconds + 60
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["observationHistory", "observationWindowEndedAt"],
        message: "Producer-cycle history cannot be newer than the observation clock",
      });
    }
  }
}

function enforceRedemptionExitRouteLane(
  observation: z.infer<typeof ExitRouteObservationBaseSchema>,
  ctx: z.RefinementCtx,
) {
  if (observation.adapterProfileId !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["adapterProfileId"],
      message: "Measured adapter identity is only supported for DEX observations",
    });
  }
  if (!REDEMPTION_EXIT_ROUTE_FAMILIES.has(observation.routeFamily)) {
    ctx.addIssue({
      code: "custom",
      path: ["routeFamily"],
      message: "redemption observations require a redemption route family",
    });
  }
  if (!REDEMPTION_EXIT_EVIDENCE_KINDS.has(observation.evidenceKind)) {
    ctx.addIssue({
      code: "custom",
      path: ["evidenceKind"],
      message: "redemption observations require redemption evidence",
    });
  }
  if (observation.observationHistory) {
    ctx.addIssue({
      code: "custom",
      path: ["observationHistory"],
      message: "Producer-cycle history is only supported for measured DEX evidence",
    });
  }
  if (observation.routeFamily === "eventual-redemption" && observation.scoreEligible) {
    ctx.addIssue({
      code: "custom",
      path: ["scoreEligible"],
      message: "eventual redemption observations are diagnostic-only",
    });
  }
  if (
    observation.scoreEligible &&
    observation.allInCostBps !== undefined &&
    observation.allInCostBps > observation.maxCostBps
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["allInCostBps"],
      message: "Score-eligible redemption all-in cost exceeds the request limit",
    });
  }
  if (
    observation.scoreEligible &&
    observation.outputUnitValueUsd !== undefined &&
    observation.allInCostBps === undefined
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["allInCostBps"],
      message: "A score-eligible redemption with pinned output value requires an all-in cost",
    });
  }
}

export const DexExitRouteObservationSchema = ExitRouteObservationBaseSchema.superRefine((observation, ctx) => {
  enforceDexExitRouteLane(observation, ctx);
});
export type DexExitRouteObservation = z.infer<typeof DexExitRouteObservationSchema>;

export const RedemptionExitRouteObservationSchema = ExitRouteObservationBaseSchema.superRefine((observation, ctx) => {
  enforceRedemptionExitRouteLane(observation, ctx);
});
export type RedemptionExitRouteObservation = z.infer<typeof RedemptionExitRouteObservationSchema>;

export const ExitRouteObservationSchema = ExitRouteObservationBaseSchema.superRefine((observation, ctx) => {
  if (DEX_EXIT_ROUTE_FAMILIES.has(observation.routeFamily)) enforceDexExitRouteLane(observation, ctx);
  else enforceRedemptionExitRouteLane(observation, ctx);
});
export type ExitRouteObservation = z.infer<typeof ExitRouteObservationSchema>;

export const ExitRouteObservationCoverageSchema = z
  .object({
    status: z.enum(["populated", "unsupported", "unknown"]),
    capabilityMatrixVersion: z.string().min(1),
    retainedPoolCount: z.number().int().nonnegative(),
    observationCount: z.number().int().nonnegative(),
    scoreEligibleObservationCount: z.number().int().nonnegative(),
    scoreEligiblePoolCount: z.number().int().nonnegative().optional(),
    /** Retained pools whose reviewed capability could emit a score-eligible observation. */
    scoreEligibleCapabilityPoolCount: z.number().int().nonnegative().optional(),
    unsupportedPoolCount: z.number().int().nonnegative(),
    evidenceCounts: z.record(z.string(), z.number().int().nonnegative()),
    unsupportedReasons: z.record(z.string(), z.number().int().nonnegative()),
  })
  .superRefine((coverage, ctx) => {
    if (coverage.scoreEligibleObservationCount > coverage.observationCount) {
      ctx.addIssue({
        code: "custom",
        path: ["scoreEligibleObservationCount"],
        message: "score-eligible observations cannot exceed total observations",
      });
    }
    if (coverage.unsupportedPoolCount > coverage.retainedPoolCount) {
      ctx.addIssue({
        code: "custom",
        path: ["unsupportedPoolCount"],
        message: "unsupported pools cannot exceed retained pools",
      });
    }
    if (coverage.scoreEligiblePoolCount != null) {
      if (coverage.scoreEligiblePoolCount > coverage.retainedPoolCount) {
        ctx.addIssue({
          code: "custom",
          path: ["scoreEligiblePoolCount"],
          message: "score-eligible pools cannot exceed retained pools",
        });
      }
      if (coverage.scoreEligiblePoolCount > coverage.scoreEligibleObservationCount) {
        ctx.addIssue({
          code: "custom",
          path: ["scoreEligiblePoolCount"],
          message: "each score-eligible pool requires a score-eligible observation",
        });
      }
    }
    if (coverage.scoreEligibleCapabilityPoolCount != null) {
      if (coverage.scoreEligibleCapabilityPoolCount > coverage.retainedPoolCount) {
        ctx.addIssue({
          code: "custom",
          path: ["scoreEligibleCapabilityPoolCount"],
          message: "score-eligible capability pools cannot exceed retained pools",
        });
      }
      if (
        coverage.scoreEligiblePoolCount != null &&
        coverage.scoreEligiblePoolCount > coverage.scoreEligibleCapabilityPoolCount
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["scoreEligiblePoolCount"],
          message: "score-eligible pools cannot exceed score-eligible capability pools",
        });
      }
    }
  });
export type ExitRouteObservationCoverage = z.infer<typeof ExitRouteObservationCoverageSchema>;
