import type { RepairDebtSummary } from "@shared/types/status";
import { createCronResult, type StructuredCronResult } from "./cron-result";
import { buildInClause, isMissingTableError } from "./db";
import { runWithOverloadRetry } from "./cron-lease";
import { toErrorMessage } from "./error-utils";

export type WorkerRepairRunnerMode = "off" | "shadow" | "enabled";

export type RepairTaskState = "open" | "claimed" | "deferred" | "closed" | "failed" | "cancelled";

const ACTIVE_REPAIR_TASK_STATES: RepairTaskState[] = ["open", "claimed", "deferred", "failed"];
const TERMINAL_REPAIR_TASK_STATES: RepairTaskState[] = ["closed", "cancelled"];
const DDR_REPAIR_TASK_KIND = "ddr-repair-required-event";
const REPAIR_RUNNER_BATCH_LIMIT = 5;
const REPAIR_RUNNER_LOCK_TTL_SEC = 15 * 60;
const REPAIR_RUNNER_DEFER_SEC = 24 * 60 * 60;
const REPAIR_RUNNER_MAX_ERROR_CHARS = 500;

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

interface RepairTaskRow {
  task_id: string;
  kind: string;
  subject_id: string;
  priority: number | null;
  state: RepairTaskState;
  attempt_count: number | null;
  next_attempt_at: number | null;
  locked_until: number | null;
  payload_json: string | null;
  created_at: number;
  updated_at: number;
}

interface RepairRunnerInspectRow {
  due_count: number | null;
  stale_claim_count: number | null;
}

type RepairTaskProcessOutcome =
  | { action: "closed"; reason: string }
  | { action: "deferred"; reason: string; nextAttemptAt: number };

export interface RepairRunnerOptions {
  mode?: string;
  nowSec?: number;
  batchLimit?: number;
  signal?: AbortSignal;
}

type RepairRunnerMetadata = {
  mode: WorkerRepairRunnerMode;
  batchLimit: number;
  claimed: number;
  closed: number;
  deferred: number;
  failed: number;
  skipped?: string;
  dueCount?: number;
  staleClaimCount?: number;
  tableMissing?: boolean;
  outcomes?: Array<{
    taskId: string;
    kind: string;
    subjectId: string;
    action: "closed" | "deferred" | "failed";
    reason: string;
  }>;
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

function normalizeBatchLimit(value: number | null | undefined): number {
  if (!Number.isFinite(value)) return REPAIR_RUNNER_BATCH_LIMIT;
  return Math.max(1, Math.min(REPAIR_RUNNER_BATCH_LIMIT, Math.floor(Number(value))));
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function truncateError(value: unknown): string {
  return toErrorMessage(value).slice(0, REPAIR_RUNNER_MAX_ERROR_CHARS);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("repair task runner aborted");
}

function normalizeWorkerRepairRunnerMode(value: string | undefined): WorkerRepairRunnerMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "shadow" || normalized === "enabled") return normalized;
  return "off";
}

