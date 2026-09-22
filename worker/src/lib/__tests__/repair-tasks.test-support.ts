import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { D1Database } from "@shared/types/cloudflare-runtime";
import { DDR_PUBLIC_PREDICTION_BACKSTOP_DELAY_SEC } from "@shared/lib/methodology-versions/depeg-resolver";
import {
  mockD1Strict,
  type MockD1Database,
  type MockTableConfig,
} from "@shared/test-utils/mock-d1";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import {
  DDR_FLAP_TOLERANT_MAX_INCIDENT_SPAN_SEC_V1,
  DDR_FLAP_TOLERANT_MAX_LINK_COUNT_V1,
  DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC,
} from "../depeg-resolver-incident-store";

const REPAIR_SCHEMA_SQL = ["0000_baseline.sql", "0228_depeg_resolver_incident_closed_pre_lock.sql"]
  .map((file) => readFileSync(join(process.cwd(), "worker/migrations", file), "utf8"))
  .join("\n");

const sql = (...parts: string[]): string => parts.join(" ");

const UPSERT_TASK_SQL = `INSERT INTO worker_repair_tasks (
  task_id, kind, subject_id, priority, state, attempt_count, next_attempt_at,
  payload_json, created_at, updated_at
) VALUES (?, ?, ?, ?, 'open', 0, ?, ?, ?, ?)
ON CONFLICT(task_id) DO UPDATE SET
  priority = excluded.priority,
  state = CASE WHEN worker_repair_tasks.state = 'closed' THEN 'open' ELSE worker_repair_tasks.state END,
  next_attempt_at = CASE WHEN worker_repair_tasks.state = 'failed' THEN worker_repair_tasks.next_attempt_at ELSE excluded.next_attempt_at END,
  payload_json = excluded.payload_json,
  closed_at = CASE WHEN worker_repair_tasks.state = 'closed' THEN NULL ELSE worker_repair_tasks.closed_at END,
  updated_at = excluded.updated_at`;

const CLOSE_TASKS_SQL = `UPDATE worker_repair_tasks
SET state = 'closed', locked_by = NULL, locked_until = NULL, updated_at = ?, closed_at = ?
WHERE kind = ?
  AND (state IN ('open', 'deferred') OR (state = 'failed' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)))
  AND subject_id NOT IN (?,?)`;

const SUMMARY_SQL = `SELECT COUNT(*) AS open_count, MIN(created_at) AS oldest_created_at, MIN(next_attempt_at) AS next_attempt_at
FROM worker_repair_tasks
WHERE kind = ? AND state IN ('open', 'claimed', 'deferred', 'failed')`;

const DETAILS_SQL = `SELECT subject_id, payload_json, updated_at,
  COUNT(*) OVER () AS total_count, MAX(updated_at) OVER () AS latest_updated_at
FROM worker_repair_tasks
WHERE kind = ? AND state IN ('open', 'claimed', 'deferred', 'failed')
ORDER BY CAST(subject_id AS INTEGER), subject_id
LIMIT 25`;

const PRUNE_SQL = `DELETE FROM worker_repair_tasks
WHERE rowid IN (
  SELECT rowid FROM worker_repair_tasks
  WHERE updated_at < ? AND state = 'closed'
  ORDER BY updated_at ASC LIMIT ?
)`;

const DUE_COUNT_SQL = `SELECT COUNT(*) AS due_count
FROM worker_repair_tasks
WHERE state IN ('open', 'deferred', 'failed') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`;

const STALE_COUNT_SQL = `SELECT COUNT(*) AS stale_claim_count
FROM worker_repair_tasks
WHERE state = 'claimed' AND (locked_until IS NULL OR locked_until <= ?)`;

const LIST_DUE_SQL = `SELECT task_id, subject_id, payload_json
FROM worker_repair_tasks
WHERE ((state IN ('open', 'deferred', 'failed') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)) OR (state = 'claimed' AND (locked_until IS NULL OR locked_until <= ?)))
  AND kind = ?
ORDER BY priority ASC, created_at ASC, task_id ASC
LIMIT ?`;

