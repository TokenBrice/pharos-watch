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
import type { RedemptionDocSource } from "../../types";
import { isRedemptionSettlementFaster } from "./settlement";

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

const RedemptionDocSourceSchema: z.ZodType<RedemptionDocSource> = z.strictObject({
  label: z.string().min(1),
  url: HttpUrlSchema,
  supports: RedemptionDocSourceSupportsSchema.optional(),
});

const RedemptionCapacityModelSchema = z.discriminatedUnion("kind", [
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
    /**
     * Overrides the adapter-derived capacity confidence on the resolved
     * live-telemetry path. Use when a live reserve read is a bounded proxy
     * for true redeemability — e.g. sBOLD's Stability-Pool-withdrawable BOLD,
     * which K3 can temporarily restrict on collateral-exposure thresholds — so
     * the measured capacity still scores but at a documented-bound confidence
     * (modelConfidence "medium") rather than the adapter's live-direct default
     * (which would resolve to "high"). Distinct from `confidence`, which only
     * labels the fallback path when live metadata is unavailable.
     */
    liveCapacityConfidence: StaticCapacityConfidenceSchema.optional(),
    basis: RedemptionCapacityBasisSchema.optional(),
  }),
]);

export type RedemptionCapacityModel = z.infer<typeof RedemptionCapacityModelSchema>;

const RedemptionCostShapeSchema = {
  flatFeeUsd: NonNegativeNumberSchema.optional(),
  minFeeUsd: NonNegativeNumberSchema.optional(),
  feeBpsMin: NonNegativeNumberSchema.optional(),
  feeBpsMax: NonNegativeNumberSchema.optional(),
  gasOrBridgeCostUsd: NonNegativeNumberSchema.optional(),
  stressFeeBps: NonNegativeNumberSchema.optional(),
  feeScenario: RedemptionFeeScenarioSchema.optional(),
};

const RedemptionCostTermsSchema = z.strictObject(RedemptionCostShapeSchema);
const RedemptionV9RouteReviewTermsSchema = z.strictObject({
  minRedeemUsd: NonNegativeNumberSchema.optional(),
  settlementModel: RedemptionSettlementModelSchema.optional(),
  settlementDelaySec: z.number().int().nonnegative().optional(),
  reviewedAt: ReviewedAtSchema.optional(),
  docs: z.array(RedemptionDocSourceSchema).min(1).optional(),
});
const RedemptionV9ComposedDexExitSchema = z.strictObject({
  intermediateAssetId: z.string().min(1),
  conversionModel: z.literal("permissionless-atomic-wrap"),
  chain: z.string().min(1),
  wrapperContract: z.string().min(1),
  reviewedAt: ReviewedAtSchema,
  docs: z.array(RedemptionDocSourceSchema).min(1),
});

export type RedemptionCostTerms = z.infer<typeof RedemptionCostTermsSchema>;
export type RedemptionV9RouteReviewTerms = z.infer<typeof RedemptionV9RouteReviewTermsSchema>;
export type RedemptionV9ComposedDexExit = z.infer<typeof RedemptionV9ComposedDexExitSchema>;

