import { afterEach, describe, expect, it, vi } from "vitest";
import { stagedPoolConfidence, stagedPoolMaturityDays } from "../../dex-discovery/types";
import { mergeStagedPools } from "../staging-merge";
import {
  buildPoolIdentity,
  createKnownPoolIdentityIndex,
  registerKnownPoolIdentity,
  type KnownPoolIdentityIndex,
} from "../pool-identity";

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

function makeKnownPoolIndex(entries: string[] = []): KnownPoolIdentityIndex {
  const known = createKnownPoolIdentityIndex();
  for (const entry of entries) {
    if (entry.startsWith("derived:")) {
      const [, chain, protocol, baseToken, quoteToken, poolType, feeTierBps, isStable] = entry.split(":");
      registerKnownPoolIdentity(known, buildPoolIdentity({
        chain,
        protocol,
        tokenAddresses: [baseToken ?? "", quoteToken ?? ""],
        poolType: poolType === "na" ? null : poolType,
        feeTierBps: feeTierBps === "na" ? null : Number(feeTierBps),
        isStable: isStable === "na" ? null : isStable === "stable",
      }));
      continue;
    }

    const [chain, poolAddressOrId] = entry.split(":");
    registerKnownPoolIdentity(known, buildPoolIdentity({
      chain,
      protocol: "test",
      poolAddressOrId,
      tokenAddresses: [],
    }));
  }
  return known;
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

  it("clamps negative age to 0 (clock skew protection)", () => {
    expect(stagedPoolConfidence(-5)).toBe(1);
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
  const exactPoolAddress = "0x0000000000000000000000000000000000000abc";
  const secondExactPoolAddress = "0x0000000000000000000000000000000000000def";
  const newPoolAddress = "0x0000000000000000000000000000000000000fed";
  const baseToken = "0x00000000000000000000000000000000000000b1";
  const quoteToken = "0x00000000000000000000000000000000000000c2";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns zero counts with empty staging table", async () => {
    const mockDb = createMockDb([]);
    const metrics = new Map();
    const knownPoolIndex = makeKnownPoolIndex();
    const result = await mergeStagedPools(mockDb, metrics, knownPoolIndex, 1710000000);

    expect(result.mergedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(result.skippedByExactIdentityCount).toBe(0);
    expect(result.skippedByUniqueDerivedIdentityCount).toBe(0);
  });

  it("does not modify metrics when staging table is empty", async () => {
    const mockDb = createMockDb([]);
    const metrics = new Map<string, { totalTvlUsd: number; poolCount: number }>();
    metrics.set("test-coin", {
      totalTvlUsd: 1000000,
      poolCount: 5,
    });
    const originalTvl = metrics.get("test-coin")?.totalTvlUsd;

    const result = await mergeStagedPools(mockDb, metrics as never, makeKnownPoolIndex(), 1710000000);

    expect(result.mergedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(result.skippedByExactIdentityCount).toBe(0);
    expect(result.skippedByUniqueDerivedIdentityCount).toBe(0);
    expect(metrics.get("test-coin")?.totalTvlUsd).toBe(originalTvl);
  });

  it("skips pools that exist in knownPoolAddrs", async () => {
    const mockDb = createMockDb([{
      pool_id: `ethereum:${exactPoolAddress}`,
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
      base_token: baseToken,
      quote_token: quoteToken,
      quote_symbol: "USDC",
      price_usd: 1,
      locked_liq_pct: null,
      discovered_at: 1709900000,
      refreshed_at: 1710000000,
    }]);
    const metrics = new Map();
    const knownPoolIndex = makeKnownPoolIndex([`ethereum:${exactPoolAddress}`]);
    const result = await mergeStagedPools(mockDb, metrics, knownPoolIndex, 1710000000);

    expect(result.skippedCount).toBe(1);
    expect(result.skippedByExactIdentityCount).toBe(1);
    expect(result.skippedByUniqueDerivedIdentityCount).toBe(0);
    expect(result.mergedCount).toBe(0);
  });

  it("skips staged pools whose token-pair fingerprint is already known", async () => {
    const mockDb = createMockDb([{
      pool_id: `ethereum:${newPoolAddress}`,
      stablecoin_id: "usdt-tether",
      source: "gecko_terminal",
      chain: "ethereum",
      protocol: "pancakeswap",
      dex_id: "pancakeswap-v3",
      symbol: "USDT/USDC",
      tvl_usd: 100000,
      volume_24h: 50000,
      quality_multiplier: 0.5,
      pool_type: "gt-concentrated",
      fee_tier: null,
      balance_ratio: null,
      is_stable: 1,
      base_token: baseToken,
      quote_token: quoteToken,
      quote_symbol: "USDC",
      price_usd: 1,
      locked_liq_pct: null,
      discovered_at: 1709900000,
      refreshed_at: 1710000000,
    }]);
    const metrics = new Map();
    const knownPoolIndex = makeKnownPoolIndex([
      `derived:ethereum:pancakeswap-v3:${baseToken}:${quoteToken}:gt-concentrated:na:stable`,
    ]);

    const result = await mergeStagedPools(mockDb, metrics, knownPoolIndex, 1710000000);

    expect(result.skippedCount).toBe(1);
    expect(result.skippedByExactIdentityCount).toBe(0);
    expect(result.skippedByUniqueDerivedIdentityCount).toBe(1);
    expect(result.mergedCount).toBe(0);
  });

  it("gracefully handles missing staging table", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mockDb = createMockDb(async () => {
      throw new Error("no such table: dex_pool_staging");
    });
    const metrics = new Map();
    const knownPoolIndex = makeKnownPoolIndex();
    const result = await mergeStagedPools(mockDb, metrics, knownPoolIndex, 1710000000);

    expect(result.mergedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(result.skippedByExactIdentityCount).toBe(0);
    expect(result.skippedByUniqueDerivedIdentityCount).toBe(0);
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

    const result = await mergeStagedPools(mockDb, metrics as never, makeKnownPoolIndex(), now);
    const metric = metrics.get("usdt-tether");

    expect(result.mergedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(result.skippedByExactIdentityCount).toBe(0);
    expect(result.skippedByUniqueDerivedIdentityCount).toBe(0);
    expect(result.priceObservations.get("usdt-tether")).toHaveLength(1);
    expect(metric).toBeDefined();
    expect(metric.totalTvlUsd).toBe(75000);
    expect(metric.totalVolume24hUsd).toBe(37500);
    expect(metric.poolCount).toBe(1);
    expect(metric.qualityAdjustedTvl).toBe(37500);
    expect(metric.protocolTvl.pancakeswap).toBe(75000);
    expect(metric.topPools).toHaveLength(1);
    expect(metric.topPools[0]?.source).toBe("gecko_terminal");
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

    const result = await mergeStagedPools(mockDb, metrics as never, makeKnownPoolIndex(), now);
    const metric = metrics.get("usdt-tether");

    expect(result.mergedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(result.skippedByExactIdentityCount).toBe(0);
    expect(result.skippedByUniqueDerivedIdentityCount).toBe(0);
    expect(result.priceObservations.get("usdt-tether")).toHaveLength(1);
    expect(metric).toBeDefined();
    expect(metric.totalTvlUsd).toBe(100000);
    expect(metric.totalVolume24hUsd).toBe(50000);
    expect(metric.totalTvlForBalance).toBe(100000);
    expect(metric.balanceRatioWeightedSum).toBe(80000);
    expect(metric.totalTvlForLocked).toBe(100000);
    expect(metric.lockedLiqWeightedSum).toBe(90000);
    expect(metric.topPools).toHaveLength(1);
    expect(metric.topPools[0]?.source).toBe("cg_onchain");
    expect(metric.topPools[0]?.extra?.balanceRatio).toBe(0.8);
    expect(metric.topPools[0]?.extra?.feeTier).toBe(5);
  });

  it("extracts price observations from pools skipped by address dedup", async () => {
    const now = 1710000000;
    const mockDb = createMockDb([{
      pool_id: `ethereum:${secondExactPoolAddress}`,
      stablecoin_id: "usdt-tether",
      source: "cg_onchain",
      chain: "ethereum",
      protocol: "uniswap-v3",
      dex_id: "uniswap_v3",
      symbol: "USDT/USDC",
      tvl_usd: 100000,
      volume_24h: 50000,
      fee_tier: 5,
      balance_ratio: null,
      is_stable: 1,
      base_token: baseToken,
      quote_token: quoteToken,
      quote_symbol: "USDC",
      price_usd: 0.9998,
      locked_liq_pct: null,
      discovered_at: now - 86400 * 10,
      refreshed_at: now,
    }]);
    const metrics = new Map();
    // Pool address is already known (from DL yields) — will be deduped for metrics
    const knownPoolIndex = makeKnownPoolIndex([`ethereum:${secondExactPoolAddress}`]);

    const result = await mergeStagedPools(mockDb, metrics as never, knownPoolIndex, now);

    // Metrics dedup still works — pool was NOT merged into metrics
    expect(result.skippedCount).toBe(1);
    expect(result.skippedByExactIdentityCount).toBe(1);
    expect(result.mergedCount).toBe(0);
    expect(metrics.size).toBe(0);

    // But price observation WAS extracted
    const obs = result.priceObservations.get("usdt-tether");
    expect(obs).toHaveLength(1);
    expect(obs![0].price).toBe(0.9998);
    expect(obs![0].tvl).toBe(100000);
    expect(obs![0].chain).toBe("ethereum");
  });

  it("extracts price observations from pools skipped by fingerprint dedup", async () => {
    const now = 1710000000;
    const mockDb = createMockDb([{
      pool_id: `ethereum:${newPoolAddress}`,
      stablecoin_id: "usdt-tether",
      source: "gecko_terminal",
      chain: "ethereum",
      protocol: "pancakeswap",
      dex_id: "pancakeswap-v3",
      symbol: "USDT/USDC",
      tvl_usd: 80000,
      volume_24h: 40000,
      quality_multiplier: 0.5,
      pool_type: "gt-concentrated",
      fee_tier: null,
      balance_ratio: null,
      is_stable: 1,
      base_token: baseToken,
      quote_token: quoteToken,
      quote_symbol: "USDC",
      price_usd: 1.0001,
      locked_liq_pct: null,
      discovered_at: now - 86400 * 5,
      refreshed_at: now,
    }]);
    const metrics = new Map();
    // Fingerprint is known (from DL yields) — will be deduped for metrics
    const knownPoolIndex = makeKnownPoolIndex([
      `derived:ethereum:pancakeswap-v3:${baseToken}:${quoteToken}:gt-concentrated:na:stable`,
    ]);

    const result = await mergeStagedPools(mockDb, metrics as never, knownPoolIndex, now);

    // Metrics dedup still works
    expect(result.skippedCount).toBe(1);
    expect(result.skippedByUniqueDerivedIdentityCount).toBe(1);
    expect(result.mergedCount).toBe(0);
    expect(metrics.size).toBe(0);

    // Price observation WAS extracted
    const obs = result.priceObservations.get("usdt-tether");
    expect(obs).toHaveLength(1);
    expect(obs![0].price).toBe(1.0001);
    expect(obs![0].tvl).toBe(80000);
  });

  it("does NOT extract price observation from deduped pool with sub-threshold TVL", async () => {
    const now = 1710000000;
    const mockDb = createMockDb([{
      pool_id: `ethereum:${secondExactPoolAddress}`,
      stablecoin_id: "usdt-tether",
      source: "cg_onchain",
      chain: "ethereum",
      protocol: "uniswap-v3",
      dex_id: "uniswap_v3",
      symbol: "USDT/USDC",
      tvl_usd: 30000,
      volume_24h: 5000,
      fee_tier: 5,
      balance_ratio: null,
      is_stable: 1,
      base_token: baseToken,
      quote_token: quoteToken,
      quote_symbol: "USDC",
      price_usd: 1.0,
      locked_liq_pct: null,
      discovered_at: now - 86400 * 10,
      refreshed_at: now,
    }]);
    const metrics = new Map();
    const knownPoolIndex = makeKnownPoolIndex([`ethereum:${secondExactPoolAddress}`]);

    const result = await mergeStagedPools(mockDb, metrics as never, knownPoolIndex, now);

    expect(result.skippedCount).toBe(1);
    // TVL $30K × confidence 1.0 = $30K < $50K threshold — no price observation
    expect(result.priceObservations.get("usdt-tether")).toBeUndefined();
  });

  it("orderbook pools skip fingerprint dedup (null tokens)", async () => {
    const now = 1710000000;
    const mockDb = createMockDb([{
      pool_id: "orderbook:binance:usdt-tether",
      stablecoin_id: "usdt-tether",
      source: "cg_tickers",
      chain: "orderbook",
      protocol: "binance",
      symbol: "USDT/USD",
      tvl_usd: 500000,
      volume_24h: 1000000,
      fee_tier: null,
      balance_ratio: null,
      is_stable: 0,
      base_token: null,
      quote_token: null,
      quote_symbol: "USD",
      price_usd: 1.0001,
      locked_liq_pct: null,
      discovered_at: now - 86400 * 5,
      refreshed_at: now,
    }]);
    const metrics = new Map();
    // Fingerprint for this pool would be null (no tokens), so it should NOT be
    // skipped by fingerprint dedup — only exact poolId match matters
    const knownPoolIndex = makeKnownPoolIndex();

    const result = await mergeStagedPools(mockDb, metrics as never, knownPoolIndex, now);

    expect(result.mergedCount).toBe(1);
    expect(result.skippedByUniqueDerivedIdentityCount).toBe(0);
  });
});
