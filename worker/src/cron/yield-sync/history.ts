import {
  THIRTY_DAYS_SECONDS,
  DAY_SECONDS,
  HOUR_SECONDS,
} from "@shared/lib/time-constants";
import {
  FROZEN_IDS,
  ACTIVE_STABLECOINS,
} from "@shared/lib/stablecoins/registry";
import {
  buildInClause,
  D1_MAX_BOUND_PARAMETERS,
} from "../../lib/db";
import {
  chunkArray,
} from "../../lib/collections";
import {
  throwIfAborted,
  yieldToEventLoop as defaultYieldToEventLoop,
} from "../../lib/abort";
import {
  isSuppressedYieldHistoryRow,
  LEGACY_BEST_YIELD_SOURCE_KEY,
  YIELD_HISTORY_OWNERSHIP_HANDOFFS,
} from "../../lib/yield-history-ownership-handoffs";
import {
  buildOnChainSourceKey,
} from "../../lib/yield-utils";
import {
  bucketUnixSecondsToUtcDay,
} from "@shared/lib/time-buckets";
import {
  YIELD_HISTORY_MAX_DAYS,
  YIELD_HISTORY_RAW_DAYS,
} from "@shared/lib/yield-history-policy";
import {
  runWithOverloadRetry,
} from "../../lib/d1-overload-retry";
import {
  logWorkerEvent,
} from "../../lib/structured-log";

const D1_SAFE_SQL_IN_CHUNK_SIZE = 90;
const STALE_YIELD_DELETE_FIXED_BIND_COUNT = 1;
const YIELD_HISTORY_LOAD_CHUNK_SIZE = 30;
const MAX_PREVIOUS_TVL_HISTORY_ROWS = 5_000;

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

