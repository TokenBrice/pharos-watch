import type {
  ReserveCompositionRecord,
  ReserveSyncAttemptHistoryRecord,
  ReserveSyncAttemptStartRecord,
  ReserveSyncStateRecord,
} from "./store-shared";
import {
  RESERVE_COMPOSITION_CONFLICT_ASSIGNMENTS,
  RESERVE_COMPOSITION_INSERT_COLUMNS,
} from "./store-shared";

const SQLITE_NOW_MS_EXPRESSION = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

const serializeWarnings = (w: readonly unknown[]): string | null => (w.length > 0 ? JSON.stringify(w) : null);

const HISTORY_TARGETS = {
  composition: {
    table: "reserve_composition_history",
    columns: ["stablecoin_id", "fetched_at", "adapter_key", "attempt_id", "payload_sha256", "slices", "metadata", "warnings",
      "warning_count", "adapter_source_model", "adapter_evidence_class"],
    insertValues: (record: ReserveCompositionRecord, payloadSha256: string | null = null) => [
      record.stablecoinId, record.fetchedAt, record.source, record.attemptId ?? null, payloadSha256,
      "", "{}", null, record.warningCount, record.adapterSourceModel, record.adapterEvidenceClass],
  },
  attempt: {
    table: "reserve_sync_attempt_history",
    columns: ["stablecoin_id", "attempted_at", "adapter_key", "breaker_key", "attempt_id", "status",
      "warnings", "warning_count", "last_error", "metadata"],
    insertValues: (record: ReserveSyncAttemptHistoryRecord) => [
      record.stablecoinId, record.attemptedAt, record.adapterKey, record.breakerKey,
      record.attemptId ?? null, record.status, serializeWarnings(record.warnings), record.warningCount,
      record.lastError, JSON.stringify(record.metadata)],
  },
} as const;

type HistoryTarget = (typeof HISTORY_TARGETS)[keyof typeof HISTORY_TARGETS];

function authoritativeSnapshotPredicate(state: "s" | "reserve_sync_state"): string {
  return `${state}.last_success_at = c.fetched_at
          AND ${state}.last_attempt_id = c.attempt_id
          AND ${state}.last_success_attempt_id = c.attempt_id
          AND ${state}.pending_attempt_id IS NULL`;
}

/** Strict current-attempt authority; retained older successes use the reader's broader admission policy. */
const AUTHORITATIVE_SNAPSHOT_JOIN = `FROM reserve_composition c
         JOIN reserve_sync_state s ON s.stablecoin_id = c.stablecoin_id
        WHERE c.stablecoin_id = ?
          AND c.attempt_id = ?
          AND ${authoritativeSnapshotPredicate("s")}`;

function buildHistoryInsertStatement(
  db: D1Database,
  target: HistoryTarget,
  values: unknown[],
  gate: string,
  gateBinds: unknown[],
): D1PreparedStatement {
  // SAFETY: `target` is one of the HISTORY_TARGETS `as const` descriptors above; table/columns are literals.
  return db.prepare(
    `INSERT OR IGNORE INTO ${target.table} (
         ${target.columns.join(",\n         ")}
       ) SELECT ${values.map(() => "?").join(", ")} WHERE EXISTS (${gate})`,
  ).bind(...values, ...gateBinds);
}



