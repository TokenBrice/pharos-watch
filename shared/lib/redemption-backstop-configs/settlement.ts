import type { RedemptionSettlementModel } from "../../types";

const REDEMPTION_SETTLEMENT_CONSERVATISM: readonly RedemptionSettlementModel[] = [
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
