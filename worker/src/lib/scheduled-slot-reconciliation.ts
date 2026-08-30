import {
  flattenScheduledSlotPlanJobs,
  getScheduledTaskDescriptor,
  SCHEDULED_SLOT_PLANS,
} from "@shared/lib/scheduled-runner-registry";
import type { CronScheduleKey } from "@shared/lib/cron-jobs";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { recordProducerOutcome } from "./producer-history";
import { cronEventCacheKey, logCronEvent } from "./cron-logger";


export interface StaleSlotExecutionArtifact {
  slot_key: string;
  slot_started_at: number;
  state: "running" | "reconciling";
  execution_owner: string;
  execution_generation: number;
  invocation_id?: string | null;
  worker_version?: string | null;
  started_at: number;
  updated_at: number;
}

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
  heartbeat_at: number;
};

export interface StaleSlotReconciliationFence {
  owner: string;
  generation: number;
  state: "running" | "reconciling";
}

export interface StaleSlotReconciliationSummary {
  syntheticCronRuns: number;
  progressRowsCleared: number;
  leasesCleared: number;
  recoveryCheckpointsPrepared: number;
  notStartedCronRuns: number;
  abandonedJobs: Array<{
    job: string;
    progressStage: string | null;
    progressUpdatedAt: number;
    leaseOwner: string | null;
    leaseUntil: number | null;
  }>;
}

const STALE_SLOT_ABANDONED_EVENT_TYPE = "scheduled-slot-abandoned";

/**
 * Exact `cron_runs.error` text the fence writes when it expires a stale slot.
 * The duration watchdog matches on it verbatim, so the two must never drift.
 */
export const STALE_SLOT_ERROR = "scheduled slot heartbeat stale; marked expired by later invocation";

export function staleSlotEventCacheKey(scheduleKey: string): string {
  return cronEventCacheKey(scheduleKey, STALE_SLOT_ABANDONED_EVENT_TYPE);
}

async function listProgressRowsForStaleSlot(
  db: D1Database,
  slotStartedAt: number,
  jobs: readonly string[],
): Promise<StaleSlotProgressRow[]> {
  if (jobs.length === 0) return [];
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

export function getExpectedJobsForScheduledSlot(slotKey: string): readonly string[] {
  const plan = SCHEDULED_SLOT_PLANS[slotKey as CronScheduleKey];
  return plan ? flattenScheduledSlotPlanJobs(plan) : [];
}

// A live child renews its lease heartbeat every 30-120 seconds, so a lease
// whose heartbeat went silent for five minutes belongs to a dead isolate even
// while its TTL (up to ~15 minutes for long jobs) has not expired. Without
// this bound a dead child's lease keeps its slot un-reconcilable for the whole
// TTL after an OOM kill.
const CHILD_LEASE_HEARTBEAT_STALE_SEC = 5 * 60;

export async function hasActiveChildLeaseForScheduledSlot(
  db: D1Database,
  slotKey: string,
  slotStartedAt: number,
  nowSec: number,
): Promise<boolean> {
  const jobs = getExpectedJobsForScheduledSlot(slotKey);
  if (jobs.length === 0) return false;
  const row = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT 1 AS active
           FROM cron_run_progress p
           JOIN cron_leases l
             ON l.job = p.job
            AND l.lease_owner = p.lease_owner
          WHERE p.slot_started_at = ?
            AND p.job IN (${jobs.map(() => "?").join(", ")})
            AND l.lease_until >= ?
            AND l.heartbeat_at >= ?
          LIMIT 1`,
      )
      .bind(slotStartedAt, ...jobs, nowSec, nowSec - CHILD_LEASE_HEARTBEAT_STALE_SEC)
      .first<{ active: number }>(),
  );
  return row?.active === 1;
}

async function isSlotFenceCurrent(
  db: D1Database,
  slot: StaleSlotExecutionArtifact,
  fence?: StaleSlotReconciliationFence,
): Promise<boolean> {
  if (!fence) return true;
  const row = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT 1 AS current
           FROM cron_slot_executions
          WHERE slot_key = ?
            AND slot_started_at = ?
            AND state = ?
            AND execution_owner = ?
            AND execution_generation = ?
          LIMIT 1`,
      )
      .bind(slot.slot_key, slot.slot_started_at, fence.state, fence.owner, fence.generation)
      .first<{ current: number }>(),
  );
  return row?.current === 1;
}

