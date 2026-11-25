import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";
import { sha256Hex } from "@shared/lib/sha256";
import type { V9ContinuationMessage } from "@shared/types/v9-continuation";
import { throwIfAborted } from "../abort";
import { executeAtomicBatch } from "../db";
import { runWithOverloadRetry } from "../d1-overload-retry";
import { assertSlotDeadline, type SlotDeadline } from "../cron-timeouts";
import { V9_MEMORY_LANE_LEASE_KEY } from "../v9-slot-window";

/** Max UTF-8/ASCII payload bytes per `v9_eval_chunks` row (CHECK constraint <= 524,288). */
export const V9_EVAL_CHUNK_MAX_ROW_BYTES = 524_288;
/** Safe split ceiling leaving headroom below the 512 KiB row CHECK constraint. */
export const V9_EVAL_CHUNK_PART_TARGET_BYTES = 480_000;
/** Stale active runs older than 1 hour are swept at Seed and :52 resume. */
export const V9_EVAL_RUN_STALE_SEC = 3_600;
/** Max runs mutated per atomic batch (2 statements/run + 1 <= 81 < 100 D1 batch cap). */
const MAX_V9_EVAL_RUNS_PER_BATCH = 40;

export type V9EvalRunStage =
  | "seeded"
  | "evaluating"
  | "committing"
  | "materializing"
  | "completed"
  | "failed"
  | "superseded";

export type V9EvalRunState = "active" | "completed" | "failed" | "superseded";

export type V9EvalChunkKind =
  | "run_context"
  | "fact_shard"
  | "upstream_state"
  | "card_shard"
  | "chunk_summary"
  | "materialize_header";

