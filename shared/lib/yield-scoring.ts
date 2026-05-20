/**
 * PYS (Pharos Yield Score) formula — shared between worker computation
 * and frontend breakdown display.
 *
 * Worker: uses computePYS() for the final score.
 * Frontend: uses computePysComponents() for breakdown tooltip display.
 */

import { clamp } from "./math";

/** Risk penalty floor — prevents division by near-zero. */
export const PYS_RISK_PENALTY_FLOOR = 0.5;

/** Exponent applied to the safety-derived risk penalty curve. */
export const PYS_RISK_PENALTY_EXPONENT = 1.75;

/** Sustainability multiplier floor — ensures non-zero contribution. */
export const PYS_SUSTAINABILITY_FLOOR = 0.3;

/** Default safety score when no report card grade is available. */
export const PYS_DEFAULT_SAFETY_SCORE = 40;

/** Weight applied to row-level benchmark spread when forming effective yield. */
export const PYS_BENCHMARK_SPREAD_WEIGHT = 0.25;

/** Maximum multiplier applied by explicit source-risk penalties. */
export const PYS_MAX_SOURCE_RISK_PENALTY = 2.5;

/**
 * Normalize a resolved source-risk multiplier into a 0-100 display score.
 * `penalty = 1.0` (neutral) → 0; `penalty = PYS_MAX_SOURCE_RISK_PENALTY` (2.5) → 100.
 * Returns null when the penalty is not a finite number.
 */
export function computeSourceRiskScoreFromPenalty(
  sourceRiskPenalty: number | null | undefined,
): number | null {
  if (typeof sourceRiskPenalty !== "number" || !Number.isFinite(sourceRiskPenalty)) {
    return null;
  }
  const span = PYS_MAX_SOURCE_RISK_PENALTY - 1;
  if (span <= 0) return 0;
  const raw = ((sourceRiskPenalty - 1) / span) * 100;
  return clamp(Math.round(raw), 0, 100);
}

export type PysSourceRiskPenaltyReason =
  | "provided"
  | "missing-neutral"
  | "invalid-neutral"
  | "below-min-clamped"
  | "above-max-clamped";

export interface PysSourceRiskPenaltyResolution {
  penalty: number;
  reason: PysSourceRiskPenaltyReason;
  provided: boolean;
}

export interface PysSourceRiskPenaltyInput {
  rewardShare?: number | null;
  sourceDepthRatio?: number | null;
  sourceAgeSeconds?: number | null;
  sourceSwitchCount30d?: number | null;
  observationCount30d?: number | null;
  venueRiskTier?: string | null;
}

