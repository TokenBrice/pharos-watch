// Bank Run Gauge mcap weighting: restrict a coin's gauge contribution to its
// tracked-chain circulating supply rather than global peg-bucket total.
//
// This module imports the full MINT_BURN_CONFIGS registry intentionally; it
// must NOT be imported from hot paths that should stay lightweight
// (DEWS, daily digest). DEWS uses mint-burn-canonical-chain; the digest reads
// the published gauge instead of recomputing its weights.

import { MINT_BURN_CONFIGS, type MintBurnContractConfig } from "./mint-burn-contracts";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import type { MintBurnWindowStartSupply } from "@shared/types/mint-burn";
import {
  canonicalizeChainCirculating,
  type ChainCirculatingPoint,
  type RawChainCirculating,
} from "@shared/lib/chains/circulating";

/** Chains admitted by the caller's publication snapshot. */
export function getMintBurnTrackedChains(stablecoinId: string, configs: readonly MintBurnContractConfig[] = MINT_BURN_CONFIGS): string[] {
  return [...new Set(configs.filter((config) => config.stablecoinId === stablecoinId && config.enabled !== false)
    .map((config) => config.chain.chainId))];
}

/**
 * Returns the circulating-supply USD total restricted to chains we actively
 * track in mint/burn ingestion, drawn from `chainCirculating[chainId].current`
 * after normalizing raw (e.g. capitalized DL) keys to canonical chain ids.
 *
 * Fallback policy (in order):
 *   1. If the coin has no tracked chains (legacy/future id) → the canonical
 *      circulating total from `getCirculatingRawOrNull({ circulating })`.
 *   2. If the canonicalized chainCirculating has no tracked-chain entry →
 *      the canonical circulating total (keeps CG-fallback assets with empty
 *      chainCirculating alive).
 *   3. Otherwise sum `chainCirculating[chainId].current` across tracked chains.
 * An explicit empty publication scope returns null; a partial scope cannot use
 * the global fallback because it includes supply from withheld chains.
 *
 * Returns `null` when the fallback path has no observed circulating bucket: the
 * coin's weight is unavailable, never a measured `0`. Callers exclude it from
 * gauge weights and tracked-mcap totals and count it.
 *
 * Note: `current = 0` is treated as real data (a tracked-chain entry exists
 * and reports zero supply); it contributes 0 but does NOT trigger fallback.
 * A missing tracked-chain entry or unavailable `current` (`null`) makes the whole
 * weight unavailable (`null`) rather than a partial sum that reads as a zero leg.
 */
export function sumMcapForTrackedChains(
  stablecoinId: string,
  chainCirculating: RawChainCirculating | null | undefined,
  circulating: Record<string, number> | undefined,
  configs?: readonly MintBurnContractConfig[],
): number | null {
  const trackedChains = getMintBurnTrackedChains(stablecoinId, configs);
  const fullScope = configs == null || MINT_BURN_CONFIGS.filter((config) => config.stablecoinId === stablecoinId)
    .every((config) => trackedChains.includes(config.chain.chainId));
  // A global fallback cannot separate supply on a withheld chain.
  const fallbackSupply = fullScope ? getCirculatingRawOrNull({ circulating }) : null;
  if (trackedChains.length === 0) return configs ? null : fallbackSupply;

  const canonical = canonicalizeChainCirculating(chainCirculating);
  if (canonical.size === 0) return fallbackSupply;

  if (!trackedChains.some((chainId) => canonical.has(chainId))) return fallbackSupply;

  let total = 0;
  for (const chainId of trackedChains) {
    const entry = canonical.get(chainId);
    if (entry?.current == null) return null;
    total += entry.current;
  }
  return total;
}

type TrackedChainHistoricalBucket = "circulatingPrevDay" | "circulatingPrevWeek" | "circulatingPrevMonth";

function sumTrackedChainBucket(
  trackedChains: readonly string[],
  canonical: ReadonlyMap<string, ChainCirculatingPoint>,
  bucket: TrackedChainHistoricalBucket,
): number | null {
  if (trackedChains.length === 0 || canonical.size === 0) return null;
  let total = 0;
  for (const chainId of trackedChains) {
    const value = canonical.get(chainId)?.[bucket];
    if (value == null) return null;
    total += value;
  }
  return Number.isFinite(total) ? total : null;
}

/**
 * Returns observed tracked-chain circulating supply (USD) at the start of each
 * flow window (`24h`, `7d`, `30d`, `90d`), restricted to the caller's admitted
 * tracked chains.
 *
 * Applies the same fail-closed all-chains-observed rule as `sumMcapForTrackedChains`
 * for chain breakdowns: every admitted tracked chain must have an observed
 * `circulatingPrev{Day,Week,Month}` entry, with no global all-chain fallback
 * (which would mix untracked chains into a tracked-chain flow share). Observed
 * zero remains `0` (ADR-28 / R1); missing or null chains yield `null`.
 * `window90d` is `null` because Pharos stores no 90-day per-chain supply series.
 */
export function sumWindowStartSupplyForTrackedChains(
  stablecoinId: string,
  chainCirculating: RawChainCirculating | null | undefined,
  configs?: readonly MintBurnContractConfig[],
): MintBurnWindowStartSupply {
  const trackedChains = getMintBurnTrackedChains(stablecoinId, configs);
  const canonical = canonicalizeChainCirculating(chainCirculating);
  return {
    window24h: sumTrackedChainBucket(trackedChains, canonical, "circulatingPrevDay"),
    window7d: sumTrackedChainBucket(trackedChains, canonical, "circulatingPrevWeek"),
    window30d: sumTrackedChainBucket(trackedChains, canonical, "circulatingPrevMonth"),
    window90d: null,
  };
}
