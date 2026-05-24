import { trackedRedemptionDocSources } from "../redemption-backstop-docs";
import type {
  RedemptionAccessModel,
  RedemptionCapacityBasis,
  RedemptionCapacityConfidence,
  RedemptionDocSource,
  RedemptionDocSourceSupport,
  RedemptionExecutionModel,
  RedemptionFeeConfidence,
  RedemptionFeeScenario,
  RedemptionFeeModelKind,
  RedemptionHolderEligibility,
  RedemptionOutputAssetType,
  RedemptionRouteExitCorrelation,
  RedemptionRouteStatus,
  RedemptionRouteFamily,
  RedemptionSettlementModel,
} from "../../types";

interface RedemptionCostScenarioConfig {
  flatFeeUsd?: number;
  minFeeUsd?: number;
  feeBpsMin?: number;
  feeBpsMax?: number;
  gasOrBridgeCostUsd?: number;
  stressFeeBps?: number;
  feeScenario?: RedemptionFeeScenario;
}

type StaticRedemptionCapacityConfidence = Exclude<RedemptionCapacityConfidence, "live-direct" | "live-proxy">;

export type RedemptionCostModel =
  | ({
      kind: "fee-bps";
      feeBps: number;
      feeDescription?: string;
      confidence?: Extract<RedemptionFeeConfidence, "fixed">;
    } & RedemptionCostScenarioConfig)
  | ({
      kind: "dynamic-or-unclear";
      feeDescription?: string;
      confidence?: Exclude<RedemptionFeeConfidence, "fixed">;
      feeModelKind?: Exclude<RedemptionFeeModelKind, "fixed-bps">;
    } & RedemptionCostScenarioConfig);

export type RedemptionCapacityModel =
  | {
      kind: "supply-full";
      confidence?: StaticRedemptionCapacityConfidence;
      basis?: RedemptionCapacityBasis;
    }
  | {
      kind: "supply-ratio";
      ratio: number;
      dailyLimitUsd?: number;
      confidence?: StaticRedemptionCapacityConfidence;
      basis?: RedemptionCapacityBasis;
    }
  | {
      kind: "fixed-usd";
      amountUsd: number;
      dailyLimitUsd?: number;
      confidence?: StaticRedemptionCapacityConfidence;
      basis?: RedemptionCapacityBasis;
    }
  | {
      kind: "reserve-sync-metadata";
      fallbackRatio?: number;
      fallbackUsd?: number;
      confidence?: StaticRedemptionCapacityConfidence;
      basis?: RedemptionCapacityBasis;
    };

export interface RedemptionBackstopConfig {
  routeFamily: RedemptionRouteFamily;
  accessModel: RedemptionAccessModel;
  settlementModel: RedemptionSettlementModel;
  executionModel: RedemptionExecutionModel;
  outputAssetType: RedemptionOutputAssetType;
  capacityModel: RedemptionCapacityModel;
  costModel: RedemptionCostModel;
  holderEligibility?: RedemptionHolderEligibility;
  routeStatus?: Extract<RedemptionRouteStatus, "open" | "unknown">;
  routeExitCorrelation?: RedemptionRouteExitCorrelation;
  /**
   * Per-config escape hatch for routes whose documented rail composes with a
   * downstream rail the holder still has to exercise — e.g., a permissionless
   * ERC-20 wrapper (wM, USDSC) whose `unwrap()` only returns the underlying,
   * which itself requires an institutional redemption. The route-family caps
   * in `redemption-backstop-scoring.ts` handle the common cases; use this when
   * the family shape alone would overstate the actual exit quality.
   */
  totalScoreCap?: number;
  docs?: RedemptionDocSource[];
  reviewedAt?: string;
  notes?: string[];
}

export function resolveDefaultHolderEligibility(
  config: Pick<RedemptionBackstopConfig, "accessModel">,
): RedemptionHolderEligibility {
  switch (config.accessModel) {
    case "permissionless-onchain":
      return "any-holder";
    case "whitelisted-onchain":
      return "whitelisted-primary";
    case "issuer-api":
      return "verified-customer";
    case "manual":
      return "issuer-discretionary";
  }
}

export function applyTrackedReviewedDocs(
  configs: Record<string, RedemptionBackstopConfig>,
  stablecoinIds: readonly string[],
  reviewedAt?: string,
): void {
  for (const stablecoinId of stablecoinIds) {
    const config = configs[stablecoinId];
    if (!config) continue;
    if (reviewedAt) {
      config.reviewedAt ??= reviewedAt;
    }
    if (!config.docs || config.docs.length === 0) {
      config.docs = trackedReviewedDocs(stablecoinId);
    }
  }
}

export function expandIds(
  ids: readonly string[],
  config: RedemptionBackstopConfig,
): Record<string, RedemptionBackstopConfig> {
  return Object.fromEntries(ids.map((id) => [id, cloneRedemptionBackstopConfig(config)]));
}

function cloneRedemptionBackstopConfig(config: RedemptionBackstopConfig): RedemptionBackstopConfig {
  return {
    ...config,
    capacityModel: { ...config.capacityModel },
    costModel: { ...config.costModel },
    ...(config.docs ? { docs: config.docs.map(cloneRedemptionDocSource) } : {}),
    ...(config.notes ? { notes: [...config.notes] } : {}),
  };
}

