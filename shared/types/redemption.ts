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

export const RedemptionSettlementModelSchema = z.enum(["atomic", "immediate", "same-day", "days", "queued"]);
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

export const RedemptionSourceModeSchema = z.enum(["dynamic", "estimated", "static"]);
export type RedemptionSourceMode = z.infer<typeof RedemptionSourceModeSchema>;

export const RedemptionResolutionStateSchema = z.enum([
  "resolved",
  "missing-cache",
  "missing-capacity",
  "failed",
  "impaired",
]);
export type RedemptionResolutionState = z.infer<typeof RedemptionResolutionStateSchema>;

export const RedemptionRouteStatusSchema = z.enum(["open", "degraded", "paused", "cohort-limited", "unknown"]);
export type RedemptionRouteStatus = z.infer<typeof RedemptionRouteStatusSchema>;

export const RedemptionRouteStatusSourceSchema = z.enum([
  "static-config",
  "market-implied",
  "operator-notice",
  "protocol-api",
  "onchain",
]);
export type RedemptionRouteStatusSource = z.infer<typeof RedemptionRouteStatusSourceSchema>;

export const RedemptionHolderEligibilitySchema = z.enum([
  "any-holder",
  "verified-customer",
  "whitelisted-primary",
  "pre-incident-holder",
  "issuer-discretionary",
  "unknown",
]);
export type RedemptionHolderEligibility = z.infer<typeof RedemptionHolderEligibilitySchema>;

export const RedemptionCapacityConfidenceSchema = z.enum([
  "live-direct",
  "live-proxy",
  "dynamic",
  "documented-bound",
  "heuristic",
]);
export type RedemptionCapacityConfidence = z.infer<typeof RedemptionCapacityConfidenceSchema>;

export const RedemptionCapacityBasisSchema = z.enum([
  "issuer-term-redemption",
  "full-system-eventual",
  "daily-limit",
  "fixed-buffer",
  "hot-buffer",
  "psm-balance-share",
  "strategy-buffer",
  "live-direct-telemetry",
  "live-proxy-buffer",
]);
export type RedemptionCapacityBasis = z.infer<typeof RedemptionCapacityBasisSchema>;

export const RedemptionCapacitySemanticsSchema = z.enum(["immediate-bounded", "eventual-only"]);
export type RedemptionCapacitySemantics = z.infer<typeof RedemptionCapacitySemanticsSchema>;

export const RedemptionFeeConfidenceSchema = z.enum(["fixed", "formula", "undisclosed-reviewed"]);
export type RedemptionFeeConfidence = z.infer<typeof RedemptionFeeConfidenceSchema>;

export const RedemptionFeeModelKindSchema = z.enum([
  "fixed-bps",
  "formula",
  "documented-variable",
  "undisclosed-reviewed",
]);
export type RedemptionFeeModelKind = z.infer<typeof RedemptionFeeModelKindSchema>;

export const RedemptionModelConfidenceSchema = z.enum(["high", "medium", "low"]);
export type RedemptionModelConfidence = z.infer<typeof RedemptionModelConfidenceSchema>;

export const RedemptionCapacityScoringHorizonSchema = z.enum(["immediate", "daily", "queued", "eventual", "unknown"]);
export type RedemptionCapacityScoringHorizon = z.infer<typeof RedemptionCapacityScoringHorizonSchema>;

export const RedemptionRouteExitCorrelationSchema = z.enum([
  "independent-issuer-rail",
  "same-stablecoin-pool-backing",
  "same-protocol-liquidity",
  "wrapper-to-parent-dependency",
  "unknown",
]);
export type RedemptionRouteExitCorrelation = z.infer<typeof RedemptionRouteExitCorrelationSchema>;

export const RedemptionFeeScenarioSchema = z.enum(["normal", "stress"]);
export type RedemptionFeeScenario = z.infer<typeof RedemptionFeeScenarioSchema>;

