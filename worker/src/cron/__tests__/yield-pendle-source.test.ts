import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupYieldSourceTest, mockYieldSourceRoutes } from "./yield-source.test-support";

import { fetchPendleMarketSources } from "../yield-sync/sources";

describe("fetchPendleMarketSources", () => {
  afterEach(cleanupYieldSourceTest);

  it("fetches the three chain pages without authentication", async () => {
    const requests: Request[] = [];
    mockYieldSourceRoutes([1, 42161, 8453].map((chainId) => ({
      match: `https://api-v2.pendle.finance/core/v1/${chainId}/markets?limit=100&skip=0&is_active=true`,
      respond: (request: Request) => {
        requests.push(request);
        return { body: { results: [] } };
      },
    })), { strictUrl: true, requireMatch: true });

    expect(await fetchPendleMarketSources()).toEqual({ candidates: [], degraded: false });
    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.headers.get("Authorization") == null)).toBe(true);
  });

  const rateLimitCases: Array<{
    headers: Record<string, string>;
    backoffSec: number;
    source: "retry-after" | "x-ratelimit-weekly-reset" | "x-ratelimit-reset" | "default";
  }> = [
    { headers: { "Retry-After": "3600" }, backoffSec: 3600, source: "retry-after" },
    { headers: { "Retry-After": "Thu, 24 Sep 2026 00:00:00 GMT" }, backoffSec: 86400, source: "retry-after" },
    { headers: { "x-ratelimit-weekly-reset": "1790208000" }, backoffSec: 86400, source: "x-ratelimit-weekly-reset" },
    {
      headers: { "Retry-After": "60", "x-ratelimit-weekly-remaining": "0", "x-ratelimit-weekly-reset": "1790208000" },
      backoffSec: 86400, source: "x-ratelimit-weekly-reset",
    },
    {
      headers: { "x-ratelimit-weekly-remaining": "100", "x-ratelimit-weekly-reset": "1790208000", "x-ratelimit-reset": "1790121660" },
      backoffSec: 60, source: "x-ratelimit-reset",
    },
    { headers: { "Retry-After": "invalid" }, backoffSec: 86400, source: "default" },
    { headers: { "Retry-After": "999999999" }, backoffSec: 7 * 86400, source: "retry-after" },
  ];

  it.each(rateLimitCases)("stops on the first 429 and preserves the retry window ($source, $backoffSec)", async ({ headers, backoffSec, source }) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-23T00:00:00Z"));
    const fetch = mockYieldSourceRoutes([{
      match: "/core/v1/1/markets?",
      respond: () => new Response("quota exhausted", { status: 429, headers }),
    }], { requireMatch: true });
    expect(await fetchPendleMarketSources()).toEqual({
      candidates: [], degraded: true, rateLimited: { backoffSec, source },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

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
