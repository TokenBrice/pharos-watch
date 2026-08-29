import { unixNowSec as nowSec } from "@shared/lib/time-constants";
import { flattenScheduledSlotPlanJobs, SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";
import {
  LIVE_RESERVE_QUEUE_HASH,
  SYNC_ORDERED_CONFIGURED_COINS,
} from "../cron/sync-live-reserves-shared";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { throwIfAborted } from "./abort";
import { hasActiveChildLeaseForScheduledSlot } from "./scheduled-slot-reconciliation";
import { parseJsonObject } from "./json-parse";

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

export interface BeginLiveReserveCheckpointInput {
  slotStartedAt: number;
  invocationId: string;
  workerVersion?: string | null;
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
  incompatibleCheckpointCount: number;
  eligibleCheckpointCount: number;
  candidates: ScheduledRecoveryEligibilityCandidate[];
}

export interface IncompatibleScheduledCheckpointRetirementSummary {
  observedAt: number;
  candidates: number;
  retired: number;
  skippedActiveChildLease: number;
  retiredCheckpoints: Array<{
    slotStartedAt: number;
    attemptNo: number;
    queueHash: string;
  }>;
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
const LIVE_RESERVE_SCHEDULE_KEY = "fourHourlyReserveSync";
const LIVE_RESERVE_CHECKPOINT_JOB = "sync-live-reserves";
export const LIVE_RESERVE_SLOT_JOBS = flattenScheduledSlotPlanJobs(
  SCHEDULED_SLOT_PLANS.fourHourlyReserveSync,
);
const LIVE_RESERVE_CHILD_PREREQUISITES = {
  "sync-live-reserves": [],
  "sync-redemption-backstops": ["sync-live-reserves"],
  "sync-kinesis-supply": [],
  "reserve-post-sync-watchdog": ["sync-live-reserves"],
} as const;
const PLATFORM_ABANDONED_ERROR = "scheduled invocation ended before terminal checkpoint";
const QUEUE_HASH_DRIFT_RETIREMENT_ERROR =
  "scheduled recovery checkpoint retired because its queue hash no longer matches the active queue";

export class ScheduledCheckpointOwnershipLostError extends Error {
  constructor(identity: ScheduledCheckpointIdentity) {
    super(
      `scheduled checkpoint ownership lost for ${identity.scheduleKey}@${identity.slotStartedAt}/${identity.job}#${identity.attemptNo}`,
    );
    this.name = "ScheduledCheckpointOwnershipLostError";
  }
}

function parseChildDispositions(value: string): Record<string, ScheduledChildDisposition> {
  const parsed = parseJsonObject(value) ?? {};
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, ScheduledChildDisposition] =>
      typeof entry[0] === "string"
      && ["not_started", "running", "completed", "failed", "platform_abandoned"].includes(String(entry[1]))
    ),
  );
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

export async function beginLiveReserveCheckpoint(
  db: D1Database,
  input: BeginLiveReserveCheckpointInput,
): Promise<ScheduledRecoveryCheckpoint> {
  const timestamp = input.nowSec ?? nowSec();
  const childDispositions = Object.fromEntries(
    LIVE_RESERVE_SLOT_JOBS.map((job) => [job, "not_started" as const]),
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
        LIVE_RESERVE_SCHEDULE_KEY,
        input.slotStartedAt,
        LIVE_RESERVE_CHECKPOINT_JOB,
        input.invocationId,
        input.workerVersion ?? null,
        LIVE_RESERVE_QUEUE_HASH,
        SYNC_ORDERED_CONFIGURED_COINS[0]?.id ?? null,
        SYNC_ORDERED_CONFIGURED_COINS.length,
        JSON.stringify(childDispositions),
        timestamp,
        timestamp,
      )
      .run(),
  );

  const checkpoint = await loadLiveReserveCheckpoint(db, {
    slotStartedAt: input.slotStartedAt,
    attemptNo: 1,
  });
  if (!checkpoint) {
    throw new Error(`failed to create live reserve checkpoint for ${LIVE_RESERVE_SCHEDULE_KEY}@${input.slotStartedAt}`);
  }
  if (checkpoint.invocationId !== input.invocationId || checkpoint.state !== "running") {
    throw new ScheduledCheckpointOwnershipLostError(checkpoint);
  }
  return checkpoint;
}

