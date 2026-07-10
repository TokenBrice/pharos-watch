/**
 * Opportunity-level risk for external yield opportunities (yield v8.32).
 *
 * External opportunities (lending markets, fixed-yield products, structured
 * tranches) expose the holder to market risk the underlying stablecoin's
 * report card does not measure. This module derives a source-keyed
 * OpportunityRisk contract: underlying stablecoin safety is one component,
 * reviewed venue risk and market evidence adjust it, and missing critical
 * market evidence produces NR rather than a neutral exact score.
 *
 * Royco Dawn tranches keep their bespoke market-health model in
 * `royco-tranche-safety.ts`; this module covers the remaining external
 * opportunity classes.
 */

import type { YieldType } from "../types/core";
import type {
  YieldOpportunityClass,
  YieldOpportunityCriticalEvidence,
  YieldOpportunityRisk,
  YieldSourceRisk,
} from "../types/yield";
import { clampScore } from "./math";
import { numberValue } from "./type-guards";
import { PYS_VENUE_PENALTY_THRESHOLD } from "./yield-scoring";

/**
 * Safety points deducted per weighted venue-risk point above the blue-chip
 * threshold. Shares {@link PYS_VENUE_PENALTY_THRESHOLD} (2.0) so venues that
 * are a no-op on the PYS venue curve are also a no-op here; calibrated to the
 * Royco tranche venue penalties (medium ≈ 5, high ≈ 10-15 safety points).
 */
export const OPPORTUNITY_VENUE_SAFETY_SLOPE = 5;

const OPPORTUNITY_CLASS_BY_YIELD_TYPE: Partial<Record<YieldType, YieldOpportunityClass>> = {
  "lending-opportunity": "lending",
  "fixed-yield": "fixed-yield",
  "structured-tranche": "structured-tranche",
};

/** External-opportunity class for a yield type; null for holder/native yield types. */
export function deriveYieldOpportunityClass(yieldType: YieldType): YieldOpportunityClass | null {
  return OPPORTUNITY_CLASS_BY_YIELD_TYPE[yieldType] ?? null;
}

export interface YieldOpportunityRiskInput {
  opportunityClass: YieldOpportunityClass;
  underlyingSafetyScore: number;
  /** Resolved weighted 1..5 venue-risk score (explicit source risk or reviewed registry). */
  venueRiskWeighted: number | null;
  sourceTvlUsd: number | null;
  sourceRisk: YieldSourceRisk | null;
}

function marketSizePenalty(marketTvlUsd: number): number {
  if (marketTvlUsd < 100_000) return 6;
  if (marketTvlUsd < 250_000) return 4;
  if (marketTvlUsd < 1_000_000) return 2;
  return 0;
}

function utilizationPenalty(sourceRisk: YieldSourceRisk | null): number {
  const utilization = numberValue(sourceRisk?.marketUtilizationRatio);
  if (utilization == null) return 0;
  const limit = numberValue(sourceRisk?.marketUtilizationLimitRatio);
  const normalized = limit != null && limit > 0 ? utilization / limit : utilization;
  if (normalized >= 0.97) return 6;
  if (normalized >= 0.9) return 3;
  return 0;
}

function accessPenalty(sourceRisk: YieldSourceRisk | null): number {
  if (sourceRisk == null) return 0;
  const kycRequired = sourceRisk.kycRequired === true || sourceRisk.investabilityFlags?.includes("kyc-required");
  const accessRestricted =
    sourceRisk.accessRestricted === true || sourceRisk.investabilityFlags?.includes("us-persons-restricted");
  return kycRequired || accessRestricted ? 2 : 0;
}

function withdrawalPenalty(sourceRisk: YieldSourceRisk | null): number {
  if (sourceRisk == null) return 0;
  const delaySeconds = numberValue(sourceRisk.withdrawalDelaySeconds);
  const underlyingDependent = sourceRisk.investabilityFlags?.includes("withdrawals-underlying-dependent") === true;
  return (delaySeconds != null && delaySeconds > 0 ? 2 : 0) + (underlyingDependent ? 1 : 0);
}

/**
 * Assess a non-Royco external opportunity. Critical market evidence (a
 * reviewed venue, an observable market size, and market status for structured
 * tranches) must be present for an opportunity safety score; otherwise the
 * contract reports what is missing and the caller withholds an exact PYS (NR).
 * Noncritical facts (utilization, access, withdrawal constraints) penalize
 * only when observed — absence is handled by evidence-completeness
 * qualification, never invented.
 */
export function assessYieldOpportunityRisk(input: YieldOpportunityRiskInput): YieldOpportunityRisk {
  const underlyingSafetyScore = clampScore(input.underlyingSafetyScore);
  const venueRiskWeighted = numberValue(input.venueRiskWeighted);
  const marketTvlUsd = numberValue(input.sourceTvlUsd) ?? numberValue(input.sourceRisk?.marketTvlUsd);

  const missingCriticalEvidence: YieldOpportunityCriticalEvidence[] = [];
  if (venueRiskWeighted == null) missingCriticalEvidence.push("venue-review");
  if (marketTvlUsd == null) missingCriticalEvidence.push("market-size");
  if (input.opportunityClass === "structured-tranche" && input.sourceRisk?.marketStatus == null) {
    missingCriticalEvidence.push("market-status");
  }

  if (missingCriticalEvidence.length > 0 || venueRiskWeighted == null || marketTvlUsd == null) {
    return {
      opportunityClass: input.opportunityClass,
      underlyingSafetyScore,
      opportunitySafetyScore: null,
      opportunitySafetyPenalty: null,
      venueReviewed: venueRiskWeighted != null,
      missingCriticalEvidence,
    };
  }

  const venuePenalty = Math.max(0, venueRiskWeighted - PYS_VENUE_PENALTY_THRESHOLD) * OPPORTUNITY_VENUE_SAFETY_SLOPE;
  const penalty =
    venuePenalty +
    marketSizePenalty(marketTvlUsd) +
    utilizationPenalty(input.sourceRisk) +
    accessPenalty(input.sourceRisk) +
    withdrawalPenalty(input.sourceRisk);
  const opportunitySafetyScore = Math.round(clampScore(underlyingSafetyScore - penalty));

  return {
    opportunityClass: input.opportunityClass,
    underlyingSafetyScore,
    opportunitySafetyScore,
    opportunitySafetyPenalty: Number((underlyingSafetyScore - opportunitySafetyScore).toFixed(2)),
    venueReviewed: true,
    missingCriticalEvidence,
  };
}
