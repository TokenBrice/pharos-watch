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
  delivery_state: PendingDeliveryState;
  delivery_owner: string | null;
  delivery_generation: number;
  delivery_started_at: number | null;
  delivery_completed_at: number | null;
  delivery_claim_expires_at: number | null;
  alert_snooze_until_ts: number | null;
  quiet_hours_enabled: number | null;
  quiet_hours_start_utc: number | null;
  quiet_hours_end_utc: number | null;
  timezone: string | null;
}

export type PendingDeliveryState = "pending" | "sending" | "sent" | "execution_unknown";

export interface PendingDeliveryClaim {
  id: number;
  owner: string;
  generation: number;
}

export type PendingDeadLetterReason =
  | "ttl_expired"
  | "permanent_failure"
  | "max_attempts"
  | "blocked_disabled"
  | "preference_changed"
  | "execution_unknown_archived"
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
  delivery_state?: PendingDeliveryState | null;
  delivery_owner?: string | null;
  delivery_generation?: number | null;
  delivery_started_at?: number | null;
  delivery_completed_at?: number | null;
  delivery_claim_expires_at?: number | null;
}

export interface PendingDrainResult {
  attempted: number;
  sent: number;
  /** Exact distinct chats with at least one Bot API-accepted message in this drain. */
  acceptedChats: number;
  blocked: number;
  blockedCleanedUp: number;
  blockedCleanupFailed: number;
  retryQueued: number;
  executionUnknown: number;
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
  sourceType?: "risk_alert" | "personalized_recap" | "admin_broadcast" | "admin_replay" | "legacy";
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
  pendingSending?: number;
  freshSending?: number;
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

export interface PendingRetryUpdate extends PendingDeliveryClaim {
  retryAfterSec: number | null;
  errorClass: TelegramSendErrorClass | null;
  notBeforeAt: number | null;
}

export interface PendingDeferUpdate {
  id: number;
  notBeforeAt: number;
  reason?: string | null;
  deliveryClaim?: PendingDeliveryClaim;
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
    acceptedChats: 0,
    blocked: 0,
    blockedCleanedUp: 0,
    blockedCleanupFailed: 0,
    retryQueued: 0,
    executionUnknown: 0,
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
