import { describe, expect, it } from "vitest";

import {
  computeDurabilityScore,
  computeLiquidityScore,
  initLiquidityFallbackCounters,
  initMetrics,
} from "../pool-helpers";
import { filterRetainedPools, rebuildMetricsFromPools } from "../scoring-helpers";
import { addSecondaryPoolContribution } from "../pool-contribution";
import { accumulatePoolMetrics } from "../process-pool-accumulation";
import { convertToGtNewPools } from "../../../lib/dex-api-pool-shaping";
import type { DexApiPool } from "../../../lib/dex-api-types";
import type {
  GtNewPool,
  LiquidityMetrics,
  LlamaPool,
} from "../types";
import type {
  PoolProtocolEnrichment,
  ResolvedPoolIdentity,
} from "../process-pool-types";

function makeMetrics(overrides: Partial<LiquidityMetrics> = {}): LiquidityMetrics {
  return { ...initMetrics("usdc-circle", "USDC"), ...overrides };
}

function makeGtPool(address: string, overrides: Partial<GtNewPool> = {}): GtNewPool {
  return {
    address,
    chain: "ethereum",
    dexId: "uniswap-v3",
    name: "USDC / USDT",
    tvlUsd: 100_000,
    volume24hUsd: 10_000,
    qualityMultiplier: 0.8,
    maturityDays: 30,
    price: 1,
    symbol: "USDC / USDT",
    poolType: "uniswap-v3-5bp",
    sourceFamily: "direct_api",
    ...overrides,
  };
}

function makePoolEntry(
  overrides: Partial<LiquidityMetrics["topPools"][number]> = {},
): LiquidityMetrics["topPools"][number] {
  return {
    poolId: "pool-1",
    project: "uniswap-v3",
    chain: "Ethereum",
    tvlUsd: 100_000,
    symbol: "USDC-USDT",
    volumeUsd1d: 10_000,
    volumeUsd7d: 70_000,
    poolType: "uniswap-v3-5bp",
    source: "dl",
    ...overrides,
  };
}

describe("initLiquidityFallbackCounters", () => {
  it("starts every counter at zero", () => {
    const counters = initLiquidityFallbackCounters();
    for (const [key, value] of Object.entries(counters)) {
      expect(value, `counter ${key} must start at 0`).toBe(0);
    }
  });
});

describe("computeDurabilityScore fallback counters", () => {
  it("counts each neutral default exactly once when inputs are unmeasured", () => {
    const counters = initLiquidityFallbackCounters();
    const m = makeMetrics({ totalTvlForOrganic: 0, oldestPoolDays: 365 });
    const withCounters = computeDurabilityScore(m, null, null, counters);
    expect(counters.durabilityOrganicFractionDefault).toBe(1);
    expect(counters.durabilityTvlStabilityDefault).toBe(1);
    expect(counters.durabilityVolumeConsistencyDefault).toBe(1);
    // Counting must not change the score.
    expect(withCounters).toBe(computeDurabilityScore(m, null, null));
  });

  it("stays at zero when all inputs are measured", () => {
    const counters = initLiquidityFallbackCounters();
    const m = makeMetrics({
      totalTvlForOrganic: 1_000_000,
      organicTvlWeightedSum: 600_000,
      oldestPoolDays: 365,
    });
    const withCounters = computeDurabilityScore(m, 0.8, 0.7, counters);
    expect(counters.durabilityOrganicFractionDefault).toBe(0);
    expect(counters.durabilityTvlStabilityDefault).toBe(0);
    expect(counters.durabilityVolumeConsistencyDefault).toBe(0);
    expect(withCounters).toBe(computeDurabilityScore(m, 0.8, 0.7));
  });
});

describe("computeLiquidityScore TVL-depth branch counters", () => {
  it("counts the absolute mcap fallback when circulating supply is missing", () => {
    const counters = initLiquidityFallbackCounters();
    const m = makeMetrics({ totalTvlUsd: 5_000_000, effectiveTvl: 4_000_000, poolCount: 4 });
    const withCounters = computeLiquidityScore(m, 50, undefined, counters);
    expect(counters.tvlDepthMcapFallback).toBe(1);
    expect(counters.tvlDepthRelative).toBe(0);
    expect(withCounters).toEqual(computeLiquidityScore(m, 50, undefined));
  });

  it("counts the absolute mcap fallback when circulating supply is zero", () => {
    const counters = initLiquidityFallbackCounters();
    const m = makeMetrics({ totalTvlUsd: 5_000_000, effectiveTvl: 4_000_000, poolCount: 4 });
    computeLiquidityScore(m, 50, 0, counters);
    expect(counters.tvlDepthMcapFallback).toBe(1);
    expect(counters.tvlDepthRelative).toBe(0);
  });

  it("counts the relative branch when circulating supply is measured", () => {
    const counters = initLiquidityFallbackCounters();
    const m = makeMetrics({ totalTvlUsd: 5_000_000, effectiveTvl: 4_000_000, poolCount: 4 });
    const withCounters = computeLiquidityScore(m, 50, 1_000_000_000, counters);
    expect(counters.tvlDepthMcapFallback).toBe(0);
    expect(counters.tvlDepthRelative).toBe(1);
    expect(withCounters).toEqual(computeLiquidityScore(m, 50, 1_000_000_000));
  });
});

