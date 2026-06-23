import {
  getScheduledSlotPlanBudgetEntries,
  SCHEDULED_SLOT_PLANS,
} from "@shared/lib/scheduled-runner-registry";
import type { CronScheduleKey } from "@shared/lib/cron-jobs";
import { createLeaseOwner } from "./cron-lease-primitives";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { toErrorMessage } from "./error-utils";

export interface ScheduledSlotExecutionOptions {
  slotStartedAt: number;
  owner?: string;
  heartbeatSec?: number;
  staleAfterSec?: number;
}

export interface ScheduledSlotExecutionResult {
  status: "ok" | "skipped_duplicate" | "skipped_running";
  resultStatus?: "ok" | "degraded" | "error";
  slotKey: string;
  slotStartedAt: number;
  owner: string;
  metadata?: unknown;
}

const SLOT_EXECUTION_RUNNING_STALE_SEC = 20 * 60;
const SLOT_EXECUTION_HEARTBEAT_SEC = 3 * 60;

type SlotExecutionRow = {
  state: string;
  execution_owner: string;
  updated_at: number;
};

type StaleSlotExecutionRow = {
  slot_key: string;
  slot_started_at: number;
  execution_owner: string;
  started_at: number;
  updated_at: number;
};

type StaleSlotProgressRow = {
  job: string;
  started_at: number;
  updated_at: number;
  stage: string | null;
  lease_owner: string;
  slot_started_at: number | null;
};

type StaleSlotLeaseRow = {
  lease_owner: string;
  lease_until: number;
};

interface StaleSlotReconciliationSummary {
  syntheticCronRuns: number;
  progressRowsCleared: number;
  leasesCleared: number;
  abandonedJobs: Array<{
    job: string;
    progressStage: string | null;
    progressUpdatedAt: number;
    leaseOwner: string;
    leaseUntil: number;
  }>;
}

export interface ScheduledSlotSweepOptions {
  staleAfterSec?: number;
  limit?: number;
  nowSec?: number;
  slotKey?: string;
  excludeSlotStartedAt?: number;
  signal?: AbortSignal;
}

export interface ScheduledSlotSweepSummary {
  staleBefore: number;
  candidateSlots: number;
  slotsReconciled: number;
  syntheticCronRuns: number;
  progressRowsCleared: number;
  leasesCleared: number;
  abandonedSlots: Array<{
    slotKey: string;
    slotStartedAt: number;
    slotOwner: string;
    slotUpdatedAt: number;
    abandonedJobs: StaleSlotReconciliationSummary["abandonedJobs"];
  }>;
}

export const STALE_SLOT_ABANDONED_EVENT_TYPE = "scheduled-slot-abandoned";
const STALE_SLOT_ERROR = "scheduled slot heartbeat stale; marked expired by later invocation";

export function cacheKeySegment(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9:-]+/g, "-").replace(/^-+|-+$/g, "");
  return (normalized || "unknown").slice(0, 96);
}

