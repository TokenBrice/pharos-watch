import { THIRTY_DAYS_SECONDS } from "@shared/lib/time-constants";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { buildInClause } from "../../lib/db";
import { chunkArray } from "../../lib/collections";
import { throwIfAborted, yieldToEventLoop as defaultYieldToEventLoop } from "../../lib/abort";
import {
  isSuppressedYieldHistoryRow,
  LEGACY_BEST_YIELD_SOURCE_KEY,
  YIELD_HISTORY_OWNERSHIP_HANDOFFS,
} from "../../lib/yield-history-ownership-handoffs";

export { isSuppressedYieldHistoryRow } from "../../lib/yield-history-ownership-handoffs";

const D1_SAFE_SQL_IN_CHUNK_SIZE = 90;
const YIELD_HISTORY_LOAD_CHUNK_SIZE = 30;

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
}

export interface LoadYieldHistorySnapshotOptions {
  signal?: AbortSignal;
  chunkSize?: number;
  yieldToEventLoop?: (signal?: AbortSignal) => Promise<void>;
  onProgress?: (progress: YieldHistorySnapshotProgress) => void | Promise<void>;
}

function appendRows<T>(target: T[], rows: readonly T[]): void {
  for (const row of rows) {
    target.push(row);
  }
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
}> {
  const historyRows: YieldHistorySnapshotRow[] = [];
  const prevTvlRows: YieldHistorySnapshotRow[] = [];
  const prevBestRows: YieldHistorySnapshotRow[] = [];

  const chunkSize = Math.max(1, Math.min(options.chunkSize ?? YIELD_HISTORY_LOAD_CHUNK_SIZE, D1_SAFE_SQL_IN_CHUNK_SIZE));
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
    });
  };

  await reportProgress(0, 0);

  for (const [chunkIndex, idChunk] of idChunks.entries()) {
    throwIfAborted(options.signal);
    const resolvedIdInClause = buildInClause(idChunk);
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

    const prevTvlResult = await db
      .prepare(
        `SELECT /* pharos:yield-sync:previous-tvl */
           stablecoin_id, source_key, source_tvl_usd, recorded_at
         FROM yield_history
         WHERE stablecoin_id IN (${resolvedIdInClause.sql})
           AND recorded_at <= ?
           AND source_tvl_usd IS NOT NULL
           AND (publication_state IS NULL OR publication_state = 'published')
         ORDER BY stablecoin_id ASC, source_key ASC, recorded_at DESC`,
      )
      .bind(...resolvedIdInClause.binds, sevenDaysAgoSec)
      .all<YieldHistorySnapshotRow>();
    throwIfAborted(options.signal);
    await yieldToEventLoop(options.signal);

    const prevBestResult = await db
      .prepare(
        `SELECT /* pharos:yield-sync:previous-best */
           stablecoin_id, source_key, recorded_at, is_best, apy, apy_base, source_tvl_usd, data_source, yield_source, yield_type, exchange_rate
         FROM yield_history
         WHERE stablecoin_id IN (${resolvedIdInClause.sql})
           AND is_best = 1
           AND recorded_at < ?
           AND (publication_state IS NULL OR publication_state = 'published')
         ORDER BY stablecoin_id ASC, recorded_at DESC`,
      )
      .bind(...resolvedIdInClause.binds, startSec)
      .all<YieldHistorySnapshotRow>();

    appendRows(
      historyRows,
      (historyResult.results ?? []).filter((row) => !isSuppressedYieldHistoryRow(row.stablecoin_id, row.source_key)),
    );
    appendRows(
      prevTvlRows,
      (prevTvlResult.results ?? []).filter((row) => !isSuppressedYieldHistoryRow(row.stablecoin_id, row.source_key)),
    );
    appendRows(
      prevBestRows,
      (prevBestResult.results ?? []).filter((row) => !isSuppressedYieldHistoryRow(row.stablecoin_id, row.source_key)),
    );
    await reportProgress(chunkIndex + 1, Math.min(resolvedIds.length, (chunkIndex + 1) * chunkSize));
    await yieldToEventLoop(options.signal);
  }

  return { historyRows, prevTvlRows, prevBestRows };
}

export async function deleteStaleYieldRows(
  db: D1Database,
  managedYieldIds: string[],
  startSec: number,
): Promise<void> {
  const frozenIdsList = [...FROZEN_IDS];
  const frozenClause =
    frozenIdsList.length > 0
      ? `AND stablecoin_id NOT IN (${frozenIdsList.map(() => "?").join(",")})`
      : "";
  for (const idChunk of chunkArray(managedYieldIds, D1_SAFE_SQL_IN_CHUNK_SIZE)) {
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

export async function deleteOrphanYieldRows(
  db: D1Database,
  managedYieldIds: string[],
): Promise<void> {
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
