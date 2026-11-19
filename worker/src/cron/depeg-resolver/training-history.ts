import { DDR_INELIGIBLE_AUDIT_VERDICTS } from "@shared/types/depeg-audit";
import { auditVerdictNotInSql } from "../../lib/depeg-audit";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { HISTORICAL_ROW_CAP, TRAINING_ROLLUP_BACKFILL_EVENT_CAP } from "./constants";
import { formatDdrrFailure, placeholders } from "./utils";

export interface DdrTrainingHistoryRow {
  id: number;
  stablecoin_id: string;
  peg_type: string;
  direction: string;
  peak_deviation_bps: number;
  started_at: number;
  /** Null only for open events from `readDdrOpenTrainingHistory`. */
  ended_at: number | null;
  recovery_price: number | null;
  close_reason: string | null;
  peer_basis_json: string | null;
  first_price: number | null;
  last_price: number | null;
  peg_reference: number | null;
  first_seen_bps: number | null;
  last_seen_bps: number | null;
  last_seen_at: number | null;
  severity_observations_json: string | null;
}

const QUOTE_CLOCK_SQL =
  "CASE WHEN json_valid(a.row_json) THEN json_extract(a.row_json, '$.currentDeviationObservedAtSec') END";

function liveObservationsSql(closed: boolean): string {
  const samples =
    "json_group_array(json_object('observedAt', a.assessed_at, 'deviationBps', " +
    "CASE WHEN json_valid(a.row_json) THEN json_extract(a.row_json, '$.currentDeviationBps') END, " +
    `'quoteObservedAt', ${QUOTE_CLOCK_SQL}))`;
  return `(SELECT ${samples} FROM depeg_resolver_assessments a` +
    " WHERE a.event_id = h.id AND a.stablecoin_id = h.stablecoin_id " +
    "AND a.direction = h.direction AND a.started_at = h.started_at " +
    "AND a.assessed_at >= h.started_at" + (closed ? " AND a.assessed_at <= h.ended_at)" : ")");
}

// Only a reviewed repair with explicitly empty admitted evidence excludes the raw event.
const REVIEWED_TRAINING_EXCLUSION_SQL = `AND NOT (
  disposition IS 'repaired' AND COALESCE(json_array_length(
    CASE WHEN json_valid(admitted_coverage_json) THEN
      CASE WHEN json_type(admitted_coverage_json) = 'array' THEN admitted_coverage_json END END
  ) = 0, 0)
)`;

async function readWithDispositionCompatibility(
  read: (dispositionSql: string) => Promise<D1Result<DdrTrainingHistoryRow>>,
) {
  try {
    return await read(REVIEWED_TRAINING_EXCLUSION_SQL);
  } catch (error) {
    if (!(error instanceof Error) || !/no such column: (?:depeg_events_with_provenance\.)?(disposition|admitted_coverage_json|peer_basis_json)\b/i.test(error.message)) throw error;
    return read("");
  }
}

