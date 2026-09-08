import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/db")>();
  return {
    ...actual,
    batchExecute: vi.fn(async (_db: D1Database, stmts: D1PreparedStatement[]) => stmts.length),
    executeAtomicBatch: vi.fn(async (_db: D1Database, stmts: D1PreparedStatement[]) => stmts.length),
  };
});

import { ACTIVE_IDS, ACTIVE_STABLECOINS, TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { LIQUIDITY_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/liquidity-score";
import { batchExecute, executeAtomicBatch } from "../../lib/db";
import { createLatestSchemaFixtureTracker } from "../../test-helpers/latest-schema-sqlite";
import { initMetrics } from "../dex-liquidity/pool-helpers";
import {
  buildDexLiquidityPublicationGenerationId,
  DEX_LIQUIDITY_PERSISTENCE_BATCH_SIZE,
  persistScores,
  pruneOldDexLiquidityGenerations,
  writeHistoricalSnapshots,
} from "../dex-liquidity/persistence";
import { makeFullScoreResult } from "./dex-liquidity-persistence.test-support";
import type { DexDeploymentCensusRow } from "../dex-liquidity/deployment-census-coverage";
import type { FullScoreResult } from "../dex-liquidity/types";

const INACTIVE_TRACKED_STABLECOIN = TRACKED_STABLECOINS.find((coin) => !ACTIVE_IDS.has(coin.id));

if (!INACTIVE_TRACKED_STABLECOIN) {
  throw new Error("dex-liquidity persistence tests require at least one tracked inactive stablecoin");
}

interface PreparedStatementWithMeta extends D1PreparedStatement {
  sql: string;
  boundValues: unknown[];
}

interface DexPersistenceMockDb extends D1Database {
  getHistory(): Array<{ sql: string; binds: unknown[] }>;
}

function makeDb(options: {
  historyError?: unknown;
  candidateCoverage?: {
    row_count: number;
    active_asset_rows: number;
    global_rows: number;
  };
  currentGenerationRows?: number;
  newerCurrentRows?: number;
  deploymentOutcomeRows?: DexDeploymentCensusRow[];
} = {}): DexPersistenceMockDb {
  const history: Array<{ sql: string; binds: unknown[] }> = [];

  function createStatement(sql: string, boundValues: unknown[] = []): PreparedStatementWithMeta {
    return {
      sql,
      boundValues,
      bind: (...args: unknown[]) => createStatement(sql, args),
      all: async <T>() => {
        history.push({ sql, binds: [...boundValues] });
        if (sql.includes("FROM dex_liquidity_history")) {
          if (options.historyError != null) {
            throw (options.historyError instanceof Error ? options.historyError : new Error(String(options.historyError)));
          }
          return {
            results: [] as T[],
            success: true,
            meta: {},
          };
        }
        if (sql.includes("FROM dex_deployment_outcomes")) {
          return {
            results: (options.deploymentOutcomeRows ?? []) as T[],
            success: true,
            meta: {},
          };
        }
        return { results: [] as T[], success: true, meta: {} };
      },
      first: async <T>() => {
        history.push({ sql, binds: [...boundValues] });
        if (sql.includes("FROM dex_liquidity_run_rows") && sql.includes("row_count")) {
          return (options.candidateCoverage ?? {
            row_count: ACTIVE_STABLECOINS.length + 1,
            active_asset_rows: ACTIVE_STABLECOINS.length,
            global_rows: 1,
          }) as T;
        }
        if (sql.includes("updated_at > ?") && sql.includes("FROM dex_liquidity")) {
          return { cnt: options.newerCurrentRows ?? 0 } as T;
        }
        if (sql.includes("current_row_count") && sql.includes("dex_liquidity_publication_generations")) {
          return { current_row_count: options.currentGenerationRows ?? ACTIVE_STABLECOINS.length + 1 } as T;
        }
        return null as T | null;
      },
      run: async () => {
        history.push({ sql, binds: [...boundValues] });
        return { success: true, meta: { changes: 1 } };
      },
    } as unknown as PreparedStatementWithMeta;
  }

  return {
    prepare: (sql: string) => createStatement(sql),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
    getHistory: () => history.map((entry) => ({ sql: entry.sql, binds: [...entry.binds] })),
  } as unknown as DexPersistenceMockDb;
}



const DEX_LIQUIDITY_RUN_ROW_BIND_COUNT = 29;

function extractDexLiquidityRunRows(statements: readonly PreparedStatementWithMeta[]): unknown[][] {
  const rows: unknown[][] = [];
  for (const statement of statements) {
    if (statement.boundValues.length % DEX_LIQUIDITY_RUN_ROW_BIND_COUNT !== 0) {
      throw new Error("DEX liquidity run-row statement has an incomplete bind group");
    }
    for (
      let index = 0;
      index < statement.boundValues.length;
      index += DEX_LIQUIDITY_RUN_ROW_BIND_COUNT
    ) {
      rows.push(
        statement.boundValues.slice(index, index + DEX_LIQUIDITY_RUN_ROW_BIND_COUNT),
      );
    }
  }
  return rows;
}

function getPreparedBatchStatements(sqlFragment: string): PreparedStatementWithMeta[] {
  return vi.mocked(batchExecute).mock.calls.flatMap(([, statements]) =>
    (statements as PreparedStatementWithMeta[]).filter((statement) => statement.sql.includes(sqlFragment))
  );
}


describe("dex-liquidity persistence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(batchExecute).mockReset().mockImplementation(async (_db, statements) => statements.length);
    vi.mocked(executeAtomicBatch).mockReset().mockImplementation(async (_db, statements) => statements.length);
  });

  it("persists scored rows, placeholders, and the global sentinel row", async () => {
    const metrics = initMetrics("usdt-tether", "USDT");
    metrics.totalTvlUsd = 123_456;
    metrics.totalVolume24hUsd = 22_222;
    metrics.totalVolume7dUsd = 155_555;
    metrics.poolCount = 2;
    metrics.pairs = new Set(["USDT-USDC", "USDT-DAI"]);
    metrics.chains = new Set(["Ethereum", "Base"]);
    metrics.protocolTvl = { curve: 100_000, "uniswap-v3": 23_456 };
    metrics.chainTvl = { Ethereum: 100_000, Base: 23_456 };
    metrics.topPools = [
      {
        poolId: "ethereum:curve",
        project: "curve",
        chain: "Ethereum",
        tvlUsd: 100_000,
        symbol: "USDT-USDC",
        volumeUsd1d: 10_000,
        poolType: "curve-stableswap",
        source: "dl",
      },
    ];
    metrics.effectiveTvl = 100_111.7;

    const result = await persistScores(
      makeDb(),
      new Map([["usdt-tether", metrics]]),
      new Map([
        [
          "usdt-tether",
          makeFullScoreResult({
            tvl: 123_456,
            vol24h: 22_222,
            score: 78,
            hhi: 0.2222,
            durability: 81,
            components: {
              tvlDepth: 70,
              volumeActivity: 60,
              poolQuality: 80,
              durability: 81,
              pairDiversity: 10,
            },
            weightedBalanceRatio: 0.91,
            organicFrac: 0.67,
            avgStress: 12.34,
            lockedLiqPct: 0.55,
            coverageClass: "mixed",
            coverageConfidence: 0.85,
            sourceMix: {
              dl: { poolCount: 1, tvlUsd: 100_000 },
              gecko_terminal: { poolCount: 1, tvlUsd: 23_456 },
            },
            balanceMeasuredTvlUsd: 120_000,
            organicMeasuredTvlUsd: 120_000,
          }),
        ],
      ]),
      {
        totalTvl: 456_789,
        totalVol24h: 99_999,
        totalVol7d: 700_000,
        totalVol7dMeasured: true,
        poolCount: 12,
        chainCount: 4,
        protocolTvl: { curve: 200_000 },
        chainTvl: { ethereum: 300_000 },
      },
      1_700_000_000,
    );

    expect(result).toEqual({
      placeholderCount: ACTIVE_STABLECOINS.length - 1,
      orphanRowsDeleted: 0,
      orphanCleanupFailed: false,
      generationId: buildDexLiquidityPublicationGenerationId(1_700_000_000),
      expectedRowCount: ACTIVE_STABLECOINS.length + 1,
      candidateRowsWritten: ACTIVE_STABLECOINS.length + 1,
      currentGenerationRows: ACTIVE_STABLECOINS.length + 1,
      inactiveMetricRowsSkipped: 0,
      inactiveMetricIdsSkipped: [],
      retention: {
        cutoff: 1_700_000_000 - 3 * 60 * 60,
        deletedRows: 2,
        deletedRunRows: 1,
        deletedGenerationRows: 1,
        oldestRemainingAt: null,
        durationMs: expect.any(Number),
        error: null,
      },
    });

    const prepared = getPreparedBatchStatements("INSERT OR REPLACE INTO dex_liquidity_run_rows");
    const preparedRows = extractDexLiquidityRunRows(prepared);
    expect(preparedRows).toHaveLength(ACTIVE_STABLECOINS.length + 1);
    expect(preparedRows.map((row) => row[1])).toEqual([
      "usdt-tether",
      ...ACTIVE_STABLECOINS.filter((coin) => coin.id !== "usdt-tether").map((coin) => coin.id),
      "__global__",
    ]);
    const candidateCalls = vi.mocked(batchExecute).mock.calls.filter(([, statements]) =>
      (statements as PreparedStatementWithMeta[]).some((statement) =>
        statement.sql.includes("INSERT OR REPLACE INTO dex_liquidity_run_rows")
      )
    );
    expect(DEX_LIQUIDITY_PERSISTENCE_BATCH_SIZE).toBe(15);
    expect(prepared).toHaveLength(Math.ceil(preparedRows.length / 3));
    expect(candidateCalls).toHaveLength(
      Math.ceil(preparedRows.length / DEX_LIQUIDITY_PERSISTENCE_BATCH_SIZE),
    );
    expect(candidateCalls.every(([, statements]) => statements.length <= 5)).toBe(true);
    expect(candidateCalls[candidateCalls.length - 1]?.[1]).toHaveLength(
      Math.ceil(
        (preparedRows.length % DEX_LIQUIDITY_PERSISTENCE_BATCH_SIZE
          || DEX_LIQUIDITY_PERSISTENCE_BATCH_SIZE) / 3,
      ),
    );
    expect(prepared.length).toBeLessThan(preparedRows.length);
    expect(prepared.every((statement) => statement.boundValues.length <= 87)).toBe(true);

    const usdtRow = preparedRows.find((row) => row[1] === "usdt-tether");
    const usdcPlaceholder = preparedRows.find((row) => row[1] === "usdc-circle");
    const globalRow = preparedRows.find((row) => row[1] === "__global__");

    expect(usdtRow).toEqual([
      buildDexLiquidityPublicationGenerationId(1_700_000_000),
      "usdt-tether",
      "USDT",
      123_456,
      22_222,
      155_555,
      1,
      2,
      2,
      2,
      JSON.stringify({ curve: 100_000, "uniswap-v3": 23_456 }),
      JSON.stringify({ Ethereum: 100_000, Base: 23_456 }),
      JSON.stringify(metrics.topPools),
      78,
      0.2222,
      12.34,
      0.91,
      0.67,
      100_112,
      81,
      JSON.stringify({
        tvlDepth: 70,
        volumeActivity: 60,
        poolQuality: 80,
        durability: 81,
        pairDiversity: 10,
      }),
      0.55,
      "mixed",
      0.85,
      JSON.stringify({
        dl: { poolCount: 1, tvlUsd: 100_000 },
        gecko_terminal: { poolCount: 1, tvlUsd: 23_456 },
      }),
      120_000,
      120_000,
      LIQUIDITY_METHODOLOGY_VERSION,
      1_700_000_000,
    ]);
    expect(usdcPlaceholder).toEqual([
      buildDexLiquidityPublicationGenerationId(1_700_000_000),
      "usdc-circle",
      "USDC",
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      0,
      null,
      expect.any(String),
      null,
      "unobserved",
      0,
      null,
      0,
      0,
      LIQUIDITY_METHODOLOGY_VERSION,
      1_700_000_000,
    ]);
    expect(JSON.parse(String(usdcPlaceholder?.[20]))).toMatchObject({
      exitRouteObservations: [],
      exitRouteObservationCoverage: {
        status: "unknown",
        retainedPoolCount: 0,
        observationCount: 0,
      },
      dexDeploymentCensus: {
        state: "discovery-deferral",
        generationId: buildDexLiquidityPublicationGenerationId(1_700_000_000),
        publishedAtSec: 1_700_000_000,
      },
    });
    expect(globalRow).toEqual([
      buildDexLiquidityPublicationGenerationId(1_700_000_000),
      "__global__",
      "__global__",
      456_789,
      99_999,
      700_000,
      1,
      12,
      0,
      4,
      JSON.stringify({ curve: 200_000 }),
      JSON.stringify({ ethereum: 300_000 }),
      null,
      null,
      null,
      null,
      null,
      null,
      0,
      null,
      null,
      null,
      "unobserved",
      0,
      null,
      0,
      0,
      LIQUIDITY_METHODOLOGY_VERSION,
      1_700_000_000,
    ]);

    expect(getPreparedBatchStatements("INSERT INTO dex_liquidity").length).toBeGreaterThan(0);
  });

  it("binds complete reviewed-empty placeholder coverage to the publication generation", async () => {
    const meta = ACTIVE_STABLECOINS.find((coin) => coin.id === "aa-falconx-mev-capital");
    if (!meta) throw new Error("expected aa-falconx-mev-capital in active registry");
    const nowSec = 1_800_000_000;
    const deploymentOutcomeRows: DexDeploymentCensusRow[] = [
      ...(meta.contracts ?? []),
      ...(meta.tradedContracts ?? []),
    ].map((deployment) => ({
      stablecoin_id: meta.id,
      chain: deployment.chain,
      contract_address: deployment.address,
      outcome: "verified_no_pools",
      provider_set_json: JSON.stringify(["coingecko"]),
      reason: "A provider completed the direct-token query with no eligible pool",
      observed_pool_count: 0,
      observed_at: nowSec - 60,
      discovery_last_crawl_at: nowSec - 120,
    }));

    await persistScores(
      makeDb({ deploymentOutcomeRows }),
      new Map(),
      new Map(),
      {
        totalTvl: 0,
        totalVol24h: 0,
        totalVol7d: 0,
        totalVol7dMeasured: true,
        poolCount: 0,
        chainCount: 0,
        protocolTvl: {},
        chainTvl: {},
      },
      nowSec,
    );

    const row = extractDexLiquidityRunRows(
      getPreparedBatchStatements("INSERT OR REPLACE INTO dex_liquidity_run_rows"),
    ).find((candidate) => candidate[1] === meta.id);
    expect(JSON.parse(String(row?.[20]))).toMatchObject({
      exitRouteObservations: [],
      exitRouteObservationCoverage: {
        status: "populated",
        retainedPoolCount: 0,
        observationCount: 0,
        unsupportedPoolCount: 0,
      },
      dexDeploymentCensus: {
        state: "complete-empty",
        generationId: buildDexLiquidityPublicationGenerationId(nowSec),
        publishedAtSec: nowSec,
        expectedDeploymentCount: deploymentOutcomeRows.length,
        reviewedDeploymentCount: deploymentOutcomeRows.length,
        verifiedNoPoolsCount: deploymentOutcomeRows.length,
      },
    });
  });

  it("classifies the deployment census for a scored row that retained no pool", async () => {
    // hlusd-hela shape: a metrics row sends the asset down the scoring path, so
    // it never reaches the placeholder loop and would otherwise publish an
    // `unknown` coverage with an empty unsupportedReasons map.
    const meta = ACTIVE_STABLECOINS.find((coin) => coin.id === "hlusd-hela");
    if (!meta) throw new Error("expected hlusd-hela in active registry");
    const nowSec = 1_800_000_000;
    const metrics = initMetrics(meta.id, meta.symbol);
    metrics.totalTvlUsd = 1_000;
    metrics.poolCount = 1;

    await persistScores(
      makeDb(),
      new Map([[meta.id, metrics]]),
      new Map([
        [
          meta.id,
          makeFullScoreResult({
            exitRouteObservations: [],
            exitRouteObservationCoverage: {
              status: "unknown",
              capabilityMatrixVersion: "p4a.9",
              retainedPoolCount: 0,
              observationCount: 0,
              scoreEligibleObservationCount: 0,
              scoreEligiblePoolCount: 0,
              scoreEligibleCapabilityPoolCount: 0,
              unsupportedPoolCount: 0,
              evidenceCounts: {},
              unsupportedReasons: {},
            },
          } as Partial<FullScoreResult>),
        ],
      ]),
      {
        totalTvl: 0,
        totalVol24h: 0,
        totalVol7d: 0,
        totalVol7dMeasured: true,
        poolCount: 0,
        chainCount: 0,
        protocolTvl: {},
        chainTvl: {},
      },
      nowSec,
    );

    const row = extractDexLiquidityRunRows(
      getPreparedBatchStatements("INSERT OR REPLACE INTO dex_liquidity_run_rows"),
    ).find((candidate) => candidate[1] === meta.id);
    expect(JSON.parse(String(row?.[20]))).toMatchObject({
      exitRouteObservationCoverage: {
        status: "unknown",
        retainedPoolCount: 0,
        unsupportedReasons: { deploymentCensusNoReviewedScope: 1 },
      },
      dexDeploymentCensus: {
        state: "unsupported-method",
        generationId: buildDexLiquidityPublicationGenerationId(nowSec),
        publishedAtSec: nowSec,
        expectedDeploymentCount: 0,
        unsupportedChainDeploymentCount: 0,
      },
    });
  });

  it("skips tracked inactive metrics when staging the active current generation", async () => {
    const activeMetrics = initMetrics("usdt-tether", "USDT");
    activeMetrics.totalTvlUsd = 123;
    activeMetrics.poolCount = 1;
    const inactiveMetrics = initMetrics(
      INACTIVE_TRACKED_STABLECOIN.id,
      INACTIVE_TRACKED_STABLECOIN.symbol,
    );
    inactiveMetrics.totalTvlUsd = 456;
    inactiveMetrics.poolCount = 1;

    const db = makeDb();
    const result = await persistScores(
      db,
      new Map([
        ["usdt-tether", activeMetrics],
        [INACTIVE_TRACKED_STABLECOIN.id, inactiveMetrics],
      ]),
      new Map([
        ["usdt-tether", makeFullScoreResult({ score: 78 })],
        [INACTIVE_TRACKED_STABLECOIN.id, makeFullScoreResult({ score: 42 })],
      ]),
      {
        totalTvl: 579,
        totalVol24h: 0,
        totalVol7d: 0,
        totalVol7dMeasured: true,
        poolCount: 2,
        chainCount: 1,
        protocolTvl: {},
        chainTvl: {},
      },
      1_700_000_000,
    );

    expect(result).toMatchObject({
      expectedRowCount: ACTIVE_STABLECOINS.length + 1,
      candidateRowsWritten: ACTIVE_STABLECOINS.length + 1,
      currentGenerationRows: ACTIVE_STABLECOINS.length + 1,
      placeholderCount: ACTIVE_STABLECOINS.length - 1,
      inactiveMetricRowsSkipped: 1,
      inactiveMetricIdsSkipped: [INACTIVE_TRACKED_STABLECOIN.id],
    });

    const prepared = extractDexLiquidityRunRows(
      getPreparedBatchStatements("INSERT OR REPLACE INTO dex_liquidity_run_rows"),
    );
    expect(prepared.some((row) => row[1] === INACTIVE_TRACKED_STABLECOIN.id)).toBe(false);
    expect(prepared.some((row) => row[1] === "usdt-tether")).toBe(true);
    expect(prepared).toHaveLength(ACTIVE_STABLECOINS.length + 1);

    const stageMetadata = db
      .getHistory()
      .map((entry) => entry.binds[3])
      .find((value): value is string => typeof value === "string" && value.includes("inactiveMetricRowsSkipped"));
    expect(JSON.parse(stageMetadata ?? "{}")).toMatchObject({
      metricsCount: 2,
      scoredCount: 2,
      activeMetricsCount: 1,
      activeScoredCount: 1,
      inactiveMetricRowsSkipped: 1,
      inactiveMetricIdsSkipped: [INACTIVE_TRACKED_STABLECOIN.id],
    });
  });

  it("does not publish freshness when the signal aborts after score batch writes", async () => {
    const metrics = initMetrics("usdt-tether", "USDT");
    const db = makeDb();
    const controller = new AbortController();
    const abortError = new Error("cron timed out");

    vi.mocked(batchExecute).mockImplementationOnce(async (_db, _stmts, options) => {
      expect(options).toMatchObject({ signal: controller.signal });
      controller.abort(abortError);
      return 1;
    });

    await expect(
      persistScores(
        db,
        new Map([["usdt-tether", metrics]]),
        new Map([["usdt-tether", makeFullScoreResult()]]),
        {
          totalTvl: 1,
          totalVol24h: 1,
          totalVol7d: 1,
          totalVol7dMeasured: true,
          poolCount: 1,
          chainCount: 1,
          protocolTvl: {},
          chainTvl: {},
        },
        1_700_000_000,
        controller.signal,
      ),
    ).rejects.toThrow("cron timed out");

    expect(db.getHistory().some((entry) => entry.binds.includes("freshness:dex-liquidity"))).toBe(false);
  });

  it("does not publish current rows when a candidate generation is incomplete", async () => {
    const metrics = initMetrics("usdt-tether", "USDT");
    const db = makeDb({
      candidateCoverage: {
        row_count: ACTIVE_STABLECOINS.length,
        active_asset_rows: ACTIVE_STABLECOINS.length - 1,
        global_rows: 1,
      },
    });

    await expect(
      persistScores(
        db,
        new Map([["usdt-tether", metrics]]),
        new Map([["usdt-tether", makeFullScoreResult()]]),
        {
          totalTvl: 1,
          totalVol24h: 1,
          totalVol7d: 1,
          totalVol7dMeasured: true,
          poolCount: 1,
          chainCount: 1,
          protocolTvl: {},
          chainTvl: {},
        },
        1_700_000_000,
      ),
    ).rejects.toThrow("Incomplete DEX liquidity generation");

    const publishCalls = vi.mocked(batchExecute).mock.calls.filter(([, statements]) =>
      (statements as PreparedStatementWithMeta[]).some((stmt) => stmt.sql.includes("INSERT INTO dex_liquidity")),
    );
    expect(publishCalls).toHaveLength(0);
    expect(db.getHistory().some((entry) => entry.binds.includes("freshness:dex-liquidity"))).toBe(false);
    expect(db.getHistory().some((entry) => entry.sql.includes("state = 'failed'"))).toBe(true);
  });

  it("does not publish current rows when candidate chunked writes fail", async () => {
    const metrics = initMetrics("usdt-tether", "USDT");
    const db = makeDb();

    vi.mocked(batchExecute).mockRejectedValueOnce(new Error("candidate batch failed"));

    await expect(
      persistScores(
        db,
        new Map([["usdt-tether", metrics]]),
        new Map([["usdt-tether", makeFullScoreResult()]]),
        {
          totalTvl: 1,
          totalVol24h: 1,
          totalVol7d: 1,
          totalVol7dMeasured: true,
          poolCount: 1,
          chainCount: 1,
          protocolTvl: {},
          chainTvl: {},
        },
        1_700_000_000,
      ),
    ).rejects.toThrow("candidate batch failed");

    expect(vi.mocked(batchExecute).mock.calls).toHaveLength(1);
    expect(db.getHistory().some((entry) => entry.binds.includes("freshness:dex-liquidity"))).toBe(false);
    expect(db.getHistory().some((entry) => entry.sql.includes("state = 'failed'"))).toBe(true);
  });

  it("keeps current publication fail-closed after a later candidate batch fails", async () => {
    const metrics = initMetrics("usdt-tether", "USDT");
    const db = makeDb();

    vi.mocked(batchExecute)
      .mockImplementationOnce(async (_db, statements) => statements.length)
      .mockRejectedValueOnce(new Error("second candidate batch failed"));

    await expect(
      persistScores(
        db,
        new Map([["usdt-tether", metrics]]),
        new Map([["usdt-tether", makeFullScoreResult()]]),
        {
          totalTvl: 1,
          totalVol24h: 1,
          totalVol7d: 1,
          totalVol7dMeasured: true,
          poolCount: 1,
          chainCount: 1,
          protocolTvl: {},
          chainTvl: {},
        },
        1_700_000_000,
      ),
    ).rejects.toThrow("second candidate batch failed");

    expect(batchExecute).toHaveBeenCalledTimes(2);
    expect(vi.mocked(batchExecute).mock.calls.every(([, statements]) =>
      statements.length <= 5
    )).toBe(true);
    expect(getPreparedBatchStatements("INSERT INTO dex_liquidity")).toHaveLength(0);
    expect(db.getHistory().some((entry) => entry.sql.includes("state = 'failed'"))).toBe(true);
    expect(db.getHistory().some((entry) => entry.binds.includes("freshness:dex-liquidity"))).toBe(false);
  });

  it("does not advance freshness when the atomic current-generation batch fails", async () => {
    const metrics = initMetrics("usdt-tether", "USDT");
    const db = makeDb();
    vi.mocked(batchExecute).mockImplementation(async (_db, statements) => {
      if ((statements as PreparedStatementWithMeta[]).some((statement) =>
        statement.sql.includes("INSERT INTO dex_liquidity")
      )) {
        throw new Error("atomic generation publish failed");
      }
      return statements.length;
    });

    await expect(
      persistScores(
        db,
        new Map([["usdt-tether", metrics]]),
        new Map([["usdt-tether", makeFullScoreResult()]]),
        {
          totalTvl: 1,
          totalVol24h: 1,
          totalVol7d: 1,
          totalVol7dMeasured: true,
          poolCount: 1,
          chainCount: 1,
          protocolTvl: {},
          chainTvl: {},
        },
        1_700_000_000,
      ),
    ).rejects.toThrow("atomic generation publish failed");

    const publishCall = vi.mocked(batchExecute).mock.calls.find(([, statements]) =>
      (statements as PreparedStatementWithMeta[]).some((statement) =>
        statement.sql.includes("INSERT INTO dex_liquidity")
      )
    );
    expect(publishCall?.[1]).toHaveLength(2);
    expect(db.getHistory().some((entry) => entry.sql.includes("state = 'failed'"))).toBe(true);
    expect(db.getHistory().some((entry) => entry.binds.includes("freshness:dex-liquidity"))).toBe(false);
  });

  it("preserves published counters and timestamps when retry staging fails", async () => {
    const fixtures = createLatestSchemaFixtureTracker();
    try {
      const { sqlite, db } = fixtures.open();
      const actual = await vi.importActual<typeof import("../../lib/db")>("../../lib/db");
      vi.mocked(batchExecute).mockImplementation(actual.batchExecute);
      const now = 1_700_000_000;
      const generationId = buildDexLiquidityPublicationGenerationId(now);
      sqlite.prepare(`INSERT INTO dex_liquidity_publication_generations
        (generation_id, started_at, state, expected_row_count, written_row_count,
         current_row_count, created_at, published_at) VALUES (?, ?, 'published', 7, 7, 7, ?, ?)`)
        .run(generationId, now, now - 100, now - 50);
      sqlite.exec(`CREATE TRIGGER fail_retry_staging BEFORE INSERT ON dex_liquidity_run_rows
        BEGIN SELECT RAISE(ABORT, 'injected staging failure'); END`);
      await expect(persistScores(db, new Map(), new Map(), {
        totalTvl: 1, totalVol24h: 1, totalVol7d: 1, totalVol7dMeasured: true,
        poolCount: 1, chainCount: 1, protocolTvl: {}, chainTvl: {},
      }, now)).rejects.toThrow("injected staging failure");
      expect(sqlite.prepare(`SELECT state, written_row_count, current_row_count,
        created_at, published_at, failed_at, failure_reason
        FROM dex_liquidity_publication_generations WHERE generation_id = ?`).get(generationId)).toEqual({
        state: "published", written_row_count: 7, current_row_count: 7,
        created_at: now - 100, published_at: now - 50, failed_at: null, failure_reason: null,
      });
    } finally {
      fixtures.closeAll();
    }
  });



  it("logs and swallows snapshot query failures", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      writeHistoricalSnapshots(
        makeDb({ historyError: new Error("snapshot unavailable") }),
        new Map([["usdt-tether", makeFullScoreResult()]]),
      ),
    ).resolves.toEqual({
      snapshotRowsWritten: 0,
      skipped: false,
      writeFailed: true,
      historyRowsPruned: 0,
      retentionPruneFailed: false,
    });

    expect(batchExecute).not.toHaveBeenCalled();
    expect(executeAtomicBatch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[dex-liquidity] Daily snapshot failed:"));
  });
});

