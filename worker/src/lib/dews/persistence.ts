import { logWorkerEventArgs } from "../structured-log";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { formatUtcDateOnly } from "@shared/lib/format";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { throwIfAborted } from "../abort";
import {
  batchExecute,
  buildInClause,
  executeAtomicBatch,
  D1_MAX_BOUND_PARAMETERS,
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

const DEWS_GENERATION_ROW_TARGETS = {
  latest: { sql: `/* pharos:dews:stress-latest-upsert */
         INSERT INTO stress_signals_latest
           (stablecoin_id, computed_at, score, band, signals_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(stablecoin_id) DO UPDATE SET
           computed_at = excluded.computed_at, score = excluded.score, band = excluded.band,
           signals_json = excluded.signals_json, updated_at = excluded.updated_at`, includeUpdatedAt: true },
  publication: { sql: "/* pharos:dews:publication-row-insert */\n         INSERT OR REPLACE INTO stress_signal_publication_rows\n           (stablecoin_id, computed_at, score, band, signals_json)\n         VALUES (?, ?, ?, ?, ?)", includeUpdatedAt: false },
} as const;

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
    effectiveWeights: result.effectiveWeights,
    evidenceKinds: result.evidenceKinds,
    insufficientEvidenceReason: result.insufficientEvidenceReason,
    dataQualityScore: result.dataQualityScore,
    topContributors: result.topContributors,
    ...(result.sourceAges ? { sourceAges: result.sourceAges } : {}),
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
 * Seal the admitted portion of one daily snapshot to the exact computed identity
 * set. Frozen and quarantined rows remain historical evidence outside this run's
 * ownership boundary.
 */
export async function reconcileDailyDewsHistorySnapshot(
  db: D1Database,
  results: DewsComputedRow[],
  snapshotDate: number,
  signal?: AbortSignal,
  quarantinedStablecoinIds?: ReadonlySet<string>,
): Promise<{ rewritten: boolean; previousOwnedRowCount: number; sealedRowCount: number }> {
  if (results.length === 0) {
    return { rewritten: false, previousOwnedRowCount: 0, sealedRowCount: 0 };
  }

  const expectedIds = new Set(results.map((result) => result.stablecoinId));
  if (expectedIds.size !== results.length) {
    throw new Error("DEWS daily snapshot contains duplicate stablecoin identities");
  }

  const existingIds = await readDailyStressHistoryIds(db, snapshotDate, signal);
  const existingOwnedIds = new Set([...existingIds].filter(
    (stablecoinId) => !FROZEN_IDS.has(stablecoinId) && !quarantinedStablecoinIds?.has(stablecoinId),
  ));
  if (hasExactStablecoinIds(existingOwnedIds, expectedIds)) {
    return {
      rewritten: false,
      previousOwnedRowCount: existingOwnedIds.size,
      sealedRowCount: expectedIds.size,
    };
  }

  const departedIds = [...existingOwnedIds].filter((id) => !expectedIds.has(id));
  const deleteOwnedRows = chunkArray(departedIds, D1_SAFE_SQL_IN_CHUNK_SIZE).map((ids) =>
    db
      .prepare(
        `/* pharos:dews:stress-history-daily-replace */
         DELETE FROM stress_signal_history
          WHERE snapshot_date = ? AND stablecoin_id IN (${buildInClause(ids).sql})`,
      )
      .bind(snapshotDate, ...ids),
  );
  const insertRows = results.map((result) => [
    result.stablecoinId,
    snapshotDate,
    result.score,
    result.band,
    buildStressSignalsEnvelope(result),
  ]);
  // A daily row has no advancing run clock. Retained identical rows can stay
  // untouched when another member joins/leaves the exact admitted identity set.
  const insertStatements = chunkArray(insertRows, Math.floor(D1_MAX_BOUND_PARAMETERS / 5)).map((rows) =>
    db.prepare(
      `/* pharos:dews:stress-history-daily-seal */
       INSERT INTO stress_signal_history
         (stablecoin_id, snapshot_date, score, band, signals_json)
       VALUES ${rows.map(() => "(?, ?, ?, ?, ?)").join(", ")}
       ON CONFLICT(stablecoin_id, snapshot_date) DO UPDATE SET
         score = excluded.score, band = excluded.band, signals_json = excluded.signals_json
       WHERE stress_signal_history.score IS NOT excluded.score
          OR stress_signal_history.band IS NOT excluded.band
          OR stress_signal_history.signals_json IS NOT excluded.signals_json`,
    ).bind(...rows.flat()),
  );
  await executeAtomicBatch(db, [...deleteOwnedRows, ...insertStatements], { signal });

  const sealedIds = await readDailyStressHistoryIds(db, snapshotDate, signal);
  const sealedOwnedIds = new Set([...sealedIds].filter(
    (stablecoinId) => !FROZEN_IDS.has(stablecoinId) && !quarantinedStablecoinIds?.has(stablecoinId),
  ));
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

async function writeDewsGenerationRows(
  db: D1Database,
  target: keyof typeof DEWS_GENERATION_ROW_TARGETS,
  results: DewsComputedRow[],
  nowSec: number,
  signal?: AbortSignal,
): Promise<void> {
  if (results.length === 0) return;
  const spec = DEWS_GENERATION_ROW_TARGETS[target];
  const stmts = results.map((result) =>
    db
      .prepare(spec.sql)
      .bind(
        result.stablecoinId,
        nowSec,
        result.score,
        result.band,
        buildStressSignalsEnvelope(result),
        ...(spec.includeUpdatedAt ? [nowSec] : []),
      ),
  );
  await batchExecute(db, stmts, { signal });
}

async function readStressSignalIdsForGeneration(
  db: D1Database,
  table: "stress_signal_publication_rows" | "stress_signals_latest",
  nowSec: number,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        table === "stress_signal_publication_rows"
          ? "SELECT /* pharos:dews:publication-generation-ids */ stablecoin_id FROM stress_signal_publication_rows WHERE computed_at = ?"
          : "SELECT /* pharos:dews:stress-latest-generation-ids */ stablecoin_id FROM stress_signals_latest WHERE computed_at = ?",
      )
      .bind(nowSec)
      .all<{ stablecoin_id: string }>(),
    3,
    signal,
  );
  throwIfAborted(signal);
  return new Set(rows.results.map((row) => row.stablecoin_id));
}

