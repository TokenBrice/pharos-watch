import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../dex-liquidity/crawl-helpers", () => ({
  crawlTokenPools: vi.fn().mockResolvedValue({ stoppedEarly: false }),
}));

vi.mock("../../../lib/dexscreener", () => ({
  fetchDsTokenPools: vi.fn(),
  dsRateLimit: vi.fn().mockResolvedValue(undefined),
}));

import { crawlCoin } from "../crawl-sources";
import { crawlTokenPools } from "../../dex-liquidity/crawl-helpers";
import { fetchDsTokenPools } from "../../../lib/dexscreener";

describe("crawlCoin DexScreener hardening", () => {
  beforeEach(() => {
    vi.mocked(crawlTokenPools).mockResolvedValue({ stoppedEarly: false });
    vi.mocked(fetchDsTokenPools).mockReset();
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

    expect(result).toEqual({ pools: [], priceObs: [] });
    expect(warnSpy).toHaveBeenCalledWith("[dex-discovery] dexscreener error for ethereum:0xabc", expect.any(Error));
  });
});
