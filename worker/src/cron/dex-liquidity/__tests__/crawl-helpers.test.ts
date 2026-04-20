import { describe, expect, it } from "vitest";
import { crawlTokenPools, type CrawlStats } from "../crawl-helpers";
import type { GtNewPool } from "../types";

interface RawPool {
  id: string;
  tvlUsd: number;
  price: number;
}

function makeStats(): CrawlStats {
  return {
    requests: 0,
    poolsSeen: 0,
    poolsNew: 0,
    poolsSkippedCurve: 0,
    poolsSkippedKnown: 0,
    poolsSkippedRatio: 0,
  };
}

describe("crawlTokenPools", () => {
  it("stops before a request when beforeRequest returns false", async () => {
    const stats = makeStats();
    const result = await crawlTokenPools<RawPool, GtNewPool>({
      sourceLabel: "test",
      tokens: [{ sourceChain: "eth", ourChain: "ethereum", address: "0xabc", stablecoinId: "usdc-circle" }],
      chainAddressToId: new Map(),
      knownPoolAddrs: new Set(),
      protocolTvlCaps: new Map(),
      newPools: new Map(),
      priceObs: new Map(),
      stats,
      beforeRequest: async () => false,
      fetchPools: async () => {
        throw new Error("should not fetch");
      },
      parsePool: () => null,
      buildNewPool: () => ({} as GtNewPool),
    });

    expect(result.stoppedEarly).toBe(true);
    expect(stats.requests).toBe(0);
  });

  it("adds new pools and price observations for matching stablecoin side", async () => {
    const stats = makeStats();
    const newPools = new Map<string, GtNewPool[]>();
    const priceObs = new Map();
    const result = await crawlTokenPools<RawPool, GtNewPool>({
      sourceLabel: "test",
      tokens: [{ sourceChain: "eth", ourChain: "ethereum", address: "0xstable", stablecoinId: "usdc-circle" }],
      chainAddressToId: new Map([["ethereum:0xstable", "usdc-circle"]]),
      knownPoolAddrs: new Set(),
      protocolTvlCaps: new Map([["testdex", 50_000]]),
      newPools,
      priceObs,
      stats,
      fetchPools: async () => [{ id: "pool-a", tvlUsd: 100_000, price: 1 }],
      parsePool: (pool) => ({
        dexId: "testdex",
        poolAddress: pool.id,
        tvlUsd: pool.tvlUsd,
        volume24hUsd: 10_000,
        baseTokenAddress: "0xstable",
        quoteTokenAddress: "0xref",
        baseTokenPriceUsd: pool.price,
        quoteTokenPriceUsd: 1,
        createdAt: "2026-01-01T00:00:00Z",
        poolName: "USDC / USD",
      }),
      buildNewPool: ({ cappedTvlUsd, price }) => ({
        address: "pool-a",
        project: "testdex",
        chain: "ethereum",
        dexId: "testdex",
        name: "USDC / USD",
        symbol: "USDC / USD",
        tvlUsd: cappedTvlUsd,
        volume24hUsd: 10_000,
        qualityMultiplier: 1,
        maturityDays: 1,
        price,
        poolType: "generic",
        sourceFamily: "gecko_terminal",
      }),
    });

    expect(result.stoppedEarly).toBe(false);
    expect(stats.poolsSeen).toBe(1);
    expect(stats.poolsNew).toBe(1);
    expect(newPools.get("usdc-circle")?.[0]?.tvlUsd).toBe(50_000);
    expect(priceObs.get("usdc-circle")).toHaveLength(1);
  });
});
