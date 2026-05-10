import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "../../api/__tests__/helpers/mock-fetch";

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(async (url: string, init?: RequestInit) => fetch(url, init)),
}));

import { fetchMorphoVaultSources } from "../yield-sync/sources";

describe("fetchMorphoVaultSources", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("returns yield sources for stablecoin vaults", async () => {
    const fetchSpy = mockFetch([{
      match: "api.morpho.org",
      body: {
        data: {
          vaults: {
            items: [{
              address: "0x9eF4cb75FeD5b3913219E881E0FF0b10a6761CF3",
              name: "Gauntlet USDC Prime",
              asset: { symbol: "USDC" },
              chain: { id: 1 },
              state: { netApy: 0.02968, totalAssetsUsd: 142_917_322, fee: 0 },
            }],
          },
        },
      },
    }]);

    const results = await fetchMorphoVaultSources();
    expect(results.length).toBe(1);
    const request = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as { variables: { symbols: string[] } };
    expect(request.variables.symbols).toContain("USDC");
    expect(request.variables.symbols).not.toEqual([
      "USDC", "USDT", "DAI", "USDS", "GHO", "FRAX", "PYUSD", "FRXUSD", "crvUSD", "DOLA", "LUSD",
    ]);
    expect(results[0].symbol).toBe("USDC");
    expect(results[0].stablecoinId).toBe("usdc-circle");
    expect(results[0].yield).toEqual(expect.objectContaining({
      currentApy: expect.closeTo(2.968, 1),
      dataSource: "protocol-api",
      sourceKey: expect.stringContaining("protocol-api:morpho-vault:"),
      yieldSource: expect.stringContaining("Morpho"),
      sourceTvlUsd: 142_917_322,
    }));
  });

  it("returns empty array on HTTP error", async () => {
    mockFetch([{ match: "api.morpho.org", body: { error: "internal server error" }, status: 500 }]);
    const results = await fetchMorphoVaultSources();
    expect(results).toEqual([]);
  });

  it("skips vaults with zero APY", async () => {
    mockFetch([{
      match: "api.morpho.org",
      body: {
        data: {
          vaults: {
            items: [{
              address: "0xabc",
              name: "Empty Vault",
              asset: { symbol: "USDC" },
              chain: { id: 1 },
              state: { netApy: 0, totalAssetsUsd: 1_000_000, fee: 0 },
            }],
          },
        },
      },
    }]);

    const results = await fetchMorphoVaultSources();
    expect(results).toEqual([]);
  });

  it("uses tracked chain/address identity before returned symbols", async () => {
    mockFetch([{
      match: "api.morpho.org",
      body: {
        data: {
          vaults: {
            items: [{
              address: "0xabc",
              name: "Wrong USDC",
              asset: {
                symbol: "USDC",
                address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
              },
              chain: { id: 1 },
              state: { netApy: 0.03, totalAssetsUsd: 1_000_000, fee: 0 },
            }],
          },
        },
      },
    }]);

    const results = await fetchMorphoVaultSources();
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(expect.objectContaining({
      stablecoinId: "usdt-tether",
      symbol: "USDT",
    }));
  });
});
