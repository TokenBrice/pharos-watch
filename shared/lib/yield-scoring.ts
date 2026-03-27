/**
 * PYS (Pharos Yield Score) formula — shared between worker computation
 * and frontend breakdown display.
 *
 * Worker: uses computePYS() for the final score.
 * Frontend: uses computePysComponents() for breakdown tooltip display.
 */

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

export function yieldStabilityToApyVarianceScore(yieldStability: number | null | undefined): number {
  if (yieldStability == null) return 0;
  return Math.max(0, Math.min(1, 1 - yieldStability));
}

interface PysComponentInput {
  apy30d: number;
  safetyScore: number | null;
  apyVarianceScore: number;
  benchmarkRate?: number | null;
}

export function computePysComponents(input: PysComponentInput) {
  const effectiveSafety = input.safetyScore ?? PYS_DEFAULT_SAFETY_SCORE;
  const riskPenalty = Math.max(PYS_RISK_PENALTY_FLOOR, (101 - effectiveSafety) / 20);
  const adjustedRiskPenalty = Math.pow(riskPenalty, PYS_RISK_PENALTY_EXPONENT);
  const benchmarkRate =
    typeof input.benchmarkRate === "number" && Number.isFinite(input.benchmarkRate)
      ? input.benchmarkRate
      : null;
  const benchmarkSpread = benchmarkRate == null ? null : input.apy30d - benchmarkRate;
  const benchmarkAdjustment = benchmarkSpread == null ? 0 : benchmarkSpread * PYS_BENCHMARK_SPREAD_WEIGHT;
  const effectiveYield = Math.max(0, input.apy30d + benchmarkAdjustment);
  const yieldEfficiency = effectiveYield / adjustedRiskPenalty;
  const sustainabilityMultiplier = Math.max(PYS_SUSTAINABILITY_FLOOR, 1.0 - input.apyVarianceScore);
  return {
    riskPenalty,
    adjustedRiskPenalty,
    benchmarkSpread,
    benchmarkAdjustment,
    effectiveYield,
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
}

export function computePYS({ apy30d, safetyScore, apyVarianceScore, scalingFactor, benchmarkRate }: PYSInput): number {
  if (apy30d <= 0) return 0;
  const { effectiveYield, yieldEfficiency, sustainabilityMultiplier } = computePysComponents({
    apy30d,
    safetyScore,
    apyVarianceScore,
    benchmarkRate,
  });
  if (effectiveYield <= 0) return 0;
  return Math.min(100, Math.round(yieldEfficiency * sustainabilityMultiplier * scalingFactor));
}
