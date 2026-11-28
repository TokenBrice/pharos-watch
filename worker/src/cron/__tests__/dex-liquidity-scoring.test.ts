import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { makeNoopD1 } from "../../test-helpers/noop-d1";

vi.mock("../../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/db")>();
  return {
    ...actual,
    batchExecute: vi.fn(async (db: D1Database, stmts: D1PreparedStatement[]) => {
      const state = (db as unknown as { scoringTestState?: ScoringTestState }).scoringTestState;
      if (state) {
        for (const s of stmts) {
          const sql = (s as unknown as { sql?: string }).sql ?? "";
          if (sql.includes("INSERT INTO dex_price_run_rows")) state.stagedPriceRows++;
          if (sql.includes("INSERT INTO dex_measured_execution_targets")) state.measuredTargetRows++;
        }
      }
      return stmts.length;
    }),
    executeAtomicBatch: vi.fn(async (db: D1Database, stmts: D1PreparedStatement[]) => {
      const state = (db as unknown as { scoringTestState?: ScoringTestState }).scoringTestState;
      const sql = stmts.map((s) => (s as unknown as { sql?: string }).sql ?? "").join("\n");
      if (!state || !sql.includes("DELETE FROM dex_prices")) return stmts.length;
      const changes = 1 + state.existingPriceRows + state.stagedPriceRows;
      state.publishedPriceRows = state.stagedPriceRows;
      return changes;
    }),
    isMissingTableError: (error: unknown) => String(error).toLowerCase().includes("no such table"),
    isMissingColumnError: (error: unknown) => String(error).toLowerCase().includes("no such column"),
  };
});

import { batchExecute } from "../../lib/db";
import { buildDexPriceObservationsFromRetainedPools } from "../dex-liquidity/scoring-helpers";
import type { FluidSwapStatus } from "@shared/types/dex-liquidity";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import { CURVE_R3_METAPOOL_POLICIES, CURVE_USD1_METAPOOL_POLICY } from "@shared/lib/curve-composite-policies";
import { buildCurveCompositeMeasuredExecutionTarget } from "../measured-execution/curve-composite";
import type { ExitRouteObservation } from "@shared/types/exit-route";
import { buildPoolFingerprint, initSourcePoolGraph } from "../dex-liquidity/pool-helpers";
import { makePool } from "../dex-liquidity/__tests__/scoring-test-builders";
import { DEX_VOLUME_OBSERVATION_MAX_AGE_SEC, summarizeDexVolumeWindow } from "@shared/lib/dex-volume-availability";
import {
  computeDexPrices,
  computeSeriesStability,
  computeStablecoinScores,
  publishStablecoinScoreTargets,
  DEX_LIQUIDITY_SCORING_BATCH_SIZE,
  loadConfidentHistoryStability,
  selectDexRouteObservations,
} from "../dex-liquidity/scoring";
import type { PoolEntry, SourcePoolGraph } from "../dex-liquidity/types";

const SCORING_CLOCK_SEC = 1_800_000_000;

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
  existingPriceRows: number;
  stagedPriceRows: number;
  publishedPriceRows: number;
  measuredTargetRows: number;
}

