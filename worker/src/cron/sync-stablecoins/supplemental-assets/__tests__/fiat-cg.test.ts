import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockRegistry } from "../../../../test-helpers/cron";

const fetchWithRetryMock = vi.fn();
const probeTrackedTokenSupplyMock = vi.fn();
const fetchErc20TotalSupplyMock = vi.fn();
const resolveVaultNavSupplyPriceMock = vi.fn();

vi.mock("@shared/lib/stablecoins/registry", () => mockRegistry({
  stablecoins: [
    {
      id: "ftusd-flying-tulip",
      name: "Flying Tulip USD",
      symbol: "ftUSD",
      geckoId: "flying-tulip-usd",
      detailProvider: "coingecko",
      contracts: [
        { chain: "ethereum", address: "0xf7d85ec4e7710f71992752eac2111312e73e9c9c", decimals: 6 },
        { chain: "sonic", address: "0xf7d85ec4e7710f71992752eac2111312e73e9c9c", decimals: 6 },
      ],
      flags: {
        pegCurrency: "USD",
        backing: "crypto-backed",
        governance: "centralized-dependent",
        yieldBearing: false,
        navToken: false,
      },
    },
    {
      id: "susds-sky",
      name: "Savings USDS",
      symbol: "sUSDS",
      geckoId: "susds",
      detailProvider: "coingecko",
      contracts: [
        { chain: "ethereum", address: "0x1111111111111111111111111111111111111111", decimals: 18 },
      ],
      flags: {
        pegCurrency: "USD",
        backing: "rwa-backed",
        governance: "centralized",
        yieldBearing: true,
        navToken: true,
      },
    },
    {
      id: "fiusd-sygnum",
      name: "Sygnum FIUSD Liquidity Fund Token",
      symbol: "FIUSD",
      geckoId: "sygnum-fiusd-liquidity-fund",
      detailProvider: "coingecko",
      contracts: [
        { chain: "zksync", address: "0x2ab105a3ead22731082b790ca9a00d9a3a7627f9", decimals: 2 },
        { chain: "arbitrum", address: "0xcded6b899edba762d793f44ed295248049440e1e", decimals: 2 },
      ],
      flags: {
        pegCurrency: "USD", backing: "rwa-backed", governance: "centralized",
        yieldBearing: true, navToken: true,
      },
    },
  ],
}));

vi.mock("../../../../lib/fetch-retry", () => ({
  fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
  fetchTextWithRetry: async (...args: unknown[]) => {
    const response = await fetchWithRetryMock(...args);
    if (!response) return null;
    return { response, body: await response.text() };
  },
}));

vi.mock("../../../reserve-adapters/helpers", () => ({
  fetchOnchainUint256: vi.fn(),
  fetchErc20TotalSupply: (...args: unknown[]) => fetchErc20TotalSupplyMock(...args),
  probeTrackedTokenSupply: (...args: unknown[]) => probeTrackedTokenSupplyMock(...args),
}));

vi.mock("../../../../lib/authoritative-price-sources", () => ({
  resolveVaultNavSupplyPrice: (...args: unknown[]) => resolveVaultNavSupplyPriceMock(...args),
}));

import { fetchFiatCoinGeckoTokens } from "../fiat-cg";

