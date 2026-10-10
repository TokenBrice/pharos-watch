import type { ScheduledWorkerRole } from "@shared/lib/scheduled-runner-registry";
import { logWorkerEventArgs } from "./structured-log";
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

export { staleSlotEventCacheKey } from "./scheduled-slot-reconciliation";

import { SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";
import type { CronScheduleKey } from "@shared/lib/cron-jobs";
import type { SlotDeadline } from "./cron-timeouts";
import { settleAfterAbort } from "./cron-abort-settlement";
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
  staleAfterSec?: number;
  preSweepStale?: boolean;
  preSweepLimit?: number;
  deadlineMs?: number;
  deadline?: SlotDeadline;
  invocationId?: string | null;
  workerVersion?: string | null;
  workerRole?: ScheduledWorkerRole;
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

export const SLOT_EXECUTION_HEARTBEAT_SEC = resolveScheduledSlotPolicy("").heartbeatSec;

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
  recoveryCheckpointsPrepared: number;
  notStartedCronRuns: number;
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
  const staleBefore = nowSec - staleAfterSec;
  const staleSlots = await listStaleScheduledSlotExecutions(
    db,
    options.slotKey ?? null,
    nowSec,
    nowSec - policy.hardDeadSec,
    limit,
    options.excludeSlotStartedAt,
  );
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
    const reconciliationOwner = createLeaseOwner(`stale-slot:${staleSlot.slot_key}`);
    const reconciliationGeneration = await claimStaleScheduledSlotForReconciliation(
      db,
      staleSlot,
      reconciliationOwner,
      nowSec,
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
  const policy = resolveScheduledSlotPolicy(slotKey);
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
  fn: (signal: AbortSignal, fence: ScheduledExecutionFence) => Promise<ScheduledSlotFenceMetadata | void>,
  opts: ScheduledSlotExecutionOptions,
): Promise<ScheduledSlotExecutionResult> {
  const owner = opts.owner ?? createLeaseOwner(slotKey);
  const policy = resolveScheduledSlotPolicy(slotKey);
  const heartbeatSec = Math.max(15, opts.heartbeatSec ?? policy.heartbeatSec);
  const staleAfterSec = policy.slotSilenceSec;
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
      logWorkerEventArgs("lib", "warn", `[cron-slot] Failed to pre-sweep stale slots for ${slotKey}:`, err);
    }
  }
  const claimResult = await claimScheduledSlotExecution(
    db,
    slotKey,
    opts.slotStartedAt,
    owner,
    staleAfterSec,
    opts.invocationId ?? owner,
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
  if ((stamped.meta.changes ?? 0) !== 1) throw new ScheduledSlotOwnershipLostError(slotKey, opts.slotStartedAt);

  const slotController = new AbortController();
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
    const outcome = await settleAfterAbort(() => fn(slotController.signal, executionFence), slotController.signal, {
      observer: true, platformDeadlineMs: opts.deadline?.platformDeadlineMs,
    });
    clearTimeout(deadlineTimer ?? undefined);
    if (outcome.status === "aborted") {
      workDrained = outcome.settled;
      throw outcome.error ?? outcome.reason;
    }
    if (outcome.status === "rejected") throw outcome.error;
    const metadata = outcome.value;
    const slotMetadata = {
      ...attachSlotRuntimeMetadata(metadata, heartbeatFailures, staleSlotPreSweep, staleSlotTakeover),
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
    clearInterval(timer);
  }
}