export function buildReserveCompositionFinalizeSuccessStatement(
  db: D1Database,
  record: ReserveCompositionRecord,
  finalizeDeadlineMs: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO reserve_composition (
${RESERVE_COMPOSITION_INSERT_COLUMNS}
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1
           FROM reserve_sync_state
          WHERE stablecoin_id = ?
            AND last_attempt_id = ?
            AND pending_attempt_id = ?
            AND ${SQLITE_NOW_MS_EXPRESSION} <= ?
       )
       ON CONFLICT(stablecoin_id) DO UPDATE SET
${RESERVE_COMPOSITION_CONFLICT_ASSIGNMENTS}
       WHERE (
            reserve_composition.fetched_at < excluded.fetched_at
            OR (reserve_composition.fetched_at = excluded.fetched_at AND reserve_composition.attempt_id IS NULL)
         )
         AND EXISTS (
           SELECT 1
             FROM reserve_sync_state
            WHERE stablecoin_id = ?
              AND last_attempt_id = ?
              AND pending_attempt_id = ?
              AND ${SQLITE_NOW_MS_EXPRESSION} <= ?
         )`,
    )
    .bind(
      record.stablecoinId,
      JSON.stringify(record.slices),
      record.fetchedAt,
      record.source,
      record.attemptId ?? null,
      JSON.stringify(record.metadata),
      record.warningCount,
      serializeWarnings(record.warnings),
      record.adapterSourceModel,
      record.adapterEvidenceClass,
      record.configFingerprint ?? null,
      record.stablecoinId,
      record.attemptId ?? null,
      record.attemptId ?? null,
      finalizeDeadlineMs,
      record.stablecoinId,
      record.attemptId ?? null,
      record.attemptId ?? null,
      finalizeDeadlineMs,
    );
}

export const buildReserveCompositionHistoryInsertStatement = (
  db: D1Database,
  record: ReserveCompositionRecord,
  payloadSha256: string | null = null,
) => buildHistoryInsertStatement(
  db,
  HISTORY_TARGETS.composition,
  HISTORY_TARGETS.composition.insertValues(record, payloadSha256),
  `SELECT 1 ${AUTHORITATIVE_SNAPSHOT_JOIN} AND c.fetched_at = ?`,
  [record.stablecoinId, record.attemptId ?? null, record.fetchedAt],
);

export const buildReserveSyncAttemptHistoryInsertStatement = (
  db: D1Database,
  record: ReserveSyncAttemptHistoryRecord,
  mode: "attempt" | "success" | "deferred" = "attempt",
) => buildHistoryInsertStatement(
  db,
  HISTORY_TARGETS.attempt,
  HISTORY_TARGETS.attempt.insertValues(record),
  mode === "deferred"
    // A scheduling deferral is recorded even when the state upsert preserves a healthy snapshot.
    ? `SELECT 1 WHERE ? IS NULL AND ? = 'skipped'`
    : mode === "success"
    ? `SELECT 1 ${AUTHORITATIVE_SNAPSHOT_JOIN}`
    : `SELECT 1 FROM reserve_sync_state
        WHERE stablecoin_id = ? AND last_attempt_id IS ?
          AND pending_attempt_id IS NULL AND last_attempted_at = ? AND last_status = ?`,
  mode === "deferred"
    ? [record.attemptId ?? null, record.status]
    : mode === "success"
    ? [record.stablecoinId, record.attemptId ?? null]
    : [record.stablecoinId, record.attemptId ?? null, record.attemptedAt, record.status],
);

export function buildReserveAttemptAuthoritativeReadbackStatement(
  db: D1Database,
  stablecoinId: string,
  attemptId: string,
): D1PreparedStatement {
  return db.prepare(
    `SELECT 1 AS finalized
           ${AUTHORITATIVE_SNAPSHOT_JOIN}
          LIMIT 1`,
  ).bind(stablecoinId, attemptId);
}

export function buildReserveSuccessAuthoritativeReadbackStatement(
  db: D1Database,
  stablecoinId: string,
  fetchedAt: number,
  attemptId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT 1 AS finalized
         ${AUTHORITATIVE_SNAPSHOT_JOIN}
          AND c.fetched_at = ?
        LIMIT 1`,
    )
    .bind(stablecoinId, attemptId, fetchedAt);
}

export function buildReserveSyncAttemptStartStatement(
  db: D1Database,
  record: ReserveSyncAttemptStartRecord,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO reserve_sync_state (
         stablecoin_id,
         adapter_key,
         breaker_key,
         last_attempted_at,
         last_success_at,
         last_status,
         warning_count,
         warnings,
         last_error,
         metadata,
         last_attempt_id,
         pending_attempt_id,
         last_success_attempt_id,
         config_fingerprint
       ) SELECT ?, ?, ?, ?, NULL, 'skipped', 0, NULL, NULL, '{}', ?, ?, NULL, ?
       WHERE ${SQLITE_NOW_MS_EXPRESSION} <= ?
         ${record.checkpoint ? `AND EXISTS (
           SELECT 1 FROM worker_scheduled_checkpoints
           WHERE schedule_key = ? AND slot_started_at = ? AND job = ?
             AND attempt_no = ? AND execution_generation = ? AND invocation_id = ?
             AND current_domain_attempt_id = ? AND next_item_key = ?
             AND state IN ('running', 'recovering')
         )` : ""}
       ON CONFLICT(stablecoin_id) DO UPDATE SET
         adapter_key = excluded.adapter_key,
         breaker_key = excluded.breaker_key,
         last_attempted_at = excluded.last_attempted_at,
         last_attempt_id = excluded.last_attempt_id,
         pending_attempt_id = excluded.pending_attempt_id,
         config_fingerprint = excluded.config_fingerprint`,
    )
    .bind(
      record.stablecoinId,
      record.adapterKey,
      record.breakerKey,
      record.attemptedAt,
      record.attemptId,
      record.attemptId,
      record.configFingerprint ?? null,
      record.deadlineMs ?? Number.MAX_SAFE_INTEGER,
      ...(record.checkpoint ? [
        record.checkpoint.scheduleKey, record.checkpoint.slotStartedAt, record.checkpoint.job,
        record.checkpoint.attemptNo, record.checkpoint.executionGeneration, record.checkpoint.invocationId,
        record.attemptId, record.stablecoinId,
      ] : []),
    );
}

export function buildReserveSyncFinalizeSuccessStatement(
  db: D1Database,
  record: ReserveSyncStateRecord,
  finalizeDeadlineMs: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE reserve_sync_state
         SET adapter_key = ?,
             breaker_key = ?,
             last_attempted_at = ?,
             last_success_at = ?,
             last_status = ?,
             warning_count = ?,
             warnings = ?,
             last_error = ?,
             metadata = ?,
             last_attempt_id = ?,
             pending_attempt_id = NULL,
             last_success_attempt_id = ?,
             config_fingerprint = ?
       WHERE stablecoin_id = ?
         AND last_attempt_id = ?
         AND pending_attempt_id = ?
         AND EXISTS (
           SELECT 1
             FROM reserve_composition
            WHERE stablecoin_id = ?
              AND fetched_at = ?
              AND attempt_id = ?
         )
         AND ${SQLITE_NOW_MS_EXPRESSION} <= ?`,
    )
    .bind(
      record.adapterKey,
      record.breakerKey,
      record.lastAttemptedAt,
      record.lastSuccessAt,
      record.lastStatus,
      record.warningCount,
      serializeWarnings(record.warnings),
      record.lastError,
      JSON.stringify(record.metadata),
      record.lastAttemptId ?? null,
      record.lastSuccessAttemptId ?? null,
      record.configFingerprint ?? null,
      record.stablecoinId,
      record.lastAttemptId ?? null,
      record.pendingAttemptId ?? null,
      record.stablecoinId,
      record.lastSuccessAt ?? null,
      record.lastSuccessAttemptId ?? null,
      finalizeDeadlineMs,
    );
}

