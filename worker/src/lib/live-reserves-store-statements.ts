import type {
  ReserveCompositionRecord,
  ReserveSyncAttemptHistoryRecord,
  ReserveSyncAttemptStartRecord,
  ReserveSyncStateRecord,
} from "./live-reserves-store-shared";

const SQLITE_NOW_MS_EXPRESSION = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

export function buildReserveCompositionUpsertStatement(
  db: D1Database,
  record: ReserveCompositionRecord,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO reserve_composition (
         stablecoin_id,
         slices,
         fetched_at,
         source,
         attempt_id,
         metadata,
         warning_count,
         warnings,
         adapter_source_model,
         adapter_evidence_class
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(stablecoin_id) DO UPDATE SET
         slices = excluded.slices,
         fetched_at = excluded.fetched_at,
         source = excluded.source,
         attempt_id = excluded.attempt_id,
         metadata = excluded.metadata,
         warning_count = excluded.warning_count,
         warnings = excluded.warnings,
         adapter_source_model = excluded.adapter_source_model,
         adapter_evidence_class = excluded.adapter_evidence_class
       WHERE reserve_composition.fetched_at < excluded.fetched_at
          OR (reserve_composition.fetched_at = excluded.fetched_at AND reserve_composition.attempt_id IS NULL)`,
    )
    .bind(
      record.stablecoinId,
      JSON.stringify(record.slices),
      record.fetchedAt,
      record.source,
      record.attemptId ?? null,
      JSON.stringify(record.metadata),
      record.warningCount,
      record.warnings.length > 0 ? JSON.stringify(record.warnings) : null,
      record.adapterSourceModel,
      record.adapterEvidenceClass,
    );
}

export function buildReserveCompositionHistoryInsertStatement(
  db: D1Database,
  record: ReserveCompositionRecord,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO reserve_composition_history (
         stablecoin_id,
         fetched_at,
         adapter_key,
         attempt_id,
         slices,
         metadata,
         warnings,
         warning_count,
         adapter_source_model,
         adapter_evidence_class
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      record.stablecoinId,
      record.fetchedAt,
      record.source,
      record.attemptId ?? null,
      JSON.stringify(record.slices),
      JSON.stringify(record.metadata),
      record.warnings.length > 0 ? JSON.stringify(record.warnings) : null,
      record.warningCount,
      record.adapterSourceModel,
      record.adapterEvidenceClass,
    );
}

export function buildReserveSyncAttemptHistoryInsertStatement(
  db: D1Database,
  record: ReserveSyncAttemptHistoryRecord,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO reserve_sync_attempt_history (
         stablecoin_id,
         attempted_at,
         adapter_key,
         breaker_key,
         attempt_id,
         status,
         warnings,
         warning_count,
         last_error,
         metadata
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      record.stablecoinId,
      record.attemptedAt,
      record.adapterKey,
      record.breakerKey,
      record.attemptId ?? null,
      record.status,
      record.warnings.length > 0 ? JSON.stringify(record.warnings) : null,
      record.warningCount,
      record.lastError,
      JSON.stringify(record.metadata),
    );
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
         AND ${SQLITE_NOW_MS_EXPRESSION} <= ?`,
    )
    .bind(
      record.adapterKey,
      record.breakerKey,
      record.lastAttemptedAt,
      record.lastSuccessAt,
      record.lastStatus,
      record.warningCount,
      record.warnings.length > 0 ? JSON.stringify(record.warnings) : null,
      record.lastError,
      JSON.stringify(record.metadata),
      record.lastAttemptId ?? null,
      record.lastSuccessAttemptId ?? null,
      record.stablecoinId,
      record.lastAttemptId ?? null,
      record.pendingAttemptId ?? null,
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
      record.warnings.length > 0 ? JSON.stringify(record.warnings) : null,
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
         pending_attempt_id = NULL`,
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
