export const SIZE_FLOOR = 26;
export const SIZE_CEIL = 120;
export const FIAT_MAP_SIZE_CEIL = 84;
const SIZE_SCALE = 4.0;
const MCAP_DIVISOR = 1_000_000;

export const FIAT_MAP_SIZE_CAP_MARKET_CAP = ((FIAT_MAP_SIZE_CEIL - SIZE_FLOOR) / SIZE_SCALE) ** 2 * MCAP_DIVISOR;

export function coinEmblemSize(marketCapUsd: number, options: { ceil?: number } = {}): number {
  const ceil = options.ceil ?? SIZE_CEIL;
  if (!Number.isFinite(marketCapUsd) || marketCapUsd <= 0) return Math.min(SIZE_FLOOR, ceil);
  const raw = SIZE_FLOOR + Math.sqrt(marketCapUsd / MCAP_DIVISOR) * SIZE_SCALE;
  return Math.round(Math.min(ceil, Math.max(SIZE_FLOOR, raw)));
}