export interface V9EvalRunRow {
  run_id: string;
  schema_version: number;
  schedule_key: string;
  slot_started_at: number;
  clock_sec: number;
  source_generation: string;
  base_input_generation_id: string;
  registry_fingerprint: string;
  evaluation_build_digest: string;
  worker_version: string | null;
  accepted_baseline_generation_id: string | null;
  accepted_baseline_sha256: string | null;
  dex_generation_id: string | null;
  redemption_generation_id: string | null;
  fact_set_digest: string | null;
  plan_digest: string;
  policy_digest: string;
  quarantine_epoch: number;
  chunk_count: number;
  next_chunk_index: number;
  materialize_step_count: number;
  next_materialize_step: number;
  stage: V9EvalRunStage;
  state: V9EvalRunState;
  execution_generation: number;
  execution_owner: string;
  publication_generation_id: string | null;
  payload_sha256: string | null;
  superseded_by_run_id: string | null;
  failure_reason: string | null;
  plan_metadata_json: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

export interface V9EvalQueueFence {
  deliveryId: string;
  runId: string;
  scheduleKey: "v9PublicationOffset";
  slotStartedAt: number;
  stage: "eval" | "commit" | "materialize";
  chunkIndex: number | null;
  quarantineEpoch: number;
  owner: string;
  invocationId: string;
  executionGeneration: number;
}

export interface V9EvalChunkWriteFence {
  executionGeneration: number;
  expectedQuarantineEpoch: number;
}

export type V9ContinuationClaimResult =
  | { status: "claimed"; fence: V9EvalQueueFence; run: V9EvalRunRow; readyToClaimMs: number; reclaimed: boolean }
  | { status: "build-drift"; runId: string; reason: "build-drift-aborted" | "worker-version-drift-aborted" }
  | { status: "stale"; reason: string };

function normalizeWorkerVersion(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function workerVersionsMatch(
  runWorkerVersion: string | null | undefined,
  runningWorkerVersion: string | null | undefined,
): boolean {
  const expected = normalizeWorkerVersion(runWorkerVersion);
  const actual = normalizeWorkerVersion(runningWorkerVersion);
  return expected !== null && actual !== null && expected === actual;
}

function uint8ToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToUint8(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export interface EncodedV9EvalChunkPart {
  partIndex: number;
  encoding: "deflate-base64";
  payload: string;
  payloadBytes: number;
  payloadSha256: string;
}

/**
 * Compress a staging payload and split into strictly <= 512 KiB ASCII parts.
 * Each part carries its own SHA-256 checksum verified on readback.
 */
export function encodeV9EvalChunkParts(
  value: unknown,
  maxPartBytes = V9_EVAL_CHUNK_PART_TARGET_BYTES,
): EncodedV9EvalChunkPart[] {
  if (!Number.isInteger(maxPartBytes) || maxPartBytes < 1 || maxPartBytes > V9_EVAL_CHUNK_MAX_ROW_BYTES) {
    throw new Error(`Invalid V9 eval chunk part ceiling: ${maxPartBytes}`);
  }
  const compressed = deflateSync(strToU8(JSON.stringify(value)), { level: 1 });
  const encoded = uint8ToBase64(compressed);
  if (encoded.length === 0) {
    throw new Error("Encoded V9 eval chunk payload must be non-empty");
  }
  const parts: EncodedV9EvalChunkPart[] = [];
  for (let offset = 0, partIndex = 0; offset < encoded.length; offset += maxPartBytes, partIndex++) {
    const slice = encoded.slice(offset, offset + maxPartBytes);
    if (slice.length < 1 || slice.length > V9_EVAL_CHUNK_MAX_ROW_BYTES) {
      throw new Error(`V9 eval chunk part ${partIndex} exceeds 512 KiB row limit`);
    }
    parts.push({
      partIndex,
      encoding: "deflate-base64",
      payload: slice,
      payloadBytes: slice.length,
      payloadSha256: sha256Hex(slice),
    });
  }
  return parts;
}

export function buildWriteV9EvalChunkStatements(
  db: D1Database,
  input: {
    runId: string;
    chunkKind: V9EvalChunkKind;
    chunkIndex: number;
    quarantineEpoch: number;
    value: unknown;
    createdAt: number;
    maxPartBytes?: number;
    fence?: V9EvalChunkWriteFence;
  },
): { statements: D1PreparedStatement[]; totalBytes: number; partCount: number } {
  const parts = encodeV9EvalChunkParts(input.value, input.maxPartBytes);
  const statements: D1PreparedStatement[] = [
    input.fence
      ? db.prepare(
          `DELETE FROM v9_eval_chunks
            WHERE run_id = ?
              AND chunk_kind = ?
              AND chunk_index = ?
              AND EXISTS (
                SELECT 1 FROM v9_eval_runs
                 WHERE run_id = ?
                   AND state = 'active'
                   AND execution_generation = ?
                   AND quarantine_epoch = ?
              )`,
        ).bind(
          input.runId,
          input.chunkKind,
          input.chunkIndex,
          input.runId,
          input.fence.executionGeneration,
          input.fence.expectedQuarantineEpoch,
        )
      : db.prepare(
          `DELETE FROM v9_eval_chunks
            WHERE run_id = ?
              AND chunk_kind = ?
              AND chunk_index = ?`,
        ).bind(input.runId, input.chunkKind, input.chunkIndex),
  ];
  let totalBytes = 0;
  for (const part of parts) {
    totalBytes += part.payloadBytes;
    statements.push(
      input.fence
        ? db.prepare(
            `INSERT INTO v9_eval_chunks (
              run_id, chunk_kind, chunk_index, part_index, quarantine_epoch,
              encoding, payload, payload_bytes, payload_sha256, created_at
            ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
              WHERE EXISTS (
                SELECT 1 FROM v9_eval_runs
                 WHERE run_id = ?
                   AND state = 'active'
                   AND execution_generation = ?
                   AND quarantine_epoch = ?
              )`,
          ).bind(
            input.runId,
            input.chunkKind,
            input.chunkIndex,
            part.partIndex,
            input.quarantineEpoch,
            part.encoding,
            part.payload,
            part.payloadBytes,
            part.payloadSha256,
            input.createdAt,
            input.runId,
            input.fence.executionGeneration,
            input.fence.expectedQuarantineEpoch,
          )
        : db.prepare(
            `INSERT INTO v9_eval_chunks (
              run_id, chunk_kind, chunk_index, part_index, quarantine_epoch,
              encoding, payload, payload_bytes, payload_sha256, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            input.runId,
            input.chunkKind,
            input.chunkIndex,
            part.partIndex,
            input.quarantineEpoch,
            part.encoding,
            part.payload,
            part.payloadBytes,
            part.payloadSha256,
            input.createdAt,
          ),
    );
  }
  return { statements, totalBytes, partCount: parts.length };
}

export async function writeV9EvalChunk(
  db: D1Database,
  input: {
    runId: string;
    chunkKind: V9EvalChunkKind;
    chunkIndex: number;
    quarantineEpoch: number;
    value: unknown;
    createdAt: number;
    maxPartBytes?: number;
    fence?: V9EvalChunkWriteFence;
  },
  signal?: AbortSignal,
): Promise<{ totalBytes: number; partCount: number }> {
  throwIfAborted(signal);
  const { statements, totalBytes, partCount } = buildWriteV9EvalChunkStatements(db, input);
  if (input.fence) {
    const results = await runWithOverloadRetry(() => db.batch(statements), 3, signal);
    for (let index = 1; index < statements.length; index++) {
      if ((results[index]?.meta.changes ?? 0) !== 1) {
        throw new Error(
          `V9 eval run ${input.runId} lost ownership writing ${input.chunkKind}[${input.chunkIndex}]`,
        );
      }
    }
  } else {
    await executeAtomicBatch(db, statements, { signal });
  }
  return { totalBytes, partCount };
}

export async function readV9EvalChunk<T>(
  db: D1Database,
  input: {
    runId: string;
    chunkKind: V9EvalChunkKind;
    chunkIndex: number;
    quarantineEpoch: number;
  },
  signal?: AbortSignal,
): Promise<T | null> {
  throwIfAborted(signal);
  const result = await runWithOverloadRetry(
    () => db.prepare(
      `SELECT part_index, encoding, payload, payload_bytes, payload_sha256
         FROM v9_eval_chunks
        WHERE run_id = ?
          AND chunk_kind = ?
          AND chunk_index = ?
          AND quarantine_epoch = ?
        ORDER BY part_index ASC`,
    ).bind(input.runId, input.chunkKind, input.chunkIndex, input.quarantineEpoch).all<{
      part_index: number;
      encoding: string;
      payload: string;
      payload_bytes: number;
      payload_sha256: string;
    }>(),
    3,
    signal,
  );
  throwIfAborted(signal);
  const rows = result.results ?? [];
  if (rows.length === 0) return null;
  let combined = "";
  const encoding = rows[0]!.encoding;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (row.part_index !== index) {
      throw new Error(`V9 eval chunk ${input.chunkKind}[${input.chunkIndex}] is missing part ${index}`);
    }
    if (row.encoding !== encoding) {
      throw new Error(`V9 eval chunk ${input.chunkKind}[${input.chunkIndex}] has mixed encodings`);
    }
    if (row.payload.length !== row.payload_bytes || sha256Hex(row.payload) !== row.payload_sha256) {
      throw new Error(`V9 eval chunk ${input.chunkKind}[${input.chunkIndex}] part ${index} failed integrity check`);
    }
    combined += row.payload;
  }
  if (encoding === "json") {
    return JSON.parse(combined) as T;
  }
  if (encoding === "deflate-base64") {
    const inflated = strFromU8(inflateSync(base64ToUint8(combined)));
    return JSON.parse(inflated) as T;
  }
  throw new Error(`Unsupported V9 eval chunk encoding: ${encoding}`);
}

export async function loadV9EvalRun(
  db: D1Database,
  runId: string,
  signal?: AbortSignal,
): Promise<V9EvalRunRow | null> {
  throwIfAborted(signal);
  return runWithOverloadRetry(
    () => db.prepare(
      `SELECT run_id, schema_version, schedule_key, slot_started_at, clock_sec,
              source_generation, base_input_generation_id, registry_fingerprint,
              evaluation_build_digest, worker_version,
              accepted_baseline_generation_id, accepted_baseline_sha256,
              dex_generation_id, redemption_generation_id,
              fact_set_digest, plan_digest, policy_digest,
              quarantine_epoch, chunk_count, next_chunk_index,
              materialize_step_count, next_materialize_step,
              stage, state, execution_generation, execution_owner,
              publication_generation_id, payload_sha256,
              superseded_by_run_id, failure_reason, plan_metadata_json,
              created_at, updated_at, finished_at
         FROM v9_eval_runs
        WHERE run_id = ?`,
    ).bind(runId).first<V9EvalRunRow>(),
    3,
    signal,
  );
}

export async function loadLatestActiveV9EvalRun(
  db: D1Database,
  signal?: AbortSignal,
): Promise<V9EvalRunRow | null> {
  throwIfAborted(signal);
  return runWithOverloadRetry(
    () => db.prepare(
      `SELECT run_id, schema_version, schedule_key, slot_started_at, clock_sec,
              source_generation, base_input_generation_id, registry_fingerprint,
              evaluation_build_digest, worker_version,
              accepted_baseline_generation_id, accepted_baseline_sha256,
              dex_generation_id, redemption_generation_id,
              fact_set_digest, plan_digest, policy_digest,
              quarantine_epoch, chunk_count, next_chunk_index,
              materialize_step_count, next_materialize_step,
              stage, state, execution_generation, execution_owner,
              publication_generation_id, payload_sha256,
              superseded_by_run_id, failure_reason, plan_metadata_json,
              created_at, updated_at, finished_at
         FROM v9_eval_runs
        WHERE state = 'active'
        ORDER BY updated_at DESC, run_id DESC
        LIMIT 1`,
    ).first<V9EvalRunRow>(),
    3,
    signal,
  );
}

export async function confirmV9EvalRunOwnership(
  db: D1Database,
  input: {
    runId: string;
    expectedStage: V9EvalRunStage;
    expectedGeneration: number;
    expectedQuarantineEpoch: number;
    workerVersion: string;
    nowSec: number;
  },
  signal?: AbortSignal,
): Promise<boolean> {
  throwIfAborted(signal);
  const result = await runWithOverloadRetry(
    () => db.prepare(
      `UPDATE v9_eval_runs
          SET updated_at = MAX(updated_at, ?)
        WHERE run_id = ?
          AND state = 'active'
          AND stage = ?
          AND execution_generation = ?
          AND quarantine_epoch = ?
          AND worker_version = ?`,
    ).bind(
      input.nowSec,
      input.runId,
      input.expectedStage,
      input.expectedGeneration,
      input.expectedQuarantineEpoch,
      input.workerVersion,
    ).run(),
    3,
    signal,
  );
  return (result.meta.changes ?? 0) === 1;
}

async function failAndPruneRunBatch(
  db: D1Database,
  runIds: readonly string[],
  reason: string,
  nowSec: number,
  signal?: AbortSignal,
): Promise<void> {
  for (let offset = 0; offset < runIds.length; offset += MAX_V9_EVAL_RUNS_PER_BATCH) {
    const slice = runIds.slice(offset, offset + MAX_V9_EVAL_RUNS_PER_BATCH);
    const statements: D1PreparedStatement[] = [];
    for (const runId of slice) {
      statements.push(
        db.prepare(
          `UPDATE v9_eval_runs
              SET state = 'failed',
                  stage = 'failed',
                  failure_reason = ?,
                  updated_at = ?,
                  finished_at = ?
            WHERE run_id = ?
              AND state = 'active'`,
        ).bind(reason, nowSec, nowSec, runId),
        db.prepare(
          `DELETE FROM v9_eval_chunks
            WHERE run_id = ?
              AND EXISTS (
                SELECT 1 FROM v9_eval_runs
                 WHERE run_id = ?
                   AND state = 'failed'
              )`,
        ).bind(runId, runId),
      );
    }
    await executeAtomicBatch(db, statements, { signal });
  }
}

export async function sweepStaleV9EvalRuns(
  db: D1Database,
  nowSec: number,
  nowMs: number,
  signal?: AbortSignal,
): Promise<{ sweptRunIds: string[]; reconciledExecutions: number }> {
  throwIfAborted(signal);
  const cutoffSec = nowSec - V9_EVAL_RUN_STALE_SEC;
  const staleRuns = await runWithOverloadRetry(
    () => db.prepare(
      `SELECT run_id
         FROM v9_eval_runs
        WHERE state = 'active'
          AND updated_at < ?
        ORDER BY updated_at ASC, run_id ASC`,
    ).bind(cutoffSec).all<{ run_id: string }>(),
    3,
    signal,
  );
  throwIfAborted(signal);
  const sweptRunIds = (staleRuns.results ?? []).map((row) => row.run_id);
  if (sweptRunIds.length > 0) {
    await failAndPruneRunBatch(db, sweptRunIds, "stale-run-swept", nowSec, signal);
  }
  const reconciled = await runWithOverloadRetry(
    () => db.prepare(
      `UPDATE v9_eval_queue_executions
          SET state = 'finished',
              result_status = 'error',
              failure_reason = 'stale-execution-reconciled',
              updated_at = ?,
              finished_at = ?
        WHERE state IN ('running', 'reconciling')
          AND deadline_ms < ?`,
    ).bind(nowSec, nowSec, nowMs).run(),
    3,
    signal,
  );
  return {
    sweptRunIds,
    reconciledExecutions: reconciled.meta.changes ?? 0,
  };
}

/**
 * Clean up abandoned active chunked runs and staging blobs when monolithic
 * `WORKER_V9_QUEUE_MODE = "off"` executes after a rollback. Leaves terminal
 * `v9_eval_runs` and `v9_eval_queue_executions` rows intact for 14-day diagnosis,
 * performs zero writes when no abandoned active runs or expired executions exist.
 */
export async function cleanupAbandonedV9EvalRunsOnOffMode(
  db: D1Database,
  nowSec: number,
  nowMs: number,
  signal?: AbortSignal,
): Promise<{ abortedRunIds: string[]; reconciledExecutions: number }> {
  throwIfAborted(signal);
  const activeRuns = await runWithOverloadRetry(
    () => db.prepare(
      `SELECT run_id
         FROM v9_eval_runs
        WHERE state = 'active'
        ORDER BY updated_at ASC, run_id ASC`,
    ).all<{ run_id: string }>(),
    3,
    signal,
  );
  throwIfAborted(signal);
  const abortedRunIds = (activeRuns.results ?? []).map((row) => row.run_id);
  if (abortedRunIds.length > 0) {
    await failAndPruneRunBatch(db, abortedRunIds, "off-mode-rollback-aborted", nowSec, signal);
  }
  const expired = await runWithOverloadRetry(
    () => db.prepare(
      `SELECT COUNT(*) AS count
         FROM v9_eval_queue_executions
        WHERE state IN ('running', 'reconciling')
          AND deadline_ms < ?`,
    ).bind(nowMs).first<{ count: number }>(),
    3,
    signal,
  );
  if ((expired?.count ?? 0) === 0) {
    return { abortedRunIds, reconciledExecutions: 0 };
  }
  const reconciled = await runWithOverloadRetry(
    () => db.prepare(
      `UPDATE v9_eval_queue_executions
          SET state = 'finished',
              result_status = 'error',
              failure_reason = 'off-mode-rollback-reconciled',
              updated_at = ?,
              finished_at = ?
        WHERE state IN ('running', 'reconciling')
          AND deadline_ms < ?`,
    ).bind(nowSec, nowSec, nowMs).run(),
    3,
    signal,
  );
  return {
    abortedRunIds,
    reconciledExecutions: reconciled.meta.changes ?? 0,
  };
}

export async function supersedeActiveV9EvalRuns(
  db: D1Database,
  supersededByRunId: string,
  nowSec: number,
  signal?: AbortSignal,
): Promise<string[]> {
  throwIfAborted(signal);
  const activeRuns = await runWithOverloadRetry(
    () => db.prepare(
      `SELECT run_id
         FROM v9_eval_runs
        WHERE state = 'active'
          AND run_id != ?
        ORDER BY updated_at ASC, run_id ASC`,
    ).bind(supersededByRunId).all<{ run_id: string }>(),
    3,
    signal,
  );
  throwIfAborted(signal);
  const runIds = (activeRuns.results ?? []).map((row) => row.run_id);
  if (runIds.length === 0) return [];
  for (let offset = 0; offset < runIds.length; offset += MAX_V9_EVAL_RUNS_PER_BATCH) {
    const slice = runIds.slice(offset, offset + MAX_V9_EVAL_RUNS_PER_BATCH);
    const statements: D1PreparedStatement[] = [];
    for (const runId of slice) {
      statements.push(
        db.prepare(
          `UPDATE v9_eval_runs
              SET state = 'superseded',
                  stage = 'superseded',
                  superseded_by_run_id = ?,
                  updated_at = ?,
                  finished_at = ?
            WHERE run_id = ?
              AND state = 'active'`,
        ).bind(supersededByRunId, nowSec, nowSec, runId),
        db.prepare(
          `DELETE FROM v9_eval_chunks
            WHERE run_id = ?
              AND EXISTS (
                SELECT 1 FROM v9_eval_runs
                 WHERE run_id = ?
                   AND state = 'superseded'
              )`,
        ).bind(runId, runId),
      );
    }
    await executeAtomicBatch(db, statements, { signal });
  }
  return runIds;
}

export async function markV9EvalRunFailedAndPrune(
  db: D1Database,
  runId: string,
  reason: string,
  nowSec: number,
  signal?: AbortSignal,
  fence?: { expectedGeneration: number; expectedQuarantineEpoch?: number },
): Promise<boolean> {
  throwIfAborted(signal);
  const expectedGeneration = fence?.expectedGeneration ?? null;
  const expectedQuarantineEpoch = fence?.expectedQuarantineEpoch ?? null;
  const results = await runWithOverloadRetry(
    () =>
      db.batch([
        db.prepare(
          `UPDATE v9_eval_runs
              SET state = 'failed',
                  stage = 'failed',
                  failure_reason = ?,
                  updated_at = ?,
                  finished_at = ?
            WHERE run_id = ?
              AND state = 'active'
              AND (? IS NULL OR execution_generation = ?)
              AND (? IS NULL OR quarantine_epoch = ?)`,
        ).bind(
          reason.slice(0, 500),
          nowSec,
          nowSec,
          runId,
          expectedGeneration,
          expectedGeneration,
          expectedQuarantineEpoch,
          expectedQuarantineEpoch,
        ),
        db.prepare(
          `DELETE FROM v9_eval_chunks
            WHERE run_id = ?
              AND EXISTS (
                SELECT 1 FROM v9_eval_runs
                 WHERE run_id = ?
                   AND state = 'failed'
                   AND (? IS NULL OR execution_generation = ?)
                   AND (? IS NULL OR quarantine_epoch = ?)
              )`,
        ).bind(
          runId,
          runId,
          expectedGeneration,
          expectedGeneration,
          expectedQuarantineEpoch,
          expectedQuarantineEpoch,
        ),
      ]),
    3,
    signal,
  );
  return (results[0]?.meta.changes ?? 0) === 1;
}

export async function markV9EvalRunCompletedAndPrune(
  db: D1Database,
  input: {
    runId: string;
    expectedGeneration: number;
    publicationGenerationId: string | null;
    payloadSha256: string | null;
    nowSec: number;
  },
  signal?: AbortSignal,
): Promise<boolean> {
  throwIfAborted(signal);
  const results = await runWithOverloadRetry(
    () =>
      db.batch([
        db.prepare(
          `UPDATE v9_eval_runs
              SET state = 'completed',
                  stage = 'completed',
                  publication_generation_id = COALESCE(?, publication_generation_id),
                  payload_sha256 = COALESCE(?, payload_sha256),
                  next_materialize_step = materialize_step_count,
                  updated_at = ?,
                  finished_at = ?
            WHERE run_id = ?
              AND state = 'active'
              AND execution_generation = ?`,
        ).bind(
          input.publicationGenerationId,
          input.payloadSha256,
          input.nowSec,
          input.nowSec,
          input.runId,
          input.expectedGeneration,
        ),
        db.prepare(
          `DELETE FROM v9_eval_chunks
            WHERE run_id = ?
              AND EXISTS (
                SELECT 1 FROM v9_eval_runs
                 WHERE run_id = ?
                   AND state = 'completed'
                   AND execution_generation = ?
              )`,
        ).bind(input.runId, input.runId, input.expectedGeneration),
      ]),
    3,
    signal,
  );
  return (results[0]?.meta.changes ?? 0) === 1;
}

export async function completeActiveV9EvalRunsForAcceptedGeneration(
  db: D1Database,
  publicationGenerationId: string,
  nowSec: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const rows = await runWithOverloadRetry(
    () => db.prepare(
      `SELECT run_id
         FROM v9_eval_runs
        WHERE state = 'active'
          AND stage = 'materializing'
          AND publication_generation_id = ?`,
    ).bind(publicationGenerationId).all<{ run_id: string }>(),
    3,
    signal,
  );
  const runIds = (rows.results ?? []).map((row) => row.run_id);
  if (runIds.length === 0) return;
  for (let offset = 0; offset < runIds.length; offset += MAX_V9_EVAL_RUNS_PER_BATCH) {
    const slice = runIds.slice(offset, offset + MAX_V9_EVAL_RUNS_PER_BATCH);
    const statements: D1PreparedStatement[] = [];
    for (const runId of slice) {
      statements.push(
        db.prepare(
          `UPDATE v9_eval_runs
              SET state = 'completed',
                  stage = 'completed',
                  next_materialize_step = materialize_step_count,
                  updated_at = ?,
                  finished_at = ?
            WHERE run_id = ?
              AND state = 'active'
              AND stage = 'materializing'
              AND publication_generation_id = ?`,
        ).bind(nowSec, nowSec, runId, publicationGenerationId),
        db.prepare(
          `DELETE FROM v9_eval_chunks
            WHERE run_id = ?
              AND EXISTS (
                SELECT 1 FROM v9_eval_runs
                 WHERE run_id = ?
                   AND state = 'completed'
              )`,
        ).bind(runId, runId),
      );
    }
    await executeAtomicBatch(db, statements, { signal });
  }
}

export async function claimActiveV9EvalRunForCronResume(
  db: D1Database,
  input: {
    runId: string;
    expectedGeneration: number;
    workerVersion: string;
    owner: string;
    nowSec: number;
  },
  signal?: AbortSignal,
): Promise<V9EvalRunRow | null> {
  throwIfAborted(signal);
  const update = await runWithOverloadRetry(
    () => db.prepare(
      `UPDATE v9_eval_runs
          SET execution_generation = execution_generation + 1,
              execution_owner = ?,
              updated_at = ?
        WHERE run_id = ?
          AND state = 'active'
          AND execution_generation = ?
          AND worker_version = ?`,
    ).bind(input.owner, input.nowSec, input.runId, input.expectedGeneration, input.workerVersion).run(),
    3,
    signal,
  );
  if (update.meta.changes !== 1) return null;
  return loadV9EvalRun(db, input.runId, signal);
}

function expectedRunStageForMessage(stage: V9ContinuationMessage["stage"]): V9EvalRunStage {
  if (stage === "eval") return "evaluating";
  if (stage === "commit") return "committing";
  return "materializing";
}

interface ExistingDeliveryExecutionRow {
  run_id: string;
  stage: string;
  chunk_index: number | null;
  quarantine_epoch: number;
  attempt_no: number;
  execution_owner: string;
  execution_generation: number;
  state: string;
  result_status: string | null;
  deadline_ms: number;
}

/**
 * Atomically claim a heavy Queue continuation delivery against D1 authority
 * (`v9_eval_runs` + `v9_eval_queue_executions` + `cron_leases`). Fails closed
 * on evaluator build, registry, policy, or Worker version drift without mixing
 * evaluator builds. Supports retry reclaim for the same `deliveryId` across
 * Queue `max_retries` when the prior attempt failed or was evicted without
 * advancing the run.
 */
export async function claimV9Continuation(
  db: D1Database,
  message: V9ContinuationMessage,
  input: {
    deliveryId: string;
    deliveryAttempt?: number;
    owner: string;
    leaseOwner: string;
    workerVersion: string | null;
    deadline: SlotDeadline;
    currentEvaluationBuildDigest: string;
    currentRegistryFingerprint: string;
    currentPolicyDigestForClock: (clockSec: number) => string;
  },
): Promise<V9ContinuationClaimResult> {
  assertSlotDeadline(input.deadline);
  const run = await loadV9EvalRun(db, message.runId);
  assertSlotDeadline(input.deadline);
  if (!run) return { status: "stale", reason: "run-not-found" };
  if (run.state !== "active") return { status: "stale", reason: `run-state-${run.state}` };

  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1_000);
  const currentPolicyDigest = input.currentPolicyDigestForClock(run.clock_sec);
  const buildDrift =
    run.evaluation_build_digest !== input.currentEvaluationBuildDigest ||
    run.registry_fingerprint !== input.currentRegistryFingerprint ||
    run.policy_digest !== currentPolicyDigest;
  if (buildDrift) {
    await markV9EvalRunFailedAndPrune(db, run.run_id, "build-drift-aborted", nowSec);
    return { status: "build-drift", runId: run.run_id, reason: "build-drift-aborted" };
  }

  const runningWorkerVersion = normalizeWorkerVersion(input.workerVersion);
  if (!workerVersionsMatch(run.worker_version, runningWorkerVersion)) {
    await markV9EvalRunFailedAndPrune(db, run.run_id, "worker-version-drift-aborted", nowSec);
    return { status: "build-drift", runId: run.run_id, reason: "worker-version-drift-aborted" };
  }

  if (
    message.evaluationBuildDigest !== input.currentEvaluationBuildDigest ||
    message.registryFingerprint !== input.currentRegistryFingerprint ||
    message.policyDigest !== currentPolicyDigest
  ) {
    return { status: "stale", reason: "message-build-mismatch" };
  }

  const expectedStage = expectedRunStageForMessage(message.stage);
  if (
    run.stage !== expectedStage ||
    run.quarantine_epoch !== message.quarantineEpoch ||
    (message.stage === "eval" &&
      (message.chunkIndex === null || run.next_chunk_index !== message.chunkIndex || message.chunkIndex >= run.chunk_count))
  ) {
    return { status: "stale", reason: "stage-or-epoch-advanced" };
  }

  const expectedChunkIndex = message.stage === "eval" ? message.chunkIndex! : run.next_chunk_index;
  const attemptNo = Math.max(message.attemptNo, input.deliveryAttempt ?? 1);
  const expectedRunGeneration = run.execution_generation;
  const nextGeneration = expectedRunGeneration + 1;

  const existing = await runWithOverloadRetry(
    () => db.prepare(
      `SELECT run_id, stage, chunk_index, quarantine_epoch, attempt_no,
              execution_owner, execution_generation, state, result_status, deadline_ms
         FROM v9_eval_queue_executions
        WHERE delivery_id = ?`,
    ).bind(input.deliveryId).first<ExistingDeliveryExecutionRow>(),
  );
  assertSlotDeadline(input.deadline);

  let reclaimed = false;
  let results: D1Result[];

  if (!existing) {
    if (expectedRunGeneration !== message.executionGeneration) {
      return { status: "stale", reason: "execution-generation-stale" };
    }
    results = await runWithOverloadRetry(() =>
      db.batch([
        db.prepare(
          `INSERT INTO v9_eval_queue_executions (
            delivery_id, run_id, schedule_key, slot_started_at, stage, chunk_index,
            quarantine_epoch, attempt_no, source_invocation_id, execution_owner,
            execution_generation, invocation_id, worker_version, state,
            started_at, updated_at, deadline_ms
          ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM v9_eval_runs
               WHERE run_id = ?
                 AND state = 'active'
                 AND stage = ?
                 AND next_chunk_index = ?
                 AND quarantine_epoch = ?
                 AND execution_generation = ?
                 AND evaluation_build_digest = ?
                 AND registry_fingerprint = ?
                 AND policy_digest = ?
                 AND worker_version = ?
            )
              AND EXISTS (
                SELECT 1 FROM cron_leases
                 WHERE job = ?
                   AND lease_owner = ?
                   AND lease_until >= ?
              )
            ON CONFLICT(delivery_id) DO NOTHING`,
        ).bind(
          input.deliveryId,
          message.runId,
          message.scheduleKey,
          message.slotStartedAt,
          message.stage,
          message.chunkIndex,
          message.quarantineEpoch,
          attemptNo,
          message.sourceInvocationId,
          input.owner,
          nextGeneration,
          input.owner,
          runningWorkerVersion,
          nowSec,
          nowSec,
          input.deadline.platformDeadlineMs,
          message.runId,
          expectedStage,
          expectedChunkIndex,
          message.quarantineEpoch,
          message.executionGeneration,
          input.currentEvaluationBuildDigest,
          input.currentRegistryFingerprint,
          currentPolicyDigest,
          runningWorkerVersion,
          V9_MEMORY_LANE_LEASE_KEY,
          input.leaseOwner,
          nowSec,
        ),
        db.prepare(
          `UPDATE v9_eval_runs
              SET execution_generation = execution_generation + 1,
                  execution_owner = ?,
                  updated_at = ?
            WHERE run_id = ?
              AND state = 'active'
              AND stage = ?
              AND next_chunk_index = ?
              AND quarantine_epoch = ?
              AND execution_generation = ?
              AND worker_version = ?
              AND EXISTS (
                SELECT 1 FROM v9_eval_queue_executions
                 WHERE delivery_id = ?
                   AND execution_owner = ?
                   AND execution_generation = ?
                   AND state = 'running'
              )`,
        ).bind(
          input.owner,
          nowSec,
          message.runId,
          expectedStage,
          expectedChunkIndex,
          message.quarantineEpoch,
          message.executionGeneration,
          runningWorkerVersion,
          input.deliveryId,
          input.owner,
          nextGeneration,
        ),
      ]),
    );
  } else {
    const sameStageTarget =
      existing.run_id === message.runId &&
      existing.stage === message.stage &&
      existing.chunk_index === message.chunkIndex &&
      existing.quarantine_epoch === message.quarantineEpoch &&
      existing.execution_generation === expectedRunGeneration &&
      existing.execution_owner !== input.owner;
    const retryablePriorAttempt =
      (existing.state === "finished" && existing.result_status === "error") ||
      (existing.state === "running" && (attemptNo > existing.attempt_no || existing.deadline_ms <= nowMs));
    if (!sameStageTarget || !retryablePriorAttempt) {
      return {
        status: "stale",
        reason:
          existing.state === "finished" && existing.result_status !== "error"
            ? "duplicate-completed-delivery"
            : "execution-generation-stale",
      };
    }

    reclaimed = true;
    results = await runWithOverloadRetry(() =>
      db.batch([
        db.prepare(
          `UPDATE v9_eval_queue_executions
              SET attempt_no = ?,
                  execution_owner = ?,
                  execution_generation = ?,
                  invocation_id = ?,
                  worker_version = ?,
                  state = 'running',
                  started_at = ?,
                  updated_at = ?,
                  deadline_ms = ?,
                  finished_at = NULL,
                  result_status = NULL,
                  failure_reason = NULL
            WHERE delivery_id = ?
              AND run_id = ?
              AND execution_generation = ?
              AND (
                (state = 'finished' AND result_status = 'error')
                OR (state = 'running' AND (attempt_no < ? OR deadline_ms <= ?))
              )
              AND EXISTS (
                SELECT 1 FROM v9_eval_runs
                 WHERE run_id = ?
                   AND state = 'active'
                   AND stage = ?
                   AND next_chunk_index = ?
                   AND quarantine_epoch = ?
                   AND execution_generation = ?
                   AND evaluation_build_digest = ?
                   AND registry_fingerprint = ?
                   AND policy_digest = ?
                   AND worker_version = ?
              )
              AND EXISTS (
                SELECT 1 FROM cron_leases
                 WHERE job = ?
                   AND lease_owner = ?
                   AND lease_until >= ?
              )`,
        ).bind(
          attemptNo,
          input.owner,
          nextGeneration,
          input.owner,
          runningWorkerVersion,
          nowSec,
          nowSec,
          input.deadline.platformDeadlineMs,
          input.deliveryId,
          message.runId,
          expectedRunGeneration,
          attemptNo,
          nowMs,
          message.runId,
          expectedStage,
          expectedChunkIndex,
          message.quarantineEpoch,
          expectedRunGeneration,
          input.currentEvaluationBuildDigest,
          input.currentRegistryFingerprint,
          currentPolicyDigest,
          runningWorkerVersion,
          V9_MEMORY_LANE_LEASE_KEY,
          input.leaseOwner,
          nowSec,
        ),
        db.prepare(
          `UPDATE v9_eval_runs
              SET execution_generation = execution_generation + 1,
                  execution_owner = ?,
                  updated_at = ?
            WHERE run_id = ?
              AND state = 'active'
              AND stage = ?
              AND next_chunk_index = ?
              AND quarantine_epoch = ?
              AND execution_generation = ?
              AND worker_version = ?
              AND EXISTS (
                SELECT 1 FROM v9_eval_queue_executions
                 WHERE delivery_id = ?
                   AND execution_owner = ?
                   AND execution_generation = ?
                   AND state = 'running'
              )`,
        ).bind(
          input.owner,
          nowSec,
          message.runId,
          expectedStage,
          expectedChunkIndex,
          message.quarantineEpoch,
          expectedRunGeneration,
          runningWorkerVersion,
          input.deliveryId,
          input.owner,
          nextGeneration,
        ),
      ]),
    );
  }
  assertSlotDeadline(input.deadline);

  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    // Transport-replay readback: recover ownership if our own batch committed
    // before the response was lost.
    const owned = await db.prepare(
      `SELECT execution_owner, execution_generation, invocation_id, state, started_at, deadline_ms
         FROM v9_eval_queue_executions
        WHERE delivery_id = ?`,
    ).bind(input.deliveryId).first<{
      execution_owner: string;
      execution_generation: number;
      invocation_id: string;
      state: string;
      started_at: number;
      deadline_ms: number;
    }>();
    assertSlotDeadline(input.deadline);
    if (
      !owned ||
      owned.execution_owner !== input.owner ||
      owned.execution_generation !== nextGeneration ||
      owned.invocation_id !== input.owner ||
      owned.state !== "running" ||
      owned.deadline_ms !== input.deadline.platformDeadlineMs
    ) {
      return { status: "stale", reason: reclaimed ? "reclaim-race-lost" : "claim-race-lost" };
    }
    const updatedRun = await loadV9EvalRun(db, message.runId);
    assertSlotDeadline(input.deadline);
    if (
      !updatedRun ||
      updatedRun.state !== "active" ||
      updatedRun.execution_owner !== input.owner ||
      updatedRun.execution_generation !== nextGeneration
    ) {
      return { status: "stale", reason: "run-ownership-unconfirmed" };
    }
    return {
      status: "claimed",
      fence: {
        deliveryId: input.deliveryId,
        runId: message.runId,
        scheduleKey: message.scheduleKey,
        slotStartedAt: message.slotStartedAt,
        stage: message.stage,
        chunkIndex: message.chunkIndex,
        quarantineEpoch: message.quarantineEpoch,
        owner: input.owner,
        invocationId: input.owner,
        executionGeneration: nextGeneration,
      },
      run: updatedRun,
      readyToClaimMs: Math.max(0, Date.now() - owned.started_at * 1_000),
      reclaimed,
    };
  }

  return {
    status: "claimed",
    fence: {
      deliveryId: input.deliveryId,
      runId: message.runId,
      scheduleKey: message.scheduleKey,
      slotStartedAt: message.slotStartedAt,
      stage: message.stage,
      chunkIndex: message.chunkIndex,
      quarantineEpoch: message.quarantineEpoch,
      owner: input.owner,
      invocationId: input.owner,
      executionGeneration: nextGeneration,
    },
    run: {
      ...run,
      execution_generation: nextGeneration,
      execution_owner: input.owner,
      updated_at: nowSec,
    },
    readyToClaimMs: Math.max(0, Date.now() - run.updated_at * 1_000),
    reclaimed,
  };
}

export async function heartbeatV9Continuation(
  db: D1Database,
  fence: V9EvalQueueFence,
): Promise<boolean> {
  const result = await runWithOverloadRetry(() =>
    db.prepare(
      `UPDATE v9_eval_queue_executions
          SET updated_at = MAX(updated_at, ?)
        WHERE delivery_id = ?
          AND execution_owner = ?
          AND execution_generation = ?
          AND state = 'running'
          AND deadline_ms > ?`,
    ).bind(
      Math.floor(Date.now() / 1_000),
      fence.deliveryId,
      fence.owner,
      fence.executionGeneration,
      Date.now(),
    ).run(),
  );
  return result.meta.changes === 1;
}

export async function finishV9Continuation(
  db: D1Database,
  fence: V9EvalQueueFence,
  status: "ok" | "degraded" | "error",
  failureReason: string | null,
  metadata: unknown,
): Promise<boolean> {
  const nowSec = Math.floor(Date.now() / 1_000);
  const result = await runWithOverloadRetry(() =>
    db.prepare(
      `UPDATE v9_eval_queue_executions
          SET state = 'finished',
              result_status = ?,
              failure_reason = ?,
              finished_at = ?,
              updated_at = ?,
              metadata = ?
        WHERE delivery_id = ?
          AND execution_owner = ?
          AND execution_generation = ?
          AND state = 'running'`,
    ).bind(
      status,
      failureReason === null ? null : failureReason.slice(0, 500),
      nowSec,
      nowSec,
      JSON.stringify(metadata),
      fence.deliveryId,
      fence.owner,
      fence.executionGeneration,
    ).run(),
  );
  return result.meta.changes === 1;
}

export function buildNextV9ContinuationMessage(
  run: Pick<
    V9EvalRunRow,
    | "run_id"
    | "slot_started_at"
    | "stage"
    | "next_chunk_index"
    | "quarantine_epoch"
    | "execution_generation"
    | "evaluation_build_digest"
    | "registry_fingerprint"
    | "policy_digest"
  >,
  sourceInvocationId: string,
  attemptNo = 1,
): V9ContinuationMessage | null {
  if (run.stage === "evaluating") {
    return {
      version: 1,
      runId: run.run_id,
      scheduleKey: "v9PublicationOffset",
      slotStartedAt: run.slot_started_at,
      stage: "eval",
      chunkIndex: run.next_chunk_index,
      quarantineEpoch: run.quarantine_epoch,
      attemptNo,
      executionGeneration: run.execution_generation,
      sourceInvocationId,
      evaluationBuildDigest: run.evaluation_build_digest,
      registryFingerprint: run.registry_fingerprint,
      policyDigest: run.policy_digest,
    };
  }
  if (run.stage === "committing") {
    return {
      version: 1,
      runId: run.run_id,
      scheduleKey: "v9PublicationOffset",
      slotStartedAt: run.slot_started_at,
      stage: "commit",
      chunkIndex: null,
      quarantineEpoch: run.quarantine_epoch,
      attemptNo,
      executionGeneration: run.execution_generation,
      sourceInvocationId,
      evaluationBuildDigest: run.evaluation_build_digest,
      registryFingerprint: run.registry_fingerprint,
      policyDigest: run.policy_digest,
    };
  }
  if (run.stage === "materializing") {
    return {
      version: 1,
      runId: run.run_id,
      scheduleKey: "v9PublicationOffset",
      slotStartedAt: run.slot_started_at,
      stage: "materialize",
      chunkIndex: null,
      quarantineEpoch: run.quarantine_epoch,
      attemptNo,
      executionGeneration: run.execution_generation,
      sourceInvocationId,
      evaluationBuildDigest: run.evaluation_build_digest,
      registryFingerprint: run.registry_fingerprint,
      policyDigest: run.policy_digest,
    };
  }
  return null;
}