interface RouteScoreView {
  exitRouteObservations?: Array<{
    scope: { contractOrPoolId?: string };
    output: { trackedAssetIds?: string[] };
    evidenceKind: string;
    scoreEligible: boolean;
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
}

function withReadings<T extends PoolEntry>(pools: T[], ageSec = 60): T[] {
  for (const pool of pools) {
    pool.volumeReading = {
      volume24hUsd: pool.volumeUsd1d,
      volume7dUsd: pool.volumeUsd7d ?? null,
      observedAtSec: SCORING_CLOCK_SEC - ageSec,
    };
  }
  return pools;
}

function makeQueryDb(configs: QueryConfig[] = [{ match: "FROM dex_liquidity_history", all: [] }]): D1Database & { scoringTestState: ScoringTestState } {
  const scoringTestState: ScoringTestState = {
    existingPriceRows: 0, stagedPriceRows: 0, publishedPriceRows: 0, measuredTargetRows: 0,
  };
  const toErr = (v: unknown) => (v instanceof Error ? v : new Error(String(v)));

  function createStatement(sql: string, boundValues: unknown[] = []): PreparedStatementWithMeta {
    const config = configs.find((e) => sql.includes(e.match));
    return {
      sql, boundValues,
      bind: (...args: unknown[]) => createStatement(sql, args),
      all: async <T>() => {
        if (config?.throwError != null) throw toErr(config.throwError);
        const results = config?.all ?? [];
        if (sql.includes("SELECT stablecoin_id FROM dex_prices")) scoringTestState.existingPriceRows = results.length;
        return { results: results as T[], success: true, meta: {} };
      },
      first: async <T>() => {
        if (config?.throwError != null) throw toErr(config.throwError);
        if (config?.first !== undefined) return config.first as T | null;
        if (sql.includes("pharos:dex-scoring:current-generation")) {
          const n = ACTIVE_STABLECOINS.length + 1;
          return { state: "published", expected_row_count: n, current_row_count: n, staged_row_count: n, public_row_count: n } as T;
        }
        if (sql.includes("pharos:dex-scoring:price-stage-coverage")) return { row_count: scoringTestState.stagedPriceRows } as T;
        if (sql.includes("pharos:dex-scoring:price-publication-coverage")) {
          return { public_row_count: scoringTestState.publishedPriceRows, generation_row_count: scoringTestState.publishedPriceRows, staged_row_count: scoringTestState.stagedPriceRows } as T;
        }
        if (sql.includes("COUNT(*) AS count FROM dex_measured_execution_targets")) return { count: scoringTestState.measuredTargetRows } as T;
        return (config?.first ?? null) as T | null;
      },
      run: async () => {
        if (config?.throwError != null) throw toErr(config.throwError);
        if (sql.includes("DELETE FROM dex_price_run_rows WHERE generation_id = ?")) {
          const changes = scoringTestState.stagedPriceRows;
          scoringTestState.stagedPriceRows = 0;
          return { success: true, meta: { changes } };
        }
        return { success: true, meta: { changes: 0 } };
      },
    } as unknown as PreparedStatementWithMeta;
  }

  return makeNoopD1({
    prepare: (sql: string) => createStatement(sql),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
    scoringTestState,
  });
}

function ammToken(
  address: string,
  symbol: string,
  decimals: number,
  balance: number,
  trackedAssetId?: string,
  weight?: number,
) {
  return {
    address, symbol, decimals, balance, referencePriceUsd: 1,
    referencePriceSource: "tracked-market" as const,
    ...(trackedAssetId ? { trackedAssetId } : {}),
    ...(weight !== undefined ? { weight } : {}),
  };
}

function curveExecutionModel(
  tracked = { symbol: "USDC", decimals: 6, id: "usdc-circle" },
  output = { symbol: "USDT", decimals: 6, id: "usdt-tether" },
) {
  return {
    source: "curve" as const, invariant: "stableswap" as const, trackedTokenIndex: 0, feeRate: 0.0004, amplification: 200,
    tokens: [
      ammToken("0x0000000000000000000000000000000000000011", tracked.symbol, tracked.decimals, 50_000, tracked.id),
      ammToken("0x0000000000000000000000000000000000000012", output.symbol, output.decimals, 50_000, output.id),
    ],
  };
}

function poolEntry(overrides: Partial<PoolEntry> = {}): PoolEntry {
  return {
    poolId: "ethereum:0xabc", project: "curve", chain: "Ethereum", tvlUsd: 100_000,
    symbol: "USDC-USDT", volumeUsd1d: 20_000, poolType: "curve-stableswap", source: "dl",
    ...overrides,
  };
}

function graphFor(id: string, symbol: string, pools: PoolEntry[]): [string, SourcePoolGraph] {
  const graph = initSourcePoolGraph(id, symbol);
  graph.pools = pools;
  return [id, graph];
}

function scoreOne(
  id: string,
  symbol: string,
  pools: PoolEntry[],
  opts: {
    db?: D1Database;
    caps?: Map<string, number>;
    nowSec?: number;
    targets?: Map<string, DexMeasuredExecutionTarget>;
  } = {},
) {
  return computeStablecoinScores(
    opts.db ?? makeQueryDb(),
    new Map([graphFor(id, symbol, pools)]),
    opts.caps ?? new Map(),
    undefined,
    opts.nowSec,
    opts.targets ? new Map() : undefined,
    undefined,
    opts.targets,
  );
}

function makeMeasuredTarget(overrides: Partial<DexMeasuredExecutionTarget> = {}): DexMeasuredExecutionTarget {
  const addrIn = "0x2222222222222222222222222222222222222222";
  const addrOut = "0x3333333333333333333333333333333333333333";
  return {
    schemaVersion: "dex-measured-target-v1",
    targetId: "normalized-aerodrome-slipstream-target",
    stablecoinId: "usdc-circle",
    adapterProfileId: "aerodrome-slipstream-quoter-v2",
    protocol: "aerodrome-slipstream",
    chain: "base",
    poolId: "base:0x1111111111111111111111111111111111111111",
    poolTokenAddresses: [addrIn, addrOut],
    tokenIn: { address: addrIn, symbol: "USDC", decimals: 6, referencePriceUsd: 1, trackedAssetId: "usdc-circle" },
    tokenOut: { address: addrOut, symbol: "USDbC", decimals: 6, referencePriceUsd: 1 },
    tickSpacing: 1,
    retainedTvlUsd: 250_000,
    retainedPoolPriceUsd: 1,
    capturedAt: 1_700_000_000,
    ...overrides,
  };
}

describe("dex-liquidity scoring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("preserves gross Fluid inventory and volumes while scoring only usable swaps", async () => {
    const address = "0x97f32e5091d0e6aee24beb398e6592ae111dee9c";
    const clock = { poolAddress: address, checkedAtSec: SCORING_CLOCK_SEC - 10, maxAgeSec: 3600 };
    const paused: FluidSwapStatus = { ...clock, status: "paused", reason: "fluid-swaps-paused" };
    const active: FluidSwapStatus = { ...clock, status: "active", reason: "fluid-swaps-active" };
    const fluid = (fluidSwapStatus?: FluidSwapStatus) => makePool({ project: "fluid", poolType: "fluid-dex", source: "dl",
      poolId: "ethereum:defillama:e3a3baab-c962-525b-a9a7-231325714c8b", price: 1, tvlUsd: 2_593_517,
      volumeUsd1d: 0, volumeUsd7d: 2_770_982,
      extra: { effectiveTvl: 2_204_489, qualityAdjustedTvl: 2_204_489, balanceRatio: 1, stressIndex: 0, fluidSwapStatus } });
    const other = () => makePool({ poolId: "other", tvlUsd: 60_000, price: 0.998, volumeUsd1d: 61_000,
      extra: { effectiveTvl: 5_000, balanceRatio: 0.23, stressIndex: 85 } });
    const score = (pools: PoolEntry[]) => scoreOne("trusd-tori", "trUSD", withReadings(pools), { nowSec: SCORING_CLOCK_SEC });
    const before = await score([other()]);
    const result = await score([other(), fluid(paused)]);
    const value = result.scores.get("trusd-tori")!;
    expect(value).toMatchObject({ tvl: 2_653_517, effectiveTvl: 5_000, vol24h: 61_000,
      effectiveDepth: { coverage: "complete", amountUsd: 5_000, pausedPoolCount: 1, unknownPoolCount: 0 },
      components: before.scores.get("trusd-tori")!.components, weightedBalanceRatio: 0.23, avgStress: 85,
      exitRouteObservationCoverage: { unsupportedReasons: { "fluid-swaps-paused": 1 } } });
    const retained = result.retainedPoolsByStablecoin.get("trusd-tori")!;
    expect(retained[1]).toMatchObject({ volumeUsd7d: 2_770_982, extra: { effectiveTvl: 0 } });
    expect(buildDexPriceObservationsFromRetainedPools(result.retainedPoolsByStablecoin, new Map([["trusd-tori", [{
      protocol: "fluid", chain: "ethereum", price: 1, tvl: 2_593_517, poolKey: retained[1]!.poolId,
      identityConfidence: "exact", sourceFamily: "direct_api",
    }, {
      protocol: "cg-ticker-fluid-ethereum", chain: "orderbook", price: 1, tvl: 0,
      observedVolumeUsd: 10_000_000, sourceFamily: "cg_tickers",
    }]]]), true, SCORING_CLOCK_SEC).get("trusd-tori")?.map((row) => row.protocol)).toEqual(["balancer-v3"]);
    const stale = fluid({ ...active, checkedAtSec: SCORING_CLOCK_SEC - 3600 });
    const partial = (await score([other(), stale])).scores.get("trusd-tori")!;
    expect(partial.effectiveDepth).toMatchObject({ amountUsd: 5_000, coverage: "partial", unknownPoolCount: 1 });
    expect(stale.extra).not.toHaveProperty("effectiveTvl");
    expect(stale.extra?.fluidSwapStatus?.reason).toBe("fluid-swap-state-expired");
    expect((await score([fluid()])).scores.get("trusd-tori")).toMatchObject({ score: null,
      effectiveDepth: { coverage: "unavailable", amountUsd: null } });
    expect((await score([fluid(paused)])).scores.get("trusd-tori")).toMatchObject({ score: 0,
      effectiveDepth: { coverage: "complete", amountUsd: 0 } });
    expect((await score([fluid(active)])).scores.get("trusd-tori")!.effectiveTvl).toBe(2_204_489);
  });

  it("retains original price clocks while scoring a mixed-age pool graph", async () => {
    const result = await scoreOne("usdc-circle", "USDC", withReadings([
      makePool({ poolId: "base:old", price: 0.998, priceObservedAt: SCORING_CLOCK_SEC - 6 * 3600 }),
      makePool({ poolId: "base:fresh", price: 1, priceObservedAt: SCORING_CLOCK_SEC - 60 }),
    ]), { db: makeQueryDb([]), nowSec: SCORING_CLOCK_SEC });
    expect(result.retainedPoolsByStablecoin.get("usdc-circle")?.map((p) => p.priceObservedAt)).toEqual([
      SCORING_CLOCK_SEC - 6 * 3600, SCORING_CLOCK_SEC - 60,
    ]);
  });

  it.each([0, 8, 512, 1_024, 1_025])("preserves ordered history and stability over %i rows", async (count) => {
    vi.spyOn(Date, "now").mockReturnValue(SCORING_CLOCK_SEC * 1000);
    const fixtures = createLatestSchemaFixtureTracker();
    const { sqlite } = fixtures.open();
    const cutoff = Math.floor(SCORING_CLOCK_SEC / 86_400) * 86_400 - 30 * 86_400;
    const split = count === 1_024 ? 512 : 700;
    try {
      const insert = sqlite.prepare(`INSERT INTO dex_liquidity_history
        (stablecoin_id, snapshot_date, total_tvl_usd, total_volume_24h_usd, coverage_class, coverage_confidence)
        VALUES (?, ?, ?, ?, 'primary', ?)`);
      for (const id of ["aaa-expired", "usdc-circle", "usdd-expired", "zzzz-expired"])
        insert.run(id, cutoff - 1, 1_000_000_000, 1, 1);
      for (let i = 0; i < count; i++) {
        const tvl = i < split ? 1_000_000 : 2_000_000;
        const rejected = [7, 511, 512].includes(i);
        insert.run(i < split ? "usdc-circle" : "zz-history-only", cutoff + (i < split ? i : i - split),
          rejected ? 1_000_000_000 : tvl, tvl / 10, rejected ? (i === 512 ? 0.74 : 1.1) : 1);
      }
      const scan = async (legacy: boolean) => {
        const rows: unknown[] = [], pages: number[] = [];
        const db = makeNoopD1({ prepare: (sql: string) => ({
          bind: (since: number, coin: string, date: number, limit: number) => ({ all: async () => {
            const query = legacy ? `SELECT stablecoin_id, snapshot_date, total_tvl_usd,
              total_volume_24h_usd, coverage_class, coverage_confidence, volume_availability_json, methodology_version
              FROM dex_liquidity_history WHERE snapshot_date >= ?1
              AND (stablecoin_id > ?2 OR (stablecoin_id = ?2 AND snapshot_date > ?3))
              ORDER BY stablecoin_id, snapshot_date LIMIT ?4` : sql;
            const args = [since, coin, date, limit];
            if (!legacy) expect(sqlite.prepare("EXPLAIN QUERY PLAN " + query).all(...args).map((row) => row.detail))
              .toEqual(expect.arrayContaining([
                "SEARCH dex_liquidity_history USING INDEX idx_dex_hist_coin_date_unique (stablecoin_id=? AND snapshot_date>?)",
                "SEARCH dex_liquidity_history USING COVERING INDEX idx_dex_hist_coin_date_unique (stablecoin_id=? AND snapshot_date>?)",
              ]));
            const results = sqlite.prepare(query).all(...args);
            rows.push(...results);
            pages.push(results.length);
            return { results, success: true, meta: {} };
          } }),
        }) });
        return { stability: await loadConfidentHistoryStability(db), rows, pages };
      };
      const current = await scan(false);
      expect(current).toEqual(await scan(true));
      expect(current.rows).toHaveLength(count);
      expect(current.pages).toEqual([...Array(Math.floor(count / 512)).fill(512), count % 512]);
      const expected = new Map(count ? [["usdc-circle", 1], ...(count > split ? [["zz-history-only", 1] as const] : [])] : []);
      expect(current.stability.tvlStabilityMap).toEqual(expected);
      expect(current.stability.volumeStabilityMap).toEqual(expected);
    } finally { fixtures.closeAll(); }
  });

  it("feeds coverage-qualified admitted turnover into volume consistency and skips days below the floor", async () => {
    const asOfSec = 1_790_000_000;
    const record = (pools: Array<{ volumeUsd: number | null; tvlUsd: number }>) => JSON.stringify({
      "24h": summarizeDexVolumeWindow(
        pools.map((p) => ({ ...p, observedAtSec: p.volumeUsd == null ? null : asOfSec - 60 })),
        "24h",
        { asOfSec, maxObservationAgeSec: DEX_VOLUME_OBSERVATION_MAX_AGE_SEC },
      ).availability,
    });
    const complete = record([{ volumeUsd: 100_000, tvlUsd: 1_000_000 }]);
    const qualified = record([{ volumeUsd: 60_000, tvlUsd: 600_000 }, { volumeUsd: null, tvlUsd: 400_000 }]);
    const belowFloor = record([{ volumeUsd: 4_000, tvlUsd: 400_000 }, { volumeUsd: null, tvlUsd: 600_000 }]);
    const row = (id: string, day: number, vol: number, json: string | null) => ({
      stablecoin_id: id, snapshot_date: day, total_tvl_usd: 1_000_000, total_volume_24h_usd: vol,
      coverage_confidence: 1, coverage_class: "primary", volume_availability_json: json,
    });
    const db = makeQueryDb([{
      match: "FROM dex_liquidity_history",
      all: [
        ...Array.from({ length: 3 }, (_, i) => row("usdc-circle", i + 1, 100_000, null)),
        row("usdc-circle", 4, 100_000, complete),
        ...Array.from({ length: 3 }, (_, i) => row("usdc-circle", i + 5, 60_000, qualified)),
        row("usdc-circle", 8, 4_000, belowFloor),
        ...Array.from({ length: 3 }, (_, i) => row("usdt-tether", i + 1, 100_000, null)),
        ...Array.from({ length: 5 }, (_, i) => row("usdt-tether", i + 4, 4_000, belowFloor)),
      ],
    }]);

    const result = await loadConfidentHistoryStability(db);
    expect(result.volumeStabilityMap).toEqual(new Map([["usdc-circle", 1]]));
    expect(result.tvlStabilityMap).toEqual(new Map([["usdc-circle", 1], ["usdt-tether", 1]]));
  });

  it("keeps TVL and turnover stability inside one TVL-measurement epoch", async () => {
    const row = (id: string, day: number, tvl: number, methodologyVersion: string | null) => ({
      stablecoin_id: id, snapshot_date: day, total_tvl_usd: tvl, total_volume_24h_usd: tvl / 10,
      coverage_confidence: 1, coverage_class: "primary", volume_availability_json: null, methodology_version: methodologyVersion,
    });
    const db = makeQueryDb([{
      match: "FROM dex_liquidity_history",
      all: [
        ...Array.from({ length: 10 }, (_, d) => row("paxg-paxos", d + 1, 160_000_000, null)),
        ...Array.from({ length: 9 }, (_, d) => row("paxg-paxos", d + 11, 160_000_000, "6.9")),
        row("paxg-paxos", 20, 160_000_000, "6.91"),
        ...Array.from({ length: 7 }, (_, d) => row("paxg-paxos", d + 21, 50_000_000, "6.92")),
        ...Array.from({ length: 9 }, (_, d) => row("usdb-blast", d + 1, 11_000_000, "6.8")),
        ...Array.from({ length: 6 }, (_, d) => row("usdb-blast", d + 10, 2_700_000, "6.92")),
        row("jpyc-jpyc", 1, 31_000_000, "6.9"),
        row("jpyc-jpyc", 2, 2_600_000, "6.92"),
      ],
    }]);

    const result = await loadConfidentHistoryStability(db);
    expect(result.tvlStabilityMap).toEqual(new Map([["paxg-paxos", 1], ["usdb-blast", 1]]));
    expect(result.volumeStabilityMap).toEqual(new Map([["paxg-paxos", 1], ["usdb-blast", 1]]));
  });

  it("filters and quarantines pools, truncates visible pools, and computes deduped global aggregates", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
    const db = makeQueryDb([
      { match: "depth_stability", all: [{ stablecoin_id: "usdt-tether", depth_stability: 0.9 }, { stablecoin_id: "usdc-circle", depth_stability: 0.8 }] },
      {
        match: "FROM dex_liquidity_history",
        all: [
          ...Array.from({ length: 7 }, () => ({ stablecoin_id: "usdt-tether", total_volume_24h_usd: 100 })),
          ...Array.from({ length: 7 }, () => ({ stablecoin_id: "usdc-circle", total_volume_24h_usd: 0 })),
        ],
      },
    ]);

    const usdtPools = withReadings([
      poolEntry({
        poolId: "ethereum:shared", chain: "ethereum", symbol: "USDT-USDC", volumeUsd1d: 50_000, volumeUsd7d: 35_000,
        extra: { qualityAdjustedTvl: 95_000, effectiveTvl: 90_000, balanceRatio: 0.75, organicFraction: 0.625, hasMeasuredOrganicFraction: true, stressIndex: 0, maturityDays: 500, lockedLiquidityPct: 50 },
      }),
      poolEntry({ poolId: "ethereum:sushi-dl", project: "sushiswap", chain: "ethereum", tvlUsd: 20_000, symbol: "USDT-USDE", volumeUsd1d: 5_000, volumeUsd7d: 3_500, poolType: "generic" }),
      poolEntry({ poolId: "ethereum:sushi-cg", project: "sushiswap", chain: "ethereum", tvlUsd: 80_000, symbol: "USDT-USDC", volumeUsd1d: 40_000, volumeUsd7d: 28_000, poolType: "generic", source: "cg_onchain", extra: { effectiveTvl: 80_000 } }),
      poolEntry({ poolId: "arbitrum:sushi-gt", project: "sushiswap", chain: "arbitrum", tvlUsd: 70_000, symbol: "USDT-USDC", volumeUsd1d: 35_000, volumeUsd7d: 24_500, poolType: "generic", source: "gecko_terminal", extra: { effectiveTvl: 70_000 } }),
      poolEntry({ poolId: "ethereum:bad-ratio", chain: "ethereum", tvlUsd: 1_000, symbol: "USDT-USDC", volumeUsd1d: 100_000, volumeUsd7d: 700_000 }),
      poolEntry({ poolId: "base:fake-tvl", project: "dnax", chain: "base", tvlUsd: 150_000_000, symbol: "USDT-USDC", volumeUsd1d: 10_000, volumeUsd7d: 70_000, poolType: "generic", source: "gecko_terminal" }),
      ...Array.from({ length: 9 }, (_, i) => poolEntry({
        poolId: `ethereum:extra-${i + 1}`, chain: "ethereum", tvlUsd: 10_000,
        symbol: `USDT-PAIR-${i + 1}`, volumeUsd1d: 30_000 - i * 1_000, volumeUsd7d: 21_000 - i * 1_000,
      })),
    ]);
    const usdcPools = withReadings([
      poolEntry({ poolId: "ethereum:shared", chain: "ethereum", volumeUsd1d: 50_000, volumeUsd7d: 35_000 }),
      poolEntry({ poolId: "base:sushi-unique", project: "sushiswap", chain: "base", tvlUsd: 90_000, symbol: "USDC-USDE", volumeUsd1d: 30_000, volumeUsd7d: 21_000, poolType: "generic", source: "gecko_terminal", extra: { effectiveTvl: 90_000 } }),
      poolEntry({ poolId: "base:curve-unique", chain: "base", tvlUsd: 40_000, symbol: "USDC-DAI", volumeUsd1d: 10_000, volumeUsd7d: 7_000 }),
    ]);

    const { scores, globalAgg } = await computeStablecoinScores(
      db, new Map([graphFor("usdt-tether", "USDT", usdtPools), graphFor("usdc-circle", "USDC", usdcPools)]),
      new Map([["sushiswap", 100_000]]), undefined, SCORING_CLOCK_SEC,
    );

    const usdtScore = scores.get("usdt-tether");
    expect(usdtScore).toMatchObject({
      tvl: 210_000, vol24h: 289_000, weightedBalanceRatio: 0.75, organicFrac: 0.625, avgStress: 0, lockedLiqPct: 0.5,
    });
    expect(usdtScore?.hhi).toBeCloseTo(0.2562, 4);
    expect(globalAgg).toMatchObject({
      poolCount: 13, totalVol24h: 329_000, totalVol7d: 219_500,
      protocolTvl: { sushiswap: 110_000 }, chainTvl: { ethereum: 210_000, base: 130_000 },
    });
    expect(globalAgg.totalTvl).toBeCloseTo(340_000, 6);
    expect(globalAgg.chainTvl.arbitrum ?? 0).toBe(0);
  });

  describe("locked-liquidity TVL-weighted average", () => {
    const cgPool = (poolId: string, tvlUsd: number, lockedLiquidityPct: number): PoolEntry => poolEntry({
      poolId, project: "uniswap-v3", chain: "ethereum", tvlUsd, volumeUsd1d: tvlUsd / 2, volumeUsd7d: tvlUsd * 3.5,
      poolType: "cg-cl-5bp", source: "cg_onchain", extra: { lockedLiquidityPct },
      volumeReading: { volume24hUsd: tvlUsd / 2, volume7dUsd: tvlUsd * 3.5, observedAtSec: SCORING_CLOCK_SEC - 60 },
    });
    const scoreLockedPools = async (pools: PoolEntry[]) => {
      const db = makeQueryDb([{ match: "FROM dex_liquidity_history", all: [] }, { match: "FROM surface_publication_generations", all: [] }]);
      const { scores } = await scoreOne("usdt-tether", "USDT", pools, { db, nowSec: SCORING_CLOCK_SEC });
      return scores.get("usdt-tether")?.lockedLiqPct;
    };

    it("keeps a measured 0% pool in the denominator instead of weighting only the positive pool", async () => {
      expect(await scoreLockedPools([cgPool("ethereum:0xunlocked", 1_000_000, 0), cgPool("ethereum:0xhalf-locked", 1_000, 50)])).toBe(0.0005);
    });

    it("publishes a measured zero, not unavailable, when every retained pool reports 0% locked", async () => {
      expect(await scoreLockedPools([cgPool("ethereum:0xunlocked-a", 1_000_000, 0), cgPool("ethereum:0xunlocked-b", 250_000, 0)])).toBe(0);
    });
  });

  it("excludes inactive tracked metrics from scores, retained pools, and global aggregates", async () => {
    const active = withReadings([poolEntry({ poolId: "ethereum:active", symbol: "USDT-USDC", volumeUsd1d: 10_000, volumeUsd7d: 70_000 })]);
    const inactive = withReadings([poolEntry({ poolId: "ethereum:inactive", tvlUsd: 900_000, symbol: "USR-USDC", volumeUsd1d: 90_000, volumeUsd7d: 630_000 })]);
    const result = await computeStablecoinScores(
      makeQueryDb(), new Map([graphFor("usdt-tether", "USDT", active), graphFor("usr-resolv", "USR", inactive)]),
      new Map(), undefined, SCORING_CLOCK_SEC,
    );

    expect(result.scores.has("usdt-tether")).toBe(true);
    expect(result.scores.has("usr-resolv")).toBe(false);
    expect(result.retainedPoolsByStablecoin.has("usr-resolv")).toBe(false);
    expect(result.globalAgg).toMatchObject({ totalTvl: 100_000, totalVol24h: 10_000, totalVol7d: 70_000, poolCount: 1 });
  });

  it("drops NEAR Intents rows from coin scoring and the global aggregate while other NEAR venues count", async () => {
    const p = (poolId: string, project: string, chain: string, tvlUsd: number, volumeUsd1d: number, source: PoolEntry["source"]) =>
      poolEntry({ poolId, project, chain, tvlUsd, symbol: "FRAX-X", volumeUsd1d, volumeUsd7d: volumeUsd1d * 7, poolType: "cg-amm", source });
    const result = await scoreOne("frax-frax", "FRAX", withReadings([
      p("near:intents-wnear", "near-intents", "near", 90_000_000, 3, "cg_onchain"),
      p("near:refv1-4525", "rhea-finance", "near", 250_000, 35_000, "cg_onchain"),
      p("ethereum:curve-frax", "curve", "Ethereum", 1_000_000, 100_000, "dl"),
    ]), { nowSec: SCORING_CLOCK_SEC });

    expect(result.retainedPoolsByStablecoin.get("frax-frax")?.map((r) => r.poolId).sort()).toEqual(["ethereum:curve-frax", "near:refv1-4525"]);
    expect(result.scoredMetrics.get("frax-frax")!.totalTvlUsd).toBe(1_250_000);
    expect(result.scoredMetrics.get("frax-frax")!.protocolTvl).toEqual({ "rhea-finance": 250_000, curve: 1_000_000 });
    expect(result.globalAgg).toMatchObject({ totalTvl: 1_250_000, poolCount: 2, chainTvl: { near: 250_000 } });
    expect(result.globalAgg.protocolTvl["near-intents"]).toBeUndefined();
    expect(result.diagnostics.fallbackCounters.retainedExclusionBlockedDex).toBe(1);
  });

  it("publishes NR instead of a default-built score when every retained pool is excluded", async () => {
    const scenarios = [
      {
        pool: makePool({
          poolId: "ethereum:0x3crv-dormant", project: "curve", chain: "Ethereum", poolType: "curve-stableswap",
          tvlUsd: 120_000_000, volumeUsd1d: 20_000,
          volumeReading: { volume24hUsd: 20_000, volume7dUsd: 140_000, observedAtSec: SCORING_CLOCK_SEC - DEX_VOLUME_OBSERVATION_MAX_AGE_SEC - 3_600 },
        }),
        expectExcluded: (r: Awaited<ReturnType<typeof computeStablecoinScores>>) => {
          expect(r.diagnostics.fallbackCounters.retainedExclusionLargePoolLowVolume).toBe(1);
          expect(r.diagnostics.deadPoolExclusions.poolCount).toBe(0);
        },
      },
      {
        pool: makePool({
          poolId: "ethereum:0xdead-3crv", project: "curve", chain: "Ethereum", poolType: "curve-stableswap",
          tvlUsd: 1_200_000, volumeUsd1d: 0,
          volumeReading: { volume24hUsd: 0, volume7dUsd: 0, observedAtSec: SCORING_CLOCK_SEC - 60, deadPoolSignature: true },
        }),
        expectExcluded: (r: Awaited<ReturnType<typeof computeStablecoinScores>>) => {
          expect(r.diagnostics.deadPoolExclusions).toMatchObject({
            reason: "dead-pool-zero-trade-untracked-counter", poolCount: 1, tvlUsd: 1_200_000,
          });
          expect(r.diagnostics.fallbackCounters.retainedExclusionLargePoolLowVolume).toBe(0);
        },
      },
    ];

    for (const { pool, expectExcluded } of scenarios) {
      const db = makeQueryDb([{ match: "FROM dex_liquidity_history", all: [] }, { match: "FROM surface_publication_generations", all: [] }]);
      const result = await scoreOne("frax-frax", "FRAX", [pool], { db, nowSec: SCORING_CLOCK_SEC });
      expectExcluded(result);
      expect(result.scoredMetrics.get("frax-frax")).toMatchObject({ totalTvlUsd: 0, poolCount: 0 });
      expect(result.scores.get("frax-frax")).toMatchObject({
        coverageClass: "unobserved", score: null, liquidityScoreUnavailableReason: "no-retained-pools",
      });
    }
  });

  it("gates activity on admitted-TVL coverage and publishes global observed volume with its coverage", async () => {
    const p = (poolId: string, tvlUsd: number, volumeUsd1d: number | null, ageSec: number | null) => poolEntry({
      poolId, chain: "ethereum", tvlUsd, symbol: "USD-USD", volumeUsd1d,
      ...(ageSec == null ? {} : { volumeReading: { volume24hUsd: volumeUsd1d, volume7dUsd: null, observedAtSec: SCORING_CLOCK_SEC - ageSec } }),
    });
    const { scores, globalAgg } = await computeStablecoinScores(
      makeQueryDb(),
      new Map([
        graphFor("usdt-tether", "USDT", [p("ethereum:admitted", 600_000, 30_000, 3_600), p("ethereum:stale", 400_000, 400_000, 72 * 3600 + 1)]),
        graphFor("usdc-circle", "USDC", [p("ethereum:boundary", 400_000, 20_000, 72 * 3600), p("ethereum:missing", 600_000, null, null)]),
      ]),
      new Map(), undefined, SCORING_CLOCK_SEC,
    );

    const usdt = scores.get("usdt-tether");
    expect(usdt?.components.volumeActivity).toBe(65);
    expect(usdt?.score).toEqual(expect.any(Number));
    expect(usdt?.vol24h).toBeNull();
    expect(usdt?.volumeAvailability["24h"]).toMatchObject({
      completeness: "partial", partialGrossUsd: 30_000, admittedTvlUsd: 600_000, retainedTvlUsd: 1_000_000, volumeCoverage: 0.6,
    });
    expect(scores.get("usdc-circle")).toMatchObject({
      score: null, components: { volumeActivity: null },
      volumeAvailability: { "24h": { partialGrossUsd: 20_000, volumeCoverage: 0.4 } },
    });
    expect(globalAgg.totalVol24h).toBeNull();
    expect(globalAgg.volumeAvailability["24h"]).toMatchObject({
      completeness: "partial", partialGrossUsd: 50_000, admittedTvlUsd: 1_000_000, retainedTvlUsd: 2_000_000,
      volumeCoverage: 0.5, maxObservationAgeSec: 72 * 3600,
    });
  });

  it("keeps paused Balancer pools only in the P4 capability denominator", async () => {
    const result = await scoreOne("usdc-circle", "USDC", [
      poolEntry({
        poolId: "ethereum:0xpaused-balancer", project: "balancer-v3", chain: "ethereum", tvlUsd: 10_000_000,
        symbol: "USDC / USDT", volumeUsd1d: 100_000, volumeUsd7d: 700_000, poolType: "balancer-stable", source: "gecko_terminal",
        extra: { executionCapabilityGate: { family: "balancer-amm", reason: "paused-or-swap-disabled" } },
      }),
      poolEntry({
        poolId: "ethereum:0xrate-bearing-balancer", project: "balancer-v3", chain: "ethereum", tvlUsd: 150_000,
        symbol: "USDC / waUSDT", volumeUsd1d: 10_000, volumeUsd7d: 70_000, poolType: "balancer-stable", source: "gecko_terminal",
        extra: { executionCapabilityGate: { family: "balancer-amm", reason: "rate-bearing-inputs" } },
      }),
    ], { caps: new Map([["balancer", 150_000]]) });

    const coverage = (result.scores.get("usdc-circle") as RouteScoreView | undefined)?.exitRouteObservationCoverage;
    expect(coverage).toMatchObject({
      retainedPoolCount: 2, scoreEligibleCapabilityPoolCount: 2, unsupportedPoolCount: 2,
      unsupportedReasons: {
        "executionCapabilityGate:balancer-amm:paused-or-swap-disabled": 1,
        "executionCapabilityGate:balancer-amm:rate-bearing-inputs": 1,
      },
    });
    const scored = result.scoredMetrics.get("usdc-circle")!;
    expect(scored).toMatchObject({ totalTvlUsd: 150_000, poolCount: 1 });
    expect(scored.topPools).toHaveLength(1);
    expect(scored.topPools[0]).toMatchObject({ poolId: "ethereum:0xrate-bearing-balancer", tvlUsd: 150_000 });
    expect(result.retainedPoolsByStablecoin.get("usdc-circle")).toHaveLength(1);
    expect(result.globalAgg).toMatchObject({ totalTvl: 150_000, poolCount: 1, protocolTvl: { balancer: 150_000 } });
    expect(result.diagnostics.protocolTvlQuarantine).toMatchObject({ poolCount: 0, tvlUsd: 0 });
  });

  it("does not let shallow measured routes evict the highest-capacity exact fallback", () => {
    const route = (args: {
      id: string; protocol: string; chain: string; capacity: number;
      evidenceKind: ExitRouteObservation["evidenceKind"]; adapterProfileId?: string;
    }): ExitRouteObservation => ({
      routeId: args.id, routeFamily: "dex-amm",
      scope: { kind: "chain-contract", chain: args.chain, contractOrPoolId: args.id, protocol: args.protocol },
      requestedNotionalUsd: 1_000_000, settlementHorizonSec: 300, maxCostBps: 200,
      executableUsd: args.capacity, completionRatio: Math.min(1, args.capacity / 1_000_000),
      output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdc-circle"] },
      evidenceKind: args.evidenceKind, ...(args.adapterProfileId ? { adapterProfileId: args.adapterProfileId } : {}),
      confidence: "high", scoreEligible: true, observedAt: 1_800_000_000, freshnessSeconds: 0,
      commonModeKeys: [`pool:${args.chain}:${args.id}`, `chain:${args.chain.toLowerCase()}`, `protocol:${args.protocol}`],
      capacityCurve: [{ requestedNotionalUsd: 25_000_000, maxCostBps: 200, executableUsd: args.capacity, completionRatio: args.capacity / 25_000_000 }],
    });
    const selected = selectDexRouteObservations([
      ...Array.from({ length: 10 }, (_, i) => route({
        id: `thinswap-${i}`, protocol: "thinswap", chain: "Polygon", capacity: 1_000,
        evidenceKind: "measured-executable-depth", adapterProfileId: "thinswap-v2-router-v1",
      })),
      route({ id: "curve-deep", protocol: "curve", chain: "Ethereum", capacity: 24_600_000, evidenceKind: "reserve-based-amm-simulation" }),
      route({ id: "pancake-independent", protocol: "pancakeswap", chain: "BSC", capacity: 7_750_000, evidenceKind: "measured-executable-depth", adapterProfileId: "pancake-v3-quoter-v2" }),
    ]);

    expect(selected.observations[0]?.routeId).toBe("curve-deep");
    expect(selected.observations.map((o) => o.routeId)).toContain("pancake-independent");
    expect(selected.bestIncludedCapacityUsd).toBe(24_600_000);
    expect(selected.bestOmittedCapacityUsd).toBe(1_000);
    expect(selected.observations.filter((o) => o.adapterProfileId === "thinswap-v2-router-v1")).toHaveLength(7);
  });

  it("selects exact route evidence below the display top ten without changing the visible pool list", async () => {
    const originalPools = Array.from({ length: 12 }, (_, i) => poolEntry({
      poolId: `ethereum:pool-${i}`, tvlUsd: 100_000 - i, volumeUsd1d: 20_000 - i, volumeUsd7d: 70_000,
      extra: {
        balanceRatio: 0.99,
        balanceDetails: [{ symbol: "USDC", balancePct: 50, isTracked: true }],
        measurement: { tvlMeasured: true, balanceMeasured: true },
        ...(i === 10 ? { ammExecutionModel: curveExecutionModel() } : {}),
        measuredExecutionTarget: undefined,
        measuredExecutionProfile: {} as NonNullable<PoolEntry["extra"]>["measuredExecutionProfile"],
        measuredExecutionPhysicalPoolId: `pool-${i}`,
        measuredExecutionDiagnostic: { adapterProfileId: "test-adapter", targetId: `target-${i}` },
      },
    }));

    const result = await scoreOne("usdc-circle", "USDC", originalPools);
    const retainedPools = result.retainedPoolsByStablecoin.get("usdc-circle") ?? [];
    const routeResult = result.scores.get("usdc-circle") as RouteScoreView | undefined;

    expect(retainedPools).toHaveLength(12);
    expect(result.scoredMetrics.get("usdc-circle")!.topPools.map((p) => p.poolId)).toEqual(
      Array.from({ length: 10 }, (_, i) => `ethereum:pool-${i}`),
    );
    expect(routeResult?.exitRouteObservations).toContainEqual(expect.objectContaining({
      scope: expect.objectContaining({ contractOrPoolId: "ethereum:pool-10" }),
      evidenceKind: "reserve-based-amm-simulation", scoreEligible: true,
    }));
    expect(routeResult?.exitRouteObservationCoverage).toMatchObject({
      retainedPoolCount: 12, scoreEligiblePoolCount: 1, scoreEligibleCapabilityPoolCount: 1,
    });
    retainedPools.forEach((pool, i) => {
      expect(pool).toBe(originalPools[i]);
      expect(pool.extra).toMatchObject({
        balanceRatio: 0.99, balanceDetails: [{ symbol: "USDC", balancePct: 50, isTracked: true }],
        measurement: { tvlMeasured: true, balanceMeasured: true },
      });
      for (const prop of ["measuredExecutionTarget", "measuredExecutionProfile", "measuredExecutionPhysicalPoolId", "measuredExecutionDiagnostic"]) {
        expect(pool.extra).not.toHaveProperty(prop);
      }
    });
  });

  it("keeps exact AMM evidence scoreable when its measured target rotates out", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    const result = await scoreOne("usdc-circle", "USDC", [poolEntry({
      poolId: "ethereum:0x0000000000000000000000000000000000000010", project: "pancakeswap",
      tvlUsd: 2_000_000, volumeUsd1d: 100_000, volumeUsd7d: 700_000, poolType: "pancakeswap-v3-1bp",
      extra: {
        ammExecutionModel: {
          source: "uniswap-v2", invariant: "constant-product", trackedTokenIndex: 0, feeRate: 0.003,
          capture: { blockNumber: 18_500_000, blockHash: `0x${"ab".repeat(32)}`, blockTimestamp: nowSec - 30, sourceGenerationId: "rotated-target-exact-amm" },
          tokens: [
            ammToken("0x0000000000000000000000000000000000000011", "USDC", 6, 1_000_000, "usdc-circle"),
            ammToken("0x0000000000000000000000000000000000000012", "USDT", 6, 1_000_000, "usdt-tether"),
          ],
        },
        executionCapabilityGate: { family: "measured-execution", reason: "target-unresolved" },
      },
    })]);
    const routeResult = result.scores.get("usdc-circle") as RouteScoreView | undefined;
    expect(routeResult?.exitRouteObservations).toContainEqual(expect.objectContaining({
      evidenceKind: "reserve-based-amm-simulation", scoreEligible: true,
    }));
    expect(routeResult?.exitRouteObservationCoverage).toMatchObject({
      scoreEligiblePoolCount: 1, scoreEligibleCapabilityPoolCount: 1, unsupportedReasons: {},
    });
  });

  it("moves a plain-NG admission diagnostic into cron diagnostics and off every scored pool", async () => {
    const nowSec = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    const diagnostic = {
      stablecoinId: "usdc-circle", chain: "ethereum",
      poolId: "ethereum:0x0000000000000000000000000000000000000020",
      poolAddress: "0x0000000000000000000000000000000000000020",
      sourcePriceSpreadRatio: 1.03,
    };
    const result = await scoreOne("usdc-circle", "USDC", [poolEntry({
      poolId: diagnostic.poolId, tvlUsd: 2_000_000, volumeUsd1d: 100_000, volumeUsd7d: 700_000,
      extra: {
        ammExecutionModel: {
          ...curveExecutionModel(),
          capture: { blockNumber: 18_500_000, blockHash: `0x${"cd".repeat(32)}`, blockTimestamp: nowSec - 30, sourceGenerationId: "plain-ng-admission" },
        },
        measurement: { balanceMeasured: true },
        curveStableswapPlainAdmissionDiagnostic: diagnostic,
      },
    })]);

    expect(result.diagnostics.curveStableswapPlainAdmissions).toEqual([diagnostic]);
    expect(result.diagnostics.curveStableswapPlainAdmissionsOmitted).toBe(0);
    const retained = result.retainedPoolsByStablecoin.get("usdc-circle") ?? [];
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.some((p) => p.extra?.curveStableswapPlainAdmissionDiagnostic !== undefined)).toBe(false);
    expect(JSON.stringify([...result.scoredMetrics.values()])).not.toContain("curveStableswapPlainAdmissionDiagnostic");
  });

  it("leaves retained Solana and Tron pools ungated as shaped evidence after the native-lane removal", async () => {
    const result = await scoreOne("usdt-tether", "USDT", [
      poolEntry({ poolId: "TFGDbUyP8xez44C76fin3bn3Ss6jugoUwJ", project: "sunswap-v2", chain: "Tron", tvlUsd: 92_000_000, symbol: "USDT-WTRX", volumeUsd1d: 700_000, volumeUsd7d: 4_900_000, poolType: "sunswap-v2" }),
      poolEntry({ poolId: "solana:Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE", project: "orca", chain: "Solana", tvlUsd: 5_000_000, symbol: "USDT-USDC", volumeUsd1d: 400_000, volumeUsd7d: 2_800_000, poolType: "orca-whirlpool", source: "direct_api" }),
    ], { nowSec: 1_752_560_000 });
    const retained = result.retainedPoolsByStablecoin.get("usdt-tether") ?? [];
    const routeResult = result.scores.get("usdt-tether") as RouteScoreView | undefined;

    expect(retained).toHaveLength(2);
    for (const p of retained) expect(p.extra?.executionCapabilityGate).toBeUndefined();
    expect(routeResult?.exitRouteObservationCoverage?.unsupportedReasons).toMatchObject({
      "nonExecutableEvidence:defillama-pool-shaped": 1, "nonExecutableEvidence:direct-api-amm-shaped": 1,
    });
  });

  it("fails coverage closed when reviewed route capabilities overflow the bounded payload", async () => {
    const result = await scoreOne("usdc-circle", "USDC", Array.from({ length: 11 }, (_, i) => poolEntry({
      poolId: `ethereum:exact-pool-${i}`, tvlUsd: 100_000 - i, volumeUsd1d: 20_000 - i, volumeUsd7d: 140_000 - i,
      extra: { ammExecutionModel: curveExecutionModel() },
    })));
    const routeResult = result.scores.get("usdc-circle") as RouteScoreView | undefined;

    expect(result.scoredMetrics.get("usdc-circle")!.topPools.map((p) => p.poolId)).toEqual(
      Array.from({ length: 10 }, (_, i) => `ethereum:exact-pool-${i}`),
    );
    expect(routeResult?.exitRouteObservations?.map((o) => o.scope.contractOrPoolId)).toEqual([
      "ethereum:exact-pool-0", "ethereum:exact-pool-1", "ethereum:exact-pool-10",
      "ethereum:exact-pool-2", "ethereum:exact-pool-3", "ethereum:exact-pool-4", "ethereum:exact-pool-5",
    ]);
    expect(routeResult?.exitRouteObservationCoverage).toMatchObject({
      retainedPoolCount: 11, observationCount: 7, scoreEligibleObservationCount: 7,
      scoreEligiblePoolCount: 7, scoreEligibleCapabilityPoolCount: 11,
      unsupportedPoolCount: 4, unsupportedReasons: { routeObservationPayloadOverflow: 4 },
    });
  });

  it("packs DAI-shaped multi-output routes so every selected physical pool is emitted", async () => {
    const result = await scoreOne("dai-makerdao", "DAI", [
      ...Array.from({ length: 3 }, (_, i) => poolEntry({
        poolId: `ethereum:dai-balancer-three-token-${i}`, project: "balancer", tvlUsd: 300_000 - i,
        symbol: "DAI-USDC-USDT", volumeUsd1d: 30_000 - i, volumeUsd7d: 210_000 - i, poolType: "balancer-weighted", source: "direct_api",
        extra: {
          ammExecutionModel: {
            source: "balancer", invariant: "weighted-constant-mean", trackedTokenIndex: 0, feeRate: 0.001,
            tokens: [
              ammToken("0x0000000000000000000000000000000000000011", "DAI", 18, 100_000, "dai-makerdao", 0.34),
              ammToken("0x0000000000000000000000000000000000000012", "USDC", 6, 100_000, "usdc-circle", 0.33),
              ammToken("0x0000000000000000000000000000000000000013", "USDT", 6, 100_000, "usdt-tether", 0.33),
            ],
          },
        },
      })),
      ...Array.from({ length: 7 }, (_, i) => poolEntry({
        poolId: `ethereum:dai-curve-pool-${i}`, tvlUsd: 100_000 - i, symbol: "DAI-USDC",
        volumeUsd1d: 20_000 - i, volumeUsd7d: 140_000 - i,
        extra: { ammExecutionModel: curveExecutionModel({ symbol: "DAI", decimals: 18, id: "dai-makerdao" }, { symbol: "USDC", decimals: 6, id: "usdc-circle" }) },
      })),
    ]);
    const routeResult = result.scores.get("dai-makerdao") as RouteScoreView | undefined;

    expect(routeResult?.exitRouteObservations).toHaveLength(13);
    expect(routeResult?.exitRouteObservations?.map((o) => o.scope.contractOrPoolId)).toEqual([
      ...Array.from({ length: 3 }, (_, i) => [`ethereum:dai-balancer-three-token-${i}`, `ethereum:dai-balancer-three-token-${i}`]).flat(),
      ...Array.from({ length: 7 }, (_, i) => `ethereum:dai-curve-pool-${i}`),
    ]);
    expect(routeResult?.exitRouteObservations?.slice(0, 2).map((o) => o.output.trackedAssetIds)).toEqual([["usdc-circle"], ["usdt-tether"]]);
    expect(routeResult?.exitRouteObservationCoverage).toMatchObject({
      retainedPoolCount: 10, observationCount: 13, scoreEligibleObservationCount: 13,
      scoreEligiblePoolCount: 10, scoreEligibleCapabilityPoolCount: 10, unsupportedPoolCount: 0,
    });
  });

  it("keeps pool coverage complete when clipping only extra outputs from represented pools", async () => {
    const result = await scoreOne("usdc-circle", "USDC", Array.from({ length: 2 }, (_, pi) => poolEntry({
      poolId: `ethereum:balancer-eight-token-${pi}`, project: "balancer", tvlUsd: 400_000 - pi,
      symbol: "USDC-MULTI", volumeUsd1d: 30_000 - pi, volumeUsd7d: 210_000 - pi, poolType: "balancer-weighted", source: "direct_api",
      extra: {
        ammExecutionModel: {
          source: "balancer", invariant: "weighted-constant-mean", trackedTokenIndex: 0, feeRate: 0.001,
          tokens: Array.from({ length: 8 }, (_, ti) => ammToken(
            `0x${(pi * 16 + ti + 1).toString(16).padStart(40, "0")}`,
            ti === 0 ? "USDC" : `TOKEN-${pi}-${ti}`, 18, 50_000, ti === 0 ? "usdc-circle" : undefined, 0.125,
          )),
        },
      },
    })));
    const routeResult = result.scores.get("usdc-circle") as RouteScoreView | undefined;

    expect(routeResult?.exitRouteObservations).toHaveLength(7);
    expect(routeResult?.exitRouteObservationCoverage).toMatchObject({
      retainedPoolCount: 2, observationCount: 7, scoreEligibleObservationCount: 7,
      scoreEligiblePoolCount: 2, scoreEligibleCapabilityPoolCount: 2, unsupportedPoolCount: 0,
    });
    expect(routeResult?.exitRouteObservationCoverage?.unsupportedReasons).not.toHaveProperty("routeObservationPayloadOverflow");
  });

  it("surfaces a missing mandatory liquidity-history table", async () => {
    const db = makeQueryDb([
      { match: "depth_stability", throwError: new Error("no such table: dex_liquidity") },
      { match: "FROM dex_liquidity_history", throwError: new Error("no such table: dex_liquidity_history") },
    ]);
    await expect(scoreOne("usdt-tether", "USDT", [poolEntry({ poolId: "ethereum:only", tvlUsd: 25_000, symbol: "USDT-USDC" })], { db }))
      .rejects.toThrow("no such table: dex_liquidity_history");
  });

  it("keeps trusted raw TVL and quarantines the fallback group instead of scaling quality/effective values", async () => {
    const pools = [
      poolEntry({ poolId: "base:orca-direct", project: "orca", chain: "solana", tvlUsd: 150_000, symbol: "USDC / USDT", poolType: "orca-whirlpool", source: "direct_api" }),
      poolEntry({ poolId: "base:orca-gt", project: "orca", chain: "solana", tvlUsd: 80_000, symbol: "USDC / USDT", volumeUsd1d: 15_000, poolType: "orca-whirlpool", source: "gecko_terminal", extra: { effectiveTvl: 80_000 } }),
    ];
    const result = await scoreOne("usdc-circle", "USDC", pools, { caps: new Map([["orca", 180_000]]) });
    const scored = result.scoredMetrics.get("usdc-circle")!;
    expect(scored.totalTvlUsd).toBe(150_000);
    expect(scored.topPools).toHaveLength(1);
    expect(scored.topPools[0]?.tvlUsd).toBe(150_000);
    expect(pools[1].tvlUsd).toBe(80_000);
    expect(pools[1].extra?.effectiveTvl).toBe(80_000);
    expect(result.diagnostics.protocolTvlQuarantine).toEqual({
      reason: "fallback-protocol-tvl-exceeds-headroom", poolCount: 1, protocolCount: 1, tvlUsd: 80_000,
    });
  });

  it.each([true, false])("keeps global retained TVL coherent above protocol caps (complete volume: %s)", async (complete) => {
    const [ethereum, base] = withReadings([
      makePool({ poolId: "ethereum:trusted", project: "curve", chain: "ethereum", tvlUsd: 80_000_000, source: "dl" }),
      makePool({ poolId: "base:trusted", project: "curve", chain: "base", tvlUsd: 80_000_000, source: "direct_api" }),
    ]);
    if (!complete) base!.volumeReading = undefined;
    const usdcPools = [ethereum!, base!, ...withReadings([
      makePool({ poolId: "ethereum:blocked", project: "near-intents", tvlUsd: 20_000_000 }),
      makePool({ poolId: "base:low-flow", project: "curve", chain: "base", tvlUsd: 120_000_000, volumeUsd1d: 1 }),
    ])];

    const result = await computeStablecoinScores(
      makeQueryDb(),
      new Map([graphFor("usdc-circle", "USDC", usdcPools), graphFor("usdt-tether", "USDT", [{ ...ethereum! }])]),
      new Map([["curve", 100_000_000]]), undefined, SCORING_CLOCK_SEC,
    );

    expect(result.globalAgg).toMatchObject({
      totalTvl: 160_000_000, totalVol24h: complete ? 2_000_000 : null, poolCount: 2, chainCount: 2,
      protocolTvl: { curve: 160_000_000 }, chainTvl: { ethereum: 80_000_000, base: 80_000_000 },
    });
    expect(result.globalAgg.volumeAvailability["24h"]).toMatchObject({
      retainedTvlUsd: 160_000_000, admittedTvlUsd: complete ? 160_000_000 : 80_000_000,
      partialGrossUsd: complete ? 2_000_000 : 1_000_000, volumeCoverage: complete ? 1 : 0.5,
    });
    expect(result.retainedPoolsByStablecoin.get("usdc-circle")?.map((p) => p.tvlUsd)).toEqual([80_000_000, 80_000_000]);
    expect(result.diagnostics.globalProtocolOverCapUsd).toBe(60_000_000);
    expect(result.diagnostics.protocolTvlQuarantine.tvlUsd).toBe(0);
    expect(result.diagnostics.fallbackCounters).toMatchObject({
      retainedExclusionBlockedDex: 1, retainedExclusionLargePoolLowVolume: 1,
    });
  });

  it("publishes normalized Aerodrome Slipstream rows into the shadow target inventory", async () => {
    const target = makeMeasuredTarget();
    const slipstreamTargets = new Map([[`usdc-circle|${target.poolId}`, target]]);
    const result = await scoreOne("usdc-circle", "USDC", [poolEntry({
      poolId: target.poolId, project: "aerodrome", chain: "Base", tvlUsd: 250_000,
      symbol: "USDC / USDbC", volumeUsd1d: 25_000, volumeUsd7d: 175_000, poolType: "aerodrome-slipstream-1bp", source: "direct_api",
    })], { nowSec: 1_700_000_100, targets: slipstreamTargets });

    expect(result.diagnostics.measuredExecution.inventoryTargetCount).toBe(1);
    expect(slipstreamTargets).toHaveLength(0);
  });

  it.each([
    ["LUSD four-token", CURVE_R3_METAPOOL_POLICIES.find((p) => p.stablecoinId === "lusd-liquity")!],
    ["MUSD three-token", CURVE_R3_METAPOOL_POLICIES.find((p) => p.stablecoinId === "meusd-mezo")!],
    ["USD1 three-token", CURVE_USD1_METAPOOL_POLICY],
    ["depegged msUSD", CURVE_R3_METAPOOL_POLICIES.find((p) => p.stablecoinId === "msusd-metronome")!],
  ] as const)("publishes the ordered %s underlying target only to shadow", async (_label, policy) => {
    const db = makeQueryDb();
    const referencePrice = policy.stablecoinId === "msusd-metronome" ? 0.883 : 1;
    const target = buildCurveCompositeMeasuredExecutionTarget({
      curveData: {
        poolAddress: policy.poolAddress, registryId: policy.expectedRegistryId, isMetaPool: true,
        basePoolAddress: policy.metapool.basePoolAddress,
        poolCoins: policy.poolTokens.map((t, i) => ({ ...t, usdPrice: i === 0 ? referencePrice : 1.02, isBasePoolLpToken: i === 1 })),
        underlyingCoins: policy.executionTokens.map((t, i) => ({ ...t, usdPrice: i === 0 ? referencePrice : 1 })),
      },
      chain: policy.chain, stablecoinId: policy.stablecoinId,
      chainAddressToId: new Map(policy.executionTokens.filter((t) => t.trackedAssetId).map((t) => [`${policy.chain}:${t.address}`, t.trackedAssetId!])),
      stablecoinPriceById: new Map([[policy.stablecoinId, referencePrice], ["usdc-circle", 0.999]]),
      retainedTvlUsd: 2_000_000, capturedAt: SCORING_CLOCK_SEC,
    });
    expect(target).not.toBeNull();
    const result = await scoreOne(policy.stablecoinId, policy.executionTokens[0]!.symbol, withReadings([poolEntry({
      poolId: target!.poolId, chain: policy.chain, symbol: policy.poolTokens.map((t) => t.symbol).join("-"),
      tvlUsd: 2_000_000, volumeUsd1d: 1_000, extra: { measuredExecutionTarget: target! },
    })]), { db, nowSec: SCORING_CLOCK_SEC });

    expect(result.measuredTargetInventory.active).toHaveLength(0);
    expect(result.measuredTargetInventory.shadow).toHaveLength(1);
    expect(result.measuredTargetInventory.shadow[0]!.poolTokenAddresses).toEqual(policy.executionTokens.map((t) => t.address));
    expect(result.measuredTargetInventory.shadow[0]!.tokenIn.referencePriceUsd).toBe(referencePrice);
    expect(result.measuredTargetInventory.shadow[0]!.tokenOut.referencePriceUsd).toBe(0.999);
    await publishStablecoinScoreTargets(db, result.measuredTargetInventory, result.diagnostics, SCORING_CLOCK_SEC);
    expect(result.diagnostics.measuredExecution.shadowTargetPublication).toMatchObject({ status: "published", rowCount: 1 });
    expect(db.scoringTestState.measuredTargetRows).toBe(1);
  });

  it("publishes target-only BSC Uniswap V3 rows without admitting them to active scoring", async () => {
    const db = makeQueryDb();
    const usdt = "0x55d398326f99059ff775485246999027b3197955";
    const usd1 = "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d";
    const target = makeMeasuredTarget({
      targetId: "bsc-uniswap-v3-shadow-target", stablecoinId: "usdt-tether",
      adapterProfileId: "uniswap-v3-quoter-v2", protocol: "uniswap-v3", chain: "bsc",
      poolId: "bsc:0xf150d29d92e7460a1531cbc9d1abeab33d6998e4",
      poolTokenAddresses: [usdt, usd1],
      tokenIn: { address: usdt, symbol: "USDT", decimals: 18, referencePriceUsd: 1, trackedAssetId: "usdt-tether" },
      tokenOut: { address: usd1, symbol: "USD1", decimals: 18, referencePriceUsd: 1, trackedAssetId: "usd1-world-liberty-financial" },
      tickSpacing: undefined, feePips: 100, retainedTvlUsd: 2_000_000,
    });
    const shadowTargets = new Map([[`usdt-tether|${target.poolId}`, target]]);

    const result = await computeStablecoinScores(db, new Map(), new Map(), undefined, 1_700_000_100, new Map(), undefined, shadowTargets);
    expect(result.diagnostics.measuredExecution.shadowTargetPublication).toEqual({
      status: "skipped", reason: "liquidity-candidate-not-published",
    });
    expect(db.scoringTestState.measuredTargetRows).toBe(0);
    expect(result.measuredTargetInventory.shadow).toHaveLength(1);
    await publishStablecoinScoreTargets(db, result.measuredTargetInventory, result.diagnostics, 1_700_000_100);
    expect(result.measuredTargetInventory.shadow).toHaveLength(0);
    expect(result.diagnostics.measuredExecution).toMatchObject({
      inventoryTargetCount: 0, shadowInventoryTargetCount: 1,
      targetPublication: { status: "skipped", reason: "no-score-eligible-targets" },
      shadowTargetPublication: { status: "published", rowCount: 1 },
    });
    expect(shadowTargets).toHaveLength(0);
  });

  it("joins a DeFiLlama Slipstream fingerprint to the unique exact target inside the TVL window", async () => {
    const capturedAt = Date.parse("2026-07-27T16:40:00Z") / 1000;
    const cadc = "0x043eb4b75d0805c43d7c834902e335621983cf03";
    const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const mkTarget = (poolId: string, retainedTvlUsd: number, tickSpacing: number) => makeMeasuredTarget({
      targetId: `target:${poolId}`, stablecoinId: "cadc-cad-coin", poolId, poolTokenAddresses: [cadc, usdc],
      tokenIn: { address: cadc, symbol: "CADC", decimals: 18, referencePriceUsd: 0.711, trackedAssetId: "cadc-cad-coin" },
      tokenOut: { address: usdc, symbol: "USDC", decimals: 6, referencePriceUsd: 1, trackedAssetId: "usdc-circle" },
      tickSpacing, retainedTvlUsd, retainedPoolPriceUsd: 0.711, capturedAt,
    });
    const primary = mkTarget("base:0x09da4832d34bebbb55783340d5bede7a70f5c48e", 156_900, 10);
    const dustSibling = mkTarget("base:0xd12f263309f05d70d88d264ad0210d7c4d1cb54a", 1.13, 1);
    const slipstreamTargets = new Map([[`cadc-cad-coin|${primary.poolId}`, primary], [`cadc-cad-coin|${dustSibling.poolId}`, dustSibling]]);

    const result = await scoreOne("cadc-cad-coin", "CADC", [poolEntry({
      poolId: "base:defillama:cadc-usdc", candidateFingerprint: buildPoolFingerprint("base", "aerodrome", [cadc, usdc])!,
      project: "aerodrome", chain: "Base", tvlUsd: 157_000, symbol: "CADC-USDC", volumeUsd1d: 31_000, volumeUsd7d: 217_000,
      poolType: "aerodrome-slipstream-5bp",
    })], { nowSec: capturedAt + 100, targets: slipstreamTargets });

    expect(result.diagnostics.measuredExecution.inventoryTargetCount).toBe(1);
    expect(slipstreamTargets).toHaveLength(0);
  });

  it("does not misattribute an unsupported Pancake pool family to the V3 adapter", async () => {
    const result = await scoreOne("cadc-cad-coin", "CADC", [poolEntry({
      poolId: "base:0x31a98819f70438b162c6f9a6d342e9e84f84c825c0348dac23b9fbcb9d282139",
      project: "pancakeswap", chain: "Base", tvlUsd: 10_327, symbol: "CADC / USDC",
      volumeUsd1d: 8, volumeUsd7d: 56, poolType: "cg-amm", source: "cg_onchain",
    })]);
    expect(result.retainedPoolsByStablecoin.get("cadc-cad-coin")?.[0]?.extra?.executionCapabilityGate).toBeUndefined();
    expect(result.diagnostics.measuredExecution.inventoryTargetCount).toBe(0);
  });

  it("quarantines oversized Carbon DeFi chain-suffixed fallback observations without rewriting them", async () => {
    const pools = withReadings([poolEntry({
      poolId: "ethereum:0xc537e898cd774e2dcba3b14ea6f34c93d5ea45e1-2236", project: "carbon-defi-ethereum",
      chain: "ethereum", tvlUsd: 2_000_000_000, symbol: "XAUt / sUSDS", volumeUsd1d: 1_000_000,
      poolType: "cg-amm", source: "cg_onchain", extra: { effectiveTvl: 480_000_000 },
    })]);
    const result = await scoreOne("xaut-tether", "XAUT", pools, { caps: new Map([["carbon-defi", 3_500_000]]), nowSec: SCORING_CLOCK_SEC });

    expect(result.scoredMetrics.get("xaut-tether")!).toMatchObject({ totalTvlUsd: 0, topPools: [] });
    expect(result.globalAgg.protocolTvl["carbon-defi"]).toBeUndefined();
    expect(pools[0].tvlUsd).toBe(2_000_000_000);
    expect(pools[0].extra?.effectiveTvl).toBe(480_000_000);
    expect(result.diagnostics.protocolTvlQuarantine).toEqual({
      reason: "fallback-protocol-tvl-exceeds-headroom", poolCount: 1, protocolCount: 1, tvlUsd: 2_000_000_000,
    });
  });

  it("stops constructing DEX prices after a bounded write aborts", async () => {
    const controller = new AbortController();
    const abortReason = new Error("DEX price publication timed out");
    const coins = ACTIVE_STABLECOINS.slice(0, 30);
    const retainedPools = new Map<string, PoolEntry[]>(coins.map((coin, i) => [
      coin.id,
      [makePool({
        poolId: `ethereum:pool-${i}`, project: "curve", chain: "Ethereum", tvlUsd: 100_000,
        symbol: "PAIR", volumeUsd1d: 0, volumeUsd7d: null, poolType: "generic", price: 1, source: "gecko_terminal",
      })],
    ]));
    const primaryPrices = new Map(coins.map((c) => [c.id, 1] as const));
    vi.mocked(batchExecute).mockImplementationOnce(async (_db, statements) => {
      controller.abort(abortReason);
      return statements.length;
    });

    await expect(computeDexPrices({
      db: makeQueryDb([]), retainedPoolsByStablecoin: retainedPools, nowSec: 1_700_000_000, signal: controller.signal, primaryPrices,
    })).rejects.toThrow("DEX price publication timed out");

    expect(batchExecute).toHaveBeenCalledTimes(1);
    expect(vi.mocked(batchExecute).mock.calls[0]?.[1]).toHaveLength(DEX_LIQUIDITY_SCORING_BATCH_SIZE);
  });
});

describe("computeSeriesStability", () => {
  it.each([
    { label: "returns null for fewer than 7 values", values: [1, 2, 3, 4, 5, 6] },
    { label: "returns null when fewer than 7 finite values remain after filtering", values: [100, NaN, NaN, NaN, NaN, NaN, NaN, NaN, 101] },
    { label: "returns null for all-zero values", values: [0, 0, 0, 0, 0, 0, 0] },
  ])("$label", ({ values }) => {
    expect(computeSeriesStability(values)).toBeNull();
  });

  it.each([
    { label: "returns a stability score for 7+ valid values", values: [100, 101, 99, 100, 102, 98, 100] },
    { label: "filters out NaN values before computing", values: [100, NaN, 101, 99, NaN, 100, 102, 98, 100] },
  ])("$label", ({ values }) => {
    const result = computeSeriesStability(values);
    expect(result).toBeTypeOf("number");
    expect(result!).toBeGreaterThan(0.9);
  });

  it("returns low stability for maximally volatile series", () => {
    const result = computeSeriesStability([1, 1000, 1, 1000, 1, 1000, 1]);
    expect(result).toBeTypeOf("number");
    expect(result!).toBeLessThanOrEqual(0.01);
  });
});
