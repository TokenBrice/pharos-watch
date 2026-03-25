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
    expect(result.degraded).toBe(false);
    expect(result.errors).toHaveLength(0);
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]?.volume24hUsd).toBe(0);
  });

  it("batches dayData lookups so one page can make multiple volume requests", async () => {
    const pagePools = Array.from({ length: 51 }, (_, index) => ({
      id: `0xpool${index}`,
      feeTier: "100",
      totalValueLockedUSD: "125000",
      totalValueLockedToken0: "62500",
      totalValueLockedToken1: "62500",
      token0Price: "1",
      token1Price: "1",
      token0: { id: `0xusdc${index}`, symbol: "USDC", decimals: "6" },
      token1: { id: `0xusdt${index}`, symbol: "USDT", decimals: "6" },
    }));

    vi.mocked(fetchWithRetry)
      .mockImplementationOnce(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.query).toContain("first: 250");
        return response({ data: { pools: pagePools } });
      })
      .mockImplementationOnce(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.query).toContain("pool_in");
        expect(body.query).toContain("\"0xpool0\"");
        expect(body.query).toContain("\"0xpool49\"");
        expect(body.query).not.toContain("\"0xpool50\"");
        return response({ data: { poolDayDatas: [{ date: 1_700_000_000, volumeUSD: "1000", pool: { id: "0xpool0" } }] } });
      })
      .mockImplementationOnce(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.query).toContain("\"0xpool50\"");
        return response({ data: { poolDayDatas: [{ date: 1_700_000_000, volumeUSD: "2000", pool: { id: "0xpool50" } }] } });
      })
      .mockImplementation(async () => response({ data: { pools: [] } }));

    const result = await fetchPancakeSwapPools("graph-key");

    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.pools).toHaveLength(51);
    expect(result.pools[0]?.volume24hUsd).toBe(1000);
    expect(result.pools[50]?.volume24hUsd).toBe(2000);
  });
});
