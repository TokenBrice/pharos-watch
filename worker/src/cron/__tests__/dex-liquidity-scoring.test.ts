import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/db", () => ({
  batchExecute: vi.fn(async (db: D1Database, stmts: D1PreparedStatement[]) => {
    const state = (db as unknown as { scoringTestState?: { stagedDepthValues: number; stagedPriceRows: number } })
      .scoringTestState;
    if (state) {
      for (const statement of stmts) {
        const sql = (statement as unknown as { sql?: string }).sql ?? "";
        if (sql.includes("SET depth_stability = ?")) state.stagedDepthValues++;
        if (sql.includes("INSERT INTO dex_price_run_rows")) state.stagedPriceRows++;
      }
    }
    return stmts.length;
  }),
  executeAtomicBatch: vi.fn(async (db: D1Database, stmts: D1PreparedStatement[]) => {
    const state = (db as unknown as {
      scoringTestState?: {
        expectedDepthRows: number;
        existingPriceRows: number;
        stagedPriceRows: number;
        publishedPriceRows: number;
      };
    }).scoringTestState;
    const sql = stmts.map((statement) => (statement as unknown as { sql?: string }).sql ?? "").join("\n");
    if (!state) return stmts.length;
    if (sql.includes("UPDATE dex_liquidity") && sql.includes("depth_stability")) {
      return state.expectedDepthRows;
    }
    if (sql.includes("DELETE FROM dex_prices")) {
      const stagedPriceRows = state.stagedPriceRows;
      const changes = 1 + state.existingPriceRows + stagedPriceRows;
      state.publishedPriceRows = stagedPriceRows;
      return changes;
    }
    return stmts.length;
  }),
  isMissingTableError: (error: unknown) => String(error).toLowerCase().includes("no such table"),
  isMissingColumnError: (error: unknown) => String(error).toLowerCase().includes("no such column"),
}));

vi.mock("../../lib/db-cache", () => ({
  getCache: vi.fn(),
}));

import { batchExecute, executeAtomicBatch } from "../../lib/db";
import { getCache } from "../../lib/db-cache";
import { DEX_PRICE_OBSERVATION_MIN_TVL_USD } from "../../lib/constants";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import { buildPoolFingerprint, initMetrics } from "../dex-liquidity/pool-helpers";
import {
  computeDepthStability,
  computeDexPrices,
  computeStablecoinScores,
  DEX_LIQUIDITY_SCORING_BATCH_SIZE,
  loadConfidentHistoryStability,
} from "../dex-liquidity/scoring";
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

