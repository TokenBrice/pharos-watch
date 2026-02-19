import type { StablecoinData, StablecoinMeta } from "./types";

/**
 * Hardcoded FX rate fallbacks — used only when live rates are unavailable.
 * Prefer passing dynamic rates from the FX rate sync cron via `fallbackRates`.
 */
const DEFAULT_FALLBACK_RATES: Record<string, number> = {
  peggedEUR: 1.08,
  peggedGBP: 1.27,
  peggedCHF: 1.13,
  peggedBRL: 0.18,
  peggedRUB: 0.0125,
  peggedJPY: 0.00645,
  peggedIDR: 0.0000591,
};

/**
 * Derive peg reference rates from the DefiLlama data itself.
 * For each pegType, compute the median price of coins with mcap > $1M.
 * This gives us live FX rates (e.g. peggedEUR -> ~1.19 USD).
 *
 * For gold-pegged tokens, prices are normalized to "per troy ounce" using
 * the goldOunces field from StablecoinMeta, since some tokens represent
 * 1 gram (KAU) while others represent 1 troy ounce (XAUT, PAXG).
 *
 * @param fallbackRates  Optional live FX rates (from sync-fx-rates cron).
 *                       If provided, used instead of hardcoded defaults for
 *                       thin peg group validation.
 *
 * Returns a map of pegType -> USD value of 1 unit of the peg currency.
 */
export function derivePegRates(
  assets: StablecoinData[],
  metaById?: Map<string, StablecoinMeta>,
  fallbackRates?: Record<string, number>,
): Record<string, number> {
  const groups: Record<string, number[]> = {};

  for (const a of assets) {
    const peg = a.pegType;
    let price = a.price;
    if (!peg || price == null || typeof price !== "number" || isNaN(price) || price <= 0) continue;

    // Only use coins with meaningful supply to avoid garbage data
    const supply = a.circulating
      ? Object.values(a.circulating).reduce((s, v) => s + (v ?? 0), 0)
      : 0;
    if (supply < 1_000_000) continue;

    // For gold tokens, normalize price to "per troy ounce"
    if (peg === "peggedGOLD" && metaById) {
      const meta = metaById.get(a.id);
      const oz = meta?.goldOunces;
      if (oz && oz > 0) {
        price = price / oz; // e.g. $162/gram → $162 / (1/31.1035) = ~$5039/oz
      }
    }

    if (!groups[peg]) groups[peg] = [];
    groups[peg].push(price);
  }

  const mergedFallbacks = fallbackRates
    ? { ...DEFAULT_FALLBACK_RATES, ...fallbackRates }
    : DEFAULT_FALLBACK_RATES;

  const rates: Record<string, number> = {};
  for (const [peg, prices] of Object.entries(groups)) {
    prices.sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    const median =
      prices.length % 2 === 0
        ? (prices[mid - 1] + prices[mid]) / 2
        : prices[mid];

    // For thin groups (<3 coins), validate against fallback to catch depegged references
    const fallback = mergedFallbacks[peg];
    if (prices.length < 3 && fallback) {
      const deviation = Math.abs(median - fallback) / fallback;
      if (deviation > 0.10) {
        rates[peg] = fallback;
        continue;
      }
    }

    rates[peg] = median;
  }

  // Fallback: USD is always 1
  if (!rates["peggedUSD"]) rates["peggedUSD"] = 1;

  return rates;
}

/**
 * Get the expected USD price for a coin given its pegType and the derived rates.
 * For gold-pegged tokens, adjusts the per-ounce reference by goldOunces
 * so that gram-denominated tokens get the correct per-gram reference.
 */
export function getPegReference(
  pegType: string | undefined,
  rates: Record<string, number>,
  goldOunces?: number
): number {
  if (!pegType) return 1;
  const rate = rates[pegType] ?? 1;
  // For gold tokens, scale the per-ounce rate by the token's gold weight
  if (pegType === "peggedGOLD" && goldOunces && goldOunces > 0) {
    return rate * goldOunces;
  }
  return rate;
}
