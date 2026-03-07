import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/db", () => ({
  getCache: vi.fn(),
  batchExecute: vi.fn(async (_db: D1Database, stmts: D1PreparedStatement[]) => stmts.length),
}));

import { batchExecute, getCache } from "../../lib/db";
import { initMetrics } from "../dex-liquidity/pool-helpers";
import { computeDepthStability, computeDexPrices, computeStablecoinScores } from "../dex-liquidity/scoring";
import type { DexPriceObs } from "../dex-liquidity/types";

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
        poolType: "curve-stableswap",
        source: "dl",
        extra: { effectiveTvl: 90_000 },
      },
      {
        poolId: "ethereum:sushi-dl",
        project: "sushiswap",
        chain: "Ethereum",
        tvlUsd: 20_000,
        symbol: "USDT-USDE",
        volumeUsd1d: 5_000,
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
        poolType: "generic",
        source: "cg",
        extra: { effectiveTvl: 80_000 },
      },
      {
        poolId: "arbitrum:sushi-gt",
        project: "sushiswap",
        chain: "Arbitrum",
        tvlUsd: 70_000,
        symbol: "USDT-USDC",
        volumeUsd1d: 35_000,
        poolType: "generic",
        source: "gt",
        extra: { effectiveTvl: 70_000 },
      },
      {
        poolId: "ethereum:bad-ratio",
        project: "curve",
        chain: "Ethereum",
        tvlUsd: 1_000,
        symbol: "USDT-USDC",
        volumeUsd1d: 100_000,
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
        poolType: "generic",
        source: "gt",
      },
      ...Array.from({ length: 9 }, (_, index) => ({
        poolId: `ethereum:extra-${index + 1}`,
        project: "curve",
        chain: "Ethereum",
        tvlUsd: 10_000,
        symbol: `USDT-PAIR-${index + 1}`,
        volumeUsd1d: 30_000 - index * 1_000,
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
        poolType: "generic",
        source: "gt",
        extra: { effectiveTvl: 90_000 },
      },
      {
        poolId: "base:curve-unique",
        project: "curve",
        chain: "Base",
        tvlUsd: 40_000,
        symbol: "USDC-DAI",
        volumeUsd1d: 10_000,
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
      vol24h: 777_000,
      weightedBalanceRatio: 0.75,
      organicFrac: 0.625,
      avgStress: 0,
      lockedLiqPct: 0.5,
    });
    expect(usdtScore?.hhi).toBeCloseTo(0.2226, 4);

    expect(globalAgg.poolCount).toBe(15);
    expect(globalAgg.totalVol24h).toBe(404_000);
    expect(globalAgg.totalVol7d).toBe(6_292_100);
    expect(globalAgg.totalTvl).toBeCloseTo(330_000, 6);
    expect(globalAgg.protocolTvl.sushiswap).toBe(100_000);
    expect(globalAgg.chainTvl.ethereum).toBeCloseTo(222_982.632, 3);
    expect(globalAgg.chainTvl.arbitrum).toBeCloseTo(19_648.947, 3);
    expect(globalAgg.chainTvl.base).toBeCloseTo(87_368.421, 3);
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

  it("persists only eligible depth-stability rows and logs DB failures", async () => {
    const nowMs = Date.UTC(2026, 0, 1);
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const db = makeQueryDb([
      {
        match: "FROM dex_liquidity_history",
        all: [
          { stablecoin_id: "usdt-tether", total_tvl_usd: 100 },
          { stablecoin_id: "usdt-tether", total_tvl_usd: 100 },
          { stablecoin_id: "usdt-tether", total_tvl_usd: 100 },
          { stablecoin_id: "usdt-tether", total_tvl_usd: 100 },
          { stablecoin_id: "usdt-tether", total_tvl_usd: 100 },
          { stablecoin_id: "usdt-tether", total_tvl_usd: 100 },
          { stablecoin_id: "usdt-tether", total_tvl_usd: 100 },
          { stablecoin_id: "usdc-circle", total_tvl_usd: 100 },
          { stablecoin_id: "usdc-circle", total_tvl_usd: 100 },
          { stablecoin_id: "usdc-circle", total_tvl_usd: 100 },
          { stablecoin_id: "usdc-circle", total_tvl_usd: 100 },
          { stablecoin_id: "usdc-circle", total_tvl_usd: 100 },
          { stablecoin_id: "usdc-circle", total_tvl_usd: 100 },
          { stablecoin_id: "dai-makerdao", total_tvl_usd: 0 },
          { stablecoin_id: "dai-makerdao", total_tvl_usd: 0 },
          { stablecoin_id: "dai-makerdao", total_tvl_usd: 0 },
          { stablecoin_id: "dai-makerdao", total_tvl_usd: 0 },
          { stablecoin_id: "dai-makerdao", total_tvl_usd: 0 },
          { stablecoin_id: "dai-makerdao", total_tvl_usd: 0 },
          { stablecoin_id: "dai-makerdao", total_tvl_usd: 0 },
        ],
      },
    ]);

    await computeDepthStability(db);

    expect(batchExecute).toHaveBeenCalledTimes(1);
    const [, statements] = vi.mocked(batchExecute).mock.calls[0]!;
    const upserts = statements as PreparedStatementWithMeta[];
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.boundValues).toEqual([1, "usdt-tether"]);
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
    await computeDexPrices(makeQueryDb([]), new Map<string, DexPriceObs[]>(), 1_700_000_000);

    expect(getCache).not.toHaveBeenCalled();
    expect(batchExecute).not.toHaveBeenCalled();

    vi.mocked(getCache).mockResolvedValueOnce({
      value: JSON.stringify({
        peggedAssets: [
          { id: "usdt-tether", price: 1.01 },
          { id: "usdc-circle", price: null },
        ],
      }),
      updatedAt: 1_700_000_000,
    });

    await computeDexPrices(
      makeQueryDb([]),
      new Map<string, DexPriceObs[]>([
        [
          "usdt-tether",
          [
            { price: 0.98, tvl: 40, chain: "Ethereum", protocol: "curve" },
            { price: 1.0, tvl: 35, chain: "Ethereum", protocol: "curve" },
            { price: 1.02, tvl: 25, chain: "Base", protocol: "uniswap-v3" },
          ],
        ],
        [
          "usdc-circle",
          [
            { price: 1.2, tvl: 10, chain: "Base", protocol: "alien-base" },
          ],
        ],
      ]),
      1_700_000_001,
    );

    expect(batchExecute).toHaveBeenCalledTimes(1);
    const [, statements] = vi.mocked(batchExecute).mock.calls[0]!;
    const upserts = statements as PreparedStatementWithMeta[];
    expect(upserts).toHaveLength(2);
    expect(upserts[0]?.boundValues).toEqual([
      "usdt-tether",
      "USDT",
      1,
      3,
      100,
      -99,
      1.01,
      JSON.stringify([
        { protocol: "curve", chain: "Ethereum", price: 0.98, tvl: 40 },
        { protocol: "curve", chain: "Ethereum", price: 1, tvl: 35 },
        { protocol: "uniswap-v3", chain: "Base", price: 1.02, tvl: 25 },
      ]),
      1_700_000_001,
    ]);
    expect(upserts[1]?.boundValues).toEqual([
      "usdc-circle",
      "USDC",
      1.2,
      1,
      10,
      null,
      null,
      JSON.stringify([{ protocol: "alien-base", chain: "Base", price: 1.2, tvl: 10 }]),
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
        ["usdt-tether", [{ price: 0.99, tvl: 5, chain: "Ethereum", protocol: "curve" }]],
      ]),
      1_700_000_002,
    );

    const latestBatchCall = vi.mocked(batchExecute).mock.calls[vi.mocked(batchExecute).mock.calls.length - 1]!;
    const [, statements] = latestBatchCall;
    const upserts = statements as PreparedStatementWithMeta[];
    expect(upserts[0]?.boundValues?.[5]).toBe(null);
    expect(upserts[0]?.boundValues?.[6]).toBe(null);
  });
});
