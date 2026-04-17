import type { PriceObservedAtMode } from "../types/core";

export type PricingSourceTrustTier =
  | "hard_oracle"
  | "hard_market"
  | "hard_protocol"
  | "soft_aggregator"
  | "soft_dex"
  | "fallback_search"
  | "cached_replay";

export type PricingSourceFreshnessKind = "upstream" | "local_fetch" | "unknown";

export interface PricingSourceCapabilities {
  hasBidAsk?: boolean;
  hasTradeAge?: boolean;
  hasUpstreamTimestamp?: boolean;
  isLastTradeOnly?: boolean;
}

export interface PricingSourceRegistryEntry {
  key: string;
  label: string;
  shortLabel: string;
  trustTier: PricingSourceTrustTier;
  freshnessKind: PricingSourceFreshnessKind;
  maxTrustedAgeSec: number | null;
  defaultWeight: number;
  isSoftSource: boolean;
  isReplaySafe: boolean;
  isPoolChallengeExempt: boolean;
  isGtProbeEligible: boolean;
  canBeDepegAuthoritative: boolean;
  canSingleSourceDepegAuthoritative: boolean;
  supportsUpstreamObservedAt: boolean;
  requiresObservedAt: boolean;
  isSearchDerived: boolean;
  isProtocolOverride?: boolean;
  bypassesSoftValidationGuardrails?: boolean;
  /**
   * Marks a source as a list-style aggregator (e.g. CoinGecko list, DefiLlama list,
   * DefiLlama detail endpoint). Two-source clusters composed entirely of list
   * aggregators are downgraded to single-source in post-consensus hardening because
   * both voices tend to re-export the same upstream list data.
   */
  isListAggregator?: boolean;
  capabilities?: PricingSourceCapabilities;
  defaultObservedAtMode: PriceObservedAtMode | null;
}
