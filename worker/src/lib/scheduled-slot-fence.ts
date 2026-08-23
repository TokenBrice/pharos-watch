import { logWorkerEventArgs } from "./structured-log";
import { createLeaseOwner } from "./cron-lease-primitives";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { toErrorMessage } from "./error-utils";
import {
  reconcileStaleSlotArtifactsAndRecordEvent,
  getExpectedJobsForScheduledSlot,
  hasActiveChildLeaseForScheduledSlot,
  STALE_SLOT_ERROR,
  type StaleSlotExecutionArtifact,
  type StaleSlotReconciliationSummary,
} from "./scheduled-slot-reconciliation";

export { staleSlotEventCacheKey } from "./scheduled-slot-reconciliation";

export interface ScheduledSlotExecutionOptions {
  slotStartedAt: number;
  owner?: string;
  heartbeatSec?: number;
  staleAfterSec?: number;
  preSweepStale?: boolean;
  preSweepLimit?: number;
  deadlineMs?: number;
  invocationId?: string | null;
  workerVersion?: string | null;
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

// The slot heartbeat is a fence-owned wall-clock timer, independent of child
// job duration, so a healthy slot of any length keeps its row fresh. Five
// minutes of silence therefore means the isolate is gone (OOM/eviction kills
// write no terminal row), and waiting longer only extends the outage window
// for every lane that gates on this slot.
const SLOT_EXECUTION_RUNNING_STALE_SEC = 5 * 60;
const SLOT_EXECUTION_HEARTBEAT_SEC = 3 * 60;
// A Cloudflare scheduled invocation cannot outlive the 15-minute event wall
// clock, so a running row older than that plus a minute of skew is provably
// dead regardless of what its heartbeat column claims.
const SLOT_EXECUTION_WALL_CLOCK_DEAD_SEC = 16 * 60;

type SlotExecutionRow = {
  state: string;
  execution_owner: string;
  execution_generation: number;
  invocation_id: string | null;
  worker_version: string | null;
  started_at: number;
  updated_at: number;
};

type StaleSlotExecutionRow = StaleSlotExecutionArtifact;

interface StaleSlotTakeoverSummary {
  previousOwner: string;
  previousStartedAt: number;
  previousUpdatedAt: number;
  staleBefore: number;
  takenOverAt: number;
  reconciliation?: StaleSlotReconciliationSummary;
}

type ScheduledSlotClaimResult =
  | { status: "claimed"; executionGeneration: number; staleSlotTakeover?: StaleSlotTakeoverSummary }
  | { status: "duplicate" }
  | { status: "running" };

class ScheduledSlotOwnershipLostError extends Error {
  constructor(slotKey: string, slotStartedAt: number) {
    super(`scheduled slot ownership lost for ${slotKey}@${slotStartedAt}`);
    this.name = "ScheduledSlotOwnershipLostError";
  }
}

class ScheduledSlotDeadlineExceededError extends Error {
  constructor(slotKey: string, slotStartedAt: number) {
    super(`scheduled slot ${slotKey}@${slotStartedAt} exceeded controlled deadline`);
    this.name = "ScheduledSlotDeadlineExceededError";
  }
}

export interface ScheduledSlotSweepOptions {
  staleAfterSec?: number;
  limit?: number;
  nowSec?: number;
  slotKey?: string;
  excludeSlotStartedAt?: number;
  signal?: AbortSignal;
  /**
   * Worker version of the process performing the sweep. Persisted into each
   * synthetic abandonment row's metadata next to the dead slot's version, so
   * "killed by deploy" (versions differ) vs "killed in place, e.g. OOM"
   * (versions match) is decidable from D1 alone.
   */
  reconcilerWorkerVersion?: string | null;
}

export interface ScheduledSlotSweepSummary {
  staleBefore: number;
  candidateSlots: number;
  slotsReconciled: number;
  syntheticCronRuns: number;
  progressRowsCleared: number;
  leasesCleared: number;
  recoveryCheckpointsPrepared: number;
  notStartedCronRuns: number;
  abandonedSlots: Array<{
    slotKey: string;
    slotStartedAt: number;
    slotOwner: string;
    slotUpdatedAt: number;
    abandonedJobs: StaleSlotReconciliationSummary["abandonedJobs"];
  }>;
}


async function getScheduledSlotExecution(
  db: D1Database,
  slotKey: string,
  slotStartedAt: number,
): Promise<SlotExecutionRow | null> {
  return runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT state, execution_owner, execution_generation, invocation_id, worker_version, started_at, updated_at
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
  wallDeadBefore: number,
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
  // The wall-clock backstop applies only to 'running' rows: started_at dates
  // the original (provably dead) invocation there, while a 'reconciling' row
  // is owned by a fresh reconciler whose liveness started_at does not measure.
  predicates.push(
    "state IN ('running', 'reconciling')",
    "(updated_at < ? OR (state = 'running' AND started_at < ?))",
  );
  bindArgs.push(staleBefore, wallDeadBefore, limit);
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT slot_key, slot_started_at, state, execution_owner, execution_generation,
                invocation_id, worker_version, started_at, updated_at
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

async function finishStaleScheduledSlotExecution(
  db: D1Database,
  slot: StaleSlotExecutionRow,
  reconciliationOwner: string,
  reconciliationGeneration: number,
  nowSec: number,
  reconciliation: StaleSlotReconciliationSummary,
): Promise<boolean> {
  // Scope the survivor guard to this slot's own child jobs. `slot_started_at` is an
  // aligned wall-clock timestamp shared across schedules (08:00 UTC is a quarter-hourly,
  // hourly and daily boundary at once), so a timestamp-only NOT EXISTS lets a foreign
  // schedule's live progress row block the finish and park the slot in 'reconciling'.
  const childJobs = getExpectedJobsForScheduledSlot(slot.slot_key);
  const survivingChildProgressGuard =
    childJobs.length > 0
      ? `
           AND NOT EXISTS (
             SELECT 1
               FROM cron_run_progress progress
              WHERE progress.slot_started_at = cron_slot_executions.slot_started_at
                AND progress.job IN (${childJobs.map(() => "?").join(", ")})
           )`
      : "";
  const result = await runWithOverloadRetry(() =>
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
           AND state = 'reconciling'
           AND execution_owner = ?
           AND execution_generation = ?${survivingChildProgressGuard}`,
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
        reconciliationOwner,
        reconciliationGeneration,
        ...childJobs,
      )
      .run(),
  );
  return (result.meta.changes ?? 0) === 1;
}

async function claimStaleScheduledSlotForReconciliation(
  db: D1Database,
  slot: StaleSlotExecutionRow,
  reconciliationOwner: string,
  nowSec: number,
  staleBefore: number,
): Promise<number | null> {
  const nextGeneration = slot.execution_generation + 1;
  const result = await runWithOverloadRetry(() =>
    db
      .prepare(
        `UPDATE cron_slot_executions
            SET state = 'reconciling',
                execution_owner = ?,
                execution_generation = ?,
                updated_at = ?
          WHERE slot_key = ?
            AND slot_started_at = ?
            AND state = ?
            AND execution_owner = ?
            AND execution_generation = ?
            AND updated_at = ?
            AND (updated_at < ? OR (state = 'running' AND started_at < ?))`,
      )
      .bind(
        reconciliationOwner,
        nextGeneration,
        nowSec,
        slot.slot_key,
        slot.slot_started_at,
        slot.state,
        slot.execution_owner,
        slot.execution_generation,
        slot.updated_at,
        staleBefore,
        nowSec - SLOT_EXECUTION_WALL_CLOCK_DEAD_SEC,
      )
      .run(),
  );
  return (result.meta.changes ?? 0) === 1 ? nextGeneration : null;
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
    nowSec - SLOT_EXECUTION_WALL_CLOCK_DEAD_SEC,
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
    recoveryCheckpointsPrepared: 0,
    notStartedCronRuns: 0,
    abandonedSlots: [],
  };

  for (const staleSlot of staleSlots) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : new Error("scheduled slot sweep aborted");
    }
    if (await hasActiveChildLeaseForScheduledSlot(db, staleSlot.slot_key, staleSlot.slot_started_at, nowSec)) {
      continue;
    }
    const reconciliationOwner = createLeaseOwner(`stale-slot:${staleSlot.slot_key}`);
    const reconciliationGeneration = await claimStaleScheduledSlotForReconciliation(
      db,
      staleSlot,
      reconciliationOwner,
      nowSec,
      staleBefore,
    );
    if (reconciliationGeneration == null) {
      continue;
    }
    const reconciliation = await reconcileStaleSlotArtifactsAndRecordEvent(
      db,
      staleSlot,
      nowSec,
      {
        owner: reconciliationOwner,
        generation: reconciliationGeneration,
        state: "reconciling",
      },
      options.reconcilerWorkerVersion ?? null,
    );
    const finished = await finishStaleScheduledSlotExecution(
      db,
      staleSlot,
      reconciliationOwner,
      reconciliationGeneration,
      nowSec,
      reconciliation,
    );
    if (!finished) {
      throw new ScheduledSlotOwnershipLostError(staleSlot.slot_key, staleSlot.slot_started_at);
    }
    summary.slotsReconciled++;
    summary.syntheticCronRuns += reconciliation.syntheticCronRuns;
    summary.progressRowsCleared += reconciliation.progressRowsCleared;
    summary.leasesCleared += reconciliation.leasesCleared;
    summary.recoveryCheckpointsPrepared += reconciliation.recoveryCheckpointsPrepared;
    summary.notStartedCronRuns += reconciliation.notStartedCronRuns;
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
  invocationId: string | null,
  workerVersion: string | null,
): Promise<ScheduledSlotClaimResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const staleBefore = nowSec - staleAfterSec;
  const inserted = await runWithOverloadRetry(() =>
    db
      .prepare(
        `INSERT OR IGNORE INTO cron_slot_executions
           (slot_key, slot_started_at, state, result_status, execution_owner, execution_generation,
            invocation_id, worker_version, started_at, finished_at, updated_at, metadata)
         VALUES (?, ?, 'running', NULL, ?, 1, ?, ?, ?, NULL, ?, NULL)`,
      )
      .bind(slotKey, slotStartedAt, owner, invocationId, workerVersion, nowSec, nowSec)
      .run(),
  );
  if ((inserted.meta.changes ?? 0) > 0) {
    return { status: "claimed", executionGeneration: 1 };
  }

  const existing = await getScheduledSlotExecution(db, slotKey, slotStartedAt);
  if (!existing) {
    return { status: "running" };
  }
  if (existing.state === "finished") {
    return { status: "duplicate" };
  }
  if (existing.execution_owner === owner) {
    return { status: "claimed", executionGeneration: existing.execution_generation };
  }

  if (existing.updated_at < staleBefore) {
    const staleSlot: StaleSlotExecutionRow = {
      slot_key: slotKey,
      slot_started_at: slotStartedAt,
      state: "running",
      execution_owner: existing.execution_owner,
      execution_generation: existing.execution_generation,
      invocation_id: existing.invocation_id,
      worker_version: existing.worker_version,
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
    if (await hasActiveChildLeaseForScheduledSlot(db, slotKey, slotStartedAt, nowSec)) {
      return { status: "running" };
    }
    const takeover = await runWithOverloadRetry(() =>
      db
        .prepare(
          `UPDATE cron_slot_executions
           SET execution_owner = ?,
               execution_generation = execution_generation + 1,
               invocation_id = ?,
               worker_version = ?,
               started_at = ?,
               updated_at = ?,
               finished_at = NULL,
               result_status = NULL,
               metadata = ?
           WHERE slot_key = ?
             AND slot_started_at = ?
             AND state = 'running'
             AND execution_owner = ?
             AND execution_generation = ?
             AND updated_at = ?
             AND updated_at < ?`,
        )
        .bind(
          owner,
          invocationId,
          workerVersion,
          nowSec,
          nowSec,
          JSON.stringify({ staleSlotTakeover }),
          slotKey,
          slotStartedAt,
          existing.execution_owner,
          existing.execution_generation,
          existing.updated_at,
          staleBefore,
        )
        .run(),
    );
    if ((takeover.meta.changes ?? 0) > 0) {
      const reconciliation: StaleSlotReconciliationSummary = await reconcileStaleSlotArtifactsAndRecordEvent(
        db,
        staleSlot,
        nowSec,
        {
          owner,
          generation: existing.execution_generation + 1,
          state: "running",
        },
      );
      staleSlotTakeover.reconciliation = reconciliation;
      await runWithOverloadRetry(() =>
        db
          .prepare(
            `UPDATE cron_slot_executions
             SET metadata = ?
             WHERE slot_key = ?
               AND slot_started_at = ?
               AND execution_owner = ?
               AND execution_generation = ?
               AND state = 'running'`,
          )
          .bind(JSON.stringify({ staleSlotTakeover }), slotKey, slotStartedAt, owner, existing.execution_generation + 1)
          .run(),
      );
      return {
        status: "claimed",
        executionGeneration: existing.execution_generation + 1,
        staleSlotTakeover,
      };
    }
  }

  return { status: "running" };
}

async function touchScheduledSlotExecution(
  db: D1Database,
  slotKey: string,
  slotStartedAt: number,
  owner: string,
  executionGeneration: number,
): Promise<boolean> {
  const nowSec = Math.floor(Date.now() / 1000);
  const result = await runWithOverloadRetry(() =>
    db
      .prepare(
        `UPDATE cron_slot_executions
         SET updated_at = ?
         WHERE slot_key = ?
           AND slot_started_at = ?
           AND execution_owner = ?
           AND execution_generation = ?
           AND state = 'running'`,
      )
      .bind(nowSec, slotKey, slotStartedAt, owner, executionGeneration)
      .run(),
  );
  return (result.meta.changes ?? 0) === 1;
}

async function finishScheduledSlotExecution(
  db: D1Database,
  slotKey: string,
  slotStartedAt: number,
  owner: string,
  executionGeneration: number,
  resultStatus: "ok" | "degraded" | "error",
  metadata: string | null,
): Promise<boolean> {
  const nowSec = Math.floor(Date.now() / 1000);
  const result = await runWithOverloadRetry(() =>
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
           AND execution_owner = ?
           AND execution_generation = ?
           AND state = 'running'`,
      )
      .bind(resultStatus, nowSec, nowSec, metadata, slotKey, slotStartedAt, owner, executionGeneration)
      .run(),
  );
  return (result.meta.changes ?? 0) === 1;
}

function attachSlotRuntimeMetadata<T>(
  metadata: T,
  heartbeatFailures: number,
  staleSlotPreSweep?: ScheduledSlotSweepSummary | { error: string },
  staleSlotTakeover?: StaleSlotTakeoverSummary,
):
  | T
  | {
      slotHeartbeatFailures?: number;
      staleSlotPreSweep?: ScheduledSlotSweepSummary | { error: string };
      staleSlotTakeover?: StaleSlotTakeoverSummary;
    }
  | {
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
        reconcilerWorkerVersion: opts.workerVersion ?? null,
      });
      if (summary.candidateSlots > 0 || summary.slotsReconciled > 0) {
        staleSlotPreSweep = summary;
      }
    } catch (err) {
      const error = toErrorMessage(err);
      staleSlotPreSweep = { error };
      logWorkerEventArgs("lib", "warn", `[cron-slot] Failed to pre-sweep stale slots for ${slotKey}:`, err);
    }
  }
  const claimResult = await claimScheduledSlotExecution(
    db,
    slotKey,
    opts.slotStartedAt,
    owner,
    staleAfterSec,
    opts.invocationId ?? null,
    opts.workerVersion ?? null,
  );

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
  const executionGeneration = claimResult.executionGeneration;

  const slotController = new AbortController();
  let heartbeatFailures = 0;
  let heartbeatOwnershipLost = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatInFlight: Promise<void> | null = null;
  let deadlineReject: ((error: Error) => void) | null = null;
  let deadlineSettled = false;
  const timer = setInterval(() => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = touchScheduledSlotExecution(db, slotKey, opts.slotStartedAt, owner, executionGeneration)
      .then((touched) => {
        if (touched || heartbeatOwnershipLost) return;
        heartbeatOwnershipLost = true;
        slotController.abort(new ScheduledSlotOwnershipLostError(slotKey, opts.slotStartedAt));
      })
      .catch((err) => {
        heartbeatFailures++;
        logWorkerEventArgs("lib", "warn", `[cron-slot] Failed to heartbeat slot ${slotKey}@${opts.slotStartedAt}:`, err);
      })
      .finally(() => {
        heartbeatInFlight = null;
      });
  }, heartbeatSec * 1000);
  const abortForDeadline = () => {
    if (deadlineSettled) return;
    deadlineSettled = true;
    const error =
      slotController.signal.aborted && slotController.signal.reason instanceof Error
        ? slotController.signal.reason
        : new ScheduledSlotDeadlineExceededError(slotKey, opts.slotStartedAt);
    if (!slotController.signal.aborted) {
      slotController.abort(error);
    }
    deadlineReject?.(error);
  };
  const deadlineMs = opts.deadlineMs;
  const deadlinePromise =
    deadlineMs == null
      ? null
      : new Promise<never>((_, reject) => {
          deadlineReject = reject;
          const delayMs = deadlineMs - Date.now();
          if (delayMs <= 0) {
            abortForDeadline();
          } else {
            deadlineTimer = setTimeout(abortForDeadline, delayMs);
          }
        });

  try {
    const workPromise = fn(slotController.signal);
    if (deadlinePromise) {
      void workPromise.catch(() => {});
    }
    const metadata = deadlinePromise ? await Promise.race([workPromise, deadlinePromise]) : await workPromise;
    deadlineSettled = true;
    deadlineReject = null;
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
    const slotMetadata = attachSlotRuntimeMetadata(metadata, heartbeatFailures, staleSlotPreSweep, staleSlotTakeover);
    const resultStatus =
      metadata && metadata.jobsErrored > 0
        ? "error"
        : metadata && (metadata.jobsDegraded > 0 || metadata.jobsSkipped > 0)
          ? "degraded"
          : "ok";
    if (heartbeatOwnershipLost) {
      throw new ScheduledSlotOwnershipLostError(slotKey, opts.slotStartedAt);
    }
    clearInterval(timer);
    await heartbeatInFlight;
    const finished = await finishScheduledSlotExecution(
      db,
      slotKey,
      opts.slotStartedAt,
      owner,
      executionGeneration,
      resultStatus,
      slotMetadata ? JSON.stringify(slotMetadata) : null,
    );
    if (!finished) {
      throw new ScheduledSlotOwnershipLostError(slotKey, opts.slotStartedAt);
    }
    return {
      status: "ok",
      resultStatus,
      slotKey,
      slotStartedAt: opts.slotStartedAt,
      owner,
      metadata: slotMetadata,
    };
  } catch (err) {
    clearInterval(timer);
    await heartbeatInFlight;
    try {
      const finished = await finishScheduledSlotExecution(
        db,
        slotKey,
        opts.slotStartedAt,
        owner,
        executionGeneration,
        "error",
        JSON.stringify({
          error: toErrorMessage(err),
          ...(heartbeatFailures > 0 ? { slotHeartbeatFailures: heartbeatFailures } : {}),
          ...(staleSlotPreSweep ? { staleSlotPreSweep } : {}),
          ...(staleSlotTakeover ? { staleSlotTakeover } : {}),
        }),
      );
      if (!finished) {
        throw new ScheduledSlotOwnershipLostError(slotKey, opts.slotStartedAt);
      }
    } catch (finishErr) {
      logWorkerEventArgs("lib", "warn", `[cron-slot] Failed to finish slot ${slotKey}@${opts.slotStartedAt}:`, finishErr);
      throw new AggregateError(
        [err, finishErr],
        `Scheduled slot ${slotKey}@${opts.slotStartedAt} failed (${toErrorMessage(err)}) and its terminal state ` +
          `could not be persisted (${toErrorMessage(finishErr)})`,
      );
    }
    throw err;
  } finally {
    slotController.abort(new Error(`scheduled slot ${slotKey}@${opts.slotStartedAt} finished`));
    if (deadlineTimer) clearTimeout(deadlineTimer);
    deadlineSettled = true;
    deadlineReject = null;
    clearInterval(timer);
  }
}
