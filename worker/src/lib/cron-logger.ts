import { sleep } from "./abort";
import {
  CRON_ABANDONED_JOB_GRACE_MS,
  CronJobAbandonedError,
  CronTimeoutError,
} from "./cron-lease-primitives";
import {
  getCronTimeoutBudgetMetadata,
  resolveCronTimeoutBudget,
  type ResolvedCronTimeoutBudget,
} from "./cron-timeouts";
import {
  runWithOverloadRetry,
} from "./d1-overload-retry";
import { setCache } from "./db-cache";
import {
  recordProducerOutcome,
  type CronProductivity,
  type ProducerIdentity,
  type ProducerOutcome,
} from "./producer-history";
import { stripSensitive } from "./safe-error-message";
import { compactCronMetadataForPersistence } from "./cron-metadata-persistence";
import { parseJsonObject } from "./json-parse";

// --- Cron failure recording ---
// `recordCronFailure` replaces ad-hoc `console.error(...)` in cron catch blocks
// where the job decides to swallow an exception (e.g. degrade rather than throw).
// It emits a single structured JSON line plus a human-readable prefix, and
// increments a per-isolate in-memory counter so callers can sample severity
// without touching D1. Non-terminal operational events that should survive
// log retention can use `logCronEvent`, which writes latest-event records to
// the existing cache table without requiring a migration.

const cronFailureCounts = new Map<string, number>();

function createCronRunIdempotencyKey(job: string, startMs: number): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const suffix = cryptoObj?.randomUUID?.() ?? `${startMs}-${Math.random().toString(36).slice(2)}`;
  return `cron-run:${job}:${suffix}`;
}

export interface CronFailureContext {
  /** Optional free-form metadata attached to the structured log. */
  metadata?: Record<string, unknown>;
}

export interface CronFailureRecord {
  job: string;
  errorName: string;
  errorMessage: string;
  failureCount: number;
}

function classifyError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: stripSensitive(error.message || String(error)),
      stack: error.stack ? stripSensitive(error.stack) : undefined,
    };
  }
  return { name: "NonError", message: stripSensitive(String(error)) };
}

function serializeTerminalCronMetadata(error: unknown): string | null {
  if (error instanceof CronJobAbandonedError) {
    return JSON.stringify(boundCronEventMetadataValue(error.metadata, 0));
  }
  if (error instanceof CronTimeoutError && error.metadata) {
    return JSON.stringify(boundCronEventMetadataValue(error.metadata, 0));
  }
  return null;
}

type CronJobOutcome =
  | { status: "fulfilled"; value: CronResult | void }
  | { status: "rejected"; error: unknown };

/**
 * Records a swallowed cron failure with a structured log line and in-memory
 * counter. Intended for `catch` blocks where the job chooses to degrade rather
 * than rethrow; for terminal exceptions, `logCronRun` already persists an
 * error row to `cron_runs`.
 */
export function recordCronFailure(
  jobName: string,
  error: unknown,
  context?: CronFailureContext,
): CronFailureRecord {
  const { name, message, stack } = classifyError(error);
  const failureCount = (cronFailureCounts.get(jobName) ?? 0) + 1;
  cronFailureCounts.set(jobName, failureCount);

  const payload: Record<string, unknown> = {
    event: "cron_failure",
    job: jobName,
    errorName: name,
    errorMessage: message.slice(0, 500),
    failureCount,
  };
  if (stack) payload.stack = stack.slice(0, 800);
  if (context?.metadata && Object.keys(context.metadata).length > 0) {
    payload.metadata = boundCronEventMetadata(context.metadata);
  }

  console.error(`[cron-failure:${jobName}] ${name}: ${message.slice(0, 200)}`, JSON.stringify(payload));

  return { job: jobName, errorName: name, errorMessage: message, failureCount };
}

/** Test-only: reset the in-memory failure counter. */
export function __resetCronFailureCountsForTests(): void {
  cronFailureCounts.clear();
}

