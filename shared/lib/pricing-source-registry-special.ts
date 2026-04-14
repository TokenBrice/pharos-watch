import type { PricingSourceRegistryEntry } from "./pricing-source-registry-types";
import { definePricingSource, PRICING_SOURCE_PRESETS } from "./pricing-source-registry-presets";

export const PRICING_SOURCE_REGISTRY_SPECIAL = [
  definePricingSource(PRICING_SOURCE_PRESETS.softAggregator, {
    key: "defillama-contract",
    label: "DefiLlama (contract)",
    shortLabel: "Contract",
    maxTrustedAgeSec: 15 * 60,
    defaultWeight: 1,
  }),
  definePricingSource(PRICING_SOURCE_PRESETS.hardProtocol, {
    key: "protocol-redeem",
    label: "Protocol Redemption",
    shortLabel: "Protocol",
    maxTrustedAgeSec: 15 * 60,
    defaultWeight: 3,
    isProtocolOverride: true,
    bypassesSoftValidationGuardrails: true,
  }),
  definePricingSource(PRICING_SOURCE_PRESETS.softDex, {
    key: "pool-tvl-weighted",
    label: "Pool TVL-weighted",
    shortLabel: "Pool",
    maxTrustedAgeSec: 35 * 60,
    defaultWeight: 1,
    bypassesSoftValidationGuardrails: true,
  }),
  definePricingSource(PRICING_SOURCE_PRESETS.cachedReplay, {
    key: "cached",
    label: "Cached fallback",
    shortLabel: "Cached",
    maxTrustedAgeSec: null,
    defaultWeight: 0,
  }),
] as const satisfies readonly PricingSourceRegistryEntry[];
