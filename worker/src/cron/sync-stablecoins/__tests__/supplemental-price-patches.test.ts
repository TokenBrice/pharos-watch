import { describe, expect, it } from "vitest";
import type { PeggedAsset } from "../enrich-prices-shared";
import { applySupplementalPricePatches } from "../shared";

function asset(input: Partial<PeggedAsset> & Pick<PeggedAsset, "id" | "symbol">): PeggedAsset {
  return {
    name: input.symbol,
    circulating: { peggedUSD: 1_000_000 },
    ...input,
  } as PeggedAsset;
}

describe("applySupplementalPricePatches", () => {
  it("patches missing primary prices from supplemental low-volume CoinGecko rows", () => {
    const primary = asset({
      id: "usp-pareto-credit",
      symbol: "USP",
      price: null,
      priceSource: "defillama",
      priceConfidence: null,
      supplySource: "defillama",
      circulating: { peggedUSD: 2_000_000 },
    });
    const supplemental = asset({
      id: "usp-pareto-credit",
      symbol: "USP",
      price: 0.911,
      priceSource: "coingecko-low-volume",
      priceConfidence: "fallback",
      priceUpdatedAt: 1_778_435_542,
      priceObservedAt: 1_778_435_542,
      priceObservedAtMode: "upstream",
      priceSyncedAt: 1_778_600_000,
      supplySource: "coingecko-fallback",
      circulating: { peggedUSD: 1_900_000 },
    });

    const result = applySupplementalPricePatches([primary], [supplemental]);

    expect(result).toEqual({
      patchedCount: 1,
      patchedIds: ["usp-pareto-credit"],
    });
    expect(primary).toMatchObject({
      price: 0.911,
      priceSource: "coingecko-low-volume",
      priceSelectedSource: "coingecko-low-volume",
      priceConfidence: "fallback",
      priceUpdatedAt: 1_778_435_542,
      priceObservedAt: 1_778_435_542,
      priceObservedAtMode: "upstream",
      priceSyncedAt: 1_778_600_000,
      supplySource: "defillama",
      circulating: { peggedUSD: 2_000_000 },
      consensusSources: ["coingecko-low-volume"],
      agreeSources: ["coingecko-low-volume"],
    });
  });

  it("does not overwrite primary prices that are already present", () => {
    const primary = asset({
      id: "tryb-bilira",
      symbol: "TRYB",
      price: 0.022,
      priceSource: "defillama-list",
      priceConfidence: "single-source",
      supplySource: "defillama",
    });
    const supplemental = asset({
      id: "tryb-bilira",
      symbol: "TRYB",
      price: 0.023,
      priceSource: "coingecko-low-volume",
      priceConfidence: "fallback",
    });

    const result = applySupplementalPricePatches([primary], [supplemental]);

    expect(result).toEqual({ patchedCount: 0, patchedIds: [] });
    expect(primary).toMatchObject({
      price: 0.022,
      priceSource: "defillama-list",
      priceConfidence: "single-source",
      supplySource: "defillama",
    });
  });

  it("ignores supplemental rows without a publishable price", () => {
    const primary = asset({
      id: "cadd-cad-digital",
      symbol: "CADD",
      price: null,
      priceSource: "defillama",
      supplySource: "defillama",
    });
    const supplemental = asset({
      id: "cadd-cad-digital",
      symbol: "CADD",
      price: null,
      priceSource: "missing",
      priceConfidence: null,
    });

    const result = applySupplementalPricePatches([primary], [supplemental]);

    expect(result).toEqual({ patchedCount: 0, patchedIds: [] });
    expect(primary).toMatchObject({
      price: null,
      priceSource: "defillama",
      supplySource: "defillama",
    });
  });
});