export function buildReserveSyncFinalizeAttemptStatement(
  db: D1Database,
  record: ReserveSyncStateRecord,
  deadlineMs = Number.MAX_SAFE_INTEGER,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE reserve_sync_state
         SET adapter_key = ?,
             breaker_key = ?,
             last_attempted_at = ?,
             last_status = ?,
             warning_count = ?,
             warnings = ?,
             last_error = ?,
             metadata = ?,
             last_attempt_id = ?,
             pending_attempt_id = NULL,
             config_fingerprint = ?
       WHERE stablecoin_id = ?
         AND last_attempt_id = ?
         AND pending_attempt_id = ?
         AND ${SQLITE_NOW_MS_EXPRESSION} <= ?`,
    )
    .bind(
      record.adapterKey,
      record.breakerKey,
      record.lastAttemptedAt,
      record.lastStatus,
      record.warningCount,
      serializeWarnings(record.warnings),
      record.lastError,
      JSON.stringify(record.metadata),
      record.lastAttemptId ?? null,
      record.configFingerprint ?? null,
      record.stablecoinId,
      record.lastAttemptId ?? null,
      record.pendingAttemptId ?? null,
      deadlineMs,
    );
}

export interface ReserveSyncDeferredRecord {
  stablecoinId: string;
  adapterKey: string;
  breakerKey: string;
  attemptedAt: number;
  reason: string;
}

export function buildReserveSyncRecordDeferredStatement(
  db: D1Database,
  record: ReserveSyncDeferredRecord,
): D1PreparedStatement {
  const metadata = JSON.stringify({ failureCategory: record.reason });
  return db
    .prepare(
      `INSERT INTO reserve_sync_state (
         stablecoin_id,
         adapter_key,
         breaker_key,
         last_attempted_at,
         last_success_at,
         last_status,
         warning_count,
         warnings,
         last_error,
         metadata,
         last_attempt_id,
         pending_attempt_id,
         last_success_attempt_id
       ) VALUES (?, ?, ?, ?, NULL, 'skipped', 0, NULL, ?, ?, NULL, NULL, NULL)
       ON CONFLICT(stablecoin_id) DO UPDATE SET
         adapter_key = excluded.adapter_key,
         breaker_key = excluded.breaker_key,
         last_attempted_at = excluded.last_attempted_at,
         last_status = 'skipped',
         warning_count = 0,
         warnings = NULL,
         last_error = excluded.last_error,
         metadata = excluded.metadata,
         last_attempt_id = NULL,
         pending_attempt_id = NULL
       WHERE NOT EXISTS (
         SELECT 1
           FROM reserve_composition c
          WHERE c.stablecoin_id = reserve_sync_state.stablecoin_id
            AND c.fetched_at = reserve_sync_state.last_success_at
            AND reserve_sync_state.last_status IN ('ok', 'degraded')
            AND reserve_sync_state.pending_attempt_id IS NULL
            AND (
              (
                ${authoritativeSnapshotPredicate("reserve_sync_state")}
              )
              OR (
                c.attempt_id IS NULL
                AND reserve_sync_state.last_attempt_id IS NULL
                AND reserve_sync_state.last_success_attempt_id IS NULL
                AND reserve_sync_state.last_attempted_at = reserve_sync_state.last_success_at
              )
            )
       )`,
    )
    .bind(
      record.stablecoinId,
      record.adapterKey,
      record.breakerKey,
      record.attemptedAt,
      record.reason,
      metadata,
    );
}
