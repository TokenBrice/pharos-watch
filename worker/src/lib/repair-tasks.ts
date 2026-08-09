import type { RepairDebtSummary } from "@shared/types/status";
import { DDR_PUBLIC_PREDICTION_BACKSTOP_DELAY_SEC } from "@shared/lib/depeg-resolver-version";
import { createCronResult, type StructuredCronResult } from "./cron-result";
import {
  DDR_FLAP_TOLERANT_MAX_INCIDENT_SPAN_SEC_V1,
  DDR_FLAP_TOLERANT_MAX_LINK_COUNT_V1,
  DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC,
  loadCanonicalIncidents,
} from "./depeg-resolver-incident-store";
import { buildInClause, isMissingTableError } from "./db";
import { runWithOverloadRetry } from "./d1-overload-retry";

export type RepairTaskState = "open" | "claimed" | "deferred" | "closed" | "failed" | "cancelled";

const ACTIVE_REPAIR_TASK_STATES: RepairTaskState[] = ["open", "claimed", "deferred", "failed"];
const TERMINAL_REPAIR_TASK_STATES: RepairTaskState[] = ["closed", "cancelled"];
const DDR_REPAIR_TASK_KIND = "ddr-repair-required-event";
export const DDR_REPAIR_RUNNER_BATCH_LIMIT_V1 = 5;
export const DDR_REPAIR_RUNNER_CLAIM_LEASE_SEC_V1 = 15 * 60;
export const DDR_REPAIR_RUNNER_BACKOFF_SEC_V1 = 6 * 60 * 60;
const DDR_REPAIR_RUNNER_CREATED_BY = "ddr-worker:repair-task-runner-v1";
const DDR_REPAIR_RUNNER_LINK_COLUMNS_JSON = '["event_id","incident_key","relation"]';
const DDR_REPAIR_RUNNER_CURRENT_COLUMNS_JSON = '["current_event_id","current_started_at"]';
const DDR_REPAIR_RUNNER_LINK_REASON = "Repair-task runner adopted a T1.2-safe live DDR tail";
const DDR_REPAIR_RUNNER_CURRENT_REASON =
  "Repair-task runner advanced a T1.2-safe canonical current source";

/**
 * DDR is the only repair-task kind this lane has ever produced. `kind` stays a
 * table column (the status projection still groups by it) but is no longer a
 * parameter: every writer below stamps `DDR_REPAIR_TASK_KIND`.
 */
interface RepairTaskInput {
  subjectId: string;
  priority?: number;
  nextAttemptAt?: number | null;
  payload?: Record<string, unknown> | null;
}

export interface DdrRepairDebtTaskInput {
  eventId: number;
  reason: string;
}

interface RepairDebtSummaryRow {
  kind: string;
  open_count: number | null;
  oldest_created_at: number | null;
  next_attempt_at: number | null;
}

interface RepairRunnerInspectRow {
  due_count: number | null;
  stale_claim_count: number | null;
}

export interface RepairRunnerOptions {
  nowSec?: number;
  signal?: AbortSignal;
  enabled?: boolean;
}

type RepairRunnerMetadata = {
  mode: "execute" | "disabled";
  enabled: boolean;
  batchLimit: typeof DDR_REPAIR_RUNNER_BATCH_LIMIT_V1;
  claimed: number;
  autoRepairCount: number;
  closed: number;
  deferred: number;
  failed: number;
  skipped?: "kill-switch";
  dueCount?: number;
  staleClaimCount?: number;
  tableMissing?: boolean;
};

interface RepairRunnerTaskRow {
  task_id: string;
  subject_id: string;
  payload_json: string | null;
}

interface DdrRepairCandidateRow {
  incident_key: string;
  stablecoin_id: string;
  peg_currency: string;
  direction: string;
  first_event_id: number;
  current_event_id: number;
  first_started_at: number;
  current_started_at: number;
  first_observed_peak_bucket_bps: number;
  closed_pre_lock_at: number | null;
  superseded_by_incident_key: string | null;
  source_fingerprint: string;
  target_event_id: number;
  target_stablecoin_id: string;
  target_symbol: string;
  target_peg_type: string;
  target_direction: string;
  target_started_at: number;
  target_start_price: number;
  target_peg_reference: number;
  target_source: string;
  current_event_ended_at: number | null;
}

function activeStateSql(): string {
  return ACTIVE_REPAIR_TASK_STATES.map(() => "?").join(",");
}

function terminalStateSql(): string {
  return TERMINAL_REPAIR_TASK_STATES.map(() => "?").join(",");
}

function claimableStateSql(): string {
  return ["open", "deferred", "failed"].map(() => "?").join(",");
}

function dueOpenOrDeferredWhereSql(): string {
  return `state IN (${claimableStateSql()}) AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`;
}

function staleClaimWhereSql(): string {
  return "state = 'claimed' AND (locked_until IS NULL OR locked_until <= ?)";
}

function closableStateSql(): string {
  return "(state IN ('open', 'deferred') OR (state = 'failed' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)))";
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("repair-task executor aborted");
}

export function isDdrRepairTaskRunnerEnabled(value: unknown): boolean {
  if (typeof value !== "string") return true;
  return !["0", "false", "no", "off", "disabled"].includes(value.trim().toLowerCase());
}

