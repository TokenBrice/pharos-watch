import { THIRTY_DAYS_SECONDS } from "@shared/lib/time-constants";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { buildInClause, D1_MAX_BOUND_PARAMETERS } from "../../lib/db";
import { chunkArray } from "../../lib/collections";
import { throwIfAborted, yieldToEventLoop as defaultYieldToEventLoop } from "../../lib/abort";
import {
  isSuppressedYieldHistoryRow,
  LEGACY_BEST_YIELD_SOURCE_KEY,
  YIELD_HISTORY_OWNERSHIP_HANDOFFS,
} from "../../lib/yield-history-ownership-handoffs";

const D1_SAFE_SQL_IN_CHUNK_SIZE = 90;
const STALE_YIELD_DELETE_FIXED_BIND_COUNT = 1;
const YIELD_HISTORY_LOAD_CHUNK_SIZE = 30;
export const MAX_PREVIOUS_TVL_HISTORY_ROWS = 5_000;

function getStaleYieldDeleteChunkSize(frozenIdCount: number): number {
  return Math.max(
    1,
    Math.min(
      D1_SAFE_SQL_IN_CHUNK_SIZE,
      D1_MAX_BOUND_PARAMETERS - STALE_YIELD_DELETE_FIXED_BIND_COUNT - frozenIdCount,
    ),
  );
}

export async function purgeYieldHistoryOwnershipHandoffs(db: D1Database): Promise<void> {
  for (const [stablecoinId, sourceKeys] of Object.entries(YIELD_HISTORY_OWNERSHIP_HANDOFFS)) {
    const inClause = buildInClause(sourceKeys);
    await db
      .prepare(
        `/* pharos:yield-sync:ownership-handoff-delete */
         DELETE FROM yield_history
         WHERE stablecoin_id = ?
           AND (source_key IS NULL OR source_key = ? OR source_key IN (${inClause.sql}))`,
      )
      .bind(stablecoinId, LEGACY_BEST_YIELD_SOURCE_KEY, ...inClause.binds)
      .run();
  }
}

export interface YieldHistorySnapshotRow {
  stablecoin_id: string;
  source_key: string | null;
  recorded_at: number;
  is_best: number | null;
  apy: number;
  apy_base?: number | null;
  source_tvl_usd: number | null;
  data_source: string;
  yield_source: string | null;
  yield_type: string | null;
  exchange_rate?: number | null;
}

export interface YieldHistorySnapshotProgress {
  chunksDone: number;
  chunksTotal: number;
  resolvedIdsDone: number;
  resolvedIdsTotal: number;
  historyRows: number;
  prevTvlRows: number;
  prevBestRows: number;
  previousTvlRowsTruncated: boolean;
}

export interface LoadYieldHistorySnapshotOptions {
  signal?: AbortSignal;
  chunkSize?: number;
  yieldToEventLoop?: (signal?: AbortSignal) => Promise<void>;
  onProgress?: (progress: YieldHistorySnapshotProgress) => void | Promise<void>;
  sourceKeysByStablecoin?: Map<string, ReadonlySet<string>>;
  maxPreviousTvlRows?: number;
}

function appendRows<T>(target: T[], rows: readonly T[]): void {
  for (const row of rows) {
    target.push(row);
  }
}

function buildSuppressedYieldHistoryExclusion(alias: string): { sql: string; binds: unknown[] } {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  for (const [stablecoinId, sourceKeys] of Object.entries(YIELD_HISTORY_OWNERSHIP_HANDOFFS)) {
    const inClause = buildInClause(sourceKeys);
    clauses.push(
      `NOT (${alias}.stablecoin_id = ? AND (${alias}.source_key IS NULL OR ${alias}.source_key = ? OR ${alias}.source_key IN (${inClause.sql})))`,
    );
    binds.push(stablecoinId, LEGACY_BEST_YIELD_SOURCE_KEY, ...inClause.binds);
  }
  return clauses.length > 0 ? { sql: clauses.join(" AND "), binds } : { sql: "1 = 1", binds: [] };
}

