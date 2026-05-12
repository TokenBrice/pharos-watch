import { z } from "zod";
import {
  RedemptionAccessModelSchema,
  RedemptionCapacityBasisSchema,
  RedemptionCapacityConfidenceSchema,
  RedemptionDocSourceSupportSchema,
  RedemptionExecutionModelSchema,
  RedemptionFeeScenarioSchema,
  RedemptionFeeModelKindSchema,
  RedemptionHolderEligibilitySchema,
  RedemptionOutputAssetTypeSchema,
  RedemptionRouteExitCorrelationSchema,
  RedemptionRouteFamilySchema,
  RedemptionSettlementModelSchema,
} from "../../types";

const REVIEWED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RatioSchema = z.number().gt(0).lte(1);

const RedemptionDocSourceSchema = z.strictObject({
  label: z.string().min(1),
  url: z.string().url(),
  supports: z.array(RedemptionDocSourceSupportSchema).optional(),
});

const RedemptionCapacityModelSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("supply-full"),
    confidence: RedemptionCapacityConfidenceSchema.optional(),
    basis: RedemptionCapacityBasisSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("supply-ratio"),
    ratio: RatioSchema,
    dailyLimitUsd: z.number().nonnegative().optional(),
    confidence: RedemptionCapacityConfidenceSchema.optional(),
    basis: RedemptionCapacityBasisSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("fixed-usd"),
    amountUsd: z.number().nonnegative(),
    dailyLimitUsd: z.number().nonnegative().optional(),
    confidence: RedemptionCapacityConfidenceSchema.optional(),
    basis: RedemptionCapacityBasisSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("reserve-sync-metadata"),
    fallbackRatio: RatioSchema.optional(),
    fallbackUsd: z.number().nonnegative().optional(),
    confidence: RedemptionCapacityConfidenceSchema.optional(),
    basis: RedemptionCapacityBasisSchema.optional(),
  }),
]);

const RedemptionCostShapeSchema = {
  flatFeeUsd: z.number().nonnegative().optional(),
  minFeeUsd: z.number().nonnegative().optional(),
  feeBpsMin: z.number().nonnegative().optional(),
  feeBpsMax: z.number().nonnegative().optional(),
  gasOrBridgeCostUsd: z.number().nonnegative().optional(),
  stressFeeBps: z.number().nonnegative().optional(),
  feeScenario: RedemptionFeeScenarioSchema.optional(),
};

const RedemptionCostModelSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("fee-bps"),
    feeBps: z.number().nonnegative(),
    feeDescription: z.string().min(1).optional(),
    confidence: z.literal("fixed").optional(),
    ...RedemptionCostShapeSchema,
  }),
  z.strictObject({
    kind: z.literal("dynamic-or-unclear"),
    feeDescription: z.string().min(1).optional(),
    confidence: z.enum(["formula", "undisclosed-reviewed"]).optional(),
    feeModelKind: RedemptionFeeModelKindSchema.exclude(["fixed-bps"]).optional(),
    ...RedemptionCostShapeSchema,
  }),
]);

export const RedemptionBackstopConfigSchema = z
  .strictObject({
    routeFamily: RedemptionRouteFamilySchema,
    accessModel: RedemptionAccessModelSchema,
    settlementModel: RedemptionSettlementModelSchema,
    executionModel: RedemptionExecutionModelSchema,
    outputAssetType: RedemptionOutputAssetTypeSchema,
    capacityModel: RedemptionCapacityModelSchema,
    costModel: RedemptionCostModelSchema,
    holderEligibility: RedemptionHolderEligibilitySchema.optional(),
    routeStatus: z.enum(["open", "unknown"]).optional(),
    routeExitCorrelation: RedemptionRouteExitCorrelationSchema.optional(),
    totalScoreCap: z.number().gt(0).lte(100).optional(),
    docs: z.array(RedemptionDocSourceSchema).optional(),
    reviewedAt: z.string().regex(REVIEWED_AT_PATTERN, "Expected YYYY-MM-DD").optional(),
    notes: z.array(z.string()).optional(),
  })
  .superRefine((config, ctx) => {
    if (
      config.routeFamily === "offchain-issuer" &&
      config.accessModel !== "issuer-api" &&
      config.accessModel !== "manual"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["accessModel"],
        message: "offchain-issuer routes require issuer-api or manual access",
      });
    }

    if (config.accessModel === "permissionless-onchain" && config.routeFamily === "offchain-issuer") {
      ctx.addIssue({
        code: "custom",
        path: ["routeFamily"],
        message: "permissionless-onchain access cannot use offchain-issuer routes",
      });
    }

    if (config.settlementModel === "atomic" && config.routeFamily === "offchain-issuer") {
      ctx.addIssue({
        code: "custom",
        path: ["settlementModel"],
        message: "atomic settlement cannot use offchain-issuer routes",
      });
    }

    if (
      config.routeFamily === "queue-redeem" &&
      config.settlementModel !== "queued" &&
      config.settlementModel !== "days" &&
      config.settlementModel !== "same-day"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["settlementModel"],
        message: "queue-redeem routes require queued, days, or same-day settlement",
      });
    }

    if (
      config.accessModel === "issuer-api" &&
      config.routeFamily !== "offchain-issuer" &&
      config.routeFamily !== "queue-redeem"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["accessModel"],
        message: "issuer-api access is only valid for offchain-issuer or queue-redeem routes",
      });
    }
  });
