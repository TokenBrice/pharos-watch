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
  it("retrieves every registry entry by its own key", () => {
    for (const entry of PRICING_SOURCE_REGISTRY) {
      expect(getPricingSourceRegistryEntry(entry.key)).toBe(entry);
      expect(entry.depegSourceFamily.trim()).not.toBe("");
    }
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