function historySql(directionCount: number, rollup: boolean, dispositionSql: string): string {
  const auditEligible = auditVerdictNotInSql("provenance_audit_verdict", DDR_INELIGIBLE_AUDIT_VERDICTS);
  // Route pre-0309 rollups through the same bounded refresh as a missing row.
  // json_type returns 'null' for an explicitly refreshed but undated sample.
  const observations = rollup
    ? "CASE WHEN r.stablecoin_id = h.stablecoin_id AND r.direction = h.direction " +
      "AND r.started_at = h.started_at AND r.ended_at = h.ended_at " +
      "THEN CASE WHEN json_array_length(r.severity_observations_json) > 0 " +
      "AND json_type(r.severity_observations_json, '$[0].quoteObservedAt') IS NULL " +
      "THEN NULL " +
      "ELSE r.severity_observations_json END END"
    : liveObservationsSql(true);
  return `/* pharos:ddr-training-history${rollup ? "" : "-live"} */ WITH history AS (` +
    "SELECT id, stablecoin_id, peg_type, direction, source, peak_deviation_bps, started_at, ended_at, recovery_price, close_reason, " +
    (dispositionSql ? "peer_basis_json " : "NULL AS peer_basis_json ") +
    "FROM depeg_events_with_provenance WHERE ended_at IS NOT NULL AND started_at >= ? " +
    `AND ${auditEligible.sql} ${dispositionSql} AND direction IN (${placeholders(directionCount)}) ` +
    `ORDER BY started_at ASC, id ASC LIMIT ${HISTORICAL_ROW_CAP}) ` +
    "SELECT h.*, p.first_seen_bps, p.last_seen_bps, p.last_seen_at, p.first_price, p.last_price, p.peg_reference, " +
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
    const result = await readWithDispositionCompatibility((dispositionSql) => runWithOverloadRetry(() =>
      db.prepare(historySql(directions.length, true, dispositionSql)).bind(...binds).all<DdrTrainingHistoryRow>()));
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
  const live = await readWithDispositionCompatibility((dispositionSql) => runWithOverloadRetry(() =>
    db.prepare(historySql(directions.length, false, dispositionSql)).bind(...binds).all<DdrTrainingHistoryRow>()));
  return live.results ?? [];
}

/** Open events are few (one per open source event); bound the read regardless. */
const OPEN_TRAINING_ROW_CAP = 500;

/**
 * DDRv5 censoring: still-open, audit-eligible events enter the duration
 * estimate as right-censored observations. They have no rollup row (the rollup
 * requires an end), so their timed observations use the live aggregate.
 */
export async function readDdrOpenTrainingHistory(
  db: D1Database,
  directions: readonly string[],
  windowStart: number,
): Promise<DdrTrainingHistoryRow[]> {
  if (directions.length === 0) return [];
  const auditEligible = auditVerdictNotInSql("provenance_audit_verdict", DDR_INELIGIBLE_AUDIT_VERDICTS);
  const sql = (dispositionSql: string) => "/* pharos:ddr-training-history-open */ WITH history AS (" +
    "SELECT id, stablecoin_id, peg_type, direction, source, peak_deviation_bps, started_at, ended_at, recovery_price, close_reason, " +
    (dispositionSql ? "peer_basis_json " : "NULL AS peer_basis_json ") +
    "FROM depeg_events_with_provenance WHERE ended_at IS NULL AND started_at >= ? " +
    `AND ${auditEligible.sql} ${dispositionSql} AND direction IN (${placeholders(directions.length)}) ` +
    `ORDER BY started_at DESC, id DESC LIMIT ${OPEN_TRAINING_ROW_CAP}) ` +
    "SELECT h.*, p.first_seen_bps, p.last_seen_bps, p.last_seen_at, p.first_price, p.last_price, p.peg_reference, " +
    liveObservationsSql(false) + " " +
    "AS severity_observations_json FROM history h " +
    "LEFT JOIN depeg_pending_outcomes p ON h.source = 'live' AND p.outcome = 'promoted' " +
    "AND p.stablecoin_id = h.stablecoin_id AND p.peg_type = h.peg_type AND p.direction = h.direction " +
    "AND p.first_seen_at = h.started_at " +
    "AND NOT EXISTS (SELECT 1 FROM depeg_pending_outcomes duplicate WHERE duplicate.outcome = 'promoted' " +
    "AND duplicate.stablecoin_id = p.stablecoin_id AND duplicate.peg_type = p.peg_type " +
    "AND duplicate.direction = p.direction AND duplicate.first_seen_at = p.first_seen_at AND duplicate.id != p.id) " +
    "ORDER BY h.started_at ASC, h.id ASC";
  const result = await readWithDispositionCompatibility((dispositionSql) => runWithOverloadRetry(() =>
    db.prepare(sql(dispositionSql)).bind(windowStart, ...auditEligible.binds, ...directions).all<DdrTrainingHistoryRow>()));
  return result.results ?? [];
}
