import { describe, expect, it } from "vitest";

import { derivePegRates, getPegReference } from "@shared/lib/peg-rates";
import type { PegAssetBase, StablecoinMeta } from "@shared/types";

function asset(
  id: string,
  pegType: string,
  price: number,
  circulatingUsd: number,
): PegAssetBase {
  return {
    id,
    symbol: id.toUpperCase(),
    pegType,
    price,
    circulating: {
      peggedUSD: circulatingUsd,
    },
  };
}

describe("derivePegRates", () => {
  it("computes the median for three candidates in a peg bucket", () => {
    const result = derivePegRates([
      asset("coin-a", "peggedUSD", 0.999, 2_000_000),
      asset("coin-b", "peggedUSD", 1.001, 2_000_000),
      asset("coin-c", "peggedUSD", 1.0, 2_000_000),
    ]);

    expect(result.rates["peggedUSD"]).toBe(1);
    expect(result.rates["peggedUSD"]!).toEqual(expect.any(Number));
    expect(result.sources["peggedUSD"]).toBe("median");
  });

  it("excludes < $1m supply assets when computing medians", () => {
    const result = derivePegRates([
      asset("thin-a", "peggedEUR", 0.98, 500_000),
      asset("thin-b", "peggedEUR", 1.02, 250_000),
    ]);

    expect(result.rates.peggedEUR).toBeUndefined();
    expect(result.sources.peggedEUR).toBeUndefined();
  });

  it("uses the single price when only one eligible coin exists", () => {
    const result = derivePegRates([asset("solo", "peggedGBP", 1.234, 2_000_000)]);

    expect(result.rates.peggedGBP).toBe(1.234);
    expect(result.sources.peggedGBP).toBe("median");
  });

  it("does not add a rate for an empty peg group", () => {
    const result = derivePegRates([], new Map(), {});

    expect(result.rates.peggedUSD).toBe(1);
    expect(result.rates.peggedEUR).toBeUndefined();
    expect(result.sources.peggedEUR).toBeUndefined();
  });

  it("uses fallback rates for empty peg groups", () => {
    const result = derivePegRates([], new Map(), { peggedTRY: 0.022417 });

    expect(result.rates.peggedTRY).toBe(0.022417);
    expect(result.sources.peggedTRY).toBe("fallback");
    expect(result.counts.peggedTRY).toBe(0);
  });

  it("normalizes gold to per-ounce before median derivation", () => {
    const gramOz = 1 / 31.1034768;
    const metalMeta = new Map<string, StablecoinMeta>([
      [
        "gold-token",
        {
          id: "gold-token",
          name: "Gold Token",
          symbol: "GOLD",
          flags: {
            backing: "crypto-backed",
            pegCurrency: "GOLD",
            governance: "centralized",
            yieldBearing: false,
            rwa: true,
            navToken: false,
          },
          commodityOunces: gramOz,
        } as StablecoinMeta,
      ],
    ]);

    const result = derivePegRates(
      [asset("gold-token", "peggedGOLD", 1600, 2_000_000)],
      metalMeta,
    );

    expect(result.rates.peggedGOLD).toBeCloseTo(1600 / gramOz, 6);
  });

  it("uses fallback rates for groups with fewer than 3 eligible coins", () => {
    const result = derivePegRates(
      [
        asset("usd-eur-a", "peggedEUR", 1.1, 2_000_000),
        asset("usd-eur-b", "peggedEUR", 1.2, 2_100_000),
      ],
      undefined,
      { peggedEUR: 1.2 },
    );

    expect(result.rates.peggedEUR).toBe(1.2);
    expect(result.sources.peggedEUR).toBe("fallback");
  });
});

describe("getPegReference", () => {
  it("scales gold and silver references by commodity ounces", () => {
    expect(getPegReference("peggedGOLD", { peggedGOLD: 5000 }, 0.5)).toBe(2500);
    expect(getPegReference("peggedSILVER", { peggedSILVER: 100 }, 2)).toBe(200);
  });

  it("returns 1 for unknown peg types when no rate is available", () => {
    expect(getPegReference("peggedDOGE", {})).toBe(1);
  });
});
