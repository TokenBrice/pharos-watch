import {
  getScheduledSlotPlanBudgetEntries,
  SCHEDULED_SLOT_PLANS,
} from "@shared/lib/scheduled-runner-registry";
import type { CronScheduleKey } from "@shared/lib/cron-jobs";
import { createLeaseOwner } from "./cron-lease-primitives";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { toErrorMessage } from "./error-utils";
import { markWorkerJobAttemptsAbandonedForSlot } from "./job-ledger";

export interface ScheduledSlotExecutionOptions {
  slotStartedAt: number;
  owner?: string;
  heartbeatSec?: number;
  staleAfterSec?: number;
  preSweepStale?: boolean;
  preSweepLimit?: number;
  deadlineMs?: number;
}

export interface ScheduledSlotExecutionResult {
  status: "ok" | "skipped_duplicate" | "skipped_running";
  resultStatus?: "ok" | "degraded" | "error";
  slotKey: string;
  slotStartedAt: number;
  owner: string;
  metadata?: unknown;
}

interface ScheduledSlotFenceMetadata {
  jobsAttempted?: number;
  jobsSucceeded?: number;
  jobsRun?: number;
  jobsErrored: number;
  jobsDegraded: number;
  jobsSkipped: number;
}

const SLOT_EXECUTION_RUNNING_STALE_SEC = 35 * 60;
const SLOT_EXECUTION_HEARTBEAT_SEC = 3 * 60;

type SlotExecutionRow = {
  state: string;
  execution_owner: string;
  started_at: number;
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
  lease_owner: string | null;
  slot_started_at: number | null;
};

type StaleSlotLeaseRow = {
  lease_owner: string;
  lease_until: number;
};

interface StaleSlotReconciliationSummary {
  syntheticCronRuns: number;
  jobAttemptsAbandoned: number;
  progressRowsCleared: number;
  leasesCleared: number;
  abandonedJobs: Array<{
    job: string;
    progressStage: string | null;
    progressUpdatedAt: number;
    leaseOwner: string | null;
    leaseUntil: number | null;
  }>;
}

interface StaleSlotTakeoverSummary {
  previousOwner: string;
  previousStartedAt: number;
  previousUpdatedAt: number;
  staleBefore: number;
  takenOverAt: number;
  reconciliation?: StaleSlotReconciliationSummary;
}

