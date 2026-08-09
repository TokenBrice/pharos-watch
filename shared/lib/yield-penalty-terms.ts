/**
 * Shared penalty-term kit for the yield safety engines (yield v8.33).
 *
 * Two engines price venue and market risk on top of an underlying stablecoin
 * safety score: the generic external-opportunity engine
 * (`yield-opportunity-risk.ts`) and the Royco Dawn tranche engine
 * (`royco-tranche-safety.ts`). They deliberately carry different *magnitudes* —
 * a junior tranche is a first-loss position and a lending market is not — but
 * they were reading the same facts through two hand-rolled implementations, and
 * they read venue risk from two different fields (`venueRiskTier` vs
 * `venueRiskWeighted`).
 *
 * This module owns the term *shapes* and the fact derivations; each engine
 * supplies a magnitude profile. Venue risk has one derivation for both engines:
 * the weighted 1..5 score is canonical and the coarse tier is derived from it
 * via {@link deriveVenueRiskTier}, so an engine can never price a venue from a
 * tier that disagrees with the weighted score it was derived from.
 *
 * Royco-only terms (first-loss, coverage, drawdown, market status) stay bespoke
 * in their own module.
 */

import type { YieldSourceRisk, YieldVenueRiskTier } from "../types/yield";
import { numberValue } from "./type-guards";
import { deriveVenueRiskTier } from "./yield-scoring";
import { resolveReviewedYieldRiskConfig, venueRiskWeightedOf } from "./yield-source-risk-registry";

/** A descending `[threshold, penalty]` band table. First matching band wins. */
export type PenaltyBands = readonly (readonly [threshold: number, penalty: number])[];

export interface UtilizationPenaltyProfile {
  /** Applied when utilization is not observed at all. */
  missing: number;
  /** Descending `>=` bands over the normalized utilization ratio. */
  bands: PenaltyBands;
  /** Applied when no band matches (default 0). */
  floor?: number;
}

export interface TvlPenaltyProfile {
  /** Applied when market/tranche TVL is not observed. */
  missing: number;
  /** Ascending `<` bands over USD TVL. */
  bands: PenaltyBands;
  /** Treat a non-positive TVL as unobserved rather than as the smallest band. */
  nonPositiveAsMissing?: boolean;
}

export interface AccessPenaltyProfile {
  /** Applied when the venue requires KYC or restricts access. */
  restricted: number;
}

export interface WithdrawalPenaltyProfile {
  /** Applied when a positive withdrawal delay is published. */
  delay: number;
  /** Applied when withdrawals are flagged underlying-dependent. */
  underlyingDependent: number;
}

export type VenuePenaltyProfile =
  | { kind: "continuous"; threshold: number; slope: number }
  | { kind: "tiered"; low: number; medium: number; high: number; unknown: number };

/**
 * Utilization normalized against its published limit when a positive limit is
 * known, otherwise the raw ratio. Null when utilization is not observed.
 */
export function normalizeUtilization(
  utilization: number | null | undefined,
  utilizationLimit: number | null | undefined,
): number | null {
  const observed = numberValue(utilization);
  if (observed == null) return null;
  const limit = numberValue(utilizationLimit);
  return limit != null && limit > 0 ? observed / limit : observed;
}

export function utilizationPenaltyTerm(normalized: number | null, profile: UtilizationPenaltyProfile): number {
  if (normalized == null) return profile.missing;
  for (const [threshold, penalty] of profile.bands) {
    if (normalized >= threshold) return penalty;
  }
  return profile.floor ?? 0;
}

export function tvlPenaltyTerm(tvlUsd: number | null | undefined, profile: TvlPenaltyProfile): number {
  const observed = numberValue(tvlUsd);
  if (observed == null) return profile.missing;
  if (profile.nonPositiveAsMissing === true && observed <= 0) return profile.missing;
  for (const [threshold, penalty] of profile.bands) {
    if (observed < threshold) return penalty;
  }
  return 0;
}

/** True when the venue requires KYC or restricts access for some persons. */
function isAccessRestricted(sourceRisk: YieldSourceRisk | null | undefined): boolean {
  if (sourceRisk == null) return false;
  const kycRequired = sourceRisk.kycRequired === true || sourceRisk.investabilityFlags?.includes("kyc-required");
  const accessRestricted =
    sourceRisk.accessRestricted === true || sourceRisk.investabilityFlags?.includes("us-persons-restricted");
  return kycRequired === true || accessRestricted === true;
}

export function accessPenaltyTerm(
  sourceRisk: YieldSourceRisk | null | undefined,
  profile: AccessPenaltyProfile,
): number {
  return isAccessRestricted(sourceRisk) ? profile.restricted : 0;
}

export function withdrawalPenaltyTerm(
  sourceRisk: YieldSourceRisk | null | undefined,
  profile: WithdrawalPenaltyProfile,
): number {
  if (sourceRisk == null) return 0;
  const delaySeconds = numberValue(sourceRisk.withdrawalDelaySeconds);
  const underlyingDependent = sourceRisk.investabilityFlags?.includes("withdrawals-underlying-dependent") === true;
  return (delaySeconds != null && delaySeconds > 0 ? profile.delay : 0) + (underlyingDependent ? profile.underlyingDependent : 0);
}

/**
 * Venue penalty from the canonical weighted 1..5 venue-risk score. Continuous
 * profiles price the distance above a blue-chip threshold; tiered profiles bin
 * the same weighted score through {@link deriveVenueRiskTier}. Neither reads a
 * stored tier directly, so the two engines can never disagree about a venue.
 */
export function venuePenaltyTerm(venueRiskWeighted: number | null, profile: VenuePenaltyProfile): number {
  if (profile.kind === "continuous") {
    if (venueRiskWeighted == null) return 0;
    return Math.max(0, venueRiskWeighted - profile.threshold) * profile.slope;
  }
  const tier = deriveVenueRiskTier(venueRiskWeighted);
  switch (tier) {
    case "low":
      return profile.low;
    case "medium":
      return profile.medium;
    case "high":
      return profile.high;
    default:
      return profile.unknown;
  }
}

export interface ResolvedVenueRisk {
  /** Weighted 1..5 score: the row's own value, else the reviewed registry's. */
  weighted: number | null;
  /** Coarse tier derived from {@link weighted}. */
  tier: YieldVenueRiskTier;
  /** True when a reviewed venue backed the resolution (explicit or registry). */
  reviewed: boolean;
}

/**
 * One venue-risk resolution for every yield surface: the row's explicit weighted
 * score wins, and the reviewed registry (keyed by the same identifier stored as
 * `venueProtocol`) is the fallback so auto-discovered rows still pick up their
 * 5-category venue score. The tier is always derived, never read from storage.
 */
export function resolveVenueRisk(params: {
  sourceRisk: YieldSourceRisk | null | undefined;
  venueProtocolHint?: string | null;
}): ResolvedVenueRisk {
  const explicit = numberValue(params.sourceRisk?.venueRiskWeighted);
  if (explicit != null) {
    return { weighted: explicit, tier: deriveVenueRiskTier(explicit), reviewed: true };
  }
  const reviewedConfig = resolveReviewedYieldRiskConfig(
    params.sourceRisk?.venueProtocol ?? params.venueProtocolHint ?? null,
  );
  if (reviewedConfig == null) return { weighted: null, tier: "unknown", reviewed: false };
  const weighted = venueRiskWeightedOf(reviewedConfig);
  return { weighted, tier: deriveVenueRiskTier(weighted), reviewed: true };
}
