import type { PegAssetBase, StablecoinMeta } from "../types";
import { normalizeLegacyPegType } from "./peg-price-bounds";
import { PEG_TAXONOMY } from "./peg-taxonomy";
import { median } from "@shared/lib/stats";
import { getCirculatingRaw } from "./supply";

/**
 * Coins excluded from the commodity peer-median reference.
 * DGLD's CoinGecko price is ~2× gold spot (likely a data error), which
 * poisons the median used as peg reference for all gold tokens.
 */
export const COMMODITY_MEDIAN_EXCLUDES = new Set(["dgld-gold-token-sa"]);

export type PegRateSource = "median" | "fx" | "fallback";

export interface PegRatesResult {
  rates: Record<string, number>;
  sources: Record<string, PegRateSource>;
  counts: Record<string, number>;
}

export function normalizePegType(pegType: string | undefined): string | undefined {
  return pegType ? normalizeLegacyPegType(pegType) : undefined;
}

function normalizeFallbackRates(fallbackRates: Record<string, number> | undefined): Record<string, number> {
  const normalized: Record<string, number> = {};
  for (const [pegType, rate] of Object.entries(fallbackRates ?? {})) {
    const peg = normalizePegType(pegType);
    if (!peg) continue;
    normalized[peg] = rate;
  }
  return normalized;
}

function addPegRateAliases(result: PegRatesResult): void {
  for (const entry of Object.values(PEG_TAXONOMY)) {
    const canonical = entry.canonicalPegType;
    if (!canonical || result.rates[canonical] == null) continue;
    for (const alias of entry.pegTypeAliases ?? []) {
      if (result.rates[alias] == null) result.rates[alias] = result.rates[canonical];
      if (result.sources[canonical] != null && result.sources[alias] == null) {
        result.sources[alias] = result.sources[canonical];
      }
      if (result.counts[canonical] != null && result.counts[alias] == null) {
        result.counts[alias] = result.counts[canonical];
      }
    }
  }
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
 * @param fallbackRates  Optional live FX/commodity rates from sync-fx-rates.
 *                       Fiat rates are authoritative current references;
 *                       commodity rates remain fallbacks for thin groups.
 *
 * Returns a map of pegType -> USD value of 1 unit of the peg currency.
 */
export function derivePegRates(
  assets: PegAssetBase[],
  metaById?: ReadonlyMap<string, Pick<StablecoinMeta, "commodityOunces">>,
  fallbackRates?: Record<string, number>,
): PegRatesResult {
  const groups = new Map<string, number[]>();

  for (const a of assets) {
    const peg = normalizePegType(a.pegType);
    let price = a.price;
    if (!peg || price == null || typeof price !== "number" || isNaN(price) || price <= 0) continue;

    // Only use coins with meaningful supply to avoid garbage data
    const supply = getCirculatingRaw(a);
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

    const prices = groups.get(peg) ?? [];
    prices.push(price);
    groups.set(peg, prices);
  }

  // Use only live cached FX rates — no stale hardcoded defaults.
  // On fresh deploy before first FX sync, fallbackRates is undefined
  // and thin-group validation is skipped for one cycle.
  const mergedFallbacks = normalizeFallbackRates(fallbackRates);

  const rates: Record<string, number> = Object.create(null) as Record<string, number>;
  const sources: Record<string, PegRateSource> = Object.create(null) as Record<string, PegRateSource>;
  const counts: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [peg, prices] of groups.entries()) {
    // Keep the scoring reference unrounded; display medians round at the API edge.
    // median() returns null for empty groups, so no separate empty-array guard is needed.
    const medianValue = median(prices);
    if (medianValue == null) continue;

    // A live FX rate is authoritative for fiat pegs regardless of peer count.
    // Peer medians remain a fallback only when an FX rate is unavailable.
    // This prevents a broad peer group, including the evaluated asset itself,
    // from shifting the displayed peg away from the actual fiat unit.
    // Commodity pegs (gold/silver) use peer median — XAUT/PAXG are arbitraged
    // against spot within seconds, so the median is a live reference. metals.dev
    // spot is only fetched once per day and can be >1.5% stale, causing false depegs.
    const fallback = Object.prototype.hasOwnProperty.call(mergedFallbacks, peg)
      ? mergedFallbacks[peg]
      : undefined;
    const isCommodityPeg = peg === "peggedGOLD" || peg === "peggedSILVER";
    if (fallback && (!isCommodityPeg || prices.length < 3)) {
      rates[peg] = fallback;
      sources[peg] = isCommodityPeg ? "fallback" : "fx";
      counts[peg] = prices.length;
      continue;
    }

    rates[peg] = medianValue;
    sources[peg] = "median";
    counts[peg] = prices.length;
  }

  for (const [peg, fallback] of Object.entries(mergedFallbacks)) {
    if (peg in rates) continue;
    if (typeof fallback !== "number" || !Number.isFinite(fallback) || fallback <= 0) continue;
    rates[peg] = fallback;
    sources[peg] = peg === "peggedGOLD" || peg === "peggedSILVER" ? "fallback" : "fx";
    counts[peg] = 0;
  }

  // Fallback: USD is always 1
  if (!rates["peggedUSD"]) rates["peggedUSD"] = 1;
  if (!sources["peggedUSD"]) sources["peggedUSD"] = "median";

  const result = { rates, sources, counts };
  addPegRateAliases(result);
  return result;
}

/**
 * Get the expected USD price for a coin given its pegType and the derived rates.
 * Returns null when a non-USD reference is unavailable; USD remains fixed at 1.
 * For gold-pegged tokens, adjusts the per-ounce reference by commodityOunces
 * so that gram-denominated tokens get the correct per-gram reference.
 */
export function getPegReference(
  pegType: string | undefined,
  rates: Record<string, number>,
  commodityOunces?: number
): number | null {
  if (!pegType) return null;
  const peg = normalizePegType(pegType);
  if (!peg) return null;
  if (peg === "peggedUSD") return 1;
  const rate = rates[peg];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
  // For gold/silver tokens, scale the per-ounce rate by the token's weight
  if ((peg === "peggedGOLD" || peg === "peggedSILVER") && commodityOunces && commodityOunces > 0) {
    return rate * commodityOunces;
  }
  return rate;
}
