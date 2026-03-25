import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "../../api/__tests__/helpers/mock-fetch";

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(async (url: string, init?: RequestInit) => fetch(url, init)),
}));

import { fetchYearnKongSources } from "../yield-sync/sources";

describe("fetchYearnKongSources", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("extracts stablecoin vault APYs from Kong GraphQL", async () => {
    mockFetch([{
      match: "kong.yearn.fi",
      body: { data: { vaults: [{
        address: "0xBe53A109B494E5c9f97b9Cd39Fe969BE68BF6204",
        name: "USDC-1 yVault", yearn: true,
        asset: { symbol: "USDC" },
        tvl: { close: 31_708_022 },
        apy: { net: 0.0312, monthlyNet: 0.0312 },
        meta: { category: "Stablecoin", isRetired: false },
      }] } },
    }]);

    const results = await fetchYearnKongSources();
    expect(results.length).toBe(1);
    expect(results[0]).toEqual(expect.objectContaining({
      symbol: "USDC",
      yield: expect.objectContaining({
        currentApy: expect.closeTo(3.12, 1),
        dataSource: "protocol-api",
        sourceKey: expect.stringContaining("protocol-api:kong:"),
        yieldSource: expect.stringContaining("Yearn"),
      }),
    }));
  });

  it("skips retired vaults", async () => {
    mockFetch([{
      match: "kong.yearn.fi",
      body: { data: { vaults: [{
        address: "0x123", name: "Old USDC", yearn: true,
        asset: { symbol: "USDC" },
        tvl: { close: 1_000_000 },
        apy: { net: 0.02, monthlyNet: 0.02 },
        meta: { category: "Stablecoin", isRetired: true },
      }] } },
    }]);
    expect(await fetchYearnKongSources()).toEqual([]);
  });

  it("labels non-Yearn vaults as Kong", async () => {
    mockFetch([{
      match: "kong.yearn.fi",
      body: { data: { vaults: [{
        address: "0xabc", name: "Steakhouse USDC", yearn: false,
        asset: { symbol: "USDC" },
        tvl: { close: 50_000_000 },
        apy: { net: 0.03, monthlyNet: 0.03 },
        meta: { category: "Stablecoin", isRetired: false },
      }] } },
    }]);
    const results = await fetchYearnKongSources();
    expect(results[0].yield.yieldSource).toContain("Kong");
  });
});
