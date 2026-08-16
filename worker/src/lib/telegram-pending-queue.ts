import { TELEGRAM_ALERT_TYPES, type TelegramAlertType } from "@shared/types/status";
import { TELEGRAM_RECAP_PENDING_PRIORITY, TELEGRAM_RECAP_TTL_SEC } from "@shared/lib/telegram-recap-policy";
import { fnv1a32 } from "@shared/lib/fnv1a";
import { batchExecute } from "./db";
import type { BatchMessage, TelegramSendErrorClass } from "./telegram";
import {
  PENDING_TTL_SEC,
  TELEGRAM_ALERT_TTL_SEC,
  TELEGRAM_PENDING_PRIORITY,
  TELEGRAM_SPLIT_VERSION,
} from "./telegram-constants";
import {
  isValidPendingSourceEventId,
  serializePendingAlertScope,
  serializePendingMarkupPolicy,
} from "./telegram-pending-provenance";

export interface PendingEnqueueOptions {
  notBeforeAt?: number | null;
  lastErrorClass?: TelegramSendErrorClass | null;
  retryAfterSec?: number | null;
  sourceType?: "risk_alert" | "personalized_recap" | "admin_broadcast" | "admin_replay" | "legacy";
  priority?: number | null;
  ttlSec?: number | null;
}

export type PendingQueueMessage = BatchMessage;

/** Base36 FNV-1a, kept compact because the dedupe key is a D1 row key. */
export function hashDedupePart(value: string): string {
  return fnv1a32(value).toString(36);
}

/**
 * Build a stable dedupe key for the pending queue.
 *
 * The hash covers the PRE-split canonical message body (falling back to the
 * chunk HTML only when callers have not plumbed `canonicalHtml` through, e.g.
 * legacy or test paths), tagged with {@link TELEGRAM_SPLIT_VERSION} so any
 * future change to the chunking algorithm cleanly invalidates old rows rather
 * than orphaning them. The chunk index keeps split parts distinct.
 */
export function buildDedupeKey(message: BatchMessage, splitVersion: number = TELEGRAM_SPLIT_VERSION): string {
  const canonical = message.canonicalHtml ?? message.html;
  return `${message.chatId}:v${splitVersion}:${message.chunkIndex ?? 0}:${hashDedupePart(canonical)}`;
}


