import type {
  ReserveCompositionRecord,
  ReserveSyncAttemptHistoryRecord,
  ReserveSyncAttemptStartRecord,
  ReserveSyncStateRecord,
} from "./live-reserves-store-shared";
import {
  RESERVE_COMPOSITION_CONFLICT_ASSIGNMENTS,
  RESERVE_COMPOSITION_INSERT_COLUMNS,
} from "./live-reserves-store-shared";

const SQLITE_NOW_MS_EXPRESSION = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

const serializeWarnings = (w: readonly unknown[]): string | null => (w.length > 0 ? JSON.stringify(w) : null);

const HISTORY_TARGETS = {
  composition: {
    table: "reserve_composition_history",
    columns: ["stablecoin_id", "fetched_at", "adapter_key", "attempt_id", "slices", "metadata", "warnings",
      "warning_count", "adapter_source_model", "adapter_evidence_class"],
    insertValues: (record: ReserveCompositionRecord) => [
      record.stablecoinId, record.fetchedAt, record.source, record.attemptId ?? null,
      JSON.stringify(record.slices), JSON.stringify(record.metadata), serializeWarnings(record.warnings),
      record.warningCount, record.adapterSourceModel, record.adapterEvidenceClass],
    repairProjection: [
      "c.stablecoin_id", "c.fetched_at", "c.source", "c.attempt_id", "c.slices", "c.metadata",
      "c.warnings", "c.warning_count", "c.adapter_source_model", "c.adapter_evidence_class"],
  },
  attempt: {
    table: "reserve_sync_attempt_history",
    columns: ["stablecoin_id", "attempted_at", "adapter_key", "breaker_key", "attempt_id", "status",
      "warnings", "warning_count", "last_error", "metadata"],
    insertValues: (record: ReserveSyncAttemptHistoryRecord) => [
      record.stablecoinId, record.attemptedAt, record.adapterKey, record.breakerKey,
      record.attemptId ?? null, record.status, serializeWarnings(record.warnings), record.warningCount,
      record.lastError, JSON.stringify(record.metadata)],
    repairProjection: [
      "s.stablecoin_id", "COALESCE(s.last_attempted_at, c.fetched_at)", "s.adapter_key", "s.breaker_key",
      "c.attempt_id", "s.last_status", "s.warnings", "s.warning_count", "s.last_error", "s.metadata"],
  },
} as const;

type HistoryTarget = (typeof HISTORY_TARGETS)[keyof typeof HISTORY_TARGETS];

const AUTHORITATIVE_HISTORY_SOURCE = `FROM reserve_composition c
         JOIN reserve_sync_state s
           ON s.stablecoin_id = c.stablecoin_id
        WHERE c.stablecoin_id = ?
          AND c.attempt_id = ?
          AND s.last_success_at = c.fetched_at
          AND s.last_attempt_id = c.attempt_id
          AND s.last_success_attempt_id = c.attempt_id
          AND s.pending_attempt_id IS NULL`;
const AUTHORITATIVE_ATTEMPT_READBACK_SOURCE = AUTHORITATIVE_HISTORY_SOURCE.replaceAll("\n", "\n  ");

function buildHistoryInsertStatement(
  db: D1Database,
  target: HistoryTarget,
  values: unknown[],
): D1PreparedStatement {
  return db.prepare(
    `INSERT OR IGNORE INTO ${target.table} (
         ${target.columns.join(",\n         ")}
       ) VALUES (${values.map(() => "?").join(", ")})`,
  ).bind(...values);
}