describe("filterRetainedPools exclusion counters", () => {
  it("counts each exclusion reason and leaves the retained set unchanged", () => {
    const counters = initLiquidityFallbackCounters();
    const retained = makePoolEntry({ poolId: "keep" });
    const blocked = makePoolEntry({ poolId: "blocked", project: "bunni" });
    const churny = makePoolEntry({ poolId: "churn", tvlUsd: 1_000, volumeUsd1d: 60_000 });
    const stale = makePoolEntry({ poolId: "stale", tvlUsd: 150_000_000, volumeUsd1d: 1_000 });
    const pools = [retained, blocked, churny, stale];

    const result = filterRetainedPools(pools, counters);
    expect(result).toEqual(filterRetainedPools(pools));
    expect(result.map((pool) => pool.poolId)).toEqual(["keep"]);
    expect(counters.retainedExclusionBlockedDex).toBe(1);
    expect(counters.retainedExclusionVolTvlRatio).toBe(1);
    expect(counters.retainedExclusionLargePoolLowVolume).toBe(1);
  });

  it("stays at zero when every pool is retained", () => {
    const counters = initLiquidityFallbackCounters();
    filterRetainedPools([makePoolEntry()], counters);
    expect(counters.retainedExclusionBlockedDex).toBe(0);
    expect(counters.retainedExclusionVolTvlRatio).toBe(0);
    expect(counters.retainedExclusionLargePoolLowVolume).toBe(0);
  });
});

describe("rebuildMetricsFromPools TVL fallback counters", () => {
  it("counts pools whose quality/effective TVL fall back to raw tvlUsd", () => {
    const counters = initLiquidityFallbackCounters();
    const bare = makePoolEntry({ poolId: "bare" });
    const measured = makePoolEntry({
      poolId: "measured",
      extra: { qualityAdjustedTvl: 80_000, effectiveTvl: 70_000 },
    });
    const rebuilt = rebuildMetricsFromPools([bare, measured], counters);
    expect(counters.rebuildQualityAdjustedTvlFallback).toBe(1);
    expect(counters.rebuildEffectiveTvlFallback).toBe(1);
    // Counting must not change the rebuilt totals.
    expect(rebuilt.qualityAdjustedTvl).toBe(180_000);
    expect(rebuilt.effectiveTvl).toBe(170_000);
  });

  it("stays at zero when every pool carries measured quality TVLs", () => {
    const counters = initLiquidityFallbackCounters();
    rebuildMetricsFromPools(
      [makePoolEntry({ extra: { qualityAdjustedTvl: 80_000, effectiveTvl: 70_000 } })],
      counters,
    );
    expect(counters.rebuildQualityAdjustedTvlFallback).toBe(0);
    expect(counters.rebuildEffectiveTvlFallback).toBe(0);
  });
});

describe("addSecondaryPoolContribution staged default counters", () => {
  it("counts the staged organic and balance defaults for an unmeasured pool", () => {
    const counters = initLiquidityFallbackCounters();
    const metrics = new Map<string, LiquidityMetrics>();
    addSecondaryPoolContribution(
      metrics,
      "usdc-circle",
      "USDC",
      makeGtPool(`0x${"1".repeat(40)}`),
      undefined,
      counters,
    );
    expect(counters.stagedOrganicFractionDefault).toBe(1);
    expect(counters.stagedBalanceRatioFallback).toBe(1);
    expect(counters.unmeasuredBalanceOptimistic).toBe(1);
  });

  it("counts only the organic default when the balance ratio is measured", () => {
    const counters = initLiquidityFallbackCounters();
    const metrics = new Map<string, LiquidityMetrics>();
    addSecondaryPoolContribution(
      metrics,
      "usdc-circle",
      "USDC",
      makeGtPool(`0x${"2".repeat(40)}`, { balanceRatio: 0.9 }),
      undefined,
      counters,
    );
    expect(counters.stagedOrganicFractionDefault).toBe(1);
    expect(counters.stagedBalanceRatioFallback).toBe(0);
    expect(counters.unmeasuredBalanceOptimistic).toBe(0);
  });

  it("does not count duplicate merges of an already-known pool", () => {
    const counters = initLiquidityFallbackCounters();
    const metrics = new Map<string, LiquidityMetrics>();
    const pool = makeGtPool(`0x${"3".repeat(40)}`);
    addSecondaryPoolContribution(metrics, "usdc-circle", "USDC", pool, undefined, counters);
    addSecondaryPoolContribution(metrics, "usdc-circle", "USDC", pool, undefined, counters);
    expect(counters.stagedOrganicFractionDefault).toBe(1);
    expect(counters.stagedBalanceRatioFallback).toBe(1);
  });
});

