import { DDR_INELIGIBLE_AUDIT_VERDICTS } from "@shared/types/depeg-audit";
import { auditVerdictNotInSql } from "../../lib/depeg-audit";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { HISTORICAL_ROW_CAP, TRAINING_ROLLUP_BACKFILL_EVENT_CAP } from "./constants";
import { formatDdrrFailure, placeholders } from "./utils";

export interface DdrTrainingHistoryRow {
  id: number;
  stablecoin_id: string;
  direction: string;
  peak_deviation_bps: number;
  started_at: number;
  ended_at: number;
  recovery_price: number | null;
  close_reason: string | null;
  first_seen_bps: number | null;
  last_seen_bps: number | null;
  last_seen_at: number | null;
  severity_observations_json: string | null;
}

/** The live path deliberately retains the pre-rollup aggregate verbatim. */
function historySql(directionCount: number, rollup: boolean): string {
  const auditEligible = auditVerdictNotInSql("provenance_audit_verdict", DDR_INELIGIBLE_AUDIT_VERDICTS);
  const observations = rollup
    ? "CASE WHEN r.stablecoin_id = h.stablecoin_id AND r.direction = h.direction " +
      "AND r.started_at = h.started_at AND r.ended_at = h.ended_at " +
      "THEN r.severity_observations_json END"
    : "(SELECT json_group_array(json_object('observedAt', a.assessed_at, 'deviationBps', " +
      "CASE WHEN json_valid(a.row_json) THEN json_extract(a.row_json, '$.currentDeviationBps') END)) " +
      "FROM depeg_resolver_assessments a WHERE a.event_id = h.id AND a.stablecoin_id = h.stablecoin_id " +
      "AND a.direction = h.direction AND a.started_at = h.started_at " +
      "AND a.assessed_at >= h.started_at AND a.assessed_at <= h.ended_at)";
  return `/* pharos:ddr-training-history${rollup ? "" : "-live"} */ WITH history AS (` +
    "SELECT id, stablecoin_id, peg_type, direction, source, peak_deviation_bps, started_at, ended_at, recovery_price, close_reason " +
    "FROM depeg_events_with_provenance WHERE ended_at IS NOT NULL AND started_at >= ? " +
    `AND ${auditEligible.sql} AND direction IN (${placeholders(directionCount)}) ` +
    `ORDER BY started_at ASC, id ASC LIMIT ${HISTORICAL_ROW_CAP}) ` +
    "SELECT h.*, p.first_seen_bps, p.last_seen_bps, p.last_seen_at, " +
    observations + " AS severity_observations_json FROM history h " +
    (rollup ? "LEFT JOIN depeg_resolver_training_corpus r ON r.event_id = h.id " : "") +
    "LEFT JOIN depeg_pending_outcomes p ON h.source = 'live' AND p.outcome = 'promoted' " +
    "AND p.stablecoin_id = h.stablecoin_id AND p.peg_type = h.peg_type AND p.direction = h.direction " +
    "AND p.first_seen_at = h.started_at " +
    "AND NOT EXISTS (SELECT 1 FROM depeg_pending_outcomes duplicate WHERE duplicate.outcome = 'promoted' " +
    "AND duplicate.stablecoin_id = p.stablecoin_id AND duplicate.peg_type = p.peg_type " +
    "AND duplicate.direction = p.direction AND duplicate.first_seen_at = p.first_seen_at AND duplicate.id != p.id) " +
    "ORDER BY h.started_at ASC, h.id ASC";
}

/**
 * Admit only a complete, identity-matched corpus from one SQLite snapshot.
 * Trigger-maintained rows make concurrent closes, repairs and assessment writes
 * atomic with this read. Never splice live samples into a partial rollup.
 */
export async function readDdrTrainingHistory(
  db: D1Database,
  directions: readonly string[],
  windowStart: number,
): Promise<DdrTrainingHistoryRow[]> {
  if (directions.length === 0) return [];
  const auditEligible = auditVerdictNotInSql("provenance_audit_verdict", DDR_INELIGIBLE_AUDIT_VERDICTS);
  const binds = [windowStart, ...auditEligible.binds, ...directions];
  try {
    const result = await runWithOverloadRetry(() => db.prepare(historySql(directions.length, true))
      .bind(...binds).all<DdrTrainingHistoryRow>());
    const rows = result.results ?? [];
    const ids: number[] = [];
    for (const row of rows) {
      if (row.severity_observations_json == null) {
        ids.push(row.id);
        if (ids.length === TRAINING_ROLLUP_BACKFILL_EVENT_CAP) break;
      }
    }
    if (ids.length === 0) return rows;

    // Only repair ids already found by the bounded training read. No full-table
    // anti-join/count and no unbounded migration-time backfill. Re-read source
    // rows inside this statement, not the earlier snapshot's identity/JSON.
    await runWithOverloadRetry(() => db.prepare(
      "/* pharos:ddr-training-backfill */ INSERT OR REPLACE INTO depeg_resolver_training_corpus " +
      "SELECT * FROM depeg_resolver_training_observations WHERE event_id IN (SELECT value FROM json_each(?))",
    ).bind(JSON.stringify(ids)).run());
  } catch (error) {
    // Missing/unreadable rollup or a failed repair must not discard the corpus.
    console.warn(`[ddr] training-rollup-unavailable:${formatDdrrFailure(error)}`);
  }
  const live = await runWithOverloadRetry(() => db.prepare(historySql(directions.length, false))
    .bind(...binds).all<DdrTrainingHistoryRow>());
  return live.results ?? [];
}
