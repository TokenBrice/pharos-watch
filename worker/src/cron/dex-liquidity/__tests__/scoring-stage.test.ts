import { afterEach, describe, expect, it, vi } from "vitest";
import { DexMeasuredExecutionTargetSchema } from "@shared/types/measured-execution";
import { createLatestSchemaSqlite } from "../../../test-helpers/latest-schema-sqlite";
import type {
  DexLiquidityPoolState,
  DexLiquidityScoringSourceState,
} from "../scoring-stage-contract";
import { initMetrics } from "../pool-helpers";
import {
  DEX_LIQUIDITY_SCORING_STAGE_MAX_CHUNK_BYTES,
  DEX_LIQUIDITY_SCORING_STAGE_PROGRESS_CHUNK_INTERVAL,
  DEX_LIQUIDITY_SCORING_STAGE_ROWS_PER_STATEMENT,
  decodeDexLiquidityScoringStageChunks,
  encodeDexLiquidityScoringStageChunks,
  loadDexLiquidityScoringStage,
  persistDexLiquidityScoringStage,
  pruneScoringStages,
  type DexLiquidityScoringStageChunk,
} from "../scoring-stage";
import type { LiquidityMetrics, PoolEntry } from "../types";

const openDatabases: ReturnType<typeof createLatestSchemaSqlite>["sqlite"][] = [];
const textEncoder = new TextEncoder();

function injectAmbiguousScoringStageCommits(db: D1Database): {
  db: D1Database;
  ambiguousChunkCommits: () => number;
  ambiguousFinalizationCommits: () => number;
  chunkRunBindings: () => unknown[][];
} {
  const underlyingByStatement = new WeakMap<object, D1PreparedStatement>();
  const bindingsByStatement = new WeakMap<object, unknown[]>();
  const chunkRunBindings: unknown[][] = [];
  let ambiguousChunkCommitCount = 0;
  let ambiguousFinalizationCommitCount = 0;

  const wrapStatement = (
    statement: D1PreparedStatement,
    sql: string,
    bindings: unknown[] = [],
  ): D1PreparedStatement => {
    const wrapped = {
      bind: (...args: unknown[]) => wrapStatement(statement.bind(...args), sql, args),
      all: <T>() => statement.all<T>(),
      first: <T>() => statement.first<T>(),
      run: async <T>() => {
        const result = await statement.run<T>();
        if (sql.includes("INSERT INTO dex_liquidity_scoring_stage_chunks")) {
          chunkRunBindings.push([...(bindingsByStatement.get(wrapped as object) ?? [])]);
          if (ambiguousChunkCommitCount === 0) {
            ambiguousChunkCommitCount++;
            throw new Error("D1 DB is overloaded after committed scoring-stage chunk write");
          }
        }
        if (
          ambiguousFinalizationCommitCount === 0
          && sql.includes("UPDATE dex_liquidity_scoring_stages")
          && sql.includes("SET state = 'ready'")
        ) {
          ambiguousFinalizationCommitCount++;
          throw new Error("D1 DB is overloaded after committed scoring-stage finalization");
        }
        return result;
      },
    } as unknown as D1PreparedStatement;
    underlyingByStatement.set(wrapped as object, statement);
    bindingsByStatement.set(wrapped as object, bindings);
    return wrapped;
  };

  const injectedDb = {
    prepare: (sql: string) => wrapStatement(db.prepare(sql), sql),
    batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
      const result = await db.batch<T>(
        statements.map((statement) => underlyingByStatement.get(statement as object) ?? statement),
      );
      return result;
    },
  } as unknown as D1Database;

  return {
    db: injectedDb,
    ambiguousChunkCommits: () => ambiguousChunkCommitCount,
    ambiguousFinalizationCommits: () => ambiguousFinalizationCommitCount,
    chunkRunBindings: () => chunkRunBindings,
  };
}

