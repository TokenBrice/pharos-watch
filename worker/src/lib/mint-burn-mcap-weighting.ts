// Bank Run Gauge mcap weighting: restrict a coin's gauge contribution to its
// tracked-chain circulating supply rather than global peg-bucket total.
//
// This module imports the full MINT_BURN_CONFIGS registry intentionally; it
// must NOT be imported from hot paths that should stay lightweight
// (DEWS, daily digest). Those consumers should use mint-burn-canonical-chain
// instead.

import { MINT_BURN_CONFIGS } from "./mint-burn-contracts";
import { getCirculatingRaw } from "@shared/lib/supply";
import {
  canonicalizeChainCirculating,
  type RawChainCirculating,
} from "@shared/lib/chain-circulating";

const TRACKED_CHAINS_BY_COIN: Map<string, Set<string>> = (() => {
  const map = new Map<string, Set<string>>();
  for (const c of MINT_BURN_CONFIGS) {
    let chains = map.get(c.stablecoinId);
    if (!chains) {
      chains = new Set<string>();
      map.set(c.stablecoinId, chains);
    }
    chains.add(c.chain.chainId);
  }
  return map;
})();

/** Chains we actively track in mint/burn ingestion for this stablecoin. */
export function getMintBurnTrackedChains(stablecoinId: string): string[] {
  const chains = TRACKED_CHAINS_BY_COIN.get(stablecoinId);
  return chains ? [...chains] : [];
}

/**
 * Returns the circulating-supply USD total restricted to chains we actively
 * track in mint/burn ingestion, drawn from `chainCirculating[chainId].current`
 * after normalizing raw (e.g. capitalized DL) keys to canonical chain ids.
 *
 * Fallback policy (in order):
 *   1. If the coin has no tracked chains (legacy/future id) → the canonical
 *      circulating total from `getCirculatingRaw({ circulating })`.
 *   2. If the canonicalized chainCirculating has no tracked-chain entry →
 *      the canonical circulating total (keeps CG-fallback assets with empty
 *      chainCirculating alive and tolerates current=null entries).
 *   3. Otherwise sum `chainCirculating[chainId].current` across tracked chains.
 *
 * Note: `current = 0` is treated as real data (a tracked-chain entry exists
 * and reports zero supply); it contributes 0 but does NOT trigger fallback.
 */
export function sumMcapForTrackedChains(
  stablecoinId: string,
  chainCirculating: RawChainCirculating | null | undefined,
  circulating: Record<string, number> | undefined,
): number {
  const fallbackSupply = getCirculatingRaw({ circulating });
  const trackedChains = getMintBurnTrackedChains(stablecoinId);
  if (trackedChains.length === 0) return fallbackSupply;

  const canonical = canonicalizeChainCirculating(chainCirculating);
  if (canonical.size === 0) return fallbackSupply;

  let total = 0;
  let anyFound = false;
  for (const chainId of trackedChains) {
    const entry = canonical.get(chainId);
    if (entry) {
      total += entry.current;
      anyFound = true;
    }
  }
  if (!anyFound) return fallbackSupply;
  return total;
}
