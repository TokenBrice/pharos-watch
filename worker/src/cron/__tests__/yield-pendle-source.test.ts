import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupYieldSourceTest, mockYieldSourceFetchRetryModule, mockYieldSourceRoutes } from "./yield-source.test-support";

vi.mock("../../lib/fetch-retry", () => mockYieldSourceFetchRetryModule());

import { fetchPendleMarketSources } from "../yield-sync/sources";

describe("fetchPendleMarketSources", () => {
  afterEach(cleanupYieldSourceTest);

  it("extracts stablecoin market yields from Pendle REST API", async () => {
    const futureExpiry = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
    mockYieldSourceRoutes([
      {
        match: "/core/v1/1/markets?",
        body: {
          total: 1,
          limit: 100,
          skip: 0,
          results: [
            {
              id: "1-0xabc",
              address: "0xabc",
              chainId: 1,
              isActive: true,
              expiry: futureExpiry,
              impliedApy: 0.052,
              underlyingApy: 0.031,
              aggregatedApy: 0.052,
              underlyingAsset: { symbol: "USDG", address: "0xdef" },
              assetRepresentation: "USDG",
              protocol: "Global Dollar",
              liquidity: { usd: 82_000_000 },
              categoryIds: ["stables", "rwa"],
            },
          ],
        },
      },
      { match: "/core/v1/42161/markets?", body: { results: [] } },
      { match: "/core/v1/8453/markets?", body: { results: [] } },
    ]);

    const { candidates: results } = await fetchPendleMarketSources();
    expect(results.map((result) => result.yield.sourceKey)).toEqual(["protocol-api:pendle:ethereum:0xabc"]);
    expect(results[0].yield).toEqual(
      expect.objectContaining({
        currentApy: expect.closeTo(5.2, 0),
        dataSource: "protocol-api",
        sourceKey: expect.stringContaining("protocol-api:pendle:"),
        yieldSource: "Pendle fixed yield: Global Dollar USDG",
        yieldType: "fixed-yield",
      }),
    );
  });

  it("filters out non-stablecoin markets", async () => {
    const futureExpiry = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
    mockYieldSourceRoutes([
      {
        match: "/core/v1/1/markets?",
        body: {
          total: 1,
          limit: 100,
          skip: 0,
          results: [
            {
              id: "1-0xabc",
              address: "0xabc",
              chainId: 1,
              isActive: true,
              expiry: futureExpiry,
              impliedApy: 0.1,
              underlyingApy: 0.05,
              aggregatedApy: 0.1,
              underlyingAsset: { symbol: "ETH", address: "0xdef" },
              assetRepresentation: "ETH",
              protocol: "Lido",
              liquidity: { usd: 200_000_000 },
              categoryIds: ["eth-staking"],
            },
          ],
        },
      },
      { match: "/core/v1/42161/markets?", body: { results: [] } },
      { match: "/core/v1/8453/markets?", body: { results: [] } },
    ]);

    const { candidates: results } = await fetchPendleMarketSources();
    expect(results).toEqual([]);
  });

  it("filters expired and implausibly high implied APY markets", async () => {
    mockYieldSourceRoutes([
      {
        match: "/core/v1/1/markets?",
        body: {
          total: 2,
          limit: 100,
          skip: 0,
          results: [
            {
              id: "1-0xexpired",
              address: "0xexpired",
              chainId: 1,
              isActive: true,
              expiry: new Date(Date.now() - 86400 * 1000).toISOString(),
              impliedApy: 0.052,
              underlyingApy: 0.031,
              aggregatedApy: 0.052,
              underlyingAsset: { symbol: "USDG", address: "0xdef" },
              assetRepresentation: "USDG",
              protocol: "Global Dollar",
              liquidity: { usd: 82_000_000 },
              categoryIds: ["stables"],
            },
            {
              id: "1-0xhigh",
              address: "0xhigh",
              chainId: 1,
              isActive: true,
              expiry: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
              impliedApy: 1.5,
              underlyingApy: 0.031,
              aggregatedApy: 1.5,
              underlyingAsset: { symbol: "USDG", address: "0xdef" },
              assetRepresentation: "USDG",
              protocol: "Global Dollar",
              liquidity: { usd: 82_000_000 },
              categoryIds: ["stables"],
            },
          ],
        },
      },
      { match: "/core/v1/42161/markets?", body: { results: [] } },
      { match: "/core/v1/8453/markets?", body: { results: [] } },
    ]);

    await expect(fetchPendleMarketSources()).resolves.toEqual({ candidates: [], degraded: false });
  });

  it("keeps same-address markets on distinct chains", async () => {
    mockYieldSourceRoutes([1, 42161, 8453].map((chainId) => ({
      match: `/core/v1/${chainId}/markets?`,
      body: { results: [{
        address: "0xabc", chainId, isActive: true,
        expiry: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
        impliedApy: 0.05, underlyingAsset: { symbol: "USDC", address: "0xdef" },
        assetRepresentation: "USDC", protocol: "Test", liquidity: { usd: 2_000_000 },
        categoryIds: ["stables"],
      }] },
    })), { requireMatch: true });
    expect((await fetchPendleMarketSources()).candidates.map((result) => result.yield.sourceKey)).toEqual([
      "protocol-api:pendle:ethereum:0xabc",
      "protocol-api:pendle:arbitrum:0xabc",
      "protocol-api:pendle:base:0xabc",
    ]);
  });

  it("reports a degraded fetch when a chain page fails", async () => {
    mockYieldSourceRoutes([
      { match: "/core/v1/1/markets?", body: { error: "upstream unavailable" }, status: 500 },
      { match: "/core/v1/42161/markets?", body: { results: [] } },
      { match: "/core/v1/8453/markets?", body: { results: [] } },
    ]);

    await expect(fetchPendleMarketSources()).resolves.toEqual({ candidates: [], degraded: true });
  });
});
