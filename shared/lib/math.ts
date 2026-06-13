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
