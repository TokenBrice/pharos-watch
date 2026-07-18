import {
  flattenScheduledSlotPlanJobs,
  getScheduledTaskDescriptor,
  SCHEDULED_SLOT_PLANS,
} from "@shared/lib/scheduled-runner-registry";
import type { CronScheduleKey } from "@shared/lib/cron-jobs";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { markWorkerJobAttemptsAbandonedForSlot } from "./job-ledger";
import { recordProducerOutcome } from "./producer-history";

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
};

export interface StaleSlotReconciliationSummary {
  syntheticCronRuns: number;
  jobAttemptsAbandoned: number;
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

export const STALE_SLOT_ABANDONED_EVENT_TYPE = "scheduled-slot-abandoned";
const STALE_SLOT_ERROR = "scheduled slot heartbeat stale; marked expired by later invocation";

export function cacheKeySegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (normalized || "unknown").slice(0, 96);
}

export function staleSlotEventCacheKey(scheduleKey: string): string {
  return `cron:event:${cacheKeySegment(scheduleKey)}:${cacheKeySegment(STALE_SLOT_ABANDONED_EVENT_TYPE)}`;
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

function getExpectedJobsForScheduledSlot(slotKey: string): readonly string[] {
  const plan = SCHEDULED_SLOT_PLANS[slotKey as CronScheduleKey];
  return plan ? flattenScheduledSlotPlanJobs(plan) : [];
}

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
          LIMIT 1`,
      )
      .bind(slotStartedAt, ...jobs, nowSec)
      .first<{ active: number }>(),
  );
  return row?.active === 1;
}

async function getCronLeaseForJob(db: D1Database, job: string): Promise<StaleSlotLeaseRow | null> {
  return runWithOverloadRetry(() =>
    db.prepare("SELECT lease_owner, lease_until FROM cron_leases WHERE job = ?").bind(job).first<StaleSlotLeaseRow>(),
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
  lease: StaleSlotLeaseRow,
  nowSec: number,
): Promise<boolean> {
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
         SELECT ?, ?, ?, 'error', ?, NULL, ?, ?, ?, ?, ?, 'scheduled-job', ?, ?, 0, 0, NULL
          WHERE NOT EXISTS (
            SELECT 1 FROM cron_runs WHERE job = ? AND slot_started_at = ?
          )
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        progress.job,
        startedAt,
        durationMs,
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
    completedAt: nowSec,
    outcome: "abandoned",
    itemCount: null,
    metadata,
    error,
    productivity: { productive: false, reason: "platform-abandoned" },
  });
  return inserted;
}

async function insertSyntheticNotStartedCronRun(
  db: D1Database,
  slot: StaleSlotExecutionArtifact,
  job: string,
  nowSec: number,
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
  const metadata = JSON.stringify({
    reason: "stale-slot-reconciled",
    failureCategory: "platform-abandoned",
    childDisposition: "not_started",
    slotKey: slot.slot_key,
    slotStartedAt: slot.slot_started_at,
    slotOwner: slot.execution_owner,
    reconciledAt: nowSec,
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
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        job,
        nowSec,
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
    invokedAt: nowSec,
    completedAt: nowSec,
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
): Promise<StaleSlotReconciliationSummary> {
  const summary: StaleSlotReconciliationSummary = {
    syntheticCronRuns: 0,
    jobAttemptsAbandoned: 0,
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

  for (const job of noProgressJobs) {
    if (await insertSyntheticNotStartedCronRun(db, slot, job, nowSec)) {
      summary.notStartedCronRuns++;
      summary.syntheticCronRuns++;
    }
  }

  for (const progress of progressRowsWithoutOwner) {
    try {
      summary.jobAttemptsAbandoned += await markWorkerJobAttemptsAbandonedForSlot(db, {
        scheduleKey: slot.slot_key,
        slotStartedAt: slot.slot_started_at,
        jobs: [progress.job],
        nowSec,
        error: STALE_SLOT_ERROR,
        metadata: {
          reason: "stale-slot-reconciled",
          reconciliationSource: "slot-ownerless-progress-sweep",
          slotKey: slot.slot_key,
          slotStartedAt: slot.slot_started_at,
          slotOwner: slot.execution_owner,
          progressStage: progress.stage,
          progressUpdatedAt: progress.updated_at,
          reconciledAt: nowSec,
        },
      });
    } catch (err) {
      console.warn(`[cron-slot] Failed to abandon ownerless attempt for ${progress.job}@${slot.slot_started_at}:`, err);
    }
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
    if (!lease || lease.lease_owner !== progress.lease_owner || lease.lease_until >= nowSec) continue;

    if (await insertSyntheticStaleCronRun(db, slot, progress, lease, nowSec)) {
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
  slot: StaleSlotExecutionArtifact,
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
  try {
    await runWithOverloadRetry(() =>
      db
        .prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
        .bind(staleSlotEventCacheKey(slot.slot_key), JSON.stringify(record), nowSec)
        .run(),
    );
    console.error(`[cron-event:${slot.slot_key}] ${STALE_SLOT_ABANDONED_EVENT_TYPE}: ${record.message}`);
  } catch (err) {
    console.warn(`[cron-slot] Failed to persist stale slot marker for ${slot.slot_key}@${slot.slot_started_at}:`, err);
  }
}

/** Reconcile durable child artifacts and record the corresponding operator event as one internal stage. */
export async function reconcileStaleSlotArtifactsAndRecordEvent(
  db: D1Database,
  slot: StaleSlotExecutionArtifact,
  nowSec: number,
): Promise<StaleSlotReconciliationSummary> {
  const reconciliation = await reconcileStaleSlotArtifacts(db, slot, nowSec);
  await writeStaleSlotEventMarker(db, slot, nowSec, reconciliation);
  return reconciliation;
}