/**
 * Ledger a generation that was computed but deliberately not published, so the
 * withheld cycle and the sources that caused it stay visible to publication
 * health instead of disappearing behind an unchanged pointer.
 */
async function recordWithheldDewsGeneration(
  db: D1Database,
  nowSec: number,
  candidateRows: number,
  degradedSources: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  await runWithOverloadRetry(() =>
    db
      .prepare(
        `/* pharos:dews:publication-generation-withheld */
         INSERT INTO surface_publication_generations
           (surface, generation_id, started_at, state, candidate_rows, expected_rows, failure_reason)
         VALUES ('dews', ?, ?, 'rejected', ?, ?, ?)
         ON CONFLICT(surface, generation_id) DO NOTHING`,
      )
      .bind(`dews:${nowSec}`, nowSec, candidateRows, candidateRows, `degraded-sources:${degradedSources.join(",")}`)
      .run(),
    3,
    signal,
  );
  throwIfAborted(signal);
}

export async function persistDewsResults(params: {
  db: D1Database;
  results: DewsComputedRow[];
  eligibleIds: Set<string>;
  noCurrentSupplyIds?: string[];
  quarantinedStablecoinIds?: string[];
  degradedSources: readonly string[];
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
  const publicationWithheld = params.degradedSources.length > 0;
  throwIfAborted(params.signal);
  if (params.results.length > 0) {
    // A withheld generation still advances `stress_signals_latest`, so an
    // accepted generation must compare its band/score with the last *published*
    // row (the tape only joins published generations). Withheld runs keep
    // comparing with latest so their diagnostic sample still records a change.
    const historyChangePredicate = publicationWithheld
      ? `OR EXISTS (
                    SELECT 1 FROM stress_signals_latest latest
                     WHERE latest.stablecoin_id = ?
                       AND (latest.band != ? OR ABS(latest.score - ?) >= 1)
                  )`
      : `OR EXISTS (
                    SELECT 1 FROM stress_signals published
                    JOIN surface_publication_generations publication
                      ON publication.surface = 'dews'
                     AND publication.generation_id = 'dews:' || CAST(published.computed_at AS TEXT)
                     AND publication.state = 'published'
                     WHERE published.stablecoin_id = ?
                       AND published.computed_at = (
                             SELECT MAX(candidate.computed_at)
                               FROM stress_signals candidate
                               JOIN surface_publication_generations candidate_publication
                                 ON candidate_publication.surface = 'dews'
                                AND candidate_publication.generation_id = 'dews:' || CAST(candidate.computed_at AS TEXT)
                                AND candidate_publication.state = 'published'
                              WHERE candidate.stablecoin_id = ?
                           )
                       AND (published.band != ? OR ABS(published.score - ?) >= 1)
                  )`;
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
               ${historyChangePredicate}`,
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
          ...(publicationWithheld
            ? [result.stablecoinId, result.band, result.score]
            : [result.stablecoinId, result.stablecoinId, result.band, result.score]),
        ),
    );
    await batchExecute(params.db, stmts, { signal: params.signal });
    throwIfAborted(params.signal);
    if (!publicationWithheld) {
      await writeDewsGenerationRows(params.db, "publication", params.results, params.nowSec, params.signal);
    }
    await writeDewsGenerationRows(params.db, "latest", params.results, params.nowSec, params.signal);
  }
  const computedIds = new Set(params.results.map((result) => result.stablecoinId));
  const noCurrentSupplyIds = (params.noCurrentSupplyIds ?? []).filter(
    (stablecoinId) => params.eligibleIds.has(stablecoinId) && !computedIds.has(stablecoinId),
  );
  const rowsRetiredCurrent = await deleteCurrentStressSignalRowsForIds(params.db, noCurrentSupplyIds, params.signal);
  await deleteLatestStressSignalRowsForIds(params.db, noCurrentSupplyIds, params.signal);
  const quarantinedStablecoinIds = new Set((params.quarantinedStablecoinIds ?? []).filter(
    (stablecoinId) => params.eligibleIds.has(stablecoinId) && !computedIds.has(stablecoinId),
  ));
  await deleteLatestStressSignalRowsForIds(params.db, quarantinedStablecoinIds, params.signal);

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
  if (params.results.length > 0 && publicationWithheld) {
    await recordWithheldDewsGeneration(
      params.db,
      params.nowSec,
      params.results.length,
      params.degradedSources,
      params.signal,
    );
  } else if (params.results.length > 0) {
    const currentGenerationIds = await readStressSignalIdsForGeneration(
      params.db,
      "stress_signal_publication_rows",
      params.nowSec,
      params.signal,
    );
    currentGenerationRows = currentGenerationIds.size;
    const latestGenerationIds = await readStressSignalIdsForGeneration(
      params.db,
      "stress_signals_latest",
      params.nowSec,
      params.signal,
    );
    latestGenerationRows = latestGenerationIds.size;
    const expectedRows = params.results.length;
    if (currentGenerationRows !== expectedRows) {
      throw new Error(
        `DEWS publication incomplete: stress_signal_publication_rows has ${currentGenerationRows}/${expectedRows} rows for ${params.nowSec}`,
      );
    }
    if (latestGenerationRows !== expectedRows) {
      throw new Error(
        `DEWS publication incomplete: stress_signals_latest has ${latestGenerationRows}/${expectedRows} rows for ${params.nowSec}`,
      );
    }
    if (computedIds.size !== expectedRows
      || !hasExactStablecoinIds(currentGenerationIds, computedIds)
      || !hasExactStablecoinIds(latestGenerationIds, computedIds)) {
      throw new Error(`DEWS publication identity mismatch for ${params.nowSec}`);
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

  if (publicationPointerWritten) {
    throwIfAborted(params.signal);
    await writeFreshnessSentinel(params.db, "dews", params.nowSec, `dews:${params.nowSec}`, params.signal);
    // History failure is visible to the caller, but cannot undo or invalidate
    // the already accepted current generation, ledger proof or freshness.
    const todayMidnight = startOfUtcDaySec(new Date());
    const dailySnapshot = await reconcileDailyDewsHistorySnapshot(
      params.db,
      params.results,
      todayMidnight,
      params.signal,
      quarantinedStablecoinIds,
    );
    if (dailySnapshot.rewritten) {
      logWorkerEventArgs("lib", "info",
        `[dews] Reconciled daily snapshot (${dailySnapshot.previousOwnedRowCount} -> ${dailySnapshot.sealedRowCount}) for ${formatUtcDateOnly(new Date(todayMidnight * 1000))}`,
      );
    }
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