async function getCronLeaseForJob(db: D1Database, job: string): Promise<StaleSlotLeaseRow | null> {
  return runWithOverloadRetry(() =>
    db
      .prepare("SELECT lease_owner, lease_until, heartbeat_at FROM cron_leases WHERE job = ?")
      .bind(job)
      .first<StaleSlotLeaseRow>(),
  );
}

async function hasCronRunWithIdempotencyKey(
  db: D1Database,
  job: string,
  slotStartedAt: number,
  idempotencyKey: string,
): Promise<boolean> {
  const row = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT id
           FROM cron_runs
          WHERE job = ? AND slot_started_at = ? AND idempotency_key = ?
          LIMIT 1`,
      )
      .bind(job, slotStartedAt, idempotencyKey)
      .first<{ id: number }>(),
  );
  return row != null;
}

async function canPersistSyntheticProducerOutcome(
  db: D1Database,
  input: {
    scheduleKey: string;
    job: string;
    producerPath: string;
    invocationId: string;
    idempotencyKey: string;
  },
): Promise<boolean> {
  const row = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT idempotency_key
           FROM worker_producer_history
          WHERE schedule_key = ?
            AND job = ?
            AND producer_path = ?
            AND producer_kind = 'scheduled-job'
            AND invocation_id = ?
          LIMIT 1`,
      )
      .bind(input.scheduleKey, input.job, input.producerPath, input.invocationId)
      .first<{ idempotency_key: string }>(),
  );
  return row == null || row.idempotency_key === input.idempotencyKey;
}

