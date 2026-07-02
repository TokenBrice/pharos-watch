import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchCurrentNativePegQuotesMock = vi.fn();

vi.mock("../native-peg-quotes", () => ({
  fetchCurrentNativePegQuotes: (...args: unknown[]) => fetchCurrentNativePegQuotesMock(...args),
}));

import {
  computePriceDivergenceBps,
  fetchCurrentNativePegImpliedUsdQuotes,
} from "../native-peg-implied-prices";

describe("native-peg-implied-prices", () => {
  beforeEach(() => {
    fetchCurrentNativePegQuotesMock.mockReset();
  });

  it("derives USD prices from fresh native quotes and fresh FX references", async () => {
    fetchCurrentNativePegQuotesMock.mockResolvedValue(new Map([
      ["eurc-circle", {
        stablecoinId: "eurc-circle",
        geckoId: "euro-coin",
        pegCurrency: "EUR",
        vsCurrency: "eur",
        price: 1.0012,
        updatedAt: 1_700_000_000,
      }],
    ]));

    const quotes = await fetchCurrentNativePegImpliedUsdQuotes(
      [{
        stablecoinId: "eurc-circle",
        geckoId: "euro-coin",
        pegCurrency: "EUR",
        pegType: "peggedEUR",
      }],
      {
        rates: { peggedEUR: 1.08 },
        type: "fresh",
        typeByPeg: { peggedEUR: "fresh" },
      },
    );

    expect(quotes.get("eurc-circle")).toMatchObject({
      stablecoinId: "eurc-circle",
      pegCurrency: "EUR",
      nativePrice: 1.0012,
      priceUsd: 1.0012 * 1.08,
      referencePriceUsd: 1.08,
      referenceType: "fresh",
    });
  });

  it("skips native-implied USD derivation when the FX reference is stale", async () => {
    fetchCurrentNativePegQuotesMock.mockResolvedValue(new Map([
      ["brz-transfero", {
        stablecoinId: "brz-transfero",
        geckoId: "brz",
        pegCurrency: "BRL",
        vsCurrency: "brl",
        price: 0.998,
        updatedAt: 1_700_000_000,
      }],
    ]));

    const quotes = await fetchCurrentNativePegImpliedUsdQuotes(
      [{
        stablecoinId: "brz-transfero",
        geckoId: "brz",
        pegCurrency: "BRL",
        pegType: "peggedREAL",
      }],
      {
        rates: { peggedREAL: 0.194 },
        type: "stale",
        typeByPeg: { peggedREAL: "stale" },
      },
    );

    expect(quotes.size).toBe(0);
  });

  it("computes symmetric divergence in basis points", () => {
    expect(computePriceDivergenceBps(1.08, 1.081)).toBe(9);
    expect(computePriceDivergenceBps(1.081, 1.08)).toBe(9);
    expect(computePriceDivergenceBps(0, 1.08)).toBeNull();
    expect(computePriceDivergenceBps(Number.POSITIVE_INFINITY, 1.08)).toBeNull();
    expect(computePriceDivergenceBps(Number.MAX_VALUE, Number.MAX_VALUE)).toBeNull();
  });
});