export async function loadLiveReserveCheckpoint(
  db: D1Database,
  input: { slotStartedAt: number; attemptNo: number },
): Promise<ScheduledRecoveryCheckpoint | null> {
  const row = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT ${CHECKPOINT_COLUMNS}
           FROM worker_scheduled_checkpoints
          WHERE schedule_key = ? AND slot_started_at = ? AND job = ? AND attempt_no = ?`,
      )
      .bind(
        LIVE_RESERVE_SCHEDULE_KEY,
        input.slotStartedAt,
        LIVE_RESERVE_CHECKPOINT_JOB,
        input.attemptNo,
      )
      .first<ScheduledCheckpointRow>(),
  );
  return row ? mapCheckpointRow(row) : null;
}

// Starting the next item also acknowledges the prior item. Persist its domain
// attempt in the same write so recovery can fence any crash before domain work.
export async function markLiveReserveCheckpointItemStarted(
  db: D1Database,
  identity: ScheduledCheckpointIdentity,
  input: {
    itemKey: string;
    domainAttemptId?: string | null;
    itemsDone: number;
    itemsTotal: number;
    nowSec?: number;
    recoveryLeaseUntil?: number | null;
  },
): Promise<void> {
  const timestamp = input.nowSec ?? nowSec();
  await requireChanged(
    runWithOverloadRetry(() =>
      db
        .prepare(
          `UPDATE worker_scheduled_checkpoints
              SET next_item_key = ?, current_item_key = ?, current_domain_attempt_id = ?,
                  items_done = ?, items_total = ?, updated_at = ?,
                  recovery_lease_until = COALESCE(?, recovery_lease_until)
            WHERE ${identityWhereSql()}
              AND state IN ('running', 'recovering')`,
        )
        .bind(
          input.itemKey,
          input.itemKey,
          input.domainAttemptId ?? null,
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

function buildScheduledCheckpointAdvanceStatement(
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

export async function advanceLiveReserveCheckpoint(
  db: D1Database,
  identity: ScheduledCheckpointIdentity,
  input: ScheduledCheckpointAdvance,
): Promise<void> {
  await requireChanged(
    runWithOverloadRetry(() => buildScheduledCheckpointAdvanceStatement(db, identity, input).run()),
    identity,
  );
}

export async function setLiveReserveCheckpointChildDisposition(
  db: D1Database,
  identity: ScheduledCheckpointIdentity,
  childJob: string,
  disposition: ScheduledChildDisposition,
  timestamp = nowSec(),
): Promise<void> {
  const checkpoint = await loadLiveReserveCheckpoint(db, identity);
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

export async function finishLiveReserveCheckpoint(
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
  slotStartedAt: number,
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
      .bind(LIVE_RESERVE_SCHEDULE_KEY, slotStartedAt, LIVE_RESERVE_CHECKPOINT_JOB, ...ACTIVE_CHECKPOINT_STATES)
      .first<ScheduledCheckpointRow>(),
  );
  return row ? mapCheckpointRow(row) : null;
}

async function loadCompletedCronJobsForSlot(
  db: D1Database,
  slotStartedAt: number,
): Promise<Set<string>> {
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT job, status, metadata
           FROM cron_runs
          WHERE slot_started_at = ?
            AND job IN (${LIVE_RESERVE_SLOT_JOBS.map(() => "?").join(", ")})
          ORDER BY started_at DESC`,
      )
      .bind(slotStartedAt, ...LIVE_RESERVE_SLOT_JOBS)
      .all<{ job: string; status: string; metadata: string | null }>(),
  );
  const completed = new Set<string>();
  for (const row of rows.results ?? []) {
    if (row.status !== "ok" && row.status !== "degraded") continue;
    const metadata = parseJsonObject(row.metadata);
    if (metadata?.childDisposition === "not_started") continue;
    if (metadata?.runBudgetTruncated === true) continue;
    if (typeof metadata?.skippedReason === "string") continue;
    if (metadata?.reason === "stale-slot-reconciled") continue;
    completed.add(row.job);
  }
  return completed;
}

