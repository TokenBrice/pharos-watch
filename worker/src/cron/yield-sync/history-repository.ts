import {
  THIRTY_DAYS_SECONDS,
} from "@shared/lib/time-constants";
import {
  buildInClause,
  D1_MAX_BOUND_PARAMETERS,
} from "../../lib/db";
import {
  chunkArray,
} from "../../lib/collections";
import {
  sleepWithSignal,
  throwIfAborted,
  yieldToEventLoop as defaultYieldToEventLoop,
} from "../../lib/abort";
import {
  isSuppressedYieldHistoryRow,
  LEGACY_BEST_YIELD_SOURCE_KEY,
  YIELD_HISTORY_OWNERSHIP_HANDOFFS,
} from "../../lib/yield/yield-history-ownership-handoffs";
import {
  D1_HEAVY_STATEMENT_IDLE_RATIO,
  runWithOverloadRetry,
} from "../../lib/d1-overload-retry";

export const D1_SAFE_SQL_IN_CHUNK_SIZE = 90;

const YIELD_HISTORY_LOAD_CHUNK_SIZE = 30;

const MAX_PREVIOUS_TVL_HISTORY_ROWS = 5_000;

/** Idle after each history-window read and the atomic publication batch. */
export const YIELD_D1_IDLE_RATIO = D1_HEAVY_STATEMENT_IDLE_RATIO;

/** Idempotent loader reads outlast one spent D1 resource window instead of failing the run. */
function readOutlastingResourceWindow<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return runWithOverloadRetry(read, 3, signal, { waitOutResourceWindow: true });
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
  /** Idles after a history-window read that took `readMs` of wall time. */
  paceHistoryRead?: (readMs: number, signal?: AbortSignal) => Promise<void>;
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
  const rows: YieldHistorySnapshotRow[] = [];
  const seekChunkSize = Math.max(1, D1_MAX_BOUND_PARAMETERS - exclusion.binds.length - 1);
  for (const coinChunk of chunkArray(idChunk, seekChunkSize)) {
    throwIfAborted(signal);
    const result = await readOutlastingResourceWindow(() => db
      .prepare(
        `WITH requested(stablecoin_id) AS (VALUES ${coinChunk.map(() => "(?)").join(", ")})
         SELECT /* pharos:yield-sync:previous-best-point */
           p.stablecoin_id, p.source_key, p.recorded_at, p.is_best, p.apy, p.apy_base, p.source_tvl_usd, p.data_source, p.yield_source, p.yield_type, p.exchange_rate
         FROM yield_history p
         WHERE p.rowid IN (
           SELECT (
             SELECT h.rowid
               FROM yield_history h INDEXED BY idx_yield_hist_best
              WHERE h.stablecoin_id = requested.stablecoin_id
                AND h.is_best = 1
                AND h.recorded_at < ?
                AND (h.publication_state IS NULL OR h.publication_state = 'published')
                AND ${exclusion.sql}
              ORDER BY h.recorded_at DESC, h.rowid DESC
              LIMIT 1
           ) FROM requested
         )`,
      )
      .bind(...coinChunk, startSec, ...exclusion.binds)
      .all<YieldHistorySnapshotRow>(), signal);
    appendRows(rows, result.results ?? []);
  }
  const rowById = new Map(
    rows
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
  const paceHistoryRead = options.paceHistoryRead ?? ((readMs: number, signal?: AbortSignal) =>
    sleepWithSignal(Math.round(readMs * YIELD_D1_IDLE_RATIO), signal));

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
    const historyReads = [
      {
        index: "idx_yield_hist_best",
        predicate: `h.stablecoin_id IN (${resolvedIdInClause.sql}) AND h.is_best = 1`,
        binds: resolvedIdInClause.binds,
      },
      ...chunkArray(requestedPairs, Math.floor((D1_MAX_BOUND_PARAMETERS - 2) / 2)).map((pairs) => {
        const values = buildSourcePairValues(pairs);
        return {
          index: "idx_yield_hist_coin_source",
          predicate: `(h.stablecoin_id, h.source_key) IN (VALUES ${values.sql})`,
          binds: values.binds,
        };
      }),
    ];
    const historyChunkRows: YieldHistorySnapshotRow[] = [];
    const historyRowKeys = new Set<string>();

    for (const read of historyReads) {
      let readMs = 0;
      const historyResult = await readOutlastingResourceWindow(async () => {
        const attemptStartedMs = Date.now();
        const attempt = await db
          .prepare(
            `SELECT /* pharos:yield-sync:history-window */
               h.stablecoin_id, h.source_key, h.recorded_at, h.is_best, h.apy, h.apy_base, h.source_tvl_usd, h.data_source, h.yield_source, h.yield_type, h.exchange_rate
             FROM yield_history h INDEXED BY ${read.index}
             WHERE ${read.predicate}
               AND h.recorded_at >= ?
               AND h.recorded_at <= ?
               AND (h.publication_state IS NULL OR h.publication_state = 'published')`,
          )
          .bind(...read.binds, startSec - THIRTY_DAYS_SECONDS, startSec)
          .all<YieldHistorySnapshotRow>();
        // Pace on this attempt alone; a waited-out window is already idle time.
        readMs = Date.now() - attemptStartedMs;
        return attempt;
      }, options.signal);
      for (const row of historyResult.results ?? []) {
        if (isSuppressedYieldHistoryRow(row.stablecoin_id, row.source_key)) continue;
        const rowKey = `${row.stablecoin_id}\0${row.source_key ?? ""}\0${row.recorded_at}`;
        if (historyRowKeys.has(rowKey)) continue;
        historyRowKeys.add(rowKey);
        historyChunkRows.push(row);
      }
      await paceHistoryRead(readMs, options.signal);
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
        const prevTvlResult = await readOutlastingResourceWindow(() => db
          .prepare(
            `WITH requested(stablecoin_id, source_key) AS (VALUES ${pairValues.sql})
             SELECT /* pharos:yield-sync:previous-tvl */
               p.stablecoin_id, p.source_key, p.source_tvl_usd, p.recorded_at
             FROM yield_history p
             WHERE p.rowid IN (
               SELECT (
                 SELECT h.rowid
                   FROM yield_history h INDEXED BY idx_yield_hist_coin_source
                  WHERE h.stablecoin_id = requested.stablecoin_id
                    AND h.source_key = requested.source_key
                    AND h.recorded_at <= ?
                    AND h.source_tvl_usd IS NOT NULL
                    AND (h.publication_state IS NULL OR h.publication_state = 'published')
                    AND ${currentExclusion.sql}
                  ORDER BY h.recorded_at DESC, h.rowid DESC
                  LIMIT 1
               ) FROM requested
             )
             ORDER BY p.stablecoin_id ASC, p.source_key ASC
             LIMIT ?`,
          )
          .bind(
            ...pairValues.binds,
            sevenDaysAgoSec,
            ...currentExclusion.binds,
            remainingPreviousTvlRows + 1,
          )
          .all<YieldHistorySnapshotRow>(), options.signal);
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

    historyChunkRows.sort((a, b) =>
      (a.stablecoin_id < b.stablecoin_id ? -1 : a.stablecoin_id > b.stablecoin_id ? 1 : 0) ||
      a.recorded_at - b.recorded_at,
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
