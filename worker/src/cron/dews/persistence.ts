import { DAY_SECONDS } from "@shared/lib/time-constants";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { batchExecute, buildInClause } from "../../lib/db";
import { chunkArray } from "../../lib/collections";
import { writeFreshnessSentinel } from "../../lib/db-cache";
import { runWithOverloadRetry } from "../../lib/cron-lease";
import type { DewsComputedRow } from "./contracts";

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
  frozenIds: Set<string> = FROZEN_IDS,
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
  options: { ignoreMissingTable?: boolean } = {},
): Promise<number> {
  if (!DEWS_TABLES.has(table)) throw new Error(`Invalid DEWS table: ${table}`);

  let existingIds: D1Result<{ stablecoin_id: string }>;
  try {
    existingIds = await runWithOverloadRetry(() =>
      db
        // SAFETY: validated against DEWS_TABLES allowlist above.
        .prepare(`/* pharos:dews:orphan-ids:${table} */ SELECT DISTINCT stablecoin_id FROM ${table}`)
        .all<{ stablecoin_id: string }>(),
    );
  } catch (error) {
    if (options.ignoreMissingTable && isMissingStressLatestTableError(error)) return 0;
    throw error;
  }
  const allDbIds = new Set((existingIds.results ?? []).map((row) => row.stablecoin_id));
  const orphanIds = [...computeStressSignalPruneIds(allDbIds, eligibleIds)];

  if (orphanIds.length === 0) return 0;

  return deleteStablecoinRowsByIdChunks(db, orphanIds, {
    ignoreMissingTable: options.ignoreMissingTable,
    buildSql: (inClauseSql) =>
      // SAFETY: validated against DEWS_TABLES allowlist above.
      `/* pharos:dews:orphan-delete:${table} */ DELETE FROM ${table} WHERE stablecoin_id IN (${inClauseSql})`,
  });
}

function isMissingStressLatestTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("no such table: stress_signals_latest");
}

async function deleteStablecoinRowsByIdChunks(
  db: D1Database,
  stablecoinIds: Iterable<string>,
  options: {
    buildSql: (inClauseSql: string) => string;
    ignoreMissingTable?: boolean;
  },
): Promise<number> {
  const ids = [...new Set(stablecoinIds)];
  if (ids.length === 0) return 0;

  let deleted = 0;
  for (const idChunk of chunkArray(ids, D1_SAFE_SQL_IN_CHUNK_SIZE)) {
    const inClause = buildInClause(idChunk);
    try {
      const result = await runWithOverloadRetry(() =>
        db
          .prepare(options.buildSql(inClause.sql))
          .bind(...inClause.binds)
          .run(),
      );
      deleted += result.meta?.changes ?? 0;
    } catch (error) {
      if (options.ignoreMissingTable && isMissingStressLatestTableError(error)) return deleted;
      throw error;
    }
  }
  return deleted;
}

async function deleteCurrentStressSignalRowsForIds(
  db: D1Database,
  stablecoinIds: Iterable<string>,
): Promise<number> {
  return deleteStablecoinRowsByIdChunks(db, stablecoinIds, {
    buildSql: (inClauseSql) =>
      `/* pharos:dews:stress-current-delete */ DELETE FROM stress_signals WHERE stablecoin_id IN (${inClauseSql})`,
  });
}

async function deleteLatestStressSignalRowsForIds(
  db: D1Database,
  stablecoinIds: Iterable<string>,
): Promise<number> {
  return deleteStablecoinRowsByIdChunks(db, stablecoinIds, {
    ignoreMissingTable: true,
    buildSql: (inClauseSql) =>
      `/* pharos:dews:stress-latest-delete */ DELETE FROM stress_signals_latest WHERE stablecoin_id IN (${inClauseSql})`,
  });
}

