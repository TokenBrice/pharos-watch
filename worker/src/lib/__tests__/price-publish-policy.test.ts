import { describe, it, expect } from "vitest";
import { validateFallbackPriceCandidate, validatePrimaryPriceCandidate } from "../price-publish-policy";
import type { PriceValidationContext } from "../price-validation";

const USD_CONTEXT: PriceValidationContext = {
  pegClass: "usd",
  pegType: "peggedUSD",
  navToken: false,
  tracked: true,
};

describe("validatePrimaryPriceCandidate — severe downside with directional corroboration", () => {
  it("rejects severe downside with single source and no corroboration", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.38,
      source: "pyth",
      confidence: "low",
      agreeSources: ["pyth"],
      validationContext: USD_CONTEXT,
    });
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe("severe_downside_requires_corroboration");
  });

  it("accepts severe downside when 2+ candidate sources confirm severe downside", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.38,
      source: "pyth",
      confidence: "low",
      agreeSources: ["pyth"],
      candidatePrices: { coingecko: 0.39, pyth: 0.38, "defillama-list": 0.51 },
      validationContext: USD_CONTEXT,
    });
    // coingecko 0.39 < 0.50 and pyth 0.38 < 0.50 → 2 severe → accepted
    expect(decision.accepted).toBe(true);
  });

  it("rejects severe downside when only correlated list aggregators corroborate", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.38,
      source: "coingecko+defillama-list",
      confidence: "low",
      agreeSources: ["coingecko", "defillama-list"],
      candidatePrices: { coingecko: 0.39, "defillama-list": 0.38 },
      validationContext: USD_CONTEXT,
    });

    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe("severe_downside_requires_corroboration");
  });

  it("accepts corroborated severe downside despite a large jump from previous trusted price", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.1525,
      source: "coingecko+defillama-list",
      confidence: "low",
      agreeSources: ["coingecko", "defillama-list"],
      candidatePrices: {
        coingecko: 0.1525,
        "defillama-list": 0.1524,
        pyth: 0.151,
        "dex-promoted": 1.0007,
      },
      validationContext: USD_CONTEXT,
      previousTrustedPrice: {
        price: 1.0007,
        source: "pyth",
        confidence: "high",
        observedAt: null,
        agreeSources: ["pyth"],
      },
    });
    expect(decision.accepted).toBe(true);
  });

  it("rejects severe downside when only 1 candidate source is in severe downside", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.45,
      source: "pyth",
      confidence: "low",
      agreeSources: ["pyth"],
      candidatePrices: { coingecko: 0.92, pyth: 0.45 },
      validationContext: USD_CONTEXT,
    });
    // only pyth 0.45 < 0.50 → 1 severe → rejected
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe("severe_downside_requires_corroboration");
  });

  it("still allows exempt sources without candidatePrices", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.30,
      source: "pool-tvl-weighted",
      confidence: "low",
      agreeSources: ["pool-tvl-weighted"],
      validationContext: USD_CONTEXT,
    });
    expect(decision.accepted).toBe(true);
  });

  it("still allows high confidence with 2+ agree sources", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.35,
      source: "coingecko+pyth",
      confidence: "high",
      agreeSources: ["coingecko", "pyth"],
      validationContext: USD_CONTEXT,
    });
    expect(decision.accepted).toBe(true);
  });

  it("still allows when previous trusted price was also severe downside", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.38,
      source: "pyth",
      confidence: "low",
      agreeSources: ["pyth"],
      validationContext: USD_CONTEXT,
      previousTrustedPrice: {
        price: 0.40,
        source: "coingecko",
        confidence: "low",
        observedAt: null,
        agreeSources: ["coingecko"],
      },
    });
    expect(decision.accepted).toBe(true);
  });

  it("does not trigger directional corroboration for non-severe prices", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.85,
      source: "pyth",
      confidence: "low",
      agreeSources: ["pyth"],
      candidatePrices: { coingecko: 0.30, pyth: 0.85 },
      validationContext: USD_CONTEXT,
    });
    // price 0.85 is NOT severe downside, so the check doesn't trigger at all
    expect(decision.accepted).toBe(true);
  });
});

describe("validatePrimaryPriceCandidate — weak fallback fixed-peg depegs", () => {
  it("rejects a depeg-sized single-source address-provider quote", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.9459920248,
      source: "coingecko-onchain-address",
      confidence: "single-source",
      agreeSources: ["coingecko-onchain-address"],
      validationContext: USD_CONTEXT,
    });

    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe("weak_fallback_depeg_requires_corroboration");
  });

  it("still accepts a near-peg address-provider quote", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.99967,
      source: "coingecko-onchain-address",
      confidence: "single-source",
      agreeSources: ["coingecko-onchain-address"],
      validationContext: USD_CONTEXT,
    });

    expect(decision.accepted).toBe(true);
  });

  it("does not block exact DefiLlama contract fallback prices", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.9459920248,
      source: "defillama-contract",
      confidence: "single-source",
      agreeSources: ["defillama-contract"],
      validationContext: USD_CONTEXT,
    });

    expect(decision.accepted).toBe(true);
  });

  it("allows depeg-sized hard-source quotes", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.9459920248,
      source: "pyth",
      confidence: "single-source",
      agreeSources: ["pyth"],
      validationContext: USD_CONTEXT,
    });

    expect(decision.accepted).toBe(true);
  });

  it("accepts a severe exact-address fallback corroborated by a same-run independent quote", () => {
    const decision = validateFallbackPriceCandidate({
      price: 0.3904,
      source: "dexscreener-exact",
      confidence: "fallback",
      agreeSources: ["dexscreener-exact"],
      candidatePrices: {
        coingecko: 0.390247,
        "dexscreener-exact": 0.3904,
      },
      validationContext: USD_CONTEXT,
    });

    expect(decision.accepted).toBe(true);
  });

  it("still rejects severe fallback evidence from list aggregators only", () => {
    const decision = validateFallbackPriceCandidate({
      price: 0.3904,
      source: "coinmarketcap",
      confidence: "fallback",
      agreeSources: ["coinmarketcap"],
      candidatePrices: {
        coingecko: 0.390247,
        "defillama-list": 0.3903,
        coinmarketcap: 0.3904,
      },
      validationContext: USD_CONTEXT,
    });

    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe("severe_downside_requires_corroboration");
  });

  it("does not use severe candidate evidence to admit a non-severe fallback quote", () => {
    const decision = validateFallbackPriceCandidate({
      price: 0.94,
      source: "dexscreener-exact",
      confidence: "fallback",
      agreeSources: ["dexscreener-exact"],
      candidatePrices: {
        coingecko: 0.390247,
        pyth: 0.3904,
        "dexscreener-exact": 0.94,
      },
      validationContext: USD_CONTEXT,
    });

    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe("weak_fallback_depeg_requires_corroboration");
  });
});