const CLAIM_TASK_SQL = `UPDATE worker_repair_tasks
SET state = 'claimed', attempt_count = attempt_count + 1, last_attempt_at = ?,
  locked_by = ?, locked_until = ?, updated_at = ?
WHERE task_id = ? AND kind = ?
  AND (
    (state IN ('open', 'deferred', 'failed') AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
    OR (state = 'claimed' AND (locked_until IS NULL OR locked_until <= ?))
  )`;

const SET_TASK_STATE_SQL = sql(
  "UPDATE worker_repair_tasks SET state = ?, next_attempt_at = ?, locked_by = NULL, locked_until = NULL,",
  "last_error = ?, updated_at = ? WHERE task_id = ? AND kind = ? AND ( (",
  "state = 'claimed' AND locked_by = ? AND locked_until >= ? ) OR (",
  "state = 'deferred' AND locked_by IS NULL AND locked_until IS NULL AND next_attempt_at IS NULL",
  "AND last_attempt_at = ? AND updated_at = ? ) )",
);


const safeCurrentEventSql = sql(
  "target.started_at > i.current_started_at AND (",
  `target.started_at - i.current_started_at <= ${DDR_PUBLIC_PREDICTION_BACKSTOP_DELAY_SEC} OR (`,
  "current_event.ended_at IS NOT NULL AND target.started_at >= current_event.ended_at",
  `AND target.started_at - current_event.ended_at <= ${DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC} ) ) AND (`,
  "i.closed_pre_lock_at IS NULL OR ( current_event.ended_at IS NOT NULL",
  `AND target.started_at >= current_event.ended_at AND target.started_at - current_event.ended_at <= ${DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC} ) )`,
  `AND target.started_at - i.first_started_at <= ${DDR_FLAP_TOLERANT_MAX_INCIDENT_SPAN_SEC_V1}`,
  "AND ( SELECT COUNT(*) FROM depeg_resolver_incident_event_links linked",
  `WHERE linked.incident_key = i.incident_key ) < ${DDR_FLAP_TOLERANT_MAX_LINK_COUNT_V1}`,
);

function authorizedPredecessor(alias: string, operation: string): string {
  return sql(
    `( SELECT 1 FROM depeg_resolver_event_repair_authorizations ${alias}_authorization`,
    `JOIN depeg_resolver_event_repair_authorization_consumptions ${alias}_consumption`,
    `ON ${alias}_consumption.authorization_id = ${alias}_authorization.id`,
    `AND ${alias}_consumption.event_id = ${alias}_authorization.event_id`,
    `AND ${alias}_consumption.incident_key = ${alias}_authorization.incident_key`,
    `AND ${alias}_consumption.operation = ${alias}_authorization.operation`,
    `WHERE ${alias}_authorization.id = ${alias}.repair_authorization_id`,
    `AND ${alias}_authorization.event_id = i.current_event_id`,
    `AND ${alias}_authorization.incident_key = i.incident_key`,
    `AND ${alias}_authorization.operation = '${operation}' )`,
  );
}

const predecessorLineageSql = sql(
  "EXISTS ( SELECT 1 FROM depeg_resolver_incident_event_links predecessor_link",
  "WHERE predecessor_link.incident_key = i.incident_key AND predecessor_link.event_id = i.current_event_id",
  `AND ( predecessor_link.repair_authorization_id IS NULL OR EXISTS ${authorizedPredecessor("predecessor_link", "incident_link")} ) )`,
  "AND EXISTS ( SELECT 1 FROM depeg_resolver_incident_revisions predecessor_revision",
  "WHERE predecessor_revision.incident_key = i.incident_key AND predecessor_revision.current_event_id = i.current_event_id",
  `AND ( predecessor_revision.repair_authorization_id IS NULL OR EXISTS ${authorizedPredecessor("predecessor_revision", "incident_current_update")} ) )`,
);

