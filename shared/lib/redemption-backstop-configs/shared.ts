import { BPS_PER_UNIT } from "../math";
import { trackedRedemptionDocSources } from "../redemption-backstop-docs";
import type {
  RedemptionDocSource,
  RedemptionDocSourceSupport,
  RedemptionFeeConfidence,
  RedemptionHolderEligibility,
} from "../../types";
import type {
  RedemptionBackstopConfig,
  RedemptionCostModel,
} from "./schema";

/**
 * Config shapes are defined once as zod schemas in `./schema` and inferred back
 * to TypeScript there. These re-exports keep the historical import site working
 * and stay type-only so `zod` never enters a runtime bundle through this module.
 */
export type {
  RedemptionBackstopConfig,
  RedemptionCapacityModel,
  RedemptionCostModel,
  RedemptionCostTerms,
  RedemptionV9ComposedDexExit,
  RedemptionV9RouteReviewTerms,
} from "./schema";

export {
  isRedemptionSettlementAtLeastAsConservative,
  resolveMoreConservativeRedemptionSettlement,
} from "./settlement";

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

/**
 * Backfill tracked reviewed docs (and an optional reviewedAt) onto an already
 * constructed config map, mutating each matched config object in place.
 *
 * Callers invoke this at module scope immediately after the `export const`
 * registry declaration. The mutation relies on ESM live-binding semantics:
 * because it runs synchronously during module evaluation, any consumer that
 * imports the registry observes the post-mutation state. Do NOT destructure or
 * snapshot individual config entries before this call has run — a caller that
 * captures an entry pre-mutation (e.g. via top-level eager destructuring) would
 * see it without docs/reviewedAt. Keep these calls at module scope, before any
 * consumer reads the registry.
 */
export function applyTrackedReviewedDocs(
  configs: Record<string, RedemptionBackstopConfig>,
  stablecoinIds: readonly string[],
  reviewedAt?: string,
): void {
  for (const stablecoinId of stablecoinIds) {
    const config = configs[stablecoinId];
    if (!config) {
      throw new Error(
        `Missing redemption backstop config for stablecoin id "${stablecoinId}" while applying tracked reviewed docs`,
      );
    }
    if (reviewedAt) {
      config.reviewedAt ??= reviewedAt;
    }
    if (!config.docs || config.docs.length === 0) {
      config.docs = trackedReviewedDocs(stablecoinId);
    }
  }
}

/**
 * Fan out one base config to a plain object keyed by stablecoin id.
 * Use this for plain-object merges outside of defineBackstopRegistry
 * (e.g. in offchain-issuer data files that spread the result into a larger map).
 * For use inside defineBackstopRegistry, prefer defineBatch() in factory.ts.
 */
export function expandIds(
  ids: readonly string[],
  config: RedemptionBackstopConfig,
): Record<string, RedemptionBackstopConfig> {
  return Object.fromEntries(ids.map((id) => [id, cloneRedemptionBackstopConfig(config)]));
}

export function cloneRedemptionBackstopConfig(config: RedemptionBackstopConfig): RedemptionBackstopConfig {
  return {
    ...config,
    capacityModel: { ...config.capacityModel },
    costModel: { ...config.costModel },
    ...(config.v9RouteCostTerms ? { v9RouteCostTerms: { ...config.v9RouteCostTerms } } : {}),
    ...(config.v9RouteReviewTerms ? { v9RouteReviewTerms: { ...config.v9RouteReviewTerms } } : {}),
    ...(config.v9ComposedDexExit
      ? {
          v9ComposedDexExit: {
            ...config.v9ComposedDexExit,
            docs: config.v9ComposedDexExit.docs.map(cloneRedemptionDocSource),
          },
        }
      : {}),
    ...(config.outputAssets ? { outputAssets: [...config.outputAssets] } : {}),
    ...(config.unresolvedOutputAssetKeys
      ? { unresolvedOutputAssetKeys: [...config.unresolvedOutputAssetKeys] }
      : {}),
    ...(config.docs ? { docs: config.docs.map(cloneRedemptionDocSource) } : {}),
    ...(config.notes ? { notes: [...config.notes] } : {}),
  };
}

export function cloneRedemptionDocSource(doc: RedemptionDocSource): RedemptionDocSource {
  return {
    label: doc.label,
    url: doc.url,
    ...(doc.supports ? { supports: [...doc.supports] } : {}),
  };
}

/**
 * Resolve the effective redemption cost at one requested notional.
 *
 * Fresh numeric telemetry takes precedence over the reviewed percentage
 * fallback. Reviewed minimum and fixed-dollar charges still apply because they
 * are separate terms of the same fee schedule.
 */
export function resolveRedemptionCostBpsAtNotional(
  costModel: RedemptionCostModel,
  requestedNotionalUsd: number,
  resolvedFeeBps: number | null = null,
): number | null {
  if (!Number.isFinite(requestedNotionalUsd) || requestedNotionalUsd <= 0) return null;
  const observedFeeBps =
    resolvedFeeBps != null && Number.isFinite(resolvedFeeBps) && resolvedFeeBps >= 0
      ? resolvedFeeBps
      : null;
  const normalFeeBps =
    observedFeeBps ??
    costModel.feeBpsMax ??
    costModel.feeBpsMin ??
    (costModel.kind === "fee-bps" ? costModel.feeBps : null);
  const variableFeeBps =
    costModel.feeScenario === "stress" && costModel.stressFeeBps != null
      ? costModel.stressFeeBps
      : normalFeeBps;
  const fixedCostUsd = (costModel.flatFeeUsd ?? 0) + (costModel.gasOrBridgeCostUsd ?? 0);
  if (variableFeeBps == null && costModel.minFeeUsd == null && fixedCostUsd === 0) return null;
  if (variableFeeBps != null && costModel.minFeeUsd == null && fixedCostUsd === 0) return variableFeeBps;
  const percentageFeeUsd = ((variableFeeBps ?? 0) * requestedNotionalUsd) / BPS_PER_UNIT;
  const variableFeeUsd = Math.max(percentageFeeUsd, costModel.minFeeUsd ?? 0);
  return ((variableFeeUsd + fixedCostUsd) / requestedNotionalUsd) * BPS_PER_UNIT;
}

export function resolveV9RedemptionRouteCostBpsAtNotional(
  config: RedemptionBackstopConfig,
  requestedNotionalUsd: number,
  resolvedFeeBps: number | null = null,
): number | null {
  return resolveRedemptionCostBpsAtNotional(
    { ...config.costModel, ...config.v9RouteCostTerms },
    requestedNotionalUsd,
    resolvedFeeBps,
  );
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