export function buildDdrRepairTaskId(subjectId: string): string {
  return `repair:${DDR_REPAIR_TASK_KIND}:${subjectId}`;
}

function normalizePriority(priority: number | null | undefined): number {
  return Number.isFinite(priority) ? Math.max(0, Math.floor(Number(priority))) : 100;
}

function serializePayload(payload: Record<string, unknown> | null | undefined): string | null {
  return payload ? JSON.stringify(payload) : null;
}

async function upsertRepairTask(
  db: D1Database,
  input: RepairTaskInput & { nowSec: number },
): Promise<void> {
  const taskId = buildDdrRepairTaskId(input.subjectId);
  await runWithOverloadRetry(() =>
    db
      .prepare(
        `INSERT INTO worker_repair_tasks (
          task_id,
          kind,
          subject_id,
          priority,
          state,
          attempt_count,
          next_attempt_at,
          payload_json,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, 'open', 0, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          priority = excluded.priority,
          state = CASE
            WHEN worker_repair_tasks.state IN ('closed', 'cancelled') THEN 'open'
            ELSE worker_repair_tasks.state
          END,
          next_attempt_at = CASE
            WHEN worker_repair_tasks.state = 'failed' THEN worker_repair_tasks.next_attempt_at
            ELSE excluded.next_attempt_at
          END,
          payload_json = excluded.payload_json,
          closed_at = CASE
            WHEN worker_repair_tasks.state IN ('closed', 'cancelled') THEN NULL
            ELSE worker_repair_tasks.closed_at
          END,
          updated_at = excluded.updated_at`,
      )
      .bind(
        taskId,
        DDR_REPAIR_TASK_KIND,
        input.subjectId,
        normalizePriority(input.priority),
        input.nextAttemptAt ?? null,
        serializePayload(input.payload),
        input.nowSec,
        input.nowSec,
      )
      .run(),
    3,
  );
}

async function closeRepairTasksNotInSubjects(
  db: D1Database,
  input: {
    activeSubjectIds: readonly string[];
    nowSec: number;
  },
): Promise<number> {
  const activeSubjectIds = [...new Set(input.activeSubjectIds)];
  if (activeSubjectIds.length === 0) {
    const result = await runWithOverloadRetry(() =>
      db
        .prepare(
          `UPDATE worker_repair_tasks
           SET state = 'closed',
               locked_by = NULL,
               locked_until = NULL,
               updated_at = ?,
               closed_at = ?
           WHERE kind = ?
             AND ${closableStateSql()}`,
        )
        .bind(input.nowSec, input.nowSec, DDR_REPAIR_TASK_KIND, input.nowSec)
        .run(),
      3,
    );
    return result.meta.changes ?? 0;
  }

  const inClause = buildInClause(activeSubjectIds);
  const result = await runWithOverloadRetry(() =>
    db
      .prepare(
        `UPDATE worker_repair_tasks
         SET state = 'closed',
             locked_by = NULL,
             locked_until = NULL,
             updated_at = ?,
             closed_at = ?
         WHERE kind = ?
           AND ${closableStateSql()}
           AND subject_id NOT IN (${inClause.sql})`,
      )
      .bind(input.nowSec, input.nowSec, DDR_REPAIR_TASK_KIND, input.nowSec, ...inClause.binds)
      .run(),
    3,
  );
  return result.meta.changes ?? 0;
}

export async function syncDdrRepairDebtTasks(
  db: D1Database,
  events: readonly DdrRepairDebtTaskInput[],
  nowSec: number,
  signal?: AbortSignal,
): Promise<{ upserted: number; closed: number }> {
  if (signal?.aborted) throw signal.reason ?? new Error("DDR repair task sync aborted");
  for (const event of events) {
    await upsertRepairTask(db, {
      subjectId: String(event.eventId),
      priority: 50,
      payload: {
        eventId: event.eventId,
        reason: event.reason,
      },
      nowSec,
    });
    if (signal?.aborted) throw signal.reason ?? new Error("DDR repair task sync aborted");
  }

  const closed = await closeRepairTasksNotInSubjects(db, {
    activeSubjectIds: events.map((event) => String(event.eventId)),
    nowSec,
  });
  return { upserted: events.length, closed };
}

export async function loadRepairDebtSummary(
  db: D1Database,
  nowSec: number,
): Promise<RepairDebtSummary> {
  const rows = await db
    .prepare(
      `SELECT
         kind,
         COUNT(*) AS open_count,
         MIN(created_at) AS oldest_created_at,
         MIN(next_attempt_at) AS next_attempt_at
       FROM worker_repair_tasks
       WHERE state IN (${activeStateSql()})
       GROUP BY kind
       ORDER BY kind
       LIMIT 50`,
    )
    .bind(...ACTIVE_REPAIR_TASK_STATES)
    .all<RepairDebtSummaryRow>();

  const byKind: RepairDebtSummary["byKind"] = {};
  let openCount = 0;
  let oldestAgeSec: number | null = null;
  let nextRunnerDueAt: number | null = null;

  for (const row of rows.results ?? []) {
    const count = Math.max(0, Math.floor(Number(row.open_count ?? 0)));
    const oldestCreatedAt = typeof row.oldest_created_at === "number" ? row.oldest_created_at : null;
    const kindOldestAgeSec = oldestCreatedAt != null ? Math.max(0, nowSec - oldestCreatedAt) : null;
    const kindNextDueAt = typeof row.next_attempt_at === "number" ? row.next_attempt_at : null;
    byKind[row.kind] = {
      openCount: count,
      oldestAgeSec: kindOldestAgeSec,
      nextRunnerDueAt: kindNextDueAt,
    };
    openCount += count;
    if (kindOldestAgeSec != null) {
      oldestAgeSec = oldestAgeSec == null ? kindOldestAgeSec : Math.max(oldestAgeSec, kindOldestAgeSec);
    }
    if (kindNextDueAt != null) {
      nextRunnerDueAt = nextRunnerDueAt == null ? kindNextDueAt : Math.min(nextRunnerDueAt, kindNextDueAt);
    }
  }

  return {
    status: openCount > 0 ? "present" : "ok",
    openCount,
    oldestAgeSec,
    byKind,
    availabilityEscalated: false,
    nextRunnerDueAt,
    source: "worker-repair-tasks",
  };
}

