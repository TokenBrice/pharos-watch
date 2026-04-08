import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../dex-liquidity/crawl-helpers", () => ({
  crawlTokenPools: vi.fn().mockResolvedValue({ stoppedEarly: false }),
}));

vi.mock("../../../lib/coingecko-onchain", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/coingecko-onchain")>("../../../lib/coingecko-onchain");
  return {
    ...actual,
    fetchCgTokenPools: vi.fn(async () => []),
  };
});

vi.mock("../../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(),
}));

vi.mock("../../../lib/dexscreener", () => ({
  fetchDsTokenPools: vi.fn(),
  dsRateLimit: vi.fn().mockResolvedValue(undefined),
  getDsTrackedTokenPriceUsd: vi.fn((pair: { baseToken: { address: string }; priceUsd: string | null }, trackedAddress: string) => ({
    side: pair.baseToken.address?.toLowerCase() === trackedAddress.toLowerCase() ? "base" : null,
    priceUsd: pair.priceUsd != null ? Number(pair.priceUsd) : null,
  })),
}));

import { crawlCoin } from "../crawl-sources";
import { crawlTokenPools } from "../../dex-liquidity/crawl-helpers";
import { fetchDsTokenPools } from "../../../lib/dexscreener";
import { fetchCgTokenPools } from "../../../lib/coingecko-onchain";
import { fetchWithRetry } from "../../../lib/fetch-retry";
import { QUALITY_MULTIPLIERS } from "../../../lib/dex-constants";

