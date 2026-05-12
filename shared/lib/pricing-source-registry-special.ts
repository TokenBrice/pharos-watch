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
    maxTrustedAgeSec: 35 * 60,
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