type ScheduledSlotClaimResult =
  | { status: "claimed"; staleSlotTakeover?: StaleSlotTakeoverSummary }
  | { status: "duplicate" | "running" };

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
  jobAttemptsAbandoned: number;
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
        `SELECT state, execution_owner, started_at, updated_at
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
           ORDER BY updated_at DESC`,
      )
      .bind(slotStartedAt, ...jobs)
      .all<StaleSlotProgressRow>(),
  );
  return rows.results ?? [];
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
    jobAttemptsAbandoned: 0,
    progressRowsCleared: 0,
    leasesCleared: 0,
    abandonedJobs: [],
  };
  const expectedJobs = getExpectedJobsForScheduledSlot(slot.slot_key);
  const progressRows = await listProgressRowsForStaleSlot(
    db,
    slot.slot_started_at,
    expectedJobs,
  );
  const progressRowsWithOwner = progressRows.filter(
    (progress): progress is StaleSlotProgressRow & { lease_owner: string } =>
      typeof progress.lease_owner === "string" && progress.lease_owner.length > 0,
  );
  const progressRowsWithoutOwner = progressRows.filter((progress) => !progress.lease_owner);
  const progressJobs = new Set(progressRowsWithOwner.map((progress) => progress.job));
  const noProgressJobs = expectedJobs.filter((job) => !progressJobs.has(job));
  if (noProgressJobs.length > 0) {
    try {
      summary.jobAttemptsAbandoned += await markWorkerJobAttemptsAbandonedForSlot(db, {
        scheduleKey: slot.slot_key,
        slotStartedAt: slot.slot_started_at,
        jobs: noProgressJobs,
        nowSec,
        error: STALE_SLOT_ERROR,
        metadata: {
          reason: "stale-slot-reconciled",
          reconciliationSource: "slot-no-progress-sweep",
          slotKey: slot.slot_key,
          slotStartedAt: slot.slot_started_at,
          slotOwner: slot.execution_owner,
          reconciledAt: nowSec,
        },
      });
    } catch (err) {
      console.warn(
        `[cron-slot] Failed to mark no-progress job attempts abandoned for ${slot.slot_key}@${slot.slot_started_at}:`,
        err,
      );
    }
  }

  for (const progress of progressRowsWithoutOwner) {
    const progressDelete = await runWithOverloadRetry(() =>
      db
        .prepare(
          `DELETE FROM cron_run_progress
           WHERE job = ?
             AND slot_started_at = ?
             AND (lease_owner IS NULL OR lease_owner = '')`,
        )
        .bind(progress.job, slot.slot_started_at)
        .run(),
    );
    summary.progressRowsCleared += progressDelete.meta.changes ?? 0;
    summary.abandonedJobs.push({
      job: progress.job,
      progressStage: progress.stage,
      progressUpdatedAt: progress.updated_at,
      leaseOwner: null,
      leaseUntil: null,
    });
  }

  for (const progress of progressRowsWithOwner) {
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
    try {
      summary.jobAttemptsAbandoned += await markWorkerJobAttemptsAbandonedForSlot(db, {
        scheduleKey: slot.slot_key,
        slotStartedAt: slot.slot_started_at,
        jobs: [progress.job],
        nowSec,
        error: STALE_SLOT_ERROR,
        metadata: {
          reason: "stale-slot-reconciled",
          slotKey: slot.slot_key,
          slotStartedAt: slot.slot_started_at,
          slotOwner: slot.execution_owner,
          progressStage: progress.stage,
          progressUpdatedAt: progress.updated_at,
          leaseOwner: progress.lease_owner,
          leaseUntil: lease.lease_until,
          reconciledAt: nowSec,
        },
      });
    } catch (err) {
      console.warn(
        `[cron-slot] Failed to mark job attempt abandoned for ${progress.job}@${slot.slot_started_at}:`,
        err,
      );
    }

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
    jobAttemptsAbandoned: 0,
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
    summary.jobAttemptsAbandoned += reconciliation.jobAttemptsAbandoned;
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
): Promise<ScheduledSlotClaimResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const staleBefore = nowSec - staleAfterSec;
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
    return { status: "claimed" };
  }

  const existing = await getScheduledSlotExecution(db, slotKey, slotStartedAt);
  if (!existing) {
    return { status: "running" };
  }
  if (existing.state === "finished") {
    return { status: "duplicate" };
  }
  if (existing.execution_owner === owner) {
    return { status: "claimed" };
  }

  if (existing.updated_at < staleBefore) {
    const staleSlot: StaleSlotExecutionRow = {
      slot_key: slotKey,
      slot_started_at: slotStartedAt,
      execution_owner: existing.execution_owner,
      started_at: existing.started_at,
      updated_at: existing.updated_at,
    };
    const staleSlotTakeover: StaleSlotTakeoverSummary = {
      previousOwner: existing.execution_owner,
      previousStartedAt: existing.started_at,
      previousUpdatedAt: existing.updated_at,
      staleBefore,
      takenOverAt: nowSec,
    };
    const takeover = await runWithOverloadRetry(() =>
      db
        .prepare(
          `UPDATE cron_slot_executions
           SET execution_owner = ?,
               started_at = ?,
               updated_at = ?,
               finished_at = NULL,
               result_status = NULL,
               metadata = ?
           WHERE slot_key = ?
             AND slot_started_at = ?
             AND state = 'running'
             AND updated_at < ?`,
        )
        .bind(owner, nowSec, nowSec, JSON.stringify({ staleSlotTakeover }), slotKey, slotStartedAt, staleBefore)
        .run(),
    );
    if ((takeover.meta.changes ?? 0) > 0) {
      const reconciliation = await reconcileStaleSlotArtifacts(db, staleSlot, nowSec);
      staleSlotTakeover.reconciliation = reconciliation;
      await writeStaleSlotEventMarker(db, staleSlot, nowSec, reconciliation);
      await runWithOverloadRetry(() =>
        db
          .prepare(
            `UPDATE cron_slot_executions
             SET metadata = ?
             WHERE slot_key = ?
               AND slot_started_at = ?
               AND execution_owner = ?
               AND state = 'running'`,
          )
          .bind(JSON.stringify({ staleSlotTakeover }), slotKey, slotStartedAt, owner)
          .run(),
      );
      return { status: "claimed", staleSlotTakeover };
    }
  }

  return { status: "running" };
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

function attachSlotRuntimeMetadata<T>(
  metadata: T,
  heartbeatFailures: number,
  staleSlotPreSweep?: ScheduledSlotSweepSummary | { error: string },
  staleSlotTakeover?: StaleSlotTakeoverSummary,
): T | {
  slotHeartbeatFailures?: number;
  staleSlotPreSweep?: ScheduledSlotSweepSummary | { error: string };
  staleSlotTakeover?: StaleSlotTakeoverSummary;
} | {
  metadata: T;
  slotHeartbeatFailures?: number;
  staleSlotPreSweep?: ScheduledSlotSweepSummary | { error: string };
  staleSlotTakeover?: StaleSlotTakeoverSummary;
} {
  if (heartbeatFailures <= 0 && !staleSlotPreSweep && !staleSlotTakeover) return metadata;
  const additions = {
    ...(heartbeatFailures > 0 ? { slotHeartbeatFailures: heartbeatFailures } : {}),
    ...(staleSlotPreSweep ? { staleSlotPreSweep } : {}),
    ...(staleSlotTakeover ? { staleSlotTakeover } : {}),
  };
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return {
      ...metadata,
      ...additions,
    };
  }
  if (metadata == null) {
    return additions;
  }
  return { metadata, ...additions };
}