export async function pruneRepairTasks(
  db: D1Database,
  cutoffSec: number,
  signal?: AbortSignal,
): Promise<number> {
  try {
    const result = await runWithOverloadRetry(() =>
      db
        .prepare(
          `DELETE FROM worker_repair_tasks
           WHERE updated_at < ?
             AND state IN (${terminalStateSql()})`,
        )
        .bind(cutoffSec, ...TERMINAL_REPAIR_TASK_STATES)
        .run(),
      3,
      signal,
    );
    return result.meta.changes ?? 0;
  } catch (err) {
    if (isMissingTableError(err)) return 0;
    throw err;
  }
}

async function inspectRepairRunnerBacklog(
  db: D1Database,
  input: { nowSec: number; signal?: AbortSignal },
): Promise<{ dueCount: number; staleClaimCount: number; tableMissing: boolean }> {
  throwIfAborted(input.signal);
  try {
    const [dueRow, staleClaimRow] = await Promise.all([
      db
        .prepare(
          `SELECT COUNT(*) AS due_count
             FROM worker_repair_tasks
            WHERE ${dueOpenOrDeferredWhereSql()}`,
        )
        .bind("open", "deferred", "failed", input.nowSec)
        .first<RepairRunnerInspectRow>(),
      db
        .prepare(
          `SELECT COUNT(*) AS stale_claim_count
             FROM worker_repair_tasks
            WHERE ${staleClaimWhereSql()}`,
        )
        .bind(input.nowSec)
        .first<RepairRunnerInspectRow>(),
    ]);

    return {
      dueCount: Math.max(0, Math.floor(Number(dueRow?.due_count ?? 0))),
      staleClaimCount: Math.max(0, Math.floor(Number(staleClaimRow?.stale_claim_count ?? 0))),
      tableMissing: false,
    };
  } catch (err) {
    if (isMissingTableError(err)) return { dueCount: 0, staleClaimCount: 0, tableMissing: true };
    throw err;
  }
}

function buildRepairRunnerResult(
  metadata: RepairRunnerMetadata,
): StructuredCronResult<RepairRunnerMetadata> {
  return {
    status: metadata.tableMissing ? "degraded" : "ok",
    itemCount: metadata.autoRepairCount,
    metadata,
  };
}

function parseTaskEventId(task: RepairRunnerTaskRow): number | null {
  const subjectId = Number(task.subject_id);
  if (!Number.isSafeInteger(subjectId) || subjectId <= 0 || task.payload_json == null) return null;
  try {
    const payload = JSON.parse(task.payload_json) as { eventId?: unknown };
    return Number.isSafeInteger(payload.eventId) && payload.eventId === subjectId ? subjectId : null;
  } catch {
    return null;
  }
}

function isDdrRepairCandidate(row: DdrRepairCandidateRow | null): row is DdrRepairCandidateRow {
  return row != null
    && typeof row.incident_key === "string"
    && typeof row.stablecoin_id === "string"
    && typeof row.peg_currency === "string"
    && (row.direction === "above" || row.direction === "below")
    && Number.isSafeInteger(row.first_event_id)
    && Number.isSafeInteger(row.current_event_id)
    && Number.isSafeInteger(row.first_started_at)
    && Number.isSafeInteger(row.current_started_at)
    && Number.isSafeInteger(row.first_observed_peak_bucket_bps)
    && row.superseded_by_incident_key == null
    && /^[0-9a-f]{64}$/.test(row.source_fingerprint)
    && Number.isSafeInteger(row.target_event_id)
    && typeof row.target_stablecoin_id === "string"
    && typeof row.target_symbol === "string"
    && typeof row.target_peg_type === "string"
    && (row.target_direction === "above" || row.target_direction === "below")
    && Number.isSafeInteger(row.target_started_at)
    && typeof row.target_start_price === "number"
    && typeof row.target_peg_reference === "number"
    && row.target_source === "live";
}