export type CronEventSeverity = "info" | "warning" | "error";

export interface CronEventInput {
  job: string;
  eventType: string;
  severity?: CronEventSeverity;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface CronEventRecord {
  event: "cron_event";
  job: string;
  eventType: string;
  severity: CronEventSeverity;
  message: string;
  metadata?: Record<string, unknown>;
  recordedAt: number;
}

const CRON_EVENT_CACHE_PREFIX = "cron:event";
const MAX_CRON_EVENT_MESSAGE_CHARS = 500;
const MAX_CRON_EVENT_METADATA_STRING_CHARS = 500;
const MAX_CRON_EVENT_METADATA_KEYS = 30;
const MAX_CRON_EVENT_METADATA_ARRAY_ITEMS = 20;
const MAX_CRON_EVENT_METADATA_DEPTH = 4;

function cacheKeySegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (normalized || "unknown").slice(0, 96);
}

export function cronEventCacheKey(job: string, eventType: string): string {
  return `${CRON_EVENT_CACHE_PREFIX}:${cacheKeySegment(job)}:${cacheKeySegment(eventType)}`;
}

function boundCronEventMetadataValue(value: unknown, depth: number): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const sanitized = stripSensitive(value);
    return sanitized.length <= MAX_CRON_EVENT_METADATA_STRING_CHARS
      ? sanitized
      : `${sanitized.slice(0, MAX_CRON_EVENT_METADATA_STRING_CHARS)}...`;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: stripSensitive(value.message).slice(0, MAX_CRON_EVENT_METADATA_STRING_CHARS),
      ...(value.stack
        ? { stack: stripSensitive(value.stack).slice(0, MAX_CRON_EVENT_METADATA_STRING_CHARS) }
        : {}),
    };
  }
  if (depth >= MAX_CRON_EVENT_METADATA_DEPTH) {
    return "[truncated-depth]";
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_CRON_EVENT_METADATA_ARRAY_ITEMS)
      .map((item) => boundCronEventMetadataValue(item, depth + 1));
    if (value.length > MAX_CRON_EVENT_METADATA_ARRAY_ITEMS) {
      items.push(`[${value.length - MAX_CRON_EVENT_METADATA_ARRAY_ITEMS} more]`);
    }
    return items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const bounded: Record<string, unknown> = {};
    for (const [key, entryValue] of entries.slice(0, MAX_CRON_EVENT_METADATA_KEYS)) {
      bounded[key] = boundCronEventMetadataValue(entryValue, depth + 1);
    }
    if (entries.length > MAX_CRON_EVENT_METADATA_KEYS) {
      bounded.truncatedKeys = entries.length - MAX_CRON_EVENT_METADATA_KEYS;
    }
    return bounded;
  }
  return stripSensitive(String(value)).slice(0, MAX_CRON_EVENT_METADATA_STRING_CHARS);
}

function boundCronEventMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata || Object.keys(metadata).length === 0) return undefined;
  return boundCronEventMetadataValue(metadata, 0) as Record<string, unknown>;
}

function writeCronEventConsole(record: CronEventRecord): void {
  const prefix = `[cron-event:${record.job}] ${record.eventType}: ${record.message.slice(0, 200)}`;
  const payload = JSON.stringify(record);
  if (record.severity === "error") {
    console.error(prefix, payload);
  } else if (record.severity === "warning") {
    console.warn(prefix, payload);
  } else {
    console.log(prefix, payload);
  }
}

/**
 * Records a non-terminal cron event. The durable side is intentionally a
 * latest-event cache row keyed by job and event type, so callers can add
 * structured observability without a schema migration or cron run failure.
 */
