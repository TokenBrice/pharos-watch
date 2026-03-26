import { splitCompositePriceSource } from "@shared/lib/pricing-sources";
import type { PriceObservedAtMode } from "@shared/types/core";
import {
  getPricingSourceRegistryEntry,
} from "@shared/lib/pricing-source-registry";

export const FIXED_PEG_SEVERE_DOWNSIDE_RATIO = 0.5;

export function isPoolChallengeEligibleConsensus(sources: string[]): boolean {
  return sources.length > 0 && sources.every((source) => !getPricingSourceRegistryEntry(source)?.isPoolChallengeExempt);
}

export function isGtProbeEligibleSingleSource(source: string): boolean {
  return !!getPricingSourceRegistryEntry(source)?.isGtProbeEligible;
}

export function isReplaySafePriceSource(source: string | null | undefined): boolean {
  if (!source) return false;
  return splitCompositePriceSource(source).every((part) => getPricingSourceRegistryEntry(part)?.isReplaySafe ?? false);
}

export function hasDepegAuthoritativeSource(sources: string[] | null | undefined): boolean {
  if (!sources || sources.length === 0) return false;
  return sources.some((source) => getPricingSourceRegistryEntry(source)?.canBeDepegAuthoritative ?? false);
}

export function countDepegAuthoritativeSources(sources: string[] | null | undefined): number {
  if (!sources || sources.length === 0) return 0;
  return sources.filter((source) => getPricingSourceRegistryEntry(source)?.canBeDepegAuthoritative ?? false).length;
}

export function hasUpstreamCapableDepegAuthoritativeSource(sources: string[] | null | undefined): boolean {
  if (!sources || sources.length === 0) return false;
  return sources.some((source) => {
    const entry = getPricingSourceRegistryEntry(source);
    return !!entry?.canBeDepegAuthoritative && !!entry.supportsUpstreamObservedAt;
  });
}

export function isSingleSourceDepegAuthoritative(
  source: string | null | undefined,
  observedAtMode: PriceObservedAtMode | null | undefined,
): boolean {
  if (!source) return false;
  const entry = getPricingSourceRegistryEntry(source);
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
