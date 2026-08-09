import { TELEGRAM_ALERT_TYPES } from "@shared/types/status";
import { PENDING_TTL_SEC, TELEGRAM_PENDING_PRIORITY } from "../../lib/telegram-constants";

/**
 * The single definition of the `telegram_pending_alerts` upsert.
 *
 * Two producers write the same row shape with the same conflict resolution:
 * `telegram-pending/enqueue.ts` (one row per bound `VALUES` tuple) and
 * `telegram-alert-target-plans/delivery.ts` (a set-based
 * `SELECT ... FROM telegram_alert_job_targets`). Only the value source differs,
 * so it is the builder's one parameter — the column list, the TTL refresh
 * predicate, the refresh/keep rules and the claim guard are generated here and
 * are therefore byte-identical for both callers.
 */

/** Insert column list, in bind order for the `VALUES` form. */
export const PENDING_ALERT_UPSERT_COLUMNS = [
  "chat_id",
  "message_html",
  "disable_notification",
  "created_at",
  "not_before_at",
  "last_error_class",
  "retry_after_sec",
  "updated_at",
  "dedupe_key",
  "chunk_index",
  "priority",
  "source_type",
  "alert_type",
  "expires_at",
  "source_event_id",
  "alert_scope_json",
  "preference_generation",
  "markup_policy_json",
] as const;

const COLUMN_LIST_SQL = `chat_id, message_html, disable_notification, created_at, not_before_at,
           last_error_class, retry_after_sec, updated_at, dedupe_key, chunk_index,
           priority, source_type, alert_type, expires_at, source_event_id,
           alert_scope_json, preference_generation, markup_policy_json`;

/**
 * True when the stored row has aged past its TTL (or past `PENDING_TTL_SEC`
 * since creation) and the incoming row should therefore replace it outright
 * instead of merging into it. `PENDING_TTL_SEC` is a module constant, so it is
 * inlined rather than bound — that keeps both producers' text identical and
 * keeps 30 bound parameters off every enqueue statement.
 */
const REFRESH_EXISTING_ROW_PREDICATE = [
  `COALESCE(
               telegram_pending_alerts.expires_at,
               telegram_pending_alerts.created_at + ${PENDING_TTL_SEC}
             ) <= excluded.created_at`,
  `telegram_pending_alerts.created_at < excluded.created_at - ${PENDING_TTL_SEC}`,
].join("\n             OR ");

function refreshCase(onRefresh: string, otherwise: string): string {
  return `CASE
             WHEN ${REFRESH_EXISTING_ROW_PREDICATE}
             THEN ${onRefresh}
             ELSE ${otherwise}
           END`;
}

/** Columns replaced on a TTL refresh and preserved otherwise, in SET order. */
const REFRESHED_COLUMNS: ReadonlyArray<{ column: string; onRefresh: string }> = [
  { column: "expires_at", onRefresh: "excluded.expires_at" },
  { column: "processing_owner", onRefresh: "NULL" },
  { column: "processing_started_at", onRefresh: "NULL" },
  { column: "processing_expires_at", onRefresh: "NULL" },
  { column: "delivery_owner", onRefresh: "NULL" },
  { column: "delivery_started_at", onRefresh: "NULL" },
  { column: "delivery_completed_at", onRefresh: "NULL" },
  { column: "delivery_claim_expires_at", onRefresh: "NULL" },
  { column: "source_event_id", onRefresh: "excluded.source_event_id" },
  { column: "alert_scope_json", onRefresh: "excluded.alert_scope_json" },
  { column: "preference_generation", onRefresh: "excluded.preference_generation" },
  { column: "markup_policy_json", onRefresh: "excluded.markup_policy_json" },
];

function refreshedColumnAssignments(): string {
  return REFRESHED_COLUMNS.map(({ column, onRefresh }) => {
    // `expires_at` keeps the stored value when present; the rest fall back to
    // the stored column verbatim.
    const otherwise = column === "expires_at"
      ? "COALESCE(telegram_pending_alerts.expires_at, excluded.expires_at)"
      : `telegram_pending_alerts.${column}`;
    return `${column} = ${refreshCase(onRefresh, otherwise)}`;
  }).join(",\n           ");
}

/**
 * Priority CASE generated from `TELEGRAM_PENDING_PRIORITY` over the canonical
 * `TELEGRAM_ALERT_TYPES` membership, so a newly registered alert family cannot
 * silently fall through to the generic `riskAlert` priority.
 */
export function pendingPrioritySql(alertTypeExpression: string): string {
  const arms = TELEGRAM_ALERT_TYPES.map(
    (alertType) => `    WHEN '${alertType}' THEN ${TELEGRAM_PENDING_PRIORITY[alertType]}`,
  ).join("\n");
  return `CASE ${alertTypeExpression}
${arms}
    ELSE ${TELEGRAM_PENDING_PRIORITY.riskAlert}
  END`;
}

/**
 * Builds the full upsert. `valuesSource` is the complete SQL between the insert
 * column list and `ON CONFLICT` — either `VALUES (...)` or a `SELECT ... FROM`.
 */
export function buildPendingAlertUpsertSql(valuesSource: string): string {
  return `INSERT INTO telegram_pending_alerts (
           ${COLUMN_LIST_SQL}
         )
         ${valuesSource}
         ON CONFLICT(dedupe_key) DO UPDATE SET
           message_html = excluded.message_html,
           disable_notification = excluded.disable_notification,
           created_at = ${refreshCase("excluded.created_at", "telegram_pending_alerts.created_at")},
           attempts = ${refreshCase("0", "telegram_pending_alerts.attempts")},
           not_before_at = CASE
             WHEN ${REFRESH_EXISTING_ROW_PREDICATE} THEN excluded.not_before_at
             WHEN excluded.not_before_at IS NULL THEN telegram_pending_alerts.not_before_at
             WHEN telegram_pending_alerts.not_before_at IS NULL THEN excluded.not_before_at
             ELSE MAX(telegram_pending_alerts.not_before_at, excluded.not_before_at)
           END,
           last_error_class = COALESCE(excluded.last_error_class, telegram_pending_alerts.last_error_class),
           retry_after_sec = COALESCE(excluded.retry_after_sec, telegram_pending_alerts.retry_after_sec),
           updated_at = excluded.updated_at,
           chunk_index = excluded.chunk_index,
           priority = MIN(COALESCE(telegram_pending_alerts.priority, excluded.priority), excluded.priority),
           source_type = CASE
             WHEN excluded.priority < COALESCE(telegram_pending_alerts.priority, excluded.priority)
             THEN excluded.source_type
             ELSE telegram_pending_alerts.source_type
           END,
           alert_type = COALESCE(excluded.alert_type, telegram_pending_alerts.alert_type),
           ${refreshedColumnAssignments()}
         WHERE telegram_pending_alerts.delivery_state = 'pending'
           AND (
             telegram_pending_alerts.processing_owner IS NULL
             OR telegram_pending_alerts.processing_expires_at IS NULL
             OR telegram_pending_alerts.processing_expires_at <= excluded.created_at
             OR ${REFRESH_EXISTING_ROW_PREDICATE}
           )`;
}
