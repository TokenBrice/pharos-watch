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

export const ExitRouteCapacityPointSchema = z.object({
  requestedNotionalUsd: z.number().finite().positive(),
  maxCostBps: z.number().finite().nonnegative(),
  executableUsd: z.number().finite().nonnegative(),
  completionRatio: z.number().finite().min(0).max(1),
});
export type ExitRouteCapacityPoint = z.infer<typeof ExitRouteCapacityPointSchema>;

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
  confidence: ExitRouteConfidenceSchema,
  scoreEligible: z.boolean(),
  observedAt: z.number().int().nonnegative(),
  freshnessSeconds: z.number().int().nonnegative(),
  commonModeKeys: z.array(z.string().min(1)),
  capacityCurve: z.array(ExitRouteCapacityPointSchema).min(1).max(16).optional(),
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
}

function enforceRedemptionExitRouteLane(
  observation: z.infer<typeof ExitRouteObservationBaseSchema>,
  ctx: z.RefinementCtx,
) {
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
  if (observation.routeFamily === "eventual-redemption" && observation.scoreEligible) {
    ctx.addIssue({
      code: "custom",
      path: ["scoreEligible"],
      message: "eventual redemption observations are diagnostic-only",
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
  });
export type ExitRouteObservationCoverage = z.infer<typeof ExitRouteObservationCoverageSchema>;