function makePool(index: number): PoolEntry {
  const source = index < 3_565
    ? "dl"
    : index < 3_565 + 1_486
      ? "direct_api"
      : "cg_onchain";
  return {
    poolId: `ethereum:0x${index.toString(16).padStart(40, "0")}`,
    project: `protocol-${index % 19}`,
    chain: index % 2 === 0 ? "Ethereum" : "Base",
    tvlUsd: 50_000 + index,
    symbol: `USD${index % 17}-PAIR${index % 23}`,
    volumeUsd1d: 5_000 + index,
    volumeUsd7d: 35_000 + index,
    poolType: index % 3 === 0 ? "stable" : "volatile",
    source,
    price: 1 + (index % 7) / 100_000,
    extra: {
      qualityAdjustedTvl: 45_000 + index,
      measuredExecutionDiagnostic: {
        adapterProfileId: "production-shape-fixture",
        targetId: `target-${index}`,
        detail: `ordered-production-shape-${index}-${"x".repeat(240)}`,
      },
    },
  };
}

function populateMetric(metric: LiquidityMetrics, pools: PoolEntry[]): LiquidityMetrics {
  const totalTvlUsd = pools.reduce((sum, pool) => sum + pool.tvlUsd, 0);
  const totalVolume24hUsd = pools.reduce((sum, pool) => sum + pool.volumeUsd1d, 0);
  return {
    ...metric,
    totalTvlUsd,
    totalVolume24hUsd,
    totalVolume7dUsd: totalVolume24hUsd * 7,
    poolCount: pools.length,
    chains: new Set(["Ethereum", "Base"]),
    pairs: new Set(["USDC", "USDT", "DAI"]),
    protocolTvl: { curve: totalTvlUsd / 2, uniswap: totalTvlUsd / 2 },
    chainTvl: { Ethereum: totalTvlUsd * 0.7, Base: totalTvlUsd * 0.3 },
    qualityAdjustedTvl: totalTvlUsd * 0.9,
    topPools: pools,
    effectiveTvl: totalTvlUsd * 0.8,
  };
}

function sourceState(): DexLiquidityScoringSourceState {
  return {
    validationReferences: {
      rates: { peggedEUR: 1.15 },
      type: "fresh",
      updatedAt: 1_000,
      updatedAtByPeg: { peggedEUR: 1_000 },
      typeByPeg: { peggedEUR: "fresh" },
    },
    stablecoinPriceById: new Map([
      ["major", 1.0001],
      ["minor", 0.9998],
    ]),
    stablecoinMcapById: new Map([
      ["major", 100_000_000_000],
      ["minor", 5_000_000],
    ]),
    protocolTvlCaps: new Map([
      ["curve", 25_000_000_000],
      ["uniswap", 15_000_000_000],
    ]),
    priceObservations: new Map([
      ["major", [{ price: 1.0001, tvl: 2_000_000, chain: "Ethereum", protocol: "curve" }]],
      ["minor", []],
    ]),
    dlYieldsAvailable: true,
    dlProtocolsAvailable: true,
    primaryRawPoolCount: 12_345,
    failedSources: [],
    criticalSourceFailures: [],
    fallbackSignals: ["fixture-fallback"],
    directApiSourceSummary: {
      circuitEvents: [],
      sourceWarnings: ["fixture warning"],
      pagination: [],
    },
  };
}

