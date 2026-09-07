import { describe, expect, it } from "vitest";
import { aggregateProtocolPrices, computeWeightedMedianPrice } from "../dex-price-estimators";

describe("computeWeightedMedianPrice", () => {
  it("preserves the lower discrete value at an exact half-weight boundary", () => {
    expect(computeWeightedMedianPrice([
      { price: 1.01, weight: 5 },
      { price: 0.99, weight: 5 },
    ])).toBe(0.99);
  });

  it("keeps price-domain filtering around the shared weighted median", () => {
    expect(computeWeightedMedianPrice([
      { price: -1, weight: 100 },
      { price: 1, weight: 0 },
      { price: 1.02, weight: 2 },
      { price: Number.NaN, weight: 50 },
    ])).toBe(1.02);
    expect(computeWeightedMedianPrice([])).toBeNull();
  });
});

describe("aggregateProtocolPrices", () => {
  it("aggregates pool-challenge observations by protocol and preserves representatives", () => {
    expect(aggregateProtocolPrices([
      {
        protocol: "curve",
        price: 0.79,
        tvl: 200_000,
        chain: "ethereum",
        observedAt: 1_700_000_020,
        poolAddress: "0xcurve-old",
        side: "base",
      },
      {
        protocol: "curve",
        price: 0.81,
        tvl: 200_000,
        chain: "base",
        observedAt: 1_700_000_010,
        poolAddress: "0xcurve-new",
        side: "quote",
      },
      {
        protocol: "uniswap",
        price: 0.84,
        tvl: 400_000,
        chain: "ethereum",
        observedAt: 1_700_000_030,
        poolAddress: "0xuniswap",
        side: "quote",
      },
      { protocol: "invalid", price: Number.NaN, tvl: 100_000 },
      { protocol: "invalid", price: 1, tvl: 0 },
    ])).toEqual([
      {
        protocol: "curve",
        price: 0.79,
        tvl: 400_000,
        chain: "multi",
        observedAt: 1_700_000_010,
        representativePoolAddress: "0xcurve-old",
        representativeSide: "base",
      },
      {
        protocol: "uniswap",
        price: 0.84,
        tvl: 400_000,
        chain: "ethereum",
        observedAt: 1_700_000_030,
        representativePoolAddress: "0xuniswap",
        representativeSide: "quote",
      },
    ]);
  });

  it("returns no groups when every pool observation is invalid", () => {
    expect(aggregateProtocolPrices([
      { protocol: "curve", price: Number.POSITIVE_INFINITY, tvl: 1 },
      { protocol: "uniswap", price: 1, tvl: Number.NEGATIVE_INFINITY },
    ])).toEqual([]);
  });
});
