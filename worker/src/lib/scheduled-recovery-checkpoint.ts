import { runWithOverloadRetry } from "./d1-overload-retry";
import { toErrorMessage } from "./error-utils";
import { throwIfAborted } from "./abort";
import { hasActiveChildLeaseForScheduledSlot } from "./scheduled-slot-reconciliation";

export type ScheduledCheckpointState =
  | "running"
  | "ready"
  | "recovering"
  | "completed"
  | "failed"
  | "platform_abandoned";

export type ScheduledChildDisposition =
  | "not_started"
  | "running"
  | "completed"
  | "failed"
  | "platform_abandoned";

export interface ScheduledCheckpointIdentity {
  scheduleKey: string;
  slotStartedAt: number;
  job: string;
  attemptNo: number;
  executionGeneration: number;
  invocationId: string;
}

export interface ScheduledRecoveryCheckpoint extends ScheduledCheckpointIdentity {
  workerVersion: string | null;
  queueHash: string;
  state: ScheduledCheckpointState;
  nextItemKey: string | null;
  currentItemKey: string | null;
  currentDomainAttemptId: string | null;
  itemsDone: number;
  itemsTotal: number;
  childDispositions: Record<string, ScheduledChildDisposition>;
  recoveryOwner: string | null;
  recoveryLeaseUntil: number | null;
  sourceAttemptNo: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

interface ScheduledCheckpointRow {
  schedule_key: string;
  slot_started_at: number;
  job: string;
  attempt_no: number;
  execution_generation: number;
  invocation_id: string;
  worker_version: string | null;
  queue_hash: string;
  state: ScheduledCheckpointState;
  next_item_key: string | null;
  current_item_key: string | null;
  current_domain_attempt_id: string | null;
  items_done: number;
  items_total: number;
  child_dispositions_json: string;
  recovery_owner: string | null;
  recovery_lease_until: number | null;
  source_attempt_no: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface BeginScheduledCheckpointInput {
  scheduleKey: string;
  slotStartedAt: number;
  job: string;
  invocationId: string;
  workerVersion?: string | null;
  queueHash: string;
  nextItemKey: string | null;
  itemsTotal: number;
  childJobs: readonly string[];
  nowSec?: number;
}

export interface ScheduledCheckpointAdvance {
  nextItemKey: string | null;
  itemsDone: number;
  nowSec?: number;
  recoveryLeaseUntil?: number | null;
}

export interface AbandonedCheckpointPreparation {
  abandonedAttemptNo: number;
  recoveryAttemptNo: number;
  currentItemKey: string | null;
  currentDomainAttemptId: string | null;
}

export type ScheduledRecoveryBlocker =
  | "active-child-lease"
  | "active-recovery-lease"
  | "queue-hash-drift"
  | "slot-heartbeat-active"
  | "slot-missing"
  | "slot-not-abandoned";

export interface ScheduledRecoveryEligibilityCandidate {
  scheduleKey: string;
  slotStartedAt: number;
  attemptNo: number;
  executionGeneration: number;
  state: "running" | "recovering" | "ready";
  queueHash: string;
  slotState: string | null;
  slotResultStatus: string | null;
  slotUpdatedAt: number | null;
  currentItemKey: string | null;
  currentDomainAttemptId: string | null;
  blockers: ScheduledRecoveryBlocker[];
  eligible: boolean;
}

export interface ScheduledRecoveryEligibilityInspection {
  observedAt: number;
  staleBefore: number;
  readyCheckpointCount: number;
  eligibleCheckpointCount: number;
  candidates: ScheduledRecoveryEligibilityCandidate[];
}

interface ScheduledRecoveryEligibilityRow extends ScheduledCheckpointRow {
  slot_state: string | null;
  slot_result_status: string | null;
  slot_updated_at: number | null;
}

const CHECKPOINT_COLUMNS = [
  "schedule_key",
  "slot_started_at",
  "job",
  "attempt_no",
  "execution_generation",
  "invocation_id",
  "worker_version",
  "queue_hash",
  "state",
  "next_item_key",
  "current_item_key",
  "current_domain_attempt_id",
  "items_done",
  "items_total",
  "child_dispositions_json",
  "recovery_owner",
  "recovery_lease_until",
  "source_attempt_no",
  "error",
  "created_at",
  "updated_at",
  "completed_at",
].join(", ");

const ACTIVE_CHECKPOINT_STATES: readonly ScheduledCheckpointState[] = ["running", "recovering"];
const PLATFORM_ABANDONED_ERROR = "scheduled invocation ended before terminal checkpoint";

export class ScheduledCheckpointOwnershipLostError extends Error {
  constructor(identity: ScheduledCheckpointIdentity) {
    super(
      `scheduled checkpoint ownership lost for ${identity.scheduleKey}@${identity.slotStartedAt}/${identity.job}#${identity.attemptNo}`,
    );
    this.name = "ScheduledCheckpointOwnershipLostError";
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function parseChildDispositions(value: string): Record<string, ScheduledChildDisposition> {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, ScheduledChildDisposition] =>
        typeof entry[0] === "string"
        && ["not_started", "running", "completed", "failed", "platform_abandoned"].includes(String(entry[1]))
      ),
    );
  } catch {
    return {};
  }
}