function cloneRedemptionDocSource(doc: RedemptionDocSource): RedemptionDocSource {
  return {
    label: doc.label,
    url: doc.url,
    ...(doc.supports ? { supports: [...doc.supports] } : {}),
  };
}

export function fixedFee(feeBps: number, feeDescription?: string): RedemptionCostModel {
  return feeDescription
    ? { kind: "fee-bps", feeBps, feeDescription, confidence: "fixed" }
    : { kind: "fee-bps", feeBps, confidence: "fixed" };
}

export const NO_PUBLIC_NUMERIC_REDEMPTION_FEE = "Public docs reviewed do not publish a numeric redemption fee.";

export const LIQUITY_STYLE_REDEMPTION_FEE = "Minimum 50 bps + baseRate (decays over time).";

export function documentedBoundSupplyFull(
  reviewedAt: string,
): Pick<RedemptionBackstopConfig, "capacityModel" | "reviewedAt"> {
  return {
    capacityModel: {
      kind: "supply-full",
      confidence: "documented-bound",
    },
    reviewedAt,
  };
}

export function documentedVariableFee(
  feeDescription: string,
  confidence: Exclude<RedemptionFeeConfidence, "fixed"> = "undisclosed-reviewed",
): RedemptionCostModel {
  const resolvedFeeModelKind =
    confidence === "formula"
      ? "formula"
      : feeDescriptionLooksUndisclosed(feeDescription)
        ? "undisclosed-reviewed"
        : "documented-variable";
  return { kind: "dynamic-or-unclear", feeDescription, confidence, feeModelKind: resolvedFeeModelKind };
}

function feeDescriptionLooksUndisclosed(feeDescription: string): boolean {
  const normalized = feeDescription.toLowerCase();
  return (
    normalized.includes("not disclosed") ||
    normalized.includes("not publish") ||
    normalized.includes("not published") ||
    normalized.includes("do not publish") ||
    normalized.includes("does not publish") ||
    normalized.includes("no separate fixed") ||
    normalized.includes("no fixed") ||
    normalized.includes("not identified")
  );
}

export function undisclosedReviewedFee(feeDescription: string = NO_PUBLIC_NUMERIC_REDEMPTION_FEE): RedemptionCostModel {
  return {
    kind: "dynamic-or-unclear",
    feeDescription,
    confidence: "undisclosed-reviewed",
    feeModelKind: "undisclosed-reviewed",
  };
}

export function sourceRef(label: string, url: string, supports?: RedemptionDocSourceSupport[]): RedemptionDocSource {
  const seen = new Set<RedemptionDocSourceSupport>();
  for (const support of supports ?? []) {
    if (seen.has(support)) {
      throw new Error(`Duplicate redemption doc support "${support}" for "${label}".`);
    }
    seen.add(support);
  }

  return supports && supports.length > 0 ? { label, url, supports } : { label, url };
}

function trackedReviewedDocs(stablecoinId: string): RedemptionDocSource[] {
  return trackedRedemptionDocSources(stablecoinId, { includeLiveReserveDisplay: true });
}

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
  capacityModel: { kind: "supply-full", basis: "issuer-term-redemption" },
  costModel: undisclosedReviewedFee(),
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
  capacityModel: { kind: "supply-full", basis: "issuer-term-redemption" },
  costModel: undisclosedReviewedFee(),
};

export const collateralRedeemBase: RedemptionBackstopConfig = {
  routeFamily: "collateral-redeem",
  accessModel: "permissionless-onchain",
  settlementModel: "atomic",
  executionModel: "deterministic-onchain",
  outputAssetType: "bluechip-collateral",
  capacityModel: { kind: "supply-full", basis: "full-system-eventual" },
  costModel: undisclosedReviewedFee(),
};

export const psmSwapBase: RedemptionBackstopConfig = {
  routeFamily: "psm-swap",
  accessModel: "permissionless-onchain",
  settlementModel: "atomic",
  executionModel: "deterministic-onchain",
  outputAssetType: "stable-single",
  capacityModel: { kind: "supply-full", basis: "full-system-eventual" },
  costModel: undisclosedReviewedFee(),
};

export const basketRedeemBase: RedemptionBackstopConfig = {
  routeFamily: "basket-redeem",
  accessModel: "permissionless-onchain",
  settlementModel: "atomic",
  executionModel: "deterministic-basket",
  outputAssetType: "stable-basket",
  capacityModel: { kind: "supply-full", basis: "full-system-eventual" },
  costModel: undisclosedReviewedFee(),
};

export const queueRedeemBase: RedemptionBackstopConfig = {
  routeFamily: "queue-redeem",
  accessModel: "permissionless-onchain",
  settlementModel: "queued",
  executionModel: "rules-based-nav",
  outputAssetType: "stable-single",
  capacityModel: { kind: "supply-ratio", ratio: 0.1, basis: "strategy-buffer" },
  costModel: undisclosedReviewedFee(),
};
