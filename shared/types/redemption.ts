import { z } from "zod";
import { MethodologyEnvelopeSchema } from "./methodology-envelope";

export const RedemptionRouteFamilySchema = z.enum([
  "stablecoin-redeem",
  "basket-redeem",
  "collateral-redeem",
  "psm-swap",
  "queue-redeem",
  "offchain-issuer",
]);
export type RedemptionRouteFamily = z.infer<typeof RedemptionRouteFamilySchema>;

export const RedemptionAccessModelSchema = z.enum([
  "permissionless-onchain",
  "whitelisted-onchain",
  "issuer-api",
  "manual",
]);
export type RedemptionAccessModel = z.infer<typeof RedemptionAccessModelSchema>;

export const RedemptionSettlementModelSchema = z.enum([
  "atomic",
  "immediate",
  "same-day",
  "days",
  "queued",
]);
export type RedemptionSettlementModel = z.infer<typeof RedemptionSettlementModelSchema>;

export const RedemptionExecutionModelSchema = z.enum([
  "deterministic-onchain",
  "deterministic-basket",
  "rules-based-nav",
  "opaque",
]);
export type RedemptionExecutionModel = z.infer<typeof RedemptionExecutionModelSchema>;

export const RedemptionOutputAssetTypeSchema = z.enum([
  "stable-single",
  "stable-basket",
  "bluechip-collateral",
  "mixed-collateral",
  "nav",
]);
export type RedemptionOutputAssetType = z.infer<typeof RedemptionOutputAssetTypeSchema>;

export const RedemptionSourceModeSchema = z.enum([
  "dynamic",
  "estimated",
  "static",
]);
export type RedemptionSourceMode = z.infer<typeof RedemptionSourceModeSchema>;

export const RedemptionResolutionStateSchema = z.enum([
  "resolved",
  "missing-cache",
  "missing-capacity",
  "failed",
  "impaired",
]);
export type RedemptionResolutionState = z.infer<
  typeof RedemptionResolutionStateSchema
>;

export const RedemptionRouteStatusSchema = z.enum([
  "open",
  "degraded",
  "paused",
  "cohort-limited",
  "unknown",
]);
export type RedemptionRouteStatus = z.infer<typeof RedemptionRouteStatusSchema>;

export const RedemptionRouteStatusSourceSchema = z.enum([
  "static-config",
  "market-implied",
  "operator-notice",
  "protocol-api",
  "onchain",
]);
export type RedemptionRouteStatusSource = z.infer<
  typeof RedemptionRouteStatusSourceSchema
>;

export const RedemptionHolderEligibilitySchema = z.enum([
  "any-holder",
  "verified-customer",
  "whitelisted-primary",
  "pre-incident-holder",
  "issuer-discretionary",
  "unknown",
]);
export type RedemptionHolderEligibility = z.infer<
  typeof RedemptionHolderEligibilitySchema
>;

export const RedemptionCapacityConfidenceSchema = z.enum([
  "live-direct",
  "live-proxy",
  "dynamic",
  "documented-bound",
  "heuristic",
]);
export type RedemptionCapacityConfidence = z.infer<
  typeof RedemptionCapacityConfidenceSchema
>;

export const RedemptionCapacityBasisSchema = z.enum([
  "issuer-term-redemption",
  "full-system-eventual",
  "daily-limit",
  "hot-buffer",
  "psm-balance-share",
  "strategy-buffer",
  "live-direct-telemetry",
  "live-proxy-buffer",
]);
export type RedemptionCapacityBasis = z.infer<typeof RedemptionCapacityBasisSchema>;

export const RedemptionCapacitySemanticsSchema = z.enum([
  "immediate-bounded",
  "eventual-only",
]);
export type RedemptionCapacitySemantics = z.infer<
  typeof RedemptionCapacitySemanticsSchema
>;

export const RedemptionFeeConfidenceSchema = z.enum([
  "fixed",
  "formula",
  "undisclosed-reviewed",
]);
export type RedemptionFeeConfidence = z.infer<
  typeof RedemptionFeeConfidenceSchema
>;

export const RedemptionFeeModelKindSchema = z.enum([
  "fixed-bps",
  "formula",
  "documented-variable",
  "undisclosed-reviewed",
]);
export type RedemptionFeeModelKind = z.infer<
  typeof RedemptionFeeModelKindSchema
>;

export const RedemptionModelConfidenceSchema = z.enum([
  "high",
  "medium",
  "low",
]);
export type RedemptionModelConfidence = z.infer<
  typeof RedemptionModelConfidenceSchema
>;

