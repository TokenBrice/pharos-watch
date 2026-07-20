import type { PriceObservedAtMode } from "../types/core";
import { getPricingSourceRegistryEntry } from "./pricing-source-registry";
import { normalizePricingSourceKeys } from "./pricing-sources";

export const FIXED_PEG_SEVERE_DOWNSIDE_RATIO = 0.5;

export function isPoolChallengeEligibleConsensus(sources: string[]): boolean {
  const sourceParts = normalizePricingSourceKeys(sources);
  return (
    sourceParts.length > 0 &&
    sourceParts.every((source) => {
      const entry = getPricingSourceRegistryEntry(source);
      return entry != null && !entry.isPoolChallengeExempt;
    })
  );
}

export function isGtProbeEligibleSingleSource(source: string): boolean {
  return !!getPricingSourceRegistryEntry(source)?.isGtProbeEligible;
}

export function isReplaySafePriceSource(source: string | null | undefined): boolean {
  if (!source) return false;
  const sourceParts = normalizePricingSourceKeys(source);
  return (
    sourceParts.length > 0 && sourceParts.every((part) => getPricingSourceRegistryEntry(part)?.isReplaySafe ?? false)
  );
}

/**
 * Returns the per-source max trusted age (seconds), or the composite cap when the source has no per-source window.
 *
 * Trust monotonicity: the window is computed over the composite's replay-safe
 * core. An agreeing non-replay-safe corroborator (e.g. an exact-address
 * augmentation lane joining a consensus label) must not zero the window the
 * core earns on its own. Unknown source keys and cached-replay lineage remain
 * hard failures — a mislabeled or cache-of-cache row never replays.
 */
export function getPriceCacheMaxAgeSec(source: string | null | undefined, compositeCapSec: number): number {
  if (!source) return compositeCapSec;
  let maxAgeSec = compositeCapSec;
  let replaySafeParts = 0;
  for (const part of normalizePricingSourceKeys(source)) {
    const entry = getPricingSourceRegistryEntry(part);
    if (!entry || entry.trustTier === "cached_replay") {
      return 0;
    }
    if (!entry.isReplaySafe) continue;
    replaySafeParts += 1;
    const sourceWindow = entry.maxTrustedAgeSec;
    if (typeof sourceWindow === "number" && Number.isFinite(sourceWindow) && sourceWindow > 0) {
      maxAgeSec = Math.min(maxAgeSec, sourceWindow);
    }
  }
  return replaySafeParts > 0 ? maxAgeSec : 0;
}

export function hasDepegAuthoritativeSource(sources: string[] | null | undefined): boolean {
  if (!sources || sources.length === 0) return false;
  return normalizePricingSourceKeys(sources).some(
    (source) => getPricingSourceRegistryEntry(source)?.canBeDepegAuthoritative ?? false,
  );
}

export function countDepegAuthoritativeSources(sources: string[] | null | undefined): number {
  if (!sources || sources.length === 0) return 0;
  return [...new Set(normalizePricingSourceKeys(sources))].filter(
    (source) => getPricingSourceRegistryEntry(source)?.canBeDepegAuthoritative ?? false,
  ).length;
}

export function hasUpstreamCapableDepegAuthoritativeSource(sources: string[] | null | undefined): boolean {
  if (!sources || sources.length === 0) return false;
  return normalizePricingSourceKeys(sources).some((source) => {
    const entry = getPricingSourceRegistryEntry(source);
    return !!entry?.canBeDepegAuthoritative && !!entry.supportsUpstreamObservedAt;
  });
}

export function isSingleSourceDepegAuthoritative(
  source: string | null | undefined,
  observedAtMode: PriceObservedAtMode | null | undefined,
): boolean {
  if (!source) return false;
  const sourceParts = normalizePricingSourceKeys(source);
  if (sourceParts.length !== 1) return false;
  const entry = getPricingSourceRegistryEntry(sourceParts[0]);
  if (!entry?.canSingleSourceDepegAuthoritative) {
    return false;
  }

  if (observedAtMode === "upstream") {
    return true;
  }

  if (observedAtMode == null && entry.supportsUpstreamObservedAt) {
    return true;
  }

  return false;
}
