import { afterEach, describe, expect, it, vi } from "vitest";
import { stagedPoolConfidence, stagedPoolMaturityDays } from "../../dex-discovery/types";
import { mergeStagedPools } from "../staging-merge";

function createMockDb(results: unknown[] | (() => Promise<{ results: unknown[] }>)): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        all: typeof results === "function"
          ? results
          : async () => ({ results }),
      }),
    }),
  } as unknown as D1Database;
}

describe("stagedPoolConfidence", () => {
  it("returns 1.0 for freshly refreshed pool", () => {
    expect(stagedPoolConfidence(0)).toBe(1);
  });

  it("returns 0.75 for 12-hour-old pool", () => {
    expect(stagedPoolConfidence(12)).toBe(0.75);
  });

  it("returns 0.5 for 24-hour-old pool", () => {
    expect(stagedPoolConfidence(24)).toBe(0.5);
  });

  it("returns 0 for pool older than 24h", () => {
    expect(stagedPoolConfidence(25)).toBe(0);
  });
});

describe("stagedPoolMaturityDays", () => {
  it("computes days since discovery", () => {
    const now = 1710000000;
    expect(stagedPoolMaturityDays(now - 86400 * 10, now)).toBe(10);
  });

  it("caps at 30 days", () => {
    const now = 1710000000;
    expect(stagedPoolMaturityDays(now - 86400 * 60, now)).toBe(30);
  });

  it("returns 0 for future discovery (clock skew)", () => {
    const now = 1710000000;
    expect(stagedPoolMaturityDays(now + 1000, now)).toBe(0);
  });
});

describe("mergeStagedPools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns zero counts with empty staging table", async () => {
    const mockDb = createMockDb([]);
    const metrics = new Map();
    const knownPoolAddrs = new Set<string>();
    const result = await mergeStagedPools(mockDb, metrics, knownPoolAddrs, 1710000000);

    expect(result.mergedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
  });

  it("does not modify metrics when staging table is empty", async () => {
    const mockDb = createMockDb([]);
    const metrics = new Map<string, { totalTvlUsd: number; poolCount: number }>();
    metrics.set("test-coin", {
      totalTvlUsd: 1000000,
      poolCount: 5,
    });
    const originalTvl = metrics.get("test-coin")?.totalTvlUsd;

    const result = await mergeStagedPools(mockDb, metrics as never, new Set(), 1710000000);

    expect(result.mergedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(metrics.get("test-coin")?.totalTvlUsd).toBe(originalTvl);
  });

  it("skips pools that exist in knownPoolAddrs", async () => {
    const mockDb = createMockDb([{
      pool_id: "ethereum:0xabc",
      stablecoin_id: "usdt-tether",
      source: "gecko_terminal",
      chain: "ethereum",
      protocol: "pancakeswap-v3",
      symbol: "USDT/USDC",
      tvl_usd: 100000,
      volume_24h: 50000,
      fee_tier: null,
      balance_ratio: null,
      is_stable: 1,
      base_token: "0xabc",
      quote_token: "0xdef",
      quote_symbol: "USDC",
      price_usd: 1,
      locked_liq_pct: null,
      discovered_at: 1709900000,
      refreshed_at: 1710000000,
    }]);
    const metrics = new Map();
    const knownPoolAddrs = new Set(["ethereum:0xabc"]);
    const result = await mergeStagedPools(mockDb, metrics, knownPoolAddrs, 1710000000);

    expect(result.skippedCount).toBe(1);
    expect(result.mergedCount).toBe(0);
  });

  it("gracefully handles missing staging table", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mockDb = createMockDb(async () => {
      throw new Error("no such table: dex_pool_staging");
    });
    const metrics = new Map();
    const knownPoolAddrs = new Set<string>();
    const result = await mergeStagedPools(mockDb, metrics, knownPoolAddrs, 1710000000);

    expect(result.mergedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("merges GT-style staged pools with confidence decay and GT dex quality", async () => {
    const now = 1710000000;
    const mockDb = createMockDb([{
      pool_id: "bsc:0xpool1",
      stablecoin_id: "usdt-tether",
      source: "gecko_terminal",
      chain: "bsc",
      protocol: "pancakeswap-v3",
      symbol: "USDT/USDC",
      tvl_usd: 100000,
      volume_24h: 50000,
      fee_tier: null,
      balance_ratio: null,
      is_stable: 1,
      base_token: "0xbase",
      quote_token: "0xquote",
      quote_symbol: "USDC",
      price_usd: 1,
      locked_liq_pct: null,
      discovered_at: now - 86400 * 10,
      refreshed_at: now - 3600 * 12,
    }]);
    const metrics = new Map();

    const result = await mergeStagedPools(mockDb, metrics as never, new Set(), now);
    const metric = metrics.get("usdt-tether");

    expect(result.mergedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(result.priceObservations.get("usdt-tether")).toHaveLength(1);
    expect(metric).toBeDefined();
    expect(metric.totalTvlUsd).toBe(75000);
    expect(metric.totalVolume24hUsd).toBe(37500);
    expect(metric.poolCount).toBe(1);
    expect(metric.qualityAdjustedTvl).toBe(37500);
    expect(metric.protocolTvl.pancakeswap).toBe(75000);
    expect(metric.topPools).toHaveLength(1);
    expect(metric.topPools[0]?.source).toBe("gt");
    expect(metric.topPools[0]?.poolId).toBe("bsc:0xpool1");
  });

  it("merges CG staged pools and preserves balance ratio and locked liquidity", async () => {
    const now = 1710000000;
    const mockDb = createMockDb([{
      pool_id: "ethereum:0xcgpool",
      stablecoin_id: "usdt-tether",
      source: "cg_onchain",
      chain: "ethereum",
      protocol: "pancakeswap-v3",
      symbol: "USDT/USDC",
      tvl_usd: 100000,
      volume_24h: 50000,
      fee_tier: 5,
      balance_ratio: 0.8,
      is_stable: 1,
      base_token: "0xbase",
      quote_token: "0xquote",
      quote_symbol: "USDC",
      price_usd: 1,
      locked_liq_pct: 90,
      discovered_at: now - 86400 * 10,
      refreshed_at: now,
    }]);
    const metrics = new Map();

    const result = await mergeStagedPools(mockDb, metrics as never, new Set(), now);
    const metric = metrics.get("usdt-tether");

    expect(result.mergedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(result.priceObservations.get("usdt-tether")).toHaveLength(1);
    expect(metric).toBeDefined();
    expect(metric.totalTvlUsd).toBe(100000);
    expect(metric.totalVolume24hUsd).toBe(50000);
    expect(metric.totalTvlForBalance).toBe(100000);
    expect(metric.balanceRatioWeightedSum).toBe(80000);
    expect(metric.totalTvlForLocked).toBe(100000);
    expect(metric.lockedLiqWeightedSum).toBe(90000);
    expect(metric.topPools).toHaveLength(1);
    expect(metric.topPools[0]?.source).toBe("cg");
    expect(metric.topPools[0]?.extra?.balanceRatio).toBe(0.8);
    expect(metric.topPools[0]?.extra?.feeTier).toBe(500);
  });
});