export function staleSlotEventCacheKey(scheduleKey: string): string {
  return `cron:event:${cacheKeySegment(scheduleKey)}:${cacheKeySegment(STALE_SLOT_ABANDONED_EVENT_TYPE)}`;
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

async function listStaleScheduledSlotExecutions(
  db: D1Database,
  slotKey: string | null,
  staleBefore: number,
  limit: number,
  excludeSlotStartedAt?: number,
): Promise<StaleSlotExecutionRow[]> {
  const predicates: string[] = [];
  const bindArgs: Array<string | number> = [];
  if (slotKey) {
    predicates.push("slot_key = ?");
    bindArgs.push(slotKey);
  }
  if (excludeSlotStartedAt != null) {
    predicates.push("slot_started_at != ?");
    bindArgs.push(excludeSlotStartedAt);
  }
  predicates.push("state = 'running'", "updated_at < ?");
  bindArgs.push(staleBefore, limit);
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT slot_key, slot_started_at, execution_owner, started_at, updated_at
           FROM cron_slot_executions
           WHERE ${predicates.join("\n             AND ")}
           ORDER BY updated_at ASC, slot_started_at ASC
           LIMIT ?`,
      )
      .bind(...bindArgs)
      .all<StaleSlotExecutionRow>(),
  );
  return rows.results ?? [];
}

async function listProgressRowsForStaleSlot(
  db: D1Database,
  slotStartedAt: number,
  jobs: readonly string[],
): Promise<StaleSlotProgressRow[]> {
  if (jobs.length === 0) {
    return [];
  }
  const jobPlaceholders = jobs.map(() => "?").join(", ");
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT job, started_at, updated_at, stage, lease_owner, slot_started_at
           FROM cron_run_progress
           WHERE slot_started_at = ?
             AND job IN (${jobPlaceholders})
             AND lease_owner IS NOT NULL
           ORDER BY updated_at DESC`,
      )
      .bind(slotStartedAt, ...jobs)
      .all<StaleSlotProgressRow>(),
  );
  return (rows.results ?? []).filter((row) => typeof row.lease_owner === "string" && row.lease_owner.length > 0);
}

function getExpectedJobsForScheduledSlot(slotKey: string): readonly string[] {
  const plan = SCHEDULED_SLOT_PLANS[slotKey as CronScheduleKey];
  return plan ? getScheduledSlotPlanBudgetEntries(plan) : [];
}

async function getCronLeaseForJob(db: D1Database, job: string): Promise<StaleSlotLeaseRow | null> {
  return runWithOverloadRetry(() =>
    db
      .prepare("SELECT lease_owner, lease_until FROM cron_leases WHERE job = ?")
      .bind(job)
      .first<StaleSlotLeaseRow>(),
  );
}

async function hasCronRunForSlot(db: D1Database, job: string, slotStartedAt: number): Promise<boolean> {
  const row = await runWithOverloadRetry(() =>
    db
      .prepare("SELECT id FROM cron_runs WHERE job = ? AND slot_started_at = ? LIMIT 1")
      .bind(job, slotStartedAt)
      .first<{ id: number }>(),
  );
  return row != null;
}

async function insertSyntheticStaleCronRun(
  db: D1Database,
  slot: StaleSlotExecutionRow,
  progress: StaleSlotProgressRow,
  lease: StaleSlotLeaseRow,
  nowSec: number,
): Promise<void> {
  const startedAt = progress.started_at || slot.started_at || slot.slot_started_at;
  const durationMs = Math.max(0, nowSec - startedAt) * 1000;
  const error = "scheduled slot heartbeat stale; child job progress abandoned";
  const metadata = JSON.stringify({
    reason: "stale-slot-reconciled",
    slotKey: slot.slot_key,
    slotStartedAt: slot.slot_started_at,
    slotOwner: slot.execution_owner,
    progressStage: progress.stage,
    progressUpdatedAt: progress.updated_at,
    leaseOwner: progress.lease_owner,
    leaseUntil: lease.lease_until,
    reconciledAt: nowSec,
  });

  await runWithOverloadRetry(() =>
    db
      .prepare(
        `INSERT INTO cron_runs
           (job, started_at, duration_ms, status, error, item_count, metadata, slot_started_at)
         VALUES (?, ?, ?, 'error', ?, NULL, ?, ?)`,
      )
      .bind(progress.job, startedAt, durationMs, error, metadata, slot.slot_started_at)
      .run(),
  );
}