describe("crawlCoin DexScreener hardening", () => {
  beforeEach(() => {
    vi.mocked(crawlTokenPools).mockResolvedValue({ stoppedEarly: false });
    vi.mocked(fetchDsTokenPools).mockReset();
    vi.mocked(fetchCgTokenPools).mockReset();
    vi.mocked(fetchWithRetry).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips malformed DexScreener pairs and keeps valid pairs in the same response", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.mocked(fetchDsTokenPools).mockResolvedValueOnce([
      {
        chainId: "ethereum",
        dexId: "uniswap-v3",
        pairAddress: "0xbadpool",
        labels: ["V3"],
        baseToken: { address: undefined, name: "Broken Token", symbol: "BROKE" },
        quoteToken: { address: "0xquote", name: "USD Coin", symbol: "USDC" },
        priceUsd: "1.00",
        volume: { h24: 12_000, h6: 0, h1: 0, m5: 0 },
        liquidity: { usd: 60_000, base: 0, quote: 0 },
        pairCreatedAt: null,
      } as never,
      {
        chainId: "ethereum",
        dexId: "uniswap-v3",
        pairAddress: "0xgoodpool",
        labels: ["V3"],
        baseToken: { address: "0xabc", name: "Test USD", symbol: "TUSD" },
        quoteToken: { address: "0xquote", name: "USD Coin", symbol: "USDC" },
        priceUsd: "1.00",
        volume: { h24: 15_000, h6: 0, h1: 0, m5: 0 },
        liquidity: { usd: 75_000, base: 0, quote: 0 },
        pairCreatedAt: null,
      } as never,
    ]);

    const result = await crawlCoin(
      "test-coin",
      [{ chain: "ethereum", address: "0xAbC", decimals: 18 }],
      null,
      new Set(),
    );

    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]?.poolId).toBe("ethereum:0xgoodpool");
    expect(result.priceObs).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[dex-discovery] dexscreener malformed pair for ethereum:0xAbC"),
      expect.objectContaining({
        pairAddress: "0xbadpool",
        dexId: "uniswap-v3",
        baseToken: null,
        quoteToken: "0xquote",
      }),
    );
  });

  it("downgrades DexScreener target errors to warnings instead of failing the coin crawl", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.mocked(fetchDsTokenPools).mockRejectedValueOnce(new Error("DexScreener boom"));

    const result = await crawlCoin(
      "test-coin",
      [{ chain: "ethereum", address: "0xabc", decimals: 18 }],
      null,
      new Set(),
    );

    expect(result).toEqual({ pools: [], priceObs: [], unresolvedChains: [] });
    expect(warnSpy).toHaveBeenCalledWith("[dex-discovery] dexscreener error for ethereum:0xabc", expect.any(Error));
  });

  it("keeps CoinGecko onchain staging output aligned with current discovery rows", async () => {
    vi.mocked(fetchCgTokenPools).mockResolvedValueOnce([{
      id: "cg-pool",
      type: "pool",
      attributes: {
        address: "0xPool",
        name: "USDC / USDT",
        pool_created_at: "2025-01-01T00:00:00.000Z",
        base_token_price_usd: "1.0002",
        quote_token_price_usd: "0.9999",
        reserve_in_usd: "220000",
        h24_volume_usd: "18000",
        pool_fee_percentage: "0.01",
        locked_liquidity_percentage: "25",
      },
      relationships: {
        base_token: { data: { id: "token_0xabc", type: "token" } },
        quote_token: { data: { id: "token_0xquote", type: "token" } },
        dex: { data: { id: "uniswap-v3", type: "dex" } },
      },
    } as never]);

    const result = await crawlCoin(
      "usdc-circle",
      [{ chain: "ethereum", address: "0xAbC", decimals: 6 }],
      "test-key",
      new Set(),
    );

    expect(result.unresolvedChains).toEqual([]);
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]).toMatchObject({
      poolId: "ethereum:0xpool",
      stablecoinId: "usdc-circle",
      source: "cg_onchain",
      chain: "ethereum",
      protocol: "uniswap-v3",
      dexId: "uniswap-v3",
      symbol: "USDC / USDT",
      tvlUsd: 220000,
      volume24h: 18000,
      qualityMultiplier: QUALITY_MULTIPLIERS["uniswap-v3-1bp"],
      poolType: "cg-cl-1bp",
      feeTier: 1,
      balanceRatio: expect.closeTo(0.9997000599880024, 8),
      baseToken: "0xabc",
      quoteToken: "0xquote",
      quoteSymbol: null,
      priceUsd: 1.0002,
      lockedLiqPct: 25,
    });
    expect(result.priceObs).toEqual([{
      stablecoinId: "usdc-circle",
      price: 1.0002,
      tvl: 220000,
      chain: "ethereum",
      protocol: "uniswap-v3",
    }]);
  });

  it("keeps CoinGecko tickers staging output aligned with current orderbook rows", async () => {
    vi.mocked(fetchDsTokenPools).mockResolvedValue([]);
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(new Response(JSON.stringify({
      tickers: [{
        base: "USDC",
        target: "USD",
        market: { name: "Kinesis", identifier: "kinesis" },
        converted_last: { usd: 1.001 },
        converted_volume: { usd: 20_000 },
        target_coin_id: undefined,
        is_anomaly: false,
        is_stale: false,
        trust_score: null,
      }, {
        base: "USDC",
        target: "USDT",
        market: { name: "Kinesis", identifier: "kinesis" },
        converted_last: { usd: 0.999 },
        converted_volume: { usd: 10_000 },
        target_coin_id: "tether",
        is_anomaly: false,
        is_stale: false,
        trust_score: null,
      }],
    }), { status: 200 }));

    const result = await crawlCoin(
      "usdc-circle",
      [{ chain: "ethereum", address: "0xabc", decimals: 6 }],
      null,
      new Set(),
    );

    expect(result.pools).toEqual([{
      poolId: "orderbook:kinesis:usdc-circle",
      stablecoinId: "usdc-circle",
      source: "cg_tickers",
      chain: "orderbook",
      protocol: "kinesis",
      dexId: "kinesis",
      symbol: "USDC / USD",
      tvlUsd: 90_000,
      volume24h: 30_000,
      qualityMultiplier: QUALITY_MULTIPLIERS["orderbook"],
      poolType: "orderbook",
      feeTier: null,
      balanceRatio: null,
      isStable: null,
      baseToken: null,
      quoteToken: null,
      quoteSymbol: "USD",
      priceUsd: (1.001 * 20_000 + 0.999 * 10_000) / 30_000,
      lockedLiqPct: null,
      rawJson: null,
      discoveredAt: expect.any(Number),
      refreshedAt: expect.any(Number),
    }]);
    expect(result.priceObs).toEqual([{
      stablecoinId: "usdc-circle",
      price: (1.001 * 20_000 + 0.999 * 10_000) / 30_000,
      tvl: 90_000,
      chain: "orderbook",
      protocol: "cg-ticker-kinesis",
    }]);
  });
});
