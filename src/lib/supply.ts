import type { StablecoinData } from "./types";

/** Sum all peg-denominated circulating values (no FX conversion) */
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

/** Convert peg-denominated bucket to USD using FX rates */
function toUSD(bucket: Record<string, number | null> | undefined, rates: Record<string, number>): number {
  if (!bucket) return 0;
  return Object.entries(bucket).reduce((s, [peg, v]) => {
    // Gold values are already in USD (CoinGecko mcap), skip rate conversion
    const rate = peg === "peggedGOLD" ? 1 : (rates[peg] ?? 1);
    return s + (v ?? 0) * rate;
  }, 0);
}

export function getCirculatingUSD(c: StablecoinData, rates: Record<string, number>): number {
  return toUSD(c.circulating, rates);
}

export function getPrevDayUSD(c: StablecoinData, rates: Record<string, number>): number {
  return toUSD(c.circulatingPrevDay, rates);
}

export function getPrevWeekUSD(c: StablecoinData, rates: Record<string, number>): number {
  return toUSD(c.circulatingPrevWeek, rates);
}

export function getPrevMonthUSD(c: StablecoinData, rates: Record<string, number>): number {
  return toUSD(c.circulatingPrevMonth, rates);
}
