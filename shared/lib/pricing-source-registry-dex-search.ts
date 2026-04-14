import type { PricingSourceRegistryEntry } from "./pricing-source-registry-types";
import { definePricingSource, PRICING_SOURCE_PRESETS } from "./pricing-source-registry-presets";

export const PRICING_SOURCE_REGISTRY_DEX_SEARCH = [
  definePricingSource(PRICING_SOURCE_PRESETS.softDex, {
    key: "dex-promoted",
    label: "DEX prices",
    shortLabel: "DEX",
    maxTrustedAgeSec: 35 * 60,
    defaultWeight: 1,
  }),
  definePricingSource(PRICING_SOURCE_PRESETS.softDex, {
    key: "fluid-dex",
    label: "Fluid",
    shortLabel: "Fluid",
    maxTrustedAgeSec: 35 * 60,
    defaultWeight: 3,
  }),
  definePricingSource(PRICING_SOURCE_PRESETS.softDex, {
    key: "balancer-dex",
    label: "Balancer",
    shortLabel: "Balancer",
    maxTrustedAgeSec: 35 * 60,
    defaultWeight: 3,
  }),
  definePricingSource(PRICING_SOURCE_PRESETS.softDex, {
    key: "raydium-dex",
    label: "Raydium",
    shortLabel: "Raydium",
    maxTrustedAgeSec: 35 * 60,
    defaultWeight: 2,
  }),
  definePricingSource(PRICING_SOURCE_PRESETS.softDex, {
    key: "orca-dex",
    label: "Orca",
    shortLabel: "Orca",
    maxTrustedAgeSec: 35 * 60,
    defaultWeight: 2,
  }),
  definePricingSource(PRICING_SOURCE_PRESETS.fallbackSearch, {
    key: "jupiter",
    label: "Jupiter",
    shortLabel: "Jupiter",
    maxTrustedAgeSec: 15 * 60,
    defaultWeight: 1,
  }),
  definePricingSource(PRICING_SOURCE_PRESETS.fallbackSearch, {
    key: "coinmarketcap",
    label: "CoinMarketCap",
    shortLabel: "CMC",
    maxTrustedAgeSec: 60 * 60,
    defaultWeight: 1,
  }),
  definePricingSource(PRICING_SOURCE_PRESETS.fallbackSearch, {
    key: "dexscreener",
    label: "DexScreener",
    shortLabel: "DexScreener",
    maxTrustedAgeSec: 15 * 60,
    defaultWeight: 1,
  }),
] as const satisfies readonly PricingSourceRegistryEntry[];