const RedemptionCostModelSchema = z.discriminatedUnion("kind", [
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

export type RedemptionCostModel = z.infer<typeof RedemptionCostModelSchema>;

export const RedemptionBackstopConfigSchema = z
  .strictObject({
    routeFamily: RedemptionRouteFamilySchema,
    accessModel: RedemptionAccessModelSchema,
    settlementModel: RedemptionSettlementModelSchema,
    executionModel: RedemptionExecutionModelSchema,
    outputAssetType: RedemptionOutputAssetTypeSchema,
    capacityModel: RedemptionCapacityModelSchema,
    costModel: RedemptionCostModelSchema,
    /**
     * Reviewed cost terms projected only by the Safety Score V9 route adapter.
     *
     * This compatibility overlay keeps evidence corrections made after the V8
     * methodology freeze from changing the public V8 redemption producer.
     */
    v9RouteCostTerms: RedemptionCostTermsSchema.optional(),
    /**
     * Reviewed route constraints projected only by the Safety Score V9 adapter.
     *
     * Conservative corrections need no citation because they can only lower a
     * score. Faster settlement semantics require an explicit cited SLA and a
     * dated review; runtime projection also preserves any stricter constraint
     * carried by the captured redemption row.
     */
    v9RouteReviewTerms: RedemptionV9RouteReviewTermsSchema.optional(),
    /**
     * Reviewed fee-free wrap composed with the intermediate asset's captured DEX
     * routes. This is projected only into V9 and does not alter the V8 producer.
     */
    v9ComposedDexExit: RedemptionV9ComposedDexExitSchema.optional(),
    holderEligibility: RedemptionHolderEligibilitySchema.optional(),
    routeStatus: z.enum(["open", "unknown"]).optional(),
    routeExitCorrelation: RedemptionRouteExitCorrelationSchema.optional(),
    /**
     * Per-config escape hatch for routes whose documented rail composes with a
     * downstream rail the holder still has to exercise — e.g., a permissionless
     * ERC-20 wrapper (wM, USDSC) whose `unwrap()` only returns the underlying,
     * which itself requires an institutional redemption. The route-family caps
     * in `redemption-backstop-scoring.ts` handle the common cases; use this when
     * the family shape alone would overstate the actual exit quality.
     */
    totalScoreCap: z.number().gt(0).lte(100).optional(),
    /**
     * Concrete redemption output assets, when the documented rail names them.
     * Tracked stablecoin ids (e.g. "usdc-circle") for stable-single /
     * stable-basket outputs; canonical `asset:<symbol>` keys (e.g.
     * "asset:weth") for collateral outputs. Drives exit-route output
     * resolution — leave unset when the output composition is not documented.
     */
    outputAssets: z.array(z.string().min(1)).min(1).max(MAX_REDEMPTION_OUTPUT_ASSETS).optional(),
    /**
     * Complete reviewed output identities that cannot yet be represented as
     * tracked, priceable `outputAssets`. These stay explicitly unresolved and
     * never make an output scoreable; they only preserve bounded diagnostics
     * instead of collapsing a known untracked basket into an anonymous gap.
     */
    unresolvedOutputAssetKeys: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_REDEMPTION_OUTPUT_ASSETS)
      .optional(),
    /**
     * Causal disposition for an output that remains deliberately unresolved.
     *
     * `reviewed-external` means the documented identity is known but the
     * runtime producer cannot yet value the external/untracked output.
     * `issuer-undisclosed` means the reviewed issuer materials do not disclose
     * the settlement asset. Neither disposition makes the output scoreable.
     */
    unresolvedOutputDisposition: z.enum(["reviewed-external", "issuer-undisclosed"]).optional(),
    docs: z.array(RedemptionDocSourceSchema).optional(),
    reviewedAt: ReviewedAtSchema.optional(),
    notes: z.array(z.string()).optional(),
  })
  .superRefine((config, ctx) => {
    const reviewedSettlement = config.v9RouteReviewTerms;
    const fasterSettlementModel =
      reviewedSettlement?.settlementModel !== undefined &&
      isRedemptionSettlementFaster(reviewedSettlement.settlementModel, config.settlementModel);
    if (
      fasterSettlementModel &&
      (reviewedSettlement.settlementDelaySec === undefined ||
        reviewedSettlement.reviewedAt === undefined ||
        reviewedSettlement.docs === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["v9RouteReviewTerms", "settlementModel"],
        message:
          "Faster V9 reviewed settlement requires settlementDelaySec, reviewedAt, and at least one docs source",
      });
    }
    if (
      !fasterSettlementModel &&
      reviewedSettlement?.settlementDelaySec !== undefined &&
      (reviewedSettlement.reviewedAt === undefined || reviewedSettlement.docs === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["v9RouteReviewTerms", "settlementDelaySec"],
        message:
          "Explicit V9 reviewed settlement SLA requires reviewedAt and at least one docs source",
      });
    }
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
    if (config.unresolvedOutputAssetKeys) {
      if (
        new Set(config.unresolvedOutputAssetKeys).size !==
        config.unresolvedOutputAssetKeys.length
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["unresolvedOutputAssetKeys"],
          message: "unresolvedOutputAssetKeys cannot contain duplicates",
        });
      }
      if (config.outputAssets) {
        ctx.addIssue({
          code: "custom",
          path: ["unresolvedOutputAssetKeys"],
          message: "unresolvedOutputAssetKeys cannot be combined with resolved outputAssets",
        });
      }
    }
    if (config.unresolvedOutputDisposition && config.outputAssets) {
      ctx.addIssue({
        code: "custom",
        path: ["unresolvedOutputDisposition"],
        message: "unresolvedOutputDisposition cannot be combined with resolved outputAssets",
      });
    }
    if (config.unresolvedOutputDisposition && !config.reviewedAt) {
      ctx.addIssue({
        code: "custom",
        path: ["unresolvedOutputDisposition"],
        message: "unresolvedOutputDisposition requires reviewedAt for historical admission",
      });
    }
    if (
      config.unresolvedOutputDisposition === "reviewed-external" &&
      !config.unresolvedOutputAssetKeys
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["unresolvedOutputDisposition"],
        message: "reviewed-external output disposition requires unresolvedOutputAssetKeys",
      });
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

export type RedemptionBackstopConfig = z.infer<typeof RedemptionBackstopConfigSchema>;

export function currentUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}
