import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "../../api/__tests__/helpers/mock-fetch";

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(async (url: string, init?: RequestInit) => fetch(url, init)),
}));

import { fetchBeefySources } from "../yield-sync/sources";

describe("fetchBeefySources", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("joins APY and vault metadata for stablecoin single-asset vaults", async () => {
    mockFetch([
      { match: "api.beefy.finance/apy", body: { "aave-usdc": 0.037 } },
      { match: "api.beefy.finance/vaults", body: [{
        id: "aave-usdc", name: "Aave USDC", token: "USDC",
        assets: ["USDC"], status: "active", chain: "ethereum", platformId: "aave",
        tokenAddress: "0x123", earnContractAddress: "0x456", earnedToken: "mooAaveUSDC",
        earnedTokenAddress: "0x789", oracle: "tokens", oracleId: "USDC",
      }] },
    ]);

    const results = await fetchBeefySources();
    expect(results.length).toBe(1);
    expect(results[0]).toEqual(expect.objectContaining({
      symbol: "USDC",
      yield: expect.objectContaining({
        currentApy: expect.closeTo(3.7, 0),
        dataSource: "protocol-api",
        sourceKey: expect.stringContaining("protocol-api:beefy:"),
      }),
    }));
  });

  it("skips EOL vaults", async () => {
    mockFetch([
      { match: "api.beefy.finance/apy", body: { "old-usdc": 0.05 } },
      { match: "api.beefy.finance/vaults", body: [{
        id: "old-usdc", name: "Old USDC", token: "USDC",
        assets: ["USDC"], status: "eol", chain: "ethereum", platformId: "aave",
        tokenAddress: "0x1", earnContractAddress: "0x2", earnedToken: "moo",
        earnedTokenAddress: "0x3", oracle: "tokens", oracleId: "USDC",
      }] },
    ]);
    expect(await fetchBeefySources()).toEqual([]);
  });

  it("skips multi-asset LP vaults", async () => {
    mockFetch([
      { match: "api.beefy.finance/apy", body: { "curve-usdc-usdt": 0.06 } },
      { match: "api.beefy.finance/vaults", body: [{
        id: "curve-usdc-usdt", name: "Curve USDC-USDT", token: "crvUSDC-USDT",
        assets: ["USDC", "USDT"], status: "active", chain: "ethereum", platformId: "curve",
        tokenAddress: "0x1", earnContractAddress: "0x2", earnedToken: "moo",
        earnedTokenAddress: "0x3", oracle: "lps", oracleId: "curve-usdc-usdt",
      }] },
    ]);
    expect(await fetchBeefySources()).toEqual([]);
  });
});
