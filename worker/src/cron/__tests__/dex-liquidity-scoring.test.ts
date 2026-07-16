import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/db", () => ({
  batchExecute: vi.fn(async (_db: D1Database, stmts: D1PreparedStatement[]) => stmts.length),
  isMissingTableError: (error: unknown) => String(error).toLowerCase().includes("no such table"),
  isMissingColumnError: (error: unknown) => String(error).toLowerCase().includes("no such column"),
}));

vi.mock("../../lib/db-cache", () => ({
  getCache: vi.fn(),
}));

import { batchExecute } from "../../lib/db";
import { getCache } from "../../lib/db-cache";
import { DEX_PRICE_OBSERVATION_MIN_TVL_USD } from "../../lib/constants";
import { initMetrics } from "../dex-liquidity/pool-helpers";
import { computeDepthStability, computeDexPrices, computeStablecoinScores } from "../dex-liquidity/scoring";
import type { PoolEntry } from "../dex-liquidity/types";

interface QueryConfig {
  match: string;
  all?: Record<string, unknown>[];
  first?: Record<string, unknown> | null;
  throwError?: unknown;
}

interface PreparedStatementWithMeta extends D1PreparedStatement {
  sql: string;
  boundValues: unknown[];
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function makeQueryDb(configs: QueryConfig[]): D1Database & { history: Array<{ sql: string; binds: unknown[] }> } {
  const history: Array<{ sql: string; binds: unknown[] }> = [];

  function createStatement(sql: string, boundValues: unknown[] = []): PreparedStatementWithMeta {
    const config = configs.find((entry) => sql.includes(entry.match));

    return {
      sql,
      boundValues,
      bind: (...args: unknown[]) => createStatement(sql, args),
      all: async <T>() => {
        history.push({ sql, binds: [...boundValues] });
        if (config?.throwError != null) throw toError(config.throwError);
        return {
          results: (config?.all ?? []) as T[],
          success: true,
          meta: {},
        };
      },
      first: async <T>() => {
        history.push({ sql, binds: [...boundValues] });
        if (config?.throwError != null) throw toError(config.throwError);
        return (config?.first ?? null) as T | null;
      },
      run: async () => {
        history.push({ sql, binds: [...boundValues] });
        if (config?.throwError != null) throw toError(config.throwError);
        return { success: true, meta: { changes: 1 } };
      },
    } as unknown as PreparedStatementWithMeta;
  }

  return {
    prepare: (sql: string) => createStatement(sql),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
    history,
  } as unknown as D1Database & { history: Array<{ sql: string; binds: unknown[] }> };
}

function makeDexPricePool(overrides: Partial<PoolEntry> & Pick<PoolEntry, "poolId" | "project" | "chain" | "tvlUsd">): PoolEntry {
  return {
    poolId: overrides.poolId,
    project: overrides.project,
    chain: overrides.chain,
    tvlUsd: overrides.tvlUsd,
    symbol: overrides.symbol ?? "PAIR",
    volumeUsd1d: overrides.volumeUsd1d ?? 0,
    volumeUsd7d: overrides.volumeUsd7d ?? null,
    poolType: overrides.poolType ?? "generic",
    source: overrides.source ?? "gecko_terminal",
    ...(typeof overrides.price === "number" ? { price: overrides.price } : {}),
    ...(overrides.extra ? { extra: overrides.extra } : {}),
  };
}

describe("dex-liquidity scoring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("filters and scales pools, truncates visible pools, and computes deduped global aggregates", async () => {
    const nowMs = Date.UTC(2026, 0, 1);
    vi.spyOn(Date, "now").mockReturnValue(nowMs);

    const db = makeQueryDb([
      {
        match: "depth_stability",
        all: [
          { stablecoin_id: "usdt-tether", depth_stability: 0.9 },
          { stablecoin_id: "usdc-circle", depth_stability: 0.8 },
        ],
      },
      {
        match: "FROM dex_liquidity_history",
        all: [
          { stablecoin_id: "usdt-tether", total_volume_24h_usd: 100 },
          { stablecoin_id: "usdt-tether", total_volume_24h_usd: 100 },
          { stablecoin_id: "usdt-tether", total_volume_24h_usd: 100 },
          { stablecoin_id: "usdt-tether", total_volume_24h_usd: 100 },
          { stablecoin_id: "usdt-tether", total_volume_24h_usd: 100 },
          { stablecoin_id: "usdt-tether", total_volume_24h_usd: 100 },
          { stablecoin_id: "usdt-tether", total_volume_24h_usd: 100 },
          { stablecoin_id: "usdc-circle", total_volume_24h_usd: 0 },
          { stablecoin_id: "usdc-circle", total_volume_24h_usd: 0 },
          { stablecoin_id: "usdc-circle", total_volume_24h_usd: 0 },
          { stablecoin_id: "usdc-circle", total_volume_24h_usd: 0 },
          { stablecoin_id: "usdc-circle", total_volume_24h_usd: 0 },
          { stablecoin_id: "usdc-circle", total_volume_24h_usd: 0 },
          { stablecoin_id: "usdc-circle", total_volume_24h_usd: 0 },
        ],
      },
    ]);

    const usdt = initMetrics("usdt-tether", "USDT");
    usdt.totalVolume24hUsd = 777_000;
    usdt.totalVolume7dUsd = 5_432_100;
    usdt.balanceRatioWeightedSum = 150_000;
    usdt.totalTvlForBalance = 200_000;
    usdt.organicTvlWeightedSum = 250_000;
    usdt.totalTvlForOrganic = 400_000;
    usdt.stressWeightedSum = 0;
    usdt.lockedLiqWeightedSum = 50_000;
    usdt.totalTvlForLocked = 100_000;
    usdt.oldestPoolDays = 500;
    usdt.topPools = [
      {
        poolId: "ethereum:shared",
        project: "curve",
        chain: "Ethereum",
        tvlUsd: 100_000,
        symbol: "USDT-USDC",
        volumeUsd1d: 50_000,
        volumeUsd7d: 35_000,
        poolType: "curve-stableswap",
        source: "dl",
        extra: {
          qualityAdjustedTvl: 95_000,
          effectiveTvl: 90_000,
          balanceRatio: 0.75,
          organicFraction: 0.625,
          hasMeasuredOrganicFraction: true,
          stressIndex: 0,
          maturityDays: 500,
          lockedLiquidityPct: 50,
        },
      },
      {
        poolId: "ethereum:sushi-dl",
        project: "sushiswap",
        chain: "Ethereum",
        tvlUsd: 20_000,
        symbol: "USDT-USDE",
        volumeUsd1d: 5_000,
        volumeUsd7d: 3_500,
        poolType: "generic",
        source: "dl",
      },
      {
        poolId: "ethereum:sushi-cg",
        project: "sushiswap",
        chain: "Ethereum",
        tvlUsd: 80_000,
        symbol: "USDT-USDC",
        volumeUsd1d: 40_000,
        volumeUsd7d: 28_000,
        poolType: "generic",
        source: "cg_onchain",
        extra: { effectiveTvl: 80_000 },
      },
      {
        poolId: "arbitrum:sushi-gt",
        project: "sushiswap",
        chain: "Arbitrum",
        tvlUsd: 70_000,
        symbol: "USDT-USDC",
        volumeUsd1d: 35_000,
        volumeUsd7d: 24_500,
        poolType: "generic",
        source: "gecko_terminal",
        extra: { effectiveTvl: 70_000 },
      },
      {
        poolId: "ethereum:bad-ratio",
        project: "curve",
        chain: "Ethereum",
        tvlUsd: 1_000,
        symbol: "USDT-USDC",
        volumeUsd1d: 100_000,
        volumeUsd7d: 700_000,
        poolType: "curve-stableswap",
        source: "dl",
      },
      {
        poolId: "base:fake-tvl",
        project: "dnax",
        chain: "Base",
        tvlUsd: 150_000_000,
        symbol: "USDT-USDC",
        volumeUsd1d: 10_000,
        volumeUsd7d: 70_000,
        poolType: "generic",
        source: "gecko_terminal",
      },
      ...Array.from({ length: 9 }, (_, index) => ({
        poolId: `ethereum:extra-${index + 1}`,
        project: "curve",
        chain: "Ethereum",
        tvlUsd: 10_000,
        symbol: `USDT-PAIR-${index + 1}`,
        volumeUsd1d: 30_000 - index * 1_000,
        volumeUsd7d: 21_000 - index * 1_000,
        poolType: "curve-stableswap",
        source: "dl" as const,
      })),
    ];

    const usdc = initMetrics("usdc-circle", "USDC");
    usdc.totalVolume24hUsd = 123_000;
    usdc.totalVolume7dUsd = 860_000;
    usdc.topPools = [
      {
        poolId: "ethereum:shared",
        project: "curve",
        chain: "Ethereum",
        tvlUsd: 100_000,
        symbol: "USDC-USDT",
        volumeUsd1d: 50_000,
        volumeUsd7d: 35_000,
        poolType: "curve-stableswap",
        source: "dl",
      },
      {
        poolId: "base:sushi-unique",
        project: "sushiswap",
        chain: "Base",
        tvlUsd: 90_000,
        symbol: "USDC-USDE",
        volumeUsd1d: 30_000,
        volumeUsd7d: 21_000,
        poolType: "generic",
        source: "gecko_terminal",
        extra: { effectiveTvl: 90_000 },
      },
      {
        poolId: "base:curve-unique",
        project: "curve",
        chain: "Base",
        tvlUsd: 40_000,
        symbol: "USDC-DAI",
        volumeUsd1d: 10_000,
        volumeUsd7d: 7_000,
        poolType: "curve-stableswap",
        source: "dl",
      },
    ];

    const { scores, globalAgg } = await computeStablecoinScores(
      db,
      new Map([
        ["usdt-tether", usdt],
        ["usdc-circle", usdc],
      ]),
      new Map([["sushiswap", 100_000]]),
    );

    expect(usdt.topPools.some((pool) => pool.poolId === "ethereum:bad-ratio")).toBe(false);
    expect(usdt.topPools.some((pool) => pool.poolId === "base:fake-tvl")).toBe(false);
    expect(usdt.poolCount).toBe(13);
    expect(usdt.topPools).toHaveLength(10);
    expect(usdt.topPools.map((pool) => pool.poolId)).toEqual([
      "ethereum:shared",
      "ethereum:sushi-cg",
      "arbitrum:sushi-gt",
      "ethereum:extra-1",
      "ethereum:extra-2",
      "ethereum:extra-3",
      "ethereum:extra-4",
      "ethereum:extra-5",
      "ethereum:extra-6",
      "ethereum:extra-7",
    ]);

    const scaledSushiCg = usdt.topPools.find((pool) => pool.poolId === "ethereum:sushi-cg");
    const scaledSushiGt = usdt.topPools.find((pool) => pool.poolId === "arbitrum:sushi-gt");
    expect(scaledSushiCg?.tvlUsd).toBe(42667);
    expect(scaledSushiCg?.extra?.effectiveTvl).toBe(42667);
    expect(scaledSushiGt?.tvlUsd).toBe(37333);
    expect(scaledSushiGt?.extra?.effectiveTvl).toBe(37333);
    expect(usdt.totalTvlUsd).toBe(290_000);
    expect(usdt.effectiveTvl).toBe(280_000);
    expect(usdt.protocolTvl).toEqual({
      curve: 190_000,
      sushiswap: 100_000,
    });
    expect(usdt.chainTvl).toEqual({
      Ethereum: 252_667,
      Arbitrum: 37_333,
    });

    const usdtScore = scores.get("usdt-tether");
    expect(usdtScore).toMatchObject({
      tvl: 290_000,
      vol24h: 364_000,
      weightedBalanceRatio: 0.75,
      organicFrac: 0.625,
      avgStress: 0,
      lockedLiqPct: 0.5,
    });
    expect(usdtScore?.hhi).toBeCloseTo(0.1726, 4);

    expect(globalAgg.poolCount).toBe(15);
    expect(globalAgg.totalVol24h).toBe(404_000);
    expect(globalAgg.totalVol7d).toBe(272_000);
    expect(globalAgg.totalTvl).toBeCloseTo(330_000, 6);
    expect(globalAgg.protocolTvl.sushiswap).toBe(100_000);
    expect(globalAgg.chainTvl.ethereum).toBeCloseTo(222_982.632, 3);
    expect(globalAgg.chainTvl.arbitrum).toBeCloseTo(19_648.947, 3);
    expect(globalAgg.chainTvl.base).toBeCloseTo(87_368.421, 3);
  });

  it("excludes inactive tracked metrics from scores, retained pools, and global aggregates", async () => {
    const db = makeQueryDb([
      { match: "FROM dex_liquidity_history", all: [] },
    ]);

    const activeMetrics = initMetrics("usdt-tether", "USDT");
    activeMetrics.totalVolume24hUsd = 10_000;
    activeMetrics.totalVolume7dUsd = 70_000;
    activeMetrics.topPools = [
      {
        poolId: "ethereum:active",
        project: "curve",
        chain: "Ethereum",
        tvlUsd: 100_000,
        symbol: "USDT-USDC",
        volumeUsd1d: 10_000,
        volumeUsd7d: 70_000,
        poolType: "curve-stableswap",
        source: "dl",
      },
    ];

    const inactiveMetrics = initMetrics("usr-resolv", "USR");
    inactiveMetrics.totalVolume24hUsd = 90_000;
    inactiveMetrics.totalVolume7dUsd = 630_000;
    inactiveMetrics.topPools = [
      {
        poolId: "ethereum:inactive",
        project: "curve",
        chain: "Ethereum",
        tvlUsd: 900_000,
        symbol: "USR-USDC",
        volumeUsd1d: 90_000,
        volumeUsd7d: 630_000,
        poolType: "curve-stableswap",
        source: "dl",
      },
    ];

    const result = await computeStablecoinScores(
      db,
      new Map([
        ["usdt-tether", activeMetrics],
        ["usr-resolv", inactiveMetrics],
      ]),
      new Map(),
    );

    expect(result.scores.has("usdt-tether")).toBe(true);
    expect(result.scores.has("usr-resolv")).toBe(false);
    expect(result.retainedPoolsByStablecoin.has("usr-resolv")).toBe(false);
    expect(result.globalAgg.totalTvl).toBe(100_000);
    expect(result.globalAgg.totalVol24h).toBe(10_000);
    expect(result.globalAgg.totalVol7d).toBe(70_000);
    expect(result.globalAgg.poolCount).toBe(1);
  });

  it("keeps paused Balancer pools only in the P4 capability denominator", async () => {
    const db = makeQueryDb([{ match: "FROM dex_liquidity_history", all: [] }]);
    const metrics = initMetrics("usdc-circle", "USDC");
    metrics.topPools = [
      {
        poolId: "ethereum:0xpaused-balancer",
        project: "balancer-v3",
        chain: "ethereum",
        tvlUsd: 10_000_000,
        symbol: "USDC / USDT",
        volumeUsd1d: 100_000,
        volumeUsd7d: 700_000,
        poolType: "balancer-stable",
        source: "gecko_terminal",
        extra: {
          executionCapabilityGate: {
            family: "balancer-amm",
            reason: "paused-or-swap-disabled",
          },
        },
      },
      {
        poolId: "ethereum:0xrate-bearing-balancer",
        project: "balancer-v3",
        chain: "ethereum",
        tvlUsd: 150_000,
        symbol: "USDC / waUSDT",
        volumeUsd1d: 10_000,
        volumeUsd7d: 70_000,
        poolType: "balancer-stable",
        source: "gecko_terminal",
        extra: {
          executionCapabilityGate: {
            family: "balancer-amm",
            reason: "rate-bearing-inputs",
          },
        },
      },
    ];

    const result = await computeStablecoinScores(
      db,
      new Map([["usdc-circle", metrics]]),
      new Map([["balancer", 100_000]]),
    );
    const coverage = (result.scores.get("usdc-circle") as {
      exitRouteObservationCoverage?: {
        retainedPoolCount: number;
        scoreEligibleCapabilityPoolCount?: number;
        unsupportedPoolCount: number;
        unsupportedReasons: Record<string, number>;
      };
    } | undefined)?.exitRouteObservationCoverage;

    expect(coverage).toMatchObject({
      retainedPoolCount: 2,
      scoreEligibleCapabilityPoolCount: 2,
      unsupportedPoolCount: 2,
      unsupportedReasons: {
        "executionCapabilityGate:balancer-amm:paused-or-swap-disabled": 1,
        "executionCapabilityGate:balancer-amm:rate-bearing-inputs": 1,
      },
    });
    expect(metrics.totalTvlUsd).toBe(100_000);
    expect(metrics.poolCount).toBe(1);
    expect(metrics.topPools).toHaveLength(1);
    expect(metrics.topPools[0]).toMatchObject({
      poolId: "ethereum:0xrate-bearing-balancer",
      tvlUsd: 100_000,
    });
    expect(result.retainedPoolsByStablecoin.get("usdc-circle")).toHaveLength(1);
    expect(result.globalAgg).toMatchObject({
      totalTvl: 100_000,
      poolCount: 1,
      protocolTvl: { balancer: 100_000 },
    });
    expect(result.diagnostics.protocolCapReductions).toMatchObject({
      cappedPoolCount: 1,
      reducedTvlUsd: 50_000,
    });
  });

  it("treats missing stability and volume-history tables as first-run state", async () => {
    const db = makeQueryDb([
      { match: "depth_stability", throwError: new Error("no such table: dex_liquidity") },
      { match: "FROM dex_liquidity_history", throwError: new Error("no such table: dex_liquidity_history") },
    ]);

    const metrics = initMetrics("usdt-tether", "USDT");
    metrics.totalVolume24hUsd = 20_000;
    metrics.totalVolume7dUsd = 140_000;
    metrics.topPools = [
      {
        poolId: "ethereum:only",
        project: "curve",
        chain: "Ethereum",
        tvlUsd: 25_000,
        symbol: "USDT-USDC",
        volumeUsd1d: 20_000,
        poolType: "curve-stableswap",
        source: "dl",
      },
    ];

    const result = await computeStablecoinScores(
      db,
      new Map([["usdt-tether", metrics]]),
      new Map(),
    );

    expect(result.scores.get("usdt-tether")?.tvl).toBe(25_000);
    expect(result.globalAgg.totalTvl).toBe(25_000);
  });

  it("treats direct_api-only coverage as primary but not maximum-confidence coverage", async () => {
    const db = makeQueryDb([
      { match: "FROM dex_liquidity_history", all: [] },
    ]);

    const metrics = initMetrics("usdc-circle", "USDC");
    metrics.totalVolume24hUsd = 10_000;
    metrics.totalVolume7dUsd = 70_000;
    metrics.topPools = [
      {
        poolId: "solana:orca-usdc",
        project: "orca",
        chain: "solana",
        tvlUsd: 50_000,
        symbol: "USDC / USDT",
        volumeUsd1d: 10_000,
        poolType: "orca-whirlpool",
        source: "direct_api",
      },
    ];

    const result = await computeStablecoinScores(
      db,
      new Map([["usdc-circle", metrics]]),
      new Map(),
    );

    expect(result.scores.get("usdc-circle")).toMatchObject({
      coverageClass: "primary",
      coverageConfidence: 0.6,
    });
  });

  it("does not clip direct_api pools with the strict secondary-source protocol cap", async () => {
    const db = makeQueryDb([
      { match: "FROM dex_liquidity_history", all: [] },
    ]);

    const metrics = initMetrics("usdc-circle", "USDC");
    metrics.totalVolume24hUsd = 20_000;
    metrics.totalVolume7dUsd = 140_000;
    metrics.topPools = [
      {
        poolId: "base:orca-direct",
        project: "orca",
        chain: "solana",
        tvlUsd: 150_000,
        symbol: "USDC / USDT",
        volumeUsd1d: 20_000,
        poolType: "orca-whirlpool",
        source: "direct_api",
      },
      {
        poolId: "base:orca-gt",
        project: "orca",
        chain: "solana",
        tvlUsd: 80_000,
        symbol: "USDC / USDT",
        volumeUsd1d: 15_000,
        poolType: "orca-whirlpool",
        source: "gecko_terminal",
        extra: { effectiveTvl: 80_000 },
      },
    ];

    const result = await computeStablecoinScores(
      db,
      new Map([["usdc-circle", metrics]]),
      new Map([["orca", 180_000]]),
    );

    expect(metrics.totalTvlUsd).toBe(180_000);
    expect(metrics.topPools[0]?.tvlUsd).toBe(150_000);
    expect(metrics.topPools[1]?.tvlUsd).toBe(30_000);
    expect(result.diagnostics.protocolCapReductions).toMatchObject({
      cappedPoolCount: 1,
      cappedProtocols: 1,
      reducedTvlUsd: 50_000,
    });
  });

  it("applies DefiLlama protocol caps to Carbon DeFi chain-suffixed secondary rows", async () => {
    const db = makeQueryDb([
      { match: "FROM dex_liquidity_history", all: [] },
    ]);

    const metrics = initMetrics("xaut-tether", "XAUT");
    metrics.totalVolume24hUsd = 1_000_000;
    metrics.totalVolume7dUsd = 7_000_000;
    metrics.topPools = [
      {
        poolId: "ethereum:0xc537e898cd774e2dcba3b14ea6f34c93d5ea45e1-2236",
        project: "carbon-defi-ethereum",
        chain: "ethereum",
        tvlUsd: 2_000_000_000,
        symbol: "XAUt / sUSDS",
        volumeUsd1d: 1_000_000,
        poolType: "cg-amm",
        source: "cg_onchain",
        extra: { effectiveTvl: 480_000_000 },
      },
    ];

    const result = await computeStablecoinScores(
      db,
      new Map([["xaut-tether", metrics]]),
      new Map([["carbon-defi", 3_500_000]]),
    );

    expect(metrics.totalTvlUsd).toBe(3_500_000);
    expect(metrics.topPools[0]?.tvlUsd).toBe(3_500_000);
    expect(result.globalAgg.protocolTvl["carbon-defi"]).toBe(3_500_000);
    expect(result.diagnostics.protocolCapReductions).toMatchObject({
      cappedPoolCount: 1,
      cappedProtocols: 1,
      reducedTvlUsd: 1_996_500_000,
    });
  });

  it("persists only eligible depth-stability rows and logs DB failures", async () => {
    const nowMs = Date.UTC(2026, 0, 1);
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const db = makeQueryDb([
      {
        match: "FROM dex_liquidity_history",
        all: [
          { stablecoin_id: "usdt-tether", total_tvl_usd: 100, total_volume_24h_usd: 10, coverage_confidence: 1 },
          { stablecoin_id: "usdt-tether", total_tvl_usd: 100, total_volume_24h_usd: 10, coverage_confidence: 1 },
          { stablecoin_id: "usdt-tether", total_tvl_usd: 100, total_volume_24h_usd: 10, coverage_confidence: 1 },
          { stablecoin_id: "usdt-tether", total_tvl_usd: 100, total_volume_24h_usd: 10, coverage_confidence: 1 },
          { stablecoin_id: "usdt-tether", total_tvl_usd: 100, total_volume_24h_usd: 10, coverage_confidence: 1 },
          { stablecoin_id: "usdt-tether", total_tvl_usd: 100, total_volume_24h_usd: 10, coverage_confidence: 1 },
          { stablecoin_id: "usdt-tether", total_tvl_usd: 100, total_volume_24h_usd: 10, coverage_confidence: 1 },
          { stablecoin_id: "usdc-circle", total_tvl_usd: 100, total_volume_24h_usd: 10, coverage_confidence: 1 },
          { stablecoin_id: "usdc-circle", total_tvl_usd: 100, total_volume_24h_usd: 10, coverage_confidence: 1 },
          { stablecoin_id: "usdc-circle", total_tvl_usd: 100, total_volume_24h_usd: 10, coverage_confidence: 1 },
          { stablecoin_id: "usdc-circle", total_tvl_usd: 100, total_volume_24h_usd: 10, coverage_confidence: 1 },
          { stablecoin_id: "usdc-circle", total_tvl_usd: 100, total_volume_24h_usd: 10, coverage_confidence: 1 },
          { stablecoin_id: "usdc-circle", total_tvl_usd: 100, total_volume_24h_usd: 10, coverage_confidence: 1 },
          { stablecoin_id: "dai-makerdao", total_tvl_usd: 0, total_volume_24h_usd: 0, coverage_confidence: 1 },
          { stablecoin_id: "dai-makerdao", total_tvl_usd: 0, total_volume_24h_usd: 0, coverage_confidence: 1 },
          { stablecoin_id: "dai-makerdao", total_tvl_usd: 0, total_volume_24h_usd: 0, coverage_confidence: 1 },
          { stablecoin_id: "dai-makerdao", total_tvl_usd: 0, total_volume_24h_usd: 0, coverage_confidence: 1 },
          { stablecoin_id: "dai-makerdao", total_tvl_usd: 0, total_volume_24h_usd: 0, coverage_confidence: 1 },
          { stablecoin_id: "dai-makerdao", total_tvl_usd: 0, total_volume_24h_usd: 0, coverage_confidence: 1 },
          { stablecoin_id: "dai-makerdao", total_tvl_usd: 0, total_volume_24h_usd: 0, coverage_confidence: 1 },
        ],
      },
    ]);

    await computeDepthStability(db);

    expect(batchExecute).toHaveBeenCalledTimes(1);
    const [, statements] = vi.mocked(batchExecute).mock.calls[0]!;
    const upserts = statements as PreparedStatementWithMeta[];
    expect(upserts).toHaveLength(2);
    expect(upserts[0]?.boundValues).toEqual([]);
    expect(upserts[1]?.boundValues).toEqual([1, "usdt-tether"]);
    expect(logSpy).toHaveBeenCalledWith("[dex-liquidity] Updated depth stability for 1 coins");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(batchExecute).mockClear();

    await expect(
      computeDepthStability(
        makeQueryDb([{ match: "FROM dex_liquidity_history", throwError: new Error("db down") }]),
      ),
    ).resolves.toBeUndefined();
    expect(batchExecute).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith("[dex-liquidity] Depth stability computation failed:", expect.any(Error));
  });

  it("returns early on empty observations and persists weighted-median DEX prices", async () => {
    await computeDexPrices(makeQueryDb([]), new Map<string, PoolEntry[]>(), 1_700_000_000);

    expect(getCache).not.toHaveBeenCalled();
    expect(batchExecute).not.toHaveBeenCalled();

    vi.mocked(getCache).mockResolvedValueOnce({
      value: JSON.stringify({
        peggedAssets: [
          { id: "usdt-tether", symbol: "USDT", price: 1.01 },
          { id: "usdc-circle", symbol: "USDC", price: null },
        ],
      }),
      updatedAt: 1_700_000_000,
    });

    await computeDexPrices(
      makeQueryDb([]),
      new Map<string, PoolEntry[]>([
        [
          "usdt-tether",
          [
            makeDexPricePool({
              poolId: "ethereum:curve-1",
              project: "curve",
              chain: "Ethereum",
              tvlUsd: 400_000,
              price: 0.98,
              source: "dl",
            }),
            makeDexPricePool({
              poolId: "ethereum:curve-2",
              project: "curve",
              chain: "Ethereum",
              tvlUsd: 350_000,
              price: 1.0,
              source: "dl",
            }),
            makeDexPricePool({
              poolId: "base:uni-1",
              project: "uniswap-v3",
              chain: "Base",
              tvlUsd: 250_000,
              price: 1.02,
              source: "direct_api",
            }),
          ],
        ],
        [
          "usdc-circle",
          [
            makeDexPricePool({
              poolId: "base:alien-1",
              project: "alien-base",
              chain: "Base",
              tvlUsd: 100_000,
              price: 1.2,
            }),
          ],
        ],
      ]),
      1_700_000_001,
    );

    expect(batchExecute).toHaveBeenCalledTimes(1);
    const [, statements] = vi.mocked(batchExecute).mock.calls[0]!;
    const upserts = statements as PreparedStatementWithMeta[];
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.boundValues).toEqual([
      "usdt-tether",
      "USDT",
      1,
      3,
      1_000_000,
      -99,
      1.01,
      JSON.stringify([
        { protocol: "curve", chain: "Ethereum", price: 0.98, tvl: 750_000, sourceFamily: "dl" },
        { protocol: "uniswap-v3", chain: "Base", price: 1.02, tvl: 250_000, sourceFamily: "direct_api" },
      ]),
      1_700_000_001,
    ]);
  });

  it("rejects a peg-impossible KRWO price before replacing dex_prices", async () => {
    const diagnostics = await computeDexPrices(
      makeQueryDb([{ match: "SELECT stablecoin_id FROM dex_prices", all: [{ stablecoin_id: "krwo-gimswap" }] }]),
      new Map([
        ["krwo-gimswap", [makeDexPricePool({
          poolId: "bsc:pancakeswap-krwo-usdt",
          project: "pancakeswap",
          chain: "BSC",
          tvlUsd: 82_806,
          price: 1349.284,
          source: "direct_api",
        })]],
      ]),
      1_700_000_001,
    );

    const [, statements] = vi.mocked(batchExecute).mock.calls[0]!;
    const prepared = statements as PreparedStatementWithMeta[];
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.sql).toContain("DELETE FROM dex_prices");
    expect(prepared[0]?.boundValues).toEqual(["krwo-gimswap"]);
    expect(diagnostics).toEqual({
      rejectedObservationCount: 1,
      rejectedByStablecoin: [{
        stablecoinId: "krwo-gimswap",
        reason: "peg-impossible",
        observations: [{
          chain: "BSC",
          protocol: "pancakeswap",
          poolKey: "bsc:pancakeswap-krwo-usdt",
          price: 1349.284,
          tvl: 82_806,
          sourceFamily: "direct_api",
        }],
        truncated: 0,
      }],
      truncatedStablecoins: 0,
    });
  });

  it("persists a correctly oriented KRWO price inside the KRW peg band", async () => {
    await computeDexPrices(
      makeQueryDb([]),
      new Map([
        ["krwo-gimswap", [makeDexPricePool({
          poolId: "bsc:pancakeswap-krwo-usdt",
          project: "pancakeswap",
          chain: "BSC",
          tvlUsd: 82_806,
          price: 0.00074113379,
          source: "direct_api",
        })]],
      ]),
      1_700_000_002,
    );

    const [, statements] = vi.mocked(batchExecute).mock.calls[0]!;
    const prepared = statements as PreparedStatementWithMeta[];
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.sql).toContain("INSERT INTO dex_prices");
    expect(prepared[0]?.boundValues.slice(0, 5)).toEqual([
      "krwo-gimswap",
      "KRWO",
      0.000741,
      1,
      82_806,
    ]);
  });

  it("does not publish retained priced pools below the DEX price observation floor", async () => {
    await computeDexPrices(
      makeQueryDb([]),
      new Map([
        ["usdt-tether", [
          makeDexPricePool({
            poolId: "ethereum:curve-1",
            project: "curve",
            chain: "Ethereum",
            tvlUsd: DEX_PRICE_OBSERVATION_MIN_TVL_USD - 1,
            price: 0.9999,
            source: "dl",
          }),
        ]],
      ]),
      1_700_000_001,
    );

    expect(getCache).not.toHaveBeenCalled();
    expect(batchExecute).not.toHaveBeenCalled();
  });

  it("weights DEX price medians by source family rather than claimed protocol", async () => {
    vi.mocked(getCache).mockResolvedValueOnce({
      value: JSON.stringify({
        peggedAssets: [
          { id: "usdt-tether", symbol: "USDT", price: 1 },
        ],
      }),
      updatedAt: 1_700_000_000,
    });

    await computeDexPrices(
      makeQueryDb([]),
      new Map([
        ["usdt-tether", [
          makeDexPricePool({
            poolId: "ethereum:curve-1",
            project: "curve",
            chain: "Ethereum",
            tvlUsd: 100_000,
            price: 1,
            source: "dl",
          }),
          makeDexPricePool({
            poolId: "solana:raydium-fallback-1",
            project: "raydium",
            chain: "Solana",
            tvlUsd: 180_000,
            price: 1.18,
            source: "dexscreener",
          }),
        ]],
      ]),
      1_700_000_001,
    );

    const [, statements] = vi.mocked(batchExecute).mock.calls[0]!;
    const upserts = statements as PreparedStatementWithMeta[];
    expect(upserts[0]?.boundValues).toEqual([
      "usdt-tether",
      "USDT",
      1,
      2,
      280_000,
      0,
      1,
      JSON.stringify([
        { protocol: "raydium", chain: "Solana", price: 1.18, tvl: 180_000, sourceFamily: "dexscreener" },
        { protocol: "curve", chain: "Ethereum", price: 1, tvl: 100_000, sourceFamily: "dl" },
      ]),
      1_700_000_001,
    ]);
  });

  it("filters high-TVL contaminated DEX prices when most observations agree with the primary price", async () => {
    vi.mocked(getCache).mockResolvedValueOnce({
      value: JSON.stringify({
        peggedAssets: [
          { id: "usdt-tether", symbol: "USDT", price: 0.3 },
        ],
      }),
      updatedAt: 1_700_000_000,
    });

    await computeDexPrices(
      makeQueryDb([]),
      new Map([
        ["usdt-tether", [
          makeDexPricePool({
            poolId: "ethereum:curve-1",
            project: "curve",
            chain: "Ethereum",
            tvlUsd: 100_000,
            price: 0.3,
            source: "dl",
          }),
          makeDexPricePool({
            poolId: "base:uniswap-1",
            project: "uniswap-v3",
            chain: "Base",
            tvlUsd: 100_000,
            price: 0.31,
            source: "direct_api",
          }),
          makeDexPricePool({
            poolId: "solana:raydium-1",
            project: "raydium",
            chain: "Solana",
            tvlUsd: 1_000_000,
            price: 1,
            source: "gecko_terminal",
          }),
        ]],
      ]),
      1_700_000_001,
    );

    const [, statements] = vi.mocked(batchExecute).mock.calls[0]!;
    const upserts = statements as PreparedStatementWithMeta[];
    expect(upserts[0]?.boundValues).toEqual([
      "usdt-tether",
      "USDT",
      0.3,
      3,
      1_200_000,
      0,
      0.3,
      JSON.stringify([
        { protocol: "curve", chain: "Ethereum", price: 0.3, tvl: 100_000, sourceFamily: "dl" },
        { protocol: "uniswap-v3", chain: "Base", price: 0.31, tvl: 100_000, sourceFamily: "direct_api" },
      ]),
      1_700_000_001,
    ]);
  });

  it("ignores malformed cache JSON when computing DEX prices", async () => {
    vi.mocked(getCache).mockResolvedValueOnce({
      value: "{bad-json",
      updatedAt: 1_700_000_000,
    });

    await computeDexPrices(
      makeQueryDb([]),
      new Map([
        ["usdt-tether", [
          makeDexPricePool({
            poolId: "ethereum:curve-1",
            project: "curve",
            chain: "Ethereum",
            tvlUsd: DEX_PRICE_OBSERVATION_MIN_TVL_USD,
            price: 0.99,
            source: "dl",
          }),
        ]],
      ]),
      1_700_000_002,
    );

    const latestBatchCall = vi.mocked(batchExecute).mock.calls[vi.mocked(batchExecute).mock.calls.length - 1]!;
    const [, statements] = latestBatchCall;
    const upserts = statements as PreparedStatementWithMeta[];
    expect(upserts[0]?.boundValues?.[5]).toBe(null);
    expect(upserts[0]?.boundValues?.[6]).toBe(null);
  });

  it("retires dex price rows that are missing from the latest observation set", async () => {
    vi.mocked(getCache).mockResolvedValueOnce({
      value: JSON.stringify({
        peggedAssets: [
          { id: "usdt-tether", symbol: "USDT", price: 1 },
        ],
      }),
      updatedAt: 1_700_000_000,
    });

    await computeDexPrices(
      makeQueryDb([
        {
          match: "SELECT stablecoin_id FROM dex_prices",
          all: [
            { stablecoin_id: "usdt-tether" },
            { stablecoin_id: "usdc-circle" },
          ],
        },
      ]),
      new Map([
        ["usdt-tether", [
          makeDexPricePool({
            poolId: "ethereum:curve-1",
            project: "curve",
            chain: "Ethereum",
            tvlUsd: 100_000,
            price: 0.9999,
            source: "dl",
          }),
        ]],
      ]),
      1_700_000_003,
    );

    const latestBatchCall = vi.mocked(batchExecute).mock.calls[vi.mocked(batchExecute).mock.calls.length - 1]!;
    const [, statements] = latestBatchCall;
    const prepared = statements as PreparedStatementWithMeta[];
    const deleteStmt = prepared.find((stmt) => stmt.sql.includes("DELETE FROM dex_prices"));

    expect(prepared).toHaveLength(2);
    expect(deleteStmt?.boundValues).toEqual(["usdc-circle"]);
  });

  it("clears stale dex price rows when the latest sync has no observations", async () => {
    await computeDexPrices(
      makeQueryDb([
        {
          match: "SELECT stablecoin_id FROM dex_prices",
          all: [
            { stablecoin_id: "usdt-tether" },
            { stablecoin_id: "usdc-circle" },
          ],
        },
      ]),
      new Map<string, PoolEntry[]>(),
      1_700_000_004,
    );

    expect(getCache).not.toHaveBeenCalled();
    const latestBatchCall = vi.mocked(batchExecute).mock.calls[vi.mocked(batchExecute).mock.calls.length - 1]!;
    const [, statements] = latestBatchCall;
    const prepared = statements as PreparedStatementWithMeta[];

    expect(prepared).toHaveLength(2);
    expect(prepared.every((stmt) => stmt.sql.includes("DELETE FROM dex_prices"))).toBe(true);
  });

  it("publishes dex prices from retained priced pools instead of pre-retention discovery observations", async () => {
    vi.mocked(getCache).mockResolvedValueOnce({
      value: JSON.stringify({
        peggedAssets: [
          { id: "usr-resolv", symbol: "USR", price: 0.1129 },
        ],
      }),
      updatedAt: 1_700_000_000,
    });

    await computeDexPrices(
      makeQueryDb([]),
      new Map([
        ["usr-resolv", [
          makeDexPricePool({
            poolId: "ethereum:curve-1",
            project: "curve",
            chain: "Ethereum",
            tvlUsd: 64_711,
            price: 0.1152,
            source: "dl",
          }),
          makeDexPricePool({
            poolId: "ethereum:uniswap-1",
            project: "uniswap",
            chain: "Ethereum",
            tvlUsd: 627_528,
            price: 0.115,
            source: "gecko_terminal",
          }),
        ]],
      ]),
      1_700_000_005,
    );

    const latestBatchCall = vi.mocked(batchExecute).mock.calls[vi.mocked(batchExecute).mock.calls.length - 1]!;
    const [, statements] = latestBatchCall;
    const upserts = statements as PreparedStatementWithMeta[];
    expect(upserts[0]?.boundValues).toEqual([
      "usr-resolv",
      "USR",
      0.115,
      2,
      692_239,
      186,
      0.1129,
      JSON.stringify([
        { protocol: "uniswap", chain: "Ethereum", price: 0.115, tvl: 627_528, sourceFamily: "gecko_terminal" },
        { protocol: "curve", chain: "Ethereum", price: 0.1152, tvl: 64_711, sourceFamily: "dl" },
      ]),
      1_700_000_005,
    ]);
  });

  it("ignores blocked dead DEX protocols when publishing dex prices", async () => {
    vi.mocked(getCache).mockResolvedValueOnce({
      value: JSON.stringify({
        peggedAssets: [
          { id: "usr-resolv", symbol: "USR", price: 0.1129 },
        ],
      }),
      updatedAt: 1_700_000_000,
    });

    await computeDexPrices(
      makeQueryDb([]),
      new Map([
        ["usr-resolv", [
          makeDexPricePool({
            poolId: "ethereum:bunni-1",
            project: "bunni-ethereum",
            chain: "Ethereum",
            tvlUsd: 1_451_774,
            price: 0.9993,
            source: "gecko_terminal",
          }),
          makeDexPricePool({
            poolId: "ethereum:curve-1",
            project: "curve",
            chain: "Ethereum",
            tvlUsd: 64_711,
            price: 0.1152,
            source: "dl",
          }),
        ]],
      ]),
      1_700_000_006,
    );

    const latestBatchCall = vi.mocked(batchExecute).mock.calls[vi.mocked(batchExecute).mock.calls.length - 1]!;
    const [, statements] = latestBatchCall;
    const upserts = statements as PreparedStatementWithMeta[];
    expect(upserts[0]?.boundValues).toEqual([
      "usr-resolv",
      "USR",
      0.1152,
      1,
      64_711,
      204,
      0.1129,
      JSON.stringify([
        { protocol: "curve", chain: "Ethereum", price: 0.1152, tvl: 64_711, sourceFamily: "dl" },
      ]),
      1_700_000_006,
    ]);
  });
});
