export const SIZE_FLOOR = 26;
export const SIZE_CEIL = 120;
export const SIZE_SCALE = 4.0;
export const MCAP_DIVISOR = 1_000_000;

export function coinEmblemSize(marketCapUsd: number): number {
  if (!Number.isFinite(marketCapUsd) || marketCapUsd <= 0) return SIZE_FLOOR;
  const raw = SIZE_FLOOR + Math.sqrt(marketCapUsd / MCAP_DIVISOR) * SIZE_SCALE;
  return Math.round(Math.min(SIZE_CEIL, Math.max(SIZE_FLOOR, raw)));
}