const CANDIDATE_SQL = sql(
  "SELECT i.incident_key, i.stablecoin_id, i.peg_currency, i.direction, i.first_event_id, i.current_event_id,",
  "i.first_started_at, i.current_started_at, i.first_observed_peak_bucket_bps, i.closed_pre_lock_at,",
  "i.superseded_by_incident_key, i.source_fingerprint, target.id AS target_event_id, target.stablecoin_id AS target_stablecoin_id,",
  "target.symbol AS target_symbol, target.peg_type AS target_peg_type, target.direction AS target_direction,",
  "target.started_at AS target_started_at, target.start_price AS target_start_price, target.peg_reference AS target_peg_reference,",
  "target.source AS target_source, current_event.ended_at AS current_event_ended_at FROM depeg_events target",
  "JOIN depeg_resolver_incidents i ON i.stablecoin_id = target.stablecoin_id AND i.direction = target.direction",
  "AND i.peg_currency = CASE WHEN target.peg_type LIKE 'pegged%' THEN substr(target.peg_type, 7) ELSE 'USD' END",
  "JOIN depeg_events current_event ON current_event.id = i.current_event_id WHERE target.id = ?",
  "AND target.source = 'live' AND i.incident_state = 'active' AND i.superseded_by_incident_key IS NULL",
  `AND ${safeCurrentEventSql} AND ${predecessorLineageSql}`,
  "AND EXISTS ( SELECT 1 FROM depeg_events_with_provenance canonical_target WHERE canonical_target.id = target.id",
  "AND canonical_target.stablecoin_id = target.stablecoin_id AND canonical_target.direction = target.direction",
  "AND canonical_target.started_at = target.started_at AND canonical_target.source = 'live' AND (",
  "canonical_target.provenance_audit_verdict IS NULL OR canonical_target.provenance_audit_verdict NOT IN ('false_positive', 'disputed', 'no_data') ) )",
  "AND NOT EXISTS ( SELECT 1 FROM depeg_resolver_incident_event_links existing_link WHERE existing_link.event_id = target.id )",
  "AND NOT EXISTS ( SELECT 1 FROM depeg_resolver_event_repair_authorizations existing_authorization WHERE existing_authorization.event_id = target.id )",
  "AND NOT EXISTS ( SELECT 1 FROM depeg_resolver_public_predictions prediction WHERE prediction.incident_key = i.incident_key )",
  "AND NOT EXISTS ( SELECT 1 FROM depeg_resolver_lock_opportunity_audit opportunity",
  "WHERE opportunity.incident_key = i.incident_key AND opportunity.action = 'pending' )",
  "ORDER BY i.current_started_at DESC, i.incident_key LIMIT 1",
);

const EXACT_SQL_BY_LEGACY_MATCH: Record<string, string> = {
  "DELETE FROM worker_repair_tasks": PRUNE_SQL,
  "COUNT(*) AS due_count": DUE_COUNT_SQL,
  "COUNT(*) AS stale_claim_count": STALE_COUNT_SQL,
  "SELECT task_id, subject_id, payload_json": LIST_DUE_SQL,
  "FROM depeg_events target": CANDIDATE_SQL,
  "COUNT(*) OVER ()": DETAILS_SQL,
  "FROM worker_repair_tasks": SUMMARY_SQL,
};

const REPAIR_TASK_RUNNER_TABLES: MockTableConfig[] = [
  { match: UPSERT_TASK_SQL, rows: [], allowUnused: true },
  { match: CLOSE_TASKS_SQL, rows: [], runMeta: { changes: 1 }, allowUnused: true },
  { match: DUE_COUNT_SQL, rows: [], allowUnused: true },
  { match: STALE_COUNT_SQL, rows: [], allowUnused: true },
  { match: LIST_DUE_SQL, rows: [], allowUnused: true },
  { match: CLAIM_TASK_SQL, rows: [], runMeta: { changes: 1 }, allowUnused: true },
  { match: SET_TASK_STATE_SQL, rows: [], runMeta: { changes: 1 }, allowUnused: true },
  {
    match: "SELECT state FROM worker_repair_tasks WHERE task_id = ? AND kind = ?",
    rows: [],
    first: { state: "closed" },
    allowUnused: true,
  },
];

export function mockRepairD1(
  overrides: MockTableConfig[] = [],
): MockD1Database {
  const exactOverrides = overrides.map((table) => ({
    ...table,
    match: EXACT_SQL_BY_LEGACY_MATCH[table.match] ?? table.match,
  }));
  return mockD1Strict([...exactOverrides, ...REPAIR_TASK_RUNNER_TABLES]);
}

export function makeSqliteD1() {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(REPAIR_SCHEMA_SQL);
    return Object.assign(createSqliteD1(sqlite), { sqlite, close: () => sqlite.close() });
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

export type SqliteD1 = D1Database & {
  sqlite: DatabaseSync;
  close: () => void;
};
