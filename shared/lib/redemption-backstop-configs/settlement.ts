import type { RedemptionSettlementModel } from "../../types";
import type { RedemptionBackstopConfig } from "./schema";

const REDEMPTION_SETTLEMENT_CONSERVATISM: readonly RedemptionSettlementModel[] = [
  "atomic",
  "immediate",
  "same-day",
  "days",
  "queued",
];

function isRedemptionSettlementAtLeastAsConservative(
  candidate: RedemptionSettlementModel,
  baseline: RedemptionSettlementModel,
): boolean {
  return (
    REDEMPTION_SETTLEMENT_CONSERVATISM.indexOf(candidate) >=
    REDEMPTION_SETTLEMENT_CONSERVATISM.indexOf(baseline)
  );
}

export function isRedemptionSettlementFaster(
  candidate: RedemptionSettlementModel,
  baseline: RedemptionSettlementModel,
): boolean {
  return !isRedemptionSettlementAtLeastAsConservative(candidate, baseline);
}

export function resolveMoreConservativeRedemptionSettlement(
  left: RedemptionSettlementModel,
  right: RedemptionSettlementModel,
): RedemptionSettlementModel {
  return isRedemptionSettlementAtLeastAsConservative(right, left) ? right : left;
}

/**
 * Resolve the settlement model published by the standalone redemption row.
 * Reviewed corrections are shared with V9 so a route cannot carry two coarse
 * settlement labels across public surfaces. The config schema requires an
 * explicit cited SLA for any score-improving (faster) correction.
 */
export function resolveReviewedRedemptionSettlement(
  config: Pick<RedemptionBackstopConfig, "settlementModel" | "v9RouteReviewTerms">,
): RedemptionSettlementModel {
  return config.v9RouteReviewTerms?.settlementModel ?? config.settlementModel;
}
