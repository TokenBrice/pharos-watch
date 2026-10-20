import type { PegSummaryCoin } from "@shared/types";

type PegSummaryCoins = { values(): Iterable<PegSummaryCoin> };

const ratesBySource = new WeakMap<PegSummaryCoins, Map<string, number>>();

function buildCurrencyRates(coins: PegSummaryCoins): Map<string, number> {
  const rates = new Map<string, number>();
  for (const coin of coins.values()) {
    const reference = coin.pegReference;
    // Commodity references are scaled per token weight, so they are not a
    // per-currency rate.
    if (!reference || coin.pegReferenceUnavailable === true || reference.usdPerTroyOunce !== undefined) continue;
    if (!rates.has(coin.pegCurrency)) rates.set(coin.pegCurrency, reference.valueUsd);
  }
  return rates;
}

/**
 * USD value of one peg-currency unit, used only to present a NAV token's
 * observed price in its peg currency. NAV tokens publish no peg reference of
 * their own (they carry no peg verdict), so the rate comes from a peer's
 * published reference for the same currency: the same derived rate for every
 * coin of that currency in one peg-summary generation. Null when no peer
 * published one; `formatNativePrice` then falls back to the USD price.
 */
export function getNavPriceReference(
  pegCurrency: string | undefined,
  coins: PegSummaryCoins | undefined,
): number | null {
  const currency = pegCurrency ?? "USD";
  if (currency === "USD") return 1;
  if (!coins) return null;
  let rates = ratesBySource.get(coins);
  if (!rates) {
    rates = buildCurrencyRates(coins);
    ratesBySource.set(coins, rates);
  }
  return rates.get(currency) ?? null;
}
