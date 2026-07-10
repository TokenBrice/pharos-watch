import { sleep } from "./abort";
import {
  CRON_ABANDONED_JOB_GRACE_MS,
  CronJobAbandonedError,
  CronTimeoutError,
  cacheKeySegment,
  getCronTimeoutBudgetMetadata,
  resolveCronTimeoutBudget,
  runWithOverloadRetry,
  type ResolvedCronTimeoutBudget,
} from "./cron-lease";
import { setCache } from "./db-cache";
import { stripSensitive } from "./safe-error-message";

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
const MAX_CRON_EVENT_METADATA_DEPTH = 3;

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

  const cacheKey = `${CRON_EVENT_CACHE_PREFIX}:${cacheKeySegment(record.job)}:${cacheKeySegment(record.eventType)}`;
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
   * abort builders (see `buildAbortedCronStageResult`). Lets `isAbortResult`
   * identify the abort sentinel without relying on the absence of fields from
   * other stage result shapes.
   */
  aborted?: true;
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
           metadata = excluded.metadata`,
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

async function clearCronProgress(db: D1Database, job: string): Promise<void> {
  await runWithOverloadRetry(() => db.prepare("DELETE FROM cron_run_progress WHERE job = ?").bind(job).run());
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
  alertFn?: (title: string, message: string) => Promise<unknown> | void,
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
  let resolvedResult: CronResult | void;
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
  const reportProgress: CronProgressReporter = async (update) => {
    progressActivated = true;
    progressState = {
      stage: update.stage === undefined ? progressState.stage : (update.stage ?? null),
      itemsDone: update.itemsDone === undefined ? progressState.itemsDone : (update.itemsDone ?? null),
      itemsTotal: update.itemsTotal === undefined ? progressState.itemsTotal : (update.itemsTotal ?? null),
      message: update.message === undefined ? progressState.message : (update.message ?? null),
      leaseOwner: update.leaseOwner === undefined ? progressState.leaseOwner : (update.leaseOwner ?? null),
      metadata: update.metadata === undefined ? progressState.metadata : (update.metadata ?? null),
    };
    try {
      await upsertCronProgress(db, job, startSec, slotStartedAt, progressState);
    } catch (err) {
      console.warn(`[db] Failed to upsert cron progress for ${job}:`, err);
    }
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
          resolvedResult?.metadata ?? null,
          slotStartedAt,
          resolvedResult?.error ?? null,
          cronRunIdempotencyKey,
        )
        .run(),
    );
    if (resultStatus === "error" && alertFn) {
      await Promise.resolve(
        alertFn(`Cron ${job} returned error status`, resolvedResult?.error ?? resolvedResult?.metadata ?? ""),
      ).catch(() => {});
    }
  } catch (e) {
    const terminalMetadata = serializeTerminalCronMetadata(e);
    try {
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
    } catch (logErr) {
      console.error(`[db] Failed to log cron error for ${job}:`, logErr);
    }
    // Alert on cron failure (non-blocking)
    if (alertFn) {
      void Promise.resolve(alertFn(`Cron failure: ${job}`, `Error: ${String(e).slice(0, 500)}`)).catch(() => {});
    }
    throw e;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (progressActivated) {
      try {
        await clearCronProgress(db, job);
      } catch (err) {
        console.warn(`[db] Failed to clear cron progress for ${job}:`, err);
      }
    }
    // TTL pruning is owned by the daily `prune-cron-history` cron (03:00 UTC).
  }
  return resolvedResult;
}