export const RedemptionDocSourceSupportSchema = z.enum(["route", "capacity", "fees", "access", "settlement"]);
export type RedemptionDocSourceSupport = z.infer<typeof RedemptionDocSourceSupportSchema>;

export const RedemptionDocsProvenanceSchema = z.enum([
  "config-reviewed",
  "live-reserve-display",
  "proof-of-reserves",
  "preferred-link",
]);
export type RedemptionDocsProvenance = z.infer<typeof RedemptionDocsProvenanceSchema>;

export const RedemptionLiveCapacityKindValues = [
  "live-direct",
  "live-direct-bounded",
  "live-queue",
  "live-proxy-validated",
  "documented-bound",
  "documented-eventual",
  "heuristic",
] as const;
export const RedemptionLiveCapacityKindSchema = z.enum(RedemptionLiveCapacityKindValues);
export type RedemptionLiveCapacityKind = z.infer<typeof RedemptionLiveCapacityKindSchema>;

export const RedemptionLiveFreshnessKindValues = [
  "verified-source-timestamp",
  "same-run-onchain",
  "same-run-api",
  "reviewed-static",
  "unverified",
] as const;
export const RedemptionLiveFreshnessKindSchema = z.enum(RedemptionLiveFreshnessKindValues);
export type RedemptionLiveFreshnessKind = z.infer<typeof RedemptionLiveFreshnessKindSchema>;

const HttpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, "Expected an http(s) URL");

export const RedemptionDocSourceSchema = z.object({
  label: z.string(),
  url: HttpUrlSchema,
  supports: z.array(RedemptionDocSourceSupportSchema).optional(),
});
export type RedemptionDocSource = z.infer<typeof RedemptionDocSourceSchema>;

export const RedemptionDocsSchema = z.object({
  label: z.string().optional(),
  url: HttpUrlSchema.optional(),
  reviewedAt: z.string().optional(),
  provenance: RedemptionDocsProvenanceSchema.optional(),
  sources: z.array(RedemptionDocSourceSchema).optional(),
});

export const RedemptionCapacityProfileSchema = z.object({
  immediateUsd: z.number().nonnegative().nullable().optional(),
  dailyLimitUsd: z.number().nonnegative().nullable().optional(),
  queuedUsd: z.number().nonnegative().nullable().optional(),
  eventualUsd: z.number().nonnegative().nullable().optional(),
  scoringUsd: z.number().nonnegative().nullable().optional(),
  scoringHorizon: RedemptionCapacityScoringHorizonSchema,
  capacityProfileConfidence: RedemptionCapacityConfidenceSchema,
  modeledExitSizeUsd: z.number().positive().optional(),
});
export type RedemptionCapacityProfile = z.infer<typeof RedemptionCapacityProfileSchema>;

export const RedemptionCostScenarioScoresSchema = z.object({
  retail: z.number().nullable().optional(),
  activeUser: z.number().nullable().optional(),
  institutional: z.number().nullable().optional(),
});
export type RedemptionCostScenarioScores = z.infer<typeof RedemptionCostScenarioScoresSchema>;

