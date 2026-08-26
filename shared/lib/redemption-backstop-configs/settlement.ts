import type { RedemptionSettlementModel } from "../../types";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "../safety-score-v9/evidence";
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
  clockSec = Math.floor(Date.now() / 1_000),
): RedemptionSettlementModel {
  const reviewed = config.v9RouteReviewTerms;
  const reviewedModel = reviewed?.settlementModel;
  if (reviewed === undefined || reviewedModel === undefined) return config.settlementModel;
  if (!isRedemptionSettlementFaster(reviewedModel, config.settlementModel)) {
    return reviewedModel;
  }
  const reviewedAtSec = reviewed.reviewedAt
    ? Date.parse(`${reviewed.reviewedAt}T00:00:00.000Z`) / 1_000
    : Number.NaN;
  const current =
    reviewed.settlementDelaySec !== undefined &&
    (reviewed.docs?.length ?? 0) > 0 &&
    Number.isFinite(reviewedAtSec) &&
    reviewedAtSec <= clockSec &&
    clockSec - reviewedAtSec <= V9_REVIEW_EVIDENCE_MAX_AGE_SEC;
  return current ? reviewedModel : config.settlementModel;
}
