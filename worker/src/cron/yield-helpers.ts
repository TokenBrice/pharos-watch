// worker/src/cron/yield-helpers.ts
// Pure computation functions for yield intelligence. No I/O.

export function computeApyFromRate(rateNow: number, ratePrev: number, days: number): number {
  if (ratePrev <= 0 || days <= 0) return 0;
  const ratio = rateNow / ratePrev;
  if (ratio === 1) return 0;
  return (Math.pow(ratio, 365.25 / days) - 1) * 100;
}

export function computeApyFromPrice(priceNow: number, pricePrev: number, days: number): number {
  return computeApyFromRate(priceNow, pricePrev, days);
}

interface PYSInput {
  apy30d: number;
  safetyScore: number;
  apyVarianceScore: number;
  scalingFactor: number;
}

export function computePYS({ apy30d, safetyScore, apyVarianceScore, scalingFactor }: PYSInput): number {
  if (apy30d <= 0) return 0;
  const riskPenalty = Math.max(0.5, (101 - safetyScore) / 20);
  const yieldEfficiency = apy30d / riskPenalty;
  const sustainabilityMultiplier = Math.max(0.3, 1.0 - apyVarianceScore);
  return Math.min(100, Math.round(yieldEfficiency * sustainabilityMultiplier * scalingFactor));
}

export function computeYieldStability(apySamples: number[]): number | null {
  if (apySamples.length < 2) return null;
  const mean = apySamples.reduce((s, v) => s + v, 0) / apySamples.length;
  if (Math.abs(mean) < 1e-10) return 1;
  const variance = apySamples.reduce((s, v) => s + (v - mean) ** 2, 0) / apySamples.length;
  const cv = Math.sqrt(variance) / Math.abs(mean);
  return Math.max(0, Math.min(1, Math.round((1 - cv) * 100) / 100));
}

export function computeApyVarianceScore(apySamples: number[]): number {
  if (apySamples.length < 2) return 0;
  const mean = apySamples.reduce((s, v) => s + v, 0) / apySamples.length;
  if (Math.abs(mean) < 1e-10) return 0;
  const variance = apySamples.reduce((s, v) => s + (v - mean) ** 2, 0) / apySamples.length;
  return Math.min(1, Math.sqrt(variance) / Math.abs(mean));
}

interface WarningInput {
  currentApy: number;
  apy30d: number;
  apyReward: number | null;
  apy: number;
  medianApy: number;
  sourceTvlUsd: number | null;
  prevTvlUsd: number | null;
}

export function detectWarningSignals(input: WarningInput): string[] {
  const signals: string[] = [];
  if (input.apy30d > 0 && input.currentApy / input.apy30d > 2.0) signals.push("yield-spike");
  if (input.medianApy > 0 && input.currentApy > input.medianApy * 3) signals.push("yield-divergence");
  if (input.apy30d > 0 && input.currentApy < input.apy30d * 0.7) signals.push("negative-trend");
  if (input.apyReward != null && input.apy > 0 && input.apyReward / input.apy > 0.8) signals.push("reward-heavy");
  if (input.sourceTvlUsd != null && input.prevTvlUsd != null && input.prevTvlUsd > 0) {
    const change = (input.sourceTvlUsd - input.prevTvlUsd) / input.prevTvlUsd;
    if (change < -0.2) signals.push("tvl-outflow");
  }
  return signals;
}
