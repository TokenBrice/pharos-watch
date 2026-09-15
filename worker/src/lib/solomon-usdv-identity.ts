import { normalizePricingSourceKeys } from "@shared/lib/pricing-sources";

// Reviewed 2026-09-15: CoinGecko reused solomon-usdv for the separate six-decimal
// Chancery mint. DefiLlama's legacy list AND old-mint contract quote alias it.
// https://github.com/SolomonLabs/chancery/blob/main/config/networks/mainnet.ts
export const LEGACY_SOLOMON_USDV_ID = "usdv-solomon";

/** Current CoinGecko quotes identify V2; its mixed historical series identifies neither. */
export function isCoinGeckoHistoryAllowed(geckoId: string): boolean {
  return geckoId !== "solomon-usdv";
}

export function isSolomonPriceIdentityAllowed(
  stablecoinId: string | undefined,
  source: string | null | undefined,
  agreeSources: readonly string[] = [],
): boolean {
  if (stablecoinId !== LEGACY_SOLOMON_USDV_ID) return true;
  const sources = normalizePricingSourceKeys(source);
  if (sources.length === 0) return false;
  return normalizePricingSourceKeys([...sources, ...agreeSources]).every((key) =>
    !key.startsWith("coingecko") && !key.startsWith("defillama") &&
    key !== "cached" && key !== "unknown",
  );
}
