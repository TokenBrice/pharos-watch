import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(),
}));

import { fetchWithRetry } from "../../../lib/fetch-retry";
import { fetchPancakeSwapPools } from "../fetch-pancakeswap";

describe("fetchPancakeSwapPools", () => {
  function response(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200 });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes v3 pools and latest daily volume", async () => {
    vi.mocked(fetchWithRetry)
      .mockImplementationOnce(async () => response({
        data: {
          pools: [{
            id: "0xpool",
            feeTier: "100",
            totalValueLockedUSD: "125000",
            totalValueLockedToken0: "62500",
            totalValueLockedToken1: "62500",
            token0Price: "1",
            token1Price: "1",
            token0: { id: "0xusdc", symbol: "USDC", decimals: "6" },
            token1: { id: "0xusdt", symbol: "USDT", decimals: "6" },
          }],
        },
      }))
      .mockImplementationOnce(async () => response({
        data: {
          poolDayDatas: [{
            date: 1_700_000_000,
            volumeUSD: "50000",
            pool: { id: "0xpool" },
          }],
        },
      }))
      .mockImplementation(async () => response({ data: { pools: [] } }));

    const result = await fetchPancakeSwapPools("graph-key");

    expect(result.ok).toBe(true);
    expect(result.pools.length).toBeGreaterThan(0);
    const pool = result.pools[0]!;
    expect(pool.source).toBe("pancakeswap");
    expect(pool.poolType).toBe("pancakeswap-v3-1bp");
    expect(pool.volume24hUsd).toBe(50000);
    expect(pool.feeRate).toBeCloseTo(0.0001);
  });

  it("keeps pool coverage when the dayData query fails for a page", async () => {
    vi.mocked(fetchWithRetry)
      .mockImplementationOnce(async () => response({
        data: {
          pools: [{
            id: "0xpool",
            feeTier: "500",
            totalValueLockedUSD: "125000",
            totalValueLockedToken0: "62500",
            totalValueLockedToken1: "62500",
            token0Price: "1",
            token1Price: "1",
            token0: { id: "0xusdc", symbol: "USDC", decimals: "6" },
            token1: { id: "0xusdt", symbol: "USDT", decimals: "6" },
          }],
        },
      }))
      .mockImplementationOnce(async () => {
        throw new Error("daydata timeout");
      })
      .mockImplementation(async () => response({ data: { pools: [] } }));

    const result = await fetchPancakeSwapPools("graph-key");

    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.errors.some((entry) => entry.includes("dayData"))).toBe(true);
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]?.volume24hUsd).toBe(0);
  });
});
