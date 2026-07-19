import { describe, expect, it } from "vitest";

import { hasPublishableCurrentPrice } from "../price-publication-state";

describe("price-publication-state", () => {
  it("requires a positive finite price, publishable source, and timestamp provenance", () => {
    expect(hasPublishableCurrentPrice({
      price: 1,
      priceSource: "coingecko",
      priceObservedAt: 1_800_000_000,
    })).toBe(true);

    expect(hasPublishableCurrentPrice({
      price: 0,
      priceSource: "coingecko",
      priceObservedAt: 1_800_000_000,
    })).toBe(false);

    expect(hasPublishableCurrentPrice({
      price: Number.NaN,
      priceSource: "coingecko",
      priceObservedAt: 1_800_000_000,
    })).toBe(false);

    expect(hasPublishableCurrentPrice({
      price: 1,
      priceSource: "missing",
      priceObservedAt: 1_800_000_000,
    })).toBe(false);

    expect(hasPublishableCurrentPrice({
      price: 1,
      priceSource: "coingecko",
    })).toBe(false);
  });

  it("accepts backup publication timestamps when the observed timestamp is absent", () => {
    expect(hasPublishableCurrentPrice({
      price: 1,
      priceSource: "coingecko-onchain-address",
      priceUpdatedAt: 1_800_000_000,
    })).toBe(true);

    expect(hasPublishableCurrentPrice({
      price: 1,
      priceSource: "dexpaprika-address",
      priceSyncedAt: 1_800_000_001,
    })).toBe(true);
  });
});
