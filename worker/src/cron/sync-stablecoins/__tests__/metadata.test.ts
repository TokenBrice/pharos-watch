import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { buildPricingSourceAuditReport, buildStablecoinsSyncResult } from "../metadata";
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

  it("keeps persisted metadata below 64 KiB without serializing deduped assets", () => {
    const sentinel = "full-asset-payload-must-not-be-persisted";
    const assets = ACTIVE_STABLECOINS.map((stablecoin) => ({
      id: stablecoin.id,
      name: stablecoin.name,
      symbol: stablecoin.symbol,
      price: 1,
      priceSource: "defillama-list",
      priceConfidence: "single-source" as const,
      circulating: { peggedUSD: 1 },
      diagnosticSentinel: sentinel,
    })) as PeggedAsset[];
    const result = buildStablecoinsSyncResult({
      assets,
      rawAssetCount: assets.length,
      droppedMalformedAssets: 0,
      canonicalDeduplication: {
        dedupedAssets: assets,
        duplicateRows: 1,
        affectedIds: assets.map((asset) => asset.id),
      },
      enrichStats: { oversizedDiagnostics: Array.from({ length: 500 }, (_, index) => ({ index, text: "x".repeat(1_000) })) },
      priceValidationStats: { rejected: [] },
      providerDiagnostics: [],
      rejectedCount: 0,
      stalenessWarning: false,
      stalenessCheckFailed: false,
      gtProbe: { updatedCount: 0, stats: {} as never },
      depegErrorCount: 0,
      depegErrors: [],
      syncStartSec: 1_777_000_000,
    });

    expect(new TextEncoder().encode(result.metadata ?? "").byteLength).toBeLessThan(64 * 1024);
    expect(result.metadata).not.toContain(sentinel);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.canonicalDeduplication).not.toHaveProperty("dedupedAssets");
    expect(metadata.activePriceCoverage).toMatchObject({
      complete: true,
      pricedActiveCount: ACTIVE_STABLECOINS.length,
      missingPriceCount: 0,
    });
  });

  it("degrades missing active prices without blocking complete row publication", () => {
    const missingId = ACTIVE_STABLECOINS[0]!.id;
    const assets = ACTIVE_STABLECOINS.map((stablecoin) => ({
      id: stablecoin.id,
      name: stablecoin.name,
      symbol: stablecoin.symbol,
      price: stablecoin.id === missingId ? null : 1,
      priceSource: stablecoin.id === missingId ? "coingecko" : "defillama-list",
      priceConfidence: "single-source" as const,
      priceObservedAt: 1_776_999_900,
      circulating: { peggedUSD: stablecoin.id === missingId ? 125_500 : 1 },
    })) as PeggedAsset[];
    const result = buildStablecoinsSyncResult({
      assets,
      rawAssetCount: assets.length,
      droppedMalformedAssets: 0,
      canonicalDeduplication: {
        dedupedAssets: assets,
        duplicateRows: 0,
        affectedIds: [],
      },
      enrichStats: {},
      priceValidationStats: {},
      providerDiagnostics: [],
      rejectedCount: 0,
      stalenessWarning: false,
      stalenessCheckFailed: false,
      gtProbe: { updatedCount: 0, stats: {} as never },
      depegErrorCount: 0,
      depegErrors: [],
      syncStartSec: 1_777_000_000,
    });

    const metadata = JSON.parse(result.metadata ?? "{}") as {
      activePublicationCoverage: { complete: boolean };
      activePriceCoverage: {
        complete: boolean;
        missingActiveIds: string[];
        affectedMarketCapUsd: number;
      };
      capabilities: { stablecoinsCache: boolean };
    };
    expect(result.status).toBe("degraded");
    expect(metadata.activePublicationCoverage.complete).toBe(true);
    expect(metadata.capabilities.stablecoinsCache).toBe(true);
    expect(metadata.activePriceCoverage).toMatchObject({
      complete: false,
      missingActiveIds: [missingId],
      affectedMarketCapUsd: 125_500,
    });
  });
});
