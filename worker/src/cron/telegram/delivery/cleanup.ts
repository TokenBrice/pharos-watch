import {
  PENDING_TTL_SEC,
  TELEGRAM_PENDING_EXECUTION_UNKNOWN_RETENTION_SEC,
  TELEGRAM_CHAT_BACKOFF_CACHE_PREFIX,
} from "../../../telegram/common/constants";
import { logTelegramEvent } from "../../../telegram/common/log";
import {
  settleUnstartedPendingRows,
  deadLetterTerminalPendingRows,
  PENDING_DELETE_CHUNK_SIZE,
} from "./dead-letter";
import type { DeadLetterPendingRow } from "./types";
import {
  recordTelegramJobTargetFinalDelivery,
  type TelegramTargetFinalDeliveryState,
} from "./telegram-alert-job-target-outcomes";
import { projectRecapPendingTerminalOutcome } from "./recap-terminal";

type SelectablePendingRow = DeadLetterPendingRow & { processing_owner?: string | null };
type ExpiredPendingRow = SelectablePendingRow & { expires_at?: number | null };
export const TELEGRAM_PENDING_SENT_RETENTION_SEC = 24 * 60 * 60;

export interface DisabledChatPendingCleanupResult {
  deleted: number;
  failed: boolean;
}

const PENDING_ALERT_DEAD_LETTER_COLUMNS = [
  "id",
  "chat_id",
  "message_html",
  "created_at",
  "attempts",
  "last_error_class",
  "dedupe_key",
  "chunk_index",
  "priority",
  "source_type",
  "alert_type",
  "source_event_id",
  "alert_scope_json",
  "preference_generation",
  "markup_policy_json",
  "delivery_state",
  "delivery_owner",
  "delivery_generation",
  "delivery_started_at",
  "delivery_completed_at",
  "delivery_claim_expires_at",
  "expires_at",
  "processing_owner",
  "processing_started_at",
  "processing_expires_at",
] as const;
const PENDING_ALERT_DEAD_LETTER_COLUMN_SQL = PENDING_ALERT_DEAD_LETTER_COLUMNS.join(", ");
export const EXPIRED_PENDING_CLEANUP_BATCH_LIMIT = PENDING_DELETE_CHUNK_SIZE;


async function projectTerminalPendingRows(
  db: D1Database,
  rows: readonly DeadLetterPendingRow[],
  state: TelegramTargetFinalDeliveryState,
  nowSec: number,
  error: string,
): Promise<void> {
  for (const row of rows) {
    if (row.dedupe_key && row.source_event_id) {
      await recordTelegramJobTargetFinalDelivery(
        db,
        { pendingDedupeKey: row.dedupe_key, sourceEventId: row.source_event_id },
        { state, at: nowSec, error },
      );
    }
    const recapOutcome = state === "execution_unknown"
      ? "execution_unknown"
      : state === "expired"
      ? "expired"
      : state === "cancelled"
      ? "cancelled"
      : "failed_permanent";
    await projectRecapPendingTerminalOutcome(db, row, recapOutcome, nowSec, error);
  }
}

async function archiveExecutionUnknownPendingRows(
  db: D1Database,
  rows: readonly DeadLetterPendingRow[],
  nowSec: number,
): Promise<number> {
  if (rows.length === 0) return 0;
  const deadLettered = await deadLetterTerminalPendingRows(
    db,
    rows,
    nowSec,
    "execution_unknown_archived",
  );
  if (!deadLettered) return 0;
  await projectTerminalPendingRows(
    db,
    rows,
    "execution_unknown",
    nowSec,
    "execution_unknown_archived",
  );
  let deleted = 0;
  for (const row of rows) {
    const archivedAt = row.delivery_completed_at ?? row.delivery_started_at ?? row.created_at;
    const result = await db
      .prepare(
        `DELETE FROM telegram_pending_alerts
          WHERE id = ?
            AND delivery_state = 'execution_unknown'
            AND delivery_owner IS ?
            AND delivery_generation = ?
            AND COALESCE(delivery_completed_at, delivery_started_at, created_at) = ?`,
      )
      .bind(
        row.id,
        row.delivery_owner ?? null,
        row.delivery_generation ?? 0,
        archivedAt,
      )
      .run();
    deleted += Number(result.meta?.changes ?? 0);
  }
  return deleted;
}