export function yieldStabilityToApyVarianceScore(yieldStability: number | null | undefined): number {
  if (yieldStability == null) return 0;
  return Math.max(0, Math.min(1, 1 - yieldStability));
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function computePysRewardShare(
  apyReward: number | null | undefined,
  currentApy: number | null | undefined,
): number | null {
  const reward = finiteOrNull(apyReward);
  const current = finiteOrNull(currentApy);
  if (reward == null || reward < 0 || current == null || current <= 0) {
    return null;
  }
  return clamp(reward / current, 0, 1);
}

export function resolvePysSourceRiskPenalty(
  sourceRiskPenalty: number | null | undefined,
): PysSourceRiskPenaltyResolution {
  if (sourceRiskPenalty == null) {
    return { penalty: 1, reason: "missing-neutral", provided: false };
  }
  if (!Number.isFinite(sourceRiskPenalty)) {
    return { penalty: 1, reason: "invalid-neutral", provided: false };
  }
  if (sourceRiskPenalty < 1) {
    return { penalty: 1, reason: "below-min-clamped", provided: true };
  }
  if (sourceRiskPenalty > PYS_MAX_SOURCE_RISK_PENALTY) {
    return { penalty: PYS_MAX_SOURCE_RISK_PENALTY, reason: "above-max-clamped", provided: true };
  }
  return { penalty: sourceRiskPenalty, reason: "provided", provided: true };
}

export function derivePysSourceRiskPenalty(input: PysSourceRiskPenaltyInput): number {
  let penalty = 0;
  const rewardShare = finiteOrNull(input.rewardShare);
  const sourceDepthRatio = finiteOrNull(input.sourceDepthRatio);
  const sourceAgeSeconds = finiteOrNull(input.sourceAgeSeconds);
  const sourceSwitchCount30d = finiteOrNull(input.sourceSwitchCount30d);
  const observationCount30d = finiteOrNull(input.observationCount30d);

  if (rewardShare != null && rewardShare > 0.5) {
    penalty += Math.min(0.5, rewardShare - 0.5);
  }
  if (sourceDepthRatio != null && sourceDepthRatio < 0.001) {
    penalty += 0.35;
  }
  if (sourceAgeSeconds != null && sourceAgeSeconds > 6 * 60 * 60) {
    penalty += 0.25;
  }
  if (sourceSwitchCount30d != null && sourceSwitchCount30d > 0) {
    penalty += Math.min(0.3, sourceSwitchCount30d * 0.1);
  }
  if (observationCount30d != null && observationCount30d > 0 && observationCount30d < 7) {
    penalty += 0.2;
  }
  if (input.venueRiskTier === "high") {
    penalty += 0.35;
  } else if (input.venueRiskTier === "medium") {
    penalty += 0.15;
  }

  return resolvePysSourceRiskPenalty(1 + penalty).penalty;
}

interface PysComponentInput {
  apy30d: number;
  safetyScore: number | null;
  apyVarianceScore: number;
  benchmarkRate?: number | null;
  sourceRiskPenalty?: number | null;
}

export function computePysComponents(input: PysComponentInput) {
  const apy30d = finiteOrNull(input.apy30d) ?? 0;
  const effectiveSafety = finiteOrNull(input.safetyScore) ?? PYS_DEFAULT_SAFETY_SCORE;
  const riskPenalty = Math.max(PYS_RISK_PENALTY_FLOOR, (101 - effectiveSafety) / 20);
  const adjustedRiskPenalty = Math.pow(riskPenalty, PYS_RISK_PENALTY_EXPONENT);
  const benchmarkRate = finiteOrNull(input.benchmarkRate);
  const benchmarkSpread = benchmarkRate == null ? null : apy30d - benchmarkRate;
  const benchmarkAdjustment = benchmarkSpread == null ? 0 : benchmarkSpread * PYS_BENCHMARK_SPREAD_WEIGHT;
  const effectiveYield = Math.max(0, apy30d + benchmarkAdjustment);
  const sourceRiskPenaltyResolution = resolvePysSourceRiskPenalty(input.sourceRiskPenalty);
  const rowUtility = effectiveYield / sourceRiskPenaltyResolution.penalty;
  const yieldEfficiency = rowUtility / adjustedRiskPenalty;
  const apyVarianceScore = clamp(finiteOrNull(input.apyVarianceScore) ?? 0, 0, 1);
  const sustainabilityMultiplier = Math.max(PYS_SUSTAINABILITY_FLOOR, 1.0 - apyVarianceScore);
  return {
    riskPenalty,
    adjustedRiskPenalty,
    sourceRiskPenalty: sourceRiskPenaltyResolution.penalty,
    sourceRiskPenaltyReason: sourceRiskPenaltyResolution.reason,
    sourceRiskPenaltyProvided: sourceRiskPenaltyResolution.provided,
    benchmarkSpread,
    benchmarkAdjustment,
    effectiveYield,
    rowUtility,
    yieldEfficiency,
    sustainabilityMultiplier,
  };
}

interface PYSInput {
  apy30d: number;
  safetyScore: number | null;
  apyVarianceScore: number;
  scalingFactor: number;
  benchmarkRate?: number | null;
  sourceRiskPenalty?: number | null;
}

export function computePYS({ apy30d, safetyScore, apyVarianceScore, scalingFactor, benchmarkRate, sourceRiskPenalty }: PYSInput): number {
  if (!Number.isFinite(apy30d) || apy30d <= 0) return 0;
  if (!Number.isFinite(scalingFactor) || scalingFactor <= 0) return 0;
  const { effectiveYield, yieldEfficiency, sustainabilityMultiplier } = computePysComponents({
    apy30d,
    safetyScore,
    apyVarianceScore,
    benchmarkRate,
    sourceRiskPenalty,
  });
  if (effectiveYield <= 0) return 0;
  return clamp(Math.round(yieldEfficiency * sustainabilityMultiplier * scalingFactor), 0, 100);
}
