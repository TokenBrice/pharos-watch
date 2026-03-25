import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "../../api/__tests__/helpers/mock-fetch";

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(async (url: string, init?: RequestInit) => fetch(url, init)),
}));

import { fetchPendleMarketSources } from "../yield-sync/sources";

describe("fetchPendleMarketSources", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("extracts stablecoin market yields from Pendle REST API", async () => {
    mockFetch([{
      match: "api-v2.pendle.finance",
      body: { total: 1, limit: 100, skip: 0, results: [{
        id: "1-0xabc", address: "0xabc", chainId: 1, isActive: true,
        expiry: "2026-05-28T00:00:00.000Z",
        impliedApy: 0.052, underlyingApy: 0.031, aggregatedApy: 0.052,
        underlyingAsset: { symbol: "USDG", address: "0xdef" },
        assetRepresentation: "USDG", protocol: "Global Dollar",
        liquidity: { usd: 82_000_000 },
        categoryIds: ["stables", "rwa"],
      }] },
    }]);

    const results = await fetchPendleMarketSources();
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].yield).toEqual(expect.objectContaining({
      currentApy: expect.closeTo(5.2, 0),
      dataSource: "protocol-api",
      sourceKey: expect.stringContaining("protocol-api:pendle:"),
    }));
  });

  it("filters out non-stablecoin markets", async () => {
    mockFetch([{
      match: "api-v2.pendle.finance",
      body: { total: 1, limit: 100, skip: 0, results: [{
        id: "1-0xabc", address: "0xabc", chainId: 1, isActive: true,
        expiry: "2026-05-28T00:00:00.000Z",
        impliedApy: 0.1, underlyingApy: 0.05, aggregatedApy: 0.1,
        underlyingAsset: { symbol: "ETH", address: "0xdef" },
        assetRepresentation: "ETH", protocol: "Lido",
        liquidity: { usd: 200_000_000 },
        categoryIds: ["eth-staking"],
      }] },
    }]);

    const results = await fetchPendleMarketSources();
    expect(results).toEqual([]);
  });
});
