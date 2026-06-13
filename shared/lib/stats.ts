function finiteSorted(values: readonly number[]): number[] {
  return values.filter(Number.isFinite).sort((left, right) => left - right);
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

/**
 * Nearest-rank percentile on a 0-100 percentile scale. Returns null for empty finite input.
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
 * Returns null when either input is non-finite or the denominator is zero.
 */
export function pct(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return (numerator / denominator) * 100;
}