function mapCheckpointRow(row: ScheduledCheckpointRow): ScheduledRecoveryCheckpoint {
  return {
    scheduleKey: row.schedule_key,
    slotStartedAt: row.slot_started_at,
    job: row.job,
    attemptNo: row.attempt_no,
    executionGeneration: row.execution_generation,
    invocationId: row.invocation_id,
    workerVersion: row.worker_version,
    queueHash: row.queue_hash,
    state: row.state,
    nextItemKey: row.next_item_key,
    currentItemKey: row.current_item_key,
    currentDomainAttemptId: row.current_domain_attempt_id,
    itemsDone: row.items_done,
    itemsTotal: row.items_total,
    childDispositions: parseChildDispositions(row.child_dispositions_json),
    recoveryOwner: row.recovery_owner,
    recoveryLeaseUntil: row.recovery_lease_until,
    sourceAttemptNo: row.source_attempt_no,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function identityBinds(identity: ScheduledCheckpointIdentity): Array<string | number> {
  return [
    identity.scheduleKey,
    identity.slotStartedAt,
    identity.job,
    identity.attemptNo,
    identity.executionGeneration,
    identity.invocationId,
  ];
}

function identityWhereSql(): string {
  return `schedule_key = ?
      AND slot_started_at = ?
      AND job = ?
      AND attempt_no = ?
      AND execution_generation = ?
      AND invocation_id = ?`;
}

async function requireChanged(
  resultPromise: Promise<D1Result>,
  identity: ScheduledCheckpointIdentity,
): Promise<void> {
  const result = await resultPromise;
  if ((result.meta.changes ?? 0) !== 1) {
    throw new ScheduledCheckpointOwnershipLostError(identity);
  }
}

export async function beginScheduledCheckpoint(
  db: D1Database,
  input: BeginScheduledCheckpointInput,
): Promise<ScheduledRecoveryCheckpoint> {
  const timestamp = input.nowSec ?? nowSec();
  const childDispositions = Object.fromEntries(
    input.childJobs.map((job) => [job, "not_started" as const]),
  );
  await runWithOverloadRetry(() =>
    db
      .prepare(
        `INSERT OR IGNORE INTO worker_scheduled_checkpoints (
           schedule_key, slot_started_at, job, attempt_no, execution_generation,
           invocation_id, worker_version, queue_hash, state, next_item_key,
           items_done, items_total, child_dispositions_json, created_at, updated_at
         ) VALUES (?, ?, ?, 1, 1, ?, ?, ?, 'running', ?, 0, ?, ?, ?, ?)`,
      )
      .bind(
        input.scheduleKey,
        input.slotStartedAt,
        input.job,
        input.invocationId,
        input.workerVersion ?? null,
        input.queueHash,
        input.nextItemKey,
        input.itemsTotal,
        JSON.stringify(childDispositions),
        timestamp,
        timestamp,
      )
      .run(),
  );

  const checkpoint = await loadScheduledCheckpoint(db, {
    scheduleKey: input.scheduleKey,
    slotStartedAt: input.slotStartedAt,
    job: input.job,
    attemptNo: 1,
  });
  if (!checkpoint) {
    throw new Error(`failed to create scheduled checkpoint for ${input.scheduleKey}@${input.slotStartedAt}`);
  }
  if (checkpoint.invocationId !== input.invocationId || checkpoint.state !== "running") {
    throw new ScheduledCheckpointOwnershipLostError(checkpoint);
  }
  return checkpoint;
}

export async function loadScheduledCheckpoint(
  db: D1Database,
  input: { scheduleKey: string; slotStartedAt: number; job: string; attemptNo: number },
): Promise<ScheduledRecoveryCheckpoint | null> {
  const row = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT ${CHECKPOINT_COLUMNS}
           FROM worker_scheduled_checkpoints
          WHERE schedule_key = ? AND slot_started_at = ? AND job = ? AND attempt_no = ?`,
      )
      .bind(input.scheduleKey, input.slotStartedAt, input.job, input.attemptNo)
      .first<ScheduledCheckpointRow>(),
  );
  return row ? mapCheckpointRow(row) : null;
}

export async function markScheduledCheckpointItemStarted(
  db: D1Database,
  identity: ScheduledCheckpointIdentity,
  input: { itemKey: string; itemsDone: number; itemsTotal: number; nowSec?: number; recoveryLeaseUntil?: number | null },
): Promise<void> {
  const timestamp = input.nowSec ?? nowSec();
  await requireChanged(
    runWithOverloadRetry(() =>
      db
        .prepare(
          `UPDATE worker_scheduled_checkpoints
              SET next_item_key = ?, current_item_key = ?, current_domain_attempt_id = NULL,
                  items_done = ?, items_total = ?, updated_at = ?,
                  recovery_lease_until = COALESCE(?, recovery_lease_until)
            WHERE ${identityWhereSql()}
              AND state IN ('running', 'recovering')`,
        )
        .bind(
          input.itemKey,
          input.itemKey,
          input.itemsDone,
          input.itemsTotal,
          timestamp,
          input.recoveryLeaseUntil ?? null,
          ...identityBinds(identity),
        )
        .run(),
    ),
    identity,
  );
}

export async function markScheduledCheckpointDomainAttempt(
  db: D1Database,
  identity: ScheduledCheckpointIdentity,
  itemKey: string,
  domainAttemptId: string,
  timestamp = nowSec(),
): Promise<void> {
  await requireChanged(
    runWithOverloadRetry(() =>
      db
        .prepare(
          `UPDATE worker_scheduled_checkpoints
              SET current_domain_attempt_id = ?, updated_at = ?
            WHERE ${identityWhereSql()}
              AND state IN ('running', 'recovering')
              AND current_item_key = ?`,
        )
        .bind(domainAttemptId, timestamp, ...identityBinds(identity), itemKey)
        .run(),
    ),
    identity,
  );
}

export function buildScheduledCheckpointAdvanceStatement(
  db: D1Database,
  identity: ScheduledCheckpointIdentity,
  input: ScheduledCheckpointAdvance,
): D1PreparedStatement {
  const timestamp = input.nowSec ?? nowSec();
  return db
    .prepare(
      `UPDATE worker_scheduled_checkpoints
          SET next_item_key = ?, current_item_key = NULL, current_domain_attempt_id = NULL,
              items_done = ?, updated_at = ?,
              recovery_lease_until = COALESCE(?, recovery_lease_until)
        WHERE ${identityWhereSql()}
          AND state IN ('running', 'recovering')`,
    )
    .bind(
      input.nextItemKey,
      input.itemsDone,
      timestamp,
      input.recoveryLeaseUntil ?? null,
      ...identityBinds(identity),
    );
}

export async function advanceScheduledCheckpoint(
  db: D1Database,
  identity: ScheduledCheckpointIdentity,
  input: ScheduledCheckpointAdvance,
): Promise<void> {
  await requireChanged(
    runWithOverloadRetry(() => buildScheduledCheckpointAdvanceStatement(db, identity, input).run()),
    identity,
  );
}

export async function setScheduledCheckpointChildDisposition(
  db: D1Database,
  identity: ScheduledCheckpointIdentity,
  childJob: string,
  disposition: ScheduledChildDisposition,
  timestamp = nowSec(),
): Promise<void> {
  const checkpoint = await loadScheduledCheckpoint(db, identity);
  if (!checkpoint || checkpoint.executionGeneration !== identity.executionGeneration || checkpoint.invocationId !== identity.invocationId) {
    throw new ScheduledCheckpointOwnershipLostError(identity);
  }
  const childDispositions = { ...checkpoint.childDispositions, [childJob]: disposition };
  await requireChanged(
    runWithOverloadRetry(() =>
      db
        .prepare(
          `UPDATE worker_scheduled_checkpoints
              SET child_dispositions_json = ?, updated_at = ?
            WHERE ${identityWhereSql()}
              AND state IN ('running', 'recovering')`,
        )
        .bind(JSON.stringify(childDispositions), timestamp, ...identityBinds(identity))
        .run(),
    ),
    identity,
  );
}

export async function finishScheduledCheckpoint(
  db: D1Database,
  identity: ScheduledCheckpointIdentity,
  input: { state: "completed" | "failed"; error?: string | null; nowSec?: number },
): Promise<void> {
  const timestamp = input.nowSec ?? nowSec();
  await requireChanged(
    runWithOverloadRetry(() =>
      db
        .prepare(
          `UPDATE worker_scheduled_checkpoints
              SET state = ?, error = ?, completed_at = ?, updated_at = ?,
                  current_item_key = NULL, current_domain_attempt_id = NULL,
                  recovery_owner = NULL, recovery_lease_until = NULL
            WHERE ${identityWhereSql()}
              AND state IN ('running', 'recovering')`,
        )
        .bind(input.state, input.error ?? null, timestamp, timestamp, ...identityBinds(identity))
        .run(),
    ),
    identity,
  );
}

async function loadLatestActiveCheckpointForSlot(
  db: D1Database,
  scheduleKey: string,
  slotStartedAt: number,
  job: string,
): Promise<ScheduledRecoveryCheckpoint | null> {
  const stateSql = ACTIVE_CHECKPOINT_STATES.map(() => "?").join(", ");
  const row = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT ${CHECKPOINT_COLUMNS}
           FROM worker_scheduled_checkpoints
          WHERE schedule_key = ? AND slot_started_at = ? AND job = ?
            AND state IN (${stateSql})
          ORDER BY attempt_no DESC
          LIMIT 1`,
      )
      .bind(scheduleKey, slotStartedAt, job, ...ACTIVE_CHECKPOINT_STATES)
      .first<ScheduledCheckpointRow>(),
  );
  return row ? mapCheckpointRow(row) : null;
}

