// Lightweight canonical-chain overrides for consumers that only need to
// exclude known non-economic rows from downstream aggregates without loading
// the full mint-burn contract registry.

import { MINT_BURN_CONFIGS } from "./mint-burn-contracts";
import { sumPegBuckets } from "@shared/lib/supply";

const NON_ETHEREUM_CANONICAL_CHAIN_BY_STABLECOIN = new Map<string, string>([
  ["usdai-usd-ai", "arbitrum"],
]);

function getCanonicalMintBurnChainId(stablecoinId: string): string {
  return NON_ETHEREUM_CANONICAL_CHAIN_BY_STABLECOIN.get(stablecoinId) ?? "ethereum";
}

export function isCanonicalMintBurnPair(stablecoinId: string, chainId: string): boolean {
  return getCanonicalMintBurnChainId(stablecoinId) === chainId;
}

const TRACKED_CHAINS_BY_COIN: Map<string, string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const c of MINT_BURN_CONFIGS) {
    const set = new Set(map.get(c.stablecoinId) ?? []);
    set.add(c.chain.chainId);
    map.set(c.stablecoinId, [...set]);
  }
  return map;
})();

export function getMintBurnTrackedChains(stablecoinId: string): string[] {
  return TRACKED_CHAINS_BY_COIN.get(stablecoinId) ?? [];
}

/**
 * Returns the circulating-supply USD total restricted to chains we actively
 * track in mint/burn ingestion, drawn from `chainCirculating[chainId].current`.
 *
 * Fallback policy (in order):
 *   1. If the coin has no tracked chains (legacy/future id) → `sumPegBuckets(circulating)`.
 *   2. If `chainCirculating` is missing or has no tracked-chain key → `sumPegBuckets(circulating)`.
 *      (CG-fallback assets ship with empty `chainCirculating: {}` so this keeps them alive.)
 *   3. Otherwise sum `chainCirculating[chainId].current` across tracked chains.
 */
export function sumMcapForTrackedChains(
  stablecoinId: string,
  chainCirculating: Record<string, { current?: number | null } | undefined> | undefined,
  circulating: Record<string, number> | undefined,
): number {
  const trackedChains = getMintBurnTrackedChains(stablecoinId);
  if (trackedChains.length === 0) return sumPegBuckets(circulating);

  let total = 0;
  let anyFound = false;
  for (const chainId of trackedChains) {
    const v = chainCirculating?.[chainId]?.current;
    if (typeof v === "number" && Number.isFinite(v)) {
      total += v;
      anyFound = true;
    }
  }
  // If none of the tracked chains have data, fall back to the peg-bucket total
  // so the gauge degrades to legacy behavior rather than zeroing the coin out.
  if (!anyFound) return sumPegBuckets(circulating);
  return total;
}