describe("dex liquidity generation prune", () => {
  it("prunes expired unreferenced generations while protecting current references and the cutoff", async () => {
    const fixtures = createLatestSchemaFixtureTracker();
    try {
      const { sqlite, db } = fixtures.open();
      const now = 1_700_000_000;
      const cutoff = now - 3 * 60 * 60;
      const insert = sqlite.prepare(`INSERT INTO dex_liquidity_publication_generations
        (generation_id, started_at, state, expected_row_count, created_at) VALUES (?, ?, ?, 1, ?)`);
      for (const [id, timestamp, state] of [
        ["expired-staged", cutoff - 5, "staged"], ["expired-failed", cutoff - 4, "failed"],
        ["expired-published", cutoff - 3, "published"], ["global-reference", cutoff - 2, "published"],
        ["asset-reference", cutoff - 1, "published"], ["cutoff", cutoff, "staged"],
        ["recent", cutoff + 1, "published"],
      ] as const) {
        insert.run(id, timestamp, state, timestamp);
        sqlite.prepare(`INSERT INTO dex_liquidity_run_rows
          (generation_id, stablecoin_id, symbol, updated_at) VALUES (?, 'usdt-tether', 'USDT', ?)`).run(id, timestamp);
      }
      sqlite.prepare(`INSERT INTO dex_liquidity
        (stablecoin_id, symbol, updated_at, publication_generation_id, publication_state)
        VALUES ('__global__', 'GLOBAL', ?, 'global-reference', 'published'),
               ('usdt-tether', 'USDT', ?, 'asset-reference', 'published')`).run(now, now);
      const retention = await pruneOldDexLiquidityGenerations(db, now);
      expect(sqlite.prepare("SELECT generation_id FROM dex_liquidity_publication_generations ORDER BY generation_id").all())
        .toEqual(["asset-reference", "cutoff", "global-reference", "recent"].map((generation_id) => ({ generation_id })));
      expect(sqlite.prepare("SELECT generation_id FROM dex_liquidity_run_rows ORDER BY generation_id").all())
        .toEqual(["cutoff", "global-reference", "recent"].map((generation_id) => ({ generation_id })));
      expect(retention).toMatchObject({
        cutoff, deletedRunRows: 4, deletedGenerationRows: 3, deletedRows: 7,
        oldestRemainingAt: cutoff - 2, error: null,
      });
    } finally {
      fixtures.closeAll();
    }
  });
});