function poolState(totalPools = 7_402): DexLiquidityPoolState {
  const pools = Array.from({ length: totalPools }, (_, index) => makePool(index));
  const majorCount = Math.min(6_181, totalPools);
  const metrics = new Map<string, LiquidityMetrics>([
    ["major", populateMetric(initMetrics("major", "MAJOR"), pools.slice(0, majorCount))],
    ["minor", populateMetric(initMetrics("minor", "MINOR"), pools.slice(majorCount))],
  ]);
  return {
    fallback: {
      weakCoverageCoinsBeforeFallback: 7,
      directCexOrderbookDepth: {
        checkedSymbols: 2,
        venueCount: 3,
        observations: 4,
        maxDepthDown2PctUsdBySymbol: { USDC: 10_000_000 },
        maxDepthUp2PctUsdBySymbol: { USDC: 9_000_000 },
      },
    },
    metrics,
    poolRejections: [],
    pancakeMeasuredExecutionTargets: new Map(),
    slipstreamMeasuredExecutionTargets: new Map(),
    stagedMergedCount: 12,
    stagedSkippedCount: 3,
    stagedSkippedByExactIdentityCount: 1,
    stagedSkippedByUniqueDerivedIdentityCount: 1,
    stagedSkippedByOptionalWildcardIdentityCount: 0,
    stagedSkippedByAuthoritativeProtocolCount: 1,
    stagedSkipDimensions: [
      {
        reason: "duplicate_exact_identity",
        protocol: "curve",
        chain: "ethereum",
        count: 1,
      },
    ],
    directApiIntegration: {
      directApiDedupSkippedByAddress: 2,
      directApiDedupSkippedByDerivedIdentity: 1,
      directApiDedupSkippedByOptionalWildcardIdentity: 0,
      directApiSkippedUntracked: 4,
      directApiSkippedInvalidUnits: 0,
      directApiSkippedBelowTvlThreshold: 5,
      directApiSkippedAboveTvlSanityCap: 0,
      acceptedByProtocolChain: { "fluid:ethereum": 12 },
      excludedByReason: { "below-tvl-threshold": 5 },
    },
  };
}

function populateMeasuredTargets(state: DexLiquidityPoolState): void {
  const evmTarget = (lane: "pancake" | "slipstream", index: number) =>
    DexMeasuredExecutionTargetSchema.parse({
      schemaVersion: "dex-measured-target-v1",
      targetId: `fixture-${lane}-target`,
      stablecoinId: "major",
      adapterProfileId: `fixture-${lane}-v1`,
      protocol: lane,
      chain: "ethereum",
      poolId: `0x${index.toString(16).padStart(40, "0")}`,
      tokenIn: {
        address: "0x0000000000000000000000000000000000000001",
        symbol: "MAJOR",
        decimals: 18,
        referencePriceUsd: 1.0001,
        trackedAssetId: "major",
      },
      tokenOut: {
        address: "0x0000000000000000000000000000000000000002",
        symbol: "USDC",
        decimals: 6,
        referencePriceUsd: 1,
      },
      retainedTvlUsd: 1_000_000 + index,
      retainedPoolPriceUsd: 1.0001,
      capturedAt: 1_000,
    });

  const pancake = evmTarget("pancake", 1);
  const slipstream = evmTarget("slipstream", 3);

  state.pancakeMeasuredExecutionTargets.set(pancake.targetId, pancake);
  state.slipstreamMeasuredExecutionTargets.set(slipstream.targetId, slipstream);
}

function withPayload(payload: string): DexLiquidityScoringStageChunk {
  return {
    payload,
    payloadBytes: textEncoder.encode(payload).byteLength,
    recordCount: payload.split("\n").length,
  };
}

afterEach(() => {
  for (const sqlite of openDatabases.splice(0)) sqlite.close();
});