async function insertSyntheticStaleCronRun(
  db: D1Database,
  slot: StaleSlotExecutionArtifact,
  progress: StaleSlotProgressRow,
  lease: StaleSlotLeaseRow | null,
  nowSec: number,
  fence?: StaleSlotReconciliationFence,
  reconcilerWorkerVersion?: string | null,
): Promise<boolean> {
  const startedAt = progress.started_at || slot.started_at || slot.slot_started_at;
  const activeDurationMs = Math.max(0, progress.updated_at - startedAt) * 1000;
  const reconciliationDelayMs = Math.max(0, nowSec - progress.updated_at) * 1000;
  // Progress timestamps are second-resolution. A zero-duration child has no
  // progress beyond its startup second, so a known version change is strong
  // evidence that the isolate was interrupted by deployment before it could
  // do useful work.
  // Keep the neutral classification fail-closed when either version is absent
  // or unchanged: those cases can still be an in-place kill or a real fault.
  const interruptedByWorkerDeploy =
    progress.updated_at === startedAt
    && slot.worker_version != null
    && reconcilerWorkerVersion != null
    && slot.worker_version !== reconcilerWorkerVersion;
  const status = interruptedByWorkerDeploy ? "skipped_neutral" : "error";
  const outcome = interruptedByWorkerDeploy ? "skipped_neutral" : "abandoned";
  const error = interruptedByWorkerDeploy ? null : "scheduled slot heartbeat stale; child job progress abandoned";
  const metadata = JSON.stringify({
    reason: "stale-slot-reconciled",
    failureCategory: interruptedByWorkerDeploy ? "platform-interrupted" : "platform-abandoned",
    childDisposition: interruptedByWorkerDeploy ? "interrupted-by-deploy" : "abandoned",
    interruptedByWorkerVersionChange: interruptedByWorkerDeploy,
    slotKey: slot.slot_key,
    slotStartedAt: slot.slot_started_at,
    slotOwner: slot.execution_owner,
    progressStage: progress.stage,
    progressUpdatedAt: progress.updated_at,
    leaseOwner: progress.lease_owner,
    leaseUntil: lease?.lease_until ?? null,
    reconciledAt: nowSec,
    activeDurationMs,
    reconciliationDelayMs,
    // Dead isolate's version rides the worker_version column; recording the
    // reconciler's version alongside makes deploy-eviction (versions differ at
    // time of death) vs in-place kill (e.g. OOM) decidable from this row.
    slotWorkerVersion: slot.worker_version ?? null,
    reconciledByWorkerVersion: reconcilerWorkerVersion ?? null,
  });
  const idempotencyKey = ["scheduled-slot-stale", slot.slot_key, slot.slot_started_at, progress.job, startedAt].join(
    ":",
  );
  const descriptor = getScheduledTaskDescriptor(slot.slot_key as CronScheduleKey, progress.job);
  const invocationId = slot.invocation_id ?? `platform-abandoned:${slot.execution_owner}`;
  if (
    !(await canPersistSyntheticProducerOutcome(db, {
      scheduleKey: slot.slot_key,
      job: progress.job,
      producerPath: descriptor.producerPath,
      invocationId,
      idempotencyKey,
    }))
  ) {
    return false;
  }

  const result = await runWithOverloadRetry(() =>
    db
      .prepare(
        `INSERT INTO cron_runs
           (job, started_at, duration_ms, status, error, item_count, metadata, slot_started_at, idempotency_key,
            schedule_key, producer_path, producer_kind, invocation_id, worker_version,
            productive, publication_count, calendar_period)
         SELECT ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'scheduled-job', ?, ?, 0, 0, NULL
          WHERE NOT EXISTS (
            SELECT 1 FROM cron_runs WHERE job = ? AND slot_started_at = ?
          )
            AND NOT EXISTS (
              SELECT 1 FROM cron_run_progress WHERE job = ? AND slot_started_at = ?
            )
            AND (
              ? IS NULL OR EXISTS (
                SELECT 1 FROM cron_slot_executions
                 WHERE slot_key = ?
                   AND slot_started_at = ?
                   AND state = ?
                   AND execution_owner = ?
                   AND execution_generation = ?
              )
            )
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        progress.job,
        startedAt,
        activeDurationMs,
        status,
        error,
        metadata,
        slot.slot_started_at,
        idempotencyKey,
        slot.slot_key,
        descriptor.producerPath,
        invocationId,
        slot.worker_version ?? null,
        progress.job,
        slot.slot_started_at,
        progress.job,
        slot.slot_started_at,
        fence?.owner ?? null,
        slot.slot_key,
        slot.slot_started_at,
        fence?.state ?? null,
        fence?.owner ?? null,
        fence?.generation ?? null,
      )
      .run(),
  );
  const inserted = (result.meta.changes ?? 0) === 1;
  if (!inserted && !(await hasCronRunWithIdempotencyKey(db, progress.job, slot.slot_started_at, idempotencyKey))) {
    return false;
  }
  await recordProducerOutcome(db, {
    scheduleKey: slot.slot_key,
    job: progress.job,
    producerPath: descriptor.producerPath,
    producerKind: "scheduled-job",
    invocationId,
    workerVersion: slot.worker_version ?? null,
    slotStartedAt: slot.slot_started_at,
    idempotencyKey,
    invokedAt: startedAt,
    // Preserve the last durable child heartbeat as the logical terminal time.
    // Reconciliation time stays in metadata and must not outrank a newer run.
    completedAt: progress.updated_at,
    outcome,
    itemCount: null,
    metadata,
    error,
    productivity: {
      productive: false,
      reason: interruptedByWorkerDeploy ? "platform-interrupted-by-deploy" : "platform-abandoned",
    },
  });
  return inserted;
}

async function insertSyntheticNotStartedCronRun(
  db: D1Database,
  slot: StaleSlotExecutionArtifact,
  job: string,
  nowSec: number,
  fence?: StaleSlotReconciliationFence,
  reconcilerWorkerVersion?: string | null,
): Promise<boolean> {
  const idempotencyKey = ["scheduled-slot-not-started", slot.slot_key, slot.slot_started_at, job].join(":");
  const descriptor = getScheduledTaskDescriptor(slot.slot_key as CronScheduleKey, job);
  const invocationId = slot.invocation_id ?? `platform-abandoned:${slot.execution_owner}`;
  if (
    !(await canPersistSyntheticProducerOutcome(db, {
      scheduleKey: slot.slot_key,
      job,
      producerPath: descriptor.producerPath,
      invocationId,
      idempotencyKey,
    }))
  ) {
    return false;
  }
  const error = "scheduled slot abandoned before child job started";
  const invokedAt = slot.started_at || slot.slot_started_at;
  const completedAt = Math.max(invokedAt, slot.updated_at);
  const metadata = JSON.stringify({
    reason: "stale-slot-reconciled",
    failureCategory: "platform-abandoned",
    childDisposition: "not_started",
    slotKey: slot.slot_key,
    slotStartedAt: slot.slot_started_at,
    slotOwner: slot.execution_owner,
    reconciledAt: nowSec,
    slotWorkerVersion: slot.worker_version ?? null,
    reconciledByWorkerVersion: reconcilerWorkerVersion ?? null,
  });
  const result = await runWithOverloadRetry(() =>
    db
      .prepare(
        `INSERT INTO cron_runs
           (job, started_at, duration_ms, status, error, item_count, metadata, slot_started_at, idempotency_key,
            schedule_key, producer_path, producer_kind, invocation_id, worker_version,
            productive, publication_count, calendar_period)
         SELECT ?, ?, 0, 'error', ?, 0, ?, ?, ?, ?, ?, 'scheduled-job', ?, ?, 0, 0, NULL
          WHERE NOT EXISTS (
            SELECT 1 FROM cron_runs WHERE job = ? AND slot_started_at = ?
          )
            AND NOT EXISTS (
              SELECT 1 FROM cron_run_progress WHERE job = ? AND slot_started_at = ?
            )
            AND (
              ? IS NULL OR EXISTS (
                SELECT 1 FROM cron_slot_executions
                 WHERE slot_key = ?
                   AND slot_started_at = ?
                   AND state = ?
                   AND execution_owner = ?
                   AND execution_generation = ?
              )
            )
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        job,
        invokedAt,
        error,
        metadata,
        slot.slot_started_at,
        idempotencyKey,
        slot.slot_key,
        descriptor.producerPath,
        invocationId,
        slot.worker_version ?? null,
        job,
        slot.slot_started_at,
        job,
        slot.slot_started_at,
        fence?.owner ?? null,
        slot.slot_key,
        slot.slot_started_at,
        fence?.state ?? null,
        fence?.owner ?? null,
        fence?.generation ?? null,
      )
      .run(),
  );
  const inserted = (result.meta.changes ?? 0) === 1;
  if (!inserted && !(await hasCronRunWithIdempotencyKey(db, job, slot.slot_started_at, idempotencyKey))) {
    return false;
  }
  await recordProducerOutcome(db, {
    scheduleKey: slot.slot_key,
    job,
    producerPath: descriptor.producerPath,
    producerKind: "scheduled-job",
    invocationId,
    workerVersion: slot.worker_version ?? null,
    slotStartedAt: slot.slot_started_at,
    idempotencyKey,
    invokedAt,
    completedAt,
    outcome: "not_started",
    itemCount: 0,
    metadata,
    error,
    productivity: { productive: false, reason: "platform-abandoned-before-start" },
  });
  return inserted;
}