export async function archiveAgedExecutionUnknownPendingAlerts(
  db: D1Database,
  nowSec: number,
): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT ${PENDING_ALERT_DEAD_LETTER_COLUMN_SQL}
         FROM telegram_pending_alerts
        WHERE delivery_state = 'execution_unknown'
          AND COALESCE(delivery_completed_at, delivery_started_at, created_at) <= ?
        ORDER BY COALESCE(delivery_completed_at, delivery_started_at, created_at) ASC, id ASC
        LIMIT ?`,
    )
    .bind(
      nowSec - TELEGRAM_PENDING_EXECUTION_UNKNOWN_RETENTION_SEC,
      EXPIRED_PENDING_CLEANUP_BATCH_LIMIT,
    )
    .all<DeadLetterPendingRow>();
  const aged = rows.results ?? [];
  return archiveExecutionUnknownPendingRows(db, aged, nowSec);
}

function normalizeFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : null;
  return parsed != null && Number.isFinite(parsed) ? parsed : null;
}

function logExpiredPendingCleanupRows(rows: readonly ExpiredPendingRow[], nowSec: number): void {
  const oldestCreatedAt = rows.reduce<number | null>((oldest, row) => {
    const createdAt = normalizeFiniteNumber(row.created_at);
    if (createdAt == null) return oldest;
    return oldest == null ? createdAt : Math.min(oldest, createdAt);
  }, null);
  logTelegramEvent({
    level: "info",
    message: "expired pending Telegram alerts cleaned up",
    action: "cleanup-expired-pending-alert",
    module: "telegram-pending-cleanup",
    reason: "ttl_expired",
    rowCount: rows.length,
    affectedChatCount: new Set(rows.map((row) => row.chat_id)).size,
    dedupeKeyCount: rows.filter((row) => row.dedupe_key).length,
    ageSec: oldestCreatedAt == null ? null : Math.max(0, nowSec - oldestCreatedAt),
  });
}


export async function clearPendingAlertsForDisabledChat(
  db: D1Database,
  chatId: string,
  nowSec: number,
  excludeIds: Iterable<number> = [],
): Promise<DisabledChatPendingCleanupResult> {
  const excluded = new Set(excludeIds);
  let deleted = 0;
  let cursorId = 0;

  try {
    for (;;) {
      const selected = await db
        .prepare(
          `SELECT ${PENDING_ALERT_DEAD_LETTER_COLUMN_SQL}
             FROM telegram_pending_alerts
            WHERE chat_id = ?
              AND id > ?
              AND delivery_state = 'pending'
            ORDER BY id ASC
            LIMIT ?`,
        )
        .bind(chatId, cursorId, PENDING_DELETE_CHUNK_SIZE)
        .all<SelectablePendingRow>();
      const rows = selected.results ?? [];
      if (rows.length === 0) break;

      cursorId = rows[rows.length - 1]?.id ?? cursorId;
      const rowsToDelete = rows.filter((row) => !excluded.has(row.id));
      if (rowsToDelete.length > 0) {
        const deletedRows = await settleUnstartedPendingRows(db, rowsToDelete, nowSec, "blocked_disabled");
        deleted += deletedRows;
        if (deletedRows < rowsToDelete.length) {
          throw new Error(
            `Deleted ${deletedRows} of ${rowsToDelete.length} selected disabled-chat pending alerts`,
          );
        }
      }

      if (rows.length < PENDING_DELETE_CHUNK_SIZE) break;
    }
    return { deleted, failed: false };
  } catch {
    logTelegramEvent({
      level: "warn",
      message: "Failed to clear pending alerts for disabled chat",
      action: "clear-disabled-chat-pending",
      module: "telegram-pending-cleanup",
      reason: "blocked_disabled",
      rowCount: deleted,
    });
    return { deleted, failed: true };
  }
}

async function cleanupAgedSentPendingAlerts(db: D1Database, nowSec: number): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM telegram_pending_alerts
        WHERE id IN (
          SELECT id
            FROM telegram_pending_alerts
           WHERE delivery_state = 'sent'
             AND COALESCE(delivery_completed_at, updated_at, created_at) <= ?
           ORDER BY COALESCE(delivery_completed_at, updated_at, created_at) ASC, id ASC
           LIMIT ?
        )`,
    )
    .bind(nowSec - TELEGRAM_PENDING_SENT_RETENTION_SEC, EXPIRED_PENDING_CLEANUP_BATCH_LIMIT)
    .run();
  return Number(result.meta?.changes ?? 0);
}

export async function cleanupExpiredPendingAlerts(
  db: D1Database,
  nowSec: number,
): Promise<number> {
  await db.prepare(`DELETE FROM cache WHERE key IN (
    SELECT key FROM cache WHERE key GLOB ? AND CAST(value AS INTEGER) <= ?
    ORDER BY key LIMIT ?
  )`).bind(`${TELEGRAM_CHAT_BACKOFF_CACHE_PREFIX}*`, nowSec, EXPIRED_PENDING_CLEANUP_BATCH_LIMIT).run();
  const sentRowsDeleted = await cleanupAgedSentPendingAlerts(db, nowSec);
  const expiredRows = await db
    .prepare(
      `SELECT ${PENDING_ALERT_DEAD_LETTER_COLUMN_SQL}
         FROM telegram_pending_alerts
        WHERE delivery_state = 'pending'
          AND COALESCE(expires_at, created_at + ?) <= ?
        ORDER BY id ASC
        LIMIT ?`,
    )
    .bind(PENDING_TTL_SEC, nowSec, EXPIRED_PENDING_CLEANUP_BATCH_LIMIT)
    .all<ExpiredPendingRow>();

  const rows = expiredRows.results ?? [];
  if (rows.length > 0) {
    const deleted = await settleUnstartedPendingRows(db, rows, nowSec, "ttl_expired");
    if (deleted < rows.length) {
      // Rows whose lease changed after the SELECT stay queued; the owner's
      // checkpoint (or a later pass once the lease lapses) settles them.
      logTelegramEvent({
        level: "warn",
        message: "Skipped deleting expired pending Telegram alerts whose processing lease changed",
        action: "cleanup-expired-pending-delete-fenced",
        module: "telegram-pending-cleanup",
        reason: "ttl_expired",
        rowCount: rows.length - deleted,
      });
    } else {
      logExpiredPendingCleanupRows(rows, nowSec);
    }
    if (rows.length >= EXPIRED_PENDING_CLEANUP_BATCH_LIMIT) {
      logTelegramEvent({
        level: "info",
        message: "expired pending Telegram alert cleanup reached batch cap",
        action: "cleanup-expired-pending-alert-capped",
        module: "telegram-pending-cleanup",
        rowCount: rows.length,
        cappedAtLimit: EXPIRED_PENDING_CLEANUP_BATCH_LIMIT,
      });
    }
    return sentRowsDeleted + deleted;
  }

  return sentRowsDeleted;
}
