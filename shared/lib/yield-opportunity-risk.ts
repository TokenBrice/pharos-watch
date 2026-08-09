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
  YieldSafetyProvenance,
  YieldSafetyReason,
  YieldSourceRisk,
  YieldVenueRiskTier,
} from "../types/yield";
import { clampScore } from "./math";
import { numberValue } from "./type-guards";
import { scoreToGrade } from "./report-card-core";
import { computeRoycoDawnTrancheSafetyScore, isRoycoDawnTrancheSourceRisk } from "./royco-tranche-safety";
import { PYS_VENUE_PENALTY_THRESHOLD } from "./yield-scoring";
import {
  accessPenaltyTerm,
  normalizeUtilization,
  resolveVenueRisk,
  tvlPenaltyTerm,
  utilizationPenaltyTerm,
  venuePenaltyTerm,
  withdrawalPenaltyTerm,
  type AccessPenaltyProfile,
  type TvlPenaltyProfile,
  type UtilizationPenaltyProfile,
  type VenuePenaltyProfile,
  type WithdrawalPenaltyProfile,
} from "./yield-penalty-terms";

/**
 * Safety points deducted per weighted venue-risk point above the blue-chip
 * threshold. Shares {@link PYS_VENUE_PENALTY_THRESHOLD} (2.0) so venues that
 * are a no-op on the PYS venue curve are also a no-op here; calibrated to the
 * Royco tranche venue penalties (medium ≈ 5, high ≈ 10-15 safety points).
 */
const OPPORTUNITY_VENUE_SAFETY_SLOPE = 5;

/** Magnitude profiles for the shared penalty terms, external-opportunity engine. */
const OPPORTUNITY_VENUE_PROFILE: VenuePenaltyProfile = {
  kind: "continuous",
  threshold: PYS_VENUE_PENALTY_THRESHOLD,
  slope: OPPORTUNITY_VENUE_SAFETY_SLOPE,
};
const OPPORTUNITY_MARKET_SIZE_PROFILE: TvlPenaltyProfile = {
  missing: 0,
  bands: [[100_000, 6], [250_000, 4], [1_000_000, 2]],
};
const OPPORTUNITY_UTILIZATION_PROFILE: UtilizationPenaltyProfile = {
  missing: 0,
  bands: [[0.97, 6], [0.9, 3]],
};
const OPPORTUNITY_ACCESS_PROFILE: AccessPenaltyProfile = { restricted: 2 };
const OPPORTUNITY_WITHDRAWAL_PROFILE: WithdrawalPenaltyProfile = { delay: 2, underlyingDependent: 1 };

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

  const penalty =
    venuePenaltyTerm(venueRiskWeighted, OPPORTUNITY_VENUE_PROFILE) +
    tvlPenaltyTerm(marketTvlUsd, OPPORTUNITY_MARKET_SIZE_PROFILE) +
    utilizationPenaltyTerm(
      normalizeUtilization(input.sourceRisk?.marketUtilizationRatio, input.sourceRisk?.marketUtilizationLimitRatio),
      OPPORTUNITY_UTILIZATION_PROFILE,
    ) +
    accessPenaltyTerm(input.sourceRisk, OPPORTUNITY_ACCESS_PROFILE) +
    withdrawalPenaltyTerm(input.sourceRisk, OPPORTUNITY_WITHDRAWAL_PROFILE);
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

/* ------------------------------------------------------------------------- *
 * Canonical yield safety-resolution ladder (yield v8.33)
 *
 * The write path (yield-sync evaluation) and the read path (live-safety
 * hydration in the rankings cache) both resolve a row's published safety score,
 * grade, provenance and reason from the underlying stablecoin's report card
 * plus opportunity-level risk. They used to do it twice, and had drifted on
 * four guards: the NR-substitution guard, the reviewed-venue fallback, the
 * opportunity entry gate, and the evidence predicates. This is the one ladder
 * both call; the stricter guard won in each case (ADR-19: one engine per
 * sub-dimension, consumers re-bin rather than re-derive).
 * ------------------------------------------------------------------------- */

/** Provenance label a rated (non-default, non-opportunity) resolution carries. */
export type YieldRatedSafetyProvenance = Extract<
  YieldSafetyProvenance,
  "cached-publish" | "live-report-card"
