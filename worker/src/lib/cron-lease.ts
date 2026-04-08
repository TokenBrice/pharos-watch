// --- Per-job cron timeout configuration ---

export const CRON_TIMEOUT_MS: Record<string, number> = {
  // Keep app-level timeout below the platform wall-clock limit so we can log
  // a controlled error instead of losing the invocation without a cron_runs row.
  "sync-stablecoins": 8 * 60_000,
  "sync-live-reserves": 12 * 60_000,
  "sync-dex-liquidity": 13 * 60_000,
  "sync-dex-discovery": 13 * 60_000,
  "sync-yield-data": 10 * 60_000,
  "sync-yield-supplemental": 12 * 60_000,
  "sync-blacklist": 12 * 60_000,
  "sync-mint-burn": 10 * 60_000,
  "sync-mint-burn-extended": 10 * 60_000,
  "daily-digest": 8 * 60_000,
};
export const DEFAULT_CRON_TIMEOUT_MS = 5 * 60_000;

// --- D1 overload retry helper ---

export function isRetriableD1OverloadError(err: unknown): boolean {
  const msg = String(err);
  return msg.includes("D1 DB is overloaded") || msg.includes("Requests queued for too long");
}

export async function runWithOverloadRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  signal?: AbortSignal,
): Promise<T> {
  let attempt = 0;
  while (true) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    try {
      return await fn();
    } catch (err) {
      if (!isRetriableD1OverloadError(err) || attempt >= maxRetries) {
        throw err;
      }
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const delayMs = Math.round(150 * 2 ** attempt * (0.5 + Math.random() * 0.5));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt++;
    }
  }
}

// --- Cron lease types ---

export interface CronLeaseOptions {
  ttlSec?: number;
  heartbeatSec?: number;
  owner?: string;
  maxRenewFailures?: number;
  abortSignal?: AbortSignal;
}

export interface CronLeaseRunResult<T> {
  status: "ok" | "skipped_locked";
  leaseOwner: string;
  renewFailures: number;
  leaseLost?: boolean;
  result?: T;
}

export interface ScheduledSlotExecutionOptions {
  slotStartedAt: number;
  owner?: string;
  heartbeatSec?: number;
  staleAfterSec?: number;
}

export interface ScheduledSlotExecutionResult {
  status: "ok" | "skipped_duplicate" | "skipped_running";
  slotKey: string;
  slotStartedAt: number;
  owner: string;
}

export class CronLeaseLostError extends Error {
  constructor(job: string, renewFailures: number) {
    super(`Cron lease lost for "${job}" after ${renewFailures} failed renewals`);
    this.name = "CronLeaseLostError";
  }
}

export class CronTimeoutError extends Error {
  constructor(job: string, timeoutMs: number) {
    super(`Cron job "${job}" timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "CronTimeoutError";
  }
}

export function createLeaseOwner(job: string): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return `${job}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const SLOT_EXECUTION_RUNNING_STALE_SEC = 20 * 60;
const SLOT_EXECUTION_HEARTBEAT_SEC = 30;
const SLOT_EXECUTION_RETENTION_SEC = 14 * 24 * 60 * 60;

type SlotExecutionRow = {
  state: string;
  execution_owner: string;
  updated_at: number;
};

function normalizeAbortError(reason: unknown, fallback: Error): Error {
  return reason instanceof Error ? reason : fallback;
}

function createAbortPromise(signal: AbortSignal, fallback: Error): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const rejectReason = () => reject(normalizeAbortError(signal.reason, fallback));
    if (signal.aborted) {
      rejectReason();
      return;
    }
    signal.addEventListener("abort", rejectReason, { once: true });
  });
}

