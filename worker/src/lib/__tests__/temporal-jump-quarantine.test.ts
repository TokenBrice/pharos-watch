import { describe, expect, it } from "vitest";
import { shouldWithholdTemporalJump } from "../price-publish-policy";
import type { PriceValidationContext } from "../price-validation";

const USD_CONTEXT: PriceValidationContext = {
  pegClass: "usd",
  pegType: "peggedUSD",
  navToken: false,
  tracked: true,
};

describe("shouldWithholdTemporalJump", () => {
  it("returns false when confidence=high with an authoritative agreement source", () => {
    // pyth is hardOracle → canBeDepegAuthoritative=true; confidence high bypasses
    // withholding despite a large 2100 bps move.
    const withheld = shouldWithholdTemporalJump({
      price: 0.79,
      source: "pyth",
      confidence: "high",
      agreeSources: ["pyth"],
      mode: "primary_authoritative",
      validationContext: USD_CONTEXT,
      previousTrustedPrice: {
        price: 1.0,
        source: "pyth",
        confidence: "high",
        observedAt: null,
        agreeSources: ["pyth"],
      },
    });
    expect(withheld).toBe(false);
  });

  it("returns false for soft-guardrail-exempt sources (pool-tvl-weighted)", () => {
    const withheld = shouldWithholdTemporalJump({
      price: 0.60,
      source: "pool-tvl-weighted",
      confidence: "low",
      agreeSources: ["pool-tvl-weighted"],
      mode: "primary_authoritative",
      validationContext: USD_CONTEXT,
      previousTrustedPrice: {
        price: 1.0,
        source: "pyth",
        confidence: "high",
        observedAt: null,
        agreeSources: ["pyth"],
      },
    });
    expect(withheld).toBe(false);
  });

  it("returns false when moveBps is below the 2000 bps threshold", () => {
    // 1.0 → 0.9 = ~1053 bps, below 2000 threshold
    const withheld = shouldWithholdTemporalJump({
      price: 0.9,
      source: "coingecko",
      confidence: "low",
      agreeSources: ["coingecko"],
      mode: "primary_authoritative",
      validationContext: USD_CONTEXT,
      previousTrustedPrice: {
        price: 1.0,
        source: "coingecko",
        confidence: "low",
        observedAt: null,
        agreeSources: ["coingecko"],
      },
    });
    expect(withheld).toBe(false);
  });

  it("returns true for uncorroborated curve-thin-onchain jumps", () => {
    const withheld = shouldWithholdTemporalJump({
      price: 0.7,
      source: "curve-thin-onchain",
      confidence: "fallback",
      agreeSources: ["curve-thin-onchain"],
      mode: "primary_authoritative",
      validationContext: USD_CONTEXT,
      previousTrustedPrice: {
        price: 1,
        source: "pyth",
        confidence: "high",
        observedAt: null,
        agreeSources: ["pyth"],
      },
    });
    expect(withheld).toBe(true);
  });

  it("returns true when moveBps is at/above the 2000 bps threshold and no bypass applies", () => {
    // 1.0 → 0.78 = ~2472 bps, above 2000 threshold.
    // Source is softAggregator (not authoritative), not guardrail-exempt, and 0.78 > 0.50
    // (NOT severe downside), so no bypass should apply.
    const withheld = shouldWithholdTemporalJump({
      price: 0.78,
      source: "coingecko",
      confidence: "low",
      agreeSources: ["coingecko"],
      mode: "primary_authoritative",
      validationContext: USD_CONTEXT,
      previousTrustedPrice: {
        price: 1.0,
        source: "coingecko",
        confidence: "low",
        observedAt: null,
        agreeSources: ["coingecko"],
      },
    });
    expect(withheld).toBe(true);
  });
});
