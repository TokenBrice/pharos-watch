import type { CronResultStatus, SchedulerChildDisposition, SchedulerTerminalSource } from "@shared/types/status/cron";
import type { CronResult } from "./cron-logger";
import type { ScheduledExecutionFence } from "./scheduled-slot-fence";
import { prepareProducerOutcomeStatements, type ProducerIdentity, type RecordProducerOutcomeInput } from "./producer-history";
import { compactCronMetadataForPersistence } from "./cron-metadata-persistence";
import { parseJsonObject } from "./json-parse";
import { runWithOverloadRetry } from "./d1-overload-retry";

export interface ScheduledChildIdentity extends ProducerIdentity {
  slotStartedAt: number;
  attemptNo: number;
  executionFence: ScheduledExecutionFence;
}
export interface ScheduledChildAttemptRow {
  attempt_key: string;
  schedule_key: string;
  slot_started_at: number;
  job: string;
  producer_path: string;
  producer_kind: string;
  invocation_id: string;
  attempt_no: number;
  execution_schedule_key: string;
  execution_slot_started_at: number;
  execution_invocation_id: string;
  execution_generation: number;
  execution_owner: string;
  worker_version: string | null;
  started_at: number | null;
  lease_owner: string | null;
  terminal_source: SchedulerTerminalSource | null;
  terminal_token: string | null;
  terminal_at: number | null;
}
export interface ScheduledChildTerminalInput {
  identity: ScheduledChildIdentity;
  source: SchedulerTerminalSource;
  /** Keep this token when retrying an ambiguous commit. */
  token?: string;
  reconciler?: { owner: string; generation: number; state: "running" | "reconciling"; invocationId?: string | null };
  startedAt: number;
  completedAt: number;
  durationMs: number;
  status: CronResultStatus;
  degradedReason: string | null;
  disposition: SchedulerChildDisposition;
  producerOutcome: RecordProducerOutcomeInput["outcome"];
  itemCount?: number | null;
  metadata?: string | null;
  error?: string | null;
  productivity?: RecordProducerOutcomeInput["productivity"];
}
export class CronChildTerminalSupersededError extends Error {
  readonly code = "cron-child-terminal-superseded";
  readonly reason = this.code;
  constructor(
    readonly attemptKey: string,
    readonly completedResult: CronResult | void,
    readonly outputPublishedAt: number | null,
    readonly productive: boolean,
  ) {
    super(`Scheduled child terminal superseded: ${attemptKey}`);
    this.name = "CronChildTerminalSupersededError";
  }
}

