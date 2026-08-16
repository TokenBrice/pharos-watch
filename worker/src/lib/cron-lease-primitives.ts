import { logWorkerEventArgs } from "./structured-log";
import { sleep } from "./abort";
import {
  getCronTimeoutBudgetMetadata,
  resolveCronTimeoutBudget,
  type CronTimeoutBudgetMetadata,
  type ResolvedCronTimeoutBudget,
} from "./cron-timeouts";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { toErrorMessage } from "./error-utils";

export interface CronLeaseOptions {
  ttlSec?: number;
  heartbeatSec?: number;
  owner?: string;
  maxRenewFailures?: number;
  abortSignal?: AbortSignal;
  timeoutBudget?: ResolvedCronTimeoutBudget;
  onLeaseState?: (state: CronLeaseStateUpdate) => Promise<void> | void;
  leaseStateObserverMode?: "best-effort" | "required";
}

export interface CronLeaseStateUpdate {
  event: "acquired" | "renewed";
  job: string;
  leaseOwner: string;
  leaseUntil: number;
  heartbeatAt: number;
  ttlSec: number;
}

export interface CronLeaseRunResult<T> {
  status: "ok" | "skipped_locked";
  leaseOwner: string;
  renewFailures: number;
  leaseTtlSec: number;
  leaseHeartbeatSec: number;
  leaseMaxRenewFailures: number;
  leaseRenewAttempts: number;
  leaseRenewSuccesses: number;
  leaseRenewFailuresTotal: number;
  leaseLastRenewedAt: number | null;
  leaseLost?: boolean;
  result?: T;
}

export class CronLeaseLostError extends Error {
  constructor(job: string, renewFailures: number) {
    super(`Cron lease lost for "${job}" after ${renewFailures} failed renewals`);
    this.name = "CronLeaseLostError";
  }
}

export class CronLeaseStateObserverError extends Error {
  readonly event: CronLeaseStateUpdate["event"];
  readonly cause: unknown;

  constructor(job: string, event: CronLeaseStateUpdate["event"], cause: unknown) {
    super(`Cron lease state observer failed for "${job}" during ${event}`);
    this.name = "CronLeaseStateObserverError";
    this.event = event;
    this.cause = cause;
  }
}

export class CronTimeoutError extends Error {
  readonly metadata?: CronTimeoutBudgetMetadata;

  constructor(job: string, timeoutMs: number, metadata?: CronTimeoutBudgetMetadata) {
    super(
      metadata?.slotBudgetExhausted
        ? `Cron job "${job}" did not start because the scheduled slot budget was exhausted`
        : `Cron job "${job}" timed out after ${Math.round(timeoutMs / 1000)}s`,
    );
    this.name = "CronTimeoutError";
    this.metadata = metadata;
  }
}

export const CRON_ABANDONED_JOB_GRACE_MS = 1_000;

export interface CronJobAbandonedMetadata {
  reason: "abandoned";
  job: string;
  stopReason: "timeout" | "lease_lost" | "aborted";
  stopError: string;
  leaseOwner: string | null;
  renewFailures: number | null;
  leaseLost: boolean | null;
  ttlSec: number | null;
  graceMs: number;
  leaseHeldUntilTtl: boolean;
}

export class CronJobAbandonedError extends Error {
  readonly metadata: CronJobAbandonedMetadata;

  constructor(job: string, stopError: unknown, metadata: Omit<CronJobAbandonedMetadata, "reason" | "job" | "stopError">) {
    const stopMessage = toErrorMessage(stopError);
    super(`Cron job "${job}" was abandoned after abort; lease left to expire by TTL (${stopMessage})`);
    this.name = "CronJobAbandonedError";
    this.metadata = {
      reason: "abandoned",
      job,
      stopError: stopMessage,
      ...metadata,
    };
  }
}

