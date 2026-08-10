import type { PricingSourceRegistryEntry } from "./pricing-source-registry-types";
import { definePricingSource, PRICING_SOURCE_PRESETS } from "./pricing-source-registry-presets";

export const PRICING_SOURCE_REGISTRY_SPECIAL = [
  definePricingSource(PRICING_SOURCE_PRESETS.softAggregator, {
    key: "defillama-contract",
    label: "DefiLlama (contract)",
    shortLabel: "Contract",
    depegSourceFamily: "defillama",
    maxTrustedAgeSec: 15 * 60,
    defaultWeight: 1,
    isListAggregator: true,
  }),
  definePricingSource(PRICING_SOURCE_PRESETS.hardProtocol, {
    key: "protocol-redeem",
    label: "Protocol Redemption",
    shortLabel: "Protocol",
    depegSourceFamily: "protocol:redeem",
    maxTrustedAgeSec: 15 * 60,
    defaultWeight: 3,
    isProtocolOverride: true,
    bypassesSoftValidationGuardrails: true,
  }),
  // Degradation lane for parent-derived vault routes: last-good on-chain rate ×
  // fresh trusted parent price when the live rate read fails. Deliberately
  // non-replay-safe and never depeg-authoritative — the rate is stale protocol
  // data with bounded drift, not a market observation.
  definePricingSource(PRICING_SOURCE_PRESETS.hardProtocol, {
    key: "protocol-redeem-cached-rate",
    label: "Protocol Redemption (cached rate)",
    shortLabel: "Protocol cached",
    depegSourceFamily: "protocol:redeem",
    maxTrustedAgeSec: 24 * 60 * 60,
    defaultWeight: 0,
    isProtocolOverride: true,
    bypassesSoftValidationGuardrails: true,
    isReplaySafe: false,
    canBeDepegAuthoritative: false,
  }),
  definePricingSource(PRICING_SOURCE_PRESETS.hardProtocol, {
    key: "zephyr-scanner",
    label: "Zephyr Scanner",
    shortLabel: "Zephyr",
    depegSourceFamily: "protocol:zephyr-scanner",
    maxTrustedAgeSec: 4 * 60 * 60,
    defaultWeight: 2,
    canBeDepegAuthoritative: false,
    canSingleSourceDepegAuthoritative: false,
  }),
  definePricingSource(PRICING_SOURCE_PRESETS.softDex, {
    key: "pool-tvl-weighted",
    label: "Pool TVL-weighted",
    shortLabel: "Pool",
    depegSourceFamily: "dex:pool-tvl-weighted",
    maxTrustedAgeSec: 75 * 60,
    defaultWeight: 1,
    bypassesSoftValidationGuardrails: true,
  }),
  definePricingSource(PRICING_SOURCE_PRESETS.cachedReplay, {
    key: "cached",
    label: "Cached fallback",
    shortLabel: "Cached",
    depegSourceFamily: "cached",
    maxTrustedAgeSec: null,
    defaultWeight: 0,
  }),
] as const satisfies readonly PricingSourceRegistryEntry[];
