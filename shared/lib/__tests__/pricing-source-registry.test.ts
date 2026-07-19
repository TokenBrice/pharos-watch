import { describe, expect, it } from "vitest";
import {
  PRICING_SOURCE_REGISTRY,
  getPricingSourceRegistryEntry,
  isPricingSourceProtocolOverride,
  isPricingSourceSoftGuardrailExempt,
} from "../pricing-source-registry";
import { getPricingSourceLabel, normalizePricingSourceKeys } from "../pricing-sources";
import {
  countDepegAuthoritativeSources,
  getPriceCacheMaxAgeSec,
  hasDepegAuthoritativeSource,
  isPoolChallengeEligibleConsensus,
  isReplaySafePriceSource,
} from "../pricing-source-policy";

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
      "kava-pricefeed",
      "aerodrome-onchain",
      "velodrome-onchain",
      "curve-onchain",
      "curve-oracle",
      "chainlink-nav",
      "superstate-liquidity",
      "dex-promoted",
      "fluid-dex",
      "balancer-dex",
      "curve-dex",
      "curve-thin-onchain",
      "uniswap-v3-dex",
      "uniswap-v3-exact",
      "uniswap-v4-dex",
      "raydium-dex",
      "orca-dex",
      "meteora-dex",
      "pancakeswap-dex",
      "aerodrome-dex",
      "velodrome-dex",
      "jupiter",
      "coinmarketcap",
      "dexscreener-exact",
      "dexscreener-address",
      "dexpaprika-address",
      "alchemy-address",
      "moralis-address",
      "birdeye-address",
      "coingecko-onchain-address",
      "dexscreener-search",
      "defillama-contract",
      "protocol-redeem",
      "protocol-redeem-cached-rate",
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

    expect(getPricingSourceRegistryEntry("kava-pricefeed")).toMatchObject({
      key: "kava-pricefeed",
      trustTier: "hard_oracle",
      freshnessKind: "upstream",
      maxTrustedAgeSec: 30 * 60,
      isReplaySafe: true,
      canBeDepegAuthoritative: true,
      canSingleSourceDepegAuthoritative: true,
      isProtocolOverride: true,
      depegSourceFamily: "oracle:kava-pricefeed",
      defaultObservedAtMode: "upstream",
    });

    expect(countDepegAuthoritativeSources(["aerodrome-onchain+velodrome-onchain"])).toBe(2);
    expect(isReplaySafePriceSource("aerodrome-onchain+velodrome-onchain")).toBe(true);

    expect(getPricingSourceRegistryEntry("chainlink-nav")).toMatchObject({
      key: "chainlink-nav",
      trustTier: "hard_protocol",
      freshnessKind: "upstream",
      requiresObservedAt: true,
      depegSourceFamily: "protocol:chainlink-nav",
      defaultWeight: 3,
    });

    expect(getPricingSourceRegistryEntry("defillama-list")).toMatchObject({
      key: "defillama-list",
      trustTier: "soft_aggregator",
      requiresObservedAt: true,
      maxTrustedAgeSec: 15 * 60,
      defaultObservedAtMode: null,
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

    for (const key of [
      "dexscreener-address",
      "dexpaprika-address",
      "alchemy-address",
      "moralis-address",
      "birdeye-address",
      "coingecko-onchain-address",
    ]) {
      expect(getPricingSourceRegistryEntry(key)).toMatchObject({
        key,
        trustTier: "fallback_search",
        isReplaySafe: false,
        canBeDepegAuthoritative: false,
        canSingleSourceDepegAuthoritative: false,
        isSearchDerived: false,
      });
    }

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

    expect(getPricingSourceRegistryEntry("uniswap-v3-dex")).toMatchObject({
      key: "uniswap-v3-dex",
      trustTier: "soft_dex",
      depegSourceFamily: "dex:uniswap-v3",
      maxTrustedAgeSec: 35 * 60,
      defaultWeight: 2,
      requiresObservedAt: true,
    });

    expect(getPricingSourceRegistryEntry("uniswap-v3-exact")).toMatchObject({
      key: "uniswap-v3-exact",
      trustTier: "soft_dex",
      depegSourceFamily: "dex:uniswap-v3",
      maxTrustedAgeSec: 5 * 60,
      defaultWeight: 1,
      isReplaySafe: false,
      freshnessKind: "upstream",
      defaultObservedAtMode: "upstream",
      requiresObservedAt: true,
    });

    expect(getPricingSourceRegistryEntry("curve-thin-onchain")).toMatchObject({
      key: "curve-thin-onchain",
      trustTier: "soft_dex",
      depegSourceFamily: "dex:curve",
      maxTrustedAgeSec: 5 * 60,
      isReplaySafe: false,
      bypassesSoftValidationGuardrails: true,
    });

    expect(getPricingSourceRegistryEntry("uniswap-v4-dex")).toMatchObject({
      key: "uniswap-v4-dex",
      trustTier: "soft_dex",
      depegSourceFamily: "dex:uniswap-v4",
      maxTrustedAgeSec: 35 * 60,
      defaultWeight: 2,
      requiresObservedAt: true,
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

  it("normalizes composite source labels", () => {
    expect(normalizePricingSourceKeys("coingecko+geckoterminal")).toEqual(["coingecko", "geckoterminal"]);
    expect(getPricingSourceLabel("coingecko+geckoterminal")).toBe("CoinGecko + GeckoTerminal");
  });

  it("keeps shared policy helpers aligned with registry metadata", () => {
    for (const entry of PRICING_SOURCE_REGISTRY) {
      expect(isReplaySafePriceSource(entry.key), entry.key).toBe(entry.isReplaySafe);
      expect(isPoolChallengeEligibleConsensus([entry.key]), entry.key).toBe(!entry.isPoolChallengeExempt);
    }

    expect(isReplaySafePriceSource(null)).toBe(false);
    expect(isPoolChallengeEligibleConsensus([])).toBe(false);
    expect(isPoolChallengeEligibleConsensus(["not-a-source"])).toBe(false);
  });

  it("expands composite source labels before applying shared policy", () => {
    expect(getPriceCacheMaxAgeSec("coingecko+pyth", 6 * 3600)).toBe(5 * 60);
    expect(getPriceCacheMaxAgeSec("coingecko+not-a-source", 6 * 3600)).toBe(0);
    // Replay-safe-core semantics: an agreeing non-replay-safe corroborator
    // does not zero the composite window, while core-less and cached labels
    // still never replay.
    expect(getPriceCacheMaxAgeSec("coingecko+coingecko-onchain-address+pyth", 6 * 3600)).toBe(5 * 60);
    expect(getPriceCacheMaxAgeSec("coingecko-onchain-address", 6 * 3600)).toBe(0);
    expect(getPriceCacheMaxAgeSec("coingecko+cached", 6 * 3600)).toBe(0);
    expect(hasDepegAuthoritativeSource(["coingecko+geckoterminal"])).toBe(false);
    expect(countDepegAuthoritativeSources(["coingecko+pyth"])).toBe(1);
    expect(isPoolChallengeEligibleConsensus(["coingecko+geckoterminal"])).toBe(true);
  });
});
