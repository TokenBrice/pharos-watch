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
import { initMetrics } from "../dex-liquidity/pool-helpers";
import {
  buildDexLiquidityPublicationGenerationId,
  DEX_LIQUIDITY_PERSISTENCE_BATCH_SIZE,
  persistScores,
  pruneOldDexLiquidityGenerations,
  writeHistoricalSnapshots,
} from "../dex-liquidity/persistence";
import type { FullScoreResult } from "../dex-liquidity/types";
import type { DexDeploymentCensusRow } from "../dex-liquidity/deployment-census-coverage";

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
  historyRows?: Array<{ stablecoin_id: string; liquidity_score: number | null }>;
  historyError?: unknown;
  candidateCoverage?: {
    row_count: number;
    active_asset_rows: number;
    global_rows: number;
  };
  currentGenerationRows?: number;
  newerCurrentRows?: number;
  publicationState?: { value: "staged" | "published" | "failed" | null };
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
            results: (options.historyRows ?? []) as T[],
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
        if (sql.includes("dex_liquidity_publication_generations") && sql.includes("INSERT")) {
          if (options.publicationState != null) {
            if (sql.includes("INSERT OR REPLACE")) {
              options.publicationState.value = "staged";
            } else if (options.publicationState.value !== "published") {
              options.publicationState.value = "staged";
            }
          }
        }
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

function makeHistoryIdentityRows(
  scoredIds: ReadonlySet<string>,
  ids = ACTIVE_STABLECOINS.map((coin) => coin.id),
): Array<{ stablecoin_id: string; liquidity_score: number | null }> {
  return ids.map((stablecoinId) => ({
    stablecoin_id: stablecoinId,
    liquidity_score: scoredIds.has(stablecoinId) ? 1 : null,
  }));
}

function extractHistoryInsertRows(statements: readonly PreparedStatementWithMeta[]): unknown[][] {
  const rows: unknown[][] = [];
  for (const statement of statements) {
    for (let index = 0; index < statement.boundValues.length; index += 10) {
      rows.push(statement.boundValues.slice(index, index + 10));
    }
  }
  return rows;
}

const DEX_LIQUIDITY_RUN_ROW_BIND_COUNT = 28;

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