async function listDueRepairRunnerTasks(
  db: D1Database,
  timestamp: number,
): Promise<RepairRunnerTaskRow[]> {
  const result = await db
    .prepare(
      `SELECT task_id, subject_id, payload_json
       FROM worker_repair_tasks
       WHERE ((${dueOpenOrDeferredWhereSql()}) OR (${staleClaimWhereSql()}))
         AND kind = ?
       ORDER BY priority ASC, created_at ASC, task_id ASC
       LIMIT ?`,
    )
    .bind("open", "deferred", "failed", timestamp, timestamp, DDR_REPAIR_TASK_KIND, DDR_REPAIR_RUNNER_BATCH_LIMIT_V1)
    .all<RepairRunnerTaskRow>();
  return result.results ?? [];
}

async function claimRepairRunnerTask(
  db: D1Database,
  taskId: string,
  timestamp: number,
): Promise<boolean> {
  const result = await runWithOverloadRetry(() =>
    db
      .prepare(
        `UPDATE worker_repair_tasks
         SET state = 'claimed',
             attempt_count = attempt_count + 1,
             last_attempt_at = ?,
             locked_by = ?,
             locked_until = ?,
             updated_at = ?
         WHERE task_id = ?
           AND kind = ?
           AND (
             (${dueOpenOrDeferredWhereSql()})
             OR (${staleClaimWhereSql()})
           )`,
      )
      .bind(
        timestamp,
        DDR_REPAIR_RUNNER_CREATED_BY,
        timestamp + DDR_REPAIR_RUNNER_CLAIM_LEASE_SEC_V1,
        timestamp,
        taskId,
        DDR_REPAIR_TASK_KIND,
        "open",
        "deferred",
        "failed",
        timestamp,
        timestamp,
      )
      .run(),
    3,
  );
  return Number(result.meta.changes ?? 0) === 1;
}

async function loadDdrRepairCandidate(
  db: D1Database,
  eventId: number,
): Promise<DdrRepairCandidateRow | null> {
  return db
    .prepare(
      `SELECT
         i.incident_key,
         i.stablecoin_id,
         i.peg_currency,
         i.direction,
         i.first_event_id,
         i.current_event_id,
         i.first_started_at,
         i.current_started_at,
         i.first_observed_peak_bucket_bps,
         i.closed_pre_lock_at,
         i.superseded_by_incident_key,
         i.source_fingerprint,
         target.id AS target_event_id,
         target.stablecoin_id AS target_stablecoin_id,
         target.symbol AS target_symbol,
         target.peg_type AS target_peg_type,
         target.direction AS target_direction,
         target.started_at AS target_started_at,
         target.start_price AS target_start_price,
         target.peg_reference AS target_peg_reference,
         target.source AS target_source,
         current_event.ended_at AS current_event_ended_at
       FROM depeg_events target
       JOIN depeg_resolver_incidents i
         ON i.stablecoin_id = target.stablecoin_id
        AND i.direction = target.direction
        AND i.peg_currency = CASE
          WHEN target.peg_type LIKE 'pegged%' THEN substr(target.peg_type, 7)
          ELSE 'USD'
        END
       JOIN depeg_events current_event ON current_event.id = i.current_event_id
       WHERE target.id = ?
         AND target.source = 'live'
         AND i.incident_state = 'active'
         AND i.superseded_by_incident_key IS NULL
         AND ${safeCurrentEventWhereSql()}
         AND ${predecessorLineageWhereSql()}
         AND EXISTS (
           SELECT 1
           FROM depeg_events_with_provenance canonical_target
           WHERE canonical_target.id = target.id
             AND canonical_target.stablecoin_id = target.stablecoin_id
             AND canonical_target.direction = target.direction
             AND canonical_target.started_at = target.started_at
             AND canonical_target.source = 'live'
             AND (
               canonical_target.provenance_audit_verdict IS NULL
               OR canonical_target.provenance_audit_verdict NOT IN ('false_positive', 'disputed', 'no_data')
             )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM depeg_resolver_incident_event_links existing_link
           WHERE existing_link.event_id = target.id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM depeg_resolver_event_repair_authorizations existing_authorization
           WHERE existing_authorization.event_id = target.id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM depeg_resolver_public_predictions prediction
           WHERE prediction.incident_key = i.incident_key
         )
         AND NOT EXISTS (
           SELECT 1
           FROM depeg_resolver_lock_opportunity_audit opportunity
           WHERE opportunity.incident_key = i.incident_key
             AND opportunity.action = 'pending'
         )
       ORDER BY i.current_started_at DESC, i.incident_key
       LIMIT 1`,
    )
    .bind(eventId)
    .first<DdrRepairCandidateRow>();
}

function targetIdentityWhereSql(): string {
  return `target.id = ?
          AND target.stablecoin_id = ?
          AND target.symbol = ?
          AND target.peg_type = ?
          AND target.direction = ?
          AND target.started_at = ?
          AND target.start_price IS ?
          AND target.peg_reference IS ?
          AND target.source = 'live'`;
}

function incidentIdentityWhereSql(): string {
  return `i.incident_key = ?
          AND i.stablecoin_id = ?
          AND i.peg_currency = ?
          AND i.direction = ?
          AND i.first_event_id = ?
          AND i.current_event_id = ?
          AND i.first_started_at = ?
          AND i.current_started_at = ?
          AND i.first_observed_peak_bucket_bps = ?
          AND i.incident_state = 'active'
          AND i.superseded_by_incident_key IS NULL
          AND i.source_fingerprint = ?`;
}

