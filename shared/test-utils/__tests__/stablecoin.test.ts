import { describe, expect, it } from "vitest";
import { makeStablecoin, makeStablecoinMeta } from "../stablecoin";

describe("makeStablecoin", () => {
  it("uses deterministic neutral defaults", () => {
    expect(makeStablecoin()).toMatchObject({
      id: "usdc-circle",
      priceSource: "test",
      priceUpdatedAt: null,
      priceObservedAt: null,
      priceSyncedAt: null,
    });
  });

  it("keeps the default supply bucket aligned with an overridden peg type", () => {
    expect(makeStablecoin({ pegType: "peggedEUR" }).circulating).toEqual({ peggedEUR: 1_000_000 });
  });
});

describe("makeStablecoinMeta", () => {
  it("provides a complete typed identity while preserving overrides", () => {
    expect(makeStablecoinMeta({ id: "fixture", symbol: "FXT" })).toMatchObject({
      id: "fixture",
      name: "Test Coin",
      symbol: "FXT",
      flags: { pegCurrency: "USD" },
    });
  });
});