export async function logCronEvent(db: D1Database, event: CronEventInput): Promise<CronEventRecord> {
  const record: CronEventRecord = {
    event: "cron_event",
    job: event.job,
    eventType: event.eventType,
    severity: event.severity ?? "info",
    message: stripSensitive(event.message).slice(0, MAX_CRON_EVENT_MESSAGE_CHARS),
    recordedAt: Math.floor(Date.now() / 1000),
    ...(event.metadata ? { metadata: boundCronEventMetadata(event.metadata) } : {}),
  };
  writeCronEventConsole(record);

  const cacheKey = cronEventCacheKey(record.job, record.eventType);
  try {
    await setCache(db, cacheKey, JSON.stringify(record));
  } catch (err) {
    const { message } = classifyError(err);
    console.warn(`[cron-event:${record.job}] Failed to persist ${record.eventType}: ${message.slice(0, 200)}`);
  }
  return record;
}

// --- Cron run logging types ---

export interface CronResult {
  itemCount?: number;
  metadata?: string;
  status?: "ok" | "degraded" | "error" | "skipped_locked" | "skipped_neutral";
  /** Human-readable failure summary persisted to cron_runs.error when present; preferred over metadata in the alert body for "error" statuses. */
  error?: string;
  /**
   * Affirmative discriminant set only on results produced by the cron-stage
   * abort builders (see `abortResult` in `sync-stablecoins/runtime.ts`). Lets `isAbortResult`
   * identify the abort sentinel without relying on the absence of fields from
   * other stage result shapes.
   */
  aborted?: true;
  /** Explicit productive-output/publication contract for durable producer history. */
  productivity?: CronProductivity;
}

export interface CronProgressUpdate {
  stage?: string | null;
  itemsDone?: number | null;
  itemsTotal?: number | null;
  message?: string | null;
  leaseOwner?: string | null;
  metadata?: Record<string, unknown> | null;
}

export type CronProgressReporter = (update: CronProgressUpdate) => Promise<void>;

export interface CronRunLoggerOptions {
  slotStartedAt?: number | null;
  timeoutBudget?: ResolvedCronTimeoutBudget;
  abortSignal?: AbortSignal;
  producer?: Omit<ProducerIdentity, "job">;
}

const NON_PRODUCTIVE_REASONS = new Set([
  "already_written_today",
  "already_written_today_before_freshness_gate",
  "cadence_bucket_completed",
  "cadence_bucket_in_progress",
  "circuit-open",
  "no-pending-request",
  "not-due-today",
]);

function inferCronProductivity(result: CronResult | null | void): CronProductivity {
  if (result?.productivity) return result.productivity;
  const status = result?.status ?? "ok";
  if (status === "error" || status === "skipped_locked" || status === "skipped_neutral") {
    return { productive: false, reason: status };
  }
  const metadata = parseJsonObject(result?.metadata);
  const reason = typeof metadata?.reason === "string" ? metadata.reason : null;
  if (reason && NON_PRODUCTIVE_REASONS.has(reason)) {
    return { productive: false, reason };
  }
  if (
    metadata?.cacheWriteMode === "skipped-newer"
    || metadata?.cacheWriteSucceeded === false
    || metadata?.lastWriteAdvanced === false
  ) {
    return { productive: false, reason: "canonical-write-not-advanced" };
  }
  if (metadata?.lastWriteAdvanced === true) {
    return { productive: true, reason: "canonical-write-advanced" };
  }
  if (metadata?.published === true || metadata?.publicationPointerWritten === true) {
    return { productive: true, reason: "publication-confirmed" };
  }
  if (typeof result?.itemCount === "number" && result.itemCount > 0) {
    return { productive: true, reason: "positive-item-count" };
  }
  return { productive: false, reason: reason ?? "no-productive-output" };
}

function producerOutcomeForResult(result: CronResult | null | void): ProducerOutcome {
  return result?.status ?? "ok";
}

function producerOutcomeForError(error: unknown): ProducerOutcome {
  return error instanceof CronJobAbandonedError ? "abandoned" : "error";
}

// --- Internal helpers ---

