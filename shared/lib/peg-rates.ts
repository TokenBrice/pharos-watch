import type { PegAssetBase, StablecoinMeta } from "../types";
import { sumPegBuckets } from "./supply";

/**
 * Coins excluded from the commodity peer-median reference.
 * DGLD's CoinGecko price is ~2× gold spot (likely a data error), which
 * poisons the median used as peg reference for all gold tokens.
 */
export const COMMODITY_MEDIAN_EXCLUDES = new Set(["dgld-gold-token-sa"]);

export type PegRateSource = "median" | "fallback";

export interface PegRatesResult {
  rates: Record<string, number>;
  sources: Record<string, PegRateSource>;
  counts: Record<string, number>;
}

/**
 * Derive peg reference rates from the DefiLlama data itself.
 * For each pegType, compute the median price of coins with mcap > $1M.
 * This gives us live FX rates (e.g. peggedEUR -> ~1.19 USD).
 *
 * For gold-pegged tokens, prices are normalized to "per troy ounce" using
 * the commodityOunces field from StablecoinMeta, since some tokens represent
 * 1 gram (KAU) while others represent 1 troy ounce (XAUT, PAXG).
 *
 * @param fallbackRates  Optional live FX rates (from sync-fx-rates cron).
 *                       If provided, used instead of hardcoded defaults for
 *                       thin peg group validation.
 *
 * Returns a map of pegType -> USD value of 1 unit of the peg currency.
 */
export function derivePegRates(
  assets: PegAssetBase[],
  metaById?: Map<string, StablecoinMeta>,
  fallbackRates?: Record<string, number>,
): PegRatesResult {
  const groups: Record<string, number[]> = {};

  for (const a of assets) {
    const peg = a.pegType;
    let price = a.price;
    if (!peg || price == null || typeof price !== "number" || isNaN(price) || price <= 0) continue;

    // Only use coins with meaningful supply to avoid garbage data
    const supply = sumPegBuckets(a.circulating);
    if (supply < 1_000_000) continue;

    // For gold/silver tokens, normalize price to "per troy ounce"
    if ((peg === "peggedGOLD" || peg === "peggedSILVER") && metaById) {
      if (COMMODITY_MEDIAN_EXCLUDES.has(a.id)) continue;
      const meta = metaById.get(a.id);
      const oz = meta?.commodityOunces;
      if (oz && oz > 0) {
        price = price / oz; // e.g. $162/gram → $162 / (1/31.1035) = ~$5039/oz
      }
    }

    if (!groups[peg]) groups[peg] = [];
    groups[peg].push(price);
  }

  // Use only live cached FX rates — no stale hardcoded defaults.
  // On fresh deploy before first FX sync, fallbackRates is undefined
  // and thin-group validation is skipped for one cycle.
  const mergedFallbacks = fallbackRates ?? {};

  const rates: Record<string, number> = {};
  const sources: Record<string, PegRateSource> = {};
  const counts: Record<string, number> = {};
  for (const [peg, prices] of Object.entries(groups)) {
    // Guard: skip empty groups (shouldn't happen since we only push non-empty,
    // but defends the median indexing below against an empty array).
    if (prices.length === 0) continue;
    prices.sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    const median =
      prices.length % 2 === 0
        ? (prices[mid - 1] + prices[mid]) / 2
        : prices[mid];

    // For thin fiat peg groups (<3 coins), use ECB FX rate instead of
    // unreliable median (1 coin = own price, 2 coins = mirror deviations).
    // Commodity pegs (gold/silver) use peer median — XAUT/PAXG are arbitraged
    // against spot within seconds, so the median is a live reference. metals.dev
    // spot is only fetched once per day and can be >1.5% stale, causing false depegs.
    const fallback = mergedFallbacks[peg];
    if (fallback && prices.length < 3) {
      rates[peg] = fallback;
      sources[peg] = "fallback";
      counts[peg] = prices.length;
      continue;
    }

    rates[peg] = median;
    sources[peg] = "median";
    counts[peg] = prices.length;
  }

  for (const [peg, fallback] of Object.entries(mergedFallbacks)) {
    if (peg in rates) continue;
    if (typeof fallback !== "number" || !Number.isFinite(fallback) || fallback <= 0) continue;
    rates[peg] = fallback;
    sources[peg] = "fallback";
    counts[peg] = 0;
  }

  // Fallback: USD is always 1
  if (!rates["peggedUSD"]) rates["peggedUSD"] = 1;
  if (!sources["peggedUSD"]) sources["peggedUSD"] = "median";

  return { rates, sources, counts };
}

/**
 * Get the expected USD price for a coin given its pegType and the derived rates.
 * For gold-pegged tokens, adjusts the per-ounce reference by commodityOunces
 * so that gram-denominated tokens get the correct per-gram reference.
 */
export function getPegReference(
  pegType: string | undefined,
  rates: Record<string, number>,
  commodityOunces?: number
): number {
  if (!pegType) return 1;
  const rate = rates[pegType] ?? 1;
  // For gold/silver tokens, scale the per-ounce rate by the token's weight
  if ((pegType === "peggedGOLD" || pegType === "peggedSILVER") && commodityOunces && commodityOunces > 0) {
    return rate * commodityOunces;
  }
  return rate;
}
