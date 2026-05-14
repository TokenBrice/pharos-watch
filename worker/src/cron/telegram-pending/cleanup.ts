import { recordTelegramAlertTargetStatuses } from "../telegram-alert-target-status";
import { PENDING_TTL_SEC } from "../../lib/telegram-constants";
import {
  deadLetterTerminalPendingRows,
  deletePendingAlertsByIds,
  PENDING_DELETE_CHUNK_SIZE,
} from "./dead-letter";
import type { DeadLetterPendingRow } from "./types";

export async function clearPendingAlertsForAdmin(
  db: D1Database,
  filter: { chatId: string } | { olderThanCutoffSec: number },
  nowSec: number,
): Promise<number> {
  let deleted = 0;

  for (;;) {
    const query = "chatId" in filter
      ? {
          sql: `SELECT id, chat_id, message_html, created_at, attempts, last_error_class,
                       dedupe_key, chunk_index, priority, source_type, alert_type
                  FROM telegram_pending_alerts
                 WHERE chat_id = ?
                 ORDER BY id ASC
                 LIMIT ?`,
          binds: [filter.chatId, PENDING_DELETE_CHUNK_SIZE] as const,
        }
      : {
          sql: `SELECT id, chat_id, message_html, created_at, attempts, last_error_class,
                       dedupe_key, chunk_index, priority, source_type, alert_type
                  FROM telegram_pending_alerts
                 WHERE created_at < ?
                 ORDER BY id ASC
                 LIMIT ?`,
          binds: [filter.olderThanCutoffSec, PENDING_DELETE_CHUNK_SIZE] as const,
        };

    const selected = await db
      .prepare(query.sql)
      .bind(...query.binds)
      .all<DeadLetterPendingRow>();
    const rows = selected.results ?? [];
    if (rows.length === 0) break;

    const deadLettered = await deadLetterTerminalPendingRows(db, rows, nowSec, "manual_clear");
    if (!deadLettered) {
      throw new Error("Failed to dead-letter Telegram pending alerts before manual clear");
    }

    await recordTelegramAlertTargetStatuses(
      db,
      rows
        .filter((row) => row.dedupe_key)
        .map((row) => ({
          targetKey: row.dedupe_key!,
          status: "failed" as const,
          at: nowSec,
          errorClass: "manual_clear",
        })),
    );

    const deletedRows = await deletePendingAlertsByIds(db, rows.map((row) => row.id));
    deleted += deletedRows;
    if (deletedRows < rows.length) {
      throw new Error(
        `Deleted ${deletedRows} of ${rows.length} selected Telegram pending alerts during manual clear`,
      );
    }
    if (rows.length < PENDING_DELETE_CHUNK_SIZE) break;
  }

  return deleted;
}

export async function cleanupExpiredPendingAlerts(
  db: D1Database,
  nowSec: number,
): Promise<number> {
  const cutoff = nowSec - PENDING_TTL_SEC;
  const expiredRows = await db
    .prepare(
      `SELECT id, chat_id, message_html, created_at, attempts, last_error_class,
              dedupe_key, chunk_index, priority, source_type, alert_type
         FROM telegram_pending_alerts
        WHERE created_at < ?
           OR (expires_at IS NOT NULL AND expires_at <= ?)`,
    )
    .bind(cutoff, nowSec)
    .all<DeadLetterPendingRow>();

  const rows = expiredRows.results ?? [];
  if (rows.length > 0) {
    const deadLettered = await deadLetterTerminalPendingRows(db, rows, nowSec, "ttl_expired");
    if (!deadLettered) {
      return 0;
    }
    await recordTelegramAlertTargetStatuses(
      db,
      rows
        .filter((row) => row.dedupe_key)
        .map((row) => ({
          targetKey: row.dedupe_key!,
          status: "expired" as const,
          at: nowSec,
          errorClass: "ttl_expired",
        })),
    );
    await deletePendingAlertsByIds(db, rows.map((row) => row.id));
    return rows.length;
  }

  return 0;
}
