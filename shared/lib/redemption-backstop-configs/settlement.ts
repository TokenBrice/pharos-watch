import type { RedemptionSettlementModel } from "../../types/redemption";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "../safety-score-v9/evidence";
import { maximumBusinessDaySettlement } from "../business-calendars";
import type { RedemptionV9RouteReviewTerms } from "./schema";
import type { RedemptionBackstopConfig } from "./schema";
import { allocationReviewClockSec as reviewAdmissionClockSec } from "../../types/safety-score-v9-allocation";

import { isRedemptionSettlementFaster } from "./settlement-order";
export { isRedemptionSettlementFaster, resolveMoreConservativeRedemptionSettlement } from "./settlement-order";

/** First whole Unix second at which reviewed settlement terms are too old. */
export function reviewedRedemptionSettlementExpirySec(reviewed: RedemptionV9RouteReviewTerms): number | null {
  const reviewSec = reviewed.reviewedAt ? Date.parse(reviewed.reviewedAt) / 1_000 : Number.NaN;
  return Number.isFinite(reviewSec) ? reviewSec + V9_REVIEW_EVIDENCE_MAX_AGE_SEC + 1 : null;
}

/** Completed settlement bounds require current settlement-scoped sources, never target/process gaps. */
export function resolveReviewedRedemptionSettlementDelay(
  reviewed: RedemptionV9RouteReviewTerms | undefined,
  clockSec: number,
): number | undefined {
  if (!reviewed || !Number.isFinite(clockSec) || reviewed.missingScoringFields?.includes("settlement")) return undefined;
  const expirySec = reviewedRedemptionSettlementExpirySec(reviewed);
  const reviewAdmissionSec = reviewed.reviewedAt ? reviewAdmissionClockSec(reviewed.reviewedAt) : Number.NaN;
  if (expirySec === null || reviewAdmissionSec > clockSec || clockSec > expirySec - 1 ||
      !(reviewed.docs ?? []).some((doc) => doc.supports?.includes("settlement"))) return undefined;
  if (!reviewed.businessDayTerms) return reviewed.settlementDelaySec;
  const bound = maximumBusinessDaySettlement(reviewed.businessDayTerms, clockSec);
  return bound.state === "known" ? bound.maximumElapsedSec : undefined;
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
  return resolveReviewedRedemptionSettlementDelay(reviewed, clockSec) !== undefined
    ? reviewedModel : config.settlementModel;
}
