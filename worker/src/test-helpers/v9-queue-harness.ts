import { vi } from "vitest";
import { computePegScore } from "@shared/lib/peg-score";
import { buildSafetyScoreV9InputIdentity } from "@shared/lib/safety-score-v9-input-identity";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { V9_CONTINUATION_QUEUE_NAME, type V9ContinuationMessage } from "@shared/types/v9-continuation";
import { handleV9ContinuationBatch } from "../handlers/v9-continuation";
import type { HeavyEnv } from "../lib/env";
import { buildSafetyScoreV9CaptureControl, SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY } from "../lib/safety-score-v9/capture-control";
import { currentV9PolicyDigestForClock } from "../lib/safety-score-v9/chunked-eval-pipeline";
import { buildNativeV9InputCacheEntry, NATIVE_V9_INPUT_CACHE_KEY, normalizeNativeV9Input, type NativeSafetyScoreV9Input } from "../lib/safety-score-v9/native-input";
import { buildSafetyScoreV9PegProvenanceSeedCacheEntry, captureSafetyScoreV9PegProvenanceById, SAFETY_SCORE_V9_PEG_PROVENANCE_SEED_CACHE_KEY } from "../lib/safety-score-v9/peg-provenance";

export const V9_QUEUE_TEST_WORKER_VERSION = "worker-v9-queue-test";
export const V9_QUEUE_TEST_WORKER_META = { id: V9_QUEUE_TEST_WORKER_VERSION, tag: "", timestamp: "2026-11-25T12:00:00Z" };

export function makePublishableV9Input(raw: NativeSafetyScoreV9Input): NativeSafetyScoreV9Input {
  const { baseInputGenerationId: _old, ...rest } = raw;
  const prep = normalizeNativeV9Input({
    ...rest,
    v9PublicationInputHealth: {
      dex: { state: "current", generationId: raw.dexGenerationId, updatedAtSec: raw.clockSec - 100 },
      redemption: { state: "not-applicable", generationId: null, updatedAtSec: null },
      liveReserves: { state: "available", coverageRatio: 1 },
    },
  });
  for (const peg of Object.values(prep.pegDataById)) {
    Object.assign(peg, computePegScore([], peg.historyCoverage!.startedAt!, raw.clockSec));
  }
  const { baseInputGenerationId: _b, ...finalPayload } = prep;
  return normalizeNativeV9Input(finalPayload);
}

export interface PreparedV9SeedPayload {
  input: NativeSafetyScoreV9Input;
  fixedValue: string;
  pegValue: string;
  controlJson: string;
  dexUpdatedAt: number;
}

export async function prepareV9SeedPayload(
  input: NativeSafetyScoreV9Input,
  workerVersion = V9_QUEUE_TEST_WORKER_VERSION,
): Promise<PreparedV9SeedPayload> {
  const id = buildSafetyScoreV9InputIdentity({
    methodologyVersion: input.methodologyVersion,
    baseInputGenerationId: input.baseInputGenerationId,
    publicationGenerationId: input.sourceGeneration,
  });
  const fixedEntry = await buildNativeV9InputCacheEntry(input, id);
  const pegEntry = buildSafetyScoreV9PegProvenanceSeedCacheEntry({
    sourceGeneration: input.sourceGeneration,
    clockSec: input.clockSec,
    safetyScoreIdentity: id,
    pegProvenanceById: captureSafetyScoreV9PegProvenanceById(input, { clockSec: input.clockSec, eventsByCoin: new Map() }),
  });
  const control = buildSafetyScoreV9CaptureControl({
    safetyScoreIdentity: id,
    baseInputGenerationId: input.baseInputGenerationId,
    sourceGeneration: input.sourceGeneration,
    clockSec: input.clockSec,
    registryFingerprint: input.registryFingerprint,
    workerVersion,
    workerUploadedAtSec: input.clockSec - 60,
  }, input.clockSec);
  return {
    input,
    fixedValue: fixedEntry.value,
    pegValue: pegEntry.value,
    controlJson: JSON.stringify(control),
    dexUpdatedAt: input.inputFreshness.dexLiquidity.updatedAt ?? input.clockSec - 100,
  };
}

export async function seedPreparedV9Db(db: D1Database, payload: PreparedV9SeedPayload): Promise<void> {
  const { input, fixedValue, pegValue, controlJson, dexUpdatedAt } = payload;
  await db.batch([
    db.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)").bind("stablecoins", "{}", input.updatedAt),
    db.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)").bind(NATIVE_V9_INPUT_CACHE_KEY, fixedValue, input.clockSec),
    db.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)").bind(SAFETY_SCORE_V9_PEG_PROVENANCE_SEED_CACHE_KEY, pegValue, input.clockSec),
    db.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)").bind(SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY, controlJson, input.clockSec),
    db.prepare(`INSERT OR REPLACE INTO dex_liquidity_publication_generations
      (generation_id, started_at, state, expected_row_count, written_row_count, current_row_count, created_at, published_at)
      VALUES (?, ?, 'published', ?, ?, ?, ?, ?)`)
      .bind(input.dexGenerationId, dexUpdatedAt, ACTIVE_STABLECOINS.length, ACTIVE_STABLECOINS.length, ACTIVE_STABLECOINS.length, dexUpdatedAt, dexUpdatedAt),
    ...ACTIVE_STABLECOINS.map((c) => db.prepare("INSERT OR REPLACE INTO dex_liquidity (stablecoin_id, symbol, updated_at, publication_generation_id) VALUES (?, ?, ?, ?)")
      .bind(c.id, c.symbol, dexUpdatedAt, input.dexGenerationId)),
  ]);
}

