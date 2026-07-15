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
  HttpUrlSchema,
  NonNegativeNumberSchema,
  PositiveNumberSchema,
} from "../../types";
import type { RedemptionBackstopConfig, RedemptionCapacityModel, RedemptionCostModel } from "./shared";

type RedemptionBackstopDocSourceConfig = NonNullable<RedemptionBackstopConfig["docs"]>[number];

const REVIEWED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REDEMPTION_OUTPUT_ASSETS = 16;
const RatioSchema = z.number().finite().gt(0).lte(1);
const StaticCapacityConfidenceSchema = RedemptionCapacityConfidenceSchema.exclude(["live-direct", "live-proxy"]);
const ReviewedAtSchema = z
  .string()
  .regex(REVIEWED_AT_PATTERN, "Expected YYYY-MM-DD")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Expected a valid calendar date")
  .refine((value) => value <= currentUtcDate(), "reviewedAt cannot be in the future");

const RedemptionDocSourceSupportsSchema = z.array(RedemptionDocSourceSupportSchema).superRefine((supports, ctx) => {
  const seen = new Set<string>();
  for (const [index, support] of supports.entries()) {
    if (seen.has(support)) {
      ctx.addIssue({
        code: "custom",
        path: [index],
        message: `Duplicate doc support "${support}"`,
      });
    }
    seen.add(support);
  }
});

const RedemptionDocSourceSchema: z.ZodType<RedemptionBackstopDocSourceConfig> = z.strictObject({
  label: z.string().min(1),
  url: HttpUrlSchema,
  supports: RedemptionDocSourceSupportsSchema.optional(),
});

const RedemptionCapacityModelSchema: z.ZodType<RedemptionCapacityModel> = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("supply-full"),
    confidence: StaticCapacityConfidenceSchema.optional(),
    basis: RedemptionCapacityBasisSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("supply-ratio"),
    ratio: RatioSchema,
    dailyLimitUsd: PositiveNumberSchema.optional(),
    confidence: StaticCapacityConfidenceSchema.optional(),
    basis: RedemptionCapacityBasisSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("fixed-usd"),
    amountUsd: NonNegativeNumberSchema,
    dailyLimitUsd: PositiveNumberSchema.optional(),
    confidence: StaticCapacityConfidenceSchema.optional(),
    basis: RedemptionCapacityBasisSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("reserve-sync-metadata"),
    fallbackRatio: RatioSchema.optional(),
    fallbackUsd: NonNegativeNumberSchema.optional(),
    confidence: StaticCapacityConfidenceSchema.optional(),
    basis: RedemptionCapacityBasisSchema.optional(),
  }),
]);

// Mirrors RedemptionCostScenarioConfig in shared.ts; keep runtime and validation fields aligned.
const RedemptionCostShapeSchema = {
  flatFeeUsd: NonNegativeNumberSchema.optional(),
  minFeeUsd: NonNegativeNumberSchema.optional(),
  feeBpsMin: NonNegativeNumberSchema.optional(),
  feeBpsMax: NonNegativeNumberSchema.optional(),
  gasOrBridgeCostUsd: NonNegativeNumberSchema.optional(),
  stressFeeBps: NonNegativeNumberSchema.optional(),
  feeScenario: RedemptionFeeScenarioSchema.optional(),
};

const RedemptionCostModelSchema: z.ZodType<RedemptionCostModel> = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("fee-bps"),
    feeBps: NonNegativeNumberSchema,
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

export const RedemptionBackstopConfigSchema: z.ZodType<RedemptionBackstopConfig> = z
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
    outputAssets: z.array(z.string().min(1)).min(1).max(MAX_REDEMPTION_OUTPUT_ASSETS).optional(),
    docs: z.array(RedemptionDocSourceSchema).optional(),
    reviewedAt: ReviewedAtSchema.optional(),
    notes: z.array(z.string()).optional(),
  })
  .superRefine((config, ctx) => {
    if (config.outputAssets) {
      if (new Set(config.outputAssets).size !== config.outputAssets.length) {
        ctx.addIssue({ code: "custom", path: ["outputAssets"], message: "outputAssets cannot contain duplicates" });
      }
      const collateralOutput =
        config.outputAssetType === "bluechip-collateral" || config.outputAssetType === "mixed-collateral";
      for (const [index, asset] of config.outputAssets.entries()) {
        if (collateralOutput !== asset.startsWith("asset:")) {
          ctx.addIssue({
            code: "custom",
            path: ["outputAssets", index],
            message: collateralOutput
              ? "collateral outputAssets must use canonical asset:<symbol> keys"
              : "stable outputAssets must be tracked stablecoin ids, not asset:<symbol> keys",
          });
        }
      }
      if (config.outputAssetType === "stable-single" && config.outputAssets.length !== 1) {
        ctx.addIssue({
          code: "custom",
          path: ["outputAssets"],
          message: "stable-single outputAssets must name exactly one tracked stablecoin",
        });
      }
    }
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

    if (
      config.capacityModel.kind === "reserve-sync-metadata" &&
      config.capacityModel.fallbackRatio != null &&
      config.capacityModel.fallbackUsd != null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["capacityModel", "fallbackUsd"],
        message: "reserve-sync-metadata fallbackRatio and fallbackUsd are mutually exclusive",
      });
    }

    if (
      config.costModel.feeBpsMin != null &&
      config.costModel.feeBpsMax != null &&
      config.costModel.feeBpsMin > config.costModel.feeBpsMax
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["costModel", "feeBpsMin"],
        message: "feeBpsMin must be less than or equal to feeBpsMax",
      });
    }

    const normalFeeBps =
      config.costModel.kind === "fee-bps"
        ? config.costModel.feeBps
        : (config.costModel.feeBpsMax ?? config.costModel.feeBpsMin);
    if (config.costModel.stressFeeBps != null && normalFeeBps != null && config.costModel.stressFeeBps < normalFeeBps) {
      ctx.addIssue({
        code: "custom",
        path: ["costModel", "stressFeeBps"],
        message: "stressFeeBps must be greater than or equal to the normal fee bound",
      });
    }

    if (config.costModel.feeScenario === "stress" && config.costModel.stressFeeBps == null) {
      ctx.addIssue({
        code: "custom",
        path: ["costModel", "stressFeeBps"],
        message: "feeScenario=stress requires stressFeeBps",
      });
    }

    if (config.costModel.kind === "dynamic-or-unclear") {
      if (
        config.costModel.confidence === "formula" &&
        config.costModel.feeModelKind != null &&
        config.costModel.feeModelKind !== "formula"
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["costModel", "feeModelKind"],
          message: "formula fee confidence requires feeModelKind=formula when feeModelKind is set",
        });
      }

      if (config.costModel.feeModelKind === "formula" && config.costModel.confidence !== "formula") {
        ctx.addIssue({
          code: "custom",
          path: ["costModel", "confidence"],
          message: "feeModelKind=formula requires formula fee confidence",
        });
      }

      if (config.costModel.feeModelKind === "documented-variable" && !config.costModel.feeDescription) {
        ctx.addIssue({
          code: "custom",
          path: ["costModel", "feeDescription"],
          message: "documented-variable fee models require feeDescription",
        });
      }
    }
  });

export function currentUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}
