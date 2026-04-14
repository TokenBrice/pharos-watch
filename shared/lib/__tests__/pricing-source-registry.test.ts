import { describe, expect, it } from "vitest";
import {
  PRICING_SOURCE_REGISTRY,
  getPricingSourceRegistryEntry,
  isPricingSourceProtocolOverride,
  isPricingSourceSoftGuardrailExempt,
} from "../pricing-source-registry";

describe("pricing source registry", () => {
  it("keeps registry order stable", () => {
    expect(PRICING_SOURCE_REGISTRY.map((entry) => entry.key)).toEqual([
      "coingecko",
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
      "jupiter",
      "coinmarketcap",
      "dexscreener",
      "defillama-contract",
      "protocol-redeem",
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
      defaultObservedAtMode: "local_fetch",
    });

    expect(getPricingSourceRegistryEntry("pyth")).toMatchObject({
      key: "pyth",
      trustTier: "hard_oracle",
      freshnessKind: "upstream",
      canBeDepegAuthoritative: true,
      canSingleSourceDepegAuthoritative: true,
      requiresObservedAt: true,
      defaultObservedAtMode: "upstream",
    });

    expect(getPricingSourceRegistryEntry("protocol-redeem")).toMatchObject({
      key: "protocol-redeem",
      isProtocolOverride: true,
      bypassesSoftValidationGuardrails: true,
      defaultObservedAtMode: "local_fetch",
    });

    expect(getPricingSourceRegistryEntry("cached")).toMatchObject({
      key: "cached",
      maxTrustedAgeSec: null,
      defaultWeight: 0,
      isReplaySafe: false,
      defaultObservedAtMode: null,
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
});