function candidateIdentityBinds(candidate: DdrRepairCandidateRow): unknown[] {
  return [
    candidate.incident_key,
    candidate.stablecoin_id,
    candidate.peg_currency,
    candidate.direction,
    candidate.first_event_id,
    candidate.current_event_id,
    candidate.first_started_at,
    candidate.current_started_at,
    candidate.first_observed_peak_bucket_bps,
    candidate.source_fingerprint,
  ];
}

function targetIdentityBinds(candidate: DdrRepairCandidateRow): unknown[] {
  return [
    candidate.target_event_id,
    candidate.target_stablecoin_id,
    candidate.target_symbol,
    candidate.target_peg_type,
    candidate.target_direction,
    candidate.target_started_at,
    candidate.target_start_price,
    candidate.target_peg_reference,
  ];
}

function safeCurrentEventWhereSql(): string {
  return `target.started_at > i.current_started_at
          AND (
            target.started_at - i.current_started_at <= ${DDR_PUBLIC_PREDICTION_BACKSTOP_DELAY_SEC}
            OR (
              current_event.ended_at IS NOT NULL
              AND target.started_at >= current_event.ended_at
              AND target.started_at - current_event.ended_at <= ${DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC}
            )
          )
          AND (
            i.closed_pre_lock_at IS NULL
            OR (
              current_event.ended_at IS NOT NULL
              AND target.started_at >= current_event.ended_at
              AND target.started_at - current_event.ended_at <= ${DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC}
            )
          )
          AND target.started_at - i.first_started_at <= ${DDR_FLAP_TOLERANT_MAX_INCIDENT_SPAN_SEC_V1}
          AND (
            SELECT COUNT(*)
            FROM depeg_resolver_incident_event_links linked
            WHERE linked.incident_key = i.incident_key
          ) < ${DDR_FLAP_TOLERANT_MAX_LINK_COUNT_V1}`;
}

function noExistingTargetRepairWhereSql(): string {
  return `NOT EXISTS (
            SELECT 1
            FROM depeg_resolver_incident_event_links existing_link
            WHERE existing_link.event_id = target.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM depeg_resolver_event_repair_authorizations existing_authorization
            WHERE existing_authorization.event_id = target.id
          )
          AND ${noPendingLockWhereSql()}`;
}

function noPendingLockWhereSql(): string {
  return `NOT EXISTS (
            SELECT 1
            FROM depeg_resolver_public_predictions prediction
            WHERE prediction.incident_key = i.incident_key
          )
          AND NOT EXISTS (
            SELECT 1
            FROM depeg_resolver_lock_opportunity_audit opportunity
           WHERE opportunity.incident_key = i.incident_key
             AND opportunity.action = 'pending'
          )`;
}

function predecessorLineageWhereSql(): string {
  return `EXISTS (
            SELECT 1
            FROM depeg_resolver_incident_event_links predecessor_link
            WHERE predecessor_link.incident_key = i.incident_key
              AND predecessor_link.event_id = i.current_event_id
              AND (
                predecessor_link.repair_authorization_id IS NULL
                OR EXISTS (
                  SELECT 1
                  FROM depeg_resolver_event_repair_authorizations predecessor_link_authorization
                  JOIN depeg_resolver_event_repair_authorization_consumptions predecessor_link_consumption
                    ON predecessor_link_consumption.authorization_id = predecessor_link_authorization.id
                   AND predecessor_link_consumption.event_id = predecessor_link_authorization.event_id
                   AND predecessor_link_consumption.incident_key = predecessor_link_authorization.incident_key
                   AND predecessor_link_consumption.operation = predecessor_link_authorization.operation
                  WHERE predecessor_link_authorization.id = predecessor_link.repair_authorization_id
                    AND predecessor_link_authorization.event_id = i.current_event_id
                    AND predecessor_link_authorization.incident_key = i.incident_key
                    AND predecessor_link_authorization.operation = 'incident_link'
                )
              )
          )
          AND EXISTS (
            SELECT 1
            FROM depeg_resolver_incident_revisions predecessor_revision
            WHERE predecessor_revision.incident_key = i.incident_key
              AND predecessor_revision.current_event_id = i.current_event_id
              AND (
                predecessor_revision.repair_authorization_id IS NULL
                OR EXISTS (
                  SELECT 1
                  FROM depeg_resolver_event_repair_authorizations predecessor_revision_authorization
                  JOIN depeg_resolver_event_repair_authorization_consumptions predecessor_revision_consumption
                    ON predecessor_revision_consumption.authorization_id = predecessor_revision_authorization.id
                   AND predecessor_revision_consumption.event_id = predecessor_revision_authorization.event_id
                   AND predecessor_revision_consumption.incident_key = predecessor_revision_authorization.incident_key
                   AND predecessor_revision_consumption.operation = predecessor_revision_authorization.operation
                  WHERE predecessor_revision_authorization.id = predecessor_revision.repair_authorization_id
                    AND predecessor_revision_authorization.event_id = i.current_event_id
                    AND predecessor_revision_authorization.incident_key = i.incident_key
                    AND predecessor_revision_authorization.operation = 'incident_current_update'
                )
              )
          )`;
}

function repairCandidateFromSql(): string {
  return `FROM depeg_resolver_incidents i
          JOIN depeg_events target
            ON target.id = ?
          JOIN depeg_events current_event
            ON current_event.id = i.current_event_id`;
}

