import type { PricingSourceRegistryEntry } from "./pricing-source-registry-types";
import { definePricingSource, PRICING_SOURCE_PRESETS } from "./pricing-source-registry-presets";

export const PRICING_SOURCE_REGISTRY_AGGREGATORS = [
  definePricingSource(PRICING_SOURCE_PRESETS.softAggregator, {
    key: "coingecko",
    label: "CoinGecko",
    shortLabel: "CG",
    freshnessKind: "upstream",
    maxTrustedAgeSec: 15 * 60,
    defaultWeight: 2,
    isGtProbeEligible: true,
    isListAggregator: true,
    supportsUpstreamObservedAt: true,
    capabilities: {
      hasUpstreamTimestamp: true,
    },
  }),
  definePricingSource(PRICING_SOURCE_PRESETS.softAggregator, {
    key: "coingecko-native-implied",
    label: "CoinGecko native+FX",
    shortLabel: "CG native",
    maxTrustedAgeSec: 15 * 60,
    defaultWeight: 1,
    isReplaySafe: false,
  }),
  definePricingSource(PRICING_SOURCE_PRESETS.softAggregator, {
    key: "defillama",
    label: "DefiLlama",
    shortLabel: "DL",
    freshnessKind: "unknown",
    maxTrustedAgeSec: 15 * 60,
    defaultWeight: 1,
    isListAggregator: true,
    defaultObservedAtMode: null,
  }),
  definePricingSource(PRICING_SOURCE_PRESETS.softAggregator, {
    key: "defillama-list",
    label: "DefiLlama (list)",
    shortLabel: "DL-list",
    freshnessKind: "unknown",
    maxTrustedAgeSec: 15 * 60,
    defaultWeight: 1,
    isGtProbeEligible: true,
    isListAggregator: true,
    defaultObservedAtMode: null,
  }),
  definePricingSource(PRICING_SOURCE_PRESETS.softAggregator, {
    key: "coingecko-mirror",
    label: "CoinGecko mirror",
    shortLabel: "CG-mirror",
    maxTrustedAgeSec: 15 * 60,
    defaultWeight: 1,
  }),
] as const satisfies readonly PricingSourceRegistryEntry[];
