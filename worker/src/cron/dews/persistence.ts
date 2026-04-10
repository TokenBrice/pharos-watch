import { DAY_SECONDS } from "@shared/lib/time-constants";
import { batchExecute, buildInClause } from "../../lib/db";
import { chunkArray } from "../../lib/collections";
import { writeFreshnessSentinel } from "../../lib/db-cache";
import type { DewsComputedRow } from "./contracts";

const D1_SAFE_SQL_IN_CHUNK_SIZE = 90;
const DEWS_TABLES = new Set([
  "stress_signals",
  "stress_signal_history",
]);

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
  const orphanIds = (existingIds.results ?? [])
    .map((row) => row.stablecoin_id)
    .filter((stablecoinId) => !eligibleIds.has(stablecoinId));

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

function getTodayMidnightUtcSec(now = new Date()): number {
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
}

export async function persistDewsResults(params: {
  db: D1Database;
  results: DewsComputedRow[];
  eligibleIds: Set<string>;
  nowSec: number;
}): Promise<{ rowsDropped: number }> {
  if (params.results.length > 0) {
    const stmts = params.results.map((result) =>
      params.db
        .prepare(
          "INSERT OR REPLACE INTO stress_signals (stablecoin_id, computed_at, score, band, signals_json) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(result.stablecoinId, params.nowSec, result.score, result.band, JSON.stringify(result.signals)),
    );
    await batchExecute(params.db, stmts);
  }
  await writeFreshnessSentinel(params.db, "dews", params.nowSec);

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
        .bind(result.stablecoinId, todayMidnight, result.score, result.band, JSON.stringify(result.signals)),
    );
    await batchExecute(params.db, histStmts);
    console.log(
      `[dews] Reconciled daily snapshot (${existingCount} -> ${histStmts.length}) for ${new Date(todayMidnight * 1000).toISOString().slice(0, 10)}`,
    );
  }

  let rowsDropped = 0;
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

  return { rowsDropped };
}