describe("DEX liquidity scoring stage", () => {
  it("round-trips the production-shaped 7,402-pool graph in bounded ordered chunks", () => {
    const source = sourceState();
    const pool = poolState();
    const chunks = [...encodeDexLiquidityScoringStageChunks(source, pool)];

    expect(chunks.length).toBeGreaterThan(10);
    expect(chunks.every((chunk) => chunk.payloadBytes <= DEX_LIQUIDITY_SCORING_STAGE_MAX_CHUNK_BYTES))
      .toBe(true);
    expect(chunks.every((chunk) => textEncoder.encode(chunk.payload).byteLength === chunk.payloadBytes))
      .toBe(true);

    const decoded = decodeDexLiquidityScoringStageChunks(chunks);
    expect([...decoded.sourceState.stablecoinPriceById]).toEqual([...source.stablecoinPriceById]);
    expect([...decoded.sourceState.stablecoinMcapById]).toEqual([...source.stablecoinMcapById]);
    expect([...decoded.sourceState.protocolTvlCaps]).toEqual([...source.protocolTvlCaps]);
    expect([...decoded.sourceState.priceObservations]).toEqual([...source.priceObservations]);
    expect([...decoded.poolState.metrics.keys()]).toEqual(["major", "minor"]);

    const originalMajor = pool.metrics.get("major")!;
    const decodedMajor = decoded.poolState.metrics.get("major")!;
    expect(decodedMajor.topPools).toHaveLength(6_181);
    expect(decodedMajor.topPools.every((entry, index) => entry.poolId === originalMajor.topPools[index]?.poolId))
      .toBe(true);
    expect([...decodedMajor.chains]).toEqual([...originalMajor.chains]);
    expect([...decodedMajor.pairs]).toEqual([...originalMajor.pairs]);

    const decodedPools = [...decoded.poolState.metrics.values()].flatMap((metric) => metric.topPools);
    expect(decodedPools).toHaveLength(7_402);
    expect(decodedPools.filter((entry) => entry.source === "dl")).toHaveLength(3_565);
    expect(decodedPools.filter((entry) => entry.source === "direct_api")).toHaveLength(1_486);
    expect(decodedPools.filter((entry) => entry.source === "cg_onchain")).toHaveLength(2_351);
  });

  it("preserves multibyte records across a partial encodeInto boundary and enforces exact byte caps", () => {
    const source = sourceState();
    source.stablecoinMcapById = new Map([["boundary-😀-asset", 123]]);
    const pool = poolState(3);
    const wideChunks = [
      ...encodeDexLiquidityScoringStageChunks(
        source,
        pool,
        DEX_LIQUIDITY_SCORING_STAGE_MAX_CHUNK_BYTES,
      ),
    ];
    const lines = wideChunks.flatMap((chunk) => chunk.payload.split("\n"));
    const header = lines[0]!;
    const unicodeLine = lines.find((line) => line.includes("😀"))!;
    const unicodeIndex = unicodeLine.indexOf("😀");
    const boundaryBytes =
      textEncoder.encode(header).byteLength
      + 1
      + textEncoder.encode(unicodeLine.slice(0, unicodeIndex)).byteLength
      + 1;

    expect(boundaryBytes).toBeGreaterThan(textEncoder.encode(unicodeLine).byteLength);
    const boundaryChunks = [
      ...encodeDexLiquidityScoringStageChunks(source, pool, boundaryBytes),
    ];
    expect(boundaryChunks[0]?.payload).toBe(header);
    expect(boundaryChunks.every((chunk) => chunk.payloadBytes <= boundaryBytes)).toBe(true);
    expect(
      decodeDexLiquidityScoringStageChunks(boundaryChunks).sourceState.stablecoinMcapById.get(
        "boundary-😀-asset",
      ),
    ).toBe(123);

    const maxRecordBytes = Math.max(...lines.map((line) => textEncoder.encode(line).byteLength));
    expect(() => [
      ...encodeDexLiquidityScoringStageChunks(source, pool, maxRecordBytes),
    ]).not.toThrow();
    expect(() => [
      ...encodeDexLiquidityScoringStageChunks(source, pool, maxRecordBytes - 1),
    ]).toThrow(`record exceeds ${maxRecordBytes - 1} bytes`);
  });

  it("can release the source graph incrementally while producing the same payload", () => {
    const retainedSource = sourceState();
    const retainedPool = poolState(40);
    const consumingSource = sourceState();
    const consumingPool = poolState(40);
    populateMeasuredTargets(retainedPool);
    populateMeasuredTargets(consumingPool);

    const retained = [...encodeDexLiquidityScoringStageChunks(retainedSource, retainedPool)];
    const consumed = [
      ...encodeDexLiquidityScoringStageChunks(
        consumingSource,
        consumingPool,
        DEX_LIQUIDITY_SCORING_STAGE_MAX_CHUNK_BYTES,
        true,
      ),
    ];

    expect(consumed).toEqual(retained);
    const decoded = decodeDexLiquidityScoringStageChunks(consumed);
    expect([...decoded.poolState.pancakeMeasuredExecutionTargets]).toEqual(
      [...retainedPool.pancakeMeasuredExecutionTargets],
    );
    expect([...decoded.poolState.slipstreamMeasuredExecutionTargets]).toEqual(
      [...retainedPool.slipstreamMeasuredExecutionTargets],
    );
    const records = consumed
      .flatMap((chunk) => chunk.payload.split("\n"))
      .map((line) => JSON.parse(line) as { kind: string });
    expect(records.findIndex((record) => record.kind === "target")).toBeGreaterThan(0);
    expect(records.findIndex((record) => record.kind === "target")).toBeLessThan(
      records.findIndex((record) => record.kind === "metric"),
    );
    expect(consumingSource.stablecoinPriceById.size).toBe(0);
    expect(consumingSource.stablecoinMcapById.size).toBe(0);
    expect(consumingSource.protocolTvlCaps.size).toBe(0);
    expect(consumingSource.priceObservations.size).toBe(0);
    expect(consumingPool.metrics.size).toBe(0);
    expect(consumingPool.pancakeMeasuredExecutionTargets.size).toBe(0);
    expect(consumingPool.slipstreamMeasuredExecutionTargets.size).toBe(0);
  });

  it("persists bounded single-row chunks and loads the newest ready generation at or before the preferred slot", async () => {
    const harness = createLatestSchemaSqlite();
    openDatabases.push(harness.sqlite);
    const previousSource = sourceState();
    const previousPool = poolState(40);
    const source = sourceState();
    const pool = poolState(40);
    const expectedMajorPoolIds = pool.metrics.get("major")?.topPools.map((entry) => entry.poolId);
    const sourceSlotStartedAt = 10_000;
    const previousSlotStartedAt = sourceSlotStartedAt - 30 * 60;
    const onChunkBatchPersisted = vi.fn(async (_progress: {
      chunkCount: number;
      recordCount: number;
      payloadBytes: number;
    }) => {});

    const previous = await persistDexLiquidityScoringStage(harness.db, {
      sourceSlotStartedAt: previousSlotStartedAt,
      syncStartSec: previousSlotStartedAt + 10,
      sourceState: previousSource,
      poolState: previousPool,
    });
    const stored = await persistDexLiquidityScoringStage(harness.db, {
      sourceSlotStartedAt,
      syncStartSec: sourceSlotStartedAt + 10,
      sourceState: source,
      poolState: pool,
      onChunkBatchPersisted,
    });
    expect(stored.chunkCount).toBeGreaterThan(0);
    expect(onChunkBatchPersisted).toHaveBeenLastCalledWith({
      chunkCount: stored.chunkCount,
      recordCount: stored.recordCount,
      payloadBytes: stored.payloadBytes,
    });
    expect(DEX_LIQUIDITY_SCORING_STAGE_ROWS_PER_STATEMENT).toBe(1);
    expect(DEX_LIQUIDITY_SCORING_STAGE_PROGRESS_CHUNK_INTERVAL).toBe(24);
    expect(onChunkBatchPersisted).toHaveBeenCalledTimes(
      Math.ceil(stored.chunkCount / DEX_LIQUIDITY_SCORING_STAGE_PROGRESS_CHUNK_INTERVAL),
    );
    expect(onChunkBatchPersisted.mock.calls[0]?.[0]).toMatchObject({
      chunkCount: Math.min(
        stored.chunkCount,
        DEX_LIQUIDITY_SCORING_STAGE_PROGRESS_CHUNK_INTERVAL,
      ),
    });

    const loaded = await loadDexLiquidityScoringStage(harness.db, {
      nowSec: sourceSlotStartedAt + 6 * 60,
      expectedSourceSlotStartedAt: sourceSlotStartedAt,
    });
    expect(loaded.generationId).toBe(stored.generationId);
    expect(loaded.syncStartSec).toBe(sourceSlotStartedAt + 10);
    expect(loaded.poolState.metrics.get("major")?.topPools.map((entry) => entry.poolId)).toEqual(
      expectedMajorPoolIds,
    );

    harness.sqlite.prepare(
      `UPDATE dex_liquidity_scoring_stages
          SET state = 'consumed'
        WHERE generation_id = ?`,
    ).run(stored.generationId);
    const retried = await loadDexLiquidityScoringStage(harness.db, {
      nowSec: sourceSlotStartedAt + 6 * 60,
      expectedSourceSlotStartedAt: sourceSlotStartedAt,
    });
    expect(retried.generationId).toBe(stored.generationId);
    expect(retried.sourceSlotStartedAt).toBe(sourceSlotStartedAt);

    await expect(loadDexLiquidityScoringStage(harness.db, {
      nowSec: sourceSlotStartedAt + 56 * 60,
      expectedSourceSlotStartedAt: sourceSlotStartedAt,
    })).rejects.toThrow("stale");

    harness.sqlite.prepare(
      `UPDATE dex_liquidity_scoring_stages
          SET state = 'writing'
        WHERE generation_id = ?`,
    ).run(stored.generationId);
    const fallback = await loadDexLiquidityScoringStage(harness.db, {
      nowSec: sourceSlotStartedAt + 6 * 60,
      expectedSourceSlotStartedAt: sourceSlotStartedAt,
    });
    expect(fallback.generationId).toBe(previous.generationId);
    expect(fallback.sourceSlotStartedAt).toBe(previousSlotStartedAt);
  });

  it("recovers exact chunks and finalization after ambiguous committed D1 responses", async () => {
    const harness = createLatestSchemaSqlite();
    openDatabases.push(harness.sqlite);
    const injected = injectAmbiguousScoringStageCommits(harness.db);
    const sourceSlotStartedAt = 15_000;

    const stored = await persistDexLiquidityScoringStage(injected.db, {
      sourceSlotStartedAt,
      syncStartSec: sourceSlotStartedAt + 10,
      sourceState: sourceState(),
      poolState: poolState(40),
    });
    const loaded = await loadDexLiquidityScoringStage(injected.db, {
      nowSec: sourceSlotStartedAt + 6 * 60,
      expectedSourceSlotStartedAt: sourceSlotStartedAt,
    });

    expect(injected.ambiguousChunkCommits()).toBe(1);
    expect(injected.ambiguousFinalizationCommits()).toBe(1);
    expect(injected.chunkRunBindings()).toHaveLength(stored.chunkCount + 1);
    expect(injected.chunkRunBindings().every((bindings) =>
      bindings.length === 6
      && typeof bindings[2] === "string"
      && textEncoder.encode(bindings[2] as string).byteLength <= DEX_LIQUIDITY_SCORING_STAGE_MAX_CHUNK_BYTES
    )).toBe(true);
    expect(new Set(
      injected.chunkRunBindings().map((bindings) => `${String(bindings[0])}:${String(bindings[1])}`),
    ).size).toBe(stored.chunkCount);
    expect(loaded.generationId).toBe(stored.generationId);
    expect(loaded.poolState.metrics.get("major")?.topPools).toHaveLength(40);
    expect(harness.sqlite.prepare(
      `SELECT state, expected_chunk_count, written_chunk_count
         FROM dex_liquidity_scoring_stages
        WHERE generation_id = ?`,
    ).get(stored.generationId)).toEqual({
      state: "ready",
      expected_chunk_count: stored.chunkCount,
      written_chunk_count: stored.chunkCount,
    });
  });

  it("rejects missing chunks, unknown records and lanes, and non-finite values", async () => {
    const harness = createLatestSchemaSqlite();
    openDatabases.push(harness.sqlite);
    const source = sourceState();
    const pool = poolState(20);
    const stored = await persistDexLiquidityScoringStage(harness.db, {
      sourceSlotStartedAt: 20_000,
      syncStartSec: 20_010,
      sourceState: source,
      poolState: pool,
    });
    harness.sqlite.prepare(
      `DELETE FROM dex_liquidity_scoring_stage_chunks
        WHERE generation_id = ?
          AND chunk_index = 0`,
    ).run(stored.generationId);
    await expect(loadDexLiquidityScoringStage(harness.db, {
      nowSec: 20_360,
      expectedSourceSlotStartedAt: 20_000,
    })).rejects.toThrow("missing chunk");

    const base = [...encodeDexLiquidityScoringStageChunks(sourceState(), poolState(0))];
    expect(base).toHaveLength(1);
    expect(() =>
      decodeDexLiquidityScoringStageChunks([
        withPayload(`${base[0]!.payload}\n${JSON.stringify({ kind: "garbage" })}`),
      ])
    ).toThrow("unknown record kind");
    expect(() =>
      decodeDexLiquidityScoringStageChunks([
        withPayload(
          `${base[0]!.payload}\n${JSON.stringify({
            kind: "target",
            lane: "bogus",
            key: "bad",
            target: { bad: true },
          })}`,
        ),
      ])
    ).toThrow("unknown target lane");

    const invalidPool = poolState(1);
    invalidPool.metrics.get("major")!.totalTvlUsd = Number.NaN;
    expect(() => [...encodeDexLiquidityScoringStageChunks(sourceState(), invalidPool)])
      .toThrow("non-finite");
  });

  it("deletes consumed stages on the next bounded pass and abandons only rows older than two hours", async () => {
    const harness = createLatestSchemaSqlite();
    openDatabases.push(harness.sqlite);
    const nowSec = 100_000;
    const cutoff = nowSec - 2 * 60 * 60;
    const insertStage = harness.sqlite.prepare(
      `INSERT INTO dex_liquidity_scoring_stages (
         generation_id, schema_version, state, source_slot_started_at,
         sync_started_at, created_at, expected_chunk_count, written_chunk_count,
         expected_record_count, payload_bytes
       ) VALUES (?, 1, ?, ?, ?, ?, 1, 1, 1, 2)`,
    );
    const insertChunk = harness.sqlite.prepare(
      `INSERT INTO dex_liquidity_scoring_stage_chunks (
         generation_id, chunk_index, payload_json, payload_bytes, record_count, created_at
       ) VALUES (?, 0, '{}', 2, 1, ?)`,
    );
    const seed = (generationId: string, state: string, createdAt: number, slot: number) => {
      insertStage.run(generationId, state, slot, slot, createdAt);
      insertChunk.run(generationId, createdAt);
    };
    seed("consumed-a", "consumed", cutoff + 100, 1);
    seed("consumed-b", "consumed", cutoff + 101, 2);
    seed("consumed-c", "consumed", cutoff + 102, 3);
    seed("ready-old", "ready", cutoff - 1, 4);
    seed("failed-old", "failed", cutoff - 2, 5);
    seed("ready-boundary", "ready", cutoff, 6);
    seed("writing-recent", "writing", nowSec - 60, 7);
    seed("current-ready", "ready", cutoff - 100, 8);

    const first = await pruneScoringStages(harness.db, "current-ready", nowSec);
    const second = await pruneScoringStages(harness.db, "current-ready", nowSec);
    const third = await pruneScoringStages(harness.db, "current-ready", nowSec);

    expect(first).toMatchObject({
      cutoff,
      deletedChunkRows: 2,
      deletedStageRows: 2,
      deletedRows: 4,
      error: null,
    });
    expect(second.deletedStageRows).toBe(2);
    expect(third.deletedStageRows).toBe(1);
    expect(
      harness.sqlite
        .prepare("SELECT generation_id FROM dex_liquidity_scoring_stages ORDER BY generation_id")
        .all()
        .map((row) => row.generation_id),
    ).toEqual(["current-ready", "ready-boundary", "writing-recent"]);
  });

  it("reports scoring-stage cleanup errors without throwing", async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error("scoring-stage retention unavailable");
          },
        }),
      }),
    } as unknown as D1Database;

    const retention = await pruneScoringStages(db, "current-ready", 100_000);

    expect(retention.deletedRows).toBe(0);
    expect(retention.error).toBe("scoring-stage retention unavailable");
  });
});
