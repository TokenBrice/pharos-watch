import { describe, expect, it } from "vitest";

import { derivePegRates, getPegReference, normalizePegType } from "@shared/lib/peg-rates";
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

  it("uses authoritative FX rates for empty fiat peg groups", () => {
    const result = derivePegRates([], new Map(), { peggedTRY: 0.022417 });

    expect(result.rates.peggedTRY).toBe(0.022417);
    expect(result.sources.peggedTRY).toBe("fx");
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

  it("excludes DGLD from the gold peer median", () => {
    const result = derivePegRates(
      [
        asset("xaut-tether-gold", "peggedGOLD", 2000, 2_000_000),
        asset("paxg-pax-gold", "peggedGOLD", 2200, 2_000_000),
        asset("dgld-gold-token-sa", "peggedGOLD", 10_000, 2_000_000),
      ],
      new Map(),
    );

    expect(result.rates.peggedGOLD).toBe(2100);
    expect(result.counts.peggedGOLD).toBe(2);
  });

  it("uses authoritative FX rates for fiat groups with fewer than 3 eligible coins", () => {
    const result = derivePegRates(
      [
        asset("usd-eur-a", "peggedEUR", 1.1, 2_000_000),
        asset("usd-eur-b", "peggedEUR", 1.2, 2_100_000),
      ],
      undefined,
      { peggedEUR: 1.2 },
    );

    expect(result.rates.peggedEUR).toBe(1.2);
    expect(result.sources.peggedEUR).toBe("fx");
  });

  it("prefers an authoritative fiat FX rate over a broad peer median", () => {
    const result = derivePegRates(
      [
        asset("brl-a", "peggedREAL", 0.1950, 2_000_000),
        asset("brl-b", "peggedREAL", 0.1953, 3_000_000),
        asset("brl-c", "peggedREAL", 0.1928, 4_000_000),
        asset("brl-d", "peggedREAL", 0.1932, 5_000_000),
      ],
      undefined,
      { peggedREAL: 0.19504 },
    );

    expect(result.rates.peggedREAL).toBe(0.19504);
    expect(result.sources.peggedREAL).toBe("fx");
    expect(result.counts.peggedREAL).toBe(4);
  });

  it("keeps BRL alias maps compatible with raw peggedBRL consumers", () => {
    const result = derivePegRates([asset("brl-token", "peggedBRL", 0.18, 2_000_000)]);

    expect(result.rates.peggedREAL).toBe(0.18);
    expect(result.rates.peggedBRL).toBe(0.18);
    expect(result.sources.peggedBRL).toBe("median");
    expect(result.counts.peggedBRL).toBe(1);
  });

  it("normalizes fallback rates before aliasing", () => {
    const result = derivePegRates([], new Map(), { peggedBRL: 0.2 });

    expect(result.rates.peggedREAL).toBe(0.2);
    expect(result.rates.peggedBRL).toBe(0.2);
    expect(result.sources.peggedBRL).toBe("fx");
    expect(result.counts.peggedBRL).toBe(0);
  });
});

describe("normalizePegType", () => {
  it("canonicalizes the legacy BRL peg alias", () => {
    expect(normalizePegType("peggedBRL")).toBe("peggedREAL");
    expect(normalizePegType("peggedEUR")).toBe("peggedEUR");
    expect(normalizePegType(undefined)).toBeUndefined();
  });

  it("handles peg types that match inherited object property names", () => {
    const result = derivePegRates([
      asset("constructor-token", "constructor", 1.23, 2_000_000),
      asset("proto-token", "__proto__", 1.25, 2_000_000),
      asset("tostring-token", "toString", 1.27, 2_000_000),
    ]);

    expect(result.rates["constructor"]).toBe(1.23);
    expect(result.rates["__proto__"]).toBe(1.25);
    expect(result.rates["toString"]).toBe(1.27);
    expect(result.sources["constructor"]).toBe("median");
    expect(result.counts["__proto__"]).toBe(1);
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

  it("uses the canonical BRL peg rate for legacy peggedBRL references", () => {
    expect(getPegReference("peggedBRL", { peggedREAL: 0.2 })).toBe(0.2);
  });
});
