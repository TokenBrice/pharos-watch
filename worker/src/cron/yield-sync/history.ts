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

const OWNERSHIP_HANDOFF_DELETE_CHUNK_ROWS = 5_000;
const OWNERSHIP_HANDOFF_DELETE_MAX_ROWS_PER_RUN = 250_000;

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
  let remainingBudget = OWNERSHIP_HANDOFF_DELETE_MAX_ROWS_PER_RUN;
  for (const [stablecoinId, sourceKeys] of Object.entries(YIELD_HISTORY_OWNERSHIP_HANDOFFS)) {
    const inClause = buildInClause(sourceKeys);
    while (remainingBudget > 0) {
      const chunkRows = Math.min(OWNERSHIP_HANDOFF_DELETE_CHUNK_ROWS, remainingBudget);
      const result = await db
        .prepare(
          `/* pharos:yield-sync:ownership-handoff-delete */
           DELETE FROM yield_history
           WHERE rowid IN (
             SELECT rowid
               FROM yield_history
              WHERE stablecoin_id = ?
                AND (source_key IS NULL OR source_key = ? OR source_key IN (${inClause.sql}))
              LIMIT ?
           )`,
        )
        .bind(stablecoinId, LEGACY_BEST_YIELD_SOURCE_KEY, ...inClause.binds, chunkRows)
        .run();
      const changed = Number(result.meta?.changes ?? 0);
      if (!Number.isFinite(changed) || changed <= 0) break;
      remainingBudget -= changed;
    }
    // materializeYieldHistoryDaily copies handed-off rows into the daily tier
    // before this purge runs, so the same key set must be deleted there too or
    // de-registering a handoff re-exposes a year of suppressed rows.
    await db
      .prepare(
        `/* pharos:yield-sync:ownership-handoff-daily-delete */
         DELETE FROM yield_history_daily
         WHERE stablecoin_id = ?
           AND (source_key = ? OR source_key IN (${inClause.sql}))`,
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
  sourceKeysByStablecoin: Map<string, ReadonlySet<string>>;
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

type YieldHistorySourcePair = readonly [stablecoinId: string, sourceKey: string];

function getRequestedSourcePairs(
  stablecoinIds: readonly string[],
  sourceKeysByStablecoin: Map<string, ReadonlySet<string>>,
): YieldHistorySourcePair[] {
  const pairs: YieldHistorySourcePair[] = [];
  for (const stablecoinId of stablecoinIds) {
    for (const sourceKey of sourceKeysByStablecoin.get(stablecoinId) ?? []) {
      pairs.push([stablecoinId, sourceKey]);
    }
  }
  return pairs;
}

function buildSourcePairValues(pairs: readonly YieldHistorySourcePair[]): {
  sql: string;
  binds: string[];
} {
  return {
    sql: pairs.map(() => "(?, ?)").join(", "),
    binds: pairs.flatMap(([stablecoinId, sourceKey]) => [stablecoinId, sourceKey]),
  };
}

async function loadPreviousBestRowsForChunk(
  db: D1Database,
  idChunk: readonly string[],
  startSec: number,
  signal?: AbortSignal,
): Promise<YieldHistorySnapshotRow[]> {
  throwIfAborted(signal);
  const exclusion = buildSuppressedYieldHistoryExclusion("h");
  const inClause = buildInClause(idChunk);
  const result = await db
    .prepare(
      `SELECT /* pharos:yield-sync:previous-best-point */
         stablecoin_id, source_key, recorded_at, is_best, apy, apy_base, source_tvl_usd, data_source, yield_source, yield_type, exchange_rate
       FROM (
         SELECT h.stablecoin_id, h.source_key, h.recorded_at, h.is_best, h.apy, h.apy_base, h.source_tvl_usd, h.data_source, h.yield_source, h.yield_type, h.exchange_rate,
                ROW_NUMBER() OVER (
                  PARTITION BY h.stablecoin_id
                  ORDER BY h.recorded_at DESC, h.rowid DESC
                ) AS row_rank
           FROM yield_history h
          WHERE h.stablecoin_id IN (${inClause.sql})
            AND h.is_best = 1
            AND h.recorded_at < ?
            AND (h.publication_state IS NULL OR h.publication_state = 'published')
            AND ${exclusion.sql}
       )
       WHERE row_rank = 1`,
    )
    .bind(...inClause.binds, startSec, ...exclusion.binds)
    .all<YieldHistorySnapshotRow>();
  const rowById = new Map(
    (result.results ?? [])
      .filter((row) => !isSuppressedYieldHistoryRow(row.stablecoin_id, row.source_key))
      .map((row) => [row.stablecoin_id, row]),
  );
  return idChunk.flatMap((stablecoinId) => {
    const row = rowById.get(stablecoinId);
    return row ? [row] : [];
  });
}

export async function loadYieldHistorySnapshots(
  db: D1Database,
  resolvedIds: string[],
  startSec: number,
  sevenDaysAgoSec: number,
  options: LoadYieldHistorySnapshotOptions,
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
    const requestedPairs = getRequestedSourcePairs(idChunk, options.sourceKeysByStablecoin);
    const historyPairChunkSize = Math.max(
      1,
      Math.floor(
        (D1_MAX_BOUND_PARAMETERS - resolvedIdInClause.binds.length - 1) / 2,
      ),
    );
    const historyPairChunks =
      requestedPairs.length > 0
        ? chunkArray(requestedPairs, historyPairChunkSize)
        : [[] as YieldHistorySourcePair[]];
    const historyChunkRows: YieldHistorySnapshotRow[] = [];
    const historyRowKeys = new Set<string>();

    for (const pairChunk of historyPairChunks) {
      const pairValues = buildSourcePairValues(pairChunk);
      const requestedSourceClause =
        pairChunk.length > 0
          ? `OR (h.stablecoin_id, h.source_key) IN (VALUES ${pairValues.sql})`
          : "";
      const historyResult = await db
        .prepare(
          `SELECT /* pharos:yield-sync:history-window */
             h.stablecoin_id, h.source_key, h.recorded_at, h.is_best, h.apy, h.apy_base, h.source_tvl_usd, h.data_source, h.yield_source, h.yield_type, h.exchange_rate
           FROM yield_history h
           WHERE h.stablecoin_id IN (${resolvedIdInClause.sql})
             AND h.recorded_at >= ?
             AND (h.publication_state IS NULL OR h.publication_state = 'published')
             AND (h.is_best = 1 ${requestedSourceClause})
           ORDER BY h.stablecoin_id ASC, h.recorded_at ASC`,
        )
        .bind(
          ...resolvedIdInClause.binds,
          startSec - THIRTY_DAYS_SECONDS,
          ...pairValues.binds,
        )
        .all<YieldHistorySnapshotRow>();
      for (const row of historyResult.results ?? []) {
        if (isSuppressedYieldHistoryRow(row.stablecoin_id, row.source_key)) continue;
        const rowKey = `${row.stablecoin_id}\0${row.source_key ?? ""}\0${row.recorded_at}`;
        if (historyRowKeys.has(rowKey)) continue;
        historyRowKeys.add(rowKey);
        historyChunkRows.push(row);
      }
    }
    throwIfAborted(options.signal);
    await yieldToEventLoop(options.signal);

    const prevTvlChunkRows: YieldHistorySnapshotRow[] = [];
    if (!previousTvlRowsTruncated && requestedPairs.length > 0) {
      const currentExclusion = buildSuppressedYieldHistoryExclusion("h");
      const previousTvlPairChunkSize = Math.max(
        1,
        Math.floor(
          (D1_MAX_BOUND_PARAMETERS - currentExclusion.binds.length - 2) / 2,
        ),
      );
      for (const pairChunk of chunkArray(requestedPairs, previousTvlPairChunkSize)) {
        const pairValues = buildSourcePairValues(pairChunk);
        const remainingPreviousTvlRows = Math.max(
          0,
          maxPreviousTvlRows - prevTvlRows.length - prevTvlChunkRows.length,
        );
        const prevTvlResult = await db
          .prepare(
            `SELECT /* pharos:yield-sync:previous-tvl */
               stablecoin_id, source_key, source_tvl_usd, recorded_at
             FROM (
               SELECT h.stablecoin_id, h.source_key, h.source_tvl_usd, h.recorded_at,
                      ROW_NUMBER() OVER (
                        PARTITION BY h.stablecoin_id, h.source_key
                        ORDER BY h.recorded_at DESC, h.rowid DESC
                      ) AS row_rank
                 FROM yield_history h
                WHERE (h.stablecoin_id, h.source_key) IN (VALUES ${pairValues.sql})
                  AND h.recorded_at <= ?
                  AND h.source_tvl_usd IS NOT NULL
                  AND (h.publication_state IS NULL OR h.publication_state = 'published')
                  AND ${currentExclusion.sql}
             )
            WHERE row_rank = 1
            ORDER BY stablecoin_id ASC, source_key ASC
            LIMIT ?`,
          )
          .bind(
            ...pairValues.binds,
            sevenDaysAgoSec,
            ...currentExclusion.binds,
            remainingPreviousTvlRows + 1,
          )
          .all<YieldHistorySnapshotRow>();
        const filteredRows = (prevTvlResult.results ?? []).filter(
          (row) => !isSuppressedYieldHistoryRow(row.stablecoin_id, row.source_key),
        );
        appendRows(
          prevTvlChunkRows,
          filteredRows.slice(0, remainingPreviousTvlRows),
        );
        if (filteredRows.length > remainingPreviousTvlRows) {
          previousTvlRowsTruncated = true;
          break;
        }
      }
    }
    throwIfAborted(options.signal);
    await yieldToEventLoop(options.signal);

    const prevBestChunkRows = await loadPreviousBestRowsForChunk(
      db,
      idChunk,
      startSec,
      options.signal,
    );

    appendRows(historyRows, historyChunkRows);
    appendRows(prevTvlRows, prevTvlChunkRows);
    appendRows(prevBestRows, prevBestChunkRows);
    await reportProgress(
      chunkIndex + 1,
      Math.min(resolvedIds.length, (chunkIndex + 1) * chunkSize),
    );
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