interface ScoringTestState {
  expectedDepthRows: number;
  stagedDepthValues: number;
  existingPriceRows: number;
  stagedPriceRows: number;
  publishedPriceRows: number;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function makeQueryDb(configs: QueryConfig[]): D1Database & { history: Array<{ sql: string; binds: unknown[] }> } {
  const history: Array<{ sql: string; binds: unknown[] }> = [];
  const scoringTestState: ScoringTestState = {
    expectedDepthRows: ACTIVE_STABLECOINS.length,
    stagedDepthValues: 0,
    existingPriceRows: 0,
    stagedPriceRows: 0,
    publishedPriceRows: 0,
  };

  function createStatement(sql: string, boundValues: unknown[] = []): PreparedStatementWithMeta {
    const config = configs.find((entry) => sql.includes(entry.match));

    return {
      sql,
      boundValues,
      bind: (...args: unknown[]) => createStatement(sql, args),
      all: async <T>() => {
        history.push({ sql, binds: [...boundValues] });
        if (config?.throwError != null) throw toError(config.throwError);
        const results = config?.all ?? [];
        if (sql.includes("SELECT stablecoin_id FROM dex_prices")) {
          scoringTestState.existingPriceRows = results.length;
        }
        return {
          results: results as T[],
          success: true,
          meta: {},
        };
      },
      first: async <T>() => {
        history.push({ sql, binds: [...boundValues] });
        if (config?.throwError != null) throw toError(config.throwError);
        if (config?.first !== undefined) return config.first as T | null;
        if (sql.includes("pharos:dex-scoring:current-generation")) {
          return {
            state: "published",
            expected_row_count: ACTIVE_STABLECOINS.length + 1,
            current_row_count: ACTIVE_STABLECOINS.length + 1,
            staged_row_count: ACTIVE_STABLECOINS.length + 1,
            public_row_count: ACTIVE_STABLECOINS.length + 1,
          } as T;
        }
        if (sql.includes("pharos:dex-scoring:depth-stage-coverage")) {
          return {
            row_count: ACTIVE_STABLECOINS.length,
            stability_count: scoringTestState.stagedDepthValues,
          } as T;
        }
        if (sql.includes("pharos:dex-scoring:price-stage-coverage")) {
          return { row_count: scoringTestState.stagedPriceRows } as T;
        }
        if (sql.includes("pharos:dex-scoring:price-publication-coverage")) {
          return {
            public_row_count: scoringTestState.publishedPriceRows,
            generation_row_count: scoringTestState.publishedPriceRows,
            staged_row_count: scoringTestState.stagedPriceRows,
          } as T;
        }
        return (config?.first ?? null) as T | null;
      },
      run: async () => {
        history.push({ sql, binds: [...boundValues] });
        if (config?.throwError != null) throw toError(config.throwError);
        if (sql.includes("DELETE FROM dex_price_run_rows WHERE generation_id = ?")) {
          const changes = scoringTestState.stagedPriceRows;
          scoringTestState.stagedPriceRows = 0;
          return { success: true, meta: { changes } };
        }
        return { success: true, meta: { changes: 0 } };
      },
    } as unknown as PreparedStatementWithMeta;
  }

  return {
    prepare: (sql: string) => createStatement(sql),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
    history,
    scoringTestState,
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

function curveExecutionModel(): NonNullable<NonNullable<PoolEntry["extra"]>["ammExecutionModel"]> {
  return {
    source: "curve",
    invariant: "stableswap",
    trackedTokenIndex: 0,
    feeRate: 0.0004,
    amplification: 200,
    tokens: [
      {
        address: "0x0000000000000000000000000000000000000011",
        symbol: "USDC",
        decimals: 6,
        balance: 50_000,
        referencePriceUsd: 1,
        referencePriceSource: "tracked-market",
        trackedAssetId: "usdc-circle",
      },
      {
        address: "0x0000000000000000000000000000000000000012",
        symbol: "USDT",
        decimals: 6,
        balance: 50_000,
        referencePriceUsd: 1,
        referencePriceSource: "tracked-market",
        trackedAssetId: "usdt-tether",
      },
    ],
  };
}

function daiCurveExecutionModel(): NonNullable<NonNullable<PoolEntry["extra"]>["ammExecutionModel"]> {
  return {
    source: "curve",
    invariant: "stableswap",
    trackedTokenIndex: 0,
    feeRate: 0.0004,
    amplification: 200,
    tokens: [
      {
        address: "0x0000000000000000000000000000000000000011",
        symbol: "DAI",
        decimals: 18,
        balance: 50_000,
        referencePriceUsd: 1,
        referencePriceSource: "tracked-market",
        trackedAssetId: "dai-makerdao",
      },
      {
        address: "0x0000000000000000000000000000000000000012",
        symbol: "USDC",
        decimals: 6,
        balance: 50_000,
        referencePriceUsd: 1,
        referencePriceSource: "tracked-market",
        trackedAssetId: "usdc-circle",
      },
    ],
  };
}

describe("dex-liquidity scoring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("loads confidence history in bounded keyset pages without changing stability", async () => {
    const historyRows = Array.from({ length: 1_025 }, (_, index) => ({
      stablecoin_id: index < 700 ? "usdc-circle" : "usdt-tether",
      snapshot_date: index < 700 ? index + 1 : index - 699,
      total_tvl_usd: index < 700 ? 1_000_000 : 2_000_000,
      total_volume_24h_usd: index < 700 ? 100_000 : 200_000,
      coverage_confidence: 1,
    }));
    let queryCount = 0;
    const db = {
      prepare: (sql: string) => ({
        bind: (
          _thirtyDaysAgo: number,
          cursorStablecoinId: string,
          _sameCursorStablecoinId: string,
          cursorSnapshotDate: number,
          limit: number,
        ) => ({
          all: async () => {
            queryCount++;
            return {
              results: historyRows
                .filter(
                  (row) =>
                    row.stablecoin_id > cursorStablecoinId ||
                    (row.stablecoin_id === cursorStablecoinId && row.snapshot_date > cursorSnapshotDate),
                )
                .slice(0, limit),
              success: true,
              meta: {},
            };
          },
        }),
        sql,
      }),
    } as unknown as D1Database;

    const result = await loadConfidentHistoryStability(db);

    expect(queryCount).toBe(3);
    expect(result.tvlStabilityMap).toEqual(
      new Map([
        ["usdc-circle", 1],
        ["usdt-tether", 1],
      ]),
    );
    expect(result.volumeStabilityMap).toEqual(
      new Map([
        ["usdc-circle", 1],
        ["usdt-tether", 1],
      ]),
    );
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

  it("selects exact route evidence below the display top ten without changing the visible pool list", async () => {
    const db = makeQueryDb([{ match: "FROM dex_liquidity_history", all: [] }]);
    const metrics = initMetrics("usdc-circle", "USDC");
    const originalPools = Array.from({ length: 12 }, (_, index): PoolEntry => ({
      poolId: `ethereum:pool-${index}`,
      project: "curve",
      chain: "Ethereum",
      tvlUsd: 100_000 - index,
      symbol: "USDC-USDT",
      volumeUsd1d: 20_000 - index,
      volumeUsd7d: 70_000,
      poolType: "curve-stableswap",
      source: "dl",
      extra: {
        balanceRatio: 0.99,
        balanceDetails: [{ symbol: "USDC", balancePct: 50, isTracked: true }],
        measurement: { tvlMeasured: true, balanceMeasured: true },
        ...(index === 10
          ? {
              ammExecutionModel: curveExecutionModel(),
            }
          : {}),
        measuredExecutionTarget: undefined,
        measuredExecutionProfile: {} as NonNullable<PoolEntry["extra"]>["measuredExecutionProfile"],
        measuredExecutionPhysicalPoolId: `pool-${index}`,
        measuredExecutionDiagnostic: { adapterProfileId: "test-adapter", targetId: `target-${index}` },
      },
    }));
    metrics.topPools = originalPools;

    const result = await computeStablecoinScores(
      db,
      new Map([["usdc-circle", metrics]]),
      new Map(),
    );
    const retainedPools = result.retainedPoolsByStablecoin.get("usdc-circle") ?? [];
    const routeResult = result.scores.get("usdc-circle") as {
      exitRouteObservations?: Array<{
        scope: { contractOrPoolId?: string };
        evidenceKind: string;
        scoreEligible: boolean;
      }>;
      exitRouteObservationCoverage?: {
        retainedPoolCount: number;
        scoreEligiblePoolCount?: number;
        scoreEligibleCapabilityPoolCount?: number;
      };
    } | undefined;

    expect(retainedPools).toHaveLength(12);
    expect(metrics.topPools).toHaveLength(10);
    expect(metrics.topPools.map((pool) => pool.poolId)).toEqual(
      Array.from({ length: 10 }, (_, index) => `ethereum:pool-${index}`),
    );
    expect(routeResult?.exitRouteObservations).toContainEqual(
      expect.objectContaining({
        scope: expect.objectContaining({ contractOrPoolId: "ethereum:pool-10" }),
        evidenceKind: "reserve-based-amm-simulation",
        scoreEligible: true,
      }),
    );
    expect(routeResult?.exitRouteObservationCoverage).toMatchObject({
      retainedPoolCount: 10,
      scoreEligiblePoolCount: 1,
      scoreEligibleCapabilityPoolCount: 1,
    });
    retainedPools.forEach((pool, index) => {
      expect(pool).toBe(originalPools[index]);
      expect(pool.extra).toMatchObject({
        balanceRatio: 0.99,
        balanceDetails: [{ symbol: "USDC", balancePct: 50, isTracked: true }],
        measurement: { tvlMeasured: true, balanceMeasured: true },
      });
      expect(pool.extra).not.toHaveProperty("measuredExecutionTarget");
      expect(pool.extra).not.toHaveProperty("measuredExecutionProfile");
      expect(pool.extra).not.toHaveProperty("measuredExecutionPhysicalPoolId");
      expect(pool.extra).not.toHaveProperty("measuredExecutionDiagnostic");
    });
  });

  it("keeps exact AMM evidence scoreable when its measured target rotates out", async () => {
    const db = makeQueryDb([{ match: "FROM dex_liquidity_history", all: [] }]);
    const metrics = initMetrics("usdc-circle", "USDC");
    metrics.topPools = [{
      poolId: "ethereum:0x0000000000000000000000000000000000000010",
      project: "pancakeswap",
      chain: "Ethereum",
      tvlUsd: 2_000_000,
      symbol: "USDC-USDT",
      volumeUsd1d: 100_000,
      volumeUsd7d: 700_000,
      poolType: "pancakeswap-v3-1bp",
      source: "dl",
      extra: {
        ammExecutionModel: {
          source: "uniswap-v2",
          invariant: "constant-product",
          trackedTokenIndex: 0,
          feeRate: 0.003,
          tokens: [
            {
              address: "0x0000000000000000000000000000000000000011",
              symbol: "USDC",
              decimals: 6,
              balance: 1_000_000,
              referencePriceUsd: 1,
              referencePriceSource: "tracked-market",
              trackedAssetId: "usdc-circle",
            },
            {
              address: "0x0000000000000000000000000000000000000012",
              symbol: "USDT",
              decimals: 6,
              balance: 1_000_000,
              referencePriceUsd: 1,
              referencePriceSource: "tracked-market",
              trackedAssetId: "usdt-tether",
            },
          ],
        },
        executionCapabilityGate: {
          family: "measured-execution",
          reason: "target-unresolved",
        },
      },
    }];

    const result = await computeStablecoinScores(
      db,
      new Map([["usdc-circle", metrics]]),
      new Map(),
    );
    const routeResult = result.scores.get("usdc-circle") as {
      exitRouteObservations?: Array<{ evidenceKind: string; scoreEligible: boolean }>;
      exitRouteObservationCoverage?: {
        scoreEligiblePoolCount?: number;
        scoreEligibleCapabilityPoolCount?: number;
        unsupportedReasons: Record<string, number>;
      };
    } | undefined;

    expect(routeResult?.exitRouteObservations).toContainEqual(
      expect.objectContaining({
        evidenceKind: "reserve-based-amm-simulation",
        scoreEligible: true,
      }),
    );
    expect(routeResult?.exitRouteObservationCoverage).toMatchObject({
      scoreEligiblePoolCount: 1,
      scoreEligibleCapabilityPoolCount: 1,
      unsupportedReasons: {},
    });
  });

  it("fails a retained SunSwap pool closed when its exact native target is missing", async () => {
    const db = makeQueryDb([{ match: "FROM dex_liquidity_history", all: [] }]);
    const metrics = initMetrics("usdt-tether", "USDT");
    metrics.topPools = [{
      poolId: "TFGDbUyP8xez44C76fin3bn3Ss6jugoUwJ",
      project: "sunswap-v2",
      chain: "Tron",
      tvlUsd: 92_000_000,
      symbol: "USDT-WTRX",
      volumeUsd1d: 700_000,
      volumeUsd7d: 4_900_000,
      poolType: "sunswap-v2",
      source: "dl",
    }];

    const result = await computeStablecoinScores(
      db,
      new Map([["usdt-tether", metrics]]),
      new Map(),
      undefined,
      1_752_560_000,
      new Map(),
      new Map(),
      undefined,
      new Map(),
      new Map(),
      new Map(),
    );
    const retainedPool = result.retainedPoolsByStablecoin.get("usdt-tether")?.[0];
    const routeResult = result.scores.get("usdt-tether") as {
      exitRouteObservationCoverage?: { unsupportedReasons: Record<string, number> };
    } | undefined;

    expect(retainedPool?.extra?.executionCapabilityGate).toEqual({
      family: "measured-execution",
      reason: "target-unresolved",
    });
    expect(routeResult?.exitRouteObservationCoverage?.unsupportedReasons).toMatchObject({
      "executionCapabilityGate:measured-execution:target-unresolved": 1,
    });
  });

  it("fails coverage closed when reviewed route capabilities overflow the bounded payload", async () => {
    const db = makeQueryDb([{ match: "FROM dex_liquidity_history", all: [] }]);
    const metrics = initMetrics("usdc-circle", "USDC");
    metrics.topPools = Array.from({ length: 11 }, (_, index): PoolEntry => ({
      poolId: `ethereum:exact-pool-${index}`,
      project: "curve",
      chain: "Ethereum",
      tvlUsd: 100_000 - index,
      symbol: "USDC-USDT",
      volumeUsd1d: 20_000 - index,
      volumeUsd7d: 140_000 - index,
      poolType: "curve-stableswap",
      source: "dl",
      extra: { ammExecutionModel: curveExecutionModel() },
    }));

    const result = await computeStablecoinScores(
      db,
      new Map([["usdc-circle", metrics]]),
      new Map(),
    );
    const routeResult = result.scores.get("usdc-circle") as {
      exitRouteObservations?: Array<{ scope: { contractOrPoolId?: string } }>;
      exitRouteObservationCoverage?: {
        retainedPoolCount: number;
        observationCount: number;
        scoreEligibleObservationCount: number;
        scoreEligiblePoolCount?: number;
        scoreEligibleCapabilityPoolCount?: number;
        unsupportedPoolCount: number;
        unsupportedReasons: Record<string, number>;
      };
    } | undefined;

    expect(metrics.topPools.map((pool) => pool.poolId)).toEqual(
      Array.from({ length: 10 }, (_, index) => `ethereum:exact-pool-${index}`),
    );
    expect(routeResult?.exitRouteObservations).toHaveLength(10);
    expect(routeResult?.exitRouteObservations).not.toContainEqual(
      expect.objectContaining({
        scope: expect.objectContaining({ contractOrPoolId: "ethereum:exact-pool-10" }),
      }),
    );
    expect(routeResult?.exitRouteObservationCoverage).toMatchObject({
      retainedPoolCount: 11,
      observationCount: 10,
      scoreEligibleObservationCount: 10,
      scoreEligiblePoolCount: 10,
      scoreEligibleCapabilityPoolCount: 11,
      unsupportedPoolCount: 1,
      unsupportedReasons: { routeSelectionCapabilityOverflow: 1 },
    });
  });

  it("packs DAI-shaped multi-output routes so every selected physical pool is emitted", async () => {
    const db = makeQueryDb([{ match: "FROM dex_liquidity_history", all: [] }]);
    const metrics = initMetrics("dai-makerdao", "DAI");
    metrics.topPools = [
      ...Array.from({ length: 3 }, (_, index): PoolEntry => ({
        poolId: `ethereum:dai-balancer-three-token-${index}`,
        project: "balancer",
        chain: "Ethereum",
        tvlUsd: 300_000 - index,
        symbol: "DAI-USDC-USDT",
        volumeUsd1d: 30_000 - index,
        volumeUsd7d: 210_000 - index,
        poolType: "balancer-weighted",
        source: "direct_api",
        extra: {
          ammExecutionModel: {
            source: "balancer",
            invariant: "weighted-constant-mean",
            trackedTokenIndex: 0,
            feeRate: 0.001,
            tokens: [
              {
                address: "0x0000000000000000000000000000000000000011",
                symbol: "DAI",
                decimals: 18,
                balance: 100_000,
                referencePriceUsd: 1,
                referencePriceSource: "tracked-market",
                trackedAssetId: "dai-makerdao",
                weight: 0.34,
              },
              {
                address: "0x0000000000000000000000000000000000000012",
                symbol: "USDC",
                decimals: 6,
                balance: 100_000,
                referencePriceUsd: 1,
                referencePriceSource: "tracked-market",
                trackedAssetId: "usdc-circle",
                weight: 0.33,
              },
              {
                address: "0x0000000000000000000000000000000000000013",
                symbol: "USDT",
                decimals: 6,
                balance: 100_000,
                referencePriceUsd: 1,
                referencePriceSource: "tracked-market",
                trackedAssetId: "usdt-tether",
                weight: 0.33,
              },
            ],
          },
        },
      })),
      ...Array.from({ length: 7 }, (_, index): PoolEntry => ({
        poolId: `ethereum:dai-curve-pool-${index}`,
        project: "curve",
        chain: "Ethereum",
        tvlUsd: 100_000 - index,
        symbol: "DAI-USDC",
        volumeUsd1d: 20_000 - index,
        volumeUsd7d: 140_000 - index,
        poolType: "curve-stableswap",
        source: "dl",
        extra: { ammExecutionModel: daiCurveExecutionModel() },
      })),
    ];

    const result = await computeStablecoinScores(
      db,
      new Map([["dai-makerdao", metrics]]),
      new Map(),
    );
    const routeResult = result.scores.get("dai-makerdao") as {
      exitRouteObservations?: Array<{
        scope: { contractOrPoolId?: string };
        output: { trackedAssetIds?: string[] };
      }>;
      exitRouteObservationCoverage?: {
        retainedPoolCount: number;
        observationCount: number;
        scoreEligibleObservationCount: number;
        scoreEligiblePoolCount?: number;
        scoreEligibleCapabilityPoolCount?: number;
        unsupportedPoolCount: number;
        unsupportedReasons: Record<string, number>;
      };
    } | undefined;

    expect(routeResult?.exitRouteObservations).toHaveLength(10);
    expect(routeResult?.exitRouteObservations?.map((observation) => observation.scope.contractOrPoolId)).toEqual([
      ...Array.from({ length: 3 }, (_, index) => `ethereum:dai-balancer-three-token-${index}`),
      ...Array.from({ length: 7 }, (_, index) => `ethereum:dai-curve-pool-${index}`),
    ]);
    expect(routeResult?.exitRouteObservations?.slice(0, 3).map((observation) => observation.output.trackedAssetIds)).toEqual(
      [["usdc-circle"], ["usdc-circle"], ["usdc-circle"]],
    );
    expect(routeResult?.exitRouteObservationCoverage).toMatchObject({
      retainedPoolCount: 10,
      observationCount: 10,
      scoreEligibleObservationCount: 10,
      scoreEligiblePoolCount: 10,
      scoreEligibleCapabilityPoolCount: 10,
      unsupportedPoolCount: 0,
    });
    expect(routeResult?.exitRouteObservationCoverage?.unsupportedReasons).not.toHaveProperty(
      "routeObservationPayloadOverflow",
    );
  });

  it("keeps pool coverage complete when clipping only extra outputs from represented pools", async () => {
    const db = makeQueryDb([{ match: "FROM dex_liquidity_history", all: [] }]);
    const metrics = initMetrics("usdc-circle", "USDC");
    metrics.topPools = Array.from({ length: 2 }, (_, poolIndex): PoolEntry => ({
      poolId: `ethereum:balancer-eight-token-${poolIndex}`,
      project: "balancer",
      chain: "Ethereum",
      tvlUsd: 400_000 - poolIndex,
      symbol: "USDC-MULTI",
      volumeUsd1d: 30_000 - poolIndex,
      volumeUsd7d: 210_000 - poolIndex,
      poolType: "balancer-weighted",
      source: "direct_api",
      extra: {
        ammExecutionModel: {
          source: "balancer",
          invariant: "weighted-constant-mean",
          trackedTokenIndex: 0,
          feeRate: 0.001,
          tokens: Array.from({ length: 8 }, (_, tokenIndex) => ({
            address: `0x${(poolIndex * 16 + tokenIndex + 1).toString(16).padStart(40, "0")}`,
            symbol: tokenIndex === 0 ? "USDC" : `TOKEN-${poolIndex}-${tokenIndex}`,
            decimals: 18,
            balance: 50_000,
            referencePriceUsd: 1,
            referencePriceSource: "tracked-market" as const,
            ...(tokenIndex === 0 ? { trackedAssetId: "usdc-circle" } : {}),
            weight: 0.125,
          })),
        },
      },
    }));

    const result = await computeStablecoinScores(
      db,
      new Map([["usdc-circle", metrics]]),
      new Map(),
    );
    const routeResult = result.scores.get("usdc-circle") as {
      exitRouteObservations?: unknown[];
      exitRouteObservationCoverage?: {
        retainedPoolCount: number;
        observationCount: number;
        scoreEligibleObservationCount: number;
        scoreEligiblePoolCount?: number;
        scoreEligibleCapabilityPoolCount?: number;
        unsupportedPoolCount: number;
        unsupportedReasons: Record<string, number>;
      };
    } | undefined;

    expect(routeResult?.exitRouteObservations).toHaveLength(10);
    expect(routeResult?.exitRouteObservationCoverage).toMatchObject({
      retainedPoolCount: 2,
      observationCount: 10,
      scoreEligibleObservationCount: 10,
      scoreEligiblePoolCount: 2,
      scoreEligibleCapabilityPoolCount: 2,
      unsupportedPoolCount: 0,
    });
    expect(routeResult?.exitRouteObservationCoverage?.unsupportedReasons).not.toHaveProperty(
      "routeObservationPayloadOverflow",
    );
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

  it("publishes normalized Aerodrome Slipstream rows into the shadow target inventory", async () => {
    const db = makeQueryDb([{ match: "FROM dex_liquidity_history", all: [] }]);
    const metrics = initMetrics("usdc-circle", "USDC");
    const poolId = "base:0x1111111111111111111111111111111111111111";
    metrics.topPools = [
      {
        poolId,
        project: "aerodrome",
        chain: "Base",
        tvlUsd: 250_000,
        symbol: "USDC / USDbC",
        volumeUsd1d: 25_000,
        volumeUsd7d: 175_000,
        poolType: "aerodrome-slipstream-1bp",
        source: "direct_api",
      },
    ];
    const target: DexMeasuredExecutionTarget = {
      schemaVersion: "dex-measured-target-v1",
      targetId: "normalized-aerodrome-slipstream-target",
      stablecoinId: "usdc-circle",
      adapterProfileId: "aerodrome-slipstream-quoter-v2",
      protocol: "aerodrome-slipstream",
      chain: "base",
      poolId,
      poolTokenAddresses: [
        "0x2222222222222222222222222222222222222222",
        "0x3333333333333333333333333333333333333333",
      ],
      tokenIn: {
        address: "0x2222222222222222222222222222222222222222",
        symbol: "USDC",
        decimals: 6,
        referencePriceUsd: 1,
        trackedAssetId: "usdc-circle",
      },
      tokenOut: {
        address: "0x3333333333333333333333333333333333333333",
        symbol: "USDbC",
        decimals: 6,
        referencePriceUsd: 1,
      },
      tickSpacing: 1,
      retainedTvlUsd: 250_000,
      retainedPoolPriceUsd: 1,
      capturedAt: 1_700_000_000,
    };
    const slipstreamTargets = new Map([
      ["usdc-circle|base:0x1111111111111111111111111111111111111111", target],
    ]);

    const result = await computeStablecoinScores(
      db,
      new Map([["usdc-circle", metrics]]),
      new Map(),
      undefined,
      1_700_000_100,
      new Map(),
      new Map(),
      undefined,
      new Map(),
      slipstreamTargets,
    );

    expect(result.diagnostics.measuredExecution.inventoryTargetCount).toBe(1);
    expect(slipstreamTargets).toHaveLength(0);
  });

  it("joins a DeFiLlama Slipstream fingerprint to the unique exact target inside the TVL window", async () => {
    const db = makeQueryDb([{ match: "FROM dex_liquidity_history", all: [] }]);
    const cadc = "0x043eb4b75d0805c43d7c834902e335621983cf03";
    const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const metrics = initMetrics("cadc-cad-coin", "CADC");
    metrics.topPools = [
      {
        poolId: buildPoolFingerprint("base", "aerodrome", [cadc, usdc])!,
        project: "aerodrome",
        chain: "Base",
        tvlUsd: 157_000,
        symbol: "CADC-USDC",
        volumeUsd1d: 31_000,
        volumeUsd7d: 217_000,
        poolType: "aerodrome-slipstream-5bp",
        source: "dl",
      },
    ];
    const makeTarget = (
      poolId: string,
      retainedTvlUsd: number,
      tickSpacing: number,
    ): DexMeasuredExecutionTarget => ({
      schemaVersion: "dex-measured-target-v1",
      targetId: `target:${poolId}`,
      stablecoinId: "cadc-cad-coin",
      adapterProfileId: "aerodrome-slipstream-quoter-v2",
      protocol: "aerodrome-slipstream",
      chain: "base",
      poolId,
      poolTokenAddresses: [cadc, usdc],
      tokenIn: {
        address: cadc,
        symbol: "CADC",
        decimals: 18,
        referencePriceUsd: 0.711,
        trackedAssetId: "cadc-cad-coin",
      },
      tokenOut: {
        address: usdc,
        symbol: "USDC",
        decimals: 6,
        referencePriceUsd: 1,
        trackedAssetId: "usdc-circle",
      },
      tickSpacing,
      retainedTvlUsd,
      retainedPoolPriceUsd: 0.711,
      capturedAt: 1_785_084_000,
    });
    const primary = makeTarget(
      "base:0x09da4832d34bebbb55783340d5bede7a70f5c48e",
      156_900,
      10,
    );
    const dustSibling = makeTarget(
      "base:0xd12f263309f05d70d88d264ad0210d7c4d1cb54a",
      1.13,
      1,
    );
    const slipstreamTargets = new Map([
      [`cadc-cad-coin|${primary.poolId}`, primary],
      [`cadc-cad-coin|${dustSibling.poolId}`, dustSibling],
    ]);

    const result = await computeStablecoinScores(
      db,
      new Map([["cadc-cad-coin", metrics]]),
      new Map(),
      undefined,
      1_785_084_100,
      new Map(),
      new Map(),
      undefined,
      new Map(),
      slipstreamTargets,
    );

    expect(result.diagnostics.measuredExecution.inventoryTargetCount).toBe(1);
    expect(slipstreamTargets).toHaveLength(0);
  });

  it("does not misattribute an unsupported Pancake pool family to the V3 adapter", async () => {
    const db = makeQueryDb([{ match: "FROM dex_liquidity_history", all: [] }]);
    const metrics = initMetrics("cadc-cad-coin", "CADC");
    metrics.topPools = [
      {
        poolId: "base:0x31a98819f70438b162c6f9a6d342e9e84f84c825c0348dac23b9fbcb9d282139",
        project: "pancakeswap",
        chain: "Base",
        tvlUsd: 10_327,
        symbol: "CADC / USDC",
        volumeUsd1d: 8,
        volumeUsd7d: 56,
        poolType: "cg-amm",
        source: "cg_onchain",
      },
    ];

    const result = await computeStablecoinScores(
      db,
      new Map([["cadc-cad-coin", metrics]]),
      new Map(),
    );
    const retained = result.retainedPoolsByStablecoin.get("cadc-cad-coin")?.[0];

    expect(retained?.extra?.executionCapabilityGate).toBeUndefined();
    expect(result.diagnostics.measuredExecution.inventoryTargetCount).toBe(0);
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

  it("publishes only eligible depth-stability rows and propagates DB failures", async () => {
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

    await computeDepthStability(db, undefined, "dex-liquidity-test");

    expect(batchExecute).toHaveBeenCalledTimes(1);
    const [, statements] = vi.mocked(batchExecute).mock.calls[0]!;
    const upserts = statements as PreparedStatementWithMeta[];
    expect(upserts).toHaveLength(2);
    expect(upserts[0]?.boundValues).toEqual(["dex-liquidity-test"]);
    expect(upserts[1]?.boundValues).toEqual([1, "usdt-tether", "dex-liquidity-test"]);
    expect(executeAtomicBatch).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      "[dex-liquidity] Published depth stability for 1 coins from dex-liquidity-test",
    );

    vi.mocked(batchExecute).mockClear();

    await expect(
      computeDepthStability(
        makeQueryDb([{ match: "FROM dex_liquidity_history", throwError: new Error("db down") }]),
        undefined,
        "dex-liquidity-test",
      ),
    ).rejects.toThrow("db down");
    expect(batchExecute).not.toHaveBeenCalled();
  });

  it("constructs depth updates in bounded order", async () => {
    const stabilityRows = new Map(
      ACTIVE_STABLECOINS.slice(0, 60).map((coin, index) => [coin.id, index / 100] as const),
    );

    await computeDepthStability(makeQueryDb([]), stabilityRows, "dex-liquidity-test");

    const calls = vi.mocked(batchExecute).mock.calls;
    expect(calls.map(([, statements]) => statements.length)).toEqual([25, 25, 11]);
    expect(calls.every(([, statements]) => statements.length <= DEX_LIQUIDITY_SCORING_BATCH_SIZE)).toBe(true);
    const prepared = calls.flatMap(([, statements]) => statements as PreparedStatementWithMeta[]);
    expect(prepared[0]?.sql).toContain("SET depth_stability = NULL");
    expect(prepared.slice(1).map((statement) => statement.boundValues[1])).toEqual([...stabilityRows.keys()]);
  });

  it("atomically publishes an empty or weighted-median DEX price generation", async () => {
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
      "dex-liquidity-1700000001",
    ]);
  });

  it("constructs DEX price writes in bounded stablecoin order", async () => {
    const coins = ACTIVE_STABLECOINS.slice(0, 30);
    const retainedPools = new Map<string, PoolEntry[]>(coins.map((coin, index) => [
      coin.id,
      [makeDexPricePool({
        poolId: `ethereum:pool-${index}`,
        project: "curve",
        chain: "Ethereum",
        tvlUsd: 100_000,
        price: 1,
        source: "dl",
      })],
    ]));

    await computeDexPrices(makeQueryDb([]), retainedPools, 1_700_000_000);

    const calls = vi.mocked(batchExecute).mock.calls;
    expect(calls.map(([, statements]) => statements.length)).toEqual([25, 5]);
    expect(calls.every(([, statements]) => statements.length <= DEX_LIQUIDITY_SCORING_BATCH_SIZE)).toBe(true);
    const prepared = calls.flatMap(([, statements]) => statements as PreparedStatementWithMeta[]);
    expect(prepared.map((statement) => statement.boundValues[0])).toEqual(coins.map((coin) => coin.id));
  });

  it("stops constructing DEX prices after a bounded write aborts", async () => {
    const controller = new AbortController();
    const abortReason = new Error("DEX price publication timed out");
    const coins = ACTIVE_STABLECOINS.slice(0, 30);
    const retainedPools = new Map<string, PoolEntry[]>(coins.map((coin, index) => [
      coin.id,
      [makeDexPricePool({
        poolId: `ethereum:pool-${index}`,
        project: "curve",
        chain: "Ethereum",
        tvlUsd: 100_000,
        price: 1,
      })],
    ]));
    vi.mocked(batchExecute).mockImplementationOnce(async (_db, statements) => {
      controller.abort(abortReason);
      return statements.length;
    });

    await expect(
      computeDexPrices(makeQueryDb([]), retainedPools, 1_700_000_000, undefined, controller.signal),
    ).rejects.toThrow("DEX price publication timed out");

    expect(batchExecute).toHaveBeenCalledTimes(1);
    expect(vi.mocked(batchExecute).mock.calls[0]?.[1]).toHaveLength(DEX_LIQUIDITY_SCORING_BATCH_SIZE);
  });

  it("rejects a peg-impossible KRW price before replacing dex_prices", async () => {
    const diagnostics = await computeDexPrices(
      makeQueryDb([{ match: "SELECT stablecoin_id FROM dex_prices", all: [{ stablecoin_id: "krwq-iq" }] }]),
      new Map([
        ["krwq-iq", [makeDexPricePool({
          poolId: "bsc:pancakeswap-krwq-usdt",
          project: "pancakeswap",
          chain: "BSC",
          tvlUsd: 82_806,
          price: 1349.284,
          source: "direct_api",
        })]],
      ]),
      1_700_000_001,
    );

    expect(batchExecute).not.toHaveBeenCalled();
    const [, atomicStatements] = vi.mocked(executeAtomicBatch).mock.calls[0]!;
    const prepared = atomicStatements as PreparedStatementWithMeta[];
    expect(prepared).toHaveLength(3);
    expect(prepared[0]?.sql).toContain("price-publication-fence");
    expect(prepared[1]?.sql).toContain("DELETE FROM dex_prices");
    expect(diagnostics).toEqual({
      rejectedObservationCount: 1,
      rejectedByStablecoin: [{
        stablecoinId: "krwq-iq",
        reason: "peg-impossible",
        observations: [{
          chain: "BSC",
          protocol: "pancakeswap",
          poolKey: "bsc:pancakeswap-krwq-usdt",
          price: 1349.284,
          tvl: 82_806,
          sourceFamily: "direct_api",
        }],
        truncated: 0,
      }],
      truncatedStablecoins: 0,
      retention: {
        cutoff: 1_700_000_001 - 3 * 60 * 60,
        deletedRows: 0,
        oldestRemainingAt: null,
        durationMs: expect.any(Number),
        error: null,
      },
    });
  });

  it("persists a correctly oriented KRW price inside the KRW peg band", async () => {
    await computeDexPrices(
      makeQueryDb([]),
      new Map([
        ["krwq-iq", [makeDexPricePool({
          poolId: "bsc:pancakeswap-krwq-usdt",
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
    expect(prepared[0]?.sql).toContain("INSERT INTO dex_price_run_rows");
    expect(prepared[0]?.boundValues.slice(0, 5)).toEqual([
      "krwq-iq",
      "KRWQ",
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
      "dex-liquidity-1700000001",
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
      "dex-liquidity-1700000001",
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

    const latestAtomicCall = vi.mocked(executeAtomicBatch).mock.calls[vi.mocked(executeAtomicBatch).mock.calls.length - 1]!;
    const [, statements] = latestAtomicCall;
    const prepared = statements as PreparedStatementWithMeta[];

    expect(prepared).toHaveLength(3);
    expect(prepared[0]?.sql).toContain("price-publication-fence");
    expect(prepared[1]?.sql).toContain("DELETE FROM dex_prices");
    expect(prepared[2]?.sql).toContain("INSERT INTO dex_prices");
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
    const latestAtomicCall = vi.mocked(executeAtomicBatch).mock.calls[vi.mocked(executeAtomicBatch).mock.calls.length - 1]!;
    const [, statements] = latestAtomicCall;
    const prepared = statements as PreparedStatementWithMeta[];

    expect(batchExecute).not.toHaveBeenCalled();
    expect(prepared).toHaveLength(3);
    expect(prepared[0]?.sql).toContain("price-publication-fence");
    expect(prepared[1]?.sql).toContain("DELETE FROM dex_prices");
    expect(prepared[2]?.sql).toContain("INSERT INTO dex_prices");
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
      "dex-liquidity-1700000005",
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
      "dex-liquidity-1700000006",
    ]);
  });
});