type RunnerRepairOperation = "incident_link" | "incident_current_update";

function runnerAuthorizationIdentityWhereSql(operation: RunnerRepairOperation): string {
  return `authorization.event_id = ?
          AND authorization.incident_key = ?
          AND authorization.operation = '${operation}'
          AND authorization.created_at = ?
          AND authorization.expires_at = ?
          AND authorization.created_by = ?`;
}

function runnerAuthorizationIdSql(operation: RunnerRepairOperation): string {
  return `(SELECT authorization.id
           FROM depeg_resolver_event_repair_authorizations authorization
           WHERE ${runnerAuthorizationIdentityWhereSql(operation)}
           LIMIT 1)`;
}

function runnerConsumedAuthorizationWhereSql(operation: RunnerRepairOperation): string {
  return `EXISTS (
            SELECT 1
            FROM depeg_resolver_event_repair_authorizations authorization
            JOIN depeg_resolver_event_repair_authorization_consumptions consumption
              ON consumption.authorization_id = authorization.id
             AND consumption.event_id = authorization.event_id
             AND consumption.incident_key = authorization.incident_key
             AND consumption.operation = authorization.operation
            WHERE ${runnerAuthorizationIdentityWhereSql(operation)}
          )`;
}

function runnerAuthorizationIdentityBinds(
  candidate: DdrRepairCandidateRow,
  timestamp: number,
): unknown[] {
  return [
    candidate.target_event_id,
    candidate.incident_key,
    timestamp,
    timestamp + DDR_REPAIR_RUNNER_CLAIM_LEASE_SEC_V1,
    DDR_REPAIR_RUNNER_CREATED_BY,
  ];
}

async function candidateStillMatchesCanonicalIncident(
  db: D1Database,
  candidate: DdrRepairCandidateRow,
): Promise<boolean> {
  const incidents = await loadCanonicalIncidents(db, {
    incidentKeys: [candidate.incident_key],
    includeSuperseded: true,
  });
  const incident = incidents[0];
  return incidents.length === 1
    && incident != null
    && incident.incidentKey === candidate.incident_key
    && incident.stablecoinId === candidate.stablecoin_id
    && incident.pegCurrency === candidate.peg_currency
    && incident.direction === candidate.direction
    && incident.firstEventId === candidate.first_event_id
    && incident.currentEventId === candidate.current_event_id
    && incident.firstStartedAt === candidate.first_started_at
    && incident.currentStartedAt === candidate.current_started_at
    && incident.firstObservedPeakBucketBps === candidate.first_observed_peak_bucket_bps
    && incident.sourceFingerprint === candidate.source_fingerprint
    && incident.supersededByIncidentKey == null;
}