function getRequestedSourceKeys(
  stablecoinId: string,
  sourceKeysByStablecoin: Map<string, ReadonlySet<string>> | undefined,
): readonly string[] {
  if (!sourceKeysByStablecoin) return [];
  const sourceKeys = sourceKeysByStablecoin.get(stablecoinId);
  return sourceKeys ? [...sourceKeys] : [];
}

async function loadPreviousTvlRowsForChunk(
  db: D1Database,
  idChunk: readonly string[],
  sevenDaysAgoSec: number,
  sourceKeysByStablecoin: Map<string, ReadonlySet<string>> | undefined,
  maxRows: number,
  signal?: AbortSignal,
): Promise<{ rows: YieldHistorySnapshotRow[]; truncated: boolean }> {
  if (!sourceKeysByStablecoin || maxRows <= 0) return { rows: [], truncated: false };
  const rows: YieldHistorySnapshotRow[] = [];
  const exclusion = buildSuppressedYieldHistoryExclusion("h");
  let truncated = false;

  outer:
  for (const stablecoinId of idChunk) {
    for (const sourceKey of getRequestedSourceKeys(stablecoinId, sourceKeysByStablecoin)) {
      if (rows.length >= maxRows) {
        truncated = true;
        break outer;
      }
      throwIfAborted(signal);
      const result = await db
        .prepare(
          `SELECT /* pharos:yield-sync:previous-tvl-point */
             h.stablecoin_id, h.source_key, h.source_tvl_usd, h.recorded_at
           FROM yield_history h
           WHERE h.stablecoin_id = ?
             AND h.source_key = ?
             AND h.recorded_at <= ?
             AND h.source_tvl_usd IS NOT NULL
             AND (h.publication_state IS NULL OR h.publication_state = 'published')
             AND ${exclusion.sql}
           ORDER BY h.recorded_at DESC, h.rowid DESC
           LIMIT 1`,
        )
        .bind(stablecoinId, sourceKey, sevenDaysAgoSec, ...exclusion.binds)
        .all<YieldHistorySnapshotRow>();
      const row = result.results?.[0] ?? null;
      if (row && !isSuppressedYieldHistoryRow(row.stablecoin_id, row.source_key)) {
        rows.push(row);
      }
    }
    throwIfAborted(signal);
  }

  return { rows, truncated };
}

async function loadPreviousBestRowsForChunk(
  db: D1Database,
  idChunk: readonly string[],
  startSec: number,
  signal?: AbortSignal,
): Promise<YieldHistorySnapshotRow[]> {
  const rows: YieldHistorySnapshotRow[] = [];
  const exclusion = buildSuppressedYieldHistoryExclusion("h");

  for (const stablecoinId of idChunk) {
    throwIfAborted(signal);
    const result = await db
      .prepare(
        `SELECT /* pharos:yield-sync:previous-best-point */
           h.stablecoin_id, h.source_key, h.recorded_at, h.is_best, h.apy, h.apy_base, h.source_tvl_usd, h.data_source, h.yield_source, h.yield_type, h.exchange_rate
         FROM yield_history h
         WHERE h.stablecoin_id = ?
           AND h.is_best = 1
           AND h.recorded_at < ?
           AND (h.publication_state IS NULL OR h.publication_state = 'published')
           AND ${exclusion.sql}
         ORDER BY h.recorded_at DESC, h.rowid DESC
         LIMIT 1`,
      )
      .bind(stablecoinId, startSec, ...exclusion.binds)
      .all<YieldHistorySnapshotRow>();
    const row = result.results?.[0] ?? null;
    if (row && !isSuppressedYieldHistoryRow(row.stablecoin_id, row.source_key)) {
      rows.push(row);
    }
  }

  return rows;
}

