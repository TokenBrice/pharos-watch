import {
  DexMeasuredExecutionTargetSchema,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import { isRecord } from "@shared/lib/type-guards";
import { executeAtomicBatch } from "../../lib/db";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { rethrowIfAborted, sleepWithSignal, throwIfAborted } from "../../lib/abort";
import { toErrorMessage } from "@shared/lib/error-utils";
import { parseJson } from "../../lib/json-parse";
import type {
  DexLiquidityPoolState,
  DexLiquidityScoringSourceState,
} from "./scoring-stage-contract";
import type { DexPriceObs, LiquidityMetrics, PoolEntry } from "./types";

const DEX_LIQUIDITY_SCORING_STAGE_SCHEMA_VERSION = 1;
export const DEX_LIQUIDITY_SCORING_STAGE_MAX_CHUNK_BYTES = 192 * 1024;
/** @internal Exported for focused scoring-stage tests. */
export const DEX_LIQUIDITY_SCORING_STAGE_ROWS_PER_STATEMENT = 1;
export const DEX_LIQUIDITY_SCORING_STAGE_PROGRESS_CHUNK_INTERVAL = 24;
const DEX_LIQUIDITY_SCORING_STAGE_READ_PAGE_SIZE = 4;
const DEX_LIQUIDITY_SCORING_STAGE_MAX_AGE_SEC = 55 * 60;
const DEX_LIQUIDITY_SCORING_STAGE_FUTURE_TOLERANCE_SEC = 2 * 60;
const DEX_LIQUIDITY_SCORING_STAGE_FAILED_RETENTION_SEC = 2 * 3600;
const DEX_LIQUIDITY_SCORING_STAGE_RETENTION_GENERATIONS_PER_RUN = 2;
const DEX_LIQUIDITY_SCORING_STAGE_READY_POLL_MS = 5_000;

type SourceHeader = Omit<
  DexLiquidityScoringSourceState,
  "stablecoinPriceById" | "stablecoinMcapById" | "protocolTvlCaps" | "priceObservations"
>;

type EncodedSourceHeader = SourceHeader & {
  /** Additive schema-v1 field; old consumers ignore it and reload the cache. */
  stablecoinPrices?: Array<[stablecoinId: string, price: number]>;
};

type PoolHeader = Omit<
  DexLiquidityPoolState,
  | "metrics"
  | "pancakeMeasuredExecutionTargets"
  | "slipstreamMeasuredExecutionTargets"
>;

type MetricHeader = Omit<LiquidityMetrics, "chains" | "pairs" | "topPools"> & {
  chains: string[];
  pairs: string[];
};

type TargetLane = "pancake" | "slipstream";
type ScoringStageChunkInsertRow = [
  generationId: string,
  chunkIndex: number,
  payload: string,
  payloadBytes: number,
  recordCount: number,
  createdAt: number,
];

type ScoringStageRecord =
  | {
      kind: "header";
      schemaVersion: typeof DEX_LIQUIDITY_SCORING_STAGE_SCHEMA_VERSION;
      source: EncodedSourceHeader;
      pool: PoolHeader;
    }
  | { kind: "source-number"; map: "stablecoinMcapById" | "protocolTvlCaps"; key: string; value: number }
  | { kind: "price-observation-set"; stablecoinId: string }
  | { kind: "price-observation"; stablecoinId: string; observation: DexPriceObs }
  | { kind: "metric"; stablecoinId: string; metric: MetricHeader }
  | { kind: "pool"; stablecoinId: string; pool: PoolEntry }
  | {
      kind: "target";
      lane: TargetLane;
      key: string;
      target: DexMeasuredExecutionTarget;
    };

export interface DexLiquidityScoringStageInput {
  sourceSlotStartedAt: number;
  syncStartSec: number;
  sourceState: DexLiquidityScoringSourceState;
  poolState: DexLiquidityPoolState;
  onChunkBatchPersisted?: (progress: {
    chunkCount: number;
    recordCount: number;
    payloadBytes: number;
  }) => Promise<void>;
}

export interface DexLiquidityScoringStageChunk {
  payload: string;
  payloadBytes: number;
  recordCount: number;
}

export interface PersistedDexLiquidityScoringStage {
  generationId: string;
  sourceSlotStartedAt: number;
  chunkCount: number;
  recordCount: number;
  payloadBytes: number;
  retention: DexLiquidityScoringStageRetentionResult;
}

export interface DexLiquidityScoringStageRetentionResult {
  cutoff: number;
  deletedRows: number;
  deletedChunkRows: number;
  deletedStageRows: number;
  oldestRemainingAt: number | null;
  durationMs: number;
  error: string | null;
}

function prepareScoringStageChunkUpsert(
  db: D1Database,
  row: ScoringStageChunkInsertRow,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO dex_liquidity_scoring_stage_chunks (
       generation_id, chunk_index, payload_json, payload_bytes, record_count, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(generation_id, chunk_index) DO UPDATE SET
       payload_json = excluded.payload_json,
       payload_bytes = excluded.payload_bytes,
       record_count = excluded.record_count,
       created_at = excluded.created_at`,
  ).bind(...row);
}

export interface LoadedDexLiquidityScoringStage {
  generationId: string;
  sourceSlotStartedAt: number;
  syncStartSec: number;
  sourceState: DexLiquidityScoringSourceState;
  poolState: DexLiquidityPoolState;
}

interface StageManifestRow {
  generation_id: string;
  schema_version: number;
  state: string;
  source_slot_started_at: number;
  sync_started_at: number;
  created_at: number;
  ready_at: number | null;
  expected_chunk_count: number;
  written_chunk_count: number;
  expected_record_count: number;
  payload_bytes: number;
}

interface StageChunkRow {
  chunk_index: number;
  payload_json: string;
  payload_bytes: number;
  record_count: number;
}

interface ScoringStageDecoder {
  sourceHeader: EncodedSourceHeader | null;
  poolHeader: PoolHeader | null;
  stablecoinMcapById: Map<string, number>;
  protocolTvlCaps: Map<string, number>;
  priceObservations: Map<string, DexPriceObs[]>;
  metrics: Map<string, LiquidityMetrics>;
  pancakeMeasuredExecutionTargets: Map<string, DexMeasuredExecutionTarget>;
  slipstreamMeasuredExecutionTargets: Map<string, DexMeasuredExecutionTarget>;
  recordCount: number;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

function stringifyScoringStageRecord(record: ScoringStageRecord): string {
  return JSON.stringify(record, (_key, value: unknown) => {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`DEX liquidity scoring stage cannot encode non-finite number in ${record.kind} record`);
    }
    if (typeof value === "bigint") {
      throw new Error(`DEX liquidity scoring stage cannot encode bigint in ${record.kind} record`);
    }
    return value;
  });
}

function stageGenerationId(sourceSlotStartedAt: number): string {
  return `dex-liquidity-scoring-stage:${sourceSlotStartedAt}`;
}

function assertTimestamp(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`DEX liquidity scoring stage requires a non-negative integer ${name}`);
  }
}

function assertUniqueMapKey<T>(map: Map<string, T>, key: string, label: string): void {
  if (map.has(key)) {
    throw new Error(`DEX liquidity scoring stage contains duplicate ${label} key "${key}"`);
  }
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`DEX liquidity scoring stage contains invalid ${label}`);
  }
  return value;
}

function buildPoolHeader(poolState: DexLiquidityPoolState): PoolHeader {
  const {
    metrics: _metrics,
    pancakeMeasuredExecutionTargets: _pancakeMeasuredExecutionTargets,
    slipstreamMeasuredExecutionTargets: _slipstreamMeasuredExecutionTargets,
    ...pool
  } = poolState;
  return pool;
}

function* iterateScoringStageRecords(
  sourceState: DexLiquidityScoringSourceState,
  poolState: DexLiquidityPoolState,
  consumeInput: boolean,
): Generator<ScoringStageRecord> {
  let stablecoinPriceById: Map<string, number> | null = sourceState.stablecoinPriceById;
  let stablecoinMcapById: Map<string, number> | null = sourceState.stablecoinMcapById;
  let protocolTvlCaps: Map<string, number> | null = sourceState.protocolTvlCaps;
  let priceObservations: Map<string, DexPriceObs[]> | null = sourceState.priceObservations;
  const source: SourceHeader = {
    validationReferences: sourceState.validationReferences,
    dlYieldsAvailable: sourceState.dlYieldsAvailable,
    dlProtocolsAvailable: sourceState.dlProtocolsAvailable,
    primaryRawPoolCount: sourceState.primaryRawPoolCount,
    failedSources: sourceState.failedSources,
    criticalSourceFailures: sourceState.criticalSourceFailures,
    fallbackSignals: sourceState.fallbackSignals,
    directApiSourceSummary: sourceState.directApiSourceSummary,
  };
  let metrics: Map<string, LiquidityMetrics> | null = poolState.metrics;
  let pancakeMeasuredExecutionTargets: Map<string, DexMeasuredExecutionTarget> | null =
    poolState.pancakeMeasuredExecutionTargets;
  let slipstreamMeasuredExecutionTargets: Map<string, DexMeasuredExecutionTarget> | null =
    poolState.slipstreamMeasuredExecutionTargets;
  const pool = buildPoolHeader(poolState);

  yield {
    kind: "header",
    schemaVersion: DEX_LIQUIDITY_SCORING_STAGE_SCHEMA_VERSION,
    source: {
      ...source,
      stablecoinPrices: [...stablecoinPriceById],
    },
    pool,
  };
  if (consumeInput) {
    stablecoinPriceById.clear();
    sourceState.stablecoinPriceById = new Map();
    stablecoinPriceById = null;
  }
  for (const [key, value] of stablecoinMcapById) {
    yield { kind: "source-number", map: "stablecoinMcapById", key, value };
    if (consumeInput) stablecoinMcapById.delete(key);
  }
  if (consumeInput) {
    stablecoinMcapById.clear();
    sourceState.stablecoinMcapById = new Map();
    stablecoinMcapById = null;
  }
  for (const [key, value] of protocolTvlCaps) {
    yield { kind: "source-number", map: "protocolTvlCaps", key, value };
    if (consumeInput) protocolTvlCaps.delete(key);
  }
  if (consumeInput) {
    protocolTvlCaps.clear();
    sourceState.protocolTvlCaps = new Map();
    protocolTvlCaps = null;
  }
  for (const [stablecoinId, observations] of priceObservations) {
    yield { kind: "price-observation-set", stablecoinId };
    for (let index = 0; index < observations.length; index++) {
      const observation = observations[index]!;
      yield { kind: "price-observation", stablecoinId, observation };
      if (consumeInput) observations[index] = undefined as unknown as DexPriceObs;
    }
    if (consumeInput) {
      observations.length = 0;
      priceObservations.delete(stablecoinId);
    }
  }
  if (consumeInput) {
    priceObservations.clear();
    sourceState.priceObservations = new Map();
    priceObservations = null;
  }

  // Targets are independent of metric/pool decoding. Consume their proof-heavy
  // producer maps before the much larger retained-pool graph.
  for (const [key, target] of pancakeMeasuredExecutionTargets) {
    yield { kind: "target", lane: "pancake", key, target };
    if (consumeInput) pancakeMeasuredExecutionTargets.delete(key);
  }
  if (consumeInput) {
    pancakeMeasuredExecutionTargets.clear();
    poolState.pancakeMeasuredExecutionTargets = new Map();
    pancakeMeasuredExecutionTargets = null;
  }
  for (const [key, target] of slipstreamMeasuredExecutionTargets) {
    yield { kind: "target", lane: "slipstream", key, target };
    if (consumeInput) slipstreamMeasuredExecutionTargets.delete(key);
  }
  if (consumeInput) {
    slipstreamMeasuredExecutionTargets.clear();
    poolState.slipstreamMeasuredExecutionTargets = new Map();
    slipstreamMeasuredExecutionTargets = null;
  }

  for (const [stablecoinId, metric] of metrics) {
    const { chains, pairs, topPools, ...scalarMetric } = metric;
    yield {
      kind: "metric",
      stablecoinId,
      metric: {
        ...scalarMetric,
        chains: [...chains],
        pairs: [...pairs],
      },
    };
    for (let index = 0; index < topPools.length; index++) {
      const poolEntry = topPools[index]!;
      yield { kind: "pool", stablecoinId, pool: poolEntry };
      if (consumeInput) topPools[index] = undefined as unknown as PoolEntry;
    }
    if (consumeInput) {
      topPools.length = 0;
      chains.clear();
      pairs.clear();
      metrics.delete(stablecoinId);
    }
  }
  if (consumeInput) {
    metrics.clear();
    poolState.metrics = new Map();
    metrics = null;
  }
}

export function* encodeDexLiquidityScoringStageChunks(
  sourceState: DexLiquidityScoringSourceState,
  poolState: DexLiquidityPoolState,
  maxChunkBytes = DEX_LIQUIDITY_SCORING_STAGE_MAX_CHUNK_BYTES,
  consumeInput = false,
): Generator<DexLiquidityScoringStageChunk> {
  if (!Number.isInteger(maxChunkBytes) || maxChunkBytes <= 0) {
    throw new RangeError("DEX liquidity scoring stage chunk size must be a positive integer");
  }

  const buffer = new Uint8Array(maxChunkBytes);
  let payloadBytes = 0;
  let recordCount = 0;
  for (const record of iterateScoringStageRecords(sourceState, poolState, consumeInput)) {
    const line = stringifyScoringStageRecord(record);
    const separatorBytes = recordCount === 0 ? 0 : 1;
    const encoded = textEncoder.encodeInto(
      line,
      buffer.subarray(payloadBytes + separatorBytes),
    );
    if (encoded.read !== line.length) {
      if (recordCount === 0) {
        const lineBytes = textEncoder.encode(line).byteLength;
        throw new Error(
          `DEX liquidity scoring stage record exceeds ${maxChunkBytes} bytes (${lineBytes} bytes, kind=${record.kind})`,
        );
      }
      const completedPayloadBytes = payloadBytes;
      const completedRecordCount = recordCount;
      payloadBytes = 0;
      recordCount = 0;
      yield {
        payload: textDecoder.decode(buffer.subarray(0, completedPayloadBytes)),
        payloadBytes: completedPayloadBytes,
        recordCount: completedRecordCount,
      };
      const retried = textEncoder.encodeInto(line, buffer);
      if (retried.read !== line.length) {
        const lineBytes = textEncoder.encode(line).byteLength;
        throw new Error(
          `DEX liquidity scoring stage record exceeds ${maxChunkBytes} bytes (${lineBytes} bytes, kind=${record.kind})`,
        );
      }
      payloadBytes = retried.written;
      recordCount = 1;
      continue;
    }
    if (separatorBytes === 1) buffer[payloadBytes] = 0x0a;
    payloadBytes += separatorBytes + encoded.written;
    recordCount++;
  }

  if (recordCount > 0) {
    const completedPayloadBytes = payloadBytes;
    const completedRecordCount = recordCount;
    payloadBytes = 0;
    recordCount = 0;
    yield {
      payload: textDecoder.decode(buffer.subarray(0, completedPayloadBytes)),
      payloadBytes: completedPayloadBytes,
      recordCount: completedRecordCount,
    };
  }
}

function createScoringStageDecoder(): ScoringStageDecoder {
  return {
    sourceHeader: null,
    poolHeader: null,
    stablecoinMcapById: new Map(),
    protocolTvlCaps: new Map(),
    priceObservations: new Map(),
    metrics: new Map(),
    pancakeMeasuredExecutionTargets: new Map(),
    slipstreamMeasuredExecutionTargets: new Map(),
    recordCount: 0,
  };
}

function decodeScoringStageRecord(decoder: ScoringStageDecoder, record: ScoringStageRecord): void {
  decoder.recordCount++;
  switch (record.kind) {
    case "header":
      if (decoder.sourceHeader || decoder.poolHeader) {
        throw new Error("DEX liquidity scoring stage contains duplicate header records");
      }
      if (record.schemaVersion !== DEX_LIQUIDITY_SCORING_STAGE_SCHEMA_VERSION) {
        throw new Error(`Unsupported DEX liquidity scoring stage schema version ${record.schemaVersion}`);
      }
      if (!isRecord(record.source) || !isRecord(record.pool)) {
        throw new Error("DEX liquidity scoring stage contains an invalid header");
      }
      decoder.sourceHeader = record.source;
      decoder.poolHeader = record.pool;
      return;
    case "source-number": {
      const target = record.map === "stablecoinMcapById"
        ? decoder.stablecoinMcapById
        : decoder.protocolTvlCaps;
      assertUniqueMapKey(target, record.key, record.map);
      if (!Number.isFinite(record.value)) {
        throw new Error(`DEX liquidity scoring stage contains non-finite ${record.map} value`);
      }
      target.set(record.key, record.value);
      return;
    }
    case "price-observation-set":
      if (typeof record.stablecoinId !== "string" || record.stablecoinId.length === 0) {
        throw new Error("DEX liquidity scoring stage contains an invalid price-observation key");
      }
      assertUniqueMapKey(decoder.priceObservations, record.stablecoinId, "price-observation");
      decoder.priceObservations.set(record.stablecoinId, []);
      return;
    case "price-observation": {
      if (
        typeof record.stablecoinId !== "string" ||
        !isRecord(record.observation) ||
        typeof record.observation.chain !== "string" ||
        typeof record.observation.protocol !== "string"
      ) {
        throw new Error("DEX liquidity scoring stage contains an invalid price observation");
      }
      requireFiniteNumber(record.observation.price, "price observation price");
      requireFiniteNumber(record.observation.tvl, "price observation TVL");
      const observations = decoder.priceObservations.get(record.stablecoinId);
      if (!observations) {
        throw new Error(
          `DEX liquidity scoring stage observation precedes missing key "${record.stablecoinId}"`,
        );
      }
      observations.push(record.observation);
      return;
    }
    case "metric": {
      if (
        typeof record.stablecoinId !== "string" ||
        !isRecord(record.metric) ||
        record.metric.stablecoinId !== record.stablecoinId ||
        !Array.isArray(record.metric.chains) ||
        !record.metric.chains.every((chain) => typeof chain === "string") ||
        !Array.isArray(record.metric.pairs) ||
        !record.metric.pairs.every((pair) => typeof pair === "string")
      ) {
        throw new Error("DEX liquidity scoring stage contains an invalid metric");
      }
      requireFiniteNumber(record.metric.totalTvlUsd, "metric TVL");
      requireFiniteNumber(record.metric.totalVolume24hUsd, "metric 24h volume");
      assertUniqueMapKey(decoder.metrics, record.stablecoinId, "metric");
      decoder.metrics.set(record.stablecoinId, {
        ...record.metric,
        chains: new Set(record.metric.chains),
        pairs: new Set(record.metric.pairs),
        topPools: [],
      });
      return;
    }
    case "pool": {
      if (
        typeof record.stablecoinId !== "string" ||
        !isRecord(record.pool) ||
        typeof record.pool.poolId !== "string" ||
        typeof record.pool.project !== "string" ||
        typeof record.pool.chain !== "string"
      ) {
        throw new Error("DEX liquidity scoring stage contains an invalid pool");
      }
      requireFiniteNumber(record.pool.tvlUsd, "pool TVL");
      requireFiniteNumber(record.pool.volumeUsd1d, "pool 24h volume");
      const metric = decoder.metrics.get(record.stablecoinId);
      if (!metric) {
        throw new Error(
          `DEX liquidity scoring stage pool precedes missing metric "${record.stablecoinId}"`,
        );
      }
      metric.topPools.push(record.pool);
      return;
    }
    case "target": {
      if (record.lane === "pancake") {
        assertUniqueMapKey(decoder.pancakeMeasuredExecutionTargets, record.key, "pancake target");
        decoder.pancakeMeasuredExecutionTargets.set(
          record.key,
          DexMeasuredExecutionTargetSchema.parse(record.target),
        );
      } else if (record.lane === "slipstream") {
        assertUniqueMapKey(decoder.slipstreamMeasuredExecutionTargets, record.key, "slipstream target");
        decoder.slipstreamMeasuredExecutionTargets.set(
          record.key,
          DexMeasuredExecutionTargetSchema.parse(record.target),
        );
      } else {
        throw new Error(`DEX liquidity scoring stage contains unknown target lane "${String(record.lane)}"`);
      }
      return;
    }
    default:
      throw new Error(
        `DEX liquidity scoring stage contains unknown record kind "${String((record as { kind?: unknown }).kind)}"`,
      );
  }
}

function decodeScoringStagePayload(decoder: ScoringStageDecoder, payload: string): void {
  if (payload.length === 0 || payload.endsWith("\n")) {
    throw new Error("DEX liquidity scoring stage contains an empty record");
  }
  let start = 0;
  while (start < payload.length) {
    const separator = payload.indexOf("\n", start);
    const end = separator === -1 ? payload.length : separator;
    const line = payload.slice(start, end);
    if (line.length === 0) {
      throw new Error("DEX liquidity scoring stage contains an empty record");
    }
    const result = parseJson(line, {
      context: "dex-liquidity scoring stage record",
      onFailure: () => {},
    });
    if (!result.ok) {
      throw new Error(
        `DEX liquidity scoring stage contains malformed JSON: ${result.message}`,
      );
    }
    const parsed = result.value as ScoringStageRecord;
    if (!parsed || typeof parsed !== "object" || typeof parsed.kind !== "string") {
      throw new Error("DEX liquidity scoring stage contains an invalid record");
    }
    decodeScoringStageRecord(decoder, parsed);
    if (separator === -1) break;
    start = end + 1;
  }
}

function getBoundedUtf8ByteLength(
  value: string,
  buffer: Uint8Array,
): number | null {
  const encoded = textEncoder.encodeInto(value, buffer);
  return encoded.read === value.length ? encoded.written : null;
}

function finishScoringStageDecode(decoder: ScoringStageDecoder): {
  sourceState: DexLiquidityScoringSourceState;
  poolState: DexLiquidityPoolState;
  recordCount: number;
} {
  if (!decoder.sourceHeader || !decoder.poolHeader) {
    throw new Error("DEX liquidity scoring stage is missing its header record");
  }
  const { stablecoinPrices = [], ...sourceHeader } = decoder.sourceHeader;
  const stablecoinPriceById = new Map<string, number>();
  for (const entry of stablecoinPrices) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      entry[0].length === 0
    ) {
      throw new Error("DEX liquidity scoring stage contains an invalid stablecoin price entry");
    }
    const price = requireFiniteNumber(entry[1], "stablecoin price");
    assertUniqueMapKey(stablecoinPriceById, entry[0], "stablecoin price");
    stablecoinPriceById.set(entry[0], price);
  }
  return {
    sourceState: {
      ...sourceHeader,
      stablecoinPriceById,
      stablecoinMcapById: decoder.stablecoinMcapById,
      protocolTvlCaps: decoder.protocolTvlCaps,
      priceObservations: decoder.priceObservations,
    },
    poolState: {
      ...decoder.poolHeader,
      poolRejections: decoder.poolHeader.poolRejections ?? [],
      metrics: decoder.metrics,
      pancakeMeasuredExecutionTargets: decoder.pancakeMeasuredExecutionTargets,
      slipstreamMeasuredExecutionTargets: decoder.slipstreamMeasuredExecutionTargets,
    },
    recordCount: decoder.recordCount,
  };
}

/** @internal Exported for focused scoring-stage tests. */
export function decodeDexLiquidityScoringStageChunks(
  chunks: readonly DexLiquidityScoringStageChunk[],
): {
  sourceState: DexLiquidityScoringSourceState;
  poolState: DexLiquidityPoolState;
  recordCount: number;
} {
  const decoder = createScoringStageDecoder();
  const byteBuffer = new Uint8Array(DEX_LIQUIDITY_SCORING_STAGE_MAX_CHUNK_BYTES);
  for (const chunk of chunks) {
    const actualBytes = getBoundedUtf8ByteLength(chunk.payload, byteBuffer);
    if (actualBytes == null || actualBytes !== chunk.payloadBytes) {
      throw new Error("DEX liquidity scoring stage chunk byte count mismatch");
    }
    const before = decoder.recordCount;
    decodeScoringStagePayload(decoder, chunk.payload);
    if (decoder.recordCount - before !== chunk.recordCount) {
      throw new Error("DEX liquidity scoring stage chunk record count mismatch");
    }
  }
  return finishScoringStageDecode(decoder);
}

async function markStageFailed(
  db: D1Database,
  generationId: string,
  error: unknown,
): Promise<void> {
  const failureReason = toErrorMessage(error);
  try {
    await db
      .prepare(
        `UPDATE dex_liquidity_scoring_stages
            SET state = 'failed',
                failure_reason = ?
          WHERE generation_id = ?
            AND state = 'writing'`,
      )
      .bind(failureReason.slice(0, 500), generationId)
      .run();
  } catch {
    // A hard Worker termination or a rollout against an unmigrated local
    // database leaves the generation in writing state, which consumers reject.
  }
}

async function hasExactFinalizedStageManifest(
  db: D1Database,
  input: {
    generationId: string;
    sourceSlotStartedAt: number;
    syncStartSec: number;
    chunkCount: number;
    recordCount: number;
    payloadBytes: number;
  },
  signal?: AbortSignal,
): Promise<boolean> {
  const row = await runWithOverloadRetry(
    () =>
      db.prepare(
        `SELECT schema_version, state, source_slot_started_at, sync_started_at,
                expected_chunk_count, written_chunk_count,
                expected_record_count, payload_bytes
           FROM dex_liquidity_scoring_stages
          WHERE generation_id = ?
          LIMIT 1`,
      ).bind(input.generationId).first<{
        schema_version: number;
        state: string;
        source_slot_started_at: number;
        sync_started_at: number;
        expected_chunk_count: number;
        written_chunk_count: number;
        expected_record_count: number;
        payload_bytes: number;
      }>(),
    3,
    signal,
  );
  return row != null
    && row.schema_version === DEX_LIQUIDITY_SCORING_STAGE_SCHEMA_VERSION
    && (row.state === "ready" || row.state === "consumed")
    && row.source_slot_started_at === input.sourceSlotStartedAt
    && row.sync_started_at === input.syncStartSec
    && row.expected_chunk_count === input.chunkCount
    && row.written_chunk_count === input.chunkCount
    && row.expected_record_count === input.recordCount
    && row.payload_bytes === input.payloadBytes;
}

export async function pruneScoringStages(
  db: D1Database,
  protectedGenerationId: string,
  nowSec: number,
  signal?: AbortSignal,
): Promise<DexLiquidityScoringStageRetentionResult> {
  const startedAtMs = Date.now();
  const staleBefore = nowSec - DEX_LIQUIDITY_SCORING_STAGE_FAILED_RETENTION_SEC;
  const result: DexLiquidityScoringStageRetentionResult = {
    cutoff: staleBefore,
    deletedRows: 0,
    deletedChunkRows: 0,
    deletedStageRows: 0,
    oldestRemainingAt: null,
    durationMs: 0,
    error: null,
  };
  const candidatesSql = `
    SELECT generation_id
      FROM dex_liquidity_scoring_stages
     WHERE generation_id != ?
       AND (
         state = 'consumed'
         OR (state IN ('writing', 'ready', 'failed') AND created_at < ?)
       )
     ORDER BY
       CASE WHEN state = 'consumed' THEN 0 ELSE 1 END,
       created_at ASC,
       generation_id ASC
     LIMIT ?`;
  try {
    const chunks = await runWithOverloadRetry(
      () => db.prepare(
        `DELETE FROM dex_liquidity_scoring_stage_chunks
          WHERE generation_id IN (${candidatesSql})`,
      ).bind(
        protectedGenerationId,
        staleBefore,
        DEX_LIQUIDITY_SCORING_STAGE_RETENTION_GENERATIONS_PER_RUN,
      ).run(),
      3,
      signal,
    );
    result.deletedChunkRows = Number(chunks.meta?.changes ?? 0);
    const stages = await runWithOverloadRetry(
      () => db.prepare(
        `DELETE FROM dex_liquidity_scoring_stages
          WHERE generation_id IN (${candidatesSql})`,
      ).bind(
        protectedGenerationId,
        staleBefore,
        DEX_LIQUIDITY_SCORING_STAGE_RETENTION_GENERATIONS_PER_RUN,
      ).run(),
      3,
      signal,
    );
    result.deletedStageRows = Number(stages.meta?.changes ?? 0);
    const oldest = await runWithOverloadRetry(
      () => db
        .prepare("SELECT MIN(created_at) AS oldest_remaining_at FROM dex_liquidity_scoring_stages")
        .first<{ oldest_remaining_at: number | null }>(),
      3,
      signal,
    );
    result.oldestRemainingAt = oldest?.oldest_remaining_at ?? null;
  } catch (error) {
    rethrowIfAborted(error, signal);
    result.error = toErrorMessage(error).slice(0, 500);
  }
  result.deletedRows = result.deletedChunkRows + result.deletedStageRows;
  result.durationMs = Math.max(0, Date.now() - startedAtMs);
  return result;
}

export async function persistDexLiquidityScoringStage(
  db: D1Database,
  input: DexLiquidityScoringStageInput,
  signal?: AbortSignal,
): Promise<PersistedDexLiquidityScoringStage> {
  assertTimestamp("sourceSlotStartedAt", input.sourceSlotStartedAt);
  assertTimestamp("syncStartSec", input.syncStartSec);
  throwIfAborted(signal);
  const generationId = stageGenerationId(input.sourceSlotStartedAt);
  const createdAt = Math.floor(Date.now() / 1000);

  await executeAtomicBatch(
    db,
    [
      db.prepare(
        `INSERT INTO dex_liquidity_scoring_stages (
           generation_id, schema_version, state, source_slot_started_at,
           sync_started_at, created_at, ready_at, consumed_at,
           expected_chunk_count, written_chunk_count, expected_record_count,
           payload_bytes, failure_reason
         ) VALUES (?, ?, 'writing', ?, ?, ?, NULL, NULL, 0, 0, 0, 0, NULL)
         ON CONFLICT(generation_id) DO UPDATE SET
           schema_version = excluded.schema_version,
           state = 'writing',
           source_slot_started_at = excluded.source_slot_started_at,
           sync_started_at = excluded.sync_started_at,
           created_at = excluded.created_at,
           ready_at = NULL,
           consumed_at = NULL,
           expected_chunk_count = 0,
           written_chunk_count = 0,
           expected_record_count = 0,
           payload_bytes = 0,
           failure_reason = NULL`,
      ).bind(
        generationId,
        DEX_LIQUIDITY_SCORING_STAGE_SCHEMA_VERSION,
        input.sourceSlotStartedAt,
        input.syncStartSec,
        createdAt,
      ),
      db.prepare(
        `DELETE FROM dex_liquidity_scoring_stage_chunks
          WHERE generation_id = ?`,
      ).bind(generationId),
    ],
    { signal },
  );

  let chunkCount = 0;
  let recordCount = 0;
  let payloadBytes = 0;
  let lastReportedChunkCount = 0;
  const reportPersistedProgress = async (force = false): Promise<void> => {
    if (
      input.onChunkBatchPersisted == null
      || chunkCount === lastReportedChunkCount
      || (
        !force
        && chunkCount - lastReportedChunkCount
          < DEX_LIQUIDITY_SCORING_STAGE_PROGRESS_CHUNK_INTERVAL
      )
    ) {
      return;
    }
    await input.onChunkBatchPersisted({ chunkCount, recordCount, payloadBytes });
    lastReportedChunkCount = chunkCount;
  };
  try {
    for (const chunk of encodeDexLiquidityScoringStageChunks(
      input.sourceState,
      input.poolState,
      DEX_LIQUIDITY_SCORING_STAGE_MAX_CHUNK_BYTES,
      true,
    )) {
      throwIfAborted(signal);
      let statement: D1PreparedStatement | null = prepareScoringStageChunkUpsert(db, [
        generationId,
        chunkCount,
        chunk.payload,
        chunk.payloadBytes,
        chunk.recordCount,
        createdAt,
      ]);
      try {
        await runWithOverloadRetry(() => statement!.run(), 3, signal);
      } finally {
        statement = null;
      }
      chunkCount++;
      recordCount += chunk.recordCount;
      payloadBytes += chunk.payloadBytes;
      chunk.payload = "";
      await reportPersistedProgress();
    }
    await reportPersistedProgress(true);
    if (chunkCount === 0 || recordCount === 0) {
      throw new Error("DEX liquidity scoring stage produced no records");
    }

    const readyAt = Math.floor(Date.now() / 1000);
    let finalizedChanges = 0;
    let finalizationError: unknown;
    try {
      const finalized = await runWithOverloadRetry(
        () =>
          db.prepare(
            `UPDATE dex_liquidity_scoring_stages
                SET state = 'ready',
                    ready_at = ?,
                    expected_chunk_count = ?,
                    written_chunk_count = (
                      SELECT COUNT(*)
                        FROM dex_liquidity_scoring_stage_chunks
                       WHERE generation_id = ?
                    ),
                    expected_record_count = ?,
                    payload_bytes = ?
              WHERE generation_id = ?
                AND state = 'writing'
                AND (
                  SELECT COUNT(*)
                    FROM dex_liquidity_scoring_stage_chunks
                   WHERE generation_id = ?
                ) = ?`,
          ).bind(
            readyAt,
            chunkCount,
            generationId,
            recordCount,
            payloadBytes,
            generationId,
            generationId,
            chunkCount,
          ).run(),
        3,
        signal,
      );
      finalizedChanges = Number(finalized.meta?.changes ?? 0);
    } catch (error) {
      finalizationError = error;
    }
    if (
      finalizedChanges !== 1
      && !(await hasExactFinalizedStageManifest(
        db,
        {
          generationId,
          sourceSlotStartedAt: input.sourceSlotStartedAt,
          syncStartSec: input.syncStartSec,
          chunkCount,
          recordCount,
          payloadBytes,
        },
        signal,
      ))
    ) {
      if (finalizationError) throw finalizationError;
      throw new Error("DEX liquidity scoring stage did not finalize a complete generation");
    }
    const retention = await pruneScoringStages(db, generationId, readyAt, signal);
    return {
      generationId,
      sourceSlotStartedAt: input.sourceSlotStartedAt,
      chunkCount,
      recordCount,
      payloadBytes,
      retention,
    };
  } catch (error) {
    await markStageFailed(db, generationId, error);
    throw error;
  }
}

async function loadStageManifest(
  db: D1Database,
  options: { nowSec: number; expectedSourceSlotStartedAt?: number },
  signal?: AbortSignal,
): Promise<StageManifestRow> {
  const query = options.expectedSourceSlotStartedAt == null
    ? db.prepare(
        `SELECT generation_id, schema_version, state, source_slot_started_at,
                sync_started_at, created_at, ready_at, expected_chunk_count,
                written_chunk_count, expected_record_count, payload_bytes
           FROM dex_liquidity_scoring_stages
          WHERE source_slot_started_at <= ?
          ORDER BY source_slot_started_at DESC
          LIMIT 1`,
      ).bind(options.nowSec + DEX_LIQUIDITY_SCORING_STAGE_FUTURE_TOLERANCE_SEC)
    : db.prepare(
        `SELECT generation_id, schema_version, state, source_slot_started_at,
                sync_started_at, created_at, ready_at, expected_chunk_count,
                written_chunk_count, expected_record_count, payload_bytes
           FROM dex_liquidity_scoring_stages
          WHERE source_slot_started_at = ?
            AND state IN ('ready', 'consumed')
          LIMIT 1`,
      ).bind(options.expectedSourceSlotStartedAt);
  const row = await runWithOverloadRetry(() => query.first<StageManifestRow>(), 3, signal);
  if (!row) {
    const suffix = options.expectedSourceSlotStartedAt == null
      ? ""
      : ` for source slot ${options.expectedSourceSlotStartedAt}`;
    throw new Error(`DEX liquidity scoring stage is missing${suffix}`);
  }
  if (row.schema_version !== DEX_LIQUIDITY_SCORING_STAGE_SCHEMA_VERSION) {
    throw new Error(`Unsupported DEX liquidity scoring stage schema version ${row.schema_version}`);
  }
  if (row.state !== "ready" && row.state !== "consumed") {
    throw new Error(`DEX liquidity scoring stage generation is incomplete (state=${row.state})`);
  }
  const ageSec = options.nowSec - row.source_slot_started_at;
  if (
    ageSec > DEX_LIQUIDITY_SCORING_STAGE_MAX_AGE_SEC ||
    ageSec < -DEX_LIQUIDITY_SCORING_STAGE_FUTURE_TOLERANCE_SEC
  ) {
    throw new Error(`DEX liquidity scoring stage generation is stale (ageSec=${ageSec})`);
  }
  if (
    row.expected_chunk_count <= 0 ||
    row.expected_chunk_count !== row.written_chunk_count ||
    row.expected_record_count <= 0 ||
    row.payload_bytes <= 0
  ) {
    throw new Error("DEX liquidity scoring stage manifest is incomplete");
  }
  return row;
}

export async function loadDexLiquidityScoringStage(
  db: D1Database,
  options: { nowSec: number; expectedSourceSlotStartedAt?: number },
  signal?: AbortSignal,
): Promise<LoadedDexLiquidityScoringStage> {
  assertTimestamp("nowSec", options.nowSec);
  if (options.expectedSourceSlotStartedAt != null) {
    assertTimestamp("expectedSourceSlotStartedAt", options.expectedSourceSlotStartedAt);
  }
  throwIfAborted(signal);
  const manifest = await loadStageManifest(db, options, signal);
  const decoder = createScoringStageDecoder();
  const byteBuffer = new Uint8Array(DEX_LIQUIDITY_SCORING_STAGE_MAX_CHUNK_BYTES);
  let nextChunkIndex = 0;
  let payloadBytes = 0;

  while (nextChunkIndex < manifest.expected_chunk_count) {
    throwIfAborted(signal);
    const page = await runWithOverloadRetry(
      () =>
        db.prepare(
          `SELECT chunk_index, payload_json, payload_bytes, record_count
             FROM dex_liquidity_scoring_stage_chunks
            WHERE generation_id = ?
              AND chunk_index >= ?
            ORDER BY chunk_index
            LIMIT ?`,
        ).bind(
          manifest.generation_id,
          nextChunkIndex,
          DEX_LIQUIDITY_SCORING_STAGE_READ_PAGE_SIZE,
        ).all<StageChunkRow>(),
      3,
      signal,
    );
    if (page.results.length === 0) {
      throw new Error(`DEX liquidity scoring stage is missing chunk ${nextChunkIndex}`);
    }
    for (const chunk of page.results) {
      if (chunk.chunk_index !== nextChunkIndex) {
        throw new Error(
          `DEX liquidity scoring stage chunk sequence mismatch (expected ${nextChunkIndex}, got ${chunk.chunk_index})`,
        );
      }
      const actualBytes = getBoundedUtf8ByteLength(chunk.payload_json, byteBuffer);
      if (actualBytes == null || actualBytes !== chunk.payload_bytes) {
        throw new Error(`DEX liquidity scoring stage chunk ${chunk.chunk_index} byte count mismatch`);
      }
      const before = decoder.recordCount;
      decodeScoringStagePayload(decoder, chunk.payload_json);
      if (decoder.recordCount - before !== chunk.record_count) {
        throw new Error(`DEX liquidity scoring stage chunk ${chunk.chunk_index} record count mismatch`);
      }
      payloadBytes += actualBytes;
      nextChunkIndex++;
    }
    page.results.length = 0;
  }

  const decoded = finishScoringStageDecode(decoder);
  if (
    nextChunkIndex !== manifest.expected_chunk_count ||
    decoded.recordCount !== manifest.expected_record_count ||
    payloadBytes !== manifest.payload_bytes
  ) {
    throw new Error("DEX liquidity scoring stage generation totals do not match its manifest");
  }
  return {
    generationId: manifest.generation_id,
    sourceSlotStartedAt: manifest.source_slot_started_at,
    syncStartSec: manifest.sync_started_at,
    sourceState: decoded.sourceState,
    poolState: decoded.poolState,
  };
}

export async function loadDexLiquidityScoringStageWhenReady(
  db: D1Database,
  options: {
    expectedSourceSlotStartedAt: number;
    readyDeadlineMs: number;
    pollIntervalMs?: number;
    nowMs?: () => number;
    wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  },
  signal?: AbortSignal,
): Promise<LoadedDexLiquidityScoringStage> {
  assertTimestamp("expectedSourceSlotStartedAt", options.expectedSourceSlotStartedAt);
  const nowMs = options.nowMs ?? Date.now;
  const wait = options.wait ?? sleepWithSignal;
  const pollIntervalMs = options.pollIntervalMs ?? DEX_LIQUIDITY_SCORING_STAGE_READY_POLL_MS;
  if (!Number.isFinite(options.readyDeadlineMs) || options.readyDeadlineMs < 0) {
    throw new RangeError("DEX liquidity scoring stage readyDeadlineMs must be non-negative");
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new RangeError("DEX liquidity scoring stage pollIntervalMs must be positive");
  }

  const missingMessage =
    `DEX liquidity scoring stage is missing for source slot ${options.expectedSourceSlotStartedAt}`;
  while (true) {
    throwIfAborted(signal);
    const observedNowMs = nowMs();
    try {
      return await loadDexLiquidityScoringStage(db, {
        nowSec: Math.floor(observedNowMs / 1_000),
        expectedSourceSlotStartedAt: options.expectedSourceSlotStartedAt,
      }, signal);
    } catch (error) {
      rethrowIfAborted(error, signal);
      if (!(error instanceof Error) || error.message !== missingMessage) throw error;
      const remainingMs = options.readyDeadlineMs - nowMs();
      if (remainingMs <= 0) throw error;
      await wait(Math.min(pollIntervalMs, remainingMs), signal);
    }
  }
}

export async function markDexLiquidityScoringStageConsumed(
  db: D1Database,
  generationId: string,
  consumedAt: number,
  signal?: AbortSignal,
): Promise<void> {
  assertTimestamp("consumedAt", consumedAt);
  throwIfAborted(signal);
  const result = await runWithOverloadRetry(
    () =>
      db.prepare(
        `UPDATE dex_liquidity_scoring_stages
            SET state = 'consumed',
                consumed_at = COALESCE(consumed_at, ?)
          WHERE generation_id = ?
            AND state IN ('ready', 'consumed')`,
      ).bind(consumedAt, generationId).run(),
    3,
    signal,
  );
  if (Number(result.meta?.changes ?? 0) !== 1) {
    throw new Error("DEX liquidity scoring stage consumption fence did not match a ready generation");
  }
}
