/**
 * Returns the best market cap estimate for a commodity token.
 *
 * CoinGecko's usd_market_cap can become frozen/corrupted when the upstream
 * data source (e.g. DefiLlama) stops tracking a token. In that case,
 * circulating_supply × price gives a reliable independent value.
 *
 * Falls back to cgMcap when circulatingSupply is unavailable.
 * Falls back to computed when cgMcap is unavailable but supply+price are present.
 */
export function resolveMarketCap(
  cgMcap: number | undefined,
  circulatingSupply: number | undefined,
  price: number,
  divergenceThreshold = 0.20,
): number {
  const hasSupply = circulatingSupply != null && circulatingSupply > 0;
  const hasPrice = price > 0;

  if (!hasSupply || !hasPrice) {
    return cgMcap ?? 0;
  }

  const computed = circulatingSupply * price;

  if (!cgMcap || cgMcap <= 0) {
    return computed;
  }

  const divergence = Math.abs(cgMcap - computed) / computed;
  if (divergence > divergenceThreshold) {
    return computed;
  }

  return cgMcap;
}