export async function deliverV9Continuation(
  db: D1Database,
  message: unknown,
  opts: {
    deliveryId?: string;
    attempts?: number;
    mode?: "on" | "off";
    workerVersion?: string | null;
    onBeforeEvaluateAsset?: (assetId: string, index: number, quarantineEpoch: number) => void;
  } = {},
) {
  const sent: V9ContinuationMessage[] = [];
  const ver = opts.workerVersion === undefined ? V9_QUEUE_TEST_WORKER_VERSION : opts.workerVersion;
  const env = {
    DB: db,
    CF_VERSION_METADATA: ver === null ? undefined : { id: ver, tag: "", timestamp: "2026-11-25T12:00:00Z" },
    WORKER_V9_QUEUE_MODE: opts.mode ?? "on",
    SAFETY_V9_DEFERRED_MATERIALIZATION: "on",
    V9_CONTINUATION_QUEUE: { send: vi.fn(async (body: V9ContinuationMessage) => { sent.push(body); }), sendBatch: vi.fn() },
  } as unknown as HeavyEnv;
  const ack = vi.fn();
  const retry = vi.fn();
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: vi.fn((p: Promise<unknown>) => { waits.push(p); }), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  const m = message as Partial<V9ContinuationMessage>;
  await handleV9ContinuationBatch({
    queue: V9_CONTINUATION_QUEUE_NAME,
    messages: [{
      id: opts.deliveryId ?? `d-${m.runId ?? "r"}-${m.stage ?? "x"}-${m.chunkIndex ?? "n"}-e${m.quarantineEpoch ?? 0}-g${m.executionGeneration ?? 0}`,
      timestamp: new Date(),
      body: message,
      attempts: opts.attempts ?? 1,
      ack,
      retry,
    }],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>, env, ctx, Date.now(), { onBeforeEvaluateAsset: opts.onBeforeEvaluateAsset });
  await Promise.allSettled(waits);
  return { acked: ack.mock.calls.length > 0, retried: retry.mock.calls.length > 0, sent };
}

export async function countRows(db: D1Database, sql: string, ...binds: unknown[]): Promise<number> {
  const row = await db.prepare(sql).bind(...binds).first<{ c: number }>();
  return row?.c ?? 0;
}

export async function insertSyntheticV9Exec(
  db: D1Database,
  msg: V9ContinuationMessage,
  deliveryId: string,
  state: "running" | "finished",
  resultStatus: string | null,
  deadlineMs: number,
): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1_000);
  await db.prepare(`INSERT INTO v9_eval_queue_executions
    (delivery_id, run_id, schedule_key, slot_started_at, stage, chunk_index, quarantine_epoch, attempt_no,
     source_invocation_id, execution_owner, execution_generation, invocation_id, worker_version, state,
     started_at, updated_at, deadline_ms, finished_at, result_status)
    VALUES (?, ?, 'v9PublicationOffset', ?, ?, ?, ?, 1, 'src', 'prev-owner', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      deliveryId, msg.runId, msg.slotStartedAt, msg.stage, msg.chunkIndex, msg.quarantineEpoch, msg.executionGeneration,
      `inv-${deliveryId}`, V9_QUEUE_TEST_WORKER_VERSION, state, nowSec - 5, nowSec - 4, deadlineMs,
      state === "finished" ? nowSec - 3 : null, resultStatus,
    ).run();
}

export async function insertSyntheticV9Run(
  db: D1Database,
  runId: string,
  createdAt: number,
  registryFingerprint: string,
  overrides: { evalDigest?: string; workerVersion?: string } = {},
): Promise<void> {
  await db.prepare(`INSERT INTO v9_eval_runs
    (run_id, schema_version, schedule_key, slot_started_at, clock_sec, source_generation, base_input_generation_id,
     registry_fingerprint, evaluation_build_digest, plan_digest, policy_digest, quarantine_epoch, chunk_count,
     next_chunk_index, materialize_step_count, next_materialize_step, stage, state, execution_generation,
     execution_owner, worker_version, created_at, updated_at)
    VALUES (?, 1, 'v9PublicationOffset', ?, ?, 'src', 'base', ?, ?, ?, ?, 0, 2, 0, 1, 0, 'evaluating', 'active', 1, 'owner', ?, ?, ?)`)
    .bind(
      runId, createdAt, createdAt, registryFingerprint, overrides.evalDigest ?? "f".repeat(64),
      "c".repeat(64), currentV9PolicyDigestForClock(createdAt), overrides.workerVersion ?? V9_QUEUE_TEST_WORKER_VERSION,
      createdAt, createdAt,
    ).run();
}
