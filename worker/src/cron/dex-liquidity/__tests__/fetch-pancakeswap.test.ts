import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAY_SECONDS } from "@shared/lib/time-constants";

vi.mock("../../../lib/fetch-retry", () => ({
  fetchTextWithRetry: vi.fn(),
}));

import { fetchTextWithRetry } from "../../../lib/fetch-retry";
import { buildPancakePageSkips, fetchPancakeSwapPools } from "../fetch-pancakeswap";

describe("fetchPancakeSwapPools", () => {
  it("refreshes the head and rotates a persisted bounded tail", () => {
    expect(buildPancakePageSkips(null)).toEqual([0, 250, 500]);
    expect(buildPancakePageSkips("1250")).toEqual([0, 1250, 1500]);
  });

  function response(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200 });
  }

  async function textResult(response: Response) {
    return { response, body: await response.text() };
  }

  function makePool(id: string, feeTier = "100") {
    return {
      id,
      feeTier,
      totalValueLockedUSD: "125000",
      totalValueLockedToken0: "62500",
      totalValueLockedToken1: "62500",
      token0Price: "1",
      token1Price: "1",
      token0: { id: `${id}-usdc`, symbol: "USDC", decimals: "6" },
      token1: { id: `${id}-usdt`, symbol: "USDT", decimals: "6" },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("normalizes v3 pools and sums hourly trailing volume across a UTC boundary", async () => {
    const now = new Date("2026-04-08T13:37:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const currentHourStart = Math.floor(now.getTime() / 1000 / 3600) * 3600;
    const oldestIncludedHourStart = currentHourStart - DAY_SECONDS;

    vi.mocked(fetchTextWithRetry)
      .mockImplementationOnce(async () => textResult(response({
        data: {
          pools: [makePool("0xpool")],
        },
      })))
      .mockImplementationOnce(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.query).toContain("poolHourDatas");
        expect(body.query).not.toContain("poolDayDatas");
        expect(body.query).toContain(`periodStartUnix_gt: ${oldestIncludedHourStart}`);
        expect(body.query).toContain(`periodStartUnix_lte: ${currentHourStart}`);
        return textResult(response({
          data: {
            poolHourDatas: [
              { periodStartUnix: currentHourStart, volumeUSD: "15000", pool: { id: "0xpool" } },
              { periodStartUnix: currentHourStart - 13 * 3600, volumeUSD: "25000", pool: { id: "0xpool" } },
              { periodStartUnix: currentHourStart - 23 * 3600, volumeUSD: "10000", pool: { id: "0xpool" } },
            ],
          },
        }));
      })
      .mockImplementation(async () => textResult(response({ data: { pools: [] } })));

    const result = await fetchPancakeSwapPools("graph-key");

    expect(result.ok).toBe(true);
    expect(result.pools.length).toBeGreaterThan(0);
    const pool = result.pools[0]!;
    expect(pool.source).toBe("pancakeswap");
    expect(pool.poolType).toBe("pancakeswap-v3-1bp");
    expect(pool.volume24hUsd).toBe(50000);
    expect(pool.feeRate).toBeCloseTo(0.0001);
  });

  it("keeps pool coverage when the hourly volume query fails for a page", async () => {
    vi.mocked(fetchTextWithRetry)
      .mockImplementationOnce(async () => textResult(response({
        data: {
          pools: [makePool("0xpool", "500")],
        },
      })))
      .mockImplementationOnce(async () => {
        throw new Error("hourdata timeout");
      })
      .mockImplementation(async () => textResult(response({ data: { pools: [] } })));

    const result = await fetchPancakeSwapPools("graph-key");

    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.errors).toHaveLength(0);
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]?.volume24hUsd).toBe(0);
  });

  it("batches hourly lookups to stay under the subgraph row cap and sums per-pool rows", async () => {
    const pagePools = Array.from({ length: 41 }, (_, index) => makePool(`0xpool${index}`));

    vi.mocked(fetchTextWithRetry)
      .mockImplementationOnce(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.query).toContain("first: 250");
        return textResult(response({ data: { pools: pagePools } }));
      })
      .mockImplementationOnce(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.query).toContain("poolHourDatas");
        expect(body.query).toContain("\"0xpool0\"");
        expect(body.query).toContain("\"0xpool39\"");
        expect(body.query).not.toContain("\"0xpool40\"");
        return textResult(response({
          data: {
            poolHourDatas: [
              { periodStartUnix: 1_700_000_000, volumeUSD: "1000", pool: { id: "0xpool0" } },
              { periodStartUnix: 1_699_996_400, volumeUSD: "500", pool: { id: "0xpool0" } },
            ],
          },
        }));
      })
      .mockImplementationOnce(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.query).toContain("\"0xpool40\"");
        return textResult(response({
          data: {
            poolHourDatas: [
              { periodStartUnix: 1_700_000_000, volumeUSD: "2000", pool: { id: "0xpool40" } },
            ],
          },
        }));
      })
      .mockImplementation(async () => textResult(response({ data: { pools: [] } })));

    const result = await fetchPancakeSwapPools("graph-key");

    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.pools).toHaveLength(41);
    expect(result.pools[0]?.volume24hUsd).toBe(1500);
    expect(result.pools[40]?.volume24hUsd).toBe(2000);
  });

  it("surfaces non-json 200 responses as degraded diagnostics instead of throwing a raw parse error", async () => {
    vi.mocked(fetchTextWithRetry)
      .mockImplementationOnce(async () =>
        textResult(new Response("GET,HEAD", {
          status: 200,
          headers: { "content-type": "text/plain" },
        })))
      .mockImplementation(async () => textResult(response({ data: { pools: [] } })));

    const result = await fetchPancakeSwapPools("graph-key");

    // The BSC source failed, while the remaining chain heads completed as valid-empty.
    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.errors[0]).toContain("invalid-json");
    expect(result.errors[0]).toContain("GET,HEAD");
  });
});