function buildReserveAttemptAbandonmentStatements(
  db: D1Database,
  checkpoint: ScheduledRecoveryCheckpoint,
  input: {
    timestamp: number;
    error: string;
    metadata: string;
    checkpointGuardSql: string;
    checkpointGuardBinds: readonly unknown[];
  },
): D1PreparedStatement[] {
  if (!checkpoint.currentItemKey || !checkpoint.currentDomainAttemptId) return [];
  const sharedBinds = [
    checkpoint.currentItemKey,
    checkpoint.currentDomainAttemptId,
    checkpoint.currentDomainAttemptId,
    ...input.checkpointGuardBinds,
  ];
  return [
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
            AND last_attempt_id = ?
            AND ${input.checkpointGuardSql}`,
      )
      .bind(input.timestamp, input.error, input.metadata, ...sharedBinds),
    db
      .prepare(
        `UPDATE reserve_sync_state
            SET pending_attempt_id = NULL,
                last_status = 'error',
                last_error = ?,
                metadata = ?
          WHERE stablecoin_id = ?
            AND pending_attempt_id = ?
            AND last_attempt_id = ?
            AND ${input.checkpointGuardSql}`,
      )
      .bind(input.error, input.metadata, ...sharedBinds),
  ];
}

async function prepareCheckpointAttemptForRecovery(
  db: D1Database,
  checkpoint: ScheduledRecoveryCheckpoint,
  timestamp: number,
): Promise<AbandonedCheckpointPreparation | null> {
  const completedJobs = await loadCompletedCronJobsForSlot(db, checkpoint.slotStartedAt);
  const abandonedChildDispositions = { ...checkpoint.childDispositions };
  const recoveryChildDispositions = { ...checkpoint.childDispositions };
  const queueExhausted = checkpoint.nextItemKey === null && checkpoint.itemsDone === checkpoint.itemsTotal;
  const preservedCompletedJobs = new Set<string>();
  const prerequisitesByJob = LIVE_RESERVE_CHILD_PREREQUISITES as Readonly<
    Record<string, readonly string[]>
  >;
  for (const childJob of LIVE_RESERVE_SLOT_JOBS) {
    const childCompleted =
      completedJobs.has(childJob)
      || checkpoint.childDispositions[childJob] === "completed";
    const prerequisitesCompleted = (prerequisitesByJob[childJob] ?? [])
      .every((prerequisite) => preservedCompletedJobs.has(prerequisite));
    const durableFrontierCompleted = childJob !== checkpoint.job || queueExhausted;
    if (prerequisitesCompleted && durableFrontierCompleted && childCompleted) {
      abandonedChildDispositions[childJob] = "completed";
      recoveryChildDispositions[childJob] = "completed";
      preservedCompletedJobs.add(childJob);
    } else {
      abandonedChildDispositions[childJob] = "platform_abandoned";
      recoveryChildDispositions[childJob] = "not_started";
    }
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

  const checkpointAbandonedExistsSql = `EXISTS (
    SELECT 1
      FROM worker_scheduled_checkpoints
     WHERE ${identityWhereSql()}
       AND state = 'platform_abandoned'
       AND error = ?
       AND completed_at = ?
  )`;
  const checkpointAbandonedBinds = [
    ...identityBinds(checkpoint),
    PLATFORM_ABANDONED_ERROR,
    timestamp,
  ];
  const abandonmentMetadata = JSON.stringify({
    reason: "platform-abandoned",
    failureCategory: "platform-abandoned",
    reconciledAt: timestamp,
  });
  const checkpointAbandonment = db
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
    );
  const readyAttemptCreation = db
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
    );
  const results = await runWithOverloadRetry(() =>
    db.batch([
      checkpointAbandonment,
      ...buildReserveAttemptAbandonmentStatements(db, checkpoint, {
        timestamp,
        error: PLATFORM_ABANDONED_ERROR,
        metadata: abandonmentMetadata,
        checkpointGuardSql: checkpointAbandonedExistsSql,
        checkpointGuardBinds: checkpointAbandonedBinds,
      }),
      readyAttemptCreation,
    ]),
  );
  if (((results[0] as D1Result | undefined)?.meta.changes ?? 0) !== 1) return null;

  return {
    abandonedAttemptNo: checkpoint.attemptNo,
    recoveryAttemptNo,
    currentItemKey: checkpoint.currentItemKey,
    currentDomainAttemptId: checkpoint.currentDomainAttemptId,
  };
}

export async function prepareLiveReserveCheckpointRecoveryForSlot(
  db: D1Database,
  input: {
    slotStartedAt: number;
    nowSec?: number;
  },
): Promise<AbandonedCheckpointPreparation | null> {
  const timestamp = input.nowSec ?? nowSec();
  const checkpoint = await loadLatestActiveCheckpointForSlot(
    db,
    input.slotStartedAt,
  );
  if (!checkpoint) return null;
  return prepareCheckpointAttemptForRecovery(
    db,
    checkpoint,
    timestamp,
  );
}

export async function inspectLiveReserveCheckpointRecoveryEligibility(
  db: D1Database,
  input: {
    staleAfterSec: number;
    nowSec?: number;
    limit?: number;
  },
): Promise<ScheduledRecoveryEligibilityInspection> {
  const timestamp = input.nowSec ?? nowSec();
  const staleBefore = timestamp - Math.max(60, input.staleAfterSec);
  const limit = Math.max(1, Math.min(input.limit ?? 5, 25));
  const [rows, countsRow] = await Promise.all([
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
              AND c.queue_hash = ?
            ORDER BY c.updated_at ASC, c.slot_started_at ASC, c.attempt_no DESC
            LIMIT ?`,
        )
        .bind(LIVE_RESERVE_SCHEDULE_KEY, LIVE_RESERVE_CHECKPOINT_JOB, LIVE_RESERVE_QUEUE_HASH, limit)
        .all<ScheduledRecoveryEligibilityRow>(),
    ),
    runWithOverloadRetry(() =>
      db
        .prepare(
          `SELECT
             SUM(CASE WHEN state = 'ready' AND queue_hash = ? THEN 1 ELSE 0 END) AS ready_count,
             SUM(CASE WHEN queue_hash <> ? THEN 1 ELSE 0 END) AS incompatible_count
             FROM worker_scheduled_checkpoints
            WHERE schedule_key = ? AND job = ?
              AND state IN ('running', 'recovering', 'ready')`,
        )
        .bind(
          LIVE_RESERVE_QUEUE_HASH,
          LIVE_RESERVE_QUEUE_HASH,
          LIVE_RESERVE_SCHEDULE_KEY,
          LIVE_RESERVE_CHECKPOINT_JOB,
        )
        .first<{ ready_count: number | null; incompatible_count: number | null }>(),
    ),
  ]);

  const candidates: ScheduledRecoveryEligibilityCandidate[] = [];
  for (const row of rows.results ?? []) {
    const checkpoint = mapCheckpointRow(row);
    const blockers: ScheduledRecoveryBlocker[] = [];
    if (checkpoint.queueHash !== LIVE_RESERVE_QUEUE_HASH) blockers.push("queue-hash-drift");
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
    readyCheckpointCount: countsRow?.ready_count ?? 0,
    incompatibleCheckpointCount: countsRow?.incompatible_count ?? 0,
    eligibleCheckpointCount: candidates.filter((candidate) => candidate.eligible).length,
    candidates,
  };
}