export const RedemptionDocSourceSupportSchema = z.enum([
  "route",
  "capacity",
  "fees",
  "access",
  "settlement",
]);
export type RedemptionDocSourceSupport = z.infer<
  typeof RedemptionDocSourceSupportSchema
>;

export const RedemptionDocsProvenanceSchema = z.enum([
  "config-reviewed",
  "live-reserve-display",
  "proof-of-reserves",
  "preferred-link",
]);
export type RedemptionDocsProvenance = z.infer<
  typeof RedemptionDocsProvenanceSchema
>;

const RedemptionDocSourceSchema = z.object({
  label: z.string(),
  url: z.string().url(),
  supports: z.array(RedemptionDocSourceSupportSchema).optional(),
});
export type RedemptionDocSource = z.infer<typeof RedemptionDocSourceSchema>;

const RedemptionDocsSchema = z.object({
  label: z.string().optional(),
  url: z.string().url().optional(),
  reviewedAt: z.string().optional(),
  provenance: RedemptionDocsProvenanceSchema.optional(),
  sources: z.array(RedemptionDocSourceSchema).optional(),
});

export const RedemptionBackstopEntrySchema = z.object({
  stablecoinId: z.string(),
  score: z.number().nullable(),
  effectiveExitScore: z.number().nullable(),
  dexLiquidityScore: z.number().nullable(),
  accessScore: z.number().nullable(),
  settlementScore: z.number().nullable(),
  executionCertaintyScore: z.number().nullable(),
  capacityScore: z.number().nullable(),
  outputAssetQualityScore: z.number().nullable(),
  costScore: z.number().nullable(),
  routeFamily: RedemptionRouteFamilySchema,
  accessModel: RedemptionAccessModelSchema,
  settlementModel: RedemptionSettlementModelSchema,
  executionModel: RedemptionExecutionModelSchema,
  outputAssetType: RedemptionOutputAssetTypeSchema,
  provider: z.string(),
  sourceMode: RedemptionSourceModeSchema,
  resolutionState: RedemptionResolutionStateSchema,
  routeStatus: RedemptionRouteStatusSchema.optional().default("unknown"),
  routeStatusSource: RedemptionRouteStatusSourceSchema.optional().default("static-config"),
  routeStatusReason: z.string().optional(),
  routeStatusReviewedAt: z.string().optional(),
  holderEligibility: RedemptionHolderEligibilitySchema.optional().default("unknown"),
  capacityConfidence: RedemptionCapacityConfidenceSchema,
  capacityBasis: RedemptionCapacityBasisSchema.optional(),
  capacitySemantics: RedemptionCapacitySemanticsSchema,
  feeConfidence: RedemptionFeeConfidenceSchema,
  feeModelKind: RedemptionFeeModelKindSchema,
  modelConfidence: RedemptionModelConfidenceSchema,
  immediateCapacityUsd: z.number().nullable(),
  immediateCapacityRatio: z.number().nullable(),
  feeBps: z.number().nullable(),
  feeDescription: z.string().optional(),
  queueEnabled: z.boolean(),
  methodologyVersion: z.string(),
  updatedAt: z.number(),
  docs: RedemptionDocsSchema.nullable().optional(),
  notes: z.array(z.string()).optional(),
  capsApplied: z.array(z.string()).optional(),
});
export type RedemptionBackstopEntry = z.infer<typeof RedemptionBackstopEntrySchema>;

export const RedemptionBackstopMapSchema = z.record(
  z.string(),
  RedemptionBackstopEntrySchema,
);
export type RedemptionBackstopMap = Record<string, RedemptionBackstopEntry>;

export const RedemptionBackstopMethodologySchema = MethodologyEnvelopeSchema.extend({
  componentWeights: z.object({
    access: z.number(),
    settlement: z.number(),
    executionCertainty: z.number(),
    capacity: z.number(),
    outputAssetQuality: z.number(),
    cost: z.number(),
  }),
  effectiveExitModel: z.object({
    model: z.string(),
    diversificationFactor: z.number(),
  }),
  routeFamilyCaps: z.object({
    queueRedeem: z.number(),
    offchainIssuer: z.number(),
  }),
});
export type RedemptionBackstopMethodology = z.infer<
  typeof RedemptionBackstopMethodologySchema
>;

export const RedemptionBackstopsResponseSchema = z.object({
  coins: RedemptionBackstopMapSchema,
  methodology: RedemptionBackstopMethodologySchema,
  updatedAt: z.number(),
});
export type RedemptionBackstopsResponse = z.infer<
  typeof RedemptionBackstopsResponseSchema
>;
