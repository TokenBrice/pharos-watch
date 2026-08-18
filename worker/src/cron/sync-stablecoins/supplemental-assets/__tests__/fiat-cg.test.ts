import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockRegistry } from "../../../../test-helpers/cron";

const fetchWithRetryMock = vi.fn();
const probeTrackedTokenSupplyMock = vi.fn();

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
      id: "singlecg-single-chain",
      name: "Single Chain CG USD",
      symbol: "sglUSD",
      geckoId: "single-chain-cg-usd",
      detailProvider: "coingecko",
      contracts: [
        { chain: "ethereum", address: "0x111111111111111111111111111111111111feed", decimals: 18 },
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
      id: "multicg-multi-chain",
      name: "Multi Chain CG USD",
      symbol: "mltUSD",
      geckoId: "multi-chain-cg-usd",
      detailProvider: "coingecko",
      contracts: [
        { chain: "ethereum", address: "0x222222222222222222222222222222222222feed", decimals: 18 },
        { chain: "sonic", address: "0x333333333333333333333333333333333333feed", decimals: 18 },
      ],
      flags: {
        pegCurrency: "USD",
        backing: "crypto-backed",
        governance: "centralized-dependent",
        yieldBearing: false,
        navToken: false,
      },
    },
  ],
}));

vi.mock("../../../../lib/fetch-retry", () => ({
  fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
}));

vi.mock("../../../reserve-adapters/helpers", () => ({
  fetchOnchainUint256: vi.fn(),
  probeTrackedTokenSupply: (...args: unknown[]) => probeTrackedTokenSupplyMock(...args),
}));

import { fetchFiatCoinGeckoTokens } from "../fiat-cg";

describe("fetchFiatCoinGeckoTokens", () => {
  beforeEach(() => {
    fetchWithRetryMock.mockReset();
    probeTrackedTokenSupplyMock.mockReset();
  });

  it("prefers curated aggregate on-chain supply over stale CoinGecko market cap for ftUSD", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    fetchWithRetryMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ coins: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    probeTrackedTokenSupplyMock.mockImplementation(async (meta, input) => {
      if (meta.id !== "ftusd-flying-tulip") return null;
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
    // The registry also carries singlecg-/multicg- fixtures used below; their
    // on-chain fallback probes resolve to null via the meta.id guard above, so
    // only ftUSD's two curated-aggregate legs are genuine supply reads.
    expect(probeTrackedTokenSupplyMock.mock.calls.filter(([meta]) => meta.id === "ftusd-flying-tulip")).toHaveLength(2);
  });

  it("attributes a CoinGecko aggregate to the single probeable deployment", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    fetchWithRetryMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ coins: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    probeTrackedTokenSupplyMock.mockResolvedValue(null);

    const result = await fetchFiatCoinGeckoTokens({
      "single-chain-cg-usd": {
        usd: 1,
        usd_market_cap: 500_000,
        last_updated_at: nowSec,
      },
    });

    const asset = result.find((token) => token.id === "singlecg-single-chain");
    expect(asset).toMatchObject({
      supplySource: "coingecko-fallback",
      circulating: { peggedUSD: 500_000 },
    });
    expect(asset?.chainCirculating).toEqual({
      Ethereum: {
        current: 500_000,
        circulatingPrevDay: 0,
        circulatingPrevWeek: 0,
        circulatingPrevMonth: 0,
      },
    });
  });

  it("leaves chainCirculating empty for multi-contract assets without a curated aggregate", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    fetchWithRetryMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ coins: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    probeTrackedTokenSupplyMock.mockResolvedValue(null);

    const result = await fetchFiatCoinGeckoTokens({
      "multi-chain-cg-usd": {
        usd: 1,
        usd_market_cap: 300_000,
        last_updated_at: nowSec,
      },
    });

    const asset = result.find((token) => token.id === "multicg-multi-chain");
    expect(asset).toMatchObject({
      supplySource: "coingecko-fallback",
      circulating: { peggedUSD: 300_000 },
    });
    expect(asset?.chainCirculating).toEqual({});
  });
});
