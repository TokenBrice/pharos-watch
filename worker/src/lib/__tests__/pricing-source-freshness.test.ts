import { describe, expect, it } from "vitest";
import {
  validateCompositePricingSourceFreshness,
  validatePricingSourceFreshness,
} from "../pricing-source-freshness";

describe("pricing source freshness", () => {
  it("accepts a fresh upstream-observed CEX source", () => {
    const decision = validatePricingSourceFreshness({
      source: "coinbase",
      observedAt: 1_800_000_000,
      nowSec: 1_800_000_120,
    });

    expect(decision).toEqual({
      accepted: true,
      observedAt: 1_800_000_000,
      observedAtMode: "upstream",
    });
  });

  it("rejects stale and future-skewed timestamps using registry source windows", () => {
    expect(validatePricingSourceFreshness({
      source: "bitstamp",
      observedAt: 1_799_999_000,
      nowSec: 1_800_000_000,
    })).toMatchObject({
      accepted: false,
      reason: "stale_observed_at",
      maxAgeSec: 600,
    });

    expect(validatePricingSourceFreshness({
      source: "pyth",
      observedAt: 1_800_001_000,
      nowSec: 1_800_000_000,
    })).toMatchObject({
      accepted: false,
      reason: "future_observed_at",
      maxFutureSkewSec: 600,
    });
  });

  it("requires observed-at metadata for sources whose registry default is upstream", () => {
    expect(validatePricingSourceFreshness({
      source: "coinbase",
      observedAt: null,
      nowSec: 1_800_000_000,
    })).toMatchObject({
      accepted: false,
      reason: "missing_observed_at",
    });
  });

  it("validates every component of composite source labels against the strictest component", () => {
    expect(validateCompositePricingSourceFreshness({
      source: "coingecko+pyth",
      observedAt: 1_799_999_650,
      observedAtMode: "upstream",
      nowSec: 1_800_000_000,
      requireObservedAt: true,
    })).toMatchObject({
      accepted: false,
      reason: "stale_observed_at",
      source: "pyth",
      maxAgeSec: 300,
    });
  });
});