export function createLeaseOwner(job: string): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return `${job}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

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

function getStopReason(error: unknown): CronJobAbandonedMetadata["stopReason"] {
  if (error instanceof CronLeaseLostError) return "lease_lost";
  if (error instanceof CronTimeoutError) return "timeout";
  return "aborted";
}

/** Acquire or take over an expired cron lease. Returns false when another active owner holds the lease. */
async function acquireCronLeaseState(
  db: D1Database,
  job: string,
  owner: string,
  ttlSec: number,
): Promise<{ acquired: boolean; leaseUntil: number; heartbeatAt: number }> {
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

  return { acquired: (result.meta.changes ?? 0) > 0, leaseUntil, heartbeatAt: nowSec };
}

export async function acquireCronLease(db: D1Database, job: string, owner: string, ttlSec: number): Promise<boolean> {
  const result = await acquireCronLeaseState(db, job, owner, ttlSec);
  return result.acquired;
}

/** Renew an existing lease. Returns false when lease ownership was lost. */
async function renewCronLeaseState(
  db: D1Database,
  job: string,
  owner: string,
  ttlSec: number,
): Promise<{ renewed: boolean; leaseUntil: number; heartbeatAt: number }> {
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
  return { renewed: (result.meta.changes ?? 0) > 0, leaseUntil, heartbeatAt: nowSec };
}

export async function renewCronLease(db: D1Database, job: string, owner: string, ttlSec: number): Promise<boolean> {
  const result = await renewCronLeaseState(db, job, owner, ttlSec);
  return result.renewed;
}

/** Release a lease if and only if caller still owns it. */
export async function releaseCronLease(db: D1Database, job: string, owner: string): Promise<void> {
  await db.prepare("DELETE FROM cron_leases WHERE job = ? AND lease_owner = ?").bind(job, owner).run();
}

/**
 * Lease wrapper primitive for cron jobs. Acquires lease, keeps it alive with heartbeats,
 * runs the job, and releases the lease only after the job settles. If the job ignores
 * timeout/lease-loss aborts, the lease is left to expire by TTL instead of being
 * released while late writes may still be running.
 *
 * This helper does not yet wire cron status logging; integration is handled separately.
 */
export async function runCronWithLease<T>(
  db: D1Database,
  job: string,
  fn: (ctx: { leaseOwner: string; signal: AbortSignal }) => Promise<T>,
  opts?: CronLeaseOptions,
): Promise<CronLeaseRunResult<T>> {
  const timeoutBudget = opts?.timeoutBudget ?? resolveCronTimeoutBudget(job);
  const timeoutMs = timeoutBudget.effectiveTimeoutMs;
  const timeoutMetadata = getCronTimeoutBudgetMetadata(timeoutBudget);
  const timeoutSec = Math.ceil(timeoutMs / 1000);
  const ttlSec = opts?.ttlSec ?? timeoutSec + 60;
  const heartbeatSec = opts?.heartbeatSec ?? Math.max(15, Math.floor(ttlSec / 3));
  const maxRenewFailures = opts?.maxRenewFailures ?? 2;
  const owner = opts?.owner ?? createLeaseOwner(job);
  const buildLeaseTelemetry = () => ({
    leaseTtlSec: ttlSec,
    leaseHeartbeatSec: heartbeatSec,
    leaseMaxRenewFailures: maxRenewFailures,
    leaseRenewAttempts: 0,
    leaseRenewSuccesses: 0,
    leaseRenewFailuresTotal: 0,
    leaseLastRenewedAt: null as number | null,
  });

  const notifyLeaseState = async (
    event: CronLeaseStateUpdate["event"],
    state: { leaseUntil: number; heartbeatAt: number },
  ): Promise<void> => {
    try {
      await opts?.onLeaseState?.({
        event,
        job,
        leaseOwner: owner,
        leaseUntil: state.leaseUntil,
        heartbeatAt: state.heartbeatAt,
        ttlSec,
      });
    } catch (err) {
      logWorkerEventArgs("lib", "error", `[cron-lease] Lease state observer failed for ${job} (${event}):`, err);
      if (opts?.leaseStateObserverMode === "required") {
        throw new CronLeaseStateObserverError(job, event, err);
      }
    }
  };

  const acquisition = await runWithOverloadRetry(() => acquireCronLeaseState(db, job, owner, ttlSec), 3, opts?.abortSignal);
  if (!acquisition.acquired) {
    return {
      status: "skipped_locked",
      leaseOwner: owner,
      renewFailures: 0,
      ...buildLeaseTelemetry(),
    };
  }
  try {
    await notifyLeaseState("acquired", acquisition);
  } catch (error) {
    try {
      await runWithOverloadRetry(() => releaseCronLease(db, job, owner), 2);
    } catch (releaseError) {
      logWorkerEventArgs("lib", "error", `[cron-lease] Failed to release lease for ${job} after observer failure:`, releaseError);
    }
    throw error;
  }

  let renewFailures = 0;
  let leaseRenewAttempts = 0;
  let leaseRenewSuccesses = 0;
  let leaseRenewFailuresTotal = 0;
  let leaseLastRenewedAt: number | null = null;
  let leaseLost = false;
  const leaseController = new AbortController();
  const abortForLeaseLoss = (failureCount: number) => {
    if (leaseLost) return;
    leaseLost = true;
    leaseController.abort(new CronLeaseLostError(job, failureCount));
  };
  const abortForLeaseStateObserverFailure = (error: CronLeaseStateObserverError) => {
    if (leaseController.signal.aborted) return;
    leaseController.abort(error);
  };
  const markRenewError = () => {
    renewFailures++;
    leaseRenewFailuresTotal++;
    if (renewFailures >= maxRenewFailures) {
      abortForLeaseLoss(renewFailures);
    }
  };
  const markOwnershipLost = () => {
    renewFailures++;
    leaseRenewFailuresTotal++;
    abortForLeaseLoss(renewFailures);
  };

  let renewalInFlight: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (renewalInFlight) return;
    leaseRenewAttempts++;
    renewalInFlight = runWithOverloadRetry(() => renewCronLeaseState(db, job, owner, ttlSec), 2, opts?.abortSignal)
      .then(async (renewal) => {
        if (!renewal.renewed) {
          markOwnershipLost();
          return;
        }
        leaseRenewSuccesses++;
        leaseLastRenewedAt = renewal.heartbeatAt;
        renewFailures = 0;
        await notifyLeaseState("renewed", renewal);
      })
      .catch((error) => {
        if (error instanceof CronLeaseStateObserverError) {
          abortForLeaseStateObserverFailure(error);
          return;
        }
        markRenewError();
      })
      .finally(() => {
        renewalInFlight = null;
      });
  }, heartbeatSec * 1000);

  const stopSignals = [leaseController.signal, opts?.abortSignal].filter((signal): signal is AbortSignal => signal != null);
  const combinedSignal = stopSignals.length <= 1
    ? stopSignals[0]!
    : AbortSignal.any(stopSignals);
  const stopPromise = Promise.race(
    stopSignals.map((signal) =>
      createAbortPromise(
        signal,
        signal === opts?.abortSignal
          ? new CronTimeoutError(job, timeoutMs, timeoutMetadata)
          : new CronLeaseLostError(job, renewFailures),
      )
    ),
  );

  let shouldReleaseLease = true;
  let timerCleared = false;
  const clearHeartbeat = () => {
    if (timerCleared) return;
    clearInterval(timer);
    timerCleared = true;
  };

  type JobOutcome =
    | { status: "fulfilled"; value: T }
    | { status: "rejected"; error: unknown };

  const jobOutcomePromise: Promise<JobOutcome> = Promise.resolve()
    .then(() => fn({ leaseOwner: owner, signal: combinedSignal }))
    .then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error) => ({ status: "rejected" as const, error }),
    );

  try {
    const race = await Promise.race([
      jobOutcomePromise.then((outcome) => ({ type: "job" as const, outcome })),
      stopPromise.catch((error) => ({ type: "stop" as const, error })),
    ]);

    if (race.type === "stop") {
      clearHeartbeat();
      const grace = await Promise.race([
        jobOutcomePromise.then((outcome) => ({ type: "job" as const, outcome })),
        sleep(CRON_ABANDONED_JOB_GRACE_MS).then(() => ({ type: "abandoned" as const })),
      ]);

      if (grace.type === "abandoned") {
        shouldReleaseLease = false;
        throw new CronJobAbandonedError(job, race.error, {
          stopReason: getStopReason(race.error),
          leaseOwner: owner,
          renewFailures,
          leaseLost,
          ttlSec,
          graceMs: CRON_ABANDONED_JOB_GRACE_MS,
          leaseHeldUntilTtl: true,
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

    const result = race.outcome.value;
    return {
      status: "ok",
      leaseOwner: owner,
      renewFailures,
      leaseTtlSec: ttlSec,
      leaseHeartbeatSec: heartbeatSec,
      leaseMaxRenewFailures: maxRenewFailures,
      leaseRenewAttempts,
      leaseRenewSuccesses,
      leaseRenewFailuresTotal,
      leaseLastRenewedAt,
      leaseLost,
      result,
    };
  } finally {
    clearHeartbeat();
    await renewalInFlight;
    if (shouldReleaseLease) {
      try {
        await runWithOverloadRetry(() => releaseCronLease(db, job, owner), 2);
      } catch (releaseErr) {
        // Best-effort release: lease expiry still guarantees eventual progress.
        logWorkerEventArgs("lib", "error", `[cron-lease] Failed to release lease for ${job}:`, releaseErr);
      }
    }
  }
}
