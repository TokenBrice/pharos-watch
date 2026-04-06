import { buildInClause } from "./db";
import { chunkArray } from "./collections";
import {
  parseReserveCompositionRow,
  parseSnapshotMetadata,
  parseWarnings,
} from "./live-reserves-store-parsing";
import {
  RESERVE_SYNC_STATE_SELECT_COLUMNS,
  type ReserveCompositionRecord,
  type ReserveCompositionRow,
  type ReserveSyncStateRecord,
  type ReserveSyncStateRow,
} from "./live-reserves-store-shared";

function mapReserveSyncStateRow(row: ReserveSyncStateRow): ReserveSyncStateRecord {
  return {
    stablecoinId: row.stablecoin_id,
    adapterKey: row.adapter_key,
    breakerKey: row.breaker_key,
    lastAttemptedAt: row.last_attempted_at,
    lastSuccessAt: row.last_success_at,
    lastStatus: row.last_status,
    warningCount: row.warning_count,
    warnings: parseWarnings(row.warnings),
    lastError: row.last_error,
    metadata: parseSnapshotMetadata(row.metadata),
    lastAttemptId: row.last_attempt_id ?? null,
    pendingAttemptId: row.pending_attempt_id ?? null,
    lastSuccessAttemptId: row.last_success_attempt_id ?? null,
  };
}

export async function getReserveCompositionRow(
  db: D1Database,
  stablecoinId: string,
): Promise<ReserveCompositionRow | null> {
  return db
    .prepare(
      `SELECT stablecoin_id, slices, fetched_at, source, attempt_id, metadata, warning_count, warnings,
              adapter_source_model, adapter_evidence_class
         FROM reserve_composition
        WHERE stablecoin_id = ?`,
    )
    .bind(stablecoinId)
    .first<ReserveCompositionRow>();
}

export async function getReserveComposition(
  db: D1Database,
  stablecoinId: string,
): Promise<ReserveCompositionRecord | null> {
  const [row, syncState] = await Promise.all([
    getReserveCompositionRow(db, stablecoinId),
    getReserveSyncState(db, stablecoinId),
  ]);
  if (!row) return null;
  return parseReserveCompositionRow(row, syncState).record;
}

export async function getReserveSyncState(
  db: D1Database,
  stablecoinId: string,
): Promise<ReserveSyncStateRecord | null> {
  const row = await db
    .prepare(
      `SELECT ${RESERVE_SYNC_STATE_SELECT_COLUMNS}
         FROM reserve_sync_state
        WHERE stablecoin_id = ?`,
    )
    .bind(stablecoinId)
    .first<ReserveSyncStateRow>();

  if (!row) return null;
  return mapReserveSyncStateRow(row);
}

export async function loadReserveSyncStateMap(
  db: D1Database,
  stablecoinIds: readonly string[],
): Promise<Map<string, ReserveSyncStateRecord>> {
  if (stablecoinIds.length === 0) return new Map();

  const result = new Map<string, ReserveSyncStateRecord>();

  for (const batch of chunkArray(stablecoinIds, 50)) {
    const inClause = buildInClause(batch);
    const rows = await db
      .prepare(
        `SELECT ${RESERVE_SYNC_STATE_SELECT_COLUMNS}
           FROM reserve_sync_state
          WHERE stablecoin_id IN (${inClause.sql})`,
      )
      .bind(...inClause.binds)
      .all<ReserveSyncStateRow>();

    for (const row of rows.results ?? []) {
      result.set(row.stablecoin_id, mapReserveSyncStateRow(row));
    }
  }

  return result;
}

export async function loadReserveCompositionRowMap(
  db: D1Database,
  stablecoinIds: readonly string[],
): Promise<Map<string, ReserveCompositionRow>> {
  if (stablecoinIds.length === 0) return new Map();

  const result = new Map<string, ReserveCompositionRow>();

  for (const batch of chunkArray(stablecoinIds, 50)) {
    const inClause = buildInClause(batch);
    const rows = await db
      .prepare(
        `SELECT stablecoin_id, slices, fetched_at, source, attempt_id, metadata, warning_count, warnings,
                adapter_source_model, adapter_evidence_class
           FROM reserve_composition
          WHERE stablecoin_id IN (${inClause.sql})`,
      )
      .bind(...inClause.binds)
      .all<ReserveCompositionRow>();

    for (const row of rows.results ?? []) {
      result.set(row.stablecoin_id, row);
    }
  }

  return result;
}

export async function getMaxSyncAge(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
): Promise<number> {
  const row = await db
    .prepare("SELECT MAX(last_success_at) AS max_ts FROM reserve_sync_state")
    .first<{ max_ts: number | null }>();
  if (!row?.max_ts) return Infinity;
  return now - row.max_ts;
}
