import type { DatabaseSync } from "node:sqlite";
import type { Mock } from "vitest";
import type { MockTableConfig } from "@shared/test-utils/mock-d1";

export const DEFAULT_TELEGRAM_PENDING_D1_TABLES: MockTableConfig[] = [
  { match: "WHERE delivery_state = 'sending'", rows: [] },
  { match: "delivery_state = 'sent'", rows: [] },
  { match: "processing_owner = ?", rows: [] },
  { match: "SET attempts = attempts + 1", rows: [] },
  { match: "AND delivery_state = 'sending'", rows: [] },
  { match: "DELETE FROM telegram_preset_subscriptions", rows: [] },
  { match: "WHERE chat_id = ?", rows: [] },
  { match: "UPDATE telegram_recap_preferences", rows: [] },
  { match: "UPDATE telegram_recap_targets", rows: [] },
];

export type PendingAlertSeed = {
  id?: number | null;
  chatId: string;
  html: string;
  disableNotification?: number;
  createdAt?: number;
  attempts?: number;
  notBeforeAt?: number | null;
  dedupeKey?: string | null;
  chunkIndex?: number | null;
  priority?: number | null;
  sourceType?: string | null;
  alertType?: string | null;
  expiresAt?: number | null;
  updatedAt?: number;
  lastErrorClass?: string | null;
  retryAfterSec?: number | null;
  deliveryState?: "pending" | "sending" | "execution_unknown" | "sent_cleanup";
  deliveryOwner?: string | null;
  deliveryGeneration?: number;
  deliveryStartedAt?: number | null;
  deliveryCompletedAt?: number | null;
  deliveryClaimExpiresAt?: number | null;
  sourceEventId?: string | null;
  alertScopeJson?: string | null;
  preferenceGeneration?: number | null;
  markupPolicyJson?: string | null;
};

export function insertPendingSqlite(sqlite: DatabaseSync, row: PendingAlertSeed): void {
  const now = Math.floor(Date.now() / 1000);
  sqlite
    .prepare(
      `INSERT INTO telegram_pending_alerts (
       id, chat_id, message_html, disable_notification, created_at, attempts,
       not_before_at, dedupe_key, chunk_index, priority, source_type, alert_type,
       expires_at, updated_at, last_error_class, retry_after_sec, delivery_state,
       delivery_owner, delivery_generation, delivery_started_at, delivery_completed_at,
       delivery_claim_expires_at, source_event_id, alert_scope_json,
       preference_generation, markup_policy_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id ?? null,
      row.chatId,
      row.html,
      row.disableNotification ?? 0,
      row.createdAt ?? now,
      row.attempts ?? 0,
      row.notBeforeAt ?? null,
      row.dedupeKey ?? null,
      row.chunkIndex ?? 0,
      row.priority ?? 50,
      row.sourceType ?? "legacy",
      row.alertType ?? null,
      row.expiresAt ?? null,
      row.updatedAt ?? row.createdAt ?? now,
      row.lastErrorClass ?? null,
      row.retryAfterSec ?? null,
      row.deliveryState ?? "pending",
      row.deliveryOwner ?? null,
      row.deliveryGeneration ?? 0,
      row.deliveryStartedAt ?? null,
      row.deliveryCompletedAt ?? null,
      row.deliveryClaimExpiresAt ?? null,
      row.sourceEventId ?? null,
      row.alertScopeJson ?? null,
      row.preferenceGeneration ?? null,
      row.markupPolicyJson ?? null,
    );
}

export type TelegramDeliveryResult = {
  ok: boolean;
  blocked: boolean;
  retryable: boolean;
  permanentFailure: boolean;
  statusCode: number;
  errorClass: string | null;
  delivery: string;
  retryAfterSec: number | null;
  rateLimitScope?: "chat" | "global";
};

export function makeTelegramDeliveryResult(
  overrides: Partial<TelegramDeliveryResult> = {},
): TelegramDeliveryResult {
  return {
    ok: true,
    blocked: false,
    retryable: false,
    permanentFailure: false,
    statusCode: 200,
    errorClass: null,
    delivery: "sent",
    retryAfterSec: null,
    ...overrides,
  };
}

type TelegramPendingMockSet = {
  sendToChat: Mock;
  migrateTelegramChatId: Mock;
  transport: { claim: Mock; readPause: Mock; record: Mock };
  sendBatchSize: number;
};

/**
 * Reset the pending-queue mocks to their default allow-everything posture.
 *
 * The `vi.mock` factories and the mock identifiers themselves have to stay in
 * each suite because vitest hoists them per file, so the mocks are passed in
 * rather than owned here.
 */
export function resetTelegramPendingMocks({
  sendToChat,
  migrateTelegramChatId,
  transport,
  sendBatchSize,
}: TelegramPendingMockSet): void {
  sendToChat.mockReset();
  migrateTelegramChatId.mockReset().mockResolvedValue(undefined);
  transport.claim.mockReset().mockResolvedValue({
    allowed: true,
    mode: "pending",
    maxDistinctChats: sendBatchSize,
    reason: "closed",
    circuitGeneration: 0,
    probeOwner: null,
    probeGeneration: null,
    pauseGeneration: null,
    deferUntil: null,
  });
  transport.readPause.mockReset().mockResolvedValue(null);
  transport.record.mockReset().mockResolvedValue({ state: "closed", generation: 0 });
}