async function deleteStaleYieldRows(db: D1Database, managedYieldIds: string[], startSec: number): Promise<void> {
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

async function deleteOrphanYieldRows(db: D1Database, managedYieldIds: string[]): Promise<void> {
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

export interface YieldHistoryEvaluationInputs {
  sourceHistory: Map<string, YieldHistorySnapshotRow[]>;
  onChainCompatibilityHistoryById: Map<string, YieldHistorySnapshotRow[]>;
  legacyDeterministicOnChainHistoryById: Map<string, YieldHistorySnapshotRow[]>;
  legacyHistoryById: Map<string, YieldHistorySnapshotRow[]>;
  prevTvlBySource: Map<string, number | null>;
  legacyPrevTvlById: Map<string, number | null>;
  prevBestSourceKeyByCoin: Map<string, string>;
  sourceSwitchCount30dByCoin: Map<string, number>;
  /**
   * Selected-source rows per coin, in the same shape `countSourceSwitches` reads.
   * The evaluation pass appends this run's winner to the series so the published
   * 30d count obeys the same collapse rule as the history recount (B2/F5).
   */
  bestRowsByCoin: Map<string, YieldHistorySnapshotRow[]>;
}

function appendHistoryRow(
  rowsByKey: Map<string, YieldHistorySnapshotRow[]>,
  key: string,
  row: YieldHistorySnapshotRow,
): void {
  const rows = rowsByKey.get(key) ?? [];
  rows.push(row);
  rowsByKey.set(key, rows);
}

type YieldHistoryEvaluationMaps = ReturnType<typeof createEmptyYieldHistoryEvaluationInputs>;

/** Route a single history row into the source/legacy/on-chain/best families. */
function classifyHistoryRow(maps: YieldHistoryEvaluationMaps, row: YieldHistorySnapshotRow): void {
  const sourceKey = row.source_key ?? "legacy-best";
  const normalizedRow = { ...row, source_key: sourceKey };
  if (sourceKey === "legacy-best") {
    appendHistoryRow(maps.legacyHistoryById, row.stablecoin_id, normalizedRow);
  } else {
    appendHistoryRow(maps.sourceHistory, buildHistoryKey(row.stablecoin_id, sourceKey), normalizedRow);
  }

  if (row.data_source === "onchain" && row.exchange_rate != null) {
    appendHistoryRow(maps.onChainCompatibilityHistoryById, row.stablecoin_id, normalizedRow);
  }

  if (isLegacyDeterministicOnChainSourceKey(row.stablecoin_id, sourceKey)) {
    appendHistoryRow(maps.legacyDeterministicOnChainHistoryById, row.stablecoin_id, normalizedRow);
  }

  if (row.is_best === 1) {
    appendHistoryRow(maps.bestRowsByCoin, row.stablecoin_id, normalizedRow);
  }
}

/** Record the first previous-TVL value seen per source/legacy bucket. */
function bucketPrevTvlRow(maps: YieldHistoryEvaluationMaps, row: YieldHistorySnapshotRow): void {
  const sourceKey = row.source_key ?? "legacy-best";
  if (sourceKey === "legacy-best") {
    if (!maps.legacyPrevTvlById.has(row.stablecoin_id)) {
      maps.legacyPrevTvlById.set(row.stablecoin_id, row.source_tvl_usd ?? null);
    }
  } else {
    const key = buildHistoryKey(row.stablecoin_id, sourceKey);
    if (!maps.prevTvlBySource.has(key)) {
      maps.prevTvlBySource.set(key, row.source_tvl_usd ?? null);
    }
  }
}

/** Record the first previous-best source key seen per coin. */
function recordPrevBestRow(maps: YieldHistoryEvaluationMaps, row: YieldHistorySnapshotRow): void {
  if (!maps.prevBestSourceKeyByCoin.has(row.stablecoin_id)) {
    maps.prevBestSourceKeyByCoin.set(row.stablecoin_id, normalizePreviousBestSourceKey(row));
  }
}

/**
 * Count selected-source switches across a coin's best rows in recorded-at order,
 * optionally with `tailSourceKey` appended as the newest publication.
 *
 * B2: a segment of one publication is a fetch gap, not a switch — a source that
 * disappears for one hour and returns would otherwise count twice (out and back).
 * Collapse every run shorter than two publications before counting adjacent
 * differences, so only durable source changes are charged.
 *
 * F4: `legacy-best` is a sentinel, not a source identity, so it is skipped
 * entirely — the same rule `isRealSourceSwitch` applies to the published signal.
 * Letting a legacy era enter the durable list charged transitions the publisher
 * never charges (and a >=2-publication legacy run between two runs of one real
 * source read as two switches around an unchanged source).
 *
 * F5: `tailSourceKey` lets the publisher count the series *including* the run it
 * is about to publish, so a durable switch is only charged from its second
 * consecutive publication and a one-publication excursion never publishes a
 * count the next run erases.
 */
export function countSourceSwitchesWithTail(
  rows: readonly YieldHistorySnapshotRow[],
  tailSourceKey?: string | null,
  signal?: AbortSignal,
): number {
  const durableSourceKeys: string[] = [];
  let runSourceKey: string | null = null;
  let runLength = 0;
  const flushRun = () => {
    if (runSourceKey != null && runLength >= 2) durableSourceKeys.push(runSourceKey);
    runSourceKey = null;
    runLength = 0;
  };
  // Skipping (rather than flushing) keeps the surrounding runs of one real
  // source contiguous across a legacy gap, so the gap can never fabricate a
  // switch out of an unchanged source.
  const acceptSourceKey = (sourceKey: string) => {
    if (sourceKey === LEGACY_BEST_YIELD_SOURCE_KEY) return;
    if (sourceKey === runSourceKey) {
      runLength++;
      return;
    }
    flushRun();
    runSourceKey = sourceKey;
    runLength = 1;
  };
  for (const row of [...rows].sort((a, b) => a.recorded_at - b.recorded_at)) {
    throwIfAborted(signal);
    acceptSourceKey(normalizePreviousBestSourceKey(row));
  }
  if (tailSourceKey != null) acceptSourceKey(tailSourceKey);
  flushRun();

  let switches = 0;
  for (let index = 1; index < durableSourceKeys.length; index++) {
    if (durableSourceKeys[index] !== durableSourceKeys[index - 1]) {
      switches++;
    }
  }
  return switches;
}

export interface YieldHistoryInputBuildProgress {
  phase: "history-rows" | "previous-tvl" | "previous-best" | "source-switches";
  rowsDone: number;
  rowsTotal: number;
}

export interface BuildYieldHistoryEvaluationInputsCooperativeOptions {
  signal?: AbortSignal;
  yieldEveryRows?: number;
  yieldToEventLoop?: (signal?: AbortSignal) => Promise<void>;
  onProgress?: (progress: YieldHistoryInputBuildProgress) => void | Promise<void>;
}

function createEmptyYieldHistoryEvaluationInputs() {
  return {
    sourceHistory: new Map<string, YieldHistorySnapshotRow[]>(),
    onChainCompatibilityHistoryById: new Map<string, YieldHistorySnapshotRow[]>(),
    legacyDeterministicOnChainHistoryById: new Map<string, YieldHistorySnapshotRow[]>(),
    legacyHistoryById: new Map<string, YieldHistorySnapshotRow[]>(),
    prevTvlBySource: new Map<string, number | null>(),
    legacyPrevTvlById: new Map<string, number | null>(),
    prevBestSourceKeyByCoin: new Map<string, string>(),
    bestRowsByCoin: new Map<string, YieldHistorySnapshotRow[]>(),
    sourceSwitchCount30dByCoin: new Map<string, number>(),
  };
}

function finalizeYieldHistoryEvaluationInputs(
  maps: YieldHistoryEvaluationMaps,
): YieldHistoryEvaluationInputs {
  return {
    sourceHistory: maps.sourceHistory,
    onChainCompatibilityHistoryById: maps.onChainCompatibilityHistoryById,
    legacyDeterministicOnChainHistoryById: maps.legacyDeterministicOnChainHistoryById,
    legacyHistoryById: maps.legacyHistoryById,
    prevTvlBySource: maps.prevTvlBySource,
    legacyPrevTvlById: maps.legacyPrevTvlById,
    prevBestSourceKeyByCoin: maps.prevBestSourceKeyByCoin,
    sourceSwitchCount30dByCoin: maps.sourceSwitchCount30dByCoin,
    bestRowsByCoin: maps.bestRowsByCoin,
  };
}

type YieldHistoryEvaluationInput = {
  historyRows: YieldHistorySnapshotRow[];
  prevTvlRows: YieldHistorySnapshotRow[];
  prevBestRows: YieldHistorySnapshotRow[];
};

export function buildYieldHistoryEvaluationInputs(
  input: YieldHistoryEvaluationInput,
): YieldHistoryEvaluationInputs {
  return buildYieldHistoryEvaluationInputsCooperative(input, { synchronous: true });
}

export function buildYieldHistoryEvaluationInputsCooperative(
  input: YieldHistoryEvaluationInput,
  options: BuildYieldHistoryEvaluationInputsCooperativeOptions & { synchronous: true },
): YieldHistoryEvaluationInputs;
export function buildYieldHistoryEvaluationInputsCooperative(
  input: YieldHistoryEvaluationInput,
  options?: BuildYieldHistoryEvaluationInputsCooperativeOptions,
): Promise<YieldHistoryEvaluationInputs>;
export function buildYieldHistoryEvaluationInputsCooperative(
  input: YieldHistoryEvaluationInput,
  options: BuildYieldHistoryEvaluationInputsCooperativeOptions & { synchronous?: boolean } = {},
): YieldHistoryEvaluationInputs | Promise<YieldHistoryEvaluationInputs> {
  const maps = createEmptyYieldHistoryEvaluationInputs();

  if (options.synchronous) {
    for (const row of input.historyRows) classifyHistoryRow(maps, row);
    for (const row of input.prevTvlRows) bucketPrevTvlRow(maps, row);
    for (const row of input.prevBestRows) recordPrevBestRow(maps, row);
    for (const [stablecoinId, rows] of maps.bestRowsByCoin) {
      maps.sourceSwitchCount30dByCoin.set(stablecoinId, countSourceSwitchesWithTail(rows));
    }
    return finalizeYieldHistoryEvaluationInputs(maps);
  }

  return (async () => {
    const yieldEveryRows = Math.max(1, options.yieldEveryRows ?? 1_000);
    const yieldToEventLoop = options.yieldToEventLoop ?? defaultYieldToEventLoop;

    const checkpoint = async (
      phase: YieldHistoryInputBuildProgress["phase"],
      rowsDone: number,
      rowsTotal: number,
    ) => {
      throwIfAborted(options.signal);
      if (rowsDone === rowsTotal || rowsDone % yieldEveryRows === 0) {
        await options.onProgress?.({ phase, rowsDone, rowsTotal });
        await yieldToEventLoop(options.signal);
      }
    };

    for (const [index, row] of input.historyRows.entries()) {
      throwIfAborted(options.signal);
      classifyHistoryRow(maps, row);
      await checkpoint("history-rows", index + 1, input.historyRows.length);
    }

    for (const [index, row] of input.prevTvlRows.entries()) {
      throwIfAborted(options.signal);
      bucketPrevTvlRow(maps, row);
      await checkpoint("previous-tvl", index + 1, input.prevTvlRows.length);
    }

    for (const [index, row] of input.prevBestRows.entries()) {
      throwIfAborted(options.signal);
      recordPrevBestRow(maps, row);
      await checkpoint("previous-best", index + 1, input.prevBestRows.length);
    }

    const bestRowsEntries = [...maps.bestRowsByCoin.entries()];
    for (const [index, [stablecoinId, rows]] of bestRowsEntries.entries()) {
      throwIfAborted(options.signal);
      maps.sourceSwitchCount30dByCoin.set(
        stablecoinId,
        countSourceSwitchesWithTail(rows, null, options.signal),
      );
      await checkpoint("source-switches", index + 1, bestRowsEntries.length);
    }

    return finalizeYieldHistoryEvaluationInputs(maps);
  })();
}

const LEGACY_LUSD_BPROTOCOL_SOURCE_KEY = "bprotocol-lqty-only";
const SCRVUSD_CURRENT_RATE_SOURCE_KEY = "onchain:scrvusd-curve:scrvusd-current-rate";

export function buildHistoryKey(stablecoinId: string, sourceKey: string): string {
  return `${stablecoinId}::${sourceKey}`;
}

function isLegacyDeterministicOnChainSourceKey(
  stablecoinId: string,
  sourceKey: string | null | undefined,
): boolean {
  return stablecoinId === "lusd-liquity" && sourceKey === LEGACY_LUSD_BPROTOCOL_SOURCE_KEY;
}

function shouldNormalizeOnChainSourceKey(row: {
  stablecoin_id: string;
  source_key: string | null;
  data_source: string;
  exchange_rate?: number | null;
}): boolean {
  if (row.data_source !== "onchain") return false;

  // Only identities that predate source-aware history are aliases. Modern
  // on-chain keys (including linked-variant and protocol-specific keys) carry
  // real ownership and must survive comparison unchanged.
  return row.source_key == null
    || row.source_key === "legacy-best"
    || isLegacyDeterministicOnChainSourceKey(row.stablecoin_id, row.source_key);
}

export function pickHistoryRowsForSource(
  stablecoinId: string,
  sourceKey: string,
  dataSource: string,
  sourceHistory: Map<string, YieldHistorySnapshotRow[]>,
  onChainCompatibilityHistoryById: Map<string, YieldHistorySnapshotRow[]>,
  legacyDeterministicOnChainHistoryById: Map<string, YieldHistorySnapshotRow[]>,
  legacyHistoryById: Map<string, YieldHistorySnapshotRow[]>,
  resolvedCountByCoin: Map<string, number>,
): { rows: YieldHistorySnapshotRow[]; usedLegacyHistory: boolean } {
  const directRows = sourceHistory.get(buildHistoryKey(stablecoinId, sourceKey)) ?? [];
  if (directRows.length > 0) {
    return { rows: directRows, usedLegacyHistory: false };
  }

  if (dataSource === "onchain" && sourceKey === buildOnChainSourceKey(stablecoinId)) {
    const compatibilityRows = onChainCompatibilityHistoryById.get(stablecoinId) ?? [];
    if (compatibilityRows.length > 0) {
      return { rows: compatibilityRows, usedLegacyHistory: false };
    }

    const legacyDeterministicRows = legacyDeterministicOnChainHistoryById.get(stablecoinId) ?? [];
    if (legacyDeterministicRows.length > 0) {
      return { rows: legacyDeterministicRows, usedLegacyHistory: false };
    }
  }

  const legacyRows = legacyHistoryById.get(stablecoinId) ?? [];
  const legacyDataSources = new Set(
    legacyRows
      .map((row) => row.data_source)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );
  const legacyMatchesCurrentSourceFamily =
    legacyDataSources.size === 1 &&
    legacyDataSources.has(dataSource);

  const freshLegacyRows = legacyRows;
  const hasKnownSourceSemanticsBreak =
    stablecoinId === "scrvusd-curve" && sourceKey === SCRVUSD_CURRENT_RATE_SOURCE_KEY;

  if (
    freshLegacyRows.length > 0 &&
    !hasKnownSourceSemanticsBreak &&
    (resolvedCountByCoin.get(stablecoinId) ?? 0) <= 1 &&
    legacyMatchesCurrentSourceFamily
  ) {
    return { rows: freshLegacyRows, usedLegacyHistory: true };
  }

  return { rows: [], usedLegacyHistory: false };
}

function normalizePreviousBestSourceKey(row: {
  stablecoin_id: string;
  source_key: string | null;
  data_source: string;
  exchange_rate?: number | null;
}): string {
  return shouldNormalizeOnChainSourceKey(row)
    ? buildOnChainSourceKey(row.stablecoin_id)
    : (row.source_key ?? "legacy-best");
}

/** Days to retain audit-only yield_source_decisions rows. Trend-tagged rows
 *  (source switches, anomalies, rejected higher-confidence sources) are
 *  preserved beyond this window for long-running analytics. */
const AUDIT_DECISION_RETENTION_DAYS = 30;

const DECISION_RETENTION_DELETE_PREDICATE =
  "retention_reason = 'audit' AND COALESCE(source_switch, 0) != 1";
/**
 * Keep a 90-day completed-generation history for operational incident review.
 * publication-contract.ts only reads the newest attempted, published, and
 * failed generations (and derives candidate age from the newest attempt); the
 * prune protects those rows explicitly, including the current staged/published
 * generation, so this window does not change the contract's lookback.
 */
const YIELD_PUBLICATION_GENERATION_RETENTION_DAYS = 90;

const YIELD_DAILY_MATERIALIZATION_MAX_ROWS_PER_RUN = 1_000;

export async function materializeYieldHistoryDaily(
  db: D1Database,
  startSec: number,
): Promise<number> {
  const rawPruneCutoff = bucketUnixSecondsToUtcDay(
    startSec - YIELD_HISTORY_RAW_DAYS * DAY_SECONDS,
  );
  const result = await db
    .prepare(
      `/* pharos:yield-sync:daily-history-materialize */
       INSERT INTO yield_history_daily (
         stablecoin_id, source_key, snapshot_date, recorded_at, is_best,
         apy, apy_base, apy_reward, exchange_rate, source_tvl_usd,
         data_source, warning_signals, yield_source, yield_type,
         publication_generation_id, publication_state, pys_at_publish,
         safety_at_publish, variance_at_publish, pys_inputs_at_publish, source_observed_at
       )
       WITH pending AS (
         SELECT h.stablecoin_id, h.source_key,
                CAST(h.recorded_at / ${DAY_SECONDS} AS INTEGER) * ${DAY_SECONDS} AS snapshot_date,
                MAX(h.recorded_at) AS recorded_at
           FROM yield_history h
          WHERE h.recorded_at < ?
            AND (h.publication_state IS NULL OR h.publication_state = 'published')
            AND NOT EXISTS (
              SELECT 1 FROM yield_history_daily d
               WHERE d.stablecoin_id = h.stablecoin_id AND d.source_key = h.source_key
                 AND d.snapshot_date = CAST(h.recorded_at / ${DAY_SECONDS} AS INTEGER) * ${DAY_SECONDS}
                 AND d.recorded_at >= h.recorded_at
            )
          GROUP BY h.stablecoin_id, h.source_key, snapshot_date
          ORDER BY snapshot_date, h.stablecoin_id, h.source_key
          LIMIT ${YIELD_DAILY_MATERIALIZATION_MAX_ROWS_PER_RUN}
       ), ranked AS (
         SELECT h.*, pending.snapshot_date
           FROM pending JOIN yield_history h
             ON h.stablecoin_id = pending.stablecoin_id
            AND h.source_key = pending.source_key
            AND h.recorded_at = pending.recorded_at
       )
       SELECT stablecoin_id, source_key, snapshot_date, recorded_at, is_best,
              apy, apy_base, apy_reward, exchange_rate, source_tvl_usd,
              data_source, warning_signals, yield_source, yield_type,
              publication_generation_id, publication_state, pys_at_publish,
              safety_at_publish, variance_at_publish, pys_inputs_at_publish, source_observed_at
         FROM ranked
        WHERE true
       ON CONFLICT(stablecoin_id, source_key, snapshot_date) DO UPDATE SET
         recorded_at = excluded.recorded_at,
         is_best = excluded.is_best,
         apy = excluded.apy,
         apy_base = excluded.apy_base,
         apy_reward = excluded.apy_reward,
         exchange_rate = excluded.exchange_rate,
         source_tvl_usd = excluded.source_tvl_usd,
         data_source = excluded.data_source,
         warning_signals = excluded.warning_signals,
         yield_source = excluded.yield_source,
         yield_type = excluded.yield_type,
         publication_generation_id = excluded.publication_generation_id,
         publication_state = excluded.publication_state,
         pys_at_publish = excluded.pys_at_publish,
         safety_at_publish = excluded.safety_at_publish,
         variance_at_publish = excluded.variance_at_publish,
         pys_inputs_at_publish = excluded.pys_inputs_at_publish,
         source_observed_at = excluded.source_observed_at
       WHERE excluded.recorded_at > yield_history_daily.recorded_at
       RETURNING snapshot_date`,
    )
    .bind(rawPruneCutoff)
    .all<{ snapshot_date: number }>();
  return result.meta?.changes ?? result.results?.length ?? 0;
}

/**
 * Reclassify the historical linked-variant false-switch pattern only after the
 * same coin has published the linked identity cleanly in two consecutive
 * generations. This prevents a one-off winner change from rewriting evidence.
 *
 * The decisions CTE is pinned to `idx_yield_source_decisions_created_coin` so
 * the 7-day `created_at >= ?` bound drives a range scan. Without the hint the
 * planner joins from every published generation into its decisions and reads
 * the whole 200k+ row table (~5.5s) on each destructive-cleanup run.
 */
export async function cleanupFalseLinkedVariantSourceSwitches(
  db: D1Database,
  startSec = 0,
): Promise<number> {
  const result = await db
    .prepare(
        `WITH ranked_generations AS (
           SELECT d.stablecoin_id, d.generation_id, d.selected_source_key, d.source_switch,
                  ROW_NUMBER() OVER (
                    PARTITION BY d.stablecoin_id
                    ORDER BY d.created_at DESC, d.generation_id DESC
                  ) AS generation_rank
            FROM yield_source_decisions d INDEXED BY idx_yield_source_decisions_created_coin
             JOIN yield_publication_generations g
               ON g.generation_id = d.generation_id
              AND g.state = 'published'
            WHERE d.created_at >= ?
         ), verified_clean_identities AS (
           SELECT stablecoin_id, MIN(selected_source_key) AS selected_source_key
             FROM ranked_generations
            WHERE generation_rank <= 2
            GROUP BY stablecoin_id
           HAVING COUNT(*) = 2
              AND SUM(CASE WHEN source_switch = 0 AND selected_source_key LIKE 'linked-variant:%' THEN 1 ELSE 0 END) = 2
              AND MIN(selected_source_key) = MAX(selected_source_key)
         )
         UPDATE yield_source_decisions
            SET source_switch = 0,
                retention_reason = 'audit'
          WHERE source_switch = 1
            AND previous_best_source_key = 'onchain:' || stablecoin_id
            AND (stablecoin_id, selected_source_key) IN (
              SELECT stablecoin_id, selected_source_key FROM verified_clean_identities
            )`,
    )
    .bind(startSec - 7 * DAY_SECONDS)
    .run();
  return result.meta?.changes ?? 0;
}

export async function pruneYieldTables(
  db: D1Database,
  startSec: number,
  options?: {
    allowDestructiveCleanup?: boolean;
    signal?: AbortSignal;
  },
): Promise<void> {
  // Cleanup is idempotent; retry transient overload without replaying publication.
  await runWithOverloadRetry(() => pruneYieldTablesOnce(db, startSec, options), 3, options?.signal);
}

/**
 * Rows removed per statement. Small enough that a single statement stays far
 * inside the D1 per-query CPU budget even on a wide index scan.
 */
const RETENTION_DELETE_CHUNK_ROWS = 5_000;
/**
 * Ceiling on rows removed per run. A retention-boundary change can put millions
 * of rows in scope at once; draining them in one invocation would exceed the D1
 * CPU limit and fail the whole publication run, so each run removes a bounded
 * slice and the next run continues. Exceeding this budget is expected after a
 * boundary change and is reported by the log line below.
 */
const RETENTION_DELETE_MAX_ROWS_PER_RUN = 250_000;

/**
 * Delete every row of `table` older than `cutoffSec` (by `timeColumn`), in
 * bounded statements, so a large backlog drains across runs instead of failing
 * one. `rowid` is used for the chunk selection because every retention table is
 * a plain rowid table; each retention table indexes its time column, so each
 * bounded statement is an index range scan rather than a full scan.
 *
 * `eligibilityClause` adds a static predicate to the bounded selection for
 * tables whose rows need additional retention guards.
 *
 * Exported with an explicit `maxRows` budget: the production default is
 * {@link RETENTION_DELETE_MAX_ROWS_PER_RUN}, and a smaller budget exercises the
 * resumable path in tests.
 */
export async function drainRowsBeforeCutoff(params: {
  db: D1Database;
  table: "yield_history" | "yield_history_daily" | "yield_source_decision_alternatives";
  statementTag: string;
  timeColumn: "recorded_at" | "snapshot_date";
  cutoffSec: number;
  frozenIdsList: number[] | string[];
  frozenClause: string;
  eligibilityClause?: string;
  maxRows?: number;
}): Promise<{ deleted: number; budgetExhausted: boolean }> {
  const {
    db,
    table,
    statementTag,
    timeColumn,
    cutoffSec,
    frozenIdsList,
    frozenClause,
    eligibilityClause = "",
  } = params;
  const perRunBudget = Math.max(
    RETENTION_DELETE_CHUNK_ROWS,
    params.maxRows ?? RETENTION_DELETE_MAX_ROWS_PER_RUN,
  );
  let remainingBudget = perRunBudget;
  let deleted = 0;

  while (remainingBudget > 0) {
    const chunkRows = Math.min(RETENTION_DELETE_CHUNK_ROWS, remainingBudget);
    const result = await db
      .prepare(
        `/* pharos:yield-sync:${statementTag} */
         DELETE FROM ${table}
          WHERE rowid IN (
            SELECT rowid FROM ${table}
             WHERE ${timeColumn} < ? ${frozenClause}${eligibilityClause}
             ORDER BY ${timeColumn} ASC
             LIMIT ?
          )`,
      )
      .bind(cutoffSec, ...frozenIdsList, chunkRows)
      .run();
    const changed = Number(result.meta?.changes ?? 0);
    if (!Number.isFinite(changed) || changed <= 0) break;
    deleted += changed;
    remainingBudget -= changed;
    // A short statement means the backlog is exhausted.
    if (changed < chunkRows) break;
  }

  const budgetExhausted = remainingBudget <= 0 && deleted >= perRunBudget;
  if (budgetExhausted) {
    logWorkerEvent({
      scope: "handler",
      level: "info",
      event: "yield-history-retention-drain-continues",
      message: `Retention drain for ${table} hit its per-run row budget; the remainder continues on the next publication run.`,
      metadata: { table, deleted, budget: perRunBudget },
    });
  }
  return { deleted, budgetExhausted };
}

/**
 * Delete audit-only decision rows in bounded, predicate-first chunks. The
 * candidate query must apply the full retention predicate before LIMIT so
 * trend-tagged keeper rows cannot consume the chunk and make progress appear
 * short.
 */
export async function drainDecisionRowsBeforeCutoff(params: {
  db: D1Database;
  cutoffSec: number;
  maxRows?: number;
}): Promise<{ deleted: number; budgetExhausted: boolean }> {
  const { db, cutoffSec } = params;
  const perRunBudget = Math.max(
    RETENTION_DELETE_CHUNK_ROWS,
    params.maxRows ?? RETENTION_DELETE_MAX_ROWS_PER_RUN,
  );
  let remainingBudget = perRunBudget;
  let deleted = 0;
  let cursorCreatedAt: number | null = null;
  let cursorRowId: number | null = null;

  while (remainingBudget > 0) {
    const chunkRows = Math.min(RETENTION_DELETE_CHUNK_ROWS, remainingBudget);
    const cursorClause: string =
      cursorCreatedAt == null
        ? ""
        : "AND (created_at > ? OR (created_at = ? AND rowid > ?))";
    const cursorBinds: number[] =
      cursorCreatedAt == null ? [] : [cursorCreatedAt, cursorCreatedAt, cursorRowId as number];
    const candidates: D1Result<{ rowid: number; created_at: number }> = await db
      .prepare(
        `/* pharos:yield-sync:decision-retention-delete-candidates */
         SELECT rowid, created_at
           FROM yield_source_decisions
          WHERE created_at < ?
            AND ${DECISION_RETENTION_DELETE_PREDICATE}
            ${cursorClause}
          ORDER BY created_at ASC, rowid ASC
          LIMIT ?`,
      )
      .bind(cutoffSec, ...cursorBinds, chunkRows)
      .all<{ rowid: number; created_at: number }>();
    const candidateRows: Array<{ rowid: number; created_at: number }> = candidates.results ?? [];
    if (candidateRows.length === 0) break;

    const lastCandidate: { rowid: number; created_at: number } =
      candidateRows[candidateRows.length - 1]!;
    const lastCreatedAt: number = Number(lastCandidate.created_at);
    const lastRowId: number = Number(lastCandidate.rowid);
    if (!Number.isFinite(lastCreatedAt) || !Number.isFinite(lastRowId)) break;

    const result = await db
      .prepare(
        `/* pharos:yield-sync:decision-retention-delete */
         DELETE FROM yield_source_decisions
          WHERE rowid IN (
            SELECT rowid
              FROM yield_source_decisions
             WHERE created_at < ?
               AND ${DECISION_RETENTION_DELETE_PREDICATE}
               ${cursorClause}
             ORDER BY created_at ASC, rowid ASC
             LIMIT ?
          )`,
      )
      .bind(cutoffSec, ...cursorBinds, chunkRows)
      .run();
    const changed = Number(result.meta?.changes ?? 0);
    if (!Number.isFinite(changed) || changed <= 0) break;
    deleted += changed;
    remainingBudget -= changed;
    cursorCreatedAt = lastCreatedAt;
    cursorRowId = lastRowId;
  }

  const budgetExhausted = remainingBudget <= 0 && deleted >= perRunBudget;
  if (budgetExhausted) {
    logWorkerEvent({
      scope: "handler",
      level: "info",
      event: "yield-history-retention-drain-continues",
      message:
        "Retention drain for yield_source_decisions hit its per-run row budget; the remainder continues on the next publication run.",
      metadata: { table: "yield_source_decisions", deleted, budget: perRunBudget },
    });
  }
  return { deleted, budgetExhausted };
}

async function pruneYieldTablesOnce(
  db: D1Database,
  startSec: number,
  options?: { allowDestructiveCleanup?: boolean },
): Promise<void> {
  const allowDestructiveCleanup = options?.allowDestructiveCleanup ?? true;
  const managedYieldIds = ACTIVE_STABLECOINS.map((meta) => meta.id);
  if (allowDestructiveCleanup && managedYieldIds.length > 0) {
    await deleteStaleYieldRows(db, managedYieldIds, startSec);
    await deleteOrphanYieldRows(db, managedYieldIds);
  }

  // A generation only stays `staged` while its own run is publishing, and that
  // run now finalizes the row on abort. Anything left staged past one cron
  // interval was abandoned by an isolate that never came back; the publication
  // surface maps `staged` to a live candidate, so it must not linger.
  await db
    .prepare(
      `/* pharos:yield-sync:abandoned-staged-generation-finalize */
       UPDATE yield_publication_generations
          SET state = 'failed', failed_at = ?, failure_reason = 'abandoned-staged'
        WHERE state = 'staged'
          AND started_at < ?`,
    )
    .bind(startSec, startSec - HOUR_SECONDS)
    .run();

  await materializeYieldHistoryDaily(db, startSec);

  // Raw rows are deletable only when their source/day has a daily close at
  // least as new. A bounded backfill never authorizes deleting its remainder.
  //
  // Both deletes are drained in bounded statements. A retention boundary change
  // (v8.43 moved the raw cutoff from 365d to 30d) leaves the whole backlog
  // eligible at once, and one unbounded DELETE over millions of rows exceeds the
  // D1 per-query CPU limit — which failed the entire run with
  // `D1_ERROR: D1 DB exceeded its CPU time limit`, every hour, forever. A chunk
  // that cannot commit leaves the table unchanged, so the drain must be bounded
  // and resumable rather than atomic.
  const desiredRawPruneCutoff = bucketUnixSecondsToUtcDay(
    startSec - YIELD_HISTORY_RAW_DAYS * DAY_SECONDS,
  );
  const rawPruneCutoff = desiredRawPruneCutoff;
  const pruneCutoff = startSec - YIELD_HISTORY_MAX_DAYS * DAY_SECONDS;
  const frozenIdsList = [...FROZEN_IDS];
  const frozenClause =
    frozenIdsList.length > 0
      ? `AND stablecoin_id NOT IN (${frozenIdsList.map(() => "?").join(",")})`
      : "";
  await drainRowsBeforeCutoff({
    db,
    table: "yield_history",
    statementTag: "history-retention-delete",
    timeColumn: "recorded_at",
    cutoffSec: rawPruneCutoff,
    frozenIdsList,
    frozenClause,
    eligibilityClause: `AND EXISTS (
      SELECT 1 FROM yield_history_daily d
       WHERE d.stablecoin_id = yield_history.stablecoin_id
         AND d.source_key = yield_history.source_key
         AND d.snapshot_date = CAST(yield_history.recorded_at / ${DAY_SECONDS} AS INTEGER) * ${DAY_SECONDS}
         AND d.recorded_at >= yield_history.recorded_at
    )`,
  });
  await drainRowsBeforeCutoff({
    db,
    table: "yield_history_daily",
    statementTag: "daily-history-retention-delete",
    timeColumn: "snapshot_date",
    cutoffSec: pruneCutoff,
    frozenIdsList,
    frozenClause,
  });

  if (allowDestructiveCleanup) {
    await cleanupFalseLinkedVariantSourceSwitches(db, startSec);
    const auditCutoffSec = startSec - AUDIT_DECISION_RETENTION_DAYS * DAY_SECONDS;
    await drainDecisionRowsBeforeCutoff({ db, cutoffSec: auditCutoffSec });
    await drainRowsBeforeCutoff({
      db,
      table: "yield_source_decision_alternatives",
      statementTag: "decision-alternatives-retention-delete",
      timeColumn: "recorded_at",
      cutoffSec: auditCutoffSec,
      frozenIdsList: [],
      frozenClause: "",
      eligibilityClause: `
        AND NOT EXISTS (
          SELECT 1 FROM yield_source_decisions d
          WHERE d.generation_id = yield_source_decision_alternatives.generation_id
            AND d.stablecoin_id = yield_source_decision_alternatives.stablecoin_id
        )`,
    });
    const generationCutoffSec =
      startSec - YIELD_PUBLICATION_GENERATION_RETENTION_DAYS * DAY_SECONDS;
    await db
      .prepare(
        `/* pharos:yield-sync:publication-generation-retention-delete */
         WITH protected_generations AS (
           SELECT generation_id
             FROM (
               SELECT generation_id
                 FROM yield_publication_generations
                ORDER BY started_at DESC
                LIMIT 1
             )
           UNION
           SELECT generation_id
             FROM (
               SELECT generation_id
                 FROM yield_publication_generations
                WHERE state = 'published'
                ORDER BY COALESCE(published_at, started_at) DESC, started_at DESC
                LIMIT 1
             )
           UNION
           SELECT generation_id
             FROM (
               SELECT generation_id
                 FROM yield_publication_generations
                WHERE state = 'failed'
                ORDER BY COALESCE(failed_at, started_at) DESC, started_at DESC
                LIMIT 1
             )
         )
         DELETE FROM yield_publication_generations
          WHERE state IN ('published', 'failed')
            AND COALESCE(published_at, failed_at, started_at) < ?
            AND generation_id NOT IN (SELECT generation_id FROM protected_generations)`,
      )
      .bind(generationCutoffSec)
      .run();
    await purgeYieldHistoryOwnershipHandoffs(db);
  }
}
