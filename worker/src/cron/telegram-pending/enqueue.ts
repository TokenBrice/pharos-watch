import { batchExecute } from "../../lib/db";
import type { BatchMessage } from "../../lib/telegram";
import {
  PENDING_TTL_SEC,
  TELEGRAM_ALERT_TTL_SEC,
  TELEGRAM_PENDING_PRIORITY,
} from "../../lib/telegram-constants";
import type { PendingEnqueueOptions } from "./types";
import { buildDedupeKey } from "./dedupe";
import type { TelegramAlertType } from "@shared/types/status";
import {
  isValidPendingSourceEventId,
  serializePendingAlertScope,
  serializePendingMarkupPolicy,
} from "../../lib/telegram-pending-provenance";

interface PendingProvenanceValues {
  sourceEventId: string | null;
  alertScopeJson: string | null;
  preferenceGeneration: number | null;
  markupPolicyJson: string | null;
}

function resolvePendingProvenance(
  message: BatchMessage,
  sourceType: "risk_alert" | "admin_broadcast" | "admin_replay" | "legacy",
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
  return {
    sourceEventId: message.sourceEventId,
    alertScopeJson: serializePendingAlertScope(message.alertScope),
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
  if (options.sourceType === "legacy") return TELEGRAM_PENDING_PRIORITY.legacy;
  return pendingPriorityForAlertType(message.alertType);
}

function resolvePendingSourceType(
  options: PendingEnqueueOptions,
): "risk_alert" | "admin_broadcast" | "admin_replay" | "legacy" {
  return options.sourceType ?? "risk_alert";
}

function resolvePendingTtlSec(message: BatchMessage, options: PendingEnqueueOptions): number {
  if (options.ttlSec != null && Number.isFinite(options.ttlSec) && options.ttlSec > 0) {
    return Math.floor(options.ttlSec);
  }
  if (options.sourceType === "admin_broadcast" || options.sourceType === "admin_replay") {
    return TELEGRAM_ALERT_TTL_SEC.adminBroadcast;
  }
  if (options.sourceType === "legacy") return TELEGRAM_ALERT_TTL_SEC.legacy;
  return message.alertType ? TELEGRAM_ALERT_TTL_SEC[message.alertType] : PENDING_TTL_SEC;
}

interface SqlFragment {
  sql: string;
  binds: readonly number[];
}

export interface PendingEnqueueGuard {
  sql: string;
  binds: readonly unknown[];
}

const SHOULD_REFRESH_EXISTING_ROW_SQL = [
  "COALESCE(telegram_pending_alerts.expires_at, telegram_pending_alerts.created_at + ?) <= excluded.created_at",
  "telegram_pending_alerts.created_at < excluded.created_at - ?",
].join(" OR ");

function refreshExistingRowPredicate(): SqlFragment {
  return {
    sql: SHOULD_REFRESH_EXISTING_ROW_SQL,
    binds: [PENDING_TTL_SEC, PENDING_TTL_SEC] as const,
  };
}

function refreshExistingRowCase(thenSql: string, elseSql: string): SqlFragment {
  const predicate = refreshExistingRowPredicate();
  return {
    sql: `CASE
             WHEN ${predicate.sql} THEN ${thenSql}
             ELSE ${elseSql}
           END`,
    binds: predicate.binds,
  };
}

function collectSqlBinds(...fragments: readonly SqlFragment[]): number[] {
  return fragments.flatMap((fragment) => [...fragment.binds]);
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
  const createdAtRefresh = refreshExistingRowCase("excluded.created_at", "telegram_pending_alerts.created_at");
  const attemptsRefresh = refreshExistingRowCase("0", "telegram_pending_alerts.attempts");
  const notBeforeRefresh = refreshExistingRowPredicate();
  const expiresAtRefresh = refreshExistingRowCase(
    "excluded.expires_at",
    "COALESCE(telegram_pending_alerts.expires_at, excluded.expires_at)",
  );
  const processingOwnerRefresh = refreshExistingRowCase("NULL", "telegram_pending_alerts.processing_owner");
  const processingStartedRefresh = refreshExistingRowCase("NULL", "telegram_pending_alerts.processing_started_at");
  const processingExpiresRefresh = refreshExistingRowCase("NULL", "telegram_pending_alerts.processing_expires_at");
  const deliveryOwnerRefresh = refreshExistingRowCase("NULL", "telegram_pending_alerts.delivery_owner");
  const deliveryStartedRefresh = refreshExistingRowCase("NULL", "telegram_pending_alerts.delivery_started_at");
  const deliveryCompletedRefresh = refreshExistingRowCase("NULL", "telegram_pending_alerts.delivery_completed_at");
  const deliveryClaimExpiresRefresh = refreshExistingRowCase("NULL", "telegram_pending_alerts.delivery_claim_expires_at");
  const sourceEventRefresh = refreshExistingRowCase(
    "excluded.source_event_id",
    "telegram_pending_alerts.source_event_id",
  );
  const alertScopeRefresh = refreshExistingRowCase(
    "excluded.alert_scope_json",
    "telegram_pending_alerts.alert_scope_json",
  );
  const preferenceGenerationRefresh = refreshExistingRowCase(
    "excluded.preference_generation",
    "telegram_pending_alerts.preference_generation",
  );
  const markupPolicyRefresh = refreshExistingRowCase(
    "excluded.markup_policy_json",
    "telegram_pending_alerts.markup_policy_json",
  );
  const refreshBinds = collectSqlBinds(
    createdAtRefresh,
    attemptsRefresh,
    notBeforeRefresh,
    expiresAtRefresh,
    processingOwnerRefresh,
    processingStartedRefresh,
    processingExpiresRefresh,
    deliveryOwnerRefresh,
    deliveryStartedRefresh,
    deliveryCompletedRefresh,
    deliveryClaimExpiresRefresh,
    sourceEventRefresh,
    alertScopeRefresh,
    preferenceGenerationRefresh,
    markupPolicyRefresh,
  );
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
    .prepare(
      `INSERT INTO telegram_pending_alerts (
           chat_id, message_html, disable_notification, created_at, not_before_at,
           last_error_class, retry_after_sec, updated_at, dedupe_key, chunk_index,
           priority, source_type, alert_type, expires_at, source_event_id,
           alert_scope_json, preference_generation, markup_policy_json
         )
         ${valuesSource}
         ON CONFLICT(dedupe_key) DO UPDATE SET
           message_html = excluded.message_html,
           disable_notification = excluded.disable_notification,
           created_at = ${createdAtRefresh.sql},
           attempts = ${attemptsRefresh.sql},
           not_before_at = CASE
             WHEN ${notBeforeRefresh.sql} THEN excluded.not_before_at
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
           expires_at = ${expiresAtRefresh.sql},
           processing_owner = ${processingOwnerRefresh.sql},
           processing_started_at = ${processingStartedRefresh.sql},
           processing_expires_at = ${processingExpiresRefresh.sql},
           delivery_owner = ${deliveryOwnerRefresh.sql},
           delivery_started_at = ${deliveryStartedRefresh.sql},
           delivery_completed_at = ${deliveryCompletedRefresh.sql},
           delivery_claim_expires_at = ${deliveryClaimExpiresRefresh.sql},
           source_event_id = ${sourceEventRefresh.sql},
           alert_scope_json = ${alertScopeRefresh.sql},
           preference_generation = ${preferenceGenerationRefresh.sql},
           markup_policy_json = ${markupPolicyRefresh.sql}
         WHERE telegram_pending_alerts.delivery_state = 'pending'
           AND (
             telegram_pending_alerts.processing_owner IS NULL
             OR telegram_pending_alerts.processing_expires_at IS NULL
             OR telegram_pending_alerts.processing_expires_at <= excluded.created_at
             OR COALESCE(
                  telegram_pending_alerts.expires_at,
                  telegram_pending_alerts.created_at + ${PENDING_TTL_SEC}
                ) <= excluded.created_at
             OR telegram_pending_alerts.created_at < excluded.created_at - ${PENDING_TTL_SEC}
           )`,
    )
    .bind(...values, ...(guard?.binds ?? []), ...refreshBinds);
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