describe("fetchFiatCoinGeckoTokens", () => {
  beforeEach(() => {
    fetchWithRetryMock.mockReset();
    probeTrackedTokenSupplyMock.mockReset();
    fetchErc20TotalSupplyMock.mockReset();
    resolveVaultNavSupplyPriceMock.mockReset().mockResolvedValue(null);
  });

  it("prefers fresh CoinGecko market cap over curated aggregate on-chain supply", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    fetchWithRetryMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ coins: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await fetchFiatCoinGeckoTokens({
      "flying-tulip-usd": {
        usd: 1,
        usd_market_cap: 868_459.9588768134,
        last_updated_at: nowSec,
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "ftusd-flying-tulip",
      supplySource: "coingecko-fallback",
      supplyObservedAt: nowSec,
      circulating: { peggedUSD: 868_459.9588768134 },
      chainCirculating: {},
    });
    expect(probeTrackedTokenSupplyMock).not.toHaveBeenCalled();
  });

  it("uses curated aggregate on-chain supply when CoinGecko market cap is stale", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    fetchWithRetryMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ coins: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    probeTrackedTokenSupplyMock.mockImplementation(async (_meta, input) => {
      if (input.chain === "ethereum") return 1_884_739_402_999n;
      if (input.chain === "sonic") return 37_578_423_196n;
      return null;
    });

    const result = await fetchFiatCoinGeckoTokens({
      "flying-tulip-usd": {
        usd: 1,
        usd_market_cap: 868_459.9588768134,
        last_updated_at: nowSec - 7 * 24 * 60 * 60,
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.chainCirculating?.Ethereum).not.toHaveProperty("circulatingPrevDay");
    expect(result[0]).toMatchObject({
      id: "ftusd-flying-tulip",
      supplySource: "onchain-total-supply",
      supplyObservedAt: expect.any(Number),
      circulating: { peggedUSD: 1_922_317.826195 },
      chainCirculating: {
        Ethereum: {
          current: 1_884_739.402999,
        },
        Sonic: {
          current: 37_578.423196,
        },
      },
    });
    expect(probeTrackedTokenSupplyMock).toHaveBeenCalledTimes(2);
  });

  it.each([0n, null])("requires FIUSD's complete native stock despite a fresh positive CG cap (Arbitrum=%s)", async (arbitrumSupply) => {
    const nowSec = Math.floor(Date.now() / 1000);
    fetchWithRetryMock.mockResolvedValueOnce(new Response(JSON.stringify({ coins: {} }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    probeTrackedTokenSupplyMock.mockImplementation(async (_meta, input) =>
      input.chain === "zksync" ? 151_766n : null,
    );
    fetchErc20TotalSupplyMock.mockImplementation(async (input) =>
      input.chain === "arbitrum" ? arbitrumSupply : null,
    );
    const result = await fetchFiatCoinGeckoTokens({
      "sygnum-fiusd-liquidity-fund": {
        usd: 12_048.93,
        usd_market_cap: 48_167_525.5038,
        last_updated_at: nowSec,
      },
    });
    if (arbitrumSupply === null) {
      expect(result).toEqual([]);
    } else {
      expect(result).toEqual([expect.objectContaining({
        id: "fiusd-sygnum",
        supplySource: "onchain-total-supply",
        circulating: { peggedUSD: 1517.66 * 12_048.93 },
        chainCirculating: {
          zkSync: { current: 1517.66 * 12_048.93, chainId: "zksync" },
          Arbitrum: { current: 0, chainId: "arbitrum" },
        },
      })]);
    }
  });

  it("skips NAV supply fallback when the price lane is missing instead of par-valuing", async () => {
    fetchWithRetryMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ coins: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await fetchFiatCoinGeckoTokens({
      susds: { usd_market_cap: 0 },
    });

    expect(result).toEqual([]);
    const susdsProbeCalls = probeTrackedTokenSupplyMock.mock.calls.filter(
      ([probeMeta]) => probeMeta != null && typeof probeMeta === "object" && "id" in probeMeta && probeMeta.id === "susds-sky",
    );
    expect(susdsProbeCalls).toHaveLength(0);
  });

  it("admits a NAV token from the protocol-redeem supply fallback without publishing a price", async () => {
    fetchWithRetryMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ coins: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    probeTrackedTokenSupplyMock.mockImplementation(async (_meta, input) =>
      input.chain === "ethereum" ? 3_000_000_000_000_000_000_000_000n : null,
    );
    resolveVaultNavSupplyPriceMock.mockResolvedValue({
      price: 1.04,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: Math.floor(Date.now() / 1000) - 60,
      observedAtMode: "local_fetch",
      metadata: { inheritedFrom: "usdc-circle" },
    });
    const previousAssetsById = new Map([["usdc-circle", { id: "usdc-circle", name: "USDC", symbol: "USDC" }]]);

    const result = await fetchFiatCoinGeckoTokens(
      { susds: { usd_market_cap: 0 } },
      undefined,
      undefined,
      undefined,
      undefined,
      previousAssetsById,
    );

    const susds = result.find((asset) => asset.id === "susds-sky");
    expect(susds).toMatchObject({
      id: "susds-sky",
      price: null,
      circulating: { peggedUSD: 3_120_000 },
      chainCirculating: { Ethereum: { current: 3_120_000, chainId: "ethereum" } },
    });
    expect(susds?.priceSource).toBeUndefined();
    expect(susds?.supplyObservedAt).toBeGreaterThan(Math.floor(Date.now() / 1000) - 10);
  });

  it("keeps the NAV token out when the supply fallback resolves nothing", async () => {
    fetchWithRetryMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ coins: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const previousAssetsById = new Map([["usdc-circle", { id: "usdc-circle", name: "USDC", symbol: "USDC" }]]);

    const result = await fetchFiatCoinGeckoTokens(
      {
        susds: { usd_market_cap: 0 },
        // FIUSD is a second NAV fixture now; keep its market-price lane observed
        // so this case isolates the missing-price protocol fallback for sUSDS.
        "sygnum-fiusd-liquidity-fund": {
          usd: 12_048.93,
          last_updated_at: Math.floor(Date.now() / 1000),
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      previousAssetsById,
    );

    expect(result).toEqual([]);
    expect(resolveVaultNavSupplyPriceMock).toHaveBeenCalledTimes(1);
  });
});
