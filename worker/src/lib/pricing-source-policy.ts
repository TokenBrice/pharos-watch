import { splitCompositePriceSource } from "@shared/lib/pricing-sources";
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