async function reconcileStaleSlotArtifacts(
  db: D1Database,
  slot: StaleSlotExecutionRow,
  nowSec: number,
): Promise<StaleSlotReconciliationSummary> {
  const summary: StaleSlotReconciliationSummary = {
    syntheticCronRuns: 0,
    progressRowsCleared: 0,
    leasesCleared: 0,
    abandonedJobs: [],
  };
  const progressRows = await listProgressRowsForStaleSlot(
    db,
    slot.slot_started_at,
    getExpectedJobsForScheduledSlot(slot.slot_key),
  );

  for (const progress of progressRows) {
    const lease = await getCronLeaseForJob(db, progress.job);
    if (!lease || lease.lease_owner !== progress.lease_owner) {
      continue;
    }
    if (lease.lease_until >= nowSec) {
      continue;
    }

    if (!(await hasCronRunForSlot(db, progress.job, slot.slot_started_at))) {
      await insertSyntheticStaleCronRun(db, slot, progress, lease, nowSec);
      summary.syntheticCronRuns++;
    }
    summary.abandonedJobs.push({
      job: progress.job,
      progressStage: progress.stage,
      progressUpdatedAt: progress.updated_at,
      leaseOwner: progress.lease_owner,
      leaseUntil: lease.lease_until,
    });

    const progressDelete = await runWithOverloadRetry(() =>
      db
        .prepare("DELETE FROM cron_run_progress WHERE job = ? AND slot_started_at = ? AND lease_owner = ?")
        .bind(progress.job, slot.slot_started_at, progress.lease_owner)
        .run(),
    );
    summary.progressRowsCleared += progressDelete.meta.changes ?? 0;

    const leaseDelete = await runWithOverloadRetry(() =>
      db
        .prepare("DELETE FROM cron_leases WHERE job = ? AND lease_owner = ? AND lease_until < ?")
        .bind(progress.job, progress.lease_owner, nowSec)
        .run(),
    );
    summary.leasesCleared += leaseDelete.meta.changes ?? 0;
  }

  return summary;
}

async function writeStaleSlotEventMarker(
  db: D1Database,
  slot: StaleSlotExecutionRow,
  nowSec: number,
  reconciliation: StaleSlotReconciliationSummary,
): Promise<void> {
  const record = {
    event: "cron_event",
    job: slot.slot_key,
    eventType: STALE_SLOT_ABANDONED_EVENT_TYPE,
    severity: "error",
    message: `Scheduled slot ${slot.slot_key}@${slot.slot_started_at} stopped heartbeating and was reconciled as abandoned.`,
    metadata: {
      slotKey: slot.slot_key,
      slotStartedAt: slot.slot_started_at,
      slotOwner: slot.execution_owner,
      slotStartedAtActual: slot.started_at,
      slotUpdatedAt: slot.updated_at,
      reconciledAt: nowSec,
      staleSlotReconciliation: reconciliation,
    },
    recordedAt: nowSec,
  };
  const cacheKey = staleSlotEventCacheKey(slot.slot_key);
  try {
    await runWithOverloadRetry(() =>
      db
        .prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
        .bind(cacheKey, JSON.stringify(record), nowSec)
        .run(),
    );
    console.error(`[cron-event:${slot.slot_key}] ${STALE_SLOT_ABANDONED_EVENT_TYPE}: ${record.message}`);
  } catch (err) {
    console.warn(
      `[cron-slot] Failed to persist stale slot marker for ${slot.slot_key}@${slot.slot_started_at}:`,
      err,
    );
  }
}

async function finishStaleScheduledSlotExecution(
  db: D1Database,
  slot: StaleSlotExecutionRow,
  nowSec: number,
  staleBefore: number,
  reconciliation: StaleSlotReconciliationSummary,
): Promise<void> {
  await runWithOverloadRetry(() =>
    db
      .prepare(
        `UPDATE cron_slot_executions
         SET state = 'finished',
             result_status = 'error',
             finished_at = ?,
             updated_at = ?,
             metadata = ?
         WHERE slot_key = ?
           AND slot_started_at = ?
           AND state = 'running'
           AND updated_at < ?`,
      )
      .bind(
        nowSec,
        nowSec,
        JSON.stringify({
          error: STALE_SLOT_ERROR,
          staleSlotReconciliation: reconciliation,
        }),
        slot.slot_key,
        slot.slot_started_at,
        staleBefore,
      )
      .run(),
  );
}

