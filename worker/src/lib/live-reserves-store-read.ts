import { buildInClause } from "./db";
import { chunkArray, D1_SAFE_IN_CLAUSE_BIND_LIMIT } from "./collections";
import {
  parseSnapshotMetadata,
  parseWarnings,
} from "./live-reserves-store-row-decoding";
import {
  RESERVE_COMPOSITION_SELECT_COLUMNS,
  RESERVE_SYNC_STATE_SELECT_COLUMNS,
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
      `SELECT ${RESERVE_COMPOSITION_SELECT_COLUMNS}
         FROM reserve_composition
        WHERE stablecoin_id = ?`,
    )
    .bind(stablecoinId)
    .first<ReserveCompositionRow>();
}

async function loadMapByStablecoinId<Row extends { stablecoin_id: string }, Value>(
  db: D1Database,
  stablecoinIds: readonly string[],
  sqlForInClause: (inClauseSql: string) => string,
  mapRow: (row: Row) => Value,
): Promise<Map<string, Value>> {
  if (stablecoinIds.length === 0) return new Map();

  const result = new Map<string, Value>();

  for (const batch of chunkArray(stablecoinIds, D1_SAFE_IN_CLAUSE_BIND_LIMIT)) {
    const inClause = buildInClause(batch);
    const rows = await db
      .prepare(sqlForInClause(inClause.sql))
      .bind(...inClause.binds)
      .all<Row>();

    for (const row of rows.results ?? []) {
      result.set(row.stablecoin_id, mapRow(row));
    }
  }

  return result;
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
  return loadMapByStablecoinId<ReserveSyncStateRow, ReserveSyncStateRecord>(
    db,
    stablecoinIds,
    (inClauseSql) =>
      `SELECT ${RESERVE_SYNC_STATE_SELECT_COLUMNS}
           FROM reserve_sync_state
          WHERE stablecoin_id IN (${inClauseSql})`,
    mapReserveSyncStateRow,
  );
}

export async function loadReserveCompositionRowMap(
  db: D1Database,
  stablecoinIds: readonly string[],
): Promise<Map<string, ReserveCompositionRow>> {
  return loadMapByStablecoinId<ReserveCompositionRow, ReserveCompositionRow>(
    db,
    stablecoinIds,
    (inClauseSql) =>
      `SELECT ${RESERVE_COMPOSITION_SELECT_COLUMNS}
           FROM reserve_composition
          WHERE stablecoin_id IN (${inClauseSql})`,
    (row) => row,
  );
}

export async function getMaxSyncAge(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
  stablecoinIds?: readonly string[],
): Promise<number> {
  if (stablecoinIds?.length === 0) return Infinity;
  const configuredFilter = stablecoinIds
    ? ` WHERE stablecoin_id IN (${stablecoinIds.map(() => "?").join(", ")})`
    : "";
  const row = await db
    .prepare(
      `SELECT MIN(last_attempted_at) AS oldest_ts,
              COUNT(DISTINCT stablecoin_id) AS observed_count
         FROM reserve_sync_state${configuredFilter}`,
    )
    .bind(...(stablecoinIds ?? []))
    .first<{ oldest_ts: number | null; observed_count: number }>();
  if (stablecoinIds && (row?.observed_count ?? 0) !== new Set(stablecoinIds).size) return Infinity;
  if (!row?.oldest_ts) return Infinity;
  return now - row.oldest_ts;
}
