import { logWorkerEventArgs } from "../structured-log";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { formatUtcDateOnly } from "@shared/lib/format";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { throwIfAborted } from "../abort";
import {
  batchExecute,
  buildInClause,
  executeAtomicBatch,
  prepareMultiRowInsertStatements,
} from "../db";
import { chunkArray } from "../collections";
import { writeFreshnessSentinel } from "../db-cache";
import { runWithOverloadRetry } from "../d1-overload-retry";
import { writeDewsPublishedGeneration } from "../dews-publication-pointer";
import type { DewsComputedRow } from "./contracts";
import { startOfUtcDaySec } from "@shared/lib/time-buckets";

const D1_SAFE_SQL_IN_CHUNK_SIZE = 90;
const DEWS_TABLES = new Set([
  "stress_signals",
  "stress_signal_history",
  "stress_signals_latest",
]);

/**
 * Compute the set of stablecoin ids whose stress-signal rows should be
 * deleted. Preserves rows for any currently eligible coin AND any frozen
 * coin (which are excluded from PSI eligibility but whose history we
 * keep).
 */
export function computeStressSignalPruneIds(
  allDbIds: Set<string>,
  eligibleIds: Set<string>,
  frozenIds: ReadonlySet<string> = FROZEN_IDS,
): Set<string> {
  const prune = new Set<string>();
  for (const id of allDbIds) {
    if (eligibleIds.has(id)) continue;
    if (frozenIds.has(id)) continue;
    prune.add(id);
  }
  return prune;
}

async function deleteOrphansForTable(
  db: D1Database,
  table: string,
  eligibleIds: Set<string>,
  options: { signal?: AbortSignal } = {},
): Promise<number> {
  if (!DEWS_TABLES.has(table)) throw new Error(`Invalid DEWS table: ${table}`);
  throwIfAborted(options.signal);

  const existingIds = await runWithOverloadRetry(() =>
    db
      // SAFETY: validated against DEWS_TABLES allowlist above.
      .prepare(`/* pharos:dews:orphan-ids:${table} */ SELECT DISTINCT stablecoin_id FROM ${table}`)
      .all<{ stablecoin_id: string }>(),
    3,
    options.signal,
  );
  throwIfAborted(options.signal);
  const allDbIds = new Set((existingIds.results ?? []).map((row) => row.stablecoin_id));
  const orphanIds = [...computeStressSignalPruneIds(allDbIds, eligibleIds)];

  if (orphanIds.length === 0) return 0;

  return deleteStablecoinRowsByIdChunks(db, orphanIds, {
    signal: options.signal,
    buildSql: (inClauseSql) =>
      // SAFETY: validated against DEWS_TABLES allowlist above.
      `/* pharos:dews:orphan-delete:${table} */ DELETE FROM ${table} WHERE stablecoin_id IN (${inClauseSql})`,
  });
}

async function deleteStablecoinRowsByIdChunks(
  db: D1Database,
  stablecoinIds: Iterable<string>,
  options: {
    buildSql: (inClauseSql: string) => string;
    signal?: AbortSignal;
  },
): Promise<number> {
  const ids = [...new Set(stablecoinIds)];
  if (ids.length === 0) return 0;

  let deleted = 0;
  for (const idChunk of chunkArray(ids, D1_SAFE_SQL_IN_CHUNK_SIZE)) {
    throwIfAborted(options.signal);
    const inClause = buildInClause(idChunk);
    const result = await runWithOverloadRetry(() =>
      db
        .prepare(options.buildSql(inClause.sql))
        .bind(...inClause.binds)
        .run(),
      3,
      options.signal,
    );
    throwIfAborted(options.signal);
    deleted += result.meta?.changes ?? 0;
  }
  return deleted;
}

async function deleteCurrentStressSignalRowsForIds(
  db: D1Database,
  stablecoinIds: Iterable<string>,
  signal?: AbortSignal,
): Promise<number> {
  return deleteStablecoinRowsByIdChunks(db, stablecoinIds, {
    signal,
    buildSql: (inClauseSql) =>
      `/* pharos:dews:stress-current-delete */ DELETE FROM stress_signals WHERE stablecoin_id IN (${inClauseSql})`,
  });
}

async function deleteLatestStressSignalRowsForIds(
  db: D1Database,
  stablecoinIds: Iterable<string>,
  signal?: AbortSignal,
): Promise<number> {
  return deleteStablecoinRowsByIdChunks(db, stablecoinIds, {
    signal,
    buildSql: (inClauseSql) =>
      `/* pharos:dews:stress-latest-delete */ DELETE FROM stress_signals_latest WHERE stablecoin_id IN (${inClauseSql})`,
  });
}

