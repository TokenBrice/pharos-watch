import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { mockFetchRetry } from "../../test-helpers/cron";

vi.mock("../../lib/fetch-retry", () => mockFetchRetry());

import { fetchPendleMarketSources } from "../yield-sync/sources";

describe("fetchPendleMarketSources", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("extracts stablecoin market yields from Pendle REST API", async () => {
    const futureExpiry = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
    mockFetch([
      {
        match: "api-v2.pendle.finance",
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
    ]);

    const results = await fetchPendleMarketSources();
    expect(results.length).toBeGreaterThanOrEqual(1);
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
    mockFetch([
      {
        match: "api-v2.pendle.finance",
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
    ]);

    const results = await fetchPendleMarketSources();
    expect(results).toEqual([]);
  });

  it("filters expired and implausibly high implied APY markets", async () => {
    mockFetch([
      {
        match: "api-v2.pendle.finance",
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
    ]);

    await expect(fetchPendleMarketSources()).resolves.toEqual([]);
  });
});