>;

export interface YieldRowSafetyInput {
  /** Row yield type; decides whether an opportunity class applies at all. */
  yieldType: YieldType;
  /** Underlying stablecoin report-card entry; null/undefined when unavailable. */
  underlyingSafety: { score: number; grade: string } | null | undefined;
  /** Score substituted when the report card carries none. */
  defaultSafetyScore: number;
  /** True only when the exact published safety snapshot could not be read. */
  safetySnapshotUnavailable?: boolean;
  sourceRisk: YieldSourceRisk | null | undefined;
  sourceTvlUsd: number | null | undefined;
  /** Venue identifier used when the row carries no `venueProtocol` of its own. */
  venueProtocolHint?: string | null;
  /** Provenance to publish when the underlying report card was read directly. */
  ratedProvenance: YieldRatedSafetyProvenance;
}

export interface YieldRowSafetyResolution {
  underlyingSafetyScore: number;
  underlyingSafetyGrade: string;
  usedDefaultSafety: boolean;
  safetyScore: number;
  safetyGrade: string;
  safetyProvenance: YieldSafetyProvenance;
  safetyReason: YieldSafetyReason | null;
  sourceRisk: YieldSourceRisk | null;
  opportunityRisk: YieldOpportunityRisk | null;
  /** Canonical weighted venue-risk score after the reviewed-registry fallback. */
  venueRiskWeighted: number | null;
  /** Coarse tier derived from {@link venueRiskWeighted}. */
  venueRiskTier: YieldVenueRiskTier;
  /** Underlying report card was observed and rated — the NR-substitution guard. */
  safetyEvidenceObserved: boolean;
  /** No critical opportunity evidence is missing. */
  opportunityEvidenceComplete: boolean;
}

/**
 * Drop every safety-derived field when the published safety snapshot could not
 * be read, so a degraded run never publishes an opportunity score computed from
 * a substituted default.
 */
function stripSafetyDerivedSourceRisk(sourceRisk: YieldSourceRisk | null): YieldSourceRisk | null {
  if (sourceRisk == null) return null;
  const { opportunityRisk: _opportunityRisk, ...independentSourceRisk } = sourceRisk;
  return {
    ...independentSourceRisk,
    underlyingSafetyScore: null,
    trancheSafetyScore: null,
    trancheSafetyPenalty: null,
  };
}

function baseSafetyReason(params: {
  usedDefaultSafety: boolean;
  underlyingSafetyGrade: string;
}): YieldSafetyReason | null {
  if (params.usedDefaultSafety) return "report-card-score-missing";
  return params.underlyingSafetyGrade === "NR" ? "report-card-grade-not-rated" : null;
}

/**
 * Resolve a yield row's published safety from its underlying report card and
 * its opportunity-level risk. Single source of truth for the write path and the
 * read path — see the module note above for the guards that were unified.
 */
