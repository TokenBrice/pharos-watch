import { isGoldBlacklistStablecoin } from "@shared/lib/blacklist";

/** Returns true if the symbol is a gold-pegged stablecoin (XAUT or PAXG). */
export function isGoldStablecoin(symbol: string): symbol is "PAXG" | "XAUT" {
  return isGoldBlacklistStablecoin(symbol);
}
