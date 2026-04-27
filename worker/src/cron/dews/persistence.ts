import { DAY_SECONDS } from "@shared/lib/time-constants";
import { FROZEN_IDS } from "@shared/lib/stablecoins";
import { batchExecute, buildInClause } from "../../lib/db";
import { chunkArray } from "../../lib/collections";
import { writeFreshnessSentinel } from "../../lib/db-cache";
import type { DewsComputedRow } from "./contracts";

const D1_SAFE_SQL_IN_CHUNK_SIZE = 90;
const DEWS_TABLES = new Set([
  "stress_signals",
  "stress_signal_history",
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
): Promise<number> {
  if (!DEWS_TABLES.has(table)) throw new Error(`Invalid DEWS table: ${table}`);

  const existingIds = await db
    // SAFETY: validated against DEWS_TABLES allowlist above.
    .prepare(`SELECT DISTINCT stablecoin_id FROM ${table}`)
    .all<{ stablecoin_id: string }>();
  const allDbIds = new Set((existingIds.results ?? []).map((row) => row.stablecoin_id));
  const orphanIds = [...computeStressSignalPruneIds(allDbIds, eligibleIds)];

  if (orphanIds.length === 0) return 0;

  let deleted = 0;
  for (const idChunk of chunkArray(orphanIds, D1_SAFE_SQL_IN_CHUNK_SIZE)) {
    const inClause = buildInClause(idChunk);
    const result = await db
      // SAFETY: validated against DEWS_TABLES allowlist above.
      .prepare(`DELETE FROM ${table} WHERE stablecoin_id IN (${inClause.sql})`)
      .bind(...inClause.binds)
      .run();
    deleted += result.meta?.changes ?? 0;
  }
  return deleted;
}

async function deleteCurrentStressSignalRowsForIds(
  db: D1Database,
  stablecoinIds: Iterable<string>,
): Promise<number> {
  const ids = [...new Set(stablecoinIds)];
  if (ids.length === 0) return 0;

  let deleted = 0;
  for (const idChunk of chunkArray(ids, D1_SAFE_SQL_IN_CHUNK_SIZE)) {
    const inClause = buildInClause(idChunk);
    const result = await db
      .prepare(`DELETE FROM stress_signals WHERE stablecoin_id IN (${inClause.sql})`)
      .bind(...inClause.binds)
      .run();
    deleted += result.meta?.changes ?? 0;
  }
  return deleted;
}

function getTodayMidnightUtcSec(now = new Date()): number {
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
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
          "INSERT OR REPLACE INTO stress_signals (stablecoin_id, computed_at, score, band, signals_json) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(
          result.stablecoinId,
          params.nowSec,
          result.score,
          result.band,
          JSON.stringify({ signals: result.signals, amplifiers: result.amplifiers }),
        ),
    );
    await batchExecute(params.db, stmts);
  }
  await writeFreshnessSentinel(params.db, "dews", params.nowSec);

  const computedIds = new Set(params.results.map((result) => result.stablecoinId));
  const noCurrentSupplyIds = (params.noCurrentSupplyIds ?? []).filter(
    (stablecoinId) => params.eligibleIds.has(stablecoinId) && !computedIds.has(stablecoinId),
  );
  const rowsRetiredCurrent = await deleteCurrentStressSignalRowsForIds(params.db, noCurrentSupplyIds);

  const todayMidnight = getTodayMidnightUtcSec();
  const existing = await params.db
    .prepare("SELECT COUNT(*) as cnt FROM stress_signal_history WHERE snapshot_date = ?")
    .bind(todayMidnight)
    .first<{ cnt: number }>();
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
          JSON.stringify({ signals: result.signals, amplifiers: result.amplifiers }),
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
    rowsDropped += await deleteOrphansForTable(params.db, "stress_signal_history", params.eligibleIds);
  }

  const oldSignals = await params.db
    .prepare("DELETE FROM stress_signals WHERE computed_at < ?")
    .bind(params.nowSec - 7 * DAY_SECONDS)
    .run();
  rowsDropped += oldSignals.meta?.changes ?? 0;

  const oldHistory = await params.db
    .prepare("DELETE FROM stress_signal_history WHERE snapshot_date < ?")
    .bind(params.nowSec - 365 * DAY_SECONDS)
    .run();
  rowsDropped += oldHistory.meta?.changes ?? 0;

  return { rowsDropped, rowsRetiredCurrent };
}
