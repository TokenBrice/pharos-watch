import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockRegistry } from "../../../../test-helpers/cron";

const fetchWithRetryMock = vi.fn();
const probeTrackedTokenSupplyMock = vi.fn();
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
    resolveVaultNavSupplyPriceMock.mockReset().mockResolvedValue(null);
  });

  it("prefers curated aggregate on-chain supply over stale CoinGecko market cap for ftUSD", async () => {
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
        last_updated_at: nowSec,
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "ftusd-flying-tulip",
      supplySource: "onchain-total-supply",
      circulating: { peggedUSD: 1_922_317.826195 },
      chainCirculating: {
        Ethereum: {
          current: 1_884_739.402999,
          circulatingPrevDay: 0,
          circulatingPrevWeek: 0,
          circulatingPrevMonth: 0,
        },
        Sonic: {
          current: 37_578.423196,
          circulatingPrevDay: 0,
          circulatingPrevWeek: 0,
          circulatingPrevMonth: 0,
        },
      },
    });
    expect(probeTrackedTokenSupplyMock).toHaveBeenCalledTimes(2);
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

    expect(resolveVaultNavSupplyPriceMock).toHaveBeenCalledWith("susds-sky", previousAssetsById, undefined, undefined);
    const susds = result.find((asset) => asset.id === "susds-sky");
    expect(susds).toMatchObject({
      id: "susds-sky",
      price: null,
      circulating: { peggedUSD: 3_120_000 },
    });
    expect(susds?.priceSource).toBeUndefined();
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
      { susds: { usd_market_cap: 0 } },
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