function buildRepairRunnerOwner(timestamp: number): string {
  const randomId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : String(timestamp);
  return `repair-runner:${timestamp}:${randomId}`;
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

async function loadClaimableRepairTasks(
  db: D1Database,
  input: { nowSec: number; limit: number; signal?: AbortSignal },
): Promise<{ rows: RepairTaskRow[]; tableMissing: boolean }> {
  throwIfAborted(input.signal);
  try {
    const selectColumns = `
           task_id,
           kind,
           subject_id,
           priority,
           state,
           attempt_count,
           next_attempt_at,
           locked_until,
           payload_json,
           created_at,
           updated_at`;
    const [dueRows, staleClaimRows] = await Promise.all([
      db
        .prepare(
          `SELECT
           ${selectColumns}
         FROM worker_repair_tasks
         WHERE ${dueOpenOrDeferredWhereSql()}
         ORDER BY next_attempt_at ASC, priority ASC, updated_at ASC
         LIMIT ?`,
        )
        .bind("open", "deferred", input.nowSec, input.limit)
        .all<RepairTaskRow>(),
      db
        .prepare(
          `SELECT
           ${selectColumns}
         FROM worker_repair_tasks
         WHERE ${staleClaimWhereSql()}
         ORDER BY locked_until ASC, updated_at ASC
         LIMIT ?`,
        )
        .bind(input.nowSec, input.limit)
        .all<RepairTaskRow>(),
    ]);
    const rowsByTaskId = new Map<string, RepairTaskRow>();
    for (const row of [...(dueRows.results ?? []), ...(staleClaimRows.results ?? [])]) {
      rowsByTaskId.set(row.task_id, row);
    }
    const rows = [...rowsByTaskId.values()]
      .sort((a, b) =>
        (a.priority ?? 100) - (b.priority ?? 100) ||
        (a.next_attempt_at ?? a.created_at) - (b.next_attempt_at ?? b.created_at) ||
        a.updated_at - b.updated_at ||
        a.task_id.localeCompare(b.task_id)
      )
      .slice(0, input.limit);
    return { rows, tableMissing: false };
  } catch (err) {
    if (isMissingTableError(err)) return { rows: [], tableMissing: true };
    throw err;
  }
}

async function claimRepairTask(
  db: D1Database,
  input: {
    taskId: string;
    owner: string;
    nowSec: number;
    lockedUntil: number;
    signal?: AbortSignal;
  },
): Promise<boolean> {
  throwIfAborted(input.signal);
  const result = await runWithOverloadRetry(() =>
    db
      .prepare(
        `UPDATE worker_repair_tasks
         SET state = 'claimed',
             locked_by = ?,
             locked_until = ?,
             attempt_count = attempt_count + 1,
             last_attempt_at = ?,
             updated_at = ?
         WHERE task_id = ?
           AND (${dueOpenOrDeferredWhereSql()} OR ${staleClaimWhereSql()})`,
      )
      .bind(
        input.owner,
        input.lockedUntil,
        input.nowSec,
        input.nowSec,
        input.taskId,
        "open",
        "deferred",
        input.nowSec,
        input.nowSec,
      )
      .run(),
    3,
    input.signal,
  );
  return (result.meta.changes ?? 0) > 0;
}

async function closeRepairTask(
  db: D1Database,
  input: { taskId: string; owner: string; nowSec: number; signal?: AbortSignal },
): Promise<void> {
  throwIfAborted(input.signal);
  await runWithOverloadRetry(() =>
    db
      .prepare(
        `UPDATE worker_repair_tasks
         SET state = 'closed',
             locked_by = NULL,
             locked_until = NULL,
             last_error = NULL,
             updated_at = ?,
             closed_at = ?
         WHERE task_id = ?
           AND state = 'claimed'
           AND locked_by = ?`,
      )
      .bind(input.nowSec, input.nowSec, input.taskId, input.owner)
      .run(),
    3,
    input.signal,
  );
}

async function deferRepairTask(
  db: D1Database,
  input: {
    taskId: string;
    owner: string;
    nowSec: number;
    nextAttemptAt: number;
    reason: string;
    signal?: AbortSignal;
  },
): Promise<void> {
  throwIfAborted(input.signal);
  await runWithOverloadRetry(() =>
    db
      .prepare(
        `UPDATE worker_repair_tasks
         SET state = 'deferred',
             locked_by = NULL,
             locked_until = NULL,
             next_attempt_at = ?,
             last_error = ?,
             updated_at = ?
         WHERE task_id = ?
           AND state = 'claimed'
           AND locked_by = ?`,
      )
      .bind(input.nextAttemptAt, input.reason.slice(0, REPAIR_RUNNER_MAX_ERROR_CHARS), input.nowSec, input.taskId, input.owner)
      .run(),
    3,
    input.signal,
  );
}

async function hasDdrEventLink(db: D1Database, eventId: number, signal?: AbortSignal): Promise<boolean> {
  throwIfAborted(signal);
  const row = await db
    .prepare("SELECT 1 AS ok FROM depeg_resolver_incident_event_links WHERE event_id = ? LIMIT 1")
    .bind(eventId)
    .first<{ ok: number }>();
  return row != null;
}

async function hasDepegEvent(db: D1Database, eventId: number, signal?: AbortSignal): Promise<boolean> {
  throwIfAborted(signal);
  const row = await db
    .prepare("SELECT 1 AS ok FROM depeg_events WHERE id = ? LIMIT 1")
    .bind(eventId)
    .first<{ ok: number }>();
  return row != null;
}

function parseDdrRepairEventId(row: RepairTaskRow): number | null {
  const subjectId = Number(row.subject_id);
  if (Number.isInteger(subjectId) && subjectId > 0) return subjectId;
  if (!row.payload_json) return null;
  try {
    const parsed = JSON.parse(row.payload_json) as { eventId?: unknown };
    const eventId = Number(parsed.eventId);
    return Number.isInteger(eventId) && eventId > 0 ? eventId : null;
  } catch {
    return null;
  }
}

async function processDdrRepairTask(
  db: D1Database,
  row: RepairTaskRow,
  input: { nowSec: number; signal?: AbortSignal },
): Promise<RepairTaskProcessOutcome> {
  const eventId = parseDdrRepairEventId(row);
  if (eventId == null) {
    return { action: "closed", reason: "malformed-ddr-event-id" };
  }

  if (await hasDdrEventLink(db, eventId, input.signal)) {
    return { action: "closed", reason: "ddr-event-linked" };
  }
  if (!(await hasDepegEvent(db, eventId, input.signal))) {
    return { action: "closed", reason: "depeg-event-missing" };
  }

  return {
    action: "deferred",
    reason: "manual-ddr-repair-required",
    nextAttemptAt: input.nowSec + REPAIR_RUNNER_DEFER_SEC,
  };
}

async function processRepairTask(
  db: D1Database,
  row: RepairTaskRow,
  input: { nowSec: number; signal?: AbortSignal },
): Promise<RepairTaskProcessOutcome> {
  if (row.kind === DDR_REPAIR_TASK_KIND) {
    return processDdrRepairTask(db, row, input);
  }
  return {
    action: "deferred",
    reason: `unsupported-repair-kind:${row.kind}`,
    nextAttemptAt: input.nowSec + REPAIR_RUNNER_DEFER_SEC,
  };
}

function buildRepairRunnerResult(
  metadata: RepairRunnerMetadata,
): StructuredCronResult<RepairRunnerMetadata> {
  return {
    status: metadata.failed > 0 || metadata.tableMissing ? "degraded" : "ok",
    itemCount: metadata.claimed,
    metadata,
  };
}

export async function runWorkerRepairTaskRunner(
  db: D1Database,
  options: RepairRunnerOptions = {},
): Promise<ReturnType<typeof createCronResult>> {
  const mode = normalizeWorkerRepairRunnerMode(options.mode);
  const timestamp = options.nowSec ?? nowSec();
  const batchLimit = normalizeBatchLimit(options.batchLimit);
  const baseMetadata: RepairRunnerMetadata = {
    mode,
    batchLimit,
    claimed: 0,
    closed: 0,
    deferred: 0,
    failed: 0,
  };

  if (mode === "off") {
    return createCronResult(buildRepairRunnerResult({
      ...baseMetadata,
      skipped: "mode-off",
    }));
  }

  const backlog = await inspectRepairRunnerBacklog(db, { nowSec: timestamp, signal: options.signal });
  if (mode === "shadow" || backlog.tableMissing) {
    return createCronResult(buildRepairRunnerResult({
      ...baseMetadata,
      dueCount: backlog.dueCount,
      staleClaimCount: backlog.staleClaimCount,
      ...(mode === "shadow" ? { skipped: "shadow-mode" } : {}),
      ...(backlog.tableMissing ? { tableMissing: true } : {}),
    }));
  }

  const owner = buildRepairRunnerOwner(timestamp);
  const loaded = await loadClaimableRepairTasks(db, {
    nowSec: timestamp,
    limit: batchLimit,
    signal: options.signal,
  });
  const metadata: RepairRunnerMetadata = {
    ...baseMetadata,
    dueCount: backlog.dueCount,
    staleClaimCount: backlog.staleClaimCount,
    ...(loaded.tableMissing ? { tableMissing: true } : {}),
    outcomes: [],
  };

  if (loaded.tableMissing) {
    return createCronResult(buildRepairRunnerResult(metadata));
  }

  for (const row of loaded.rows) {
    throwIfAborted(options.signal);
    const claimed = await claimRepairTask(db, {
      taskId: row.task_id,
      owner,
      nowSec: timestamp,
      lockedUntil: timestamp + REPAIR_RUNNER_LOCK_TTL_SEC,
      signal: options.signal,
    });
    if (!claimed) continue;

    metadata.claimed += 1;
    try {
      const outcome = await processRepairTask(db, row, { nowSec: timestamp, signal: options.signal });
      if (outcome.action === "closed") {
        await closeRepairTask(db, { taskId: row.task_id, owner, nowSec: timestamp, signal: options.signal });
        metadata.closed += 1;
      } else {
        await deferRepairTask(db, {
          taskId: row.task_id,
          owner,
          nowSec: timestamp,
          nextAttemptAt: outcome.nextAttemptAt,
          reason: outcome.reason,
          signal: options.signal,
        });
        metadata.deferred += 1;
      }
      metadata.outcomes?.push({
        taskId: row.task_id,
        kind: row.kind,
        subjectId: row.subject_id,
        action: outcome.action,
        reason: outcome.reason,
      });
    } catch (err) {
      const reason = truncateError(err);
      await deferRepairTask(db, {
        taskId: row.task_id,
        owner,
        nowSec: timestamp,
        nextAttemptAt: timestamp + REPAIR_RUNNER_DEFER_SEC,
        reason,
        signal: options.signal,
      });
      metadata.failed += 1;
      metadata.outcomes?.push({
        taskId: row.task_id,
        kind: row.kind,
        subjectId: row.subject_id,
        action: "failed",
        reason,
      });
    }
  }

  return createCronResult(buildRepairRunnerResult(metadata));
}