describe("accumulatePoolMetrics optimistic balance counter", () => {
  function makeLlamaPool(): LlamaPool {
    return {
      pool: "11111111-1111-1111-1111-111111111111",
      chain: "Ethereum",
      project: "uniswap-v3",
      symbol: "USDC-USDT",
      tvlUsd: 500_000,
      volumeUsd1d: 50_000,
      volumeUsd7d: 350_000,
      stablecoin: true,
      underlyingTokens: null,
      apyBase: null,
      apyReward: null,
      apy: 0,
      sigma: 0,
      exposure: "multi",
      count: 10,
    };
  }

  function makeIdentity(pool: LlamaPool): ResolvedPoolIdentity {
    return {
      pool,
      matchedIds: new Set(["usdc-circle"]),
      poolSymbols: ["USDC", "USDT"],
      poolType: "uniswap-v3-5bp",
      protocol: "uniswap-v3",
      chainNorm: "ethereum",
      addrCurveKey: "ethereum:11111111-1111-1111-1111-111111111111",
      fpCurveKey: null,
      symCurveKey: "ethereum:usdc-usdt",
    };
  }

  function makeEnrichment(
    overrides: Partial<PoolProtocolEnrichment> = {},
  ): PoolProtocolEnrichment {
    return {
      curveData: undefined,
      curveMeasuredRouteData: undefined,
      curveAddressMatch: false,
      resolvedPoolType: "uniswap-v3-5bp",
      qualityMultiplier: 0.8,
      feeTierForExtra: undefined,
      balanceRatio: 1,
      poolMaturityDays: 100,
      organicFraction: 0.5,
      hasMeasuredOrganicFraction: false,
      effectivePoolTvl: 500_000,
      rawContribTvl: 500_000,
      balanceDetails: undefined,
      volumeUsd1d: 50_000,
      volumeUsd7d: 350_000,
      ...overrides,
    };
  }

  it("counts the optimistic path when no measured balance data exists", () => {
    const counters = initLiquidityFallbackCounters();
    const metrics = new Map<string, LiquidityMetrics>();
    const pool = makeLlamaPool();
    accumulatePoolMetrics(metrics, makeIdentity(pool), makeEnrichment(), {}, "usdc-circle", counters);
    expect(counters.unmeasuredBalanceOptimistic).toBe(1);
  });

  it("stays at zero when Curve balance data is measured", () => {
    const counters = initLiquidityFallbackCounters();
    const metrics = new Map<string, LiquidityMetrics>();
    const pool = makeLlamaPool();
    const enrichment = makeEnrichment({
      curveData: {
        A: 200,
        registryId: "main",
        isMetaPool: false,
        balanceRatio: 0.95,
        tvl: 500_000,
        metapoolAdjustedTvl: 500_000,
        creationTs: 1_600_000_000,
        balanceDetails: [],
        tokenPrices: {},
      },
      balanceRatio: 0.95,
    });
    accumulatePoolMetrics(metrics, makeIdentity(pool), enrichment, {}, "usdc-circle", counters);
    expect(counters.unmeasuredBalanceOptimistic).toBe(0);
  });
});

describe("convertToGtNewPools measurement-default counters", () => {
  const USDC = "0x00000000000000000000000000000000000000c1";
  const OTHER = "0x00000000000000000000000000000000000000c2";
  const chainAddressToId = new Map([[`ethereum:${USDC}`, "usdc-circle"]]);
  const symbolToChainScopedIds = new Map<string, Map<string, string[]>>();

  function makeDirectPool(overrides: Partial<DexApiPool> = {}): DexApiPool {
    return {
      source: "balancer",
      chain: "ethereum",
      poolAddress: "0x00000000000000000000000000000000000000dd",
      poolType: "balancer-stable",
      tokens: [
        { address: USDC, symbol: "USDC", decimals: 6, priceUsd: 1 },
        { address: OTHER, symbol: "USDT", decimals: 6, priceUsd: 1 },
      ],
      price: 1,
      tvlUsd: 1_000_000,
      volume24hUsd: 100_000,
      feeRate: null,
      balances: null,
      ...overrides,
    };
  }

  it("counts defaulted maturity/balance/price measurement flags per shaped pool", () => {
    const counters = initLiquidityFallbackCounters();
    const shaped = convertToGtNewPools(
      [makeDirectPool()],
      chainAddressToId,
      symbolToChainScopedIds,
      undefined,
      undefined,
      counters,
    );
    expect(shaped.get("usdc-circle")).toHaveLength(1);
    expect(counters.directApiMaturityDefaulted).toBe(1);
    expect(counters.directApiBalanceUnmeasured).toBe(1);
    expect(counters.directApiPriceUnmeasured).toBe(0);
  });

  it("counts an unmeasured price when the pool cannot derive a token USD price", () => {
    const counters = initLiquidityFallbackCounters();
    convertToGtNewPools(
      [
        makeDirectPool({
          price: null,
          tokens: [
            { address: USDC, symbol: "USDC", decimals: 6, priceUsd: null },
            { address: OTHER, symbol: "USDT", decimals: 6, priceUsd: null },
          ],
        }),
      ],
      chainAddressToId,
      symbolToChainScopedIds,
      undefined,
      undefined,
      counters,
    );
    expect(counters.directApiPriceUnmeasured).toBe(1);
  });
});