/**
 * The single definition of the `telegram_pending_alerts` upsert.
 *
 * Two producers write the same row shape with the same conflict resolution:
 * `telegram-pending-queue.ts` (one row per bound `VALUES` tuple) and
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


interface PendingProvenanceValues {
  sourceEventId: string | null;
  alertScopeJson: string | null;
  preferenceGeneration: number | null;
  markupPolicyJson: string | null;
}

function resolvePendingProvenance(
  message: BatchMessage,
  sourceType: "risk_alert" | "personalized_recap" | "admin_broadcast" | "admin_replay" | "legacy",
): PendingProvenanceValues {
  if (sourceType === "admin_replay") {
    return {
      sourceEventId: null,
      alertScopeJson: null,
      preferenceGeneration: null,
      markupPolicyJson: serializePendingMarkupPolicy({
        replyMarkup: message.replyMarkup,
        linkPreviewOptions: message.linkPreviewOptions,
        disableWebPagePreview: message.disableWebPagePreview,
      }),
    };
  }
  if (sourceType !== "risk_alert") {
    if (sourceType === "personalized_recap") {
      if (
        !message.sourceEventId ||
        !isValidPendingSourceEventId(message.sourceEventId) ||
        !Number.isSafeInteger(message.preferenceGeneration) ||
        (message.preferenceGeneration ?? -1) < 0
      ) {
        throw new Error("Telegram personalized recap has incomplete provenance");
      }
      return {
        sourceEventId: message.sourceEventId,
        alertScopeJson: null,
        preferenceGeneration: message.preferenceGeneration ?? null,
        markupPolicyJson: serializePendingMarkupPolicy({
          replyMarkup: message.replyMarkup,
          linkPreviewOptions: message.linkPreviewOptions,
          disableWebPagePreview: message.disableWebPagePreview,
        }),
      };
    }
    return {
      sourceEventId: null,
      alertScopeJson: null,
      preferenceGeneration: null,
      markupPolicyJson: null,
    };
  }
  const fieldsPresent = [
    message.sourceEventId != null,
    message.alertScope != null,
    message.preferenceGeneration != null,
  ];
  if (fieldsPresent.every((present) => !present)) {
    // Existing cache entries and rolling-deploy producers predate provenance.
    return {
      sourceEventId: null,
      alertScopeJson: null,
      preferenceGeneration: null,
      markupPolicyJson: null,
    };
  }
  if (
    !fieldsPresent.every(Boolean) ||
    !message.sourceEventId ||
    !isValidPendingSourceEventId(message.sourceEventId) ||
    !Number.isSafeInteger(message.preferenceGeneration) ||
    (message.preferenceGeneration ?? -1) < 0 ||
    !message.alertScope
  ) {
    throw new Error("Telegram pending risk alert has incomplete provenance");
  }
  if (
    message.alertScope.some((item) => item.family === "safety") &&
    !message.safetyScoreIdentity
  ) {
    throw new Error("Telegram pending safety alert has no Safety Score identity");
  }
  return {
    sourceEventId: message.sourceEventId,
    alertScopeJson: serializePendingAlertScope(
      message.alertScope,
      message.safetyScoreIdentity,
    ),
    preferenceGeneration: message.preferenceGeneration ?? null,
    markupPolicyJson: serializePendingMarkupPolicy({
      replyMarkup: message.replyMarkup,
      linkPreviewOptions: message.linkPreviewOptions,
      disableWebPagePreview: message.disableWebPagePreview,
    }),
  };
}

function pendingPriorityForAlertType(alertType: TelegramAlertType | undefined): number {
  if (!alertType) return TELEGRAM_PENDING_PRIORITY.riskAlert;
  return TELEGRAM_PENDING_PRIORITY[alertType] ?? TELEGRAM_PENDING_PRIORITY.riskAlert;
}

function resolvePendingPriority(message: BatchMessage, options: PendingEnqueueOptions): number {
  if (options.priority != null && Number.isFinite(options.priority)) {
    return Math.max(0, Math.floor(options.priority));
  }
  if (options.sourceType === "admin_broadcast" || options.sourceType === "admin_replay") {
    return TELEGRAM_PENDING_PRIORITY.adminBroadcast;
  }
  if (options.sourceType === "personalized_recap") return TELEGRAM_RECAP_PENDING_PRIORITY;
  if (options.sourceType === "legacy") return TELEGRAM_PENDING_PRIORITY.legacy;
  return pendingPriorityForAlertType(message.alertType);
}

function resolvePendingSourceType(
  options: PendingEnqueueOptions,
): "risk_alert" | "personalized_recap" | "admin_broadcast" | "admin_replay" | "legacy" {
  return options.sourceType ?? "risk_alert";
}

function resolvePendingTtlSec(message: BatchMessage, options: PendingEnqueueOptions): number {
  if (options.ttlSec != null && Number.isFinite(options.ttlSec) && options.ttlSec > 0) {
    return Math.floor(options.ttlSec);
  }
  if (options.sourceType === "admin_broadcast" || options.sourceType === "admin_replay") {
    return TELEGRAM_ALERT_TTL_SEC.adminBroadcast;
  }
  if (options.sourceType === "personalized_recap") return TELEGRAM_RECAP_TTL_SEC;
  if (options.sourceType === "legacy") return TELEGRAM_ALERT_TTL_SEC.legacy;
  return message.alertType ? TELEGRAM_ALERT_TTL_SEC[message.alertType] : PENDING_TTL_SEC;
}

export interface PendingEnqueueGuard {
  sql: string;
  binds: readonly unknown[];
}

export function buildPendingAlertEnqueueStatement(
  db: D1Database,
  msg: BatchMessage,
  nowSec: number,
  options: PendingEnqueueOptions = {},
  guard?: PendingEnqueueGuard,
): D1PreparedStatement {
  const sourceType = resolvePendingSourceType(options);
  const provenance = resolvePendingProvenance(msg, sourceType);
  const expiresAt = nowSec + resolvePendingTtlSec(msg, options);
  const values = [
    msg.chatId,
    msg.html,
    msg.disableNotification ? 1 : 0,
    nowSec,
    options.notBeforeAt ?? null,
    options.lastErrorClass ?? null,
    options.retryAfterSec ?? null,
    nowSec,
    buildDedupeKey(msg),
    msg.chunkIndex ?? 0,
    resolvePendingPriority(msg, options),
    sourceType,
    msg.alertType ?? null,
    expiresAt,
    provenance.sourceEventId,
    provenance.alertScopeJson,
    provenance.preferenceGeneration,
    provenance.markupPolicyJson,
  ];
  const valuePlaceholders = values.map(() => "?").join(", ");
  const valuesSource = guard
    ? `SELECT ${valuePlaceholders} WHERE ${guard.sql}`
    : `VALUES (${valuePlaceholders})`;
  return db
    .prepare(buildPendingAlertUpsertSql(valuesSource))
    .bind(...values, ...(guard?.binds ?? []));
}

export async function enqueuePendingAlerts(
  db: D1Database,
  messages: BatchMessage[],
  nowSec: number,
  options: PendingEnqueueOptions = {},
): Promise<void> {
  if (messages.length === 0) return;
  const stmts = messages.map((message) => buildPendingAlertEnqueueStatement(db, message, nowSec, options));
  await batchExecute(db, stmts);
}
