import { CLIENT_TRACKED_IDS } from "./stablecoins/client-registry";

/**
 * Check whether a coin ID is in the tracked stablecoins set.
 * Excludes shadow stablecoins (PSI phantom assets). For shadow-inclusive
 * validation, use PSI_INCLUSIVE_REGISTRY_BY_ID.has() from stablecoin-id-registry.ts.
 */
export function isKnownCoinId(id: string): boolean {
  return CLIENT_TRACKED_IDS.has(id);
}
