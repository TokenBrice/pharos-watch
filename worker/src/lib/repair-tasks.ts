import type { RepairDebtSummary } from "@shared/types/status";
import { createCronResult, type StructuredCronResult } from "./cron-result";
import { buildInClause, isMissingTableError } from "./db";
import { runWithOverloadRetry } from "./cron-lease";

export type RepairTaskState = "open" | "claimed" | "deferred" | "closed" | "failed" | "cancelled";

const ACTIVE_REPAIR_TASK_STATES: RepairTaskState[] = ["open", "claimed", "deferred", "failed"];
const TERMINAL_REPAIR_TASK_STATES: RepairTaskState[] = ["closed", "cancelled"];
const DDR_REPAIR_TASK_KIND = "ddr-repair-required-event";
const LEGACY_REPAIR_RUNNER_BATCH_LIMIT = 5;

export interface RepairTaskInput {
  kind: string;
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
}

type RepairRunnerMetadata = {
  mode: "shadow";
  batchLimit: typeof LEGACY_REPAIR_RUNNER_BATCH_LIMIT;
  claimed: 0;
  closed: 0;
  deferred: 0;
  failed: 0;
  skipped: "shadow-mode";
  dueCount?: number;
  staleClaimCount?: number;
  tableMissing?: boolean;
};

function activeStateSql(): string {
  return ACTIVE_REPAIR_TASK_STATES.map(() => "?").join(",");
}

function terminalStateSql(): string {
  return TERMINAL_REPAIR_TASK_STATES.map(() => "?").join(",");
}

function claimableStateSql(): string {
  return ["open", "deferred"].map(() => "?").join(",");
}

function dueOpenOrDeferredWhereSql(): string {
  return `state IN (${claimableStateSql()}) AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`;
}

function staleClaimWhereSql(): string {
  return "state = 'claimed' AND (locked_until IS NULL OR locked_until <= ?)";
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("repair debt monitor aborted");
}

export function buildRepairTaskId(kind: string, subjectId: string): string {
  return `repair:${kind}:${subjectId}`;
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
  const taskId = buildRepairTaskId(input.kind, input.subjectId);
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
            WHEN worker_repair_tasks.state IN ('closed', 'failed', 'cancelled') THEN 'open'
            ELSE worker_repair_tasks.state
          END,
          next_attempt_at = excluded.next_attempt_at,
          payload_json = excluded.payload_json,
          closed_at = CASE
            WHEN worker_repair_tasks.state IN ('closed', 'failed', 'cancelled') THEN NULL
            ELSE worker_repair_tasks.closed_at
          END,
          updated_at = excluded.updated_at`,
      )
      .bind(
        taskId,
        input.kind,
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
    kind: string;
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
             AND state IN (${activeStateSql()})`,
        )
        .bind(input.nowSec, input.nowSec, input.kind, ...ACTIVE_REPAIR_TASK_STATES)
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
           AND state IN (${activeStateSql()})
           AND subject_id NOT IN (${inClause.sql})`,
      )
      .bind(input.nowSec, input.nowSec, input.kind, ...ACTIVE_REPAIR_TASK_STATES, ...inClause.binds)
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
      kind: DDR_REPAIR_TASK_KIND,
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
    kind: DDR_REPAIR_TASK_KIND,
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
        .bind("open", "deferred", input.nowSec)
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
    itemCount: 0,
    metadata,
  };
}

export async function runWorkerRepairTaskRunner(
  db: D1Database,
  options: RepairRunnerOptions = {},
): Promise<ReturnType<typeof createCronResult>> {
  const timestamp = options.nowSec ?? nowSec();
  const backlog = await inspectRepairRunnerBacklog(db, { nowSec: timestamp, signal: options.signal });
  return createCronResult(buildRepairRunnerResult({
    mode: "shadow",
    batchLimit: LEGACY_REPAIR_RUNNER_BATCH_LIMIT,
    claimed: 0,
    closed: 0,
    deferred: 0,
    failed: 0,
    skipped: "shadow-mode",
    dueCount: backlog.dueCount,
    staleClaimCount: backlog.staleClaimCount,
    ...(backlog.tableMissing ? { tableMissing: true } : {}),
  }));
}