export function resolveYieldRowSafety(input: YieldRowSafetyInput): YieldRowSafetyResolution {
  const snapshotUnavailable = input.safetySnapshotUnavailable === true;
  const usedDefaultSafety = input.underlyingSafety == null;
  const underlyingSafetyScore = input.underlyingSafety?.score ?? input.defaultSafetyScore;
  const underlyingSafetyGrade = input.underlyingSafety?.grade ?? "NR";
  const baseSourceRisk = snapshotUnavailable
    ? stripSafetyDerivedSourceRisk(input.sourceRisk ?? null)
    : (input.sourceRisk ?? null);
  const venue = resolveVenueRisk({
    sourceRisk: baseSourceRisk,
    venueProtocolHint: input.venueProtocolHint ?? null,
  });

  const shared = {
    underlyingSafetyScore,
    underlyingSafetyGrade,
    usedDefaultSafety,
    venueRiskWeighted: venue.weighted,
    venueRiskTier: venue.tier,
  };

  if (snapshotUnavailable) {
    return {
      ...shared,
      safetyScore: underlyingSafetyScore,
      safetyGrade: underlyingSafetyGrade,
      safetyProvenance: "safety-snapshot-unavailable",
      safetyReason: "safety-snapshot-unavailable",
      sourceRisk: baseSourceRisk,
      opportunityRisk: null,
      safetyEvidenceObserved: false,
      opportunityEvidenceComplete: true,
    };
  }

  // NR-substitution guard: an opportunity score is only substituted over a
  // report card that was actually observed and rated. A default or NR-graded
  // underlying keeps its own (un)rating rather than acquiring an exact score
  // through the market-risk adjustment.
  const safetyEvidenceObserved = !usedDefaultSafety && underlyingSafetyGrade !== "NR";
  const opportunityClass = deriveYieldOpportunityClass(input.yieldType);

  // Royco Dawn tranches: bespoke market-health engine, published through the
  // same opportunity contract.
  if (isRoycoDawnTrancheSourceRisk(baseSourceRisk)) {
    const trancheSafety = computeRoycoDawnTrancheSafetyScore({
      underlyingSafetyScore,
      sourceRisk: baseSourceRisk,
      venueRiskWeighted: venue.weighted,
    });
    if (trancheSafety != null) {
      const opportunityRisk: YieldOpportunityRisk | null =
        opportunityClass == null
          ? null
          : {
              opportunityClass,
              underlyingSafetyScore,
              opportunitySafetyScore: trancheSafety.score,
              opportunitySafetyPenalty: trancheSafety.penalty,
              venueReviewed: venue.tier !== "unknown",
              missingCriticalEvidence: [],
            };
      return {
        ...shared,
        safetyScore: trancheSafety.score,
        safetyGrade: scoreToGrade(trancheSafety.score),
        safetyProvenance: "opportunity-safety",
        safetyReason: usedDefaultSafety ? "underlying-report-card-score-missing" : null,
        sourceRisk: {
          ...baseSourceRisk,
          underlyingSafetyScore,
          trancheSafetyScore: trancheSafety.score,
          trancheSafetyPenalty: trancheSafety.penalty,
          ...(opportunityRisk ? { opportunityRisk } : {}),
        },
        opportunityRisk,
        safetyEvidenceObserved,
        opportunityEvidenceComplete: true,
      };
    }
  }

  if (opportunityClass != null) {
    const opportunityRisk = assessYieldOpportunityRisk({
      opportunityClass,
      underlyingSafetyScore,
      venueRiskWeighted: venue.weighted,
      sourceTvlUsd: numberValue(input.sourceTvlUsd),
      sourceRisk: baseSourceRisk,
    });
    const sourceRisk: YieldSourceRisk = {
      ...(baseSourceRisk ?? {}),
      opportunityRisk,
      underlyingSafetyScore,
    };
    const opportunityEvidenceComplete = opportunityRisk.missingCriticalEvidence.length === 0;
    if (safetyEvidenceObserved && opportunityRisk.opportunitySafetyScore != null) {
      return {
        ...shared,
        safetyScore: opportunityRisk.opportunitySafetyScore,
        safetyGrade: scoreToGrade(opportunityRisk.opportunitySafetyScore),
        safetyProvenance: "opportunity-safety",
        safetyReason: null,
        sourceRisk,
        opportunityRisk,
        safetyEvidenceObserved,
        opportunityEvidenceComplete,
      };
    }
    return {
      ...shared,
      safetyScore: underlyingSafetyScore,
      safetyGrade: underlyingSafetyGrade,
      safetyProvenance: usedDefaultSafety ? "default-safety" : input.ratedProvenance,
      safetyReason: baseSafetyReason({ usedDefaultSafety, underlyingSafetyGrade }),
      sourceRisk,
      opportunityRisk,
      safetyEvidenceObserved,
      opportunityEvidenceComplete,
    };
  }

  return {
    ...shared,
    safetyScore: underlyingSafetyScore,
    safetyGrade: underlyingSafetyGrade,
    safetyProvenance: usedDefaultSafety ? "default-safety" : input.ratedProvenance,
    safetyReason: baseSafetyReason({ usedDefaultSafety, underlyingSafetyGrade }),
    sourceRisk: baseSourceRisk,
    opportunityRisk: null,
    safetyEvidenceObserved,
    opportunityEvidenceComplete: true,
  };
}