function buildStressSignalsEnvelope(result: DewsComputedRow): string {
  return JSON.stringify({
    signals: result.signals,
    amplifiers: result.amplifiers,
    baseScore: result.baseScore,
    finalScore: result.finalScore,
    availableWeight: result.availableWeight,
    effectiveWeights: result.effectiveWeights,
    evidenceKinds: result.evidenceKinds,
    insufficientEvidenceReason: result.insufficientEvidenceReason,
    dataQualityScore: result.dataQualityScore,
    topContributors: result.topContributors,
    ...(result.sourceAges ? { sourceAges: result.sourceAges } : {}),
    ...(result.staleFlags ? { staleFlags: result.staleFlags } : {}),
  });
}

function hasExactStablecoinIds(actual: ReadonlySet<string>, expected: ReadonlySet<string>): boolean {
  if (actual.size !== expected.size) return false;
  for (const stablecoinId of expected) {
    if (!actual.has(stablecoinId)) return false;
  }
  return true;
}

async function readDailyStressHistoryIds(
  db: D1Database,
  snapshotDate: number,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT /* pharos:dews:stress-history-daily-ids */ stablecoin_id
           FROM stress_signal_history
          WHERE snapshot_date = ?`,
      )
      .bind(snapshotDate)
      .all<{ stablecoin_id: string }>(),
    3,
    signal,
  );
  throwIfAborted(signal);
  return new Set((rows.results ?? []).map((row) => row.stablecoin_id));
}

/**
 * Seal the producer-owned portion of one daily snapshot to the exact computed
 * identity set. Frozen rows are retained as historical evidence outside the
 * active producer's ownership boundary.
 */
export async function reconcileDailyDewsHistorySnapshot(
  db: D1Database,
  results: DewsComputedRow[],
  snapshotDate: number,
  signal?: AbortSignal,
): Promise<{ rewritten: boolean; previousOwnedRowCount: number; sealedRowCount: number }> {
  if (results.length === 0) {
    return { rewritten: false, previousOwnedRowCount: 0, sealedRowCount: 0 };
  }

  const expectedIds = new Set(results.map((result) => result.stablecoinId));
  if (expectedIds.size !== results.length) {
    throw new Error("DEWS daily snapshot contains duplicate stablecoin identities");
  }

  const existingIds = await readDailyStressHistoryIds(db, snapshotDate, signal);
  const existingOwnedIds = new Set([...existingIds].filter((stablecoinId) => !FROZEN_IDS.has(stablecoinId)));
  if (hasExactStablecoinIds(existingOwnedIds, expectedIds)) {
    return {
      rewritten: false,
      previousOwnedRowCount: existingOwnedIds.size,
      sealedRowCount: expectedIds.size,
    };
  }

  const frozenIds = [...FROZEN_IDS];
  const frozenClause = frozenIds.length > 0
    ? `AND stablecoin_id NOT IN (${buildInClause(frozenIds).sql})`
    : "";
  const deleteOwnedRows = db
    .prepare(
      `/* pharos:dews:stress-history-daily-replace */
       DELETE FROM stress_signal_history
        WHERE snapshot_date = ? ${frozenClause}`,
    )
    .bind(snapshotDate, ...frozenIds);
  const insertRows = results.map((result) => [
    result.stablecoinId,
    snapshotDate,
    result.score,
    result.band,
    buildStressSignalsEnvelope(result),
  ]);
  const insertStatements = prepareMultiRowInsertStatements(
    db,
    `/* pharos:dews:stress-history-daily-seal */
     INSERT OR REPLACE INTO stress_signal_history
       (stablecoin_id, snapshot_date, score, band, signals_json)`,
    insertRows,
  );
  await executeAtomicBatch(db, [deleteOwnedRows, ...insertStatements], { signal });

  const sealedIds = await readDailyStressHistoryIds(db, snapshotDate, signal);
  const sealedOwnedIds = new Set([...sealedIds].filter((stablecoinId) => !FROZEN_IDS.has(stablecoinId)));
  if (!hasExactStablecoinIds(sealedOwnedIds, expectedIds)) {
    throw new Error(
      `DEWS daily snapshot identity mismatch: sealed ${sealedOwnedIds.size}/${expectedIds.size} rows for ${snapshotDate}`,
    );
  }

  return {
    rewritten: true,
    previousOwnedRowCount: existingOwnedIds.size,
    sealedRowCount: sealedOwnedIds.size,
  };
}

async function upsertLatestStressSignalRows(
  db: D1Database,
  results: DewsComputedRow[],
  nowSec: number,
  signal?: AbortSignal,
): Promise<void> {
  if (results.length === 0) return;
  const stmts = results.map((result) =>
    db
      .prepare(
        `/* pharos:dews:stress-latest-upsert */
         INSERT OR REPLACE INTO stress_signals_latest
           (stablecoin_id, computed_at, score, band, signals_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        result.stablecoinId,
        nowSec,
        result.score,
        result.band,
        buildStressSignalsEnvelope(result),
        nowSec,
      ),
  );
  await batchExecute(db, stmts, { signal });
}

