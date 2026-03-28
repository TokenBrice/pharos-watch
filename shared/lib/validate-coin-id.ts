import { TRACKED_STABLECOINS } from "./stablecoins";

const KNOWN_IDS = new Set(TRACKED_STABLECOINS.map((c) => c.id));

/** Returns true if `id` matches a tracked stablecoin. */
export function isKnownCoinId(id: string): boolean {
  return KNOWN_IDS.has(id);
}
