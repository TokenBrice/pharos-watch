import { TRACKED_META_BY_ID } from "../stablecoins";
import type {
  RedemptionAccessModel,
  RedemptionCapacityBasis,
  RedemptionCapacityConfidence,
  RedemptionDocSource,
  RedemptionDocSourceSupport,
  RedemptionExecutionModel,
  RedemptionFeeConfidence,
  RedemptionFeeModelKind,
  RedemptionHolderEligibility,
  RedemptionOutputAssetType,
  RedemptionRouteStatus,
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
  | {
      kind: "supply-full";
      confidence?: RedemptionCapacityConfidence;
      basis?: RedemptionCapacityBasis;
    }
  | {
      kind: "supply-ratio";
      ratio: number;
      confidence?: RedemptionCapacityConfidence;
      basis?: RedemptionCapacityBasis;
    }
  | {
      kind: "reserve-sync-metadata";
      fallbackRatio?: number;
      confidence?: RedemptionCapacityConfidence;
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

function trackedReviewedDocs(
  stablecoinId: string,
): RedemptionDocSource[] {
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  if (!meta) {
    throw new Error(`Unknown tracked stablecoin id "${stablecoinId}" while building redemption docs`);
  }

  const docs: RedemptionDocSource[] = [];
  const seen = new Set<string>();
  const push = (doc: RedemptionDocSource) => {
    const key = `${doc.label}:${doc.url}`;
    if (seen.has(key)) return;
    seen.add(key);
    docs.push(doc);
  };

  if (meta.liveReservesConfig?.display?.url) {
    push(sourceRef(
      meta.liveReservesConfig.display.label ?? "Live reserve source",
      meta.liveReservesConfig.display.url,
      ["capacity"],
    ));
  }

  if (meta.proofOfReserves?.url) {
    push(sourceRef(
      meta.proofOfReserves.provider ? `${meta.proofOfReserves.provider} feed` : "Reserve feed",
      meta.proofOfReserves.url,
      ["capacity"],
    ));
  }

  for (const link of meta.links ?? []) {
    if (
      link.label === "Docs"
      || link.label === "Proof of Reserve"
      || link.label === "Transparency"
      || link.label === "Website"
    ) {
      push(sourceRef(link.label, link.url));
    }
  }

  return docs;
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
  capacityModel: { kind: "supply-full", basis: "issuer-term-redemption" },
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
  capacityModel: { kind: "supply-full", basis: "issuer-term-redemption" },
  costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
};

export const collateralRedeemBase: RedemptionBackstopConfig = {
  routeFamily: "collateral-redeem",
  accessModel: "permissionless-onchain",
  settlementModel: "atomic",
  executionModel: "deterministic-onchain",
  outputAssetType: "bluechip-collateral",
  capacityModel: { kind: "supply-full", basis: "full-system-eventual" },
  costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
};

export const psmSwapBase: RedemptionBackstopConfig = {
  routeFamily: "psm-swap",
  accessModel: "permissionless-onchain",
  settlementModel: "atomic",
  executionModel: "deterministic-onchain",
  outputAssetType: "stable-single",
  capacityModel: { kind: "supply-full", basis: "full-system-eventual" },
  costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
};

export const basketRedeemBase: RedemptionBackstopConfig = {
  routeFamily: "basket-redeem",
  accessModel: "permissionless-onchain",
  settlementModel: "atomic",
  executionModel: "deterministic-basket",
  outputAssetType: "stable-basket",
  capacityModel: { kind: "supply-full", basis: "full-system-eventual" },
  costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
};

export const queueRedeemBase: RedemptionBackstopConfig = {
  routeFamily: "queue-redeem",
  accessModel: "permissionless-onchain",
  settlementModel: "queued",
  executionModel: "rules-based-nav",
  outputAssetType: "stable-single",
  capacityModel: { kind: "supply-ratio", ratio: 0.1, basis: "strategy-buffer" },
  costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
};
