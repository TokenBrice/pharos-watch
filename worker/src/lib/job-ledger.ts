import type {
  WorkerJobAttemptState,
  WorkerJobAttemptStatus,
  WorkerJobAttemptStatusClass,
} from "@shared/types/status";
import { CronJobAbandonedError } from "./cron-lease-primitives";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { toErrorMessage } from "./error-utils";
import { boundedJson, parseObjectMetadata } from "./json-metadata";
import { logWorkerEvent } from "./structured-log";

export type WorkerJobLedgerMode = "off" | "shadow" | "write";

export interface WorkerJobAttemptIdentity {
  attemptId: string;
  idempotencyKey: string;
  attemptNo: number;
}

export interface CreateWorkerJobAttemptInput {
  scheduleKey: string;
  job: string;
  slotStartedAt: number | null;
  producerKind?: string;
  attemptNo?: number;
  nowSec?: number;
}

export interface FinishWorkerJobAttemptInput {
  attemptId: string;
  startedAtMs: number;
  result?: WorkerJobAttemptCronResult | void;
  error?: unknown;
  nowSec?: number;
}

export interface WorkerJobAttemptCronResult {
  itemCount?: number;
  metadata?: string;
  status?: "ok" | "degraded" | "error" | "skipped_locked" | "skipped_neutral";
  error?: string;
}

export interface WorkerJobAttemptProgressUpdate {
  stage?: string | null;
  itemsDone?: number | null;
  itemsTotal?: number | null;
  message?: string | null;
  leaseOwner?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface WorkerJobAttemptHealth {
  latestByJob: Map<string, WorkerJobAttemptStatus>;
  activeAttempts: number;
  staleAttempts: number;
  queryFailed: boolean;
}

interface WorkerJobAttemptRow {
  attempt_id: string;
  idempotency_key: string;
  schedule_key: string;
  job: string;
  slot_started_at: number | null;
  producer_kind: string;
  state: WorkerJobAttemptState;
  status_class: WorkerJobAttemptStatusClass | null;
  attempt_no: number;
  owner: string | null;
  lease_until: number | null;
  queued_at: number;
  claimed_at: number | null;
  started_at: number | null;
  last_heartbeat_at: number | null;
  finished_at: number | null;
  updated_at: number;
  duration_ms: number | null;
  item_count: number | null;
  result_metadata_json: string | null;
  error: string | null;
}

interface WorkerJobAttemptSummaryRow {
  active_count: number | null;
  stale_count: number | null;
}

const ACTIVE_ATTEMPT_STATES: WorkerJobAttemptState[] = ["queued", "claimed", "running"];
const TERMINAL_ATTEMPT_STATES: WorkerJobAttemptState[] = [
  "completed",
  "deferred",
  "abandoned",
  "failed",
  "skipped_locked",
  "cancelled",
];
const WORKER_JOB_ATTEMPT_STALE_SEC = 35 * 60;
const MAX_ATTEMPT_METADATA_JSON_CHARS = 16_000;
const D1_MAX_BOUND_PARAMETERS = 100;

const ATTEMPT_COLUMNS = [
  "attempt_id",
  "idempotency_key",
  "schedule_key",
  "job",
  "slot_started_at",
  "producer_kind",
  "state",
  "status_class",
  "attempt_no",
  "owner",
  "lease_until",
  "queued_at",
  "claimed_at",
  "started_at",
  "last_heartbeat_at",
  "finished_at",
  "updated_at",
  "duration_ms",
  "item_count",
  "result_metadata_json",
  "error",
].join(", ");

export function normalizeWorkerJobLedgerMode(value: string | undefined): WorkerJobLedgerMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "shadow" || normalized === "write") return normalized;
  return "off";
}