export async function scheduledChildAttemptKey(identity: ScheduledChildIdentity): Promise<string> {
  const f = identity.executionFence;
  const tuple = JSON.stringify([
    identity.scheduleKey, identity.slotStartedAt, identity.job, identity.producerPath,
    identity.producerKind, identity.invocationId, identity.attemptNo,
    f.scheduleKey, f.slotStartedAt, f.invocationId, f.generation,
    ...(f.kind === "reserve-continuation" ? [f.kind, f.deliveryId] : []),
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tuple));
  return `scheduled-child:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function prepareAttempt(db: D1Database, identity: ScheduledChildIdentity, key: string, startedAt: number | null, leaseOwner: string | null, guard: string, bindings: (string | number | null)[]): D1PreparedStatement {
  const f = identity.executionFence;
  const sql = f.kind === "reserve-continuation"
    ? `INSERT INTO reserve_continuation_child_attempts (
        attempt_key, schedule_key, slot_started_at, job, producer_path, producer_kind, invocation_id, attempt_no,
        execution_schedule_key, execution_slot_started_at, execution_invocation_id, execution_generation,
        execution_owner, worker_version, started_at, lease_owner, delivery_id
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}
      ON CONFLICT(attempt_key) DO NOTHING`
    : `INSERT INTO scheduled_child_attempts (
        attempt_key, schedule_key, slot_started_at, job, producer_path, producer_kind, invocation_id, attempt_no,
        execution_schedule_key, execution_slot_started_at, execution_invocation_id, execution_generation,
        execution_owner, worker_version, started_at, lease_owner
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}
      ON CONFLICT(attempt_key) DO NOTHING`;
  return db.prepare(sql).bind(
    key, identity.scheduleKey, identity.slotStartedAt, identity.job, identity.producerPath, identity.producerKind,
    identity.invocationId, identity.attemptNo, f.scheduleKey, f.slotStartedAt, f.invocationId, f.generation,
    f.owner, identity.workerVersion ?? null, startedAt, leaseOwner,
    ...(f.kind === "reserve-continuation" ? [f.deliveryId!] : []), ...bindings,
  );
}

export function childAttemptTable(fence: ScheduledExecutionFence): "scheduled_child_attempts" | "reserve_continuation_child_attempts" {
  return fence.kind === "reserve-continuation" ? "reserve_continuation_child_attempts" : "scheduled_child_attempts";
}

function currentFenceSql(fence: ScheduledExecutionFence): string {
  if (fence.kind !== "reserve-continuation") return CURRENT_FENCE_SQL;
  if (!fence.deliveryId) throw new Error("Queue child requires a delivery fence");
  return `EXISTS (SELECT 1 FROM reserve_continuation_executions
    WHERE delivery_id = ? AND schedule_key = ? AND slot_started_at = ? AND state = ?
      AND execution_owner = ? AND execution_generation = ? AND invocation_id IS ?)`;
}
const CURRENT_FENCE_SQL = `EXISTS (SELECT 1 FROM cron_slot_executions
  WHERE slot_key = ? AND slot_started_at = ? AND state = ?
    AND execution_owner = ? AND execution_generation = ? AND invocation_id IS ?)`;

export async function markScheduledChildStarted(
  db: D1Database, identity: ScheduledChildIdentity, startedAt: number, leaseOwner: string | null = null,
): Promise<string> {
  const key = await scheduledChildAttemptKey(identity);
  const f = identity.executionFence;
  const bindings = [...(f.kind === "reserve-continuation" ? [f.deliveryId] : []),
    f.scheduleKey, f.slotStartedAt, "running", f.owner, f.generation, f.invocationId];
  const guard = currentFenceSql(f);
  await runWithOverloadRetry(() => prepareAttempt(db, identity, key, startedAt, leaseOwner, guard, bindings).run());
  const sql = f.kind === "reserve-continuation"
    ? `SELECT attempt_key FROM reserve_continuation_child_attempts
        WHERE attempt_key = ? AND started_at IS NOT NULL AND terminal_token IS NULL AND ${guard}`
    : `SELECT attempt_key FROM scheduled_child_attempts
        WHERE attempt_key = ? AND started_at IS NOT NULL AND terminal_token IS NULL AND ${guard}`;
  const row = await runWithOverloadRetry(() => db.prepare(sql)
    .bind(key, ...bindings).first<{ attempt_key: string }>());
  if (!row) throw new CronChildTerminalSupersededError(key, undefined, null, false);
  return key;
}

export async function writeScheduledChildTerminal(
  db: D1Database, input: ScheduledChildTerminalInput,
): Promise<{ accepted: boolean; attemptKey: string; token: string }> {
  const key = await scheduledChildAttemptKey(input.identity);
  const token = input.token ?? crypto.randomUUID();
  const f = input.identity.executionFence;
  if (input.source === "synthetic" && !input.reconciler) throw new Error("Synthetic child terminal requires reconciler CAS");
  const authority = input.source === "synthetic" ? input.reconciler!
    : { owner: f.owner, generation: f.generation, state: "running" };
  // A takeover may have changed invocation_id. Synthetic authority is the reconciler
  // owner/generation/state; the immutable dead invocation stays in the attempt tuple.
  const guard = input.source === "synthetic"
    ? currentFenceSql(f).replace(" AND invocation_id IS ?", "") : currentFenceSql(f);
  const bindings: (string | number | null)[] = [...(f.kind === "reserve-continuation" ? [f.deliveryId] : []),
    f.scheduleKey, f.slotStartedAt, authority.state, authority.owner, authority.generation];
  if (input.source !== "synthetic") bindings.push(f.invocationId);
  const metadata = compactCronMetadataForPersistence(JSON.stringify({
    ...(parseJsonObject(input.metadata) ?? {}), schedulerAttemptKey: key,
    schedulerTerminalSource: input.source, schedulerTerminalToken: token, childDisposition: input.disposition,
  }), undefined, input.identity.job).metadata;
  const terminalUpdateSql = f.kind === "reserve-continuation"
    ? `UPDATE reserve_continuation_child_attempts SET terminal_source = ?, terminal_token = ?, terminal_at = ?
        WHERE attempt_key = ? AND terminal_token IS NULL
          ${input.source === "real" ? "AND started_at IS NOT NULL" : ""} AND ${guard}`
    : `UPDATE scheduled_child_attempts SET terminal_source = ?, terminal_token = ?, terminal_at = ?
        WHERE attempt_key = ? AND terminal_token IS NULL
          ${input.source === "real" ? "AND started_at IS NOT NULL" : ""} AND ${guard}`;
  const terminalClaimSql = f.kind === "reserve-continuation"
    ? "SELECT 1 FROM reserve_continuation_child_attempts WHERE attempt_key = ? AND terminal_token = ?"
    : "SELECT 1 FROM scheduled_child_attempts WHERE attempt_key = ? AND terminal_token = ?";
  const statements = [
    ...(input.source === "real" ? [] : [prepareAttempt(db, input.identity, key,
      input.disposition === "abandoned" || input.disposition === "interrupted-by-deploy" ? input.startedAt : null,
      null, guard, bindings)]),
    db.prepare(terminalUpdateSql).bind(input.source, token, input.completedAt, key, ...bindings),
    db.prepare(`INSERT INTO cron_runs (
      job, started_at, duration_ms, status, item_count, metadata, slot_started_at, error, idempotency_key,
      schedule_key, producer_path, producer_kind, invocation_id, worker_version,
      productive, publication_count, calendar_period, degraded_reason
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (${terminalClaimSql})
      AND ${guard} ON CONFLICT DO NOTHING`).bind(
      input.identity.job, input.startedAt, input.durationMs, input.status, input.itemCount ?? null,
      metadata, input.identity.slotStartedAt, input.error ?? null, key,
      input.identity.scheduleKey, input.identity.producerPath, input.identity.producerKind,
      input.identity.invocationId, input.identity.workerVersion ?? null,
      input.productivity?.productive ? 1 : 0, input.productivity?.publications?.length ?? 0,
      input.identity.calendarPeriod ?? null, input.degradedReason, key, token, ...bindings,
    ),
    ...prepareProducerOutcomeStatements(db, {
      ...input.identity, idempotencyKey: key, invokedAt: input.startedAt, completedAt: input.completedAt,
      outcome: input.producerOutcome, itemCount: input.itemCount, metadata, error: input.error,
      productivity: input.productivity,
    }, { attemptKey: key, terminalToken: token, attemptNo: input.identity.attemptNo,
      executionSlotStartedAt: f.slotStartedAt, executionGeneration: f.generation,
      attemptTable: childAttemptTable(f) }),
  ];
  const results = await runWithOverloadRetry(() => db.batch(statements));
  if (results.some((result) => !result.success)) throw new Error("scheduled-child-terminal-batch-failed");
  const terminalReadSql = f.kind === "reserve-continuation"
    ? "SELECT terminal_token FROM reserve_continuation_child_attempts WHERE attempt_key = ?"
    : "SELECT terminal_token FROM scheduled_child_attempts WHERE attempt_key = ?";
  const row = await runWithOverloadRetry(() => db.prepare(terminalReadSql)
    .bind(key).first<{ terminal_token: string | null }>());
  return { accepted: row?.terminal_token === token, attemptKey: key, token };
}