async function loadCompletedCronJobsForSlot(
  db: D1Database,
  slotStartedAt: number,
  jobs: readonly string[],
): Promise<Set<string>> {
  if (jobs.length === 0) return new Set();
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT job, status, metadata
           FROM cron_runs
          WHERE slot_started_at = ?
            AND job IN (${jobs.map(() => "?").join(", ")})
          ORDER BY started_at DESC`,
      )
      .bind(slotStartedAt, ...jobs)
      .all<{ job: string; status: string; metadata: string | null }>(),
  );
  const completed = new Set<string>();
  for (const row of rows.results ?? []) {
    if (row.status !== "ok" && row.status !== "degraded") continue;
    let metadata: Record<string, unknown> | null = null;
    try {
      const parsed = row.metadata ? JSON.parse(row.metadata) as unknown : null;
      metadata = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      metadata = null;
    }
    if (metadata?.childDisposition === "not_started") continue;
    if (metadata?.runBudgetTruncated === true) continue;
    if (typeof metadata?.skippedReason === "string") continue;
    if (metadata?.reason === "stale-slot-reconciled") continue;
    completed.add(row.job);
  }
  return completed;
}

async function clearExactAbandonedReserveAttempt(
  db: D1Database,
  checkpoint: Pick<ScheduledRecoveryCheckpoint, "currentItemKey" | "currentDomainAttemptId">,
  timestamp: number,
): Promise<number> {
  if (!checkpoint.currentItemKey || !checkpoint.currentDomainAttemptId) return 0;
  const metadata = JSON.stringify({
    reason: "platform-abandoned",
    failureCategory: "platform-abandoned",
    reconciledAt: timestamp,
  });
  const results = await runWithOverloadRetry(() =>
    db.batch([
      db
        .prepare(
          `INSERT OR IGNORE INTO reserve_sync_attempt_history (
             stablecoin_id, attempted_at, adapter_key, breaker_key, attempt_id,
             status, warnings, warning_count, last_error, metadata
           )
           SELECT stablecoin_id, COALESCE(last_attempted_at, ?), adapter_key, breaker_key,
                  pending_attempt_id, 'error', NULL, 0, ?, ?
             FROM reserve_sync_state
            WHERE stablecoin_id = ?
              AND pending_attempt_id = ?
              AND last_attempt_id = ?`,
        )
        .bind(
          timestamp,
          PLATFORM_ABANDONED_ERROR,
          metadata,
          checkpoint.currentItemKey,
          checkpoint.currentDomainAttemptId,
          checkpoint.currentDomainAttemptId,
        ),
      db
        .prepare(
          `UPDATE reserve_sync_state
              SET pending_attempt_id = NULL,
                  last_status = 'error',
                  last_error = ?,
                  metadata = ?
            WHERE stablecoin_id = ?
              AND pending_attempt_id = ?
              AND last_attempt_id = ?`,
        )
        .bind(
          PLATFORM_ABANDONED_ERROR,
          metadata,
          checkpoint.currentItemKey,
          checkpoint.currentDomainAttemptId,
          checkpoint.currentDomainAttemptId,
        ),
    ]),
  );
  return (results[1] as D1Result | undefined)?.meta.changes ?? 0;
}

async function prepareCheckpointAttemptForRecovery(
  db: D1Database,
  checkpoint: ScheduledRecoveryCheckpoint,
  childJobs: readonly string[],
  timestamp: number,
): Promise<AbandonedCheckpointPreparation | null> {
  const completedJobs = await loadCompletedCronJobsForSlot(db, checkpoint.slotStartedAt, childJobs);
  const abandonedChildDispositions = { ...checkpoint.childDispositions };
  const recoveryChildDispositions = { ...checkpoint.childDispositions };
  const queueExhausted = checkpoint.nextItemKey === null && checkpoint.itemsDone === checkpoint.itemsTotal;
  let upstreamCompleted = queueExhausted;
  for (const childJob of childJobs) {
    const childCompleted =
      completedJobs.has(childJob)
      || checkpoint.childDispositions[childJob] === "completed";
    if (
      upstreamCompleted
      && childCompleted
    ) {
      abandonedChildDispositions[childJob] = "completed";
      recoveryChildDispositions[childJob] = "completed";
    } else {
      abandonedChildDispositions[childJob] = "platform_abandoned";
      recoveryChildDispositions[childJob] = "not_started";
    }
    upstreamCompleted = upstreamCompleted && childCompleted;
  }

  const recoveryAttemptNo = checkpoint.attemptNo + 1;
  const recoveryGeneration = checkpoint.executionGeneration + 1;
  const recoveryInvocationId = [
    "recovery-pending",
    checkpoint.scheduleKey,
    checkpoint.slotStartedAt,
    checkpoint.job,
    recoveryAttemptNo,
  ].join(":");
  const recoveryNextItem = checkpoint.currentItemKey ?? checkpoint.nextItemKey;
  const recoveryItemsDone = checkpoint.currentItemKey
    ? Math.max(0, checkpoint.itemsDone)
    : checkpoint.itemsDone;

  const results = await runWithOverloadRetry(() =>
    db.batch([
      db
        .prepare(
          `UPDATE worker_scheduled_checkpoints
              SET state = 'platform_abandoned', error = ?, completed_at = ?, updated_at = ?,
                  child_dispositions_json = ?, recovery_owner = NULL, recovery_lease_until = NULL
            WHERE ${identityWhereSql()}
              AND state IN ('running', 'recovering')`,
        )
        .bind(
          PLATFORM_ABANDONED_ERROR,
          timestamp,
          timestamp,
          JSON.stringify(abandonedChildDispositions),
          ...identityBinds(checkpoint),
        ),
      db
        .prepare(
          `INSERT OR IGNORE INTO worker_scheduled_checkpoints (
             schedule_key, slot_started_at, job, attempt_no, execution_generation,
             invocation_id, worker_version, queue_hash, state, next_item_key,
             current_item_key, current_domain_attempt_id, items_done, items_total,
             child_dispositions_json, source_attempt_no, created_at, updated_at
           )
           SELECT schedule_key, slot_started_at, job, ?, ?, ?, worker_version, queue_hash,
                  'ready', ?, NULL, current_domain_attempt_id, ?, items_total, ?, attempt_no, ?, ?
             FROM worker_scheduled_checkpoints
            WHERE ${identityWhereSql()}
              AND state = 'platform_abandoned'`,
        )
        .bind(
          recoveryAttemptNo,
          recoveryGeneration,
          recoveryInvocationId,
          recoveryNextItem,
          recoveryItemsDone,
          JSON.stringify(recoveryChildDispositions),
          timestamp,
          timestamp,
          ...identityBinds(checkpoint),
        ),
    ]),
  );
  if (((results[0] as D1Result | undefined)?.meta.changes ?? 0) !== 1) return null;

  await clearExactAbandonedReserveAttempt(db, checkpoint, timestamp);
  return {
    abandonedAttemptNo: checkpoint.attemptNo,
    recoveryAttemptNo,
    currentItemKey: checkpoint.currentItemKey,
    currentDomainAttemptId: checkpoint.currentDomainAttemptId,
  };
}

export async function prepareScheduledCheckpointRecoveryForSlot(
  db: D1Database,
  input: {
    scheduleKey: string;
    slotStartedAt: number;
    job: string;
    childJobs: readonly string[];
    nowSec?: number;
  },
): Promise<AbandonedCheckpointPreparation | null> {
  const timestamp = input.nowSec ?? nowSec();
  const checkpoint = await loadLatestActiveCheckpointForSlot(
    db,
    input.scheduleKey,
    input.slotStartedAt,
    input.job,
  );
  if (!checkpoint) return null;
  return prepareCheckpointAttemptForRecovery(db, checkpoint, input.childJobs, timestamp);
}

export async function inspectScheduledCheckpointRecoveryEligibility(
  db: D1Database,
  input: {
    scheduleKey: string;
    job: string;
    expectedQueueHash: string;
    staleAfterSec: number;
    nowSec?: number;
    limit?: number;
  },
): Promise<ScheduledRecoveryEligibilityInspection> {
  const timestamp = input.nowSec ?? nowSec();
  const staleBefore = timestamp - Math.max(60, input.staleAfterSec);
  const limit = Math.max(1, Math.min(input.limit ?? 5, 25));
  const [rows, readyRow] = await Promise.all([
    runWithOverloadRetry(() =>
      db
        .prepare(
          `SELECT ${CHECKPOINT_COLUMNS.split(", ").map((column) => `c.${column}`).join(", ")},
                  s.state AS slot_state, s.result_status AS slot_result_status,
                  s.updated_at AS slot_updated_at
             FROM worker_scheduled_checkpoints c
             LEFT JOIN cron_slot_executions s
               ON s.slot_key = c.schedule_key
              AND s.slot_started_at = c.slot_started_at
            WHERE c.schedule_key = ? AND c.job = ?
              AND c.state IN ('running', 'recovering', 'ready')
            ORDER BY c.updated_at ASC, c.slot_started_at ASC, c.attempt_no DESC
            LIMIT ?`,
        )
        .bind(input.scheduleKey, input.job, limit)
        .all<ScheduledRecoveryEligibilityRow>(),
    ),
    runWithOverloadRetry(() =>
      db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM worker_scheduled_checkpoints
            WHERE schedule_key = ? AND job = ? AND state = 'ready'`,
        )
        .bind(input.scheduleKey, input.job)
        .first<{ count: number }>(),
    ),
  ]);

  const candidates: ScheduledRecoveryEligibilityCandidate[] = [];
  for (const row of rows.results ?? []) {
    const checkpoint = mapCheckpointRow(row);
    const blockers: ScheduledRecoveryBlocker[] = [];
    if (checkpoint.queueHash !== input.expectedQueueHash) blockers.push("queue-hash-drift");
    if (checkpoint.state === "recovering" && (checkpoint.recoveryLeaseUntil ?? 0) >= timestamp) {
      blockers.push("active-recovery-lease");
    }
    if (checkpoint.state !== "ready") {
      if (!row.slot_state) {
        blockers.push("slot-missing");
      } else if (row.slot_state === "running" || row.slot_state === "reconciling") {
        if ((row.slot_updated_at ?? timestamp) >= staleBefore) blockers.push("slot-heartbeat-active");
      } else if (
        row.slot_state !== "finished"
        || (row.slot_result_status !== "error" && row.slot_result_status !== "degraded")
      ) {
        blockers.push("slot-not-abandoned");
      }
      if (
        !blockers.includes("slot-missing")
        && await hasActiveChildLeaseForScheduledSlot(db, checkpoint.scheduleKey, checkpoint.slotStartedAt, timestamp)
      ) {
        blockers.push("active-child-lease");
      }
    }
    candidates.push({
      scheduleKey: checkpoint.scheduleKey,
      slotStartedAt: checkpoint.slotStartedAt,
      attemptNo: checkpoint.attemptNo,
      executionGeneration: checkpoint.executionGeneration,
      state: checkpoint.state as "running" | "recovering" | "ready",
      queueHash: checkpoint.queueHash,
      slotState: row.slot_state,
      slotResultStatus: row.slot_result_status,
      slotUpdatedAt: row.slot_updated_at,
      currentItemKey: checkpoint.currentItemKey,
      currentDomainAttemptId: checkpoint.currentDomainAttemptId,
      blockers,
      eligible: blockers.length === 0,
    });
  }

  return {
    observedAt: timestamp,
    staleBefore,
    readyCheckpointCount: readyRow?.count ?? 0,
    eligibleCheckpointCount: candidates.filter((candidate) => candidate.eligible).length,
    candidates,
  };
}

