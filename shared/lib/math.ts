export const BPS_PER_UNIT = 10_000;

/** Clamp a number to [min, max]. NaN → min, ±Infinity → nearest bound. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return value !== value ? min : value > 0 ? max : min; // NaN→min, Inf→max, -Inf→min
  }
  return Math.max(min, Math.min(max, value));
}

export function clampScore(value: number): number {
  return clamp(value, 0, 100);
}

/** Clamp a share to [0, 1]. NaN → 0, ±Infinity → nearest bound. */
export function clampShare(value: number): number {
  return clamp(value, 0, 1);
}

export function roundScore(value: number): number {
  return Math.round(clampScore(value));
}

export function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Round to one decimal place. */
export function round1(value: number): number {
  return roundTo(value, 1);
}

export function round4(value: number): number {
  return roundTo(value, 4);
}

/**
 * Herfindahl-Hirschman Index (0–1, higher = more concentrated) → diversity score
 * on the 0–100 scale. Unrounded on purpose: callers own their rounding policy
 * (the Selector keeps full precision, Chain Health rounds to an integer).
 */
export function hhiToDiversityScore(hhi: number): number {
  return clamp((1 - hhi) * 100, 0, 100);
}

/**
 * Walk a descending-min threshold table and return the first matching band.
 * The caller owns table order; this helper intentionally does not sort bands.
 */
export function bandFromThresholds<T extends { min: number }>(
  score: number,
  bands: readonly T[],
  fallback: T,
): T {
  for (const band of bands) {
    if (score >= band.min) return band;
  }
  return fallback;
}
