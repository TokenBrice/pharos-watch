import { batchExecute } from "../../lib/db";
import type { BatchMessage } from "../../lib/telegram";
import {
  PENDING_TTL_SEC,
  TELEGRAM_ALERT_TTL_SEC,
  TELEGRAM_PENDING_PRIORITY,
} from "../../lib/telegram-constants";
import type { PendingEnqueueOptions } from "./types";
import { buildDedupeKey } from "./dedupe";
import { buildPendingAlertUpsertSql } from "./upsert-sql";
import type { TelegramAlertType } from "@shared/types/status";
import {
  isValidPendingSourceEventId,
  serializePendingAlertScope,
  serializePendingMarkupPolicy,
} from "../../lib/telegram-pending-provenance";
import {
  TELEGRAM_RECAP_PENDING_PRIORITY,
  TELEGRAM_RECAP_TTL_SEC,
} from "@shared/lib/telegram-recap-policy";

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
