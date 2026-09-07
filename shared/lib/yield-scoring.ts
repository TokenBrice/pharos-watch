/**
 * PYS (Pharos Yield Score) formula — shared between worker computation
 * and frontend breakdown display.
 *
 * Worker evaluation: derives the score via computePYSFromComponents() from
 * components it already computed once; other callers use computePYS().
 * Frontend: uses computePysComponents() for breakdown tooltip display.
 */

import type { YieldVenueRiskTier } from "../types/yield";
import { clamp } from "./math";
import { numberValue } from "./type-guards";

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

/**
 * Yearn-style venue-risk rubric (yield v8.292). Five category sub-scores, each an
 * integer 1..5 where higher = riskier, weighted into a 1..5 venue-risk score that
 * derives the coarse {@link YieldVenueRiskTier} and a continuous PYS penalty.
 * See `worker/src/cron/yield-sync/source-risk.ts` for the scored venue registry.
 */
const VENUE_RISK_CATEGORY_WEIGHTS = {
  audits: 0.2,
  centralization: 0.3,
  fundsManagement: 0.3,
  liquidity: 0.15,
  operational: 0.05,
} as const;

export interface YieldVenueRiskScores {
  audits: number;
  centralization: number;
  fundsManagement: number;
  liquidity: number;
  operational: number;
}

/** Weighted 1..5 venue-risk score from the five Yearn-style category sub-scores. */
export function computeVenueRiskWeighted(scores: YieldVenueRiskScores): number {
  return (
    scores.audits * VENUE_RISK_CATEGORY_WEIGHTS.audits +
    scores.centralization * VENUE_RISK_CATEGORY_WEIGHTS.centralization +
    scores.fundsManagement * VENUE_RISK_CATEGORY_WEIGHTS.fundsManagement +
    scores.liquidity * VENUE_RISK_CATEGORY_WEIGHTS.liquidity +
    scores.operational * VENUE_RISK_CATEGORY_WEIGHTS.operational
  );
}

/**
 * Map a weighted 1..5 venue-risk score to the coarse tier enum (kept for the DEWS
 * structured-venue branch and UI display). Yearn Minimal+Low → low, Medium →
 * medium, Elevated+High → high. Null/non-finite → unknown.
 */
export function deriveVenueRiskTier(weighted: number | null | undefined): YieldVenueRiskTier {
  if (typeof weighted !== "number" || !Number.isFinite(weighted)) return "unknown";
  // Round to 3 decimals so boundary scores (e.g. 0.15*3 = 2.4999…) land on the
  // intended tier rather than a floating-point hair under it. The continuous
  // penalty curve still uses the exact weighted value.
  const w = Math.round(weighted * 1000) / 1000;
  if (w < 2.5) return "low";
  if (w < 3.5) return "medium";
  return "high";
}

/**
 * Weighted-score below which a scored venue contributes no penalty (blue-chip no-op floor).
 *
 * This is intentionally BELOW the low/medium tier cutoff (2.5): the tier is a coarse 3-bucket
 * label for DEWS + display, while the penalty is continuous. So a `low`-tier venue scoring in
 * the 2.0–2.5 band (e.g. Gearbox, Exactly, Liqwid) is genuinely low-but-not-pristine and carries
 * a small proportional penalty (≤ 0.075), while only true blue-chips (≤ 2.0) are a zero no-op.
 * Aligning the two thresholds was rejected: lowering the tier cutoff to 2.0 misclassifies the
 * 2.00 blue-chips (Yearn, Pendle) into `medium`; raising the knee to 2.5 steepens high-venue
 * penalties. The continuous curve is more accurate than a hard cliff. (yield v8.292, FU5)
 */
export const PYS_VENUE_PENALTY_THRESHOLD = 2.0;
/** Penalty contribution per weighted-score point above the threshold. */
export const PYS_VENUE_PENALTY_SLOPE = 0.15;

/**
 * Continuous venue-risk penalty contribution from a weighted 1..5 score.
 * Calibration-preserving: weighted ≤ 2.0 → 0 (matches legacy `low` no-op),
 * 3.0 → 0.15 (matches legacy `medium`), 4.0 → 0.30, 5.0 → 0.45.
 */
export function computeVenuePenaltyFromWeighted(weighted: number | null | undefined): number {
  if (typeof weighted !== "number" || !Number.isFinite(weighted)) return 0;
  return Math.max(0, weighted - PYS_VENUE_PENALTY_THRESHOLD) * PYS_VENUE_PENALTY_SLOPE;
}

export type YieldDependencyConcentrationSeverity = "low" | "medium" | "high";

/** Additive PYS source-risk penalty for reviewer-set cross-venue dependency concentration. */
const PYS_DEPENDENCY_CONCENTRATION_PENALTY: Record<
  YieldDependencyConcentrationSeverity,
  number
> = {
  low: 0,
  medium: 0.1,
  high: 0.2,
};

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
  /**
   * Weighted 1..5 venue-risk score (yield v8.292). When present, the continuous
   * {@link computeVenuePenaltyFromWeighted} curve replaces the coarse
   * `venueRiskTier` branch; absent → legacy tier branch (rollback-safe).
   */
  venueRiskWeighted?: number | null;
  /** Reviewer-set cross-venue dependency concentration (yield v8.292). */
  dependencyConcentrationSeverity?: YieldDependencyConcentrationSeverity | null;
}

