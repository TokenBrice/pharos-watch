import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupYieldSourceTest, mockYieldSourceFetchRetryModule, mockYieldSourceRoutes } from "./yield-source.test-support";

vi.mock("../../lib/fetch-retry", () => mockYieldSourceFetchRetryModule());

import { fetchBeefySources } from "../yield-sync/sources-optional";

describe("fetchBeefySources", () => {
  afterEach(cleanupYieldSourceTest);

  it("joins APY and vault metadata for stablecoin single-asset vaults", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_790_121_600_000);
    mockYieldSourceRoutes([
      { match: "api.beefy.finance/apy", body: { "Aave-USDC": 0.037 } },
      { match: "api.beefy.finance/tvl", body: { "43114": { "Aave-USDC": 12_500_000 } } },
      {
        match: "api.beefy.finance/vaults",
        body: [
          {
            id: "Aave-USDC",
            name: "Aave USDC",
            token: "USDC",
            assets: ["USDC"],
            status: "active",
            chain: "avax",
            platformId: "aave",
            tokenAddress: "0x123",
            earnContractAddress: "0x456",
            earnedToken: "mooAaveUSDC",
            earnedTokenAddress: "0x789",
            oracle: "tokens",
            oracleId: "USDC",
          },
        ],
      },
    ]);

    const { candidates: results } = await fetchBeefySources();
    expect(results).toStrictEqual([{
      symbol: "USDC", chain: "avalanche", address: "0x123",
      yield: {
        currentApy: 3.6999999999999997, apyBase: 3.6999999999999997, apyReward: null,
        sourcePool: "Aave-USDC", sourceTvlUsd: 12_500_000, dataSource: "protocol-api",
        exchangeRate: null, sourceKey: "protocol-api:beefy:avalanche:Aave-USDC",
        yieldSource: "Beefy: Aave USDC", yieldType: "lending-opportunity",
        sourceObservedAt: 1_790_121_600, comparisonAnchorObservedAt: null,
      },
    }]);
  });

  it.each([
    {
      name: "skips EOL vaults",
      apy: { "old-usdc": 0.05 },
      tvl: { "1": { "old-usdc": 1_000_000 } },
      vault: {
        id: "old-usdc",
        name: "Old USDC",
        token: "USDC",
        assets: ["USDC"],
        status: "eol",
        chain: "ethereum",
        platformId: "aave",
        tokenAddress: "0x1",
        earnContractAddress: "0x2",
        earnedToken: "moo",
        earnedTokenAddress: "0x3",
        oracle: "tokens",
        oracleId: "USDC",
      },
    },
    {
      name: "skips multi-asset LP vaults",
      apy: { "curve-usdc-usdt": 0.06 },
      tvl: { "1": { "curve-usdc-usdt": 1_000_000 } },
      vault: {
        id: "curve-usdc-usdt",
        name: "Curve USDC-USDT",
        token: "crvUSDC-USDT",
        assets: ["USDC", "USDT"],
        status: "active",
        chain: "ethereum",
        platformId: "curve",
        tokenAddress: "0x1",
        earnContractAddress: "0x2",
        earnedToken: "moo",
        earnedTokenAddress: "0x3",
        oracle: "lps",
        oracleId: "curve-usdc-usdt",
      },
    },
    {
      name: "skips vaults without enough Beefy TVL to pass size gates",
      apy: { "aave-usdc": 0.037 },
      tvl: { "1": { "aave-usdc": 99_999 } },
      vault: {
        id: "aave-usdc",
        name: "Aave USDC",
        token: "USDC",
        assets: ["USDC"],
        status: "active",
        chain: "ethereum",
        platformId: "aave",
        tokenAddress: "0x123",
      },
    },
  ])("$name", async ({ apy, tvl, vault }) => {
    mockYieldSourceRoutes([
      { match: "api.beefy.finance/apy", body: apy },
      { match: "api.beefy.finance/tvl", body: tvl },
      { match: "api.beefy.finance/vaults", body: [vault] },
    ]);
    await expect(fetchBeefySources()).resolves.toEqual({ candidates: [], degraded: false });
  });

  it("marks the family degraded when an upstream document is unreadable", async () => {
    mockYieldSourceRoutes([{ match: "api.beefy.finance/apy", status: 500, body: {} }]);

    expect(await fetchBeefySources()).toEqual({ candidates: [], degraded: true });
  });
});