export function shouldRecordWorkerJobAttempt(input: {
  mode: WorkerJobLedgerMode;
  allowlist: readonly string[];
  job: string;
}): boolean {
  if (input.mode === "off") return false;
  if (input.allowlist.length === 0) return true;
  return input.allowlist.includes("*") || input.allowlist.includes(input.job);
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function buildWorkerJobAttemptIdentity(input: CreateWorkerJobAttemptInput): WorkerJobAttemptIdentity {
  const attemptNo = input.attemptNo ?? 1;
  const producerKind = input.producerKind ?? "scheduled-slot";
  const slotKey = input.slotStartedAt == null ? "none" : String(input.slotStartedAt);
  const idempotencyKey = `${producerKind}|${input.scheduleKey}|${slotKey}|${input.job}|${attemptNo}`;
  return {
    attemptId: `attempt|${idempotencyKey}`,
    idempotencyKey,
    attemptNo,
  };
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> | undefined {
  return parseObjectMetadata(value);
}

function cronResultMetadata(result: WorkerJobAttemptCronResult | void): Record<string, unknown> | undefined {
  if (!result?.metadata) return undefined;
  return parseJsonObject(result.metadata);
}

function normalizeResultMetadata(result: WorkerJobAttemptCronResult | void): string | null {
  if (!result?.metadata) return null;
  const parsed = parseJsonObject(result.metadata);
  return boundedJson(
    parsed ?? { raw: result.metadata.slice(0, MAX_ATTEMPT_METADATA_JSON_CHARS) },
    MAX_ATTEMPT_METADATA_JSON_CHARS,
  );
}

function hasDeferredMetadata(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  return (
    metadata.deferred === true ||
    metadata.runBudgetTruncated === true ||
    metadata.runtimeBudgetReached === true ||
    metadata.subrequestBudgetReached === true ||
    metadata.budgetTruncated === true
  );
}

function classifyCronResult(result: WorkerJobAttemptCronResult | void): {
  state: WorkerJobAttemptState;
  statusClass: WorkerJobAttemptStatusClass;
} {
  const metadata = cronResultMetadata(result);
  if (result?.status === "skipped_locked") {
    return { state: "skipped_locked", statusClass: "skipped_locked" };
  }
  if (result?.status === "skipped_neutral") {
    return { state: "completed", statusClass: "ok" };
  }
  if (hasDeferredMetadata(metadata)) {
    return { state: "deferred", statusClass: "deferred" };
  }
  if (result?.status === "error") {
    return { state: "failed", statusClass: "controlled_error" };
  }
  if (result?.status === "degraded") {
    return { state: "completed", statusClass: "degraded" };
  }
  return { state: "completed", statusClass: "ok" };
}

function progressMetadata(update: WorkerJobAttemptProgressUpdate): string | null {
  return boundedJson({
    progress: {
      ...(update.stage !== undefined ? { stage: update.stage } : {}),
      ...(update.itemsDone !== undefined ? { itemsDone: update.itemsDone } : {}),
      ...(update.itemsTotal !== undefined ? { itemsTotal: update.itemsTotal } : {}),
      ...(update.message !== undefined ? { message: update.message } : {}),
      ...(update.leaseOwner !== undefined ? { leaseOwner: update.leaseOwner } : {}),
      ...(update.metadata !== undefined ? { metadata: update.metadata } : {}),
    },
  }, MAX_ATTEMPT_METADATA_JSON_CHARS);
}

function terminalStateSql(): string {
  return TERMINAL_ATTEMPT_STATES.map(() => "?").join(",");
}

function activeStateSql(): string {
  return ACTIVE_ATTEMPT_STATES.map(() => "?").join(",");
}

function buildAttemptInClause(values: readonly unknown[]): { sql: string; binds: unknown[] } {
  if (values.length === 0) throw new Error("buildAttemptInClause: empty array");
  if (values.length > D1_MAX_BOUND_PARAMETERS) {
    throw new Error(
      `buildAttemptInClause: ${values.length} values exceeds D1 bound-parameter limit ${D1_MAX_BOUND_PARAMETERS}`,
    );
  }
  return {
    sql: values.map(() => "?").join(","),
    binds: [...values],
  };
}

function isMissingWorkerJobAttemptsTable(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes("no such table") && message.includes("worker_job_attempts");
}

function mapAttemptRow(row: WorkerJobAttemptRow, now: number): WorkerJobAttemptStatus {
  const heartbeatAt = row.last_heartbeat_at ?? row.started_at ?? row.claimed_at ?? row.queued_at;
  const leaseExpired = row.lease_until != null && row.lease_until < now;
  const heartbeatStale = ACTIVE_ATTEMPT_STATES.includes(row.state) && now - heartbeatAt >= WORKER_JOB_ATTEMPT_STALE_SEC;
  const metadata = parseJsonObject(row.result_metadata_json);
  return {
    attemptId: row.attempt_id,
    idempotencyKey: row.idempotency_key,
    scheduleKey: row.schedule_key,
    job: row.job,
    slotStartedAt: row.slot_started_at,
    producerKind: row.producer_kind,
    state: row.state,
    statusClass: row.status_class,
    attemptNo: row.attempt_no,
    owner: row.owner,
    leaseUntil: row.lease_until ?? null,
    queuedAt: row.queued_at,
    claimedAt: row.claimed_at,
    startedAt: row.started_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
    durationMs: row.duration_ms,
    itemCount: row.item_count,
    stale: ACTIVE_ATTEMPT_STATES.includes(row.state) && (leaseExpired || heartbeatStale),
    error: row.error,
    ...(metadata ? { metadata } : {}),
  };
}

export async function createWorkerJobAttempt(
  db: D1Database,
  input: CreateWorkerJobAttemptInput,
): Promise<WorkerJobAttemptIdentity> {
  const timestamp = input.nowSec ?? nowSec();
  const producerKind = input.producerKind ?? "scheduled-slot";
  const identity = buildWorkerJobAttemptIdentity(input);
  await runWithOverloadRetry(() =>
    db
      .prepare(
        `INSERT OR IGNORE INTO worker_job_attempts
           (attempt_id, idempotency_key, schedule_key, job, slot_started_at, producer_kind, state, status_class,
            attempt_no, queued_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?, ?, ?)`,
      )
      .bind(
        identity.attemptId,
        identity.idempotencyKey,
        input.scheduleKey,
        input.job,
        input.slotStartedAt,
        producerKind,
        identity.attemptNo,
        timestamp,
        timestamp,
        timestamp,
      )
      .run(),
  );
  return identity;
}

export async function recordWorkerJobAttemptLease(
  db: D1Database,
  input: { attemptId: string; owner: string; leaseUntil: number; nowSec?: number },
): Promise<void> {
  const timestamp = input.nowSec ?? nowSec();
  await runWithOverloadRetry(() =>
    db
      .prepare(
        `UPDATE worker_job_attempts
            SET state = 'running',
                owner = ?,
                lease_until = ?,
                claimed_at = COALESCE(claimed_at, ?),
                started_at = COALESCE(started_at, ?),
                last_heartbeat_at = ?,
                updated_at = ?
          WHERE attempt_id = ?
            AND state NOT IN (${terminalStateSql()})`,
      )
      .bind(
        input.owner,
        input.leaseUntil,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
        input.attemptId,
        ...TERMINAL_ATTEMPT_STATES,
      )
      .run(),
  );
}

export async function heartbeatWorkerJobAttempt(
  db: D1Database,
  input: { attemptId: string; progress: WorkerJobAttemptProgressUpdate; nowSec?: number },
): Promise<void> {
  const timestamp = input.nowSec ?? nowSec();
  const itemsDone = input.progress.itemsDone;
  await runWithOverloadRetry(() =>
    db
      .prepare(
        `UPDATE worker_job_attempts
            SET last_heartbeat_at = ?,
                updated_at = ?,
                item_count = COALESCE(?, item_count),
                result_metadata_json = COALESCE(?, result_metadata_json)
          WHERE attempt_id = ?
            AND state IN (${activeStateSql()})`,
      )
      .bind(
        timestamp,
        timestamp,
        typeof itemsDone === "number" && Number.isFinite(itemsDone) ? itemsDone : null,
        progressMetadata(input.progress),
        input.attemptId,
        ...ACTIVE_ATTEMPT_STATES,
      )
      .run(),
  );
}

export async function finishWorkerJobAttempt(
  db: D1Database,
  input: FinishWorkerJobAttemptInput,
): Promise<void> {
  const timestamp = input.nowSec ?? nowSec();
  const durationMs = Math.max(0, Date.now() - input.startedAtMs);
  const classification = input.error
    ? input.error instanceof CronJobAbandonedError
      ? { state: "abandoned" as const, statusClass: "abandoned" as const }
      : { state: "failed" as const, statusClass: "thrown_error" as const }
    : classifyCronResult(input.result);
  const resultMetadataJson = input.error instanceof CronJobAbandonedError
    ? boundedJson(input.error.metadata, MAX_ATTEMPT_METADATA_JSON_CHARS)
    : normalizeResultMetadata(input.result);
  const error = input.error
    ? toErrorMessage(input.error)
    : input.result?.error ?? null;
  await runWithOverloadRetry(() =>
    db
      .prepare(
        `UPDATE worker_job_attempts
            SET state = ?,
                status_class = ?,
                finished_at = ?,
                duration_ms = ?,
                item_count = COALESCE(?, item_count),
                result_metadata_json = COALESCE(?, result_metadata_json),
                error = ?,
                updated_at = ?
          WHERE attempt_id = ?
            AND state NOT IN (${terminalStateSql()})`,
      )
      .bind(
        classification.state,
        classification.statusClass,
        timestamp,
        durationMs,
        input.result?.itemCount ?? null,
        resultMetadataJson,
        error,
        timestamp,
        input.attemptId,
        ...TERMINAL_ATTEMPT_STATES,
      )
      .run(),
  );
}

export async function markWorkerJobAttemptsAbandonedForSlot(
  db: D1Database,
  input: {
    scheduleKey: string;
    slotStartedAt: number;
    jobs: readonly string[];
    nowSec?: number;
    error: string;
    metadata?: Record<string, unknown>;
  },
): Promise<number> {
  if (input.jobs.length === 0) return 0;
  const timestamp = input.nowSec ?? nowSec();
  const jobInClause = buildAttemptInClause(input.jobs);
  const result = await runWithOverloadRetry(() =>
    db
      .prepare(
        `UPDATE worker_job_attempts
            SET state = 'abandoned',
                status_class = 'abandoned',
                finished_at = ?,
                error = ?,
                result_metadata_json = COALESCE(?, result_metadata_json),
                updated_at = ?
          WHERE schedule_key = ?
            AND slot_started_at = ?
            AND job IN (${jobInClause.sql})
            AND state IN (${activeStateSql()})`,
      )
      .bind(
        timestamp,
        input.error,
        boundedJson(input.metadata, MAX_ATTEMPT_METADATA_JSON_CHARS),
        timestamp,
        input.scheduleKey,
        input.slotStartedAt,
        ...jobInClause.binds,
        ...ACTIVE_ATTEMPT_STATES,
      )
      .run(),
  );
  return result.meta.changes ?? 0;
}

export async function pruneWorkerJobAttempts(
  db: D1Database,
  cutoffSec: number,
  signal?: AbortSignal,
): Promise<number> {
  try {
    const result = await runWithOverloadRetry(() =>
      db
        .prepare(
          `DELETE FROM worker_job_attempts
            WHERE updated_at < ?
              AND state IN (${terminalStateSql()})`,
        )
        .bind(cutoffSec, ...TERMINAL_ATTEMPT_STATES)
        .run(),
      3,
      signal,
    );
    return result.meta.changes ?? 0;
  } catch (err) {
    if (isMissingWorkerJobAttemptsTable(err)) return 0;
    throw err;
  }
}

export async function loadWorkerJobAttemptHealth(
  db: D1Database,
  jobs: readonly string[],
  now: number,
): Promise<WorkerJobAttemptHealth> {
  if (jobs.length === 0) {
    return { latestByJob: new Map(), activeAttempts: 0, staleAttempts: 0, queryFailed: false };
  }
  const jobInClause = buildAttemptInClause(jobs);
  try {
    const [latestRows, summaryRow] = await Promise.all([
      db
        .prepare(
          `SELECT ${ATTEMPT_COLUMNS}
             FROM (
               SELECT ${ATTEMPT_COLUMNS},
                      ROW_NUMBER() OVER (PARTITION BY job ORDER BY updated_at DESC, queued_at DESC) AS attempt_rank
                 FROM worker_job_attempts
                WHERE job IN (${jobInClause.sql})
             )
            WHERE attempt_rank = 1
            ORDER BY updated_at DESC
            LIMIT ?`,
        )
        .bind(...jobInClause.binds, jobs.length)
        .all<WorkerJobAttemptRow>(),
      db
        .prepare(
          `SELECT
             COUNT(*) AS active_count,
             SUM(CASE
               WHEN (lease_until IS NOT NULL AND lease_until < ?)
                 OR COALESCE(last_heartbeat_at, started_at, claimed_at, queued_at) < ?
               THEN 1 ELSE 0 END) AS stale_count
             FROM worker_job_attempts
            WHERE state IN (${activeStateSql()})`,
        )
        .bind(now, now - WORKER_JOB_ATTEMPT_STALE_SEC, ...ACTIVE_ATTEMPT_STATES)
        .first<WorkerJobAttemptSummaryRow>(),
    ]);

    const latestByJob = new Map<string, WorkerJobAttemptStatus>();
    for (const row of latestRows.results ?? []) {
      latestByJob.set(row.job, mapAttemptRow(row, now));
    }
    return {
      latestByJob,
      activeAttempts: summaryRow?.active_count ?? 0,
      staleAttempts: summaryRow?.stale_count ?? 0,
      queryFailed: false,
    };
  } catch (err) {
    logWorkerEvent({
      scope: "status",
      level: "warn",
      event: "worker_job_attempts_unavailable",
      route: "status",
      source: "worker_job_attempts",
      message: "Worker job attempt ledger unavailable",
      error: err,
    });
    return { latestByJob: new Map(), activeAttempts: 0, staleAttempts: 0, queryFailed: true };
  }
}
