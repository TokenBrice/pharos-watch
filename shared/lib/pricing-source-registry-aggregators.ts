import type { PricingSourceRegistryEntry } from "./pricing-source-registry-types";
import { definePricingSource, PRICING_SOURCE_PRESETS } from "./pricing-source-registry-presets";

export const PRICING_SOURCE_REGISTRY_AGGREGATORS = [
  definePricingSource(PRICING_SOURCE_PRESETS.softAggregator, {
    key: "coingecko",
    label: "CoinGecko",
    shortLabel: "CG",
    depegSourceFamily: "coingecko",
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
  // Relaxed-freshness CoinGecko lane for low-volume CG-only stablecoins
  // (detailProvider="coingecko" with no DefiLlama listing). The standard
  // `coingecko` 15-min gate rejects their legitimate but slow-updating
  // upstream timestamps; this source preserves attribution while accepting
  // older quotes inside `fetchFiatCoinGeckoTokens` only.
  definePricingSource(PRICING_SOURCE_PRESETS.softAggregator, {
    key: "coingecko-low-volume",
    label: "CoinGecko (low volume)",
    shortLabel: "CG-lv",
    depegSourceFamily: "coingecko",
    freshnessKind: "upstream",
    maxTrustedAgeSec: 7 * 24 * 60 * 60,
    defaultWeight: 0.5,
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
    depegSourceFamily: "coingecko",
    maxTrustedAgeSec: 15 * 60,
    defaultWeight: 1,
    isReplaySafe: false,
  }),
  definePricingSource(PRICING_SOURCE_PRESETS.softAggregator, {
    key: "defillama",
    label: "DefiLlama",
    shortLabel: "DL",
    depegSourceFamily: "defillama",
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
    depegSourceFamily: "defillama",
    freshnessKind: "unknown",
    maxTrustedAgeSec: 15 * 60,
    defaultWeight: 1,
    isGtProbeEligible: true,
    isListAggregator: true,
    requiresObservedAt: true,
    defaultObservedAtMode: null,
  }),
  definePricingSource(PRICING_SOURCE_PRESETS.softAggregator, {
    key: "coingecko-mirror",
    label: "CoinGecko mirror",
    shortLabel: "CG-mirror",
    depegSourceFamily: "coingecko",
    maxTrustedAgeSec: 15 * 60,
    defaultWeight: 1,
    isListAggregator: true,
  }),
] as const satisfies readonly PricingSourceRegistryEntry[];
