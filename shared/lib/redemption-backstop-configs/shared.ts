import type {
  RedemptionAccessModel,
  RedemptionCapacityConfidence,
  RedemptionDocSource,
  RedemptionDocSourceSupport,
  RedemptionExecutionModel,
  RedemptionFeeConfidence,
  RedemptionFeeModelKind,
  RedemptionOutputAssetType,
  RedemptionRouteFamily,
  RedemptionSettlementModel,
} from "../../types";

export type RedemptionCostModel =
  | {
      kind: "fee-bps";
      feeBps: number;
      feeDescription?: string;
      confidence?: RedemptionFeeConfidence;
    }
  | {
      kind: "dynamic-or-unclear";
      feeDescription?: string;
      confidence?: Exclude<RedemptionFeeConfidence, "fixed">;
      feeModelKind?: Exclude<RedemptionFeeModelKind, "fixed-bps">;
    };

export type RedemptionCapacityModel =
  | { kind: "supply-full"; confidence?: RedemptionCapacityConfidence }
  | {
      kind: "supply-ratio";
      ratio: number;
      confidence?: RedemptionCapacityConfidence;
    }
  | {
      kind: "reserve-sync-metadata";
      fallbackRatio?: number;
      confidence?: RedemptionCapacityConfidence;
    };

export interface RedemptionBackstopConfig {
  routeFamily: RedemptionRouteFamily;
  accessModel: RedemptionAccessModel;
  settlementModel: RedemptionSettlementModel;
  executionModel: RedemptionExecutionModel;
  outputAssetType: RedemptionOutputAssetType;
  capacityModel: RedemptionCapacityModel;
  costModel: RedemptionCostModel;
  totalScoreCap?: number;
  docs?: RedemptionDocSource[];
  reviewedAt?: string;
  notes?: string[];
}

export function expandIds(
  ids: readonly string[],
  config: RedemptionBackstopConfig,
): Record<string, RedemptionBackstopConfig> {
  return Object.fromEntries(ids.map((id) => [id, config]));
}

export function fixedFee(feeBps: number, feeDescription?: string): RedemptionCostModel {
  return feeDescription
    ? { kind: "fee-bps", feeBps, feeDescription, confidence: "fixed" }
    : { kind: "fee-bps", feeBps, confidence: "fixed" };
}

export function documentedBoundSupplyFull(
  reviewedAt: string,
): Pick<RedemptionBackstopConfig, "capacityModel" | "reviewedAt"> {
  return {
    capacityModel: { kind: "supply-full", confidence: "documented-bound" },
    reviewedAt,
  };
}

export function documentedVariableFee(
  feeDescription: string,
  confidence: Exclude<RedemptionFeeConfidence, "fixed"> = "undisclosed-reviewed",
): RedemptionCostModel {
  const feeModelKind =
    confidence === "formula"
      ? "formula"
      : feeDescription === NO_PUBLIC_NUMERIC_REDEMPTION_FEE
        ? "undisclosed-reviewed"
        : "documented-variable";
  return { kind: "dynamic-or-unclear", feeDescription, confidence, feeModelKind };
}

export function sourceRef(
  label: string,
  url: string,
  supports?: RedemptionDocSourceSupport[],
): RedemptionDocSource {
  return supports && supports.length > 0 ? { label, url, supports } : { label, url };
}

export const NO_PUBLIC_NUMERIC_REDEMPTION_FEE = "Public docs reviewed do not publish a numeric redemption fee.";

export const LIQUITY_STYLE_REDEMPTION_FEE = "Minimum 50 bps + baseRate (decays over time).";

/** Offchain-issuer base config.
 *  Uses supply-full capacity since the full supply is eventually redeemable,
 *  while the route-family cap (65) constrains the final score to reflect
 *  the inherent delays and access restrictions of institutional redemption. */
export const issuerBase: RedemptionBackstopConfig = {
  routeFamily: "offchain-issuer",
  accessModel: "issuer-api",
  settlementModel: "same-day",
  executionModel: "rules-based-nav",
  outputAssetType: "stable-single",
  capacityModel: { kind: "supply-full" },
  costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
};

export const commodityIssuerBase: RedemptionBackstopConfig = {
  ...issuerBase,
  settlementModel: "days",
  outputAssetType: "bluechip-collateral",
};

export const stablecoinRedeemBase: RedemptionBackstopConfig = {
  routeFamily: "stablecoin-redeem",
  accessModel: "permissionless-onchain",
  settlementModel: "atomic",
  executionModel: "deterministic-onchain",
  outputAssetType: "stable-single",
  capacityModel: { kind: "supply-full" },
  costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
};

export const collateralRedeemBase: RedemptionBackstopConfig = {
  routeFamily: "collateral-redeem",
  accessModel: "permissionless-onchain",
  settlementModel: "atomic",
  executionModel: "deterministic-onchain",
  outputAssetType: "bluechip-collateral",
  capacityModel: { kind: "supply-full" },
  costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
};

export const psmSwapBase: RedemptionBackstopConfig = {
  routeFamily: "psm-swap",
  accessModel: "permissionless-onchain",
  settlementModel: "atomic",
  executionModel: "deterministic-onchain",
  outputAssetType: "stable-single",
  capacityModel: { kind: "supply-full" },
  costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
};

export const basketRedeemBase: RedemptionBackstopConfig = {
  routeFamily: "basket-redeem",
  accessModel: "permissionless-onchain",
  settlementModel: "atomic",
  executionModel: "deterministic-basket",
  outputAssetType: "stable-basket",
  capacityModel: { kind: "supply-full" },
  costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
};

export const queueRedeemBase: RedemptionBackstopConfig = {
  routeFamily: "queue-redeem",
  accessModel: "permissionless-onchain",
  settlementModel: "queued",
  executionModel: "rules-based-nav",
  outputAssetType: "stable-single",
  capacityModel: { kind: "supply-ratio", ratio: 0.1 },
  costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
};
