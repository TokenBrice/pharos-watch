import type { PegAssetBase, StablecoinMeta } from "./types";
import { sumPegBuckets } from "./supply";

type PegRateSource = "median" | "fallback";

export interface PegRatesResult {
  rates: Record<string, number>;
  sources: Record<string, PegRateSource>;
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
  for (const [peg, prices] of Object.entries(groups)) {
    prices.sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    const median =
      prices.length % 2 === 0
        ? (prices[mid - 1] + prices[mid]) / 2
        : prices[mid];

    // For commodity pegs (gold/silver), always prefer the spot price.
    // Peer median is self-referential when 2 tokens dominate the group —
    // commodity spot IS the definitive reference.
    // For fiat pegs with thin groups (<3 coins), use ECB FX rate instead of
    // unreliable median (1 coin = own price, 2 coins = mirror deviations).
    const fallback = mergedFallbacks[peg];
    const isCommodity = peg === "peggedGOLD" || peg === "peggedSILVER";
    if (fallback && (isCommodity || prices.length < 3)) {
      rates[peg] = fallback;
      sources[peg] = "fallback";
      continue;
    }

    rates[peg] = median;
    sources[peg] = "median";
  }

  // Fallback: USD is always 1
  if (!rates["peggedUSD"]) rates["peggedUSD"] = 1;
  if (!sources["peggedUSD"]) sources["peggedUSD"] = "median";

  return { rates, sources };
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
