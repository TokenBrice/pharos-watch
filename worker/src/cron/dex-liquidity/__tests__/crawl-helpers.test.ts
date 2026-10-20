import { describe, expect, it, vi } from "vitest";
import {
  crawlTokenPools,
  shouldSkipFallbackCurvePool,
} from "../crawl-helpers";
import type { GtNewPool, GtPool } from "../types";
import { parseGtPool } from "../geckoterminal-shared";
import * as structuredLog from "../../../lib/structured-log";

interface RawPool {
  id: string;
  tvlUsd: number;
  price: number;
}

describe("crawlTokenPools", () => {
  it("skips fallback Curve pools only when the native Curve API covers that chain", () => {
    expect(shouldSkipFallbackCurvePool("ethereum", "curve")).toBe(true);
    expect(shouldSkipFallbackCurvePool("base", "curve-stable-swap")).toBe(true);
    expect(shouldSkipFallbackCurvePool("plasma", "curve-plasma")).toBe(false);
    expect(shouldSkipFallbackCurvePool("plasma", "balancer-v3-plasma")).toBe(false);
  });

  it("does not turn provider numeric prefixes into crawler TVL, prices or volume", async () => {
    const fixture = (address: string, fields: Partial<GtPool["attributes"]>): GtPool => ({
      id: address, type: "pool",
      attributes: {
        address, name: "USDC / USD", pool_created_at: "2026-01-01T00:00:00Z",
        reserve_in_usd: "100000.25", base_token_price_usd: "1.001",
        quote_token_price_usd: "1", volume_usd: { h24: "0" }, ...fields,
      },
      relationships: {
        base_token: { data: { id: "ethereum_0xstable", type: "token" } },
        quote_token: { data: { id: "ethereum_0xref", type: "token" } },
        dex: { data: { id: "testdex", type: "dex" } },
      },
    });
    const newPools = new Map<string, GtNewPool[]>();
    const priceObs = new Map();
    await crawlTokenPools<GtPool, GtNewPool>({
      sourceLabel: "GT", tokens: [
        { sourceChain: "eth", ourChain: "ethereum", address: "0xstable", stablecoinId: "usdc-circle" },
      ],
      chainAddressToId: new Map([["ethereum:0xstable", "usdc-circle"]]),
      knownPoolAddrs: new Set(), protocolTvlCaps: new Map(), newPools, priceObs,
      fetchPools: async () => ({
        rows: [
          fixture("0xbadtvl", { reserve_in_usd: "100000usd" }),
          fixture("0xbadprice", { base_token_price_usd: "1.001usd" }),
          fixture("0xbadvolume", { volume_usd: { h24: "100usd" } }),
          fixture("0xvalid", {}),
        ], complete: true, cappedAtMaxPages: false, failedAfterRows: null,
      }),
      parsePool: parseGtPool,
      buildNewPool: ({ parsed, price }) => ({
        address: parsed.poolAddress, project: parsed.dexId, chain: "ethereum", dexId: parsed.dexId,
        name: parsed.poolName, symbol: parsed.poolName, tvlUsd: parsed.tvlUsd,
        volume24hUsd: parsed.volume24hUsd, qualityMultiplier: 1, maturityDays: 1,
        price, poolType: "generic", sourceFamily: "gecko_terminal",
      }),
    });
    const admitted = newPools.get("usdc-circle")!;
    expect(admitted.map((pool) => pool.address)).toEqual(["0xbadprice", "0xbadvolume", "0xvalid"]);
    expect(admitted[0]!.price).toBeNaN();
    expect(admitted[1]!.volume24hUsd).toBeNull();
    expect(admitted[2]).toMatchObject({ tvlUsd: 100000.25, price: 1.001, volume24hUsd: 0 });
    expect(priceObs.get("usdc-circle")).toHaveLength(2);
    expect(priceObs.get("usdc-circle").every((obs: { price: number }) => obs.price === 1.001)).toBe(true);
  });

  it("stops before a request when beforeRequest returns false", async () => {
    const result = await crawlTokenPools<RawPool, GtNewPool>({
      sourceLabel: "test",
      tokens: [{ sourceChain: "eth", ourChain: "ethereum", address: "0xabc", stablecoinId: "usdc-circle" }],
      chainAddressToId: new Map(),
      knownPoolAddrs: new Set(),
      protocolTvlCaps: new Map(),
      newPools: new Map(),
      priceObs: new Map(),
      beforeRequest: async () => false,
      fetchPools: async () => {
        throw new Error("should not fetch");
      },
      parsePool: () => null,
      buildNewPool: () => ({}) as GtNewPool,
    });

    expect(result.stoppedEarly).toBe(true);
  });

  it("keeps native-covered Curve pools out of secondary discovery", async () => {
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
      fetchPools: async () => ({ rows: [{ id: "pool-a", tvlUsd: 100_000, price: 1 }], complete: true, cappedAtMaxPages: false, failedAfterRows: null }),
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
    expect(newPools.size).toBe(0);
    expect(priceObs.size).toBe(0);
  });

  it("accepts fallback Curve pools on chains without native Curve API coverage", async () => {
    const newPools = new Map<string, GtNewPool[]>();
    const priceObs = new Map();
    // Live crawler observations now preserve the local provider-read clock.
    const beforeRead = Math.floor(Date.now() / 1000);
    const result = await crawlTokenPools<RawPool, GtNewPool>({
      sourceLabel: "test",
      tokens: [{ sourceChain: "plasma", ourChain: "plasma", address: "0xstable", stablecoinId: "yzusd-yuzu" }],
      chainAddressToId: new Map([["plasma:0xstable", "yzusd-yuzu"]]),
      knownPoolAddrs: new Set(),
      protocolTvlCaps: new Map([["curve", 900_000]]),
      newPools,
      priceObs,
      fetchPools: async () => ({ rows: [{ id: "0xpool", tvlUsd: 900_000, price: 0.9973 }], complete: true, cappedAtMaxPages: false, failedAfterRows: null }),
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
      buildNewPool: ({ parsed, price }) => ({
        address: "0xpool",
        project: "curve-plasma",
        chain: "plasma",
        dexId: "curve-plasma",
        name: "yzUSD / USDT0",
        symbol: "yzUSD / USDT0",
        tvlUsd: parsed.tvlUsd,
        volume24hUsd: 20_000,
        qualityMultiplier: 1,
        maturityDays: 1,
        price,
        poolType: "gt-amm",
        sourceFamily: "gecko_terminal",
      }),
    });

    expect(result.stoppedEarly).toBe(false);
    expect(newPools.get("yzusd-yuzu")?.[0]).toMatchObject({
      chain: "plasma",
      dexId: "curve-plasma",
      tvlUsd: 900_000,
      price: 0.9973,
    });
    expect(priceObs.get("yzusd-yuzu")).toEqual([
      { price: 0.9973, observedAt: expect.any(Number), tvl: 900_000, chain: "plasma", protocol: "curve-plasma" },
    ]);
    const observedAt = priceObs.get("yzusd-yuzu")[0].observedAt;
    expect(observedAt).toBeGreaterThanOrEqual(beforeRead);
    expect(observedAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(newPools.get("yzusd-yuzu")?.[0].priceObservedAt).toBe(observedAt);
  });

  it.each([50_000, 100_000, 200_000, null, 0])("quarantines oversized fallback without scaling admitted raw TVL (protocol total %s)", async (cap) => {
    const newPools = new Map<string, GtNewPool[]>();
    const priceObs = new Map();
    const log = vi.spyOn(structuredLog, "logWorkerEvent").mockImplementation(() => {});
    const result = await crawlTokenPools<RawPool, GtNewPool>({
      sourceLabel: "test",
      tokens: [{ sourceChain: "eth", ourChain: "ethereum", address: "0xstable", stablecoinId: "usdc-circle" }],
      chainAddressToId: new Map([["ethereum:0xstable", "usdc-circle"]]),
      knownPoolAddrs: new Set(),
      protocolTvlCaps: cap == null ? new Map() : new Map([["testdex", cap]]),
      newPools,
      priceObs,
      fetchPools: async () => ({ rows: [{ id: "pool-a", tvlUsd: 100_000, price: 1 }], complete: true, cappedAtMaxPages: false, failedAfterRows: null }),
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
      buildNewPool: ({ parsed, price }) => ({
        address: "pool-a",
        project: "testdex",
        chain: "ethereum",
        dexId: "testdex",
        name: "USDC / USD",
        symbol: "USDC / USD",
        tvlUsd: parsed.tvlUsd,
        volume24hUsd: 10_000,
        qualityMultiplier: 1,
        maturityDays: 1,
        price,
        poolType: "generic",
        sourceFamily: "gecko_terminal",
      }),
    });

    expect(result.stoppedEarly).toBe(false);
    if (cap === 50_000) {
      expect(newPools.size).toBe(0);
      expect(priceObs.size).toBe(0);
      expect(log).toHaveBeenCalledWith(expect.objectContaining({
        event: "dex-liquidity-source-quarantine",
        metadata: { reason: "fallback-pool-tvl-exceeds-protocol", poolCount: 1, tvlUsd: 100_000 },
      }));
    } else {
      expect(newPools.get("usdc-circle")?.[0]?.tvlUsd).toBe(100_000);
      expect(priceObs.get("usdc-circle")).toHaveLength(1);
      expect(log).not.toHaveBeenCalled();
    }
    log.mockRestore();
  });

  it("skips secondary-source pools with implausible tracked token prices", async () => {
    const newPools = new Map<string, GtNewPool[]>();
    const priceObs = new Map();
    await crawlTokenPools<RawPool, GtNewPool>({
      sourceLabel: "test",
      tokens: [{ sourceChain: "eth", ourChain: "ethereum", address: "0xstable", stablecoinId: "usdc-circle" }],
      chainAddressToId: new Map([["ethereum:0xstable", "usdc-circle"]]),
      knownPoolAddrs: new Set(),
      protocolTvlCaps: new Map(),
      newPools,
      priceObs,
      fetchPools: async () => ({ rows: [{ id: "pool-a", tvlUsd: 2_000_000_000, price: 500 }], complete: true, cappedAtMaxPages: false, failedAfterRows: null }),
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

    expect(newPools.size).toBe(0);
    expect(priceObs.size).toBe(0);
  });

  it("rejects pools carrying the provider broken-price signature before any price observation", async () => {
    const newPools = new Map<string, GtNewPool[]>();
    const priceObs = new Map();
    await crawlTokenPools<RawPool, GtNewPool>({
      sourceLabel: "test",
      tokens: [{ sourceChain: "sophon", ourChain: "sophon", address: "0xusn", stablecoinId: "usn-noon" }],
      chainAddressToId: new Map([["sophon:0xusn", "usn-noon"]]),
      knownPoolAddrs: new Set(),
      protocolTvlCaps: new Map(),
      newPools,
      priceObs,
      fetchPools: async () => ({ rows: [{ id: "0xpool", tvlUsd: 324_992, price: 0.3323290599 }], complete: true, cappedAtMaxPages: false, failedAfterRows: null }),
      parsePool: (pool) => ({
        dexId: "syncswap-v3-sophon",
        poolAddress: pool.id,
        tvlUsd: pool.tvlUsd,
        volume24hUsd: 0,
        baseTokenAddress: "0xusdt",
        quoteTokenAddress: "0xusn",
        baseTokenPriceUsd: 0.3323456606,
        quoteTokenPriceUsd: pool.price,
        baseTokenPriceQuoteToken: null,
        quoteTokenPriceBaseToken: null,
        baseTokenPriceNativeCurrency: null,
        quoteTokenPriceNativeCurrency: null,
        createdAt: "2025-05-29T11:33:16Z",
        poolName: "USDT / USN 0.04%",
      }),
      buildNewPool: () => {
        throw new Error("should not build");
      },
    });

    expect(newPools.size).toBe(0);
    expect(priceObs.size).toBe(0);
  });

  it("admits a coherent quiet pool with zero volume and takes its price observation", async () => {
    const newPools = new Map<string, GtNewPool[]>();
    const priceObs = new Map();
    const beforeRead = Math.floor(Date.now() / 1000);
    await crawlTokenPools<RawPool, GtNewPool>({
      sourceLabel: "test",
      tokens: [{ sourceChain: "zksync", ourChain: "zksync", address: "0xusn", stablecoinId: "test" }],
      chainAddressToId: new Map([["zksync:0xusn", "test"]]),
      knownPoolAddrs: new Set(),
      protocolTvlCaps: new Map(),
      newPools,
      priceObs,
      fetchPools: async () => ({ rows: [{ id: "0xpool", tvlUsd: 52_313, price: 1.0018122159 }], complete: true, cappedAtMaxPages: false, failedAfterRows: null }),
      parsePool: (pool) => ({
        dexId: "syncswap-v3-zksync",
        poolAddress: pool.id,
        tvlUsd: pool.tvlUsd,
        volume24hUsd: 0,
        baseTokenAddress: "0xusn",
        quoteTokenAddress: "0xusdc",
        baseTokenPriceUsd: pool.price,
        quoteTokenPriceUsd: 1.0016693845,
        baseTokenPriceQuoteToken: 1.0005451588,
        quoteTokenPriceBaseToken: 0.9994551383,
        baseTokenPriceNativeCurrency: 0.000401420873955884,
        quoteTokenPriceNativeCurrency: 0.000401202155087959,
        createdAt: "2025-01-01T00:00:00Z",
        poolName: "USN / USDC",
      }),
      buildNewPool: ({ price }) => ({
        address: "0xpool",
        project: "syncswap-v3-zksync",
        chain: "zksync",
        dexId: "syncswap-v3-zksync",
        name: "USN / USDC",
        symbol: "USN / USDC",
        tvlUsd: 52_313,
        volume24hUsd: 0,
        qualityMultiplier: 1,
        maturityDays: 1,
        price,
        poolType: "gt-concentrated",
        sourceFamily: "gecko_terminal",
      }),
    });

    expect(newPools.get("test")).toHaveLength(1);
    expect(priceObs.get("test")).toEqual([
      { price: 1.0018122159, observedAt: expect.any(Number), tvl: 52_313, chain: "zksync", protocol: "syncswap-v3-zksync" },
    ]);
    const observedAt = priceObs.get("test")[0].observedAt;
    expect(observedAt).toBeGreaterThanOrEqual(beforeRead);
    expect(observedAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(newPools.get("test")?.[0].priceObservedAt).toBe(observedAt);
  });

  it("does not collapse case-distinct non-EVM token identities", async () => {

    const newPools = new Map<string, GtNewPool[]>();
    await crawlTokenPools<RawPool, GtNewPool>({
      sourceLabel: "test",
      tokens: [{ sourceChain: "solana", ourChain: "solana", address: "MintCase", stablecoinId: "test" }],
      chainAddressToId: new Map([["solana:MintCase", "test"]]),
      knownPoolAddrs: new Set(),
      protocolTvlCaps: new Map(),
      newPools,
      priceObs: new Map(),
      fetchPools: async () => ({ rows: [{ id: "PoolCase", tvlUsd: 100_000, price: 1 }], complete: true, cappedAtMaxPages: false, failedAfterRows: null }),
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

    expect(newPools.size).toBe(0);
  });
});
