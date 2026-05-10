import { describe, expect, it } from "vitest";
import { buildPricingSourceAuditReport } from "../metadata";
import type { PeggedAsset } from "../enrich-prices";

describe("stablecoins pricing metadata", () => {
  it("summarizes weak source coverage and provider rejection counts", () => {
    const assets: PeggedAsset[] = [
      {
        id: "hard",
        name: "Hard USD",
        symbol: "HARD",
        price: 1,
        priceSource: "pyth",
        priceConfidence: "high",
        agreeSources: ["pyth", "binance"],
      },
      {
        id: "search",
        name: "Search USD",
        symbol: "SEARCH",
        price: 1,
        priceSource: "dexscreener-search",
        priceConfidence: "fallback",
      },
      {
        id: "cached",
        name: "Cached USD",
        symbol: "CACHED",
        price: 1,
        priceSource: "cached",
        priceConfidence: "fallback",
      },
      {
        id: "missing",
        name: "Missing USD",
        symbol: "MISS",
        price: 0,
      },
      {
        id: "low",
        name: "Low USD",
        symbol: "LOW",
        price: 1,
        priceSource: "coingecko",
        priceConfidence: "low",
      },
    ];

    const report = buildPricingSourceAuditReport(assets, [
      {
        source: "dexscreener-search",
        stage: "fallback",
        endpoint: "api.dexscreener.com/latest/dex/search",
        status: 200,
        ok: true,
        success: false,
        rejectionReasonCounts: { "price-rejected": 2 },
      },
      {
        source: "native-peg",
        stage: "fallback",
        endpoint: "api.coingecko.com/api/v3/simple/price",
        status: 200,
        ok: true,
        success: false,
        rejectionReasonCounts: { stale: 1 },
      },
    ]);

    expect(report).toMatchObject({
      missingPriceCount: 1,
      fallbackOrCachedCount: 2,
      lowConfidenceCount: 1,
      providerRejectionCounts: {
        "price-rejected": 2,
        stale: 1,
      },
      providerFailuresBySource: {
        "dexscreener-search": 1,
        "native-peg": 1,
      },
    });
    expect(report.assetsWithoutIndependentHardSource).toEqual(["cached", "low", "search"]);
  });
});
