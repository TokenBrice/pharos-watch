import { clampScore } from "./math";
import type { YieldSourceRisk, YieldTrancheSide, YieldVenueRiskTier } from "../types/yield";

export interface RoycoDawnTrancheSafetyResult {
  score: number;
  penalty: number;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function isRoycoDawnTrancheSourceRisk(
  sourceRisk: Pick<YieldSourceRisk, "deploymentPlace" | "trancheSide" | "venueProtocol"> | null | undefined,
): sourceRisk is YieldSourceRisk & { trancheSide: YieldTrancheSide } {
  const hasTrancheSide = sourceRisk?.trancheSide === "senior" || sourceRisk?.trancheSide === "junior";
  return hasTrancheSide && (sourceRisk.venueProtocol === "royco-dawn" || sourceRisk.deploymentPlace === "structured-tranche");
}

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

function utilizationPenalty(params: {
  utilization: number | null;
  utilizationLimit: number | null;
  side: YieldTrancheSide;
}): number {
  const { utilization, utilizationLimit, side } = params;
  if (utilization == null) return side === "senior" ? 2 : 6;
  const normalized = utilizationLimit != null && utilizationLimit > 0 ? utilization / utilizationLimit : utilization;
  if (side === "senior") {
    if (normalized >= 1) return 8;
    if (normalized >= 0.85) return 5;
    if (normalized >= 0.65) return 3;
    return 0;
  }
  if (normalized >= 1) return 24;
  if (normalized >= 0.85) return 18;
  if (normalized >= 0.65) return 12;
  if (normalized >= 0.45) return 8;
  if (normalized >= 0.25) return 5;
  return 3;
}

function tvlPenalty(tvlUsd: number | null, side: YieldTrancheSide): number {
  if (tvlUsd == null || tvlUsd <= 0) return side === "senior" ? 5 : 7;
  if (tvlUsd < 100_000) return side === "senior" ? 5 : 7;
  if (tvlUsd < 250_000) return side === "senior" ? 3 : 5;
  if (tvlUsd < 1_000_000) return side === "senior" ? 1 : 3;
  return 0;
}

function venuePenalty(tier: YieldVenueRiskTier | null | undefined, side: YieldTrancheSide): number {
  switch (tier) {
    case "low":
      return 0;
    case "medium":
      return side === "senior" ? 3 : 4;
    case "high":
      return side === "senior" ? 8 : 10;
    case "unknown":
    default:
      return side === "senior" ? 2 : 3;
  }
}

function accessPenalty(sourceRisk: YieldSourceRisk, side: YieldTrancheSide): number {
  const kycRequired = sourceRisk.kycRequired === true || sourceRisk.investabilityFlags?.includes("kyc-required");
  const accessRestricted =
    sourceRisk.accessRestricted === true || sourceRisk.investabilityFlags?.includes("us-persons-restricted");
  if (!kycRequired && !accessRestricted) return 0;
  return side === "senior" ? 2 : 3;
}

function withdrawalPenalty(sourceRisk: YieldSourceRisk, side: YieldTrancheSide): number {
  const delaySeconds = finiteNumber(sourceRisk.withdrawalDelaySeconds);
  const hasUnderlyingConstraint = sourceRisk.investabilityFlags?.includes("withdrawals-underlying-dependent") === true;
  let penalty = hasUnderlyingConstraint ? (side === "senior" ? 1 : 2) : 0;
  if (delaySeconds != null && delaySeconds > 0) {
    penalty += side === "senior" ? 1 : 3;
  }
  return penalty;
}

export function computeRoycoDawnTrancheSafetyScore(params: {
  underlyingSafetyScore: number;
  sourceRisk: YieldSourceRisk;
}): RoycoDawnTrancheSafetyResult | null {
  if (!isRoycoDawnTrancheSourceRisk(params.sourceRisk)) return null;

  const side = params.sourceRisk.trancheSide;
  const underlyingSafetyScore = clampScore(params.underlyingSafetyScore);
  const coverage = finiteNumber(params.sourceRisk.marketCoverageRatio);
  const minCoverage = finiteNumber(params.sourceRisk.marketMinCoverageRatio);
  const utilization = finiteNumber(params.sourceRisk.marketUtilizationRatio);
  const utilizationLimit = finiteNumber(params.sourceRisk.marketUtilizationLimitRatio);
  const drawdownRatio = finiteNumber(params.sourceRisk.marketDrawdownRatio);
  const trancheTvlUsd = finiteNumber(params.sourceRisk.trancheTvlUsd ?? params.sourceRisk.marketTvlUsd);

  const firstLossPenalty = side === "junior" ? 18 : 0;
  const drawdownPenalty = drawdownRatio == null ? 0 : Math.min(side === "senior" ? 20 : 30, drawdownRatio * 100 * (side === "senior" ? 0.6 : 1.2));
  const penalty =
    firstLossPenalty +
    statusPenalty(params.sourceRisk.marketStatus, side) +
    coveragePenalty({ coverage, minCoverage, side }) +
    utilizationPenalty({ utilization, utilizationLimit, side }) +
    tvlPenalty(trancheTvlUsd, side) +
    venuePenalty(params.sourceRisk.venueRiskTier, side) +
    accessPenalty(params.sourceRisk, side) +
    withdrawalPenalty(params.sourceRisk, side) +
    drawdownPenalty;

  const score = Math.round(clampScore(underlyingSafetyScore - penalty));
  return {
    score,
    penalty: Number((underlyingSafetyScore - score).toFixed(2)),
  };
}