function buildHistoryRepairStatement(
  db: D1Database,
  target: HistoryTarget,
  stablecoinId: string,
  attemptId: string,
): D1PreparedStatement {
  return db.prepare(
    `INSERT OR IGNORE INTO ${target.table} (
         ${target.columns.join(",\n         ")}
       )
       SELECT ${target.repairProjection.join(",\n              ")}
         ${AUTHORITATIVE_HISTORY_SOURCE}`,
  ).bind(stablecoinId, attemptId);
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
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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

export const buildReserveCompositionHistoryInsertStatement = (db: D1Database, record: ReserveCompositionRecord) =>
  buildHistoryInsertStatement(db, HISTORY_TARGETS.composition, HISTORY_TARGETS.composition.insertValues(record));

export const buildReserveSyncAttemptHistoryInsertStatement = (db: D1Database, record: ReserveSyncAttemptHistoryRecord) =>
  buildHistoryInsertStatement(db, HISTORY_TARGETS.attempt, HISTORY_TARGETS.attempt.insertValues(record));

export const buildReserveCompositionHistoryRepairStatement = (db: D1Database, stablecoinId: string, attemptId: string) =>
  buildHistoryRepairStatement(db, HISTORY_TARGETS.composition, stablecoinId, attemptId);

export const buildReserveSyncAttemptHistoryRepairStatement = (db: D1Database, stablecoinId: string, attemptId: string) =>
  buildHistoryRepairStatement(db, HISTORY_TARGETS.attempt, stablecoinId, attemptId);

export function buildReserveAuthoritativeHistoryRepairReadbackStatement(
  db: D1Database,
  stablecoinId: string,
  attemptId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT 1 AS repaired
         ${AUTHORITATIVE_HISTORY_SOURCE}
          AND EXISTS (
            SELECT 1
              FROM reserve_composition_history ch
             WHERE ch.stablecoin_id = c.stablecoin_id
               AND ch.attempt_id = c.attempt_id
          )
          AND EXISTS (
            SELECT 1
              FROM reserve_sync_attempt_history ah
             WHERE ah.stablecoin_id = c.stablecoin_id
               AND ah.attempt_id = c.attempt_id
          )
        LIMIT 1`,
    )
    .bind(stablecoinId, attemptId);
}

export function buildReserveAttemptAuthoritativeReadbackStatement(
  db: D1Database,
  stablecoinId: string,
  attemptId: string,
): D1PreparedStatement {
  return db.prepare(
    `SELECT 1 AS finalized
           ${AUTHORITATIVE_ATTEMPT_READBACK_SOURCE}
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
         FROM reserve_composition c
         JOIN reserve_sync_state s
           ON s.stablecoin_id = c.stablecoin_id
        WHERE c.stablecoin_id = ?
          AND c.fetched_at = ?
          AND c.attempt_id = ?
          AND s.last_success_at = c.fetched_at
          AND s.last_attempt_id = c.attempt_id
          AND s.last_success_attempt_id = c.attempt_id
          AND s.pending_attempt_id IS NULL
        LIMIT 1`,
    )
    .bind(stablecoinId, fetchedAt, attemptId);
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
         last_success_attempt_id
       ) VALUES (?, ?, ?, ?, NULL, 'skipped', 0, NULL, NULL, '{}', ?, ?, NULL)
       ON CONFLICT(stablecoin_id) DO UPDATE SET
         adapter_key = excluded.adapter_key,
         breaker_key = excluded.breaker_key,
         last_attempted_at = excluded.last_attempted_at,
         last_attempt_id = excluded.last_attempt_id,
         pending_attempt_id = excluded.pending_attempt_id`,
    )
    .bind(
      record.stablecoinId,
      record.adapterKey,
      record.breakerKey,
      record.attemptedAt,
      record.attemptId,
      record.attemptId,
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
             last_success_attempt_id = ?
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
             pending_attempt_id = NULL
       WHERE stablecoin_id = ?
         AND last_attempt_id = ?
         AND pending_attempt_id = ?`,
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
      record.stablecoinId,
      record.lastAttemptId ?? null,
      record.pendingAttemptId ?? null,
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
                c.attempt_id IS NOT NULL
                AND reserve_sync_state.last_attempt_id = c.attempt_id
                AND reserve_sync_state.last_success_attempt_id = c.attempt_id
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