export const RedemptionConfidenceDetailsSchema = z.object({
  capacityEvidenceQuality: z.number().min(0).max(100),
  feeEvidenceQuality: z.number().min(0).max(100),
  routeStatusFreshness: z.number().min(0).max(100),
  holderCohortBreadth: z.number().min(0).max(100),
  sourceQuality: z.number().min(0).max(100),
  reviewedDocAgeDays: z.number().nonnegative().nullable().optional(),
  reasons: z.array(z.string()).optional(),
});
export type RedemptionConfidenceDetails = z.infer<typeof RedemptionConfidenceDetailsSchema>;

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
  capacityProfile: RedemptionCapacityProfileSchema.optional(),
  feeConfidence: RedemptionFeeConfidenceSchema,
  feeModelKind: RedemptionFeeModelKindSchema,
  modelConfidence: RedemptionModelConfidenceSchema,
  confidenceDetails: RedemptionConfidenceDetailsSchema.optional(),
  immediateCapacityUsd: z.number().nullable(),
  immediateCapacityRatio: z.number().nullable(),
  eventualRedeemabilityScore: z.number().nullable().optional(),
  capacityKind: RedemptionLiveCapacityKindSchema.optional(),
  freshnessKind: RedemptionLiveFreshnessKindSchema.optional(),
  sourceTimestamp: z.number().optional(),
  sourceUrls: z.array(HttpUrlSchema).optional(),
  settlementDelaySec: z.number().nonnegative().optional(),
  queueDepthUsd: z.number().nonnegative().optional(),
  dailyLimitUsd: z.number().nonnegative().optional(),
  minRedeemUsd: z.number().nonnegative().optional(),
  liveHolderEligibility: RedemptionHolderEligibilitySchema.optional(),
  feeBps: z.number().nullable(),
  feeDescription: z.string().optional(),
  costScenarioScores: RedemptionCostScenarioScoresSchema.optional(),
  routeExitCorrelation: RedemptionRouteExitCorrelationSchema.optional(),
  queueEnabled: z.boolean(),
  methodologyVersion: z.string(),
  updatedAt: z.number(),
  docs: RedemptionDocsSchema.nullable().optional(),
  notes: z.array(z.string()).optional(),
  capsApplied: z.array(z.string()).optional(),
});
export type RedemptionBackstopEntry = z.infer<typeof RedemptionBackstopEntrySchema>;

export const RedemptionBackstopDetailsSchema = RedemptionBackstopEntrySchema.pick({
  resolutionState: true,
  capacityConfidence: true,
  capacityBasis: true,
  capacitySemantics: true,
  capacityProfile: true,
  feeConfidence: true,
  feeModelKind: true,
  modelConfidence: true,
  confidenceDetails: true,
  routeStatus: true,
  routeStatusSource: true,
  routeStatusReason: true,
  routeStatusReviewedAt: true,
  holderEligibility: true,
  routeFamily: true,
  provider: true,
  sourceMode: true,
  immediateCapacityUsd: true,
  immediateCapacityRatio: true,
  eventualRedeemabilityScore: true,
  capacityKind: true,
  freshnessKind: true,
  sourceTimestamp: true,
  sourceUrls: true,
  settlementDelaySec: true,
  queueDepthUsd: true,
  dailyLimitUsd: true,
  minRedeemUsd: true,
  liveHolderEligibility: true,
  feeBps: true,
  costScenarioScores: true,
  routeExitCorrelation: true,
  docs: true,
  notes: true,
  capsApplied: true,
  feeDescription: true,
})
  .partial()
  .passthrough();
export type RedemptionBackstopDetails = z.infer<typeof RedemptionBackstopDetailsSchema>;

export const RedemptionBackstopMapSchema = z.record(z.string(), RedemptionBackstopEntrySchema);
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
    modeledExitSize: z
      .object({
        supplyRatio: z.number(),
        floorUsd: z.number(),
        capUsd: z.number(),
      })
      .optional(),
    capacityFactor: z
      .object({
        formula: z.string(),
        missingCapacityBehavior: z.string(),
      })
      .optional(),
    confidenceFactors: z
      .object({
        high: z.number(),
        medium: z.number(),
        low: z.number(),
      })
      .optional(),
    diversificationPolicy: z.string().optional(),
  }),
  routeFamilyCaps: z.object({
    queueRedeem: z.number(),
    offchainIssuer: z.number(),
  }),
});
export type RedemptionBackstopMethodology = z.infer<typeof RedemptionBackstopMethodologySchema>;

export const RedemptionBackstopsResponseSchema = z.object({
  coins: RedemptionBackstopMapSchema,
  methodology: RedemptionBackstopMethodologySchema,
  updatedAt: z.number(),
});
export type RedemptionBackstopsResponse = z.infer<typeof RedemptionBackstopsResponseSchema>;
