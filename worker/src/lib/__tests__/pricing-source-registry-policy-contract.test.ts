import { describe, expect, it } from "vitest";
import { PRICING_SOURCE_REGISTRY } from "@shared/lib/pricing-source-registry";
import {
  countDepegAuthoritativeSources,
  getPriceCacheMaxAgeSec,
  hasDepegAuthoritativeSource,
  isPoolChallengeEligibleConsensus,
  isReplaySafePriceSource,
} from "../pricing-source-policy";

/**
 * Contract: the pricing-source registry is the single source of truth for
 * per-source policy. The runtime predicates in pricing-source-policy.ts
 * must round-trip the registry flags for every entry. If a flag changes
 * without an accompanying predicate update (or vice versa) this test fails.
 */
describe("pricing-source registry ↔ policy contract", () => {
  it("isReplaySafePriceSource mirrors registry.isReplaySafe for every entry", () => {
    for (const entry of PRICING_SOURCE_REGISTRY) {
      expect(isReplaySafePriceSource(entry.key)).toBe(entry.isReplaySafe);
    }
  });

  it("isPoolChallengeEligibleConsensus mirrors !registry.isPoolChallengeExempt for every single-source entry", () => {
    for (const entry of PRICING_SOURCE_REGISTRY) {
      expect(isPoolChallengeEligibleConsensus([entry.key])).toBe(!entry.isPoolChallengeExempt);
    }
  });

  it("treats unknown / falsy sources as non-replay-safe and non-eligible", () => {
    expect(isReplaySafePriceSource(null)).toBe(false);
    expect(isReplaySafePriceSource(undefined)).toBe(false);
    expect(isReplaySafePriceSource("dexscreener-search")).toBe(false);
    expect(isPoolChallengeEligibleConsensus([])).toBe(false);
    expect(isPoolChallengeEligibleConsensus(["not-a-source"])).toBe(false);
  });

  it("uses the strictest component freshness for replay-cache composite sources", () => {
    expect(getPriceCacheMaxAgeSec("coingecko+pyth", 6 * 3600)).toBe(5 * 60);
    expect(getPriceCacheMaxAgeSec("bitstamp+coinbase", 6 * 3600)).toBe(10 * 60);
    expect(getPriceCacheMaxAgeSec("coingecko+not-a-source", 6 * 3600)).toBe(0);
    expect(getPriceCacheMaxAgeSec(null, 6 * 3600)).toBe(6 * 3600);
  });

  it("expands composite source labels before applying authority and pool-challenge policy", () => {
    expect(hasDepegAuthoritativeSource(["coingecko+geckoterminal"])).toBe(false);
    expect(countDepegAuthoritativeSources(["coingecko+pyth"])).toBe(1);
    expect(isPoolChallengeEligibleConsensus(["coingecko+pyth"])).toBe(false);
    expect(isPoolChallengeEligibleConsensus(["coingecko+geckoterminal"])).toBe(true);
  });

  it("keeps fallback/search lanes non-authoritative", () => {
    const fallbackEntries = PRICING_SOURCE_REGISTRY.filter((entry) => entry.trustTier === "fallback_search");
    expect(fallbackEntries.map((entry) => entry.key).sort()).toEqual([
      "coinmarketcap",
      "dexscreener-exact",
      "dexscreener-search",
      "jupiter",
    ]);

    for (const entry of fallbackEntries) {
      expect(entry.canBeDepegAuthoritative, entry.key).toBe(false);
      expect(entry.canSingleSourceDepegAuthoritative, entry.key).toBe(false);
      expect(hasDepegAuthoritativeSource([entry.key]), entry.key).toBe(false);
    }
  });
});