export async function retireIncompatibleLiveReserveCheckpointRecoveries(
  db: D1Database,
  input: {
    nowSec?: number;
    limit?: number;
  },
): Promise<IncompatibleScheduledCheckpointRetirementSummary> {
  const timestamp = input.nowSec ?? nowSec();
  const limit = Math.max(1, Math.min(input.limit ?? 5, 25));
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT ${CHECKPOINT_COLUMNS.split(", ").map((column) => `c.${column}`).join(", ")}
           FROM worker_scheduled_checkpoints c
           JOIN cron_slot_executions s
             ON s.slot_key = c.schedule_key
            AND s.slot_started_at = c.slot_started_at
          WHERE c.schedule_key = ? AND c.job = ?
            AND c.state IN ('running', 'recovering', 'ready')
            AND c.queue_hash <> ?
            AND s.state = 'finished'
            AND (
              c.state <> 'recovering'
              OR c.recovery_lease_until IS NULL
              OR c.recovery_lease_until < ?
            )
          ORDER BY c.updated_at ASC, c.slot_started_at ASC, c.attempt_no DESC
          LIMIT ?`,
      )
      .bind(
        LIVE_RESERVE_SCHEDULE_KEY,
        LIVE_RESERVE_CHECKPOINT_JOB,
        LIVE_RESERVE_QUEUE_HASH,
        timestamp,
        limit,
      )
      .all<ScheduledCheckpointRow>(),
  );
  const checkpoints = (rows.results ?? []).map(mapCheckpointRow);
  const summary: IncompatibleScheduledCheckpointRetirementSummary = {
    observedAt: timestamp,
    candidates: checkpoints.length,
    retired: 0,
    skippedActiveChildLease: 0,
    retiredCheckpoints: [],
  };

  for (const checkpoint of checkpoints) {
    if (await hasActiveChildLeaseForScheduledSlot(db, checkpoint.scheduleKey, checkpoint.slotStartedAt, timestamp)) {
      summary.skippedActiveChildLease++;
      continue;
    }
    const childDispositions = { ...checkpoint.childDispositions };
    for (const childJob of LIVE_RESERVE_SLOT_JOBS) {
      if (childDispositions[childJob] !== "completed") {
        childDispositions[childJob] = "platform_abandoned";
      }
    }
    const statements: D1PreparedStatement[] = [
      db
        .prepare(
          `UPDATE worker_scheduled_checkpoints
              SET state = 'platform_abandoned', error = ?, completed_at = ?, updated_at = ?,
                  child_dispositions_json = ?, current_item_key = NULL, current_domain_attempt_id = NULL,
                  recovery_owner = NULL, recovery_lease_until = NULL
            WHERE ${identityWhereSql()}
              AND queue_hash = ?
              AND queue_hash <> ?
              AND state IN ('running', 'recovering', 'ready')
              AND (
                state <> 'recovering'
                OR recovery_lease_until IS NULL
                OR recovery_lease_until < ?
              )`,
        )
        .bind(
          QUEUE_HASH_DRIFT_RETIREMENT_ERROR,
          timestamp,
          timestamp,
          JSON.stringify(childDispositions),
          ...identityBinds(checkpoint),
          checkpoint.queueHash,
          LIVE_RESERVE_QUEUE_HASH,
          timestamp,
        ),
    ];
    const retiredCheckpointExistsSql = `EXISTS (
      SELECT 1
        FROM worker_scheduled_checkpoints
       WHERE ${identityWhereSql()}
         AND state = 'platform_abandoned'
         AND error = ?
         AND completed_at = ?
    )`;
    const retirementBinds = [
      ...identityBinds(checkpoint),
      QUEUE_HASH_DRIFT_RETIREMENT_ERROR,
      timestamp,
    ];
    const retirementMetadata = JSON.stringify({
      reason: "queue-hash-drift",
      failureCategory: "platform-abandoned",
      expectedQueueHash: LIVE_RESERVE_QUEUE_HASH,
      checkpointQueueHash: checkpoint.queueHash,
      reconciledAt: timestamp,
    });
    statements.push(...buildReserveAttemptAbandonmentStatements(db, checkpoint, {
      timestamp,
      error: QUEUE_HASH_DRIFT_RETIREMENT_ERROR,
      metadata: retirementMetadata,
      checkpointGuardSql: retiredCheckpointExistsSql,
      checkpointGuardBinds: retirementBinds,
    }));
    const results = await runWithOverloadRetry(() => db.batch(statements));
    if (((results[0] as D1Result | undefined)?.meta.changes ?? 0) !== 1) continue;
    summary.retired++;
    summary.retiredCheckpoints.push({
      slotStartedAt: checkpoint.slotStartedAt,
      attemptNo: checkpoint.attemptNo,
      queueHash: checkpoint.queueHash,
    });
  }

  return summary;
}

export async function prepareEligibleLiveReserveCheckpointRecoveries(
  db: D1Database,
  input: {
    staleAfterSec: number;
    nowSec?: number;
    limit?: number;
  },
): Promise<{
  inspection: ScheduledRecoveryEligibilityInspection;
  prepared: AbandonedCheckpointPreparation[];
}> {
  const inspection = await inspectLiveReserveCheckpointRecoveryEligibility(db, input);
  const prepared: AbandonedCheckpointPreparation[] = [];
  for (const candidate of inspection.candidates) {
    if (!candidate.eligible || candidate.state === "ready") continue;
    const result = await prepareLiveReserveCheckpointRecoveryForSlot(db, {
      slotStartedAt: candidate.slotStartedAt,
      nowSec: inspection.observedAt,
    });
    if (result) prepared.push(result);
  }
  return { inspection, prepared };
}

async function requeueExpiredRecoveries(
  db: D1Database,
  timestamp: number,
): Promise<void> {
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT ${CHECKPOINT_COLUMNS}
           FROM worker_scheduled_checkpoints
          WHERE schedule_key = ? AND job = ?
            AND state = 'recovering' AND recovery_lease_until < ?
            AND queue_hash = ?
          ORDER BY updated_at ASC
          LIMIT 5`,
      )
      .bind(
        LIVE_RESERVE_SCHEDULE_KEY,
        LIVE_RESERVE_CHECKPOINT_JOB,
        timestamp,
        LIVE_RESERVE_QUEUE_HASH,
      )
      .all<ScheduledCheckpointRow>(),
  );
  for (const row of rows.results ?? []) {
    await prepareCheckpointAttemptForRecovery(
      db,
      mapCheckpointRow(row),
      timestamp,
    );
  }
}

export async function claimNextLiveReserveCheckpointRecovery(
  db: D1Database,
  input: {
    owner: string;
    leaseSec: number;
    nowSec?: number;
  },
): Promise<ScheduledRecoveryCheckpoint | null> {
  const timestamp = input.nowSec ?? nowSec();
  await requeueExpiredRecoveries(db, timestamp);
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT ${CHECKPOINT_COLUMNS}
           FROM worker_scheduled_checkpoints
          WHERE schedule_key = ? AND job = ? AND state = 'ready'
            AND queue_hash = ?
          ORDER BY updated_at ASC, slot_started_at ASC
          LIMIT 5`,
      )
      .bind(LIVE_RESERVE_SCHEDULE_KEY, LIVE_RESERVE_CHECKPOINT_JOB, LIVE_RESERVE_QUEUE_HASH)
      .all<ScheduledCheckpointRow>(),
  );

  for (const row of rows.results ?? []) {
    const checkpoint = mapCheckpointRow(row);
    if (checkpoint.queueHash !== LIVE_RESERVE_QUEUE_HASH) continue;
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

export async function pruneLiveReserveRecoveryCheckpoints(
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
