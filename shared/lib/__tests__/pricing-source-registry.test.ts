import { describe, expect, it } from "vitest";
import {
  PRICING_SOURCE_REGISTRY,
  getPricingSourceRegistryEntry,
  isPricingSourceProtocolOverride,
  isPricingSourceSoftGuardrailExempt,
} from "../pricing-source-registry";
import {
  getPricingSourceLabel,
  getUnknownPricingSourceKeys,
  isKnownPricingSourceOrComposite,
  normalizePricingSourceKeys,
} from "../pricing-sources";

describe("pricing source registry", () => {
  it("keeps registry order stable", () => {
    expect(PRICING_SOURCE_REGISTRY.map((entry) => entry.key)).toEqual([
      "coingecko",
      "coingecko-low-volume",
      "coingecko-native-implied",
      "defillama",
      "defillama-list",
      "coingecko-mirror",
      "cg-ticker",
      "geckoterminal",
      "pyth",
      "binance",
      "kraken",
      "bitstamp",
      "coinbase",
      "redstone",
      "curve-onchain",
      "curve-oracle",
      "dex-promoted",
      "fluid-dex",
      "balancer-dex",
      "raydium-dex",
      "orca-dex",
      "meteora-dex",
      "pancakeswap-dex",
      "aerodrome-dex",
      "velodrome-dex",
      "jupiter",
      "coinmarketcap",
      "dexscreener-exact",
      "dexscreener-search",
      "defillama-contract",
      "protocol-redeem",
      "zephyr-scanner",
      "pool-tvl-weighted",
      "cached",
    ]);
  });

  it("preserves high-risk registry flags and defaults", () => {
    expect(getPricingSourceRegistryEntry("coingecko")).toMatchObject({
      key: "coingecko",
      trustTier: "soft_aggregator",
      freshnessKind: "upstream",
      isReplaySafe: true,
      canBeDepegAuthoritative: false,
      depegSourceFamily: "coingecko",
      defaultObservedAtMode: "local_fetch",
    });

    expect(getPricingSourceRegistryEntry("pyth")).toMatchObject({
      key: "pyth",
      trustTier: "hard_oracle",
      freshnessKind: "upstream",
      canBeDepegAuthoritative: true,
      canSingleSourceDepegAuthoritative: true,
      requiresObservedAt: true,
      depegSourceFamily: "oracle:pyth",
      defaultObservedAtMode: "upstream",
    });

    expect(getPricingSourceRegistryEntry("protocol-redeem")).toMatchObject({
      key: "protocol-redeem",
      isProtocolOverride: true,
      depegSourceFamily: "protocol:redeem",
      bypassesSoftValidationGuardrails: true,
      defaultObservedAtMode: "local_fetch",
    });

    expect(getPricingSourceRegistryEntry("zephyr-scanner")).toMatchObject({
      key: "zephyr-scanner",
      trustTier: "hard_protocol",
      canBeDepegAuthoritative: false,
      depegSourceFamily: "protocol:zephyr-scanner",
      defaultObservedAtMode: "local_fetch",
    });

    expect(getPricingSourceRegistryEntry("cached")).toMatchObject({
      key: "cached",
      maxTrustedAgeSec: null,
      defaultWeight: 0,
      isReplaySafe: false,
      defaultObservedAtMode: null,
    });

    expect(getPricingSourceRegistryEntry("dexscreener-exact")).toMatchObject({
      key: "dexscreener-exact",
      isSearchDerived: false,
    });

    expect(getPricingSourceRegistryEntry("dexscreener-search")).toMatchObject({
      key: "dexscreener-search",
      isSearchDerived: true,
    });

    expect(getPricingSourceRegistryEntry("coinmarketcap")).toMatchObject({
      key: "coinmarketcap",
      trustTier: "fallback_search",
      isListAggregator: true,
      canBeDepegAuthoritative: false,
      depegSourceFamily: "coinmarketcap",
    });

    expect(getPricingSourceRegistryEntry("defillama-contract")).toMatchObject({
      key: "defillama-contract",
      isListAggregator: true,
      canBeDepegAuthoritative: false,
      depegSourceFamily: "defillama",
    });
  });

  it("keeps helper predicates aligned with registry metadata", () => {
    expect(isPricingSourceProtocolOverride("protocol-redeem")).toBe(true);
    expect(isPricingSourceProtocolOverride("coingecko")).toBe(false);
    expect(isPricingSourceSoftGuardrailExempt("pool-tvl-weighted")).toBe(true);
    expect(isPricingSourceSoftGuardrailExempt("cached")).toBe(false);
    expect(isPricingSourceProtocolOverride(null)).toBe(false);
    expect(isPricingSourceSoftGuardrailExempt(undefined)).toBe(false);
  });

  it("normalizes composite source labels without treating them as unknown keys", () => {
    expect(normalizePricingSourceKeys("coingecko+geckoterminal")).toEqual(["coingecko", "geckoterminal"]);
    expect(getPricingSourceLabel("coingecko+geckoterminal")).toBe("CoinGecko + GeckoTerminal");
    expect(isKnownPricingSourceOrComposite("coingecko+geckoterminal")).toBe(true);
    expect(getUnknownPricingSourceKeys("coingecko+not-a-source")).toEqual(["not-a-source"]);
  });
});