export async function prepareEligibleScheduledCheckpointRecoveries(
  db: D1Database,
  input: {
    scheduleKey: string;
    job: string;
    childJobs: readonly string[];
    expectedQueueHash: string;
    staleAfterSec: number;
    nowSec?: number;
    limit?: number;
  },
): Promise<{
  inspection: ScheduledRecoveryEligibilityInspection;
  prepared: AbandonedCheckpointPreparation[];
}> {
  const inspection = await inspectScheduledCheckpointRecoveryEligibility(db, input);
  const prepared: AbandonedCheckpointPreparation[] = [];
  for (const candidate of inspection.candidates) {
    if (!candidate.eligible || candidate.state === "ready") continue;
    const result = await prepareScheduledCheckpointRecoveryForSlot(db, {
      scheduleKey: candidate.scheduleKey,
      slotStartedAt: candidate.slotStartedAt,
      job: input.job,
      childJobs: input.childJobs,
      nowSec: inspection.observedAt,
    });
    if (result) prepared.push(result);
  }
  return { inspection, prepared };
}

async function requeueExpiredRecoveries(
  db: D1Database,
  job: string,
  childJobs: readonly string[],
  timestamp: number,
): Promise<void> {
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT ${CHECKPOINT_COLUMNS}
           FROM worker_scheduled_checkpoints
          WHERE job = ? AND state = 'recovering' AND recovery_lease_until < ?
          ORDER BY updated_at ASC
          LIMIT 5`,
      )
      .bind(job, timestamp)
      .all<ScheduledCheckpointRow>(),
  );
  for (const row of rows.results ?? []) {
    await prepareCheckpointAttemptForRecovery(db, mapCheckpointRow(row), childJobs, timestamp);
  }
}

export async function claimNextScheduledCheckpointRecovery(
  db: D1Database,
  input: {
    job: string;
    childJobs: readonly string[];
    owner: string;
    leaseSec: number;
    expectedQueueHash?: string;
    nowSec?: number;
  },
): Promise<ScheduledRecoveryCheckpoint | null> {
  const timestamp = input.nowSec ?? nowSec();
  await requeueExpiredRecoveries(db, input.job, input.childJobs, timestamp);
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT ${CHECKPOINT_COLUMNS}
           FROM worker_scheduled_checkpoints
          WHERE job = ? AND state = 'ready'
          ORDER BY updated_at ASC, slot_started_at ASC
          LIMIT 5`,
      )
      .bind(input.job)
      .all<ScheduledCheckpointRow>(),
  );

  for (const row of rows.results ?? []) {
    const checkpoint = mapCheckpointRow(row);
    if (input.expectedQueueHash && checkpoint.queueHash !== input.expectedQueueHash) continue;
    await clearExactAbandonedReserveAttempt(db, checkpoint, timestamp);
    const leaseUntil = timestamp + Math.max(60, input.leaseSec);
    const result = await runWithOverloadRetry(() =>
      db
        .prepare(
          `UPDATE worker_scheduled_checkpoints
              SET state = 'recovering', invocation_id = ?, recovery_owner = ?,
                  recovery_lease_until = ?, updated_at = ?
            WHERE schedule_key = ? AND slot_started_at = ? AND job = ? AND attempt_no = ?
              AND execution_generation = ? AND invocation_id = ? AND state = 'ready'`,
        )
        .bind(
          input.owner,
          input.owner,
          leaseUntil,
          timestamp,
          checkpoint.scheduleKey,
          checkpoint.slotStartedAt,
          checkpoint.job,
          checkpoint.attemptNo,
          checkpoint.executionGeneration,
          checkpoint.invocationId,
        )
        .run(),
    );
    if ((result.meta.changes ?? 0) !== 1) continue;
    return {
      ...checkpoint,
      state: "recovering",
      invocationId: input.owner,
      recoveryOwner: input.owner,
      recoveryLeaseUntil: leaseUntil,
      updatedAt: timestamp,
    };
  }
  return null;
}

export function checkpointErrorMetadata(error: unknown): string {
  return toErrorMessage(error).slice(0, 1_000);
}

export async function pruneScheduledRecoveryCheckpoints(
  db: D1Database,
  cutoffUpdatedAt: number,
  signal?: AbortSignal,
): Promise<number> {
  throwIfAborted(signal);
  const result = await runWithOverloadRetry(() =>
    db
      .prepare(
        `DELETE FROM worker_scheduled_checkpoints
          WHERE updated_at < ?
            AND state IN ('completed', 'failed', 'platform_abandoned')`,
      )
      .bind(cutoffUpdatedAt)
      .run(),
    3,
    signal,
  );
  return result.meta?.changes ?? 0;
}
