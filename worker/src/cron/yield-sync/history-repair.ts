import {
  YIELD_HISTORY_IDENTITY_TRANSITIONS,
} from "../../lib/yield-config/yield-history-identity-transitions";
import {
  DAY_SECONDS,
} from "@shared/lib/time-constants";
import {
  buildInClause,
} from "../../lib/db";
import {
  LEGACY_BEST_YIELD_SOURCE_KEY,
  YIELD_HISTORY_OWNERSHIP_HANDOFFS,
} from "../../lib/yield/yield-history-ownership-handoffs";

const OWNERSHIP_HANDOFF_DELETE_CHUNK_ROWS = 5_000;

const OWNERSHIP_HANDOFF_DELETE_MAX_ROWS_PER_RUN = 250_000;

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
        YIELD_HISTORY_IDENTITY_TRANSITIONS.linkedVariantFalseSwitchRepair.sql,
    )
    .bind(startSec - YIELD_HISTORY_IDENTITY_TRANSITIONS.linkedVariantFalseSwitchRepair.lookbackDays * DAY_SECONDS)
    .run();
  return result.meta?.changes ?? 0;
}
