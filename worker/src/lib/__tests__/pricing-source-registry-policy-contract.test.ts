import { describe, expect, it } from "vitest";
import { PRICING_SOURCE_REGISTRY } from "@shared/lib/pricing-source-registry";
import {
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
  });
});
