import { BPS_PER_UNIT } from "../math";
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

// Keep these fields in sync with RedemptionCostShapeSchema in schema.ts.
export interface RedemptionCostTerms {
  flatFeeUsd?: number;
  minFeeUsd?: number;
  feeBpsMin?: number;
  feeBpsMax?: number;
  gasOrBridgeCostUsd?: number;
  stressFeeBps?: number;
  feeScenario?: RedemptionFeeScenario;
}

export interface RedemptionV9RouteReviewTerms {
  minRedeemUsd?: number;
  settlementModel?: RedemptionSettlementModel;
}

export const REDEMPTION_SETTLEMENT_CONSERVATISM: readonly RedemptionSettlementModel[] = [
  "atomic",
  "immediate",
  "same-day",
  "days",
  "queued",
];

export function isRedemptionSettlementAtLeastAsConservative(
  candidate: RedemptionSettlementModel,
  baseline: RedemptionSettlementModel,
): boolean {
  return (
    REDEMPTION_SETTLEMENT_CONSERVATISM.indexOf(candidate) >=
    REDEMPTION_SETTLEMENT_CONSERVATISM.indexOf(baseline)
  );
}

export function resolveMoreConservativeRedemptionSettlement(
  left: RedemptionSettlementModel,
  right: RedemptionSettlementModel,
): RedemptionSettlementModel {
  return isRedemptionSettlementAtLeastAsConservative(right, left) ? right : left;
}

type StaticRedemptionCapacityConfidence = Exclude<RedemptionCapacityConfidence, "live-direct" | "live-proxy">;

export type RedemptionCostModel =
  | ({
      kind: "fee-bps";
      feeBps: number;
      feeDescription?: string;
      confidence?: Extract<RedemptionFeeConfidence, "fixed">;
    } & RedemptionCostTerms)
  | ({
      kind: "dynamic-or-unclear";
      feeDescription?: string;
      confidence?: Exclude<RedemptionFeeConfidence, "fixed">;
      feeModelKind?: Exclude<RedemptionFeeModelKind, "fixed-bps">;
    } & RedemptionCostTerms);

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
      liveCapacityConfidence?: StaticRedemptionCapacityConfidence;
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
  /**
   * Reviewed cost terms projected only by the Safety Score V9 route adapter.
   *
   * This compatibility overlay keeps evidence corrections made after the V8
   * methodology freeze from changing the public V8 redemption producer.
   */
  v9RouteCostTerms?: RedemptionCostTerms;
  /**
   * Reviewed route constraints projected only by the Safety Score V9 adapter.
   *
   * Validation permits only settlement semantics that are at least as
   * conservative as the frozen V8 config. Runtime projection also preserves
   * any stricter constraint carried by the captured redemption row.
   */
  v9RouteReviewTerms?: RedemptionV9RouteReviewTerms;
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
  /**
   * Concrete redemption output assets, when the documented rail names them.
   * Tracked stablecoin ids (e.g. "usdc-circle") for stable-single /
   * stable-basket outputs; canonical `asset:<symbol>` keys (e.g.
   * "asset:weth") for collateral outputs. Drives exit-route output
   * resolution — leave unset when the output composition is not documented.
   */
  outputAssets?: string[];
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
