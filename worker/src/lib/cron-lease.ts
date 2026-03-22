// --- Per-job cron timeout configuration ---

export const CRON_TIMEOUT_MS: Record<string, number> = {
  // Keep app-level timeout below the platform wall-clock limit so we can log
  // a controlled error instead of losing the invocation without a cron_runs row.
  "sync-stablecoins": 8 * 60_000,
  "sync-dex-liquidity": 13 * 60_000,
  "sync-dex-discovery": 13 * 60_000,
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
      const delayMs = 150 * 2 ** attempt;
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
}

export interface CronLeaseRunResult<T> {
  status: "ok" | "skipped_locked";
  leaseOwner: string;
  renewFailures: number;
  leaseLost?: boolean;
  result?: T;
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
  const timeoutSec = Math.ceil((CRON_TIMEOUT_MS[job] ?? DEFAULT_CRON_TIMEOUT_MS) / 1000);
  const ttlSec = opts?.ttlSec ?? timeoutSec + 60;
  const heartbeatSec = opts?.heartbeatSec ?? Math.max(15, Math.floor(ttlSec / 3));
  const maxRenewFailures = opts?.maxRenewFailures ?? 2;
  const owner = opts?.owner ?? createLeaseOwner(job);

  const acquired = await acquireCronLease(db, job, owner, ttlSec);
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
        if (!ok) markLeaseFailure();
      })
      .catch(() => {
        markLeaseFailure();
      });
  }, heartbeatSec * 1000);

  const leaseLossPromise = new Promise<never>((_resolve, reject) => {
    const rejectReason = () => {
      const reason = leaseController.signal.reason;
      reject(reason instanceof Error ? reason : new CronLeaseLostError(job, renewFailures));
    };
    if (leaseController.signal.aborted) {
      rejectReason();
      return;
    }
    leaseController.signal.addEventListener("abort", rejectReason, { once: true });
  });

  try {
    const result = await Promise.race([fn({ leaseOwner: owner, signal: leaseController.signal }), leaseLossPromise]);
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
