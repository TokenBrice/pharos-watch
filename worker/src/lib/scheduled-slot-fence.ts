import type { ScheduledWorkerRole } from "@shared/lib/scheduled-runner-registry";
import { logWorkerEvent, logWorkerEventArgs } from "./structured-log";
import { createLeaseOwner } from "./cron-lease-primitives";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { toErrorMessage } from "@shared/lib/error-utils";
import {
  reconcileStaleSlotArtifactsAndRecordEvent,
  getExpectedJobsForScheduledSlot,
  hasActiveChildLeaseForScheduledSlot,
  STALE_SLOT_ERROR,
  type StaleSlotExecutionArtifact,
  type StaleSlotReconciliationSummary,
} from "./scheduled-slot-reconciliation";

import { SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";
import type { CronScheduleKey } from "@shared/lib/cron-jobs";
import { assertSlotDeadline, createSlotDeadline, SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS, type SlotDeadline } from "./cron-timeouts";
import { retainUntilDeadline, settleAfterAbort } from "./cron-abort-settlement";
import { resolveScheduledSlotPolicy, scheduledSlotSilenceSql } from "./scheduled-slot-policy";
import type { ScheduledSlotPolicy } from "./scheduled-slot-policy";

export interface ScheduledExecutionFence {
  readonly scheduleKey: string;
  readonly slotStartedAt: number;
  readonly invocationId: string;
  readonly owner: string;
  readonly generation: number;
  readonly workerRole: ScheduledWorkerRole;
}

export interface ScheduledSlotExecutionOptions {
  slotStartedAt: number;
  owner?: string;
  heartbeatSec?: number;
  deadlineMs?: number;
  deadline?: SlotDeadline;
  invocationId?: string | null;
  workerVersion?: string | null;
  workerRole?: ScheduledWorkerRole;
  waitUntil?: (work: Promise<unknown>) => void;
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

type SlotExecutionRow = {
  state: string;
  execution_owner: string;
  execution_generation: number;
  invocation_id: string | null;
  worker_version: string | null;
  started_at: number;
  updated_at: number;
  child_marker_version?: number | null;
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
  recoveryCheckpointsPrepared: number;
  notStartedCronRuns: number;
  maxReconciliationLagSec: number | null;
  slotPolicies: Record<string, ScheduledSlotPolicy>;
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
        `SELECT state, execution_owner, execution_generation, invocation_id, worker_version, started_at, updated_at, child_marker_version
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
  nowSec: number,
  wallDeadBefore: number,
  limit: number,
  excludeSlotStartedAt?: number,
): Promise<StaleSlotExecutionRow[]> {
  const predicates: string[] = [];
  const bindArgs: Array<string | number> = [];
  const silence = scheduledSlotSilenceSql();
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
    `(updated_at <= ? - (${silence.sql}) OR (state = 'running' AND started_at <= ?))`,
  );
  bindArgs.push(nowSec, ...silence.bindings, wallDeadBefore, limit);
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT slot_key, slot_started_at, state, execution_owner, execution_generation,
                invocation_id, worker_version, started_at, updated_at, child_marker_version
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
           AND execution_generation = ?${survivingChildProgressGuard}
           AND NOT EXISTS (SELECT 1 FROM scheduled_child_attempts
             WHERE execution_schedule_key = cron_slot_executions.slot_key
               AND execution_slot_started_at = cron_slot_executions.slot_started_at AND terminal_token IS NULL)`,
      )
      .bind(
        nowSec,
        nowSec,
        JSON.stringify({
          error: STALE_SLOT_ERROR,
          staleSlotReconciliation: reconciliation,
          slotPolicy: resolveScheduledSlotPolicy(slot.slot_key),
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
): Promise<number | null> {
  const nextGeneration = slot.execution_generation + 1;
  const policy = resolveScheduledSlotPolicy(slot.slot_key);
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
            AND (updated_at <= ? OR (state = 'running' AND started_at <= ?))`,
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
        nowSec - policy.slotSilenceSec,
        nowSec - policy.hardDeadSec,
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
  const policy = resolveScheduledSlotPolicy(options.slotKey ?? "");
  const staleAfterSec = policy.slotSilenceSec;
  const limit = Math.max(1, Math.min(options.limit ?? 25, 100));
  options.signal?.throwIfAborted();
  const staleBefore = nowSec - staleAfterSec;
  const staleSlots = await listStaleScheduledSlotExecutions(
    db,
    options.slotKey ?? null,
    nowSec,
    nowSec - policy.hardDeadSec,
    limit,
    options.excludeSlotStartedAt,
  );
  options.signal?.throwIfAborted();
  const summary: ScheduledSlotSweepSummary = {
    staleBefore,
    slotPolicies: {},
    candidateSlots: staleSlots.length,
    slotsReconciled: 0,
    syntheticCronRuns: 0,
    progressRowsCleared: 0,
    leasesCleared: 0,
    recoveryCheckpointsPrepared: 0,
    notStartedCronRuns: 0,
    maxReconciliationLagSec: null,
    abandonedSlots: [],
  };

  for (const staleSlot of staleSlots) {
    summary.slotPolicies[staleSlot.slot_key] = resolveScheduledSlotPolicy(staleSlot.slot_key);
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : new Error("scheduled slot sweep aborted");
    }
    if (await hasActiveChildLeaseForScheduledSlot(db, staleSlot.slot_key, staleSlot.slot_started_at, nowSec)) {
      continue;
    }
    options.signal?.throwIfAborted();
    const reconciliationOwner = createLeaseOwner(`stale-slot:${staleSlot.slot_key}`);
    const reconciliationGeneration = await claimStaleScheduledSlotForReconciliation(
      db,
      staleSlot,
      reconciliationOwner,
      nowSec,
    );
    options.signal?.throwIfAborted();
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
      () => options.signal?.throwIfAborted(),
    );
    options.signal?.throwIfAborted();
    const finished = await finishStaleScheduledSlotExecution(
      db,
      staleSlot,
      reconciliationOwner,
      reconciliationGeneration,
      nowSec,
      reconciliation,
    );
    options.signal?.throwIfAborted();
    if (!finished) {
      throw new ScheduledSlotOwnershipLostError(staleSlot.slot_key, staleSlot.slot_started_at);
    }
    summary.slotsReconciled++;
    const slotPolicy = resolveScheduledSlotPolicy(staleSlot.slot_key);
    const eligibleAt = Math.min(staleSlot.updated_at + slotPolicy.slotSilenceSec,
      staleSlot.state === "running" ? staleSlot.started_at + slotPolicy.hardDeadSec : Infinity);
    const lagSec = nowSec - eligibleAt;
    summary.maxReconciliationLagSec = Math.max(summary.maxReconciliationLagSec ?? lagSec, lagSec);
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
  invocationId: string | null,
  workerVersion: string | null,
  checkpoint: () => void,
): Promise<ScheduledSlotClaimResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  checkpoint();
  const policy = resolveScheduledSlotPolicy(slotKey);
  const staleBefore = nowSec - policy.slotSilenceSec;
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
  checkpoint();
  if ((inserted.meta.changes ?? 0) > 0) {
    return { status: "claimed", executionGeneration: 1 };
  }

  const existing = await getScheduledSlotExecution(db, slotKey, slotStartedAt);
  checkpoint();
  if (!existing) {
    return { status: "running" };
  }
  if (existing.state === "finished") {
    return { status: "duplicate" };
  }
  if (existing.execution_owner === owner) {
    return { status: "claimed", executionGeneration: existing.execution_generation };
  }

  if (existing.updated_at <= staleBefore || (existing.state === "running" && existing.started_at <= nowSec - policy.hardDeadSec)) {
    const staleSlot: StaleSlotExecutionRow = {
      slot_key: slotKey,
      slot_started_at: slotStartedAt,
      state: existing.state as StaleSlotExecutionRow["state"],
      execution_owner: existing.execution_owner,
      execution_generation: existing.execution_generation,
      invocation_id: existing.invocation_id,
      worker_version: existing.worker_version,
      started_at: existing.started_at,
      updated_at: existing.updated_at,
      child_marker_version: existing.child_marker_version,
    };
    const staleSlotTakeover: StaleSlotTakeoverSummary = {
      previousOwner: existing.execution_owner,
      previousStartedAt: existing.started_at,
      previousUpdatedAt: existing.updated_at,
      staleBefore,
      takenOverAt: nowSec,
    };
    if (await hasActiveChildLeaseForScheduledSlot(db, slotKey, slotStartedAt, nowSec)) {
      checkpoint();
      return { status: "running" };
    }
    checkpoint();
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
             AND (updated_at <= ? OR started_at <= ?)`,
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
          nowSec - policy.hardDeadSec,
        )
        .run(),
    );
    checkpoint();
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
        checkpoint,
      );
      checkpoint();
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
      checkpoint();
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
         SET updated_at = MAX(updated_at, ?)
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
           AND state = 'running'
           AND NOT EXISTS (SELECT 1 FROM scheduled_child_attempts
             WHERE execution_schedule_key = cron_slot_executions.slot_key
               AND execution_slot_started_at = cron_slot_executions.slot_started_at
               AND execution_generation = cron_slot_executions.execution_generation AND terminal_token IS NULL)`,
      )
      .bind(resultStatus, nowSec, nowSec, metadata, slotKey, slotStartedAt, owner, executionGeneration)
      .run(),
  );
  return (result.meta.changes ?? 0) === 1;
}

function attachSlotRuntimeMetadata<T>(
  metadata: T,
  heartbeatFailures: number,
  staleSlotTakeover?: StaleSlotTakeoverSummary,
):
  | T
  | {
      slotHeartbeatFailures?: number;
      staleSlotTakeover?: StaleSlotTakeoverSummary;
    }
  | {
      metadata: T;
      slotHeartbeatFailures?: number;
      staleSlotTakeover?: StaleSlotTakeoverSummary;
    } {
  if (heartbeatFailures <= 0 && !staleSlotTakeover) return metadata;
  const additions = {
    ...(heartbeatFailures > 0 ? { slotHeartbeatFailures: heartbeatFailures } : {}),
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

async function runScheduledSlotLifecycle(
  db: D1Database,
  slotKey: string,
  fn: (signal: AbortSignal, fence: ScheduledExecutionFence) => Promise<ScheduledSlotFenceMetadata | void>,
  opts: ScheduledSlotExecutionOptions,
  slotController: AbortController,
  checkpoint: () => void,
  onAdmitted: () => void,
  onWorkSettlement: (drained: boolean) => void,
): Promise<ScheduledSlotExecutionResult> {
  const owner = opts.owner ?? createLeaseOwner(slotKey);
  const policy = resolveScheduledSlotPolicy(slotKey);
  const heartbeatSec = Math.max(15, opts.heartbeatSec ?? policy.heartbeatSec);
  checkpoint();
  const claimResult = await claimScheduledSlotExecution(
    db,
    slotKey,
    opts.slotStartedAt,
    owner,
    opts.invocationId ?? owner,
    opts.workerVersion ?? null,
    checkpoint,
  );
  checkpoint();

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
  onAdmitted();
  const executionFence: ScheduledExecutionFence = Object.freeze({
    scheduleKey: slotKey, slotStartedAt: opts.slotStartedAt, invocationId: opts.invocationId ?? owner,
    owner, generation: executionGeneration,
    workerRole: opts.workerRole ?? SCHEDULED_SLOT_PLANS[slotKey as CronScheduleKey]?.worker ?? "public",
  });
  const stamped = await runWithOverloadRetry(() => db.prepare(
    `UPDATE cron_slot_executions SET child_marker_version = 1,
       metadata = json_set(COALESCE(metadata, '{}'), '$.slotPolicy', json(?), '$.slotDeadlineMs', ?)
     WHERE slot_key = ? AND slot_started_at = ? AND state = 'running'
       AND execution_owner = ? AND execution_generation = ? AND invocation_id = ?`,
  ).bind(JSON.stringify(policy), opts.deadline?.platformDeadlineMs ?? opts.deadlineMs ?? null,
    slotKey, opts.slotStartedAt, owner, executionGeneration, executionFence.invocationId).run());
  checkpoint();
  if ((stamped.meta.changes ?? 0) !== 1) throw new ScheduledSlotOwnershipLostError(slotKey, opts.slotStartedAt);

  let heartbeatFailures = 0;
  let heartbeatOwnershipLost = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  const heartbeatAttempts = new Set<Promise<void>>();
  let heartbeatLatestStartedAtMs = 0;
  const timer = setInterval(() => {
    // Skip only while an attempt is still inside its first heartbeat period.
    // A heartbeat stuck beyond that is queued behind a D1 overload (overload
    // errors fast-fail and retry inside touchScheduledSlotExecution); leaving
    // it as the only attempt silences the fence for the whole stale window
    // while the isolate is alive, and the slot is then falsely reconciled as
    // abandoned (2026-09-23 depegResolverOffset: one queued child read plus
    // one queued heartbeat produced a platform-abandoned error). The write is
    // an idempotent CAS on owner/generation/state with a monotonic timestamp,
    // so overlapping attempts are safe even if an older queued write commits
    // after a replacement heartbeat.
    if (heartbeatLatestStartedAtMs > 0 && Date.now() - heartbeatLatestStartedAtMs < heartbeatSec * 1000) return;
    if (heartbeatLatestStartedAtMs > 0) {
      logWorkerEventArgs("lib", "warn", `[cron-slot] Slot ${slotKey}@${opts.slotStartedAt} heartbeat still in flight after ${heartbeatSec}s; starting a replacement attempt`);
    }
    heartbeatLatestStartedAtMs = Date.now();
    const attempt: Promise<void> = touchScheduledSlotExecution(db, slotKey, opts.slotStartedAt, owner, executionGeneration)
      .then((touched) => {
        checkpoint();
        if (touched || heartbeatOwnershipLost) return;
        heartbeatOwnershipLost = true;
        slotController.abort(new ScheduledSlotOwnershipLostError(slotKey, opts.slotStartedAt));
      })
      .catch((err) => {
        heartbeatFailures++;
        logWorkerEventArgs("lib", "warn", `[cron-slot] Failed to heartbeat slot ${slotKey}@${opts.slotStartedAt}:`, err);
      })
      .finally(() => {
        heartbeatAttempts.delete(attempt);
      });
    heartbeatAttempts.add(attempt);
  }, heartbeatSec * 1000);
  const deadlineMs = opts.deadline?.platformDeadlineMs ?? opts.deadlineMs;
  if (deadlineMs != null) {
    const abortForDeadline = () => slotController.abort(new ScheduledSlotDeadlineExceededError(slotKey, opts.slotStartedAt));
    if (deadlineMs <= Date.now()) abortForDeadline();
    else deadlineTimer = setTimeout(abortForDeadline, deadlineMs - Date.now());
  }

  let workDrained = true;
  try {
    onWorkSettlement(false);
    const outcome = await settleAfterAbort(() => fn(slotController.signal, executionFence), slotController.signal, {
      observer: true, platformDeadlineMs: opts.deadline
        ? opts.deadline.platformDeadlineMs + SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS : undefined,
    });
    onWorkSettlement(outcome.status !== "aborted" || outcome.settled);
    clearTimeout(deadlineTimer ?? undefined);
    if (outcome.status === "aborted") {
      workDrained = outcome.settled;
      throw outcome.error ?? outcome.reason;
    }
    checkpoint();
    if (outcome.status === "rejected") throw outcome.error;
    const metadata = outcome.value;
    const slotMetadata = {
      ...attachSlotRuntimeMetadata(metadata, heartbeatFailures, staleSlotTakeover),
      slotPolicy: policy, ...(opts.deadline ? { slotDeadlineMs: opts.deadline.platformDeadlineMs } : {}),
    };
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
    await Promise.allSettled(heartbeatAttempts);
    checkpoint();
    const finished = await finishScheduledSlotExecution(
      db,
      slotKey,
      opts.slotStartedAt,
      owner,
      executionGeneration,
      resultStatus,
      slotMetadata ? JSON.stringify(slotMetadata) : null,
    );
    checkpoint();
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
    if (!slotController.signal.aborted) slotController.abort(err);
    clearInterval(timer);
    await Promise.allSettled(heartbeatAttempts);
    if (!workDrained) throw err;
    try {
      const finished = await finishScheduledSlotExecution(
        db,
        slotKey,
        opts.slotStartedAt,
        owner,
        executionGeneration,
        "error",
        JSON.stringify({
          reason: "scheduled-slot-failed",
          error: toErrorMessage(err),
          ...(heartbeatFailures > 0 ? { slotHeartbeatFailures: heartbeatFailures } : {}),
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
    if (deadlineTimer) clearTimeout(deadlineTimer);
    clearInterval(timer);
  }
}

/**
 * Arm the event-entry clock before the first D1 await, including admission.
 * Uncancellable operations retain an observed continuation. That continuation
 * checks the expired fence before admitting more work and closes only its own
 * still-running row; it can never rewrite a takeover or a reconciler's terminal.
 */
export async function runScheduledSlotWithFence(
  db: D1Database,
  slotKey: string,
  fn: (signal: AbortSignal, fence: ScheduledExecutionFence) => Promise<ScheduledSlotFenceMetadata | void>,
  opts: ScheduledSlotExecutionOptions,
): Promise<ScheduledSlotExecutionResult> {
  const deadline = opts.deadline ?? createSlotDeadline(Date.now(), opts.deadlineMs);
  const owner = opts.owner ?? createLeaseOwner(slotKey);
  const controller = new AbortController();
  let admitted = false;
  let workDrained = true;
  const checkpoint = () => assertSlotDeadline(deadline, controller.signal);
  const timeout = setTimeout(() => controller.abort(
    new ScheduledSlotDeadlineExceededError(slotKey, opts.slotStartedAt),
  ), deadline.remainingMs());
  const work = runScheduledSlotLifecycle(db, slotKey, fn, { ...opts, owner, deadline },
    controller, checkpoint, () => { admitted = true; }, (drained) => { workDrained = drained; }).catch(async (error: unknown) => {
      if (!workDrained) throw error;
      // Also handles a claim/marker that committed after the caller timed out.
      // Never terminate an executing child: its ledger and lease remain the
      // recovery authority until it settles or the shared stale policy fires.
      await runWithOverloadRetry(() => db.prepare(
        `UPDATE cron_slot_executions
            SET state = 'finished', result_status = 'error', finished_at = ?, updated_at = ?,
                execution_generation = execution_generation + 1, metadata = ?
          WHERE slot_key = ? AND slot_started_at = ? AND execution_owner = ? AND state = 'running'
            AND NOT EXISTS (SELECT 1 FROM scheduled_child_attempts
              WHERE execution_schedule_key = cron_slot_executions.slot_key
                AND execution_slot_started_at = cron_slot_executions.slot_started_at AND terminal_token IS NULL)`,
      ).bind(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000),
        JSON.stringify({ reason: "scheduled-slot-failed", error: toErrorMessage(error),
          disposition: admitted ? "claimed-failed" : "delivered-not-admitted",
          invocationId: opts.invocationId ?? owner, slotDeadlineMs: deadline.platformDeadlineMs }),
        slotKey, opts.slotStartedAt, owner).run()).catch((cleanupError: unknown) => {
          logWorkerEventArgs("lib", "warn", "[cron-slot] Fenced late-result cleanup failed:", cleanupError);
        });
      throw error;
    });
  try {
    const outcome = await settleAfterAbort(() => work, controller.signal, {
      platformDeadlineMs: deadline.platformDeadlineMs,
    });
    if (outcome.status === "fulfilled") {
      if (outcome.value.status !== "ok") {
        logWorkerEvent({
          scope: "handler", level: "info", event: "scheduled-slot-delivery", status: "skipped_neutral",
          message: "Scheduled delivery was not admitted",
          metadata: { disposition: "delivered-not-admitted", reason: outcome.value.status,
            scheduleKey: slotKey, slotStartedAt: opts.slotStartedAt, invocationId: opts.invocationId ?? owner,
            eventEntryMs: deadline.eventEntryMs, slotDeadlineMs: deadline.platformDeadlineMs },
        });
      }
      return outcome.value;
    }
    if (outcome.status === "rejected") throw outcome.error;
    // Observe the entire mutation tail, not merely Promise.race's winning arm.
    const observed = work.catch((error: unknown) => {
      logWorkerEventArgs("lib", "warn", "[cron-slot] Late fenced lifecycle settled:", error);
    });
    opts.waitUntil?.(retainUntilDeadline(observed,
      deadline.platformDeadlineMs + SCHEDULED_SLOT_CONTROLLED_ERROR_RESERVE_MS));
    throw outcome.error ?? outcome.reason;
  } catch (error) {
    logWorkerEvent({
      scope: "handler", level: "error", event: "scheduled-slot-delivery", status: "error",
      message: "Scheduled delivery failed within its event-entry deadline",
      metadata: { reason: "scheduled-slot-failed", disposition: admitted ? "claimed-failed" : "delivered-not-admitted",
        scheduleKey: slotKey, slotStartedAt: opts.slotStartedAt, invocationId: opts.invocationId ?? owner,
        eventEntryMs: deadline.eventEntryMs, slotDeadlineMs: deadline.platformDeadlineMs },
      error,
    });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
