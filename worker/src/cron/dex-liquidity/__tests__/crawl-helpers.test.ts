import { describe, expect, it } from "vitest";
import {
  crawlTokenPools,
  getChainAwareDsTrackedTokenPriceUsd,
  shouldSkipFallbackCurvePool,
  type CrawlStats,
} from "../crawl-helpers";
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
  it("skips fallback Curve pools only when the native Curve API covers that chain", () => {
    expect(shouldSkipFallbackCurvePool("ethereum", "curve")).toBe(true);
    expect(shouldSkipFallbackCurvePool("base", "curve-stable-swap")).toBe(true);
    expect(shouldSkipFallbackCurvePool("plasma", "curve-plasma")).toBe(false);
    expect(shouldSkipFallbackCurvePool("plasma", "balancer-v3-plasma")).toBe(false);
  });

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
      buildNewPool: () => ({}) as GtNewPool,
    });

    expect(result.stoppedEarly).toBe(true);
    expect(stats.requests).toBe(0);
  });

  it("keeps native-covered Curve pools out of secondary discovery", async () => {
    const stats = makeStats();
    const newPools = new Map<string, GtNewPool[]>();
    const priceObs = new Map();
    const result = await crawlTokenPools<RawPool, GtNewPool>({
      sourceLabel: "test",
      tokens: [{ sourceChain: "eth", ourChain: "ethereum", address: "0xstable", stablecoinId: "usdc-circle" }],
      chainAddressToId: new Map([["ethereum:0xstable", "usdc-circle"]]),
      knownPoolAddrs: new Set(),
      protocolTvlCaps: new Map(),
      newPools,
      priceObs,
      stats,
      fetchPools: async () => [{ id: "pool-a", tvlUsd: 100_000, price: 1 }],
      parsePool: (pool) => ({
        dexId: "curve",
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
      buildNewPool: () => {
        throw new Error("should not build");
      },
    });

    expect(result.stoppedEarly).toBe(false);
    expect(stats.poolsSeen).toBe(1);
    expect(stats.poolsSkippedCurve).toBe(1);
    expect(stats.poolsNew).toBe(0);
    expect(newPools.size).toBe(0);
    expect(priceObs.size).toBe(0);
  });

  it("accepts fallback Curve pools on chains without native Curve API coverage", async () => {
    const stats = makeStats();
    const newPools = new Map<string, GtNewPool[]>();
    const priceObs = new Map();
    const result = await crawlTokenPools<RawPool, GtNewPool>({
      sourceLabel: "test",
      tokens: [{ sourceChain: "plasma", ourChain: "plasma", address: "0xstable", stablecoinId: "yzusd-yuzu" }],
      chainAddressToId: new Map([["plasma:0xstable", "yzusd-yuzu"]]),
      knownPoolAddrs: new Set(),
      protocolTvlCaps: new Map([["curve", 800_000]]),
      newPools,
      priceObs,
      stats,
      fetchPools: async () => [{ id: "0xpool", tvlUsd: 900_000, price: 0.9973 }],
      parsePool: (pool) => ({
        dexId: "curve-plasma",
        poolAddress: pool.id,
        tvlUsd: pool.tvlUsd,
        volume24hUsd: 20_000,
        baseTokenAddress: "0xstable",
        quoteTokenAddress: "0xref",
        baseTokenPriceUsd: pool.price,
        quoteTokenPriceUsd: 1,
        createdAt: "2026-01-01T00:00:00Z",
        poolName: "yzUSD / USDT0",
      }),
      buildNewPool: ({ cappedTvlUsd, price }) => ({
        address: "0xpool",
        project: "curve-plasma",
        chain: "plasma",
        dexId: "curve-plasma",
        name: "yzUSD / USDT0",
        symbol: "yzUSD / USDT0",
        tvlUsd: cappedTvlUsd,
        volume24hUsd: 20_000,
        qualityMultiplier: 1,
        maturityDays: 1,
        price,
        poolType: "gt-amm",
        sourceFamily: "gecko_terminal",
      }),
    });

    expect(result.stoppedEarly).toBe(false);
    expect(stats.poolsSeen).toBe(1);
    expect(stats.poolsSkippedCurve).toBe(0);
    expect(stats.poolsNew).toBe(1);
    expect(newPools.get("yzusd-yuzu")?.[0]).toMatchObject({
      chain: "plasma",
      dexId: "curve-plasma",
      tvlUsd: 800_000,
      price: 0.9973,
    });
    expect(priceObs.get("yzusd-yuzu")).toEqual([
      { price: 0.9973, tvl: 900_000, chain: "plasma", protocol: "curve-plasma" },
    ]);
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

  it("skips secondary-source pools with implausible tracked token prices", async () => {
    const stats = makeStats();
    const newPools = new Map<string, GtNewPool[]>();
    const priceObs = new Map();
    const result = await crawlTokenPools<RawPool, GtNewPool>({
      sourceLabel: "test",
      tokens: [{ sourceChain: "eth", ourChain: "ethereum", address: "0xstable", stablecoinId: "usdc-circle" }],
      chainAddressToId: new Map([["ethereum:0xstable", "usdc-circle"]]),
      knownPoolAddrs: new Set(),
      protocolTvlCaps: new Map(),
      newPools,
      priceObs,
      stats,
      fetchPools: async () => [{ id: "pool-a", tvlUsd: 2_000_000_000, price: 500 }],
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
      buildNewPool: () => {
        throw new Error("should not build");
      },
    });

    expect(result.stoppedEarly).toBe(false);
    expect(stats.poolsSeen).toBe(1);
    expect(stats.poolsNew).toBe(0);
    expect(newPools.size).toBe(0);
    expect(priceObs.size).toBe(0);
  });

  it("does not collapse case-distinct non-EVM token identities", async () => {
    const pair = {
      baseToken: { address: "MintCase" },
      quoteToken: { address: "QuoteCase" },
      priceUsd: "1",
      priceNative: "1",
    } as never;
    expect(getChainAwareDsTrackedTokenPriceUsd(pair, "mintCase", "solana")).toEqual({
      side: null,
      priceUsd: null,
    });
    expect(getChainAwareDsTrackedTokenPriceUsd(pair, "mintCase", "ethereum")).toEqual({
      side: "base",
      priceUsd: 1,
    });

    const stats = makeStats();
    const newPools = new Map<string, GtNewPool[]>();
    await crawlTokenPools<RawPool, GtNewPool>({
      sourceLabel: "test",
      tokens: [{ sourceChain: "solana", ourChain: "solana", address: "MintCase", stablecoinId: "test" }],
      chainAddressToId: new Map([["solana:MintCase", "test"]]),
      knownPoolAddrs: new Set(),
      protocolTvlCaps: new Map(),
      newPools,
      priceObs: new Map(),
      stats,
      fetchPools: async () => [{ id: "PoolCase", tvlUsd: 100_000, price: 1 }],
      parsePool: (pool) => ({
        dexId: "testdex",
        poolAddress: pool.id,
        tvlUsd: pool.tvlUsd,
        volume24hUsd: 10_000,
        baseTokenAddress: "mintCase",
        quoteTokenAddress: "QuoteCase",
        baseTokenPriceUsd: pool.price,
        quoteTokenPriceUsd: 1,
        createdAt: null,
        poolName: "TEST / QUOTE",
      }),
      buildNewPool: () => {
        throw new Error("case-distinct mint must not match");
      },
    });

    expect(stats.poolsNew).toBe(0);
    expect(newPools.size).toBe(0);
  });
});
