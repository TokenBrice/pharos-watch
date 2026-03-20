import { THIRTY_DAYS_SECONDS } from "@shared/lib/time-constants";
import { buildInClause } from "../../lib/db";
import { chunkArray } from "../../lib/collections";

const D1_SAFE_SQL_IN_CHUNK_SIZE = 90;

export interface YieldHistorySnapshotRow {
  stablecoin_id: string;
  source_key: string | null;
  recorded_at: number;
  is_best: number | null;
  apy: number;
  source_tvl_usd: number | null;
  data_source: string;
  yield_source: string | null;
  yield_type: string | null;
  exchange_rate?: number | null;
}

export async function loadYieldHistorySnapshots(
  db: D1Database,
  resolvedIds: string[],
  startSec: number,
  sevenDaysAgoSec: number,
): Promise<{
  historyRows: YieldHistorySnapshotRow[];
  prevTvlRows: YieldHistorySnapshotRow[];
  prevBestRows: YieldHistorySnapshotRow[];
}> {
  const historyRows: YieldHistorySnapshotRow[] = [];
  const prevTvlRows: YieldHistorySnapshotRow[] = [];
  const prevBestRows: YieldHistorySnapshotRow[] = [];

  for (const idChunk of chunkArray(resolvedIds, D1_SAFE_SQL_IN_CHUNK_SIZE)) {
    const resolvedIdInClause = buildInClause(idChunk);
    const [historyResult, prevTvlResult, prevBestResult] = await Promise.all([
      db
        .prepare(
          `SELECT stablecoin_id, source_key, recorded_at, is_best, apy, source_tvl_usd, data_source, yield_source, yield_type, exchange_rate
           FROM yield_history
           WHERE stablecoin_id IN (${resolvedIdInClause.sql}) AND recorded_at >= ?
           ORDER BY stablecoin_id ASC, recorded_at ASC`,
        )
        .bind(...resolvedIdInClause.binds, startSec - THIRTY_DAYS_SECONDS)
        .all<YieldHistorySnapshotRow>(),
      db
        .prepare(
          `SELECT stablecoin_id, source_key, source_tvl_usd, recorded_at
           FROM yield_history
           WHERE stablecoin_id IN (${resolvedIdInClause.sql}) AND recorded_at <= ? AND source_tvl_usd IS NOT NULL
           ORDER BY stablecoin_id ASC, source_key ASC, recorded_at DESC`,
        )
        .bind(...resolvedIdInClause.binds, sevenDaysAgoSec)
        .all<YieldHistorySnapshotRow>(),
      db
        .prepare(
          `SELECT stablecoin_id, source_key, recorded_at, is_best, apy, source_tvl_usd, data_source, yield_source, yield_type, exchange_rate
           FROM yield_history
           WHERE stablecoin_id IN (${resolvedIdInClause.sql}) AND is_best = 1 AND recorded_at < ?
           ORDER BY stablecoin_id ASC, recorded_at DESC`,
        )
        .bind(...resolvedIdInClause.binds, startSec)
        .all<YieldHistorySnapshotRow>(),
    ]);

    historyRows.push(...(historyResult.results ?? []));
    prevTvlRows.push(...(prevTvlResult.results ?? []));
    prevBestRows.push(...(prevBestResult.results ?? []));
  }

  return { historyRows, prevTvlRows, prevBestRows };
}

export async function deleteStaleYieldRows(
  db: D1Database,
  managedYieldIds: string[],
  startSec: number,
): Promise<void> {
  for (const idChunk of chunkArray(managedYieldIds, D1_SAFE_SQL_IN_CHUNK_SIZE)) {
    const staleRowInClause = buildInClause(idChunk);
    await db
      .prepare(
        `DELETE FROM yield_data
         WHERE stablecoin_id IN (${staleRowInClause.sql}) AND updated_at < ?`,
      )
      .bind(...staleRowInClause.binds, startSec)
      .run();
  }
}

export async function deleteOrphanYieldRows(
  db: D1Database,
  managedYieldIds: string[],
): Promise<void> {
  const managedYieldIdSet = new Set(managedYieldIds);
  const existingIds = await db
    .prepare("SELECT DISTINCT stablecoin_id FROM yield_data")
    .all<{ stablecoin_id: string }>();
  const orphanIds = (existingIds.results ?? [])
    .map((row) => row.stablecoin_id)
    .filter((id) => !managedYieldIdSet.has(id));

  for (const idChunk of chunkArray(orphanIds, D1_SAFE_SQL_IN_CHUNK_SIZE)) {
    const orphanInClause = buildInClause(idChunk);
    await db
      .prepare(
        `DELETE FROM yield_data
         WHERE stablecoin_id IN (${orphanInClause.sql})`,
      )
      .bind(...orphanInClause.binds)
      .run();
  }
}
