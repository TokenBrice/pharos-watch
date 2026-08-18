import { describe, expect, it, vi } from "vitest";
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
});