function serializeProgressMetadata(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata || Object.keys(metadata).length === 0) return null;
  return JSON.stringify(metadata);
}

async function upsertCronProgress(
  db: D1Database,
  job: string,
  startedAt: number,
  slotStartedAt: number | null,
  progress: Required<Omit<CronProgressUpdate, "metadata">> & { metadata: Record<string, unknown> | null },
): Promise<void> {
  const updatedAt = Math.floor(Date.now() / 1000);
  await runWithOverloadRetry(() =>
    db
      .prepare(
        `INSERT INTO cron_run_progress
           (job, started_at, slot_started_at, updated_at, stage, items_done, items_total, message, lease_owner, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job) DO UPDATE SET
           started_at = excluded.started_at,
           slot_started_at = excluded.slot_started_at,
           updated_at = excluded.updated_at,
           stage = excluded.stage,
           items_done = excluded.items_done,
           items_total = excluded.items_total,
           message = excluded.message,
           lease_owner = excluded.lease_owner,
           metadata = excluded.metadata
         WHERE cron_run_progress.lease_owner IS NULL
            OR cron_run_progress.lease_owner = excluded.lease_owner
            OR (
              excluded.lease_owner IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                  FROM cron_leases active_lease
                 WHERE active_lease.job = cron_run_progress.job
                   AND active_lease.lease_owner = cron_run_progress.lease_owner
                   AND active_lease.lease_until >= excluded.updated_at
              )
            )`,
      )
      .bind(
        job,
        startedAt,
        slotStartedAt,
        updatedAt,
        progress.stage,
        progress.itemsDone,
        progress.itemsTotal,
        progress.message,
        progress.leaseOwner,
        serializeProgressMetadata(progress.metadata),
      )
      .run(),
  );
}

async function clearCronProgress(
  db: D1Database,
  job: string,
  startedAt: number,
  slotStartedAt: number | null,
): Promise<void> {
  await runWithOverloadRetry(() =>
    db
      .prepare(
        `DELETE FROM cron_run_progress
          WHERE job = ? AND started_at = ? AND slot_started_at IS ?`,
      )
      .bind(job, startedAt, slotStartedAt)
      .run(),
  );
}

// --- Main cron run logger ---

/**
 * Wraps a cron job function with execution logging and an AbortController timeout.
 * Logs start time, duration, status, and optional item count to cron_runs table.
 * TTL pruning for cron_runs is owned by the daily `prune-cron-history` cron.
 */