export async function loadYieldHistorySnapshots(
  db: D1Database,
  resolvedIds: string[],
  startSec: number,
  sevenDaysAgoSec: number,
  options: LoadYieldHistorySnapshotOptions = {},
): Promise<{
  historyRows: YieldHistorySnapshotRow[];
  prevTvlRows: YieldHistorySnapshotRow[];
  prevBestRows: YieldHistorySnapshotRow[];
  previousTvlRowsTruncated: boolean;
}> {
  const historyRows: YieldHistorySnapshotRow[] = [];
  const prevTvlRows: YieldHistorySnapshotRow[] = [];
  const prevBestRows: YieldHistorySnapshotRow[] = [];

  const chunkSize = Math.max(
    1,
    Math.min(options.chunkSize ?? YIELD_HISTORY_LOAD_CHUNK_SIZE, D1_SAFE_SQL_IN_CHUNK_SIZE),
  );
  const maxPreviousTvlRows = Math.max(1, Math.floor(options.maxPreviousTvlRows ?? MAX_PREVIOUS_TVL_HISTORY_ROWS));
  let previousTvlRowsTruncated = false;
  const idChunks = chunkArray(resolvedIds, chunkSize);
  const yieldToEventLoop = options.yieldToEventLoop ?? defaultYieldToEventLoop;

  const reportProgress = async (chunksDone: number, resolvedIdsDone: number) => {
    await options.onProgress?.({
      chunksDone,
      chunksTotal: idChunks.length,
      resolvedIdsDone,
      resolvedIdsTotal: resolvedIds.length,
      historyRows: historyRows.length,
      prevTvlRows: prevTvlRows.length,
      prevBestRows: prevBestRows.length,
      previousTvlRowsTruncated,
    });
  };

  await reportProgress(0, 0);

  for (const [chunkIndex, idChunk] of idChunks.entries()) {
    throwIfAborted(options.signal);
    const resolvedIdInClause = buildInClause(idChunk);
    const currentExclusion = buildSuppressedYieldHistoryExclusion("h");
    const newerExclusion = buildSuppressedYieldHistoryExclusion("newer");
    const historyResult = await db
      .prepare(
        `SELECT /* pharos:yield-sync:history-window */
           stablecoin_id, source_key, recorded_at, is_best, apy, apy_base, source_tvl_usd, data_source, yield_source, yield_type, exchange_rate
         FROM yield_history
         WHERE stablecoin_id IN (${resolvedIdInClause.sql})
           AND recorded_at >= ?
           AND (publication_state IS NULL OR publication_state = 'published')
         ORDER BY stablecoin_id ASC, recorded_at ASC`,
      )
      .bind(...resolvedIdInClause.binds, startSec - THIRTY_DAYS_SECONDS)
      .all<YieldHistorySnapshotRow>();
    throwIfAborted(options.signal);
    await yieldToEventLoop(options.signal);

    const remainingPreviousTvlRows = Math.max(0, maxPreviousTvlRows - prevTvlRows.length);
    if (remainingPreviousTvlRows === 0 && chunkIndex < idChunks.length) {
      previousTvlRowsTruncated = true;
    }
    let prevTvlChunkRows: YieldHistorySnapshotRow[] = [];
    if (remainingPreviousTvlRows > 0 && options.sourceKeysByStablecoin) {
      const prevTvlResult = await loadPreviousTvlRowsForChunk(
        db,
        idChunk,
        sevenDaysAgoSec,
        options.sourceKeysByStablecoin,
        remainingPreviousTvlRows,
        options.signal,
      );
      prevTvlChunkRows = prevTvlResult.rows;
      previousTvlRowsTruncated ||= prevTvlResult.truncated;
    } else if (remainingPreviousTvlRows > 0) {
      const prevTvlResult = await db
        .prepare(
          `SELECT /* pharos:yield-sync:previous-tvl */
             h.stablecoin_id, h.source_key, h.source_tvl_usd, h.recorded_at
           FROM yield_history h
           WHERE h.stablecoin_id IN (${resolvedIdInClause.sql})
             AND h.recorded_at <= ?
             AND h.source_tvl_usd IS NOT NULL
             AND (h.publication_state IS NULL OR h.publication_state = 'published')
             AND ${currentExclusion.sql}
             AND NOT EXISTS (
               SELECT 1
               FROM yield_history newer
               WHERE newer.stablecoin_id = h.stablecoin_id
                 AND newer.source_key = h.source_key
                 AND newer.recorded_at <= ?
                 AND newer.source_tvl_usd IS NOT NULL
                 AND (newer.publication_state IS NULL OR newer.publication_state = 'published')
                 AND ${newerExclusion.sql}
                 AND (
                   newer.recorded_at > h.recorded_at
                   OR (newer.recorded_at = h.recorded_at AND newer.rowid > h.rowid)
                 )
             )
           ORDER BY h.stablecoin_id ASC, h.source_key ASC, h.recorded_at DESC
           LIMIT ?`,
        )
        .bind(
          ...resolvedIdInClause.binds,
          sevenDaysAgoSec,
          ...currentExclusion.binds,
          sevenDaysAgoSec,
          ...newerExclusion.binds,
          remainingPreviousTvlRows + 1,
        )
        .all<YieldHistorySnapshotRow>();
      const filteredPrevTvlRows = (prevTvlResult.results ?? []).filter(
        (row) => !isSuppressedYieldHistoryRow(row.stablecoin_id, row.source_key),
      );
      if (filteredPrevTvlRows.length > remainingPreviousTvlRows) {
        previousTvlRowsTruncated = true;
      }
      prevTvlChunkRows = filteredPrevTvlRows.slice(0, remainingPreviousTvlRows);
    }
    throwIfAborted(options.signal);
    await yieldToEventLoop(options.signal);

    const prevBestChunkRows = await loadPreviousBestRowsForChunk(db, idChunk, startSec, options.signal);

    appendRows(
      historyRows,
      (historyResult.results ?? []).filter((row) => !isSuppressedYieldHistoryRow(row.stablecoin_id, row.source_key)),
    );
    appendRows(prevTvlRows, prevTvlChunkRows);
    appendRows(prevBestRows, prevBestChunkRows);
    await reportProgress(chunkIndex + 1, Math.min(resolvedIds.length, (chunkIndex + 1) * chunkSize));
    await yieldToEventLoop(options.signal);
  }

  return { historyRows, prevTvlRows, prevBestRows, previousTvlRowsTruncated };
}