export async function sweepStaleScheduledSlotExecutions(
  db: D1Database,
  options: ScheduledSlotSweepOptions = {},
): Promise<ScheduledSlotSweepSummary> {
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const staleAfterSec = Math.max(60, options.staleAfterSec ?? SLOT_EXECUTION_RUNNING_STALE_SEC);
  const limit = Math.max(1, Math.min(options.limit ?? 25, 100));
  const staleBefore = nowSec - staleAfterSec;
  const staleSlots = await listStaleScheduledSlotExecutions(
    db,
    options.slotKey ?? null,
    staleBefore,
    limit,
    options.excludeSlotStartedAt,
  );
  const summary: ScheduledSlotSweepSummary = {
    staleBefore,
    candidateSlots: staleSlots.length,
    slotsReconciled: 0,
    syntheticCronRuns: 0,
    progressRowsCleared: 0,
    leasesCleared: 0,
    abandonedSlots: [],
  };

  for (const staleSlot of staleSlots) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : new Error("scheduled slot sweep aborted");
    }
    const reconciliation = await reconcileStaleSlotArtifacts(db, staleSlot, nowSec);
    await writeStaleSlotEventMarker(db, staleSlot, nowSec, reconciliation);
    await finishStaleScheduledSlotExecution(db, staleSlot, nowSec, staleBefore, reconciliation);
    summary.slotsReconciled++;
    summary.syntheticCronRuns += reconciliation.syntheticCronRuns;
    summary.progressRowsCleared += reconciliation.progressRowsCleared;
    summary.leasesCleared += reconciliation.leasesCleared;
    summary.abandonedSlots.push({
      slotKey: staleSlot.slot_key,
      slotStartedAt: staleSlot.slot_started_at,
      slotOwner: staleSlot.execution_owner,
      slotUpdatedAt: staleSlot.updated_at,
      abandonedJobs: reconciliation.abandonedJobs,
    });
  }

  return summary;
}

async function claimScheduledSlotExecution(
  db: D1Database,
  slotKey: string,
  slotStartedAt: number,
  owner: string,
  staleAfterSec: number,
): Promise<"claimed" | "duplicate" | "running"> {
  const nowSec = Math.floor(Date.now() / 1000);
  const staleBefore = nowSec - staleAfterSec;
  await sweepStaleScheduledSlotExecutions(db, {
    slotKey,
    staleAfterSec,
    nowSec,
    excludeSlotStartedAt: slotStartedAt,
  });
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
  resultStatus: "ok" | "degraded" | "error",
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

export async function runScheduledSlotWithFence(
  db: D1Database,
  slotKey: string,
  fn: () => Promise<{ jobsErrored: number; jobsDegraded: number; jobsSkipped: number } | void>,
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
    const metadata = await fn();
    const resultStatus =
      metadata && metadata.jobsErrored > 0
        ? "error"
        : metadata && (metadata.jobsDegraded > 0 || metadata.jobsSkipped > 0)
          ? "degraded"
          : "ok";
    await finishScheduledSlotExecution(
      db,
      slotKey,
      opts.slotStartedAt,
      owner,
      resultStatus,
      metadata ? JSON.stringify(metadata) : null,
    );
    return {
      status: "ok",
      resultStatus,
      slotKey,
      slotStartedAt: opts.slotStartedAt,
      owner,
      metadata,
    };
  } catch (err) {
    await finishScheduledSlotExecution(
      db,
      slotKey,
      opts.slotStartedAt,
      owner,
      "error",
      JSON.stringify({
        error: toErrorMessage(err),
      }),
    ).catch((finishErr) => {
      console.warn(`[cron-slot] Failed to finish slot ${slotKey}@${opts.slotStartedAt}:`, finishErr);
    });
    throw err;
  } finally {
    clearInterval(timer);
  }
}
