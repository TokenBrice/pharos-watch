/**
 * Royco Dawn tranche market-health engine.
 *
 * Senior/junior tranches of a Royco Dawn market carry structural risk no
 * lending-market model captures (first-loss ordering, coverage against a
 * minimum, market status, drawdown), so they keep a bespoke engine. The terms
 * they share with the generic external-opportunity engine — access, withdrawal,
 * utilization, TVL, venue — come from the shared kit in `yield-penalty-terms.ts`
 * with tranche-side magnitude profiles; only the Royco-only terms below are
 * hand-rolled here.
 */

import { clampScore } from "./math";
import { numberValue } from "./type-guards";
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
import type { YieldSourceRisk, YieldTrancheSide } from "../types/yield";

export interface RoycoDawnTrancheSafetyResult {
  score: number;
  penalty: number;
}

export function isRoycoDawnTrancheSourceRisk(
  sourceRisk: Pick<YieldSourceRisk, "deploymentPlace" | "trancheSide" | "venueProtocol"> | null | undefined,
): sourceRisk is YieldSourceRisk & { trancheSide: YieldTrancheSide } {
  const hasTrancheSide = sourceRisk?.trancheSide === "senior" || sourceRisk?.trancheSide === "junior";
  return hasTrancheSide && sourceRisk.venueProtocol === "royco-dawn";
}

interface TranchePenaltyProfile {
  utilization: UtilizationPenaltyProfile;
  tvl: TvlPenaltyProfile;
  venue: VenuePenaltyProfile;
  access: AccessPenaltyProfile;
  withdrawal: WithdrawalPenaltyProfile;
  /** Junior capital absorbs losses first; senior does not. */
  firstLoss: number;
}

/** Tranche-side magnitude profiles for the shared penalty terms. */
const TRANCHE_PENALTY_PROFILES: Record<YieldTrancheSide, TranchePenaltyProfile> = {
  senior: {
    utilization: { missing: 2, bands: [[1, 8], [0.85, 5], [0.65, 3]] },
    tvl: { missing: 5, bands: [[100_000, 5], [250_000, 3], [1_000_000, 1]], nonPositiveAsMissing: true },
    venue: { kind: "tiered", low: 0, medium: 3, high: 8, unknown: 2 },
    access: { restricted: 2 },
    withdrawal: { delay: 1, underlyingDependent: 1 },
    firstLoss: 0,
  },
  junior: {
    utilization: { missing: 6, bands: [[1, 24], [0.85, 18], [0.65, 12], [0.45, 8], [0.25, 5]], floor: 3 },
    tvl: { missing: 7, bands: [[100_000, 7], [250_000, 5], [1_000_000, 3]], nonPositiveAsMissing: true },
    venue: { kind: "tiered", low: 0, medium: 4, high: 10, unknown: 3 },
    access: { restricted: 3 },
    withdrawal: { delay: 3, underlyingDependent: 2 },
    firstLoss: 18,
  },
};

function statusPenalty(status: YieldSourceRisk["marketStatus"], side: YieldTrancheSide): number {
  switch (status) {
    case "protected":
      return side === "senior" ? 8 : 15;
    case "unhealthy":
      return side === "senior" ? 15 : 25;
    case "critical":
      return side === "senior" ? 25 : 35;
    case "normal":
    default:
      return 0;
  }
}

function coveragePenalty(params: {
  coverage: number | null;
  minCoverage: number | null;
  side: YieldTrancheSide;
}): number {
  const { coverage, minCoverage, side } = params;
  if (coverage == null || minCoverage == null || minCoverage <= 0) {
    return side === "senior" ? 3 : 5;
  }
  if (coverage < minCoverage) {
    const shortfallRatio = Math.min(1, (minCoverage - coverage) / minCoverage);
    return (side === "senior" ? 14 : 10) + shortfallRatio * (side === "senior" ? 10 : 8);
  }
  if (coverage < minCoverage * 1.25) return side === "senior" ? 4 : 5;
  return 0;
}

// Slope and cap constants for the drawdown penalty curve, asymmetric by tranche side.
const DRAWDOWN_SENIOR_SLOPE = 0.6;
const DRAWDOWN_JUNIOR_SLOPE = 1.2;
const DRAWDOWN_SENIOR_CAP = 20;
const DRAWDOWN_JUNIOR_CAP = 30;

function computeDrawdownPenalty(drawdownRatio: number | null, side: YieldTrancheSide): number {
  if (drawdownRatio == null) return 0;
  const slope = side === "senior" ? DRAWDOWN_SENIOR_SLOPE : DRAWDOWN_JUNIOR_SLOPE;
  const cap = side === "senior" ? DRAWDOWN_SENIOR_CAP : DRAWDOWN_JUNIOR_CAP;
  return Math.min(cap, drawdownRatio * 100 * slope);
}

export function computeRoycoDawnTrancheSafetyScore(params: {
  underlyingSafetyScore: number;
  sourceRisk: YieldSourceRisk;
  /**
   * Canonical weighted venue-risk score. Omit to resolve it from the source risk
   * and the reviewed registry (the same derivation every yield surface uses).
   */
  venueRiskWeighted?: number | null;
}): RoycoDawnTrancheSafetyResult | null {
  if (!isRoycoDawnTrancheSourceRisk(params.sourceRisk)) return null;

  const side = params.sourceRisk.trancheSide;
  const profile = TRANCHE_PENALTY_PROFILES[side];
  const underlyingSafetyScore = clampScore(params.underlyingSafetyScore);
  const coverage = numberValue(params.sourceRisk.marketCoverageRatio);
  const minCoverage = numberValue(params.sourceRisk.marketMinCoverageRatio);
  const normalizedUtilization = normalizeUtilization(
    params.sourceRisk.marketUtilizationRatio,
    params.sourceRisk.marketUtilizationLimitRatio,
  );
  const drawdownRatio = numberValue(params.sourceRisk.marketDrawdownRatio);
  const trancheTvlUsd = params.sourceRisk.trancheTvlUsd ?? params.sourceRisk.marketTvlUsd;
  const venueRiskWeighted =
    params.venueRiskWeighted !== undefined
      ? params.venueRiskWeighted
      : resolveVenueRisk({ sourceRisk: params.sourceRisk }).weighted;

  const penalty =
    profile.firstLoss +
    statusPenalty(params.sourceRisk.marketStatus, side) +
    coveragePenalty({ coverage, minCoverage, side }) +
    utilizationPenaltyTerm(normalizedUtilization, profile.utilization) +
    tvlPenaltyTerm(trancheTvlUsd, profile.tvl) +
    venuePenaltyTerm(venueRiskWeighted, profile.venue) +
    accessPenaltyTerm(params.sourceRisk, profile.access) +
    withdrawalPenaltyTerm(params.sourceRisk, profile.withdrawal) +
    computeDrawdownPenalty(drawdownRatio, side);

  const score = Math.round(clampScore(underlyingSafetyScore - penalty));
  return {
    score,
    penalty: Number((underlyingSafetyScore - score).toFixed(2)),
  };
}