export function yieldStabilityToApyVarianceScore(yieldStability: number | null | undefined): number {
  if (yieldStability == null) return 0;
  return Math.max(0, Math.min(1, 1 - yieldStability));
}

export function computePysRewardShare(
  apyReward: number | null | undefined,
  currentApy: number | null | undefined,
): number | null {
  const reward = numberValue(apyReward);
  const current = numberValue(currentApy);
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
  const rewardShare = numberValue(input.rewardShare);
  const sourceDepthRatio = numberValue(input.sourceDepthRatio);
  const sourceAgeSeconds = numberValue(input.sourceAgeSeconds);
  const sourceSwitchCount30d = numberValue(input.sourceSwitchCount30d);
  const observationCount30d = numberValue(input.observationCount30d);

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
  const venueRiskWeighted = numberValue(input.venueRiskWeighted);
  if (venueRiskWeighted != null) {
    // Scored venue: continuous Yearn-rubric curve.
    penalty += computeVenuePenaltyFromWeighted(venueRiskWeighted);
  } else if (input.venueRiskTier === "high") {
    // Legacy fallback for venues not yet scored on the 5-category rubric.
    penalty += 0.35;
  } else if (input.venueRiskTier === "medium") {
    penalty += 0.15;
  }
  penalty += PYS_DEPENDENCY_CONCENTRATION_PENALTY[input.dependencyConcentrationSeverity ?? "low"] ?? 0;

  return resolvePysSourceRiskPenalty(1 + penalty).penalty;
}

interface PysComponentInput {
  apy30d: number;
  safetyScore: number | null;
  apyVarianceScore: number;
  benchmarkRate?: number | null;
  sourceRiskPenalty?: number | null;
}

/** Per-source PYS intermediate values (see {@link computePysComponents}). */
export interface PysComponents {
  riskPenalty: number;
  adjustedRiskPenalty: number;
  sourceRiskPenalty: number;
  sourceRiskPenaltyReason: PysSourceRiskPenaltyReason;
  sourceRiskPenaltyProvided: boolean;
  benchmarkSpread: number | null;
  benchmarkAdjustment: number;
  effectiveYield: number;
  rowUtility: number;
  yieldEfficiency: number;
  sustainabilityMultiplier: number;
}

export function computePysComponents(input: PysComponentInput): PysComponents {
  const apy30d = numberValue(input.apy30d) ?? 0;
  const effectiveSafety = numberValue(input.safetyScore) ?? PYS_DEFAULT_SAFETY_SCORE;
  const riskPenalty = Math.max(PYS_RISK_PENALTY_FLOOR, (101 - effectiveSafety) / 20);
  const adjustedRiskPenalty = Math.pow(riskPenalty, PYS_RISK_PENALTY_EXPONENT);
  const benchmarkRate = numberValue(input.benchmarkRate);
  const benchmarkSpread = benchmarkRate == null ? null : apy30d - benchmarkRate;
  const benchmarkAdjustment = benchmarkSpread == null ? 0 : benchmarkSpread * PYS_BENCHMARK_SPREAD_WEIGHT;
  const effectiveYield = Math.max(0, apy30d + benchmarkAdjustment);
  const sourceRiskPenaltyResolution = resolvePysSourceRiskPenalty(input.sourceRiskPenalty);
  const rowUtility = effectiveYield / sourceRiskPenaltyResolution.penalty;
  const yieldEfficiency = rowUtility / adjustedRiskPenalty;
  const apyVarianceScore = clamp(numberValue(input.apyVarianceScore) ?? 0, 0, 1);
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

// Raw apy30d/scalingFactor accompany the components because computePysComponents
// folds a non-finite apy30d to 0 (finite negatives survive to the effectiveYield
// clamp), so the finite/positive guards are unrecoverable from the components.
export function computePYSFromComponents(
  apy30d: number,
  scalingFactor: number,
  components: PysComponents,
): number {
  if (!Number.isFinite(apy30d) || apy30d <= 0) return 0;
  if (!Number.isFinite(scalingFactor) || scalingFactor <= 0) return 0;
  if (components.effectiveYield <= 0) return 0;
  return clamp(
    Math.round(components.yieldEfficiency * components.sustainabilityMultiplier * scalingFactor),
    0,
    100,
  );
}

export function computePYS({ apy30d, safetyScore, apyVarianceScore, scalingFactor, benchmarkRate, sourceRiskPenalty }: PYSInput): number {
  if (!Number.isFinite(apy30d) || apy30d <= 0) return 0;
  if (!Number.isFinite(scalingFactor) || scalingFactor <= 0) return 0;
  return computePYSFromComponents(
    apy30d,
    scalingFactor,
    computePysComponents({
      apy30d,
      safetyScore,
      apyVarianceScore,
      benchmarkRate,
      sourceRiskPenalty,
    }),
  );
}
