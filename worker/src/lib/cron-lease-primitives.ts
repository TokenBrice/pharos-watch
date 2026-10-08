import { logWorkerEventArgs } from "./structured-log";
import { sleepWithSignal } from "./abort";
import { settleAfterAbort, CRON_ABORT_GRACE_MS } from "./cron-abort-settlement";
import type { SlotDeadline } from "./cron-timeouts";
import {
  getCronTimeoutBudgetMetadata,
  resolveCronTimeoutBudget,
  type CronTimeoutBudgetMetadata,
  type ResolvedCronTimeoutBudget,
} from "./cron-timeouts";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { toErrorMessage } from "@shared/lib/error-utils";
import {
  CRON_LEASE_TTL_ALLOWANCE_SEC,
  getReserveProducerPriority,
  reserveRecoveryAdmissionSql,
  type ReserveProducerPriority,
} from "./reserve-producer-priority";
import { parseJsonObject } from "./json-parse";

export interface CronLeaseOptions {
  ttlSec?: number;
  heartbeatSec?: number;
  owner?: string;
  maxRenewFailures?: number;
  abortSignal?: AbortSignal;
  timeoutBudget?: ResolvedCronTimeoutBudget;
  deadline?: SlotDeadline;
  onLeaseState?: (state: CronLeaseStateUpdate) => Promise<void> | void;
  leaseStateObserverMode?: "best-effort" | "required";
  reserveRecoveryAdmission?: boolean;
  acquisitionWait?: {
    deadlineMs: number;
    onWait?: (blockedBy: CronLeaseBlocker, attempts: number) => Promise<void> | void;
  };
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
  status: "ok" | "skipped_locked" | "skipped_neutral";
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
  producerPriority?: ReserveProducerPriority;
  blockedBy?: CronLeaseBlocker | null;
  leaseWaitDurationMs?: number;
  leaseAcquisitionAttempts?: number;
}

export interface CronLeaseBlocker {
  leaseJob: string;
  leaseOwner: string;
  holderJob: string | null;
  path: string | null;
  invocationId: string | null;
  scheduleKey: string | null;
  slotStartedAt: number | null;
  leaseUntil: number;
  heartbeatAt: number;
  observedAt: number;
}

async function readCronLeaseBlocker(db: D1Database, job: string): Promise<CronLeaseBlocker | null> {
  const row = await runWithOverloadRetry(() => db.prepare(
    "SELECT lease_owner, lease_until, heartbeat_at FROM cron_leases WHERE job = ?",
  ).bind(job).first<{ lease_owner: string; lease_until: number; heartbeat_at: number }>());
  if (!row) return null;
  const envelope = parseJsonObject(row.lease_owner);
  let evidence = envelope?.version === 1 ? envelope : null;
  if (!evidence) {
    // A legacy owner is attributable only through its own exact progress fence.
    const progress = await runWithOverloadRetry(() => db.prepare(
      "SELECT job, slot_started_at, metadata FROM cron_run_progress WHERE lease_owner = ?",
    ).bind(row.lease_owner).first<{ job: string; slot_started_at: number | null; metadata: string | null }>());
    if (progress) evidence = { ...parseJsonObject(progress.metadata), holderJob: progress.job, slotStartedAt: progress.slot_started_at };
  }
  const text = (key: string) => typeof evidence?.[key] === "string" ? evidence[key] as string : null;
  return {
    leaseJob: job, leaseOwner: row.lease_owner, holderJob: text("holderJob"), path: text("path") ?? text("producerPath"),
    invocationId: text("invocationId"), scheduleKey: text("scheduleKey"),
    slotStartedAt: typeof evidence?.slotStartedAt === "number" ? evidence.slotStartedAt : null,
    leaseUntil: row.lease_until, heartbeatAt: row.heartbeat_at, observedAt: Math.floor(Date.now() / 1000),
  };
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

export const CRON_ABANDONED_JOB_GRACE_MS = CRON_ABORT_GRACE_MS;

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
  reserveRecoveryAdmission = false,
): Promise<{ acquired: boolean; leaseUntil: number; heartbeatAt: number }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const leaseUntil = nowSec + ttlSec;
  const admission = reserveRecoveryAdmission ? reserveRecoveryAdmissionSql() : null;
  const result = await db
    .prepare(
      `INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at)
       SELECT ?, ?, ?, ?, ? WHERE ${admission?.sql ?? "1 = 1"}
       ON CONFLICT(job) DO UPDATE SET
         lease_owner = excluded.lease_owner,
         lease_until = excluded.lease_until,
         heartbeat_at = excluded.heartbeat_at,
         updated_at = excluded.updated_at
       WHERE (cron_leases.lease_until < ? OR cron_leases.lease_owner = excluded.lease_owner)
         AND (${admission?.sql ?? "1 = 1"})`,
    )
    .bind(job, owner, leaseUntil, nowSec, nowSec, ...(admission?.binds ?? []), nowSec, ...(admission?.binds ?? []))
    .run();

  return { acquired: (result.meta.changes ?? 0) > 0, leaseUntil, heartbeatAt: nowSec };
}

export async function acquireCronLease(db: D1Database, job: string, owner: string, ttlSec: number): Promise<boolean> {
  const result = await runWithOverloadRetry(() => acquireCronLeaseState(db, job, owner, ttlSec), 3);
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
  const result = await runWithOverloadRetry(() => renewCronLeaseState(db, job, owner, ttlSec), 3);
  return result.renewed;
}

