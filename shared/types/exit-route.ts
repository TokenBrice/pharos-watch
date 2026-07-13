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

export const ExitRouteObservationSchema = z.object({
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
export type ExitRouteObservation = z.infer<typeof ExitRouteObservationSchema>;

export const ExitRouteObservationCoverageSchema = z.object({
  status: z.enum(["populated", "unsupported", "unknown"]),
  capabilityMatrixVersion: z.string().min(1),
  retainedPoolCount: z.number().int().nonnegative(),
  observationCount: z.number().int().nonnegative(),
  scoreEligibleObservationCount: z.number().int().nonnegative(),
  unsupportedPoolCount: z.number().int().nonnegative(),
  evidenceCounts: z.record(z.string(), z.number().int().nonnegative()),
  unsupportedReasons: z.record(z.string(), z.number().int().nonnegative()),
});
export type ExitRouteObservationCoverage = z.infer<typeof ExitRouteObservationCoverageSchema>;
