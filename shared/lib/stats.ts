import type { Ratio } from "@shared/types/ratio";

export type { Ratio };

function finiteSorted(values: readonly number[]): number[] {
  return values.filter(Number.isFinite).sort((left, right) => left - right);
}

/** Numerator divided by denominator on the ratio scale (1 = 100%). */
export function ratio(numerator: number, denominator: number): Ratio | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return (numerator / denominator) as Ratio;
}

/** Relative change on the ratio scale: `(current - previous) / previous`. */
export function relativeChangeRatio(current: number, previous: number): Ratio | null {
  return ratio(current - previous, previous);
}

/** Convert a ratio to a 0-100 percentage at a presentation or serialization boundary. */
export function ratioToPercentage(value: Ratio): number {
  return value * 100;
}

/**
 * Arithmetic mean of finite samples. Returns null when there are no finite samples.
 */
export function mean(values: readonly number[]): number | null {
  const samples = values.filter(Number.isFinite);
  if (samples.length === 0) return null;
  return samples.reduce((sum, value) => sum + value, 0) / samples.length;
}

/**
 * Conventional median of finite samples. Even-sized inputs average the two middle values.
 * Returns null when there are no finite samples.
 */
export function median(values: readonly number[]): number | null {
  const samples = finiteSorted(values);
  if (samples.length === 0) return null;
  const middle = Math.floor(samples.length / 2);
  if (samples.length % 2 === 1) return samples[middle];
  return (samples[middle - 1] + samples[middle]) / 2;
}

export interface WeightedMedianPoint {
  value: number;
  weight: number;
}

/**
 * Discrete weighted median of finite values with positive finite weights.
 * Returns the first value whose cumulative weight reaches half the total,
 * preserving lower-median semantics at an exact 50% boundary.
 */
export function weightedMedian(points: readonly WeightedMedianPoint[]): number | null {
  const samples = points
    .filter(({ value, weight }) => Number.isFinite(value) && Number.isFinite(weight) && weight > 0)
    .sort((left, right) => left.value - right.value);
  if (samples.length === 0) return null;

  const totalWeight = samples.reduce((sum, sample) => sum + sample.weight, 0);
  if (!Number.isFinite(totalWeight)) return null;
  const halfWeight = totalWeight / 2;
  let cumulativeWeight = 0;
  for (const sample of samples) {
    cumulativeWeight += sample.weight;
    if (cumulativeWeight >= halfWeight) return sample.value;
  }
  return samples[samples.length - 1]?.value ?? null;
}

/**
 * Nearest-rank percentile on a 0-100 percentile scale. Returns null for empty finite input.
 * Non-finite samples (NaN/Infinity) are silently dropped before computing.
 */
export function percentileNearestRank(values: readonly number[], percentile: number): number | null {
  const samples = finiteSorted(values);
  if (samples.length === 0) return null;
  if (!Number.isFinite(percentile)) return null;
  const clamped = Math.max(0, Math.min(100, percentile));
  if (clamped === 0) return samples[0];
  const rank = Math.ceil((clamped / 100) * samples.length);
  return samples[Math.min(samples.length - 1, Math.max(0, rank - 1))];
}

/**
 * Linearly interpolated percentile on a 0-100 percentile scale.
 * Returns null for empty finite input.
 * Non-finite samples (NaN/Infinity) are silently dropped before computing.
 */
export function percentileLinear(values: readonly number[], percentile: number): number | null {
  const samples = finiteSorted(values);
  if (samples.length === 0) return null;
  if (!Number.isFinite(percentile)) return null;
  const clamped = Math.max(0, Math.min(100, percentile));
  const position = (clamped / 100) * (samples.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) return samples[lowerIndex];
  const weight = position - lowerIndex;
  return samples[lowerIndex] + (samples[upperIndex] - samples[lowerIndex]) * weight;
}

/**
 * Percentage helper: numerator / denominator * 100.
 * Returns a 0-100 percentage (not a 0-1 ratio); do not adopt for ratio-based callers
 * such as depeg-resolver-review/summary.ts's local `pct`, which returns num/den.
 * Returns null when either input is non-finite or the denominator is zero.
 */
export function pct(numerator: number, denominator: number): number | null {
  const value = ratio(numerator, denominator);
  return value == null ? null : ratioToPercentage(value);
}