/** Release a lease if and only if caller still owns it. */
export async function releaseCronLease(db: D1Database, job: string, owner: string): Promise<void> {
  await runWithOverloadRetry(
    () => db.prepare("DELETE FROM cron_leases WHERE job = ? AND lease_owner = ?").bind(job, owner).run(),
    3,
  );
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
  const timeoutBudget = opts?.timeoutBudget ?? resolveCronTimeoutBudget(job, { deadline: opts?.deadline });
  const timeoutMs = timeoutBudget.effectiveTimeoutMs;
  const timeoutMetadata = getCronTimeoutBudgetMetadata(timeoutBudget);
  const timeoutSec = Math.ceil(timeoutMs / 1000);
  const ttlSec = opts?.ttlSec ?? timeoutSec + CRON_LEASE_TTL_ALLOWANCE_SEC;
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

  const acquisitionStartedMs = Date.now();
  let attempts = 0;
  let blockedBy: CronLeaseBlocker | null = null;
  let waitDeadlineMs = opts?.acquisitionWait?.deadlineMs ?? acquisitionStartedMs;
  let blockerDeadlineCaptured = false;
  let acquisition: { acquired: boolean; leaseUntil: number; heartbeatAt: number };
  const skipped = (producerPriority?: ReserveProducerPriority): CronLeaseRunResult<T> => ({
    status: producerPriority ? "skipped_neutral" : "skipped_locked",
    leaseOwner: owner, renewFailures: 0, ...buildLeaseTelemetry(),
    ...(producerPriority ? { producerPriority } : {}),
    blockedBy, leaseWaitDurationMs: Date.now() - acquisitionStartedMs, leaseAcquisitionAttempts: attempts,
  });
  for (;;) {
    if (opts?.abortSignal?.aborted) throw normalizeAbortError(opts.abortSignal.reason, new Error("Lease acquisition aborted"));
    if (attempts > 0 && opts?.acquisitionWait && Date.now() > waitDeadlineMs) {
      blockedBy = await readCronLeaseBlocker(db, job);
      return skipped();
    }
    if (opts?.reserveRecoveryAdmission) {
      const priority = await getReserveProducerPriority(db);
      if (priority) return skipped(priority);
    }
    attempts++;
    acquisition = await runWithOverloadRetry(
      () => acquireCronLeaseState(db, job, owner, ttlSec, opts?.reserveRecoveryAdmission), 3, opts?.abortSignal,
    );
    if (acquisition.acquired) break;
    if (opts?.reserveRecoveryAdmission) {
      const priority = await getReserveProducerPriority(db);
      if (priority) return skipped(priority);
    }
    blockedBy = await readCronLeaseBlocker(db, job);
    if (opts?.acquisitionWait && !blockerDeadlineCaptured && blockedBy) {
      const blocker = blockedBy;
      // Include the next eligible second: acquisition uses strict lease_until < now.
      waitDeadlineMs = Math.min(waitDeadlineMs, (blocker.leaseUntil + 1) * 1000);
      const claim = await runWithOverloadRetry(() => db.prepare(
        "SELECT MAX(recovery_lease_until) AS lease_until FROM worker_scheduled_checkpoints WHERE state = 'recovering' AND recovery_owner = ? AND recovery_lease_until >= ?",
      ).bind(blocker.invocationId ?? blocker.leaseOwner, blocker.observedAt).first<{ lease_until: number | null }>());
      if (claim?.lease_until != null) waitDeadlineMs = Math.min(waitDeadlineMs, (claim.lease_until + 1) * 1000);
      blockerDeadlineCaptured = true;
    }
    if (!opts?.acquisitionWait || Date.now() >= waitDeadlineMs) return skipped();
    if (blockedBy) await opts.acquisitionWait.onWait?.(blockedBy, attempts);
    await sleepWithSignal(Math.min(15_000, waitDeadlineMs - Date.now()), opts.abortSignal);
  }
  const leaseWaitDurationMs = Date.now() - acquisitionStartedMs;
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

  let shouldReleaseLease = true;
  let timerCleared = false;
  const clearHeartbeat = () => {
    if (timerCleared) return;
    clearInterval(timer);
    timerCleared = true;
  };
  combinedSignal.addEventListener("abort", clearHeartbeat, { once: true });

  try {
    const outcome = await settleAfterAbort(
      () => fn({ leaseOwner: owner, signal: combinedSignal }), combinedSignal,
      { platformDeadlineMs: opts?.deadline?.platformDeadlineMs },
    );
    if (outcome.status === "aborted") {
      clearHeartbeat();
      const stopError = normalizeAbortError(outcome.reason, new CronTimeoutError(job, timeoutMs, timeoutMetadata));
      if (!outcome.settled) {
        shouldReleaseLease = false;
        throw new CronJobAbandonedError(job, stopError, {
          stopReason: getStopReason(stopError), leaseOwner: owner, renewFailures, leaseLost, ttlSec,
          graceMs: CRON_ABORT_GRACE_MS, leaseHeldUntilTtl: true,
        });
      }
      throw outcome.error ?? stopError;
    }
    if (outcome.status === "rejected") throw outcome.error;
    const result = outcome.value;
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
      leaseWaitDurationMs,
      leaseAcquisitionAttempts: attempts,
    };
  } finally {
    combinedSignal.removeEventListener("abort", clearHeartbeat);
    clearHeartbeat();
    await renewalInFlight;
    if (shouldReleaseLease) {
      try {
        await releaseCronLease(db, job, owner);
      } catch (releaseErr) {
        // Best-effort release: lease expiry still guarantees eventual progress.
        logWorkerEventArgs("lib", "error", `[cron-lease] Failed to release lease for ${job}:`, releaseErr);
      }
    }
  }
}
