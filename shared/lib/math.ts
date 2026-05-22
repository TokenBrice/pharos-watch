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
