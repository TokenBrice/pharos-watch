import { TRACKED_IDS } from "./stablecoins";

/**
 * Check whether a coin ID is in the tracked stablecoins set.
 * Excludes shadow stablecoins (PSI phantom assets). For shadow-inclusive
 * validation, use REGISTRY_BY_ID.has() from stablecoin-id-registry.ts.
 */
export function isKnownCoinId(id: string): boolean {
  return TRACKED_IDS.has(id);
}
