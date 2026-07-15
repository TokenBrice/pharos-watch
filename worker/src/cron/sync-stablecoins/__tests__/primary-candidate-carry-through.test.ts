import { describe, expect, it } from "vitest";
import {
  getPostEnrichmentCandidatePricesForCurrentAsset,
  getPrimaryCandidatePricesForCurrentAsset,
} from "../pricing";
import type { PeggedAsset, PrimaryPriceResult } from "../enrich-prices";

function makeAsset(overrides: Partial<PeggedAsset> = {}): PeggedAsset {
  return {
    id: "usdt-tether",
    name: "Tether",
    symbol: "USDT",
    pegType: "peggedUSD",
    price: 1.0,
    priceSource: "coingecko",
    priceConfidence: "high",
    ...overrides,
  };
}

function makePrimaryPriceResult(overrides: Partial<PrimaryPriceResult> = {}): PrimaryPriceResult {
  return {
    price: 1.0,
    source: "coingecko",
    confidence: "high",
    selectedSource: "coingecko",
    dlPrice: null,
    cgPrice: null,
    candidateSources: ["coingecko", "defillama-list"],
    agreeSources: ["coingecko", "defillama-list"],
    allPrices: { coingecko: 1.0, "defillama-list": 1.0005 },
    observedAt: 1_700_000_000,
    observedAtMode: "upstream",
    ...overrides,
  };
}

describe("getPrimaryCandidatePricesForCurrentAsset", () => {
  it("returns undefined when the primary result is for a different asset id", () => {
    const asset = makeAsset({ id: "usdt-tether" });
    const results = new Map([["usdc-circle", makePrimaryPriceResult()]]);

    expect(getPrimaryCandidatePricesForCurrentAsset(asset, results)).toBeUndefined();
  });

  it("returns undefined when the current source differs from the primary result source", () => {
    const asset = makeAsset({ priceSource: "pyth" });
    const results = new Map([
      ["usdt-tether", makePrimaryPriceResult({ source: "coingecko" })],
    ]);

    expect(getPrimaryCandidatePricesForCurrentAsset(asset, results)).toBeUndefined();
  });

  it("returns undefined when the current confidence differs from the primary result confidence", () => {
    const asset = makeAsset({ priceConfidence: "single-source" });
    const results = new Map([
      ["usdt-tether", makePrimaryPriceResult({ confidence: "high" })],
    ]);

    expect(getPrimaryCandidatePricesForCurrentAsset(asset, results)).toBeUndefined();
  });

  it("returns allPrices when the current price matches the primary result within 1e-9 tolerance", () => {
    const allPrices = { coingecko: 1.001, "defillama-list": 1.0005, pyth: 0.9997 };
    // 1e-10 delta is within the 1.001 * 1e-9 ~= 1e-9 tolerance.
    const asset = makeAsset({ price: 1.001 + 1e-10 });
    const results = new Map([
      [
        "usdt-tether",
        makePrimaryPriceResult({ price: 1.001, allPrices }),
      ],
    ]);

    expect(getPrimaryCandidatePricesForCurrentAsset(asset, results)).toBe(allPrices);
  });

  it("returns undefined when the current price drifts outside the 1e-9 tolerance", () => {
    const asset = makeAsset({ price: 1.001 + 1e-5 });
    const results = new Map([
      [
        "usdt-tether",
        makePrimaryPriceResult({ price: 1.001 }),
      ],
    ]);

    expect(getPrimaryCandidatePricesForCurrentAsset(asset, results)).toBeUndefined();
  });
});

describe("getPostEnrichmentCandidatePricesForCurrentAsset", () => {
  it("merges a same-run primary quote with the current fallback quote", () => {
    const asset = makeAsset({
      id: "usx-dforce",
      price: 0.3904,
      priceSource: "dexscreener-exact",
      priceConfidence: "fallback",
    });
    const results = new Map([
      [
        "usx-dforce",
        makePrimaryPriceResult({
          price: 0.390247,
          source: "coingecko",
          confidence: "single-source",
          allPrices: { coingecko: 0.390247 },
        }),
      ],
    ]);

    expect(getPostEnrichmentCandidatePricesForCurrentAsset(asset, results)).toEqual({
      coingecko: 0.390247,
      "dexscreener-exact": 0.3904,
    });
  });

  it("adds the current fallback even when primary metadata already matches it", () => {
    const asset = makeAsset({
      id: "usx-dforce",
      price: 0.3904,
      priceSource: "dexscreener-exact",
      priceConfidence: "fallback",
    });
    const results = new Map([
      [
        "usx-dforce",
        makePrimaryPriceResult({
          price: 0.3904,
          source: "dexscreener-exact",
          confidence: "fallback",
          allPrices: { coingecko: 0.390247 },
        }),
      ],
    ]);

    expect(getPostEnrichmentCandidatePricesForCurrentAsset(asset, results)).toEqual({
      coingecko: 0.390247,
      "dexscreener-exact": 0.3904,
    });
  });

  it("does not merge same-run evidence into a non-fallback replacement", () => {
    const asset = makeAsset({
      price: 0.3904,
      priceSource: "protocol-redeem",
      priceConfidence: "single-source",
    });

    expect(
      getPostEnrichmentCandidatePricesForCurrentAsset(
        asset,
        new Map([[asset.id, makePrimaryPriceResult({ allPrices: { coingecko: 0.390247 } })]]),
      ),
    ).toBeUndefined();
  });
});