async function reconcileStaleSlotArtifacts(
  db: D1Database,
  slot: StaleSlotExecutionArtifact,
  nowSec: number,
  fence?: StaleSlotReconciliationFence,
  reconcilerWorkerVersion?: string | null,
): Promise<StaleSlotReconciliationSummary> {
  const summary: StaleSlotReconciliationSummary = {
    syntheticCronRuns: 0,
    progressRowsCleared: 0,
    leasesCleared: 0,
    recoveryCheckpointsPrepared: 0,
    notStartedCronRuns: 0,
    abandonedJobs: [],
  };
  const expectedJobs = getExpectedJobsForScheduledSlot(slot.slot_key);
  const progressRows = await listProgressRowsForStaleSlot(db, slot.slot_started_at, expectedJobs);
  const progressRowsWithOwner = progressRows.filter(
    (progress): progress is StaleSlotProgressRow & { lease_owner: string } =>
      typeof progress.lease_owner === "string" && progress.lease_owner.length > 0,
  );
  const progressRowsWithoutOwner = progressRows.filter((progress) => !progress.lease_owner);
  const progressJobs = new Set(progressRows.map((progress) => progress.job));
  const noProgressJobs = expectedJobs.filter((job) => !progressJobs.has(job));
  const stillMissingProgressJobs: string[] = [];
  for (const job of noProgressJobs) {
    const row = await runWithOverloadRetry(() =>
      db
        .prepare(
          `SELECT 1 AS present
             FROM cron_run_progress
            WHERE job = ?
              AND slot_started_at = ?
            LIMIT 1`,
        )
        .bind(job, slot.slot_started_at)
        .first<{ present: number }>(),
    );
    if (!row && (await isSlotFenceCurrent(db, slot, fence))) {
      stillMissingProgressJobs.push(job);
    }
  }
  const unconditionallyDueMissingJobs = stillMissingProgressJobs.filter(
    (job) => !(slot.slot_key === "digestTriggerPoll" && job === "daily-digest"),
  );
  for (const job of unconditionallyDueMissingJobs) {
    if (await insertSyntheticNotStartedCronRun(db, slot, job, nowSec, fence, reconcilerWorkerVersion)) {
      summary.notStartedCronRuns++;
      summary.syntheticCronRuns++;
    }
  }

  for (const progress of progressRowsWithoutOwner) {
    if (!(await isSlotFenceCurrent(db, slot, fence))) continue;
    const progressDelete = await runWithOverloadRetry(() =>
      db
        .prepare(
          `DELETE FROM cron_run_progress
           WHERE job = ?
             AND slot_started_at = ?
             AND started_at = ?
             AND updated_at = ?
             AND (lease_owner IS NULL OR lease_owner = '')`,
        )
        .bind(progress.job, slot.slot_started_at, progress.started_at, progress.updated_at)
        .run(),
    );
    const cleared = progressDelete.meta.changes ?? 0;
    summary.progressRowsCleared += cleared;
    if (cleared === 0) continue;
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
      if (!(await isSlotFenceCurrent(db, slot, fence))) continue;
      const progressDelete = await runWithOverloadRetry(() =>
        db.prepare(
          `DELETE FROM cron_run_progress
           WHERE job = ? AND slot_started_at = ? AND started_at = ? AND updated_at = ?
             AND lease_owner = ? AND NOT EXISTS (SELECT 1 FROM cron_leases WHERE job = ? AND lease_owner = ?)
             AND (? IS NULL OR EXISTS (
               SELECT 1 FROM cron_slot_executions
                WHERE slot_key = ? AND slot_started_at = ? AND state = ?
                  AND execution_owner = ? AND execution_generation = ?
             ))`,
        )
          .bind(
            progress.job, slot.slot_started_at, progress.started_at, progress.updated_at,
            progress.lease_owner, progress.job, progress.lease_owner, fence?.owner ?? null,
            slot.slot_key, slot.slot_started_at, fence?.state ?? null, fence?.owner ?? null, fence?.generation ?? null,
          )
          .run(),
      );
      const cleared = progressDelete.meta.changes ?? 0;
      summary.progressRowsCleared += cleared;
      if (cleared === 0) continue;

      if (await insertSyntheticStaleCronRun(db, slot, progress, null, nowSec, fence, reconcilerWorkerVersion)) {
        summary.syntheticCronRuns++;
      }
      summary.abandonedJobs.push({
        job: progress.job,
        progressStage: progress.stage,
        progressUpdatedAt: progress.updated_at,
        leaseOwner: progress.lease_owner,
        leaseUntil: null,
      });
      continue;
    }
    // A lease is dead when its TTL expired OR its heartbeat went silent past
    // the child heartbeat window: renewals run every 30-120s, so a silent
    // lease belongs to a killed isolate even while the TTL has not lapsed.
    const leaseDead =
      lease.lease_until < nowSec || lease.heartbeat_at < nowSec - CHILD_LEASE_HEARTBEAT_STALE_SEC;
    if (!leaseDead) continue;

    if (!(await isSlotFenceCurrent(db, slot, fence))) continue;
    const progressDelete = await runWithOverloadRetry(() =>
      db
        .prepare(
          `DELETE FROM cron_run_progress
           WHERE job = ?
             AND slot_started_at = ?
             AND started_at = ?
             AND updated_at = ?
             AND lease_owner = ?
             AND EXISTS (
               SELECT 1 FROM cron_leases
                WHERE job = ?
                  AND lease_owner = ?
                  AND lease_until = ?
                  AND (lease_until < ? OR heartbeat_at < ?)
             )`,
        )
        .bind(
          progress.job,
          slot.slot_started_at,
          progress.started_at,
          progress.updated_at,
          progress.lease_owner,
          progress.job,
          progress.lease_owner,
          lease.lease_until,
          nowSec,
          nowSec - CHILD_LEASE_HEARTBEAT_STALE_SEC,
        )
        .run(),
    );
    const cleared = progressDelete.meta.changes ?? 0;
    summary.progressRowsCleared += cleared;
    if (cleared === 0) continue;

    if (await insertSyntheticStaleCronRun(db, slot, progress, lease, nowSec, fence, reconcilerWorkerVersion)) {
      summary.syntheticCronRuns++;
    }
    summary.abandonedJobs.push({
      job: progress.job,
      progressStage: progress.stage,
      progressUpdatedAt: progress.updated_at,
      leaseOwner: progress.lease_owner,
      leaseUntil: lease.lease_until,
    });
    const leaseDelete = await runWithOverloadRetry(() =>
      db
        .prepare(
          "DELETE FROM cron_leases WHERE job = ? AND lease_owner = ? AND lease_until = ? AND (lease_until < ? OR heartbeat_at < ?)",
        )
        .bind(progress.job, progress.lease_owner, lease.lease_until, nowSec, nowSec - CHILD_LEASE_HEARTBEAT_STALE_SEC)
        .run(),
    );
    summary.leasesCleared += leaseDelete.meta.changes ?? 0;
  }

  return summary;
}

async function writeStaleSlotEventMarker(
  db: D1Database,
  slot: StaleSlotExecutionArtifact,
  nowSec: number,
  reconciliation: StaleSlotReconciliationSummary,
): Promise<void> {
  await logCronEvent(db, {
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
  });
}

/** Reconcile durable child artifacts and record the corresponding operator event as one internal stage. */
export async function reconcileStaleSlotArtifactsAndRecordEvent(
  db: D1Database,
  slot: StaleSlotExecutionArtifact,
  nowSec: number,
  fence?: StaleSlotReconciliationFence,
  reconcilerWorkerVersion?: string | null,
): Promise<StaleSlotReconciliationSummary> {
  const reconciliation = await reconcileStaleSlotArtifacts(db, slot, nowSec, fence, reconcilerWorkerVersion);
  await writeStaleSlotEventMarker(db, slot, nowSec, reconciliation);
  return reconciliation;
}
