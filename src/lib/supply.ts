import type { StablecoinData } from "./types";

/**
 * Sum circulating values across all peg buckets.
 * DefiLlama stores all circulating values in USD regardless of pegType key,
 * so no FX conversion is needed — the raw sum IS the USD market cap.
 */
export function getCirculatingRaw(c: StablecoinData): number {
  if (!c.circulating) return 0;
  return Object.values(c.circulating).reduce((s, v) => s + (v ?? 0), 0);
}

export function getPrevDayRaw(c: StablecoinData): number {
  if (!c.circulatingPrevDay) return 0;
  return Object.values(c.circulatingPrevDay).reduce((s, v) => s + (v ?? 0), 0);
}

export function getPrevWeekRaw(c: StablecoinData): number {
  if (!c.circulatingPrevWeek) return 0;
  return Object.values(c.circulatingPrevWeek).reduce((s, v) => s + (v ?? 0), 0);
}

export function getPrevMonthRaw(c: StablecoinData): number {
  if (!c.circulatingPrevMonth) return 0;
  return Object.values(c.circulatingPrevMonth).reduce((s, v) => s + (v ?? 0), 0);
}
