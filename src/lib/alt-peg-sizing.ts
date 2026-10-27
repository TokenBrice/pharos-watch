export const SIZE_FLOOR = 16;
export const SIZE_CEIL = 92;
// One sqrt scale for every emblem. It is gentle enough that the map ceiling sits near
// the largest mapped coins (~$1.2B), so the leading euro coins stay distinguishable.
export const SHELF_SIZE_CEIL = 48;
export const FIAT_MAP_SIZE_CEIL = 40;
const SIZE_SCALE = 0.7;
/** Unknown supply: a neutral mid-size marker, distinct from the measured-zero floor. */
const UNKNOWN_SUPPLY_SIZE = 23;
const MCAP_DIVISOR = 1_000_000;

/** Market cap at which an emblem reaches a ceiling: one sqrt scale, two ceilings (map vs shelf). */
export function sizeCapMarketCap(ceil: number): number {
  return ((ceil - SIZE_FLOOR) / SIZE_SCALE) ** 2 * MCAP_DIVISOR;
}

export function coinEmblemSize(marketCapUsd: number | null, options: { ceil?: number } = {}): number {
  const ceil = options.ceil ?? SIZE_CEIL;
  if (marketCapUsd === null) return Math.min(UNKNOWN_SUPPLY_SIZE, ceil);
  if (!Number.isFinite(marketCapUsd) || marketCapUsd <= 0) return Math.min(SIZE_FLOOR, ceil);
  const raw = SIZE_FLOOR + Math.sqrt(marketCapUsd / MCAP_DIVISOR) * SIZE_SCALE;
  return Math.round(Math.min(ceil, Math.max(SIZE_FLOOR, raw)));
}