export async function runScheduledSlotWithFence(
  db: D1Database,
  slotKey: string,
  fn: (signal: AbortSignal) => Promise<ScheduledSlotFenceMetadata | void>,
  opts: ScheduledSlotExecutionOptions,
): Promise<ScheduledSlotExecutionResult> {
  const owner = opts.owner ?? createLeaseOwner(slotKey);
  const heartbeatSec = Math.max(15, opts.heartbeatSec ?? SLOT_EXECUTION_HEARTBEAT_SEC);
  const staleAfterSec = Math.max(heartbeatSec * 2, opts.staleAfterSec ?? SLOT_EXECUTION_RUNNING_STALE_SEC);
  let staleSlotPreSweep: ScheduledSlotSweepSummary | { error: string } | undefined;
  if (opts.preSweepStale !== false) {
    try {
      const summary = await sweepStaleScheduledSlotExecutions(db, {
        slotKey,
        excludeSlotStartedAt: opts.slotStartedAt,
        staleAfterSec,
        limit: opts.preSweepLimit ?? 5,
      });
      if (summary.candidateSlots > 0 || summary.slotsReconciled > 0) {
        staleSlotPreSweep = summary;
      }
    } catch (err) {
      const error = toErrorMessage(err);
      staleSlotPreSweep = { error };
      console.warn(`[cron-slot] Failed to pre-sweep stale slots for ${slotKey}:`, err);
    }
  }
  const claimResult = await claimScheduledSlotExecution(db, slotKey, opts.slotStartedAt, owner, staleAfterSec);

  if (claimResult.status === "duplicate") {
    return {
      status: "skipped_duplicate",
      slotKey,
      slotStartedAt: opts.slotStartedAt,
      owner,
    };
  }
  if (claimResult.status === "running") {
    return {
      status: "skipped_running",
      slotKey,
      slotStartedAt: opts.slotStartedAt,
      owner,
    };
  }
  const staleSlotTakeover = "staleSlotTakeover" in claimResult ? claimResult.staleSlotTakeover : undefined;

  const slotController = new AbortController();
  let heartbeatFailures = 0;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  const abortForDeadline = () => {
    if (slotController.signal.aborted) return;
    slotController.abort(new Error(`scheduled slot ${slotKey}@${opts.slotStartedAt} exceeded controlled deadline`));
  };
  if (opts.deadlineMs != null) {
    const delayMs = opts.deadlineMs - Date.now();
    if (delayMs <= 0) {
      abortForDeadline();
    } else {
      deadlineTimer = setTimeout(abortForDeadline, delayMs);
    }
  }
  const timer = setInterval(() => {
    void touchScheduledSlotExecution(db, slotKey, opts.slotStartedAt, owner).catch((err) => {
      heartbeatFailures++;
      console.warn(`[cron-slot] Failed to heartbeat slot ${slotKey}@${opts.slotStartedAt}:`, err);
    });
  }, heartbeatSec * 1000);

  try {
    const metadata = await fn(slotController.signal);
    const slotMetadata = attachSlotRuntimeMetadata(
      metadata,
      heartbeatFailures,
      staleSlotPreSweep,
      staleSlotTakeover,
    );
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
      slotMetadata ? JSON.stringify(slotMetadata) : null,
    );
    return {
      status: "ok",
      resultStatus,
      slotKey,
      slotStartedAt: opts.slotStartedAt,
      owner,
      metadata: slotMetadata,
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
        ...(heartbeatFailures > 0 ? { slotHeartbeatFailures: heartbeatFailures } : {}),
        ...(staleSlotPreSweep ? { staleSlotPreSweep } : {}),
        ...(staleSlotTakeover ? { staleSlotTakeover } : {}),
      }),
    ).catch((finishErr) => {
      console.warn(`[cron-slot] Failed to finish slot ${slotKey}@${opts.slotStartedAt}:`, finishErr);
    });
    throw err;
  } finally {
    slotController.abort(new Error(`scheduled slot ${slotKey}@${opts.slotStartedAt} finished`));
    if (deadlineTimer) clearTimeout(deadlineTimer);
    clearInterval(timer);
  }
}