export async function logCronRun(
  db: D1Database,
  job: string,
  fn: (signal: AbortSignal, reportProgress: CronProgressReporter) => Promise<CronResult | void>,
  options?: CronRunLoggerOptions,
): Promise<CronResult | void> {
  const startMs = Date.now();
  const startSec = Math.floor(startMs / 1000);
  const cronRunIdempotencyKey = createCronRunIdempotencyKey(job, startMs);
  const slotStartedAt = options?.slotStartedAt ?? null;
  const timeoutBudget = options?.timeoutBudget ?? resolveCronTimeoutBudget(job);
  const timeoutMs = timeoutBudget.effectiveTimeoutMs;
  const ac = new AbortController();
  const operationSignal = options?.abortSignal
    ? AbortSignal.any([ac.signal, options.abortSignal])
    : ac.signal;
  const timeoutError = new CronTimeoutError(job, timeoutMs, getCronTimeoutBudgetMetadata(timeoutBudget));
  let resolvedResult: CronResult | void = undefined;
  let persistingCompletedTelemetry = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let progressActivated = false;
  let progressState: Required<Omit<CronProgressUpdate, "metadata">> & { metadata: Record<string, unknown> | null } = {
    stage: "running",
    itemsDone: null,
    itemsTotal: null,
    message: null,
    leaseOwner: null,
    metadata: null,
  };
  let progressWriteTail = Promise.resolve();
  const reportProgress: CronProgressReporter = (update) => {
    progressActivated = true;
    progressState = {
      stage: update.stage === undefined ? progressState.stage : (update.stage ?? null),
      itemsDone: update.itemsDone === undefined ? progressState.itemsDone : (update.itemsDone ?? null),
      itemsTotal: update.itemsTotal === undefined ? progressState.itemsTotal : (update.itemsTotal ?? null),
      message: update.message === undefined ? progressState.message : (update.message ?? null),
      leaseOwner: update.leaseOwner === undefined ? progressState.leaseOwner : (update.leaseOwner ?? null),
      metadata: update.metadata === undefined ? progressState.metadata : (update.metadata ?? null),
    };
    const snapshot = { ...progressState };
    progressWriteTail = progressWriteTail.then(async () => {
      try {
        await upsertCronProgress(db, job, startSec, slotStartedAt, snapshot);
      } catch (err) {
        console.warn(`[db] Failed to upsert cron progress for ${job}:`, err);
      }
    });
    return progressWriteTail;
  };
  try {
    if (timeoutBudget.exhausted) {
      ac.abort(timeoutError);
      throw timeoutError;
    }

    const jobOutcomePromise: Promise<CronJobOutcome> = Promise.resolve()
      .then(() => fn(operationSignal, reportProgress))
      .then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error) => ({ status: "rejected" as const, error }),
      );
    const timeoutPromise = new Promise<{ type: "timeout"; error: CronTimeoutError }>((resolve) => {
      timeoutHandle = setTimeout(() => {
        ac.abort(timeoutError);
        resolve({ type: "timeout", error: timeoutError });
      }, timeoutMs);
    });

    const race = await Promise.race([
      jobOutcomePromise.then((outcome) => ({ type: "job" as const, outcome })),
      timeoutPromise,
    ]);
    if (race.type === "timeout") {
      const grace = await Promise.race([
        jobOutcomePromise.then((outcome) => ({ type: "job" as const, outcome })),
        sleep(CRON_ABANDONED_JOB_GRACE_MS + 250).then(() => ({ type: "abandoned" as const })),
      ]);

      if (grace.type === "abandoned") {
        throw new CronJobAbandonedError(job, race.error, {
          stopReason: "timeout",
          leaseOwner: null,
          renewFailures: null,
          leaseLost: null,
          ttlSec: null,
          graceMs: CRON_ABANDONED_JOB_GRACE_MS + 250,
          leaseHeldUntilTtl: false,
        });
      }
      if (grace.outcome.status === "rejected") {
        throw grace.outcome.error;
      }
      throw race.error;
    }

    if (race.outcome.status === "rejected") {
      throw race.outcome.error;
    }

    resolvedResult = race.outcome.value;
    const resultStatus = resolvedResult?.status ?? "ok";
    const completedAt = Math.floor(Date.now() / 1000);
    const productivity = inferCronProductivity(resolvedResult);
    const publicationCount = productivity.publications?.length ?? 0;
    const persistedMetadata = compactCronMetadataForPersistence(resolvedResult?.metadata).metadata;
    const producer = options?.producer;
    persistingCompletedTelemetry = true;
    if (producer) {
      await runWithOverloadRetry(() =>
        db.prepare(
          `INSERT INTO cron_runs
             (job, started_at, duration_ms, status, item_count, metadata, slot_started_at, error, idempotency_key,
              schedule_key, producer_path, producer_kind, invocation_id, worker_version,
              productive, publication_count, calendar_period)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        ).bind(
          job,
          startSec,
          Date.now() - startMs,
          resultStatus,
          resolvedResult?.itemCount ?? null,
          persistedMetadata,
          slotStartedAt,
          resolvedResult?.error ?? null,
          cronRunIdempotencyKey,
          producer.scheduleKey,
          producer.producerPath,
          producer.producerKind,
          producer.invocationId,
          producer.workerVersion ?? null,
          productivity.productive ? 1 : 0,
          publicationCount,
          producer.calendarPeriod ?? null,
        ).run(),
      );
      await recordProducerOutcome(db, {
        ...producer,
        job,
        idempotencyKey: cronRunIdempotencyKey,
        invokedAt: startSec,
        completedAt,
        outcome: producerOutcomeForResult(resolvedResult),
        itemCount: resolvedResult?.itemCount ?? null,
        metadata: persistedMetadata,
        error: resolvedResult?.error ?? null,
        productivity,
      });
    } else {
      await runWithOverloadRetry(() =>
        db
          .prepare(
            `INSERT INTO cron_runs
               (job, started_at, duration_ms, status, item_count, metadata, slot_started_at, error, idempotency_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT DO NOTHING`,
          )
          .bind(
            job,
            startSec,
            Date.now() - startMs,
            resultStatus,
            resolvedResult?.itemCount ?? null,
            persistedMetadata,
            slotStartedAt,
            resolvedResult?.error ?? null,
            cronRunIdempotencyKey,
          )
          .run(),
      );
    }
    persistingCompletedTelemetry = false;
  } catch (e) {
    if (persistingCompletedTelemetry) {
      const { name, message } = classifyError(e);
      console.error(`[db] Failed to persist completed cron result for ${job}: ${name}: ${message}`);
      return resolvedResult;
    }
    const terminalMetadata = compactCronMetadataForPersistence(serializeTerminalCronMetadata(e)).metadata;
    try {
      const completedAt = Math.floor(Date.now() / 1000);
      const producer = options?.producer;
      if (producer) {
        await runWithOverloadRetry(() =>
          db.prepare(
            `INSERT INTO cron_runs
               (job, started_at, duration_ms, status, error, metadata, slot_started_at, idempotency_key,
                schedule_key, producer_path, producer_kind, invocation_id, worker_version,
                productive, publication_count, calendar_period)
             VALUES (?, ?, ?, 'error', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
             ON CONFLICT(idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET
               status = 'error',
               error = excluded.error,
               metadata = COALESCE(excluded.metadata, cron_runs.metadata),
               productive = 0,
               publication_count = 0`,
          ).bind(
            job,
            startSec,
            Date.now() - startMs,
            String(e),
            terminalMetadata,
            slotStartedAt,
            cronRunIdempotencyKey,
            producer.scheduleKey,
            producer.producerPath,
            producer.producerKind,
            producer.invocationId,
            producer.workerVersion ?? null,
            producer.calendarPeriod ?? null,
          ).run(),
        );
        await recordProducerOutcome(db, {
          ...producer,
          job,
          idempotencyKey: cronRunIdempotencyKey,
          invokedAt: startSec,
          completedAt,
          outcome: producerOutcomeForError(e),
          itemCount: null,
          metadata: terminalMetadata,
          error: String(e),
          productivity: { productive: false, reason: producerOutcomeForError(e) },
        });
      } else {
        await runWithOverloadRetry(() =>
          db
            .prepare(
              `INSERT INTO cron_runs
                 (job, started_at, duration_ms, status, error, metadata, slot_started_at, idempotency_key)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT DO NOTHING`,
            )
            .bind(
              job,
              startSec,
              Date.now() - startMs,
              "error",
              String(e),
              terminalMetadata,
              slotStartedAt,
              cronRunIdempotencyKey,
            )
            .run(),
        );
      }
    } catch (logErr) {
      console.error(`[db] Failed to log cron error for ${job}:`, logErr);
    }
    throw e;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    await progressWriteTail;
    if (progressActivated) {
      try {
        await clearCronProgress(db, job, startSec, slotStartedAt);
      } catch (err) {
        console.warn(`[db] Failed to clear cron progress for ${job}:`, err);
      }
    }
    // TTL pruning is owned by the daily `prune-cron-history` cron (03:00 UTC).
  }
  return resolvedResult;
}
