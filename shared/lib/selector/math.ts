export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