async function insertStressSignalPublicationRows(
  db: D1Database,
  results: DewsComputedRow[],
  nowSec: number,
  signal?: AbortSignal,
): Promise<void> {
  if (results.length === 0) return;
  const stmts = results.map((result) =>
    db
      .prepare(
        `/* pharos:dews:publication-row-insert */
         INSERT OR REPLACE INTO stress_signal_publication_rows
           (stablecoin_id, computed_at, score, band, signals_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        result.stablecoinId,
        nowSec,
        result.score,
        result.band,
        buildStressSignalsEnvelope(result),
      ),
  );
  await batchExecute(db, stmts, { signal });
}

async function countStressSignalRowsForGeneration(
  db: D1Database,
  table: "stress_signal_publication_rows" | "stress_signals_latest",
  nowSec: number,
  signal?: AbortSignal,
): Promise<number | null> {
  const row = await runWithOverloadRetry(() =>
    db
      .prepare(
        table === "stress_signal_publication_rows"
          ? "SELECT /* pharos:dews:publication-generation-count */ COUNT(*) as cnt FROM stress_signal_publication_rows WHERE computed_at = ?"
          : "SELECT /* pharos:dews:stress-latest-generation-count */ COUNT(*) as cnt FROM stress_signals_latest WHERE computed_at = ?",
      )
      .bind(nowSec)
      .first<{ cnt: number }>(),
    3,
    signal,
  );
  throwIfAborted(signal);
  return row?.cnt ?? 0;
}

export async function persistDewsResults(params: {
  db: D1Database;
  results: DewsComputedRow[];
  eligibleIds: Set<string>;
  noCurrentSupplyIds?: string[];
  publishFreshnessSentinel: boolean;
  nowSec: number;
  signal?: AbortSignal;
}): Promise<{
  rowsDropped: number;
  rowsRetiredCurrent: number;
  currentGenerationRows: number;
  latestGenerationRows: number | null;
  publicationPointerWritten: boolean;
  publishedGeneration: number | null;
}> {
  throwIfAborted(params.signal);
  if (params.results.length > 0) {
    const stmts = params.results.map((result) =>
      params.db
        .prepare(
          `/* pharos:dews:stress-history-sparse-insert */
           INSERT OR IGNORE INTO stress_signals (stablecoin_id, computed_at, score, band, signals_json)
           SELECT ?, ?, ?, ?, ?
            WHERE NOT EXISTS (
                    SELECT 1 FROM stress_signals history
                     WHERE history.stablecoin_id = ?
                       AND history.computed_at > ?
                  )
               OR NOT EXISTS (
                    SELECT 1 FROM stress_signals_latest latest
                     WHERE latest.stablecoin_id = ?
                  )
               OR EXISTS (
                    SELECT 1 FROM stress_signals_latest latest
                     WHERE latest.stablecoin_id = ?
                       AND (latest.band != ? OR ABS(latest.score - ?) >= 1)
                  )`,
        )
        .bind(
          result.stablecoinId,
          params.nowSec,
          result.score,
          result.band,
          buildStressSignalsEnvelope(result),
          result.stablecoinId,
          params.nowSec - 60 * 60,
          result.stablecoinId,
          result.stablecoinId,
          result.band,
          result.score,
        ),
    );
    await batchExecute(params.db, stmts, { signal: params.signal });
    throwIfAborted(params.signal);
    await insertStressSignalPublicationRows(params.db, params.results, params.nowSec, params.signal);
    await upsertLatestStressSignalRows(params.db, params.results, params.nowSec, params.signal);
  }
  const computedIds = new Set(params.results.map((result) => result.stablecoinId));
  const noCurrentSupplyIds = (params.noCurrentSupplyIds ?? []).filter(
    (stablecoinId) => params.eligibleIds.has(stablecoinId) && !computedIds.has(stablecoinId),
  );
  const rowsRetiredCurrent = await deleteCurrentStressSignalRowsForIds(params.db, noCurrentSupplyIds, params.signal);
  await deleteLatestStressSignalRowsForIds(params.db, noCurrentSupplyIds, params.signal);

  const todayMidnight = startOfUtcDaySec(new Date());
  if (params.results.length > 0) {
    const dailySnapshot = await reconcileDailyDewsHistorySnapshot(
      params.db,
      params.results,
      todayMidnight,
      params.signal,
    );
    if (dailySnapshot.rewritten) {
      logWorkerEventArgs("lib", "info",
        `[dews] Reconciled daily snapshot (${dailySnapshot.previousOwnedRowCount} -> ${dailySnapshot.sealedRowCount}) for ${formatUtcDateOnly(new Date(todayMidnight * 1000))}`,
      );
    }
  }

  let rowsDropped = rowsRetiredCurrent;
  if (params.eligibleIds.size > 0) {
    rowsDropped += await deleteOrphansForTable(params.db, "stress_signals", params.eligibleIds, {
      signal: params.signal,
    });
    rowsDropped += await deleteOrphansForTable(params.db, "stress_signals_latest", params.eligibleIds, {
      signal: params.signal,
    });
    rowsDropped += await deleteOrphansForTable(params.db, "stress_signal_history", params.eligibleIds, {
      signal: params.signal,
    });
  }

  const frozenIdsList = [...FROZEN_IDS];
  const frozenClause =
    frozenIdsList.length > 0 ? `AND stablecoin_id NOT IN (${frozenIdsList.map(() => "?").join(",")})` : "";

  const oldSignals = await runWithOverloadRetry(() =>
    params.db
      .prepare(`/* pharos:dews:stress-current-prune-old */ DELETE FROM stress_signals WHERE computed_at < ? ${frozenClause}`)
      .bind(params.nowSec - 7 * DAY_SECONDS, ...frozenIdsList)
      .run(),
    3,
    params.signal,
  );
  rowsDropped += oldSignals.meta?.changes ?? 0;

  const oldHistory = await runWithOverloadRetry(() =>
    params.db
      .prepare(`/* pharos:dews:stress-history-prune-old */ DELETE FROM stress_signal_history WHERE snapshot_date < ? ${frozenClause}`)
      .bind(params.nowSec - 365 * DAY_SECONDS, ...frozenIdsList)
      .run(),
    3,
    params.signal,
  );
  rowsDropped += oldHistory.meta?.changes ?? 0;

  let currentGenerationRows = 0;
  let latestGenerationRows: number | null = null;
  let publicationPointerWritten = false;
  let publishedGeneration: number | null = null;
  if (params.results.length > 0) {
    currentGenerationRows = await countStressSignalRowsForGeneration(
      params.db,
      "stress_signal_publication_rows",
      params.nowSec,
      params.signal,
    ) ?? 0;
    latestGenerationRows = await countStressSignalRowsForGeneration(
      params.db,
      "stress_signals_latest",
      params.nowSec,
      params.signal,
    );
    const expectedRows = params.results.length;
    if (currentGenerationRows !== expectedRows) {
      throw new Error(
        `DEWS publication incomplete: stress_signal_publication_rows has ${currentGenerationRows}/${expectedRows} rows for ${params.nowSec}`,
      );
    }
    if (latestGenerationRows != null && latestGenerationRows !== expectedRows) {
      throw new Error(
        `DEWS publication incomplete: stress_signals_latest has ${latestGenerationRows}/${expectedRows} rows for ${params.nowSec}`,
      );
    }
    const pointerWrite = await writeDewsPublishedGeneration(
      params.db,
      params.nowSec,
      params.results.map((result) => result.stablecoinId),
      params.signal,
    );
    publicationPointerWritten = pointerWrite.written;
    publishedGeneration = pointerWrite.written ? params.nowSec : null;
    if (pointerWrite.written) {
      await runWithOverloadRetry(() =>
        params.db
          .prepare(
            `/* pharos:dews:publication-generation-retention */
             DELETE FROM stress_signal_publication_rows
              WHERE computed_at < (
                SELECT MIN(computed_at)
                  FROM (
                    SELECT DISTINCT computed_at
                      FROM stress_signal_publication_rows
                     ORDER BY computed_at DESC
                     LIMIT 2
                  )
              )`,
          )
          .run(),
        3,
        params.signal,
      );
    }
  }

  if (params.publishFreshnessSentinel && params.results.length > 0) {
    throwIfAborted(params.signal);
    await writeFreshnessSentinel(params.db, "dews", params.nowSec, params.signal);
  }

  return {
    rowsDropped,
    rowsRetiredCurrent,
    currentGenerationRows,
    latestGenerationRows,
    publicationPointerWritten,
    publishedGeneration,
  };
}