async function getScheduledSlotExecution(
  db: D1Database,
  slotKey: string,
  slotStartedAt: number,
): Promise<SlotExecutionRow | null> {
  return runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT state, execution_owner, updated_at
           FROM cron_slot_executions
           WHERE slot_key = ? AND slot_started_at = ?`,
      )
      .bind(slotKey, slotStartedAt)
      .first<SlotExecutionRow>(),
  );
}

async function claimScheduledSlotExecution(
  db: D1Database,
  slotKey: string,
  slotStartedAt: number,
  owner: string,
  staleAfterSec: number,
): Promise<"claimed" | "duplicate" | "running"> {
  const nowSec = Math.floor(Date.now() / 1000);
  const inserted = await runWithOverloadRetry(() =>
    db
      .prepare(
        `INSERT OR IGNORE INTO cron_slot_executions
           (slot_key, slot_started_at, state, result_status, execution_owner, started_at, finished_at, updated_at, metadata)
         VALUES (?, ?, 'running', NULL, ?, ?, NULL, ?, NULL)`,
      )
      .bind(slotKey, slotStartedAt, owner, nowSec, nowSec)
      .run(),
  );
  if ((inserted.meta.changes ?? 0) > 0) {
    return "claimed";
  }

  const existing = await getScheduledSlotExecution(db, slotKey, slotStartedAt);
  if (!existing) {
    return "running";
  }
  if (existing.state === "finished") {
    return "duplicate";
  }
  if (existing.execution_owner === owner) {
    return "claimed";
  }

  const staleBefore = nowSec - staleAfterSec;
  if (existing.updated_at < staleBefore) {
    const takeover = await runWithOverloadRetry(() =>
      db
        .prepare(
          `UPDATE cron_slot_executions
           SET execution_owner = ?,
               started_at = ?,
               updated_at = ?,
               finished_at = NULL,
               result_status = NULL,
               metadata = NULL
           WHERE slot_key = ?
             AND slot_started_at = ?
             AND state = 'running'
             AND updated_at < ?`,
        )
        .bind(owner, nowSec, nowSec, slotKey, slotStartedAt, staleBefore)
        .run(),
    );
    if ((takeover.meta.changes ?? 0) > 0) {
      return "claimed";
    }
  }

  return "running";
}

async function touchScheduledSlotExecution(
  db: D1Database,
  slotKey: string,
  slotStartedAt: number,
  owner: string,
): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  await runWithOverloadRetry(() =>
    db
      .prepare(
        `UPDATE cron_slot_executions
         SET updated_at = ?
         WHERE slot_key = ?
           AND slot_started_at = ?
           AND execution_owner = ?
           AND state = 'running'`,
      )
      .bind(nowSec, slotKey, slotStartedAt, owner)
      .run(),
  );
}

async function finishScheduledSlotExecution(
  db: D1Database,
  slotKey: string,
  slotStartedAt: number,
  owner: string,
  resultStatus: "ok" | "error",
  metadata: string | null,
): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  await runWithOverloadRetry(() =>
    db
      .prepare(
        `UPDATE cron_slot_executions
         SET state = 'finished',
             result_status = ?,
             finished_at = ?,
             updated_at = ?,
             metadata = ?
         WHERE slot_key = ?
           AND slot_started_at = ?
           AND execution_owner = ?`,
      )
      .bind(resultStatus, nowSec, nowSec, metadata, slotKey, slotStartedAt, owner)
      .run(),
  );
}

async function pruneScheduledSlotExecutions(db: D1Database): Promise<void> {
  const cutoffSec = Math.floor(Date.now() / 1000) - SLOT_EXECUTION_RETENTION_SEC;
  await runWithOverloadRetry(() =>
    db
      .prepare("DELETE FROM cron_slot_executions WHERE slot_started_at < ?")
      .bind(cutoffSec)
      .run(),
  );
}

export async function runScheduledSlotWithFence(
  db: D1Database,
  slotKey: string,
  fn: () => Promise<void>,
  opts: ScheduledSlotExecutionOptions,
): Promise<ScheduledSlotExecutionResult> {
  const owner = opts.owner ?? createLeaseOwner(slotKey);
  const heartbeatSec = Math.max(15, opts.heartbeatSec ?? SLOT_EXECUTION_HEARTBEAT_SEC);
  const staleAfterSec = Math.max(heartbeatSec * 2, opts.staleAfterSec ?? SLOT_EXECUTION_RUNNING_STALE_SEC);
  const claimResult = await claimScheduledSlotExecution(db, slotKey, opts.slotStartedAt, owner, staleAfterSec);

  if (claimResult === "duplicate") {
    return {
      status: "skipped_duplicate",
      slotKey,
      slotStartedAt: opts.slotStartedAt,
      owner,
    };
  }
  if (claimResult === "running") {
    return {
      status: "skipped_running",
      slotKey,
      slotStartedAt: opts.slotStartedAt,
      owner,
    };
  }

  const timer = setInterval(() => {
    void touchScheduledSlotExecution(db, slotKey, opts.slotStartedAt, owner).catch((err) => {
      console.warn(`[cron-slot] Failed to heartbeat slot ${slotKey}@${opts.slotStartedAt}:`, err);
    });
  }, heartbeatSec * 1000);

  try {
    await fn();
    await finishScheduledSlotExecution(db, slotKey, opts.slotStartedAt, owner, "ok", null);
    return {
      status: "ok",
      slotKey,
      slotStartedAt: opts.slotStartedAt,
      owner,
    };
  } catch (err) {
    await finishScheduledSlotExecution(
      db,
      slotKey,
      opts.slotStartedAt,
      owner,
      "error",
      JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      }),
    ).catch((finishErr) => {
      console.warn(`[cron-slot] Failed to finish slot ${slotKey}@${opts.slotStartedAt}:`, finishErr);
    });
    throw err;
  } finally {
    clearInterval(timer);
    void pruneScheduledSlotExecutions(db).catch((err) => {
      console.warn("[cron-slot] Failed to prune old slot execution rows:", err);
    });
  }
}

// --- Cron lease primitives ---

/** Acquire or take over an expired cron lease. Returns false when another active owner holds the lease. */
export async function acquireCronLease(db: D1Database, job: string, owner: string, ttlSec: number): Promise<boolean> {
  const nowSec = Math.floor(Date.now() / 1000);
  const leaseUntil = nowSec + ttlSec;
  const result = await db
    .prepare(
      `INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(job) DO UPDATE SET
         lease_owner = excluded.lease_owner,
         lease_until = excluded.lease_until,
         heartbeat_at = excluded.heartbeat_at,
         updated_at = excluded.updated_at
       WHERE cron_leases.lease_until < ? OR cron_leases.lease_owner = excluded.lease_owner`,
    )
    .bind(job, owner, leaseUntil, nowSec, nowSec, nowSec)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/** Renew an existing lease. Returns false when lease ownership was lost. */
export async function renewCronLease(db: D1Database, job: string, owner: string, ttlSec: number): Promise<boolean> {
  const nowSec = Math.floor(Date.now() / 1000);
  const leaseUntil = nowSec + ttlSec;
  const result = await db
    .prepare(
      `UPDATE cron_leases
       SET lease_until = ?, heartbeat_at = ?, updated_at = ?
       WHERE job = ? AND lease_owner = ?`,
    )
    .bind(leaseUntil, nowSec, nowSec, job, owner)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Release a lease if and only if caller still owns it. */
export async function releaseCronLease(db: D1Database, job: string, owner: string): Promise<void> {
  await db.prepare("DELETE FROM cron_leases WHERE job = ? AND lease_owner = ?").bind(job, owner).run();
}

/**
 * Lease wrapper primitive for cron jobs. Acquires lease, keeps it alive with heartbeats,
 * runs the job, and releases lease in finally.
 *
 * This helper does not yet wire cron status logging; integration is handled separately.
 */
export async function runCronWithLease<T>(
  db: D1Database,
  job: string,
  fn: (ctx: { leaseOwner: string; signal: AbortSignal }) => Promise<T>,
  opts?: CronLeaseOptions,
): Promise<CronLeaseRunResult<T>> {
  const timeoutMs = CRON_TIMEOUT_MS[job] ?? DEFAULT_CRON_TIMEOUT_MS;
  const timeoutSec = Math.ceil((CRON_TIMEOUT_MS[job] ?? DEFAULT_CRON_TIMEOUT_MS) / 1000);
  const ttlSec = opts?.ttlSec ?? timeoutSec + 60;
  const heartbeatSec = opts?.heartbeatSec ?? Math.max(15, Math.floor(ttlSec / 3));
  const maxRenewFailures = opts?.maxRenewFailures ?? 2;
  const owner = opts?.owner ?? createLeaseOwner(job);

  const acquired = await runWithOverloadRetry(() => acquireCronLease(db, job, owner, ttlSec), 3, opts?.abortSignal);
  if (!acquired) {
    return {
      status: "skipped_locked",
      leaseOwner: owner,
      renewFailures: 0,
    };
  }

  let renewFailures = 0;
  let leaseLost = false;
  const leaseController = new AbortController();
  const markLeaseFailure = () => {
    renewFailures++;
    if (!leaseLost && renewFailures >= maxRenewFailures) {
      leaseLost = true;
      leaseController.abort(new CronLeaseLostError(job, renewFailures));
    }
  };

  const timer = setInterval(() => {
    void renewCronLease(db, job, owner, ttlSec)
      .then((ok) => {
        if (!ok) {
          markLeaseFailure();
          return;
        }
        renewFailures = 0;
      })
      .catch(() => {
        markLeaseFailure();
      });
  }, heartbeatSec * 1000);

  const stopSignals = [leaseController.signal, opts?.abortSignal].filter((signal): signal is AbortSignal => signal != null);
  const combinedSignal = stopSignals.length <= 1
    ? (stopSignals[0] ?? new AbortController().signal)
    : AbortSignal.any(stopSignals);
  const stopPromise = Promise.race(
    stopSignals.map((signal) =>
      createAbortPromise(
        signal,
        signal === opts?.abortSignal
          ? new CronTimeoutError(job, timeoutMs)
          : new CronLeaseLostError(job, renewFailures),
      )
    ),
  );

  try {
    const jobPromise = Promise.resolve().then(() => fn({ leaseOwner: owner, signal: combinedSignal }));
    void jobPromise.catch(() => {});
    const result = await Promise.race([jobPromise, stopPromise]);
    return {
      status: "ok",
      leaseOwner: owner,
      renewFailures,
      leaseLost,
      result,
    };
  } finally {
    clearInterval(timer);
    try {
      await runWithOverloadRetry(() => releaseCronLease(db, job, owner), 2);
    } catch (releaseErr) {
      // Best-effort release: lease expiry still guarantees eventual progress.
      console.error(`[cron-lease] Failed to release lease for ${job}:`, releaseErr);
    }
  }
}