async function executeDdrRepair(
  db: D1Database,
  task: RepairRunnerTaskRow,
  timestamp: number,
): Promise<"closed" | "deferred"> {
  const eventId = parseTaskEventId(task);
  if (eventId == null) return "deferred";

  const candidate = await loadDdrRepairCandidate(db, eventId);
  if (!isDdrRepairCandidate(candidate)) return "deferred";
  if (!(await candidateStillMatchesCanonicalIncident(db, candidate))) return "deferred";

  const targetBinds = targetIdentityBinds(candidate);
  const incidentBinds = candidateIdentityBinds(candidate);
  const authorizationIdentityBinds = runnerAuthorizationIdentityBinds(candidate, timestamp);
  const statements = [
    db
      .prepare(
        `INSERT INTO depeg_resolver_event_repair_authorizations
         (event_id, incident_key, operation, columns_json, required_revision_id,
          required_erratum_id, reason, created_at, expires_at, created_by)
         VALUES (?, ?, 'incident_link', ?, NULL, NULL, ?,
           CASE WHEN EXISTS (
             SELECT 1
             ${repairCandidateFromSql()}
             WHERE ${targetIdentityWhereSql()}
               AND ${incidentIdentityWhereSql()}
               AND ${safeCurrentEventWhereSql()}
               AND ${predecessorLineageWhereSql()}
               AND ${noExistingTargetRepairWhereSql()}
               AND EXISTS (
                 SELECT 1
                 FROM depeg_events_with_provenance canonical_target
                 WHERE canonical_target.id = target.id
                   AND canonical_target.stablecoin_id = target.stablecoin_id
                   AND canonical_target.direction = target.direction
                   AND canonical_target.started_at = target.started_at
                   AND canonical_target.source = 'live'
                   AND (
                     canonical_target.provenance_audit_verdict IS NULL
                     OR canonical_target.provenance_audit_verdict NOT IN ('false_positive', 'disputed', 'no_data')
                   )
               )
               AND EXISTS (
                 SELECT 1
                 FROM worker_repair_tasks claimed_task
                 WHERE claimed_task.task_id = ?
                   AND claimed_task.kind = ?
                   AND claimed_task.state = 'claimed'
                   AND claimed_task.locked_by = ?
                   AND claimed_task.locked_until >= ?
               )
           ) THEN ? ELSE 0 END,
           ?, ?)`,
      )
      .bind(
        eventId,
        candidate.incident_key,
        DDR_REPAIR_RUNNER_LINK_COLUMNS_JSON,
        DDR_REPAIR_RUNNER_LINK_REASON,
        candidate.target_event_id,
        ...targetBinds,
        ...incidentBinds,
        task.task_id,
        DDR_REPAIR_TASK_KIND,
        DDR_REPAIR_RUNNER_CREATED_BY,
        timestamp,
        timestamp,
        timestamp + DDR_REPAIR_RUNNER_CLAIM_LEASE_SEC_V1,
        DDR_REPAIR_RUNNER_CREATED_BY,
      ),
    db
      .prepare(
        `INSERT INTO depeg_resolver_event_repair_authorization_consumptions
         (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
         SELECT authorization.id, authorization.event_id, authorization.incident_key,
                authorization.operation, ?, ?
         FROM depeg_resolver_event_repair_authorizations authorization
         WHERE ${runnerAuthorizationIdentityWhereSql("incident_link")}`,
      )
      .bind(timestamp, DDR_REPAIR_RUNNER_CREATED_BY, ...authorizationIdentityBinds),
    db
      .prepare(
        `INSERT INTO depeg_resolver_event_repair_authorizations
         (event_id, incident_key, operation, columns_json, required_revision_id,
          required_erratum_id, reason, created_at, expires_at, created_by)
         VALUES (?, ?, 'incident_current_update', ?, NULL, NULL, ?, ?, ?, ?)`,
      )
      .bind(
        eventId,
        candidate.incident_key,
        DDR_REPAIR_RUNNER_CURRENT_COLUMNS_JSON,
        DDR_REPAIR_RUNNER_CURRENT_REASON,
        timestamp,
        timestamp + DDR_REPAIR_RUNNER_CLAIM_LEASE_SEC_V1,
        DDR_REPAIR_RUNNER_CREATED_BY,
      ),
    db
      .prepare(
        `INSERT INTO depeg_resolver_event_repair_authorization_consumptions
         (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
         SELECT authorization.id, authorization.event_id, authorization.incident_key,
                authorization.operation, ?, ?
         FROM depeg_resolver_event_repair_authorizations authorization
         WHERE ${runnerAuthorizationIdentityWhereSql("incident_current_update")}`,
      )
      .bind(timestamp, DDR_REPAIR_RUNNER_CREATED_BY, ...authorizationIdentityBinds),
    db
      .prepare(
        `INSERT INTO depeg_resolver_incident_event_links
         (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
         VALUES (?, ?, 'repair_replacement',
           ${runnerAuthorizationIdSql("incident_link")},
           CASE WHEN ${runnerConsumedAuthorizationWhereSql("incident_link")}
             THEN ? ELSE 0 END,
           'T1.2-safe live tail linked by repair-task runner')`,
      )
      .bind(
        candidate.incident_key,
        candidate.target_event_id,
        ...authorizationIdentityBinds,
        ...authorizationIdentityBinds,
        timestamp,
      ),
    db
      .prepare(
        `INSERT INTO depeg_resolver_incident_revisions
         (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id, erratum_id, created_at, created_by)
         VALUES (?, ?, ?, 'T1.2-safe live tail adopted by repair-task runner',
           ${runnerAuthorizationIdSql("incident_current_update")}, NULL,
           CASE WHEN EXISTS (
             SELECT 1
             FROM depeg_resolver_incident_event_links linked
             WHERE linked.incident_key = ?
               AND linked.event_id = ?
               AND linked.repair_authorization_id = ${runnerAuthorizationIdSql("incident_link")}
           )
             AND ${runnerConsumedAuthorizationWhereSql("incident_current_update")}
             THEN ? ELSE 0 END,
           ?)`,
      )
      .bind(
        candidate.incident_key,
        candidate.current_event_id,
        candidate.target_event_id,
        ...authorizationIdentityBinds,
        candidate.incident_key,
        candidate.target_event_id,
        ...authorizationIdentityBinds,
        ...authorizationIdentityBinds,
        timestamp,
        DDR_REPAIR_RUNNER_CREATED_BY,
      ),
    db
      .prepare(
        `UPDATE depeg_resolver_incidents AS i
         SET current_event_id = ?,
             current_started_at = ?,
             closed_pre_lock_at = NULL,
             updated_at = ?
         WHERE ${incidentIdentityWhereSql()}
           AND EXISTS (
             SELECT 1
             FROM depeg_events target
             JOIN depeg_events current_event ON current_event.id = i.current_event_id
               WHERE ${targetIdentityWhereSql()}
               AND ${safeCurrentEventWhereSql()}
               AND ${predecessorLineageWhereSql()}
               AND ${noPendingLockWhereSql()}
               AND EXISTS (
                 SELECT 1
                 FROM depeg_resolver_incident_event_links linked
                 WHERE linked.incident_key = i.incident_key
                   AND linked.event_id = target.id
                   AND linked.repair_authorization_id = ${runnerAuthorizationIdSql("incident_link")}
               )
               AND EXISTS (
                 SELECT 1
                 FROM depeg_resolver_incident_revisions revision
                 WHERE revision.incident_key = i.incident_key
                   AND revision.previous_event_id = i.current_event_id
                   AND revision.current_event_id = target.id
                   AND revision.repair_authorization_id = ${runnerAuthorizationIdSql("incident_current_update")}
               )
           )`,
      )
      .bind(
        candidate.target_event_id,
        candidate.target_started_at,
        timestamp,
        ...incidentBinds,
        ...targetBinds,
        ...authorizationIdentityBinds,
        ...authorizationIdentityBinds,
      ),
    db
      .prepare(
        `UPDATE worker_repair_tasks
         SET state = CASE WHEN EXISTS (
               SELECT 1
               FROM depeg_resolver_incidents repaired
               WHERE repaired.incident_key = ?
                 AND repaired.current_event_id = ?
                 AND repaired.current_started_at = ?
                 AND repaired.source_fingerprint = ?
             )
             THEN 'closed'
             ELSE 'repair_guard_rejected'
           END,
             next_attempt_at = NULL,
             locked_by = NULL,
             locked_until = NULL,
             last_error = NULL,
             updated_at = ?,
             closed_at = ?
         WHERE task_id = ?
           AND kind = ?
           AND state = 'claimed'
           AND locked_by = ?
           AND locked_until >= ?`,
      )
      .bind(
        candidate.incident_key,
        candidate.target_event_id,
        candidate.target_started_at,
        candidate.source_fingerprint,
        timestamp,
        timestamp,
        task.task_id,
        DDR_REPAIR_TASK_KIND,
        DDR_REPAIR_RUNNER_CREATED_BY,
        timestamp,
      ),
  ];
  const results = await db.batch(statements);
  if (results.some((result) => Number(result.meta?.changes ?? 0) !== 1)) {
    throw new Error("DDR repair runner SQL guard rejected a claimed task");
  }
  return "closed";
}

