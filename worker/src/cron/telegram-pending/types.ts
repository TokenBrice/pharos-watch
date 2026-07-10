import type { BatchMessage, TelegramSendErrorClass } from "../../lib/telegram";
import type { TelegramAlertType } from "@shared/types/status";

export interface PendingAlertRow {
  id: number;
  chat_id: string;
  message_html: string;
  disable_notification: number;
  created_at: number;
  expires_at: number | null;
  attempts: number;
  not_before_at: number | null;
  priority: number | null;
  source_type: string | null;
  alert_type: TelegramAlertType | null;
  last_error_class: string | null;
  dedupe_key: string | null;
  chunk_index: number | null;
  source_event_id: string | null;
  alert_scope_json: string | null;
  preference_generation: number | null;
  markup_policy_json: string | null;
  alert_snooze_until_ts: number | null;
  quiet_hours_enabled: number | null;
  quiet_hours_start_utc: number | null;
  quiet_hours_end_utc: number | null;
  timezone: string | null;
}

export type PendingDeadLetterReason =
  | "ttl_expired"
  | "permanent_failure"
  | "max_attempts"
  | "blocked_disabled"
  | "preference_changed"
  | "manual_clear";

export interface DeadLetterPendingRow {
  id: number;
  chat_id: string;
  message_html: string;
  created_at: number;
  attempts: number | null;
  last_error_class?: string | null;
  dedupe_key?: string | null;
  chunk_index?: number | null;
  priority?: number | null;
  source_type?: string | null;
  alert_type?: string | null;
  source_event_id?: string | null;
  alert_scope_json?: string | null;
  preference_generation?: number | null;
  markup_policy_json?: string | null;
}

export interface PendingDrainResult {
  attempted: number;
  sent: number;
  blocked: number;
  blockedCleanedUp: number;
  blockedCleanupFailed: number;
  retryQueued: number;
  dropped: number;
  /** Drained rows dropped because Telegram returned a non-retryable, non-blocked error. */
  droppedPermanentFailure: number;
  /** Drained rows dropped because the defensive attempts ceiling was hit inside the TTL window. */
  droppedMaxAttemptsFallback: number;
  deferred: number;
  rateLimited: boolean;
  retryAfterSec: number | null;
  notBeforeAt: number | null;
}

export interface PendingEnqueueOptions {
  notBeforeAt?: number | null;
  lastErrorClass?: TelegramSendErrorClass | null;
  retryAfterSec?: number | null;
  sourceType?: "risk_alert" | "admin_broadcast" | "legacy";
  priority?: number | null;
  ttlSec?: number | null;
}

export interface PendingCapacitySnapshot {
  total: number;
  active: number;
  due: number;
  deferred: number;
  expired: number;
  nearTtl: number;
  sending: number;
  pendingExecutionUnknown: number;
  freshExecutionUnknown: number;
  executionUnknown: number;
  sentCleanup: number;
  oldestExecutionUnknownAgeSec: number | null;
  executionUnknownSampleLimit: number;
  executionUnknownLowerBound: boolean;
  oldestPendingAgeSec: number | null;
  oldestDuePendingAgeSec: number | null;
  estimatedDrainTimeSec: number;
  drainBudgetPerRun: number;
  dispatchIntervalSec: number;
}

export type PendingCapacityReadResult =
  | { status: "available"; value: PendingCapacitySnapshot }
  | { status: "unknown"; errorClass: "query_failed" };

export interface PendingRetryUpdate {
  id: number;
  retryAfterSec: number | null;
  errorClass: TelegramSendErrorClass | null;
  notBeforeAt: number | null;
}

export interface PendingDeferUpdate {
  id: number;
  notBeforeAt: number;
  reason?: string | null;
}

export interface PendingDeliveryDiagnostic {
  chatId: string;
  ok: boolean;
  errorClass?: string | null;
}

export function emptyDrainResult(): PendingDrainResult {
  return {
    attempted: 0,
    sent: 0,
    blocked: 0,
    blockedCleanedUp: 0,
    blockedCleanupFailed: 0,
    retryQueued: 0,
    dropped: 0,
    droppedPermanentFailure: 0,
    droppedMaxAttemptsFallback: 0,
    deferred: 0,
    rateLimited: false,
    retryAfterSec: null,
    notBeforeAt: null,
  };
}

export type PendingQueueMessage = BatchMessage;