function makeFullScoreResult(overrides: Partial<FullScoreResult> = {}): FullScoreResult {
  return {
    tvl: 1,
    effectiveTvl: 1,
    vol24h: 1,
    score: 1,
    hhi: 0.1,
    durability: 50,
    components: {
      tvlDepth: 10,
      volumeActivity: 10,
      poolQuality: 10,
      durability: 50,
      pairDiversity: 5,
    },
    weightedBalanceRatio: null,
    organicFrac: null,
    avgStress: null,
    lockedLiqPct: null,
    coverageClass: "primary",
    coverageConfidence: 1,
    sourceMix: { dl: { poolCount: 1, tvlUsd: 1 } },
    balanceMeasuredTvlUsd: 0,
    organicMeasuredTvlUsd: 0,
    ...overrides,
  };
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
    expect(prepared.every((statement) => statement.boundValues.length <= 84)).toBe(true);

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
    expect(JSON.parse(String(usdcPlaceholder?.[19]))).toMatchObject({
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
    expect(JSON.parse(String(row?.[19]))).toMatchObject({
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
    expect(JSON.parse(String(row?.[19]))).toMatchObject({
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

  it("keeps an already-published generation published when restaging a retry", async () => {
    const metrics = initMetrics("usdt-tether", "USDT");
    const publicationState = { value: "published" as const };
    const db = makeDb({ publicationState });

    await expect(
      persistScores(
        db,
        new Map([["usdt-tether", metrics]]),
        new Map([["usdt-tether", makeFullScoreResult()]]),
        {
          totalTvl: 1,
          totalVol24h: 1,
          totalVol7d: 1,
          poolCount: 1,
          chainCount: 1,
          protocolTvl: {},
          chainTvl: {},
        },
        1_700_000_000,
      ),
    ).resolves.toMatchObject({
      generationId: buildDexLiquidityPublicationGenerationId(1_700_000_000),
      currentGenerationRows: ACTIVE_STABLECOINS.length + 1,
    });

    expect(publicationState.value).toBe("published");
    const stageSql = db
      .getHistory()
      .find((entry) =>
        entry.sql.includes("INSERT INTO dex_liquidity_publication_generations") &&
        entry.sql.includes("ON CONFLICT(generation_id) DO UPDATE")
      )?.sql;
    expect(stageSql).toContain("dex_liquidity_publication_generations.state = 'published'");
  });

  it("skips historical snapshot writes only when active and scored identities are exact", async () => {
    const scoredIds = new Set(["usdt-tether", "usdc-circle"]);
    const result = await writeHistoricalSnapshots(
      makeDb({
        historyRows: makeHistoryIdentityRows(scoredIds),
      }),
      new Map([
        ["usdt-tether", makeFullScoreResult()],
        ["usdc-circle", makeFullScoreResult()],
      ]),
    );

    expect(result).toEqual({
      snapshotRowsWritten: 0,
      skipped: true,
      writeFailed: false,
      historyRowsPruned: 1,
      retentionPruneFailed: false,
    });
    expect(batchExecute).not.toHaveBeenCalled();
    expect(executeAtomicBatch).not.toHaveBeenCalled();
  });

  it("prunes historical snapshots beyond the public 365-day window when today's snapshot is already complete", async () => {
    const nowSec = Math.floor(Date.UTC(2026, 0, 1, 12) / 1000);
    const db = makeDb({
      historyRows: makeHistoryIdentityRows(new Set(["usdt-tether"])),
    });

    const result = await writeHistoricalSnapshots(
      db,
      new Map([["usdt-tether", makeFullScoreResult()]]),
      undefined,
      nowSec,
    );

    expect(result).toMatchObject({
      snapshotRowsWritten: 0,
      skipped: true,
      writeFailed: false,
      historyRowsPruned: 1,
      retentionPruneFailed: false,
    });
    const prune = db
      .getHistory()
      .find((entry) => entry.sql.includes("pharos:dex-liquidity:history-retention-delete"));
    expect(prune?.sql).toContain("DELETE FROM dex_liquidity_history");
    expect(prune?.binds).toEqual([nowSec - 365 * 86_400]);
  });

  it("reconciles missing historical snapshots and backfills placeholder rows", async () => {
    const nowMs = Date.UTC(2026, 0, 1, 12);
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await writeHistoricalSnapshots(
      makeDb({
        historyRows: makeHistoryIdentityRows(
          new Set(["usdt-tether"]),
          [
            "usdt-tether",
            ...ACTIVE_STABLECOINS.map((coin) => coin.id).filter((id) => id !== "usdt-tether"),
          ].slice(0, 10),
        ),
      }),
      new Map([
        ["usdt-tether", makeFullScoreResult({ tvl: 10, vol24h: 11, score: 12 })],
        ["usdc-circle", makeFullScoreResult({ tvl: 20, vol24h: 21, score: 22 })],
      ]),
    );

    expect(result).toEqual({
      snapshotRowsWritten: ACTIVE_STABLECOINS.length,
      skipped: false,
      writeFailed: false,
      historyRowsPruned: 1,
      retentionPruneFailed: false,
    });
    expect(executeAtomicBatch).toHaveBeenCalledTimes(1);
    const [, statements] = vi.mocked(executeAtomicBatch).mock.calls[0]!;
    const prepared = statements as PreparedStatementWithMeta[];
    expect(prepared.length).toBeLessThanOrEqual(100);

    const todayMidnight = Math.floor(nowMs / 86_400_000) * 86_400;
    expect(prepared[0]?.sql).toContain("pharos:dex-liquidity:history-date-replace");
    expect(prepared[0]?.boundValues).toEqual([todayMidnight]);
    const insertedRows = extractHistoryInsertRows(prepared.slice(1));
    expect(insertedRows).toHaveLength(ACTIVE_STABLECOINS.length);
    const usdtSnapshot = insertedRows.find((row) => row[0] === "usdt-tether");
    const daiPlaceholder = insertedRows.find((row) => row[0] === "dai-makerdao");

    expect(usdtSnapshot).toEqual([
      "usdt-tether",
      10,
      11,
      12,
      todayMidnight,
      "primary",
      1,
      JSON.stringify({ dl: { poolCount: 1, tvlUsd: 1 } }),
      LIQUIDITY_METHODOLOGY_VERSION,
      null,
    ]);
    expect(daiPlaceholder).toEqual([
      "dai-makerdao",
      0,
      0,
      null,
      todayMidnight,
      "unobserved",
      0,
      null,
      LIQUIDITY_METHODOLOGY_VERSION,
      null,
    ]);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("[dex-liquidity] Reconciled daily snapshot (10/1 ->"),
    );
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
    expect(warnSpy).toHaveBeenCalledWith("[dex-liquidity] Daily snapshot failed:", expect.any(Error));
  });
});

describe("dex liquidity generation prune", () => {
  it("deletes terminal and abandoned staged generations past the 3-hour horizon in bounded oldest-first batches", async () => {
    const executed: Array<{ kind: "run" | "first"; sql: string; binds: unknown[] }> = [];
    const statement = (sql: string, binds: unknown[] = []) => ({
      bind: (...nextBinds: unknown[]) => statement(sql, nextBinds),
      run: async () => {
        executed.push({ kind: "run", sql, binds });
        return { meta: { changes: 2 } };
      },
      first: async () => {
        executed.push({ kind: "first", sql, binds });
        return { oldest_remaining_at: 1_699_990_000 };
      },
    });
    const db = {
      prepare: (sql: string) => statement(sql, []),
    } as unknown as D1Database;

    const nowSec = 1_700_000_000;
    const retention = await pruneOldDexLiquidityGenerations(db, nowSec);

    expect(executed).toHaveLength(3);
    const cutoff = nowSec - 3 * 60 * 60;
    const [runRows, ledger, oldest] = executed;

    expect(runRows.sql).toContain("DELETE FROM dex_liquidity_run_rows");
    expect(runRows.sql).toContain("state IN ('staged', 'published', 'failed')");
    expect(runRows.sql).toContain("EXISTS");
    expect(runRows.sql).toContain("SELECT 1 FROM dex_liquidity_run_rows candidate_row");
    expect(runRows.sql).toContain("SELECT publication_generation_id");
    expect(runRows.sql).toContain("stablecoin_id = '__global__'");
    expect(runRows.sql).toContain("ORDER BY started_at ASC LIMIT ?");
    expect(runRows.binds).toEqual([cutoff, 16]);

    expect(ledger.sql).toContain("DELETE FROM dex_liquidity_publication_generations");
    expect(ledger.sql).toContain("state IN ('staged', 'published', 'failed')");
    expect(ledger.sql).toContain("SELECT publication_generation_id");
    expect(ledger.sql).toContain("NOT EXISTS");
    expect(ledger.sql).toContain("SELECT 1 FROM dex_liquidity_run_rows r");
    expect(ledger.sql).toContain("ORDER BY candidate.started_at ASC");
    expect(ledger.binds).toEqual([cutoff, 16]);
    expect(oldest.kind).toBe("first");
    expect(retention).toMatchObject({
      cutoff,
      deletedRunRows: 2,
      deletedGenerationRows: 2,
      deletedRows: 4,
      oldestRemainingAt: 1_699_990_000,
      error: null,
    });
  });
});