async function setRepairRunnerTaskState(
  db: D1Database,
  input: {
    taskId: string;
    state: "deferred" | "failed";
    timestamp: number;
    error: string;
  },
): Promise<void> {
  await runWithOverloadRetry(() =>
    db
      .prepare(
        `UPDATE worker_repair_tasks
         SET state = ?,
             next_attempt_at = ?,
             locked_by = NULL,
             locked_until = NULL,
             last_error = ?,
             updated_at = ?
         WHERE task_id = ?
           AND kind = ?
           AND state = 'claimed'
           AND locked_by = ?`,
      )
      .bind(
        input.state,
        input.timestamp + DDR_REPAIR_RUNNER_BACKOFF_SEC_V1,
        input.error,
        input.timestamp,
        input.taskId,
        DDR_REPAIR_TASK_KIND,
        DDR_REPAIR_RUNNER_CREATED_BY,
      )
      .run(),
    3,
  );
}

export async function runWorkerRepairTaskRunner(
  db: D1Database,
  options: RepairRunnerOptions = {},
): Promise<ReturnType<typeof createCronResult>> {
  const timestamp = options.nowSec ?? nowSec();
  const backlog = await inspectRepairRunnerBacklog(db, { nowSec: timestamp, signal: options.signal });
  const baseMetadata = {
    batchLimit: DDR_REPAIR_RUNNER_BATCH_LIMIT_V1,
    dueCount: backlog.dueCount,
    staleClaimCount: backlog.staleClaimCount,
  } satisfies Pick<RepairRunnerMetadata, "batchLimit" | "dueCount" | "staleClaimCount">;
  if (backlog.tableMissing) {
    return createCronResult(buildRepairRunnerResult({
      mode: "execute",
      enabled: options.enabled ?? true,
      claimed: 0,
      autoRepairCount: 0,
      closed: 0,
      deferred: 0,
      failed: 0,
      tableMissing: true,
      ...baseMetadata,
    }));
  }
  if (options.enabled === false) {
    return createCronResult(buildRepairRunnerResult({
      mode: "disabled",
      enabled: false,
      claimed: 0,
      autoRepairCount: 0,
      closed: 0,
      deferred: 0,
      failed: 0,
      skipped: "kill-switch",
      ...baseMetadata,
    }));
  }

  const metadata: RepairRunnerMetadata = {
    mode: "execute",
    enabled: true,
    claimed: 0,
    autoRepairCount: 0,
    closed: 0,
    deferred: 0,
    failed: 0,
    ...baseMetadata,
  };
  try {
    const tasks = await listDueRepairRunnerTasks(db, timestamp);
    for (const task of tasks) {
      throwIfAborted(options.signal);
      if (!(await claimRepairRunnerTask(db, task.task_id, timestamp))) continue;
      metadata.claimed++;
      try {
        const outcome = await executeDdrRepair(db, task, timestamp);
        if (outcome === "closed") {
          metadata.closed++;
          metadata.autoRepairCount++;
        } else {
          await setRepairRunnerTaskState(db, {
            taskId: task.task_id,
            state: "deferred",
            timestamp,
            error: "safe-class-not-proven",
          });
          metadata.deferred++;
        }
      } catch (error) {
        if (isMissingTableError(error)) throw error;
        await setRepairRunnerTaskState(db, {
          taskId: task.task_id,
          state: "failed",
          timestamp,
          error: "repair-execution-failed",
        });
        metadata.failed++;
      }
    }
  } catch (error) {
    if (isMissingTableError(error)) {
      return createCronResult(buildRepairRunnerResult({
        ...metadata,
        tableMissing: true,
      }));
    }
    throw error;
  }
  return createCronResult(buildRepairRunnerResult(metadata));
}
