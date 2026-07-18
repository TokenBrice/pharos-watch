import type { CronScheduleKey } from "@shared/lib/cron-jobs";
import { flattenScheduledSlotPlanJobs, SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";
import { createLeaseOwner } from "./cron-lease-primitives";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { toErrorMessage } from "./error-utils";
import {
  reconcileStaleSlotArtifactsAndRecordEvent,
  hasActiveChildLeaseForScheduledSlot,
  type ScheduledSlotReconciliationFence,
  type StaleSlotExecutionArtifact,
  type StaleSlotReconciliationSummary,
} from "./scheduled-slot-reconciliation";

export {
  cacheKeySegment,
  STALE_SLOT_ABANDONED_EVENT_TYPE,
  staleSlotEventCacheKey,
} from "./scheduled-slot-reconciliation";

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

const SLOT_EXECUTION_RUNNING_STALE_SEC = 35 * 60;
const SLOT_EXECUTION_HEARTBEAT_SEC = 3 * 60;

type SlotExecutionRow = {
  state: string;
  result_status: string | null;
  execution_owner: string;
  execution_generation: number;
  invocation_id: string | null;
  worker_version: string | null;
  started_at: number;
  finished_at: number | null;
  updated_at: number;
  metadata: string | null;
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
  jobAttemptsTerminalized: number;
  progressRowsCleared: number;
  leasesCleared: number;
  recoveryCheckpointsPrepared: number;
  notStartedCronRuns: number;
  successfulChildTerminals: number;
  skippedLockedChildTerminals: number;
  derivedPublishedChildTerminals: number;
  publicationFailures: number;
  terminalAccountingUnknown: number;
  realChildFailures: number;
  abandonedSlots: Array<{
    slotKey: string;
    slotStartedAt: number;
    slotOwner: string;
    slotUpdatedAt: number;
    abandonedJobs: StaleSlotReconciliationSummary["abandonedJobs"];
  }>;
}

const STALE_SLOT_ERROR = "scheduled slot heartbeat stale; marked expired by later invocation";

async function getScheduledSlotExecution(
  db: D1Database,
  slotKey: string,
  slotStartedAt: number,
): Promise<SlotExecutionRow | null> {
  return runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT state, result_status, execution_owner, execution_generation, invocation_id, worker_version,
                started_at, finished_at, updated_at, metadata
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
  predicates.push("state IN ('running', 'reconciling')", "updated_at < ?");
  bindArgs.push(staleBefore, limit);
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
  const slotPlan = SCHEDULED_SLOT_PLANS[slot.slot_key as CronScheduleKey];
  const expectedJobs = slotPlan ? flattenScheduledSlotPlanJobs(slotPlan) : [];
  const progressAbsencePredicate =
    expectedJobs.length === 0
      ? ""
      : `
           AND NOT EXISTS (
             SELECT 1
               FROM cron_run_progress
              WHERE slot_started_at = ?
                AND job IN (${expectedJobs.map(() => "?").join(", ")})
           )`;
  const hasDataFailure =
    reconciliation.publicationFailures > 0 ||
    reconciliation.realChildFailures > 0 ||
    reconciliation.notStartedCronRuns > 0 ||
    reconciliation.terminalAccountingUnknown > reconciliation.derivedPublishedChildTerminals;
  const resultStatus = hasDataFailure ? "error" : "degraded";
  const metadata = JSON.stringify({
    error: STALE_SLOT_ERROR,
    staleSlotReconciliation: reconciliation,
  });
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
           AND state = 'reconciling'
           AND execution_owner = ?
           AND execution_generation = ?${progressAbsencePredicate}`,
      )
      .bind(
        resultStatus,
        nowSec,
        nowSec,
        metadata,
        slot.slot_key,
        slot.slot_started_at,
        reconciliationOwner,
        reconciliationGeneration,
        ...(expectedJobs.length > 0 ? [slot.slot_started_at, ...expectedJobs] : []),
      )
      .run(),
  );
  if ((result.meta.changes ?? 0) === 1) return true;
  const current = await getScheduledSlotExecution(db, slot.slot_key, slot.slot_started_at);
  const remainingProgress =
    expectedJobs.length === 0
      ? null
      : await runWithOverloadRetry(() =>
          db
            .prepare(
              `SELECT 1 AS present
                 FROM cron_run_progress
                WHERE slot_started_at = ?
                  AND job IN (${expectedJobs.map(() => "?").join(", ")})
                LIMIT 1`,
            )
            .bind(slot.slot_started_at, ...expectedJobs)
            .first<{ present: number }>(),
        );
  return (
    remainingProgress == null &&
    current?.state === "finished" &&
    current.result_status === resultStatus &&
    current.execution_owner === reconciliationOwner &&
    current.execution_generation === reconciliationGeneration &&
    current.finished_at === nowSec &&
    current.updated_at === nowSec &&
    current.metadata === metadata
  );
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
            AND updated_at < ?`,
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
      )
      .run(),
  );
  if ((result.meta.changes ?? 0) === 1) return nextGeneration;
  const current = await getScheduledSlotExecution(db, slot.slot_key, slot.slot_started_at);
  return current?.state === "reconciling" &&
    current.execution_owner === reconciliationOwner &&
    current.execution_generation === nextGeneration &&
    current.updated_at === nowSec
    ? nextGeneration
    : null;
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
    jobAttemptsTerminalized: 0,
    progressRowsCleared: 0,
    leasesCleared: 0,
    recoveryCheckpointsPrepared: 0,
    notStartedCronRuns: 0,
    successfulChildTerminals: 0,
    skippedLockedChildTerminals: 0,
    derivedPublishedChildTerminals: 0,
    publicationFailures: 0,
    terminalAccountingUnknown: 0,
    realChildFailures: 0,
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
    const reconciliationFence: ScheduledSlotReconciliationFence = {
      slotKey: staleSlot.slot_key,
      slotStartedAt: staleSlot.slot_started_at,
      state: "reconciling",
      owner: reconciliationOwner,
      generation: reconciliationGeneration,
    };
    let reconciliation: StaleSlotReconciliationSummary | null = null;
    let finished = false;
    for (let reconciliationAttempt = 0; reconciliationAttempt < 3; reconciliationAttempt++) {
      reconciliation = await reconcileStaleSlotArtifactsAndRecordEvent(db, staleSlot, nowSec, reconciliationFence);
      finished = await finishStaleScheduledSlotExecution(
        db,
        staleSlot,
        reconciliationOwner,
        reconciliationGeneration,
        nowSec,
        reconciliation,
      );
      if (finished) break;
      const current = await getScheduledSlotExecution(db, staleSlot.slot_key, staleSlot.slot_started_at);
      if (
        current?.state !== "reconciling" ||
        current.execution_owner !== reconciliationOwner ||
        current.execution_generation !== reconciliationGeneration
      ) {
        throw new ScheduledSlotOwnershipLostError(staleSlot.slot_key, staleSlot.slot_started_at);
      }
    }
    if (!finished || reconciliation == null) {
      throw new Error(
        `reconciliation progress did not stabilize for ${staleSlot.slot_key}@${staleSlot.slot_started_at}`,
      );
    }
    summary.slotsReconciled++;
    summary.syntheticCronRuns += reconciliation.syntheticCronRuns;
    summary.jobAttemptsAbandoned += reconciliation.jobAttemptsAbandoned;
    summary.jobAttemptsTerminalized += reconciliation.jobAttemptsTerminalized;
    summary.progressRowsCleared += reconciliation.progressRowsCleared;
    summary.leasesCleared += reconciliation.leasesCleared;
    summary.recoveryCheckpointsPrepared += reconciliation.recoveryCheckpointsPrepared;
    summary.notStartedCronRuns += reconciliation.notStartedCronRuns;
    summary.successfulChildTerminals += reconciliation.successfulChildTerminals;
    summary.skippedLockedChildTerminals += reconciliation.skippedLockedChildTerminals;
    summary.derivedPublishedChildTerminals += reconciliation.derivedPublishedChildTerminals;
    summary.publicationFailures += reconciliation.publicationFailures;
    summary.terminalAccountingUnknown += reconciliation.terminalAccountingUnknown;
    summary.realChildFailures += reconciliation.realChildFailures;
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
    const nextGeneration = existing.execution_generation + 1;
    const takeoverMetadata = JSON.stringify({ staleSlotTakeover });
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
          takeoverMetadata,
          slotKey,
          slotStartedAt,
          existing.execution_owner,
          existing.execution_generation,
          existing.updated_at,
          staleBefore,
        )
        .run(),
    );
    const takeoverApplied = (takeover.meta.changes ?? 0) > 0;
    const currentAfterTakeover = takeoverApplied ? null : await getScheduledSlotExecution(db, slotKey, slotStartedAt);
    const exactTakeoverApplied =
      takeoverApplied ||
      (currentAfterTakeover?.state === "running" &&
        currentAfterTakeover.result_status == null &&
        currentAfterTakeover.execution_owner === owner &&
        currentAfterTakeover.execution_generation === nextGeneration &&
        currentAfterTakeover.invocation_id === invocationId &&
        currentAfterTakeover.worker_version === workerVersion &&
        currentAfterTakeover.started_at === nowSec &&
        currentAfterTakeover.finished_at == null &&
        currentAfterTakeover.updated_at === nowSec &&
        currentAfterTakeover.metadata === takeoverMetadata);
    if (exactTakeoverApplied) {
      const reconciliationFence: ScheduledSlotReconciliationFence = {
        slotKey,
        slotStartedAt,
        state: "running",
        owner,
        generation: nextGeneration,
      };
      const reconciliation = await reconcileStaleSlotArtifactsAndRecordEvent(
        db,
        staleSlot,
        nowSec,
        reconciliationFence,
      );
      staleSlotTakeover.reconciliation = reconciliation;
      const reconciledMetadata = JSON.stringify({ staleSlotTakeover });
      const metadataUpdate = await runWithOverloadRetry(() =>
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
          .bind(reconciledMetadata, slotKey, slotStartedAt, owner, nextGeneration)
          .run(),
      );
      if ((metadataUpdate.meta.changes ?? 0) !== 1) {
        const current = await getScheduledSlotExecution(db, slotKey, slotStartedAt);
        const exactMetadataApplied =
          current?.state === "running" &&
          current.execution_owner === owner &&
          current.execution_generation === nextGeneration &&
          current.metadata === reconciledMetadata;
        if (!exactMetadataApplied) {
          throw new ScheduledSlotOwnershipLostError(slotKey, slotStartedAt);
        }
      }
      return {
        status: "claimed",
        executionGeneration: nextGeneration,
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
  if ((result.meta.changes ?? 0) === 1) return true;
  const current = await getScheduledSlotExecution(db, slotKey, slotStartedAt);
  return (
    current?.state === "finished" &&
    current.result_status === resultStatus &&
    current.execution_owner === owner &&
    current.execution_generation === executionGeneration &&
    current.finished_at === nowSec &&
    current.updated_at === nowSec &&
    current.metadata === metadata
  );
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
  let heartbeatInFlight: Promise<void> | null = null;
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
        console.warn(`[cron-slot] Failed to heartbeat slot ${slotKey}@${opts.slotStartedAt}:`, err);
      })
      .finally(() => {
        heartbeatInFlight = null;
      });
  }, heartbeatSec * 1000);

  try {
    const metadata = await fn(slotController.signal);
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
      console.warn(`[cron-slot] Failed to finish slot ${slotKey}@${opts.slotStartedAt}:`, finishErr);
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