function getTodayMidnightUtcSec(now = new Date()): number {
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
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

async function upsertLatestStressSignalRows(
  db: D1Database,
  results: DewsComputedRow[],
  nowSec: number,
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
  try {
    await batchExecute(db, stmts);
  } catch (error) {
    if (isMissingStressLatestTableError(error)) return;
    throw error;
  }
}

export async function persistDewsResults(params: {
  db: D1Database;
  results: DewsComputedRow[];
  eligibleIds: Set<string>;
  noCurrentSupplyIds?: string[];
  nowSec: number;
}): Promise<{ rowsDropped: number; rowsRetiredCurrent: number }> {
  if (params.results.length > 0) {
    const stmts = params.results.map((result) =>
      params.db
        .prepare(
          `/* pharos:dews:stress-current-upsert */
           INSERT OR REPLACE INTO stress_signals (stablecoin_id, computed_at, score, band, signals_json)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          result.stablecoinId,
          params.nowSec,
          result.score,
          result.band,
          buildStressSignalsEnvelope(result),
        ),
    );
    await batchExecute(params.db, stmts);
    await upsertLatestStressSignalRows(params.db, params.results, params.nowSec);
  }
  await writeFreshnessSentinel(params.db, "dews", params.nowSec);

  const computedIds = new Set(params.results.map((result) => result.stablecoinId));
  const noCurrentSupplyIds = (params.noCurrentSupplyIds ?? []).filter(
    (stablecoinId) => params.eligibleIds.has(stablecoinId) && !computedIds.has(stablecoinId),
  );
  const rowsRetiredCurrent = await deleteCurrentStressSignalRowsForIds(params.db, noCurrentSupplyIds);
  await deleteLatestStressSignalRowsForIds(params.db, noCurrentSupplyIds);

  const todayMidnight = getTodayMidnightUtcSec();
  const existing = await runWithOverloadRetry(() =>
    params.db
      .prepare("SELECT COUNT(*) as cnt FROM stress_signal_history WHERE snapshot_date = ?")
      .bind(todayMidnight)
      .first<{ cnt: number }>(),
  );
  const existingCount = existing?.cnt ?? 0;

  if (params.results.length > 0 && existingCount < params.results.length) {
    const histStmts = params.results.map((result) =>
      params.db
        .prepare(
          "INSERT OR REPLACE INTO stress_signal_history (stablecoin_id, snapshot_date, score, band, signals_json) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(
          result.stablecoinId,
          todayMidnight,
          result.score,
          result.band,
          buildStressSignalsEnvelope(result),
        ),
    );
    await batchExecute(params.db, histStmts);
    console.log(
      `[dews] Reconciled daily snapshot (${existingCount} -> ${histStmts.length}) for ${new Date(todayMidnight * 1000).toISOString().slice(0, 10)}`,
    );
  }

  let rowsDropped = rowsRetiredCurrent;
  if (params.eligibleIds.size > 0) {
    rowsDropped += await deleteOrphansForTable(params.db, "stress_signals", params.eligibleIds);
    rowsDropped += await deleteOrphansForTable(params.db, "stress_signals_latest", params.eligibleIds, {
      ignoreMissingTable: true,
    });
    rowsDropped += await deleteOrphansForTable(params.db, "stress_signal_history", params.eligibleIds);
  }

  const frozenIdsList = [...FROZEN_IDS];
  const frozenClause =
    frozenIdsList.length > 0 ? `AND stablecoin_id NOT IN (${frozenIdsList.map(() => "?").join(",")})` : "";

  const oldSignals = await runWithOverloadRetry(() =>
    params.db
      .prepare(`/* pharos:dews:stress-current-prune-old */ DELETE FROM stress_signals WHERE computed_at < ? ${frozenClause}`)
      .bind(params.nowSec - 7 * DAY_SECONDS, ...frozenIdsList)
      .run(),
  );
  rowsDropped += oldSignals.meta?.changes ?? 0;

  const oldHistory = await runWithOverloadRetry(() =>
    params.db
      .prepare(`/* pharos:dews:stress-history-prune-old */ DELETE FROM stress_signal_history WHERE snapshot_date < ? ${frozenClause}`)
      .bind(params.nowSec - 365 * DAY_SECONDS, ...frozenIdsList)
      .run(),
  );
  rowsDropped += oldHistory.meta?.changes ?? 0;

  return { rowsDropped, rowsRetiredCurrent };
}
