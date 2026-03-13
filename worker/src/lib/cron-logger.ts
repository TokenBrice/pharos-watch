import { SECONDS } from "./time-constants";
import { sendAlert } from "./alerts";
import { CRON_TIMEOUT_MS, CronTimeoutError, DEFAULT_CRON_TIMEOUT_MS, runWithOverloadRetry } from "./cron-lease";

// --- Cron run logging types ---

export interface CronResult {
  itemCount?: number;
  metadata?: string;
  status?: "ok" | "degraded" | "error" | "skipped_locked";
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

// --- Internal helpers ---

function serializeProgressMetadata(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata || Object.keys(metadata).length === 0) return null;
  return JSON.stringify(metadata);
}

async function upsertCronProgress(
  db: D1Database,
  job: string,
  startedAt: number,
  progress: Required<Omit<CronProgressUpdate, "metadata">> & { metadata: Record<string, unknown> | null },
): Promise<void> {
  const updatedAt = Math.floor(Date.now() / 1000);
  await runWithOverloadRetry(() =>
    db
      .prepare(
        `INSERT INTO cron_run_progress
           (job, started_at, updated_at, stage, items_done, items_total, message, lease_owner, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job) DO UPDATE SET
           started_at = excluded.started_at,
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
 * Prunes rows older than 7 days after each insert.
 */
export async function logCronRun(
  db: D1Database,
  job: string,
  fn: (signal: AbortSignal, reportProgress: CronProgressReporter) => Promise<CronResult | void>,
  alertFn?: (title: string, message: string) => Promise<unknown> | void,
): Promise<CronResult | void> {
  const startMs = Date.now();
  const startSec = Math.floor(startMs / 1000);
  const timeoutMs = CRON_TIMEOUT_MS[job] ?? DEFAULT_CRON_TIMEOUT_MS;
  const ac = new AbortController();
  const timeoutError = new CronTimeoutError(job, timeoutMs);
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
      await upsertCronProgress(db, job, startSec, progressState);
    } catch (err) {
      console.warn(`[db] Failed to upsert cron progress for ${job}:`, err);
    }
  };
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      ac.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    resolvedResult = await Promise.race([fn(ac.signal, reportProgress), timeoutPromise]);
    const resultStatus = resolvedResult?.status ?? "ok";
    await runWithOverloadRetry(() =>
      db
        .prepare(
          "INSERT INTO cron_runs (job, started_at, duration_ms, status, item_count, metadata) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(
          job,
          startSec,
          Date.now() - startMs,
          resultStatus,
          resolvedResult?.itemCount ?? null,
          resolvedResult?.metadata ?? null,
        )
        .run(),
    );
    if (resultStatus === "error" && alertFn) {
      await Promise.resolve(alertFn(`Cron ${job} returned error status`, resolvedResult?.metadata ?? "")).catch(
        () => {},
      );
    }
  } catch (e) {
    try {
      await runWithOverloadRetry(() =>
        db
          .prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status, error) VALUES (?, ?, ?, ?, ?)")
          .bind(job, startSec, Date.now() - startMs, "error", String(e))
          .run(),
      );
    } catch (logErr) {
      console.error(`[db] Failed to log cron error for ${job}:`, logErr);
    }
    // Alert on cron failure (non-blocking)
    const emitFailureAlert = alertFn ? alertFn : sendAlert;
    void Promise.resolve(emitFailureAlert(`Cron failure: ${job}`, `Error: ${String(e).slice(0, 500)}`)).catch(() => {});
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
  }
  // Prune rows older than 7 days
  try {
    await db
      .prepare("DELETE FROM cron_runs WHERE started_at < ?")
      .bind(Math.floor(Date.now() / 1000) - SECONDS.ONE_WEEK)
      .run();
  } catch (e) {
    console.error("[db] Failed to prune old cron runs:", e);
    // Safety valve: if time-based prune fails, keep only most recent 5000 rows
    try {
      await db
        .prepare(
          "DELETE FROM cron_runs WHERE rowid NOT IN (SELECT rowid FROM cron_runs ORDER BY started_at DESC LIMIT 5000)",
        )
        .run();
    } catch (e2) {
      console.error("[db] Safety valve prune also failed:", e2);
    }
  }
  return resolvedResult;
}