export async function deleteStaleYieldRows(db: D1Database, managedYieldIds: string[], startSec: number): Promise<void> {
  const frozenIdsList = [...FROZEN_IDS];
  const frozenClause =
    frozenIdsList.length > 0 ? `AND stablecoin_id NOT IN (${frozenIdsList.map(() => "?").join(",")})` : "";
  const chunkSize = getStaleYieldDeleteChunkSize(frozenIdsList.length);
  for (const idChunk of chunkArray(managedYieldIds, chunkSize)) {
    const staleRowInClause = buildInClause(idChunk);
    await db
      .prepare(
        `/* pharos:yield-sync:stale-yield-data-delete */
         DELETE FROM yield_data
         WHERE stablecoin_id IN (${staleRowInClause.sql}) AND updated_at < ? ${frozenClause}`,
      )
      .bind(...staleRowInClause.binds, startSec, ...frozenIdsList)
      .run();
  }
}

export async function deleteOrphanYieldRows(db: D1Database, managedYieldIds: string[]): Promise<void> {
  const managedYieldIdSet = new Set(managedYieldIds);
  const existingIds = await db
    .prepare("SELECT /* pharos:yield-sync:yield-data-existing-ids */ DISTINCT stablecoin_id FROM yield_data")
    .all<{ stablecoin_id: string }>();
  const orphanIds = (existingIds.results ?? [])
    .map((row) => row.stablecoin_id)
    .filter((id) => !managedYieldIdSet.has(id) && !FROZEN_IDS.has(id));

  for (const idChunk of chunkArray(orphanIds, D1_SAFE_SQL_IN_CHUNK_SIZE)) {
    const orphanInClause = buildInClause(idChunk);
    await db
      .prepare(
        `/* pharos:yield-sync:orphan-yield-data-delete */
         DELETE FROM yield_data
         WHERE stablecoin_id IN (${orphanInClause.sql})`,
      )
      .bind(...orphanInClause.binds)
      .run();
  }
}
