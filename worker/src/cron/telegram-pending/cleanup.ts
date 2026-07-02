import { recordTelegramAlertTargetStatuses } from "../telegram-alert-target-status";
import { PENDING_TTL_SEC } from "../../lib/telegram-constants";
import { logTelegramEvent } from "../../lib/telegram-log";
import { toErrorMessage } from "../../lib/error-utils";
import {
  deadLetterTerminalPendingRows,
  deletePendingAlertsByIds,
  PENDING_DELETE_CHUNK_SIZE,
} from "./dead-letter";
import type { DeadLetterPendingRow } from "./types";

type ExpiredPendingRow = DeadLetterPendingRow & { expires_at?: number | null };
type ExpiredPendingReasonClass = "explicit-ttl" | "default-ttl" | "corrupt-expiry";
type PriorFailureReasonClass = "none" | "terminal" | "retryable" | "unknown";
type PendingAlertAdminFilter = { chatId: string } | { olderThanCutoffSec: number };
type PendingAlertFilterClause = {
  whereSql: "chat_id = ?" | "created_at < ?";
  binds: readonly [string] | readonly [number];
};

export interface DisabledChatPendingCleanupResult {
  deleted: number;
  failed: boolean;
}

const TERMINAL_PENDING_ERROR_CLASSES = new Set(["blocked", "bad_request", "auth_error"]);
const RETRYABLE_PENDING_ERROR_CLASSES = new Set([
  "rate_limit",
  "server_error",
  "timeout",
  "network",
  "unknown",
]);
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
] as const;
const PENDING_ALERT_DEAD_LETTER_COLUMN_SQL = PENDING_ALERT_DEAD_LETTER_COLUMNS.join(", ");
export const EXPIRED_PENDING_CLEANUP_BATCH_LIMIT = PENDING_DELETE_CHUNK_SIZE;

function pendingAlertFilterClause(filter: PendingAlertAdminFilter): PendingAlertFilterClause {
  if ("chatId" in filter) {
    return { whereSql: "chat_id = ?", binds: [filter.chatId] };
  }
  return { whereSql: "created_at < ?", binds: [filter.olderThanCutoffSec] };
}

function normalizeFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : null;
  return parsed != null && Number.isFinite(parsed) ? parsed : null;
}

function classifyExpiredPendingRow(row: ExpiredPendingRow, nowSec: number): ExpiredPendingReasonClass {
  const expiresAt = normalizeFiniteNumber(row.expires_at);
  if (expiresAt != null && expiresAt <= nowSec) return "explicit-ttl";
  const createdAt = normalizeFiniteNumber(row.created_at);
  if (createdAt != null && createdAt + PENDING_TTL_SEC <= nowSec) return "default-ttl";
  return "corrupt-expiry";
}

function classifyPriorFailure(row: ExpiredPendingRow): PriorFailureReasonClass {
  const errorClass = row.last_error_class?.trim();
  if (!errorClass) return "none";
  if (TERMINAL_PENDING_ERROR_CLASSES.has(errorClass)) return "terminal";
  if (RETRYABLE_PENDING_ERROR_CLASSES.has(errorClass)) return "retryable";
  return "unknown";
}

function logExpiredPendingCleanupRows(rows: readonly ExpiredPendingRow[], nowSec: number): void {
  for (const row of rows) {
    const createdAt = normalizeFiniteNumber(row.created_at);
    const expiresAt = normalizeFiniteNumber(row.expires_at);
    logTelegramEvent({
      level: "info",
      message: "expired pending Telegram alert cleaned up",
      action: "cleanup-expired-pending-alert",
      module: "telegram-pending-cleanup",
      chatId: row.chat_id,
      pendingId: row.id,
      reason: "ttl_expired",
      reasonClass: classifyExpiredPendingRow(row, nowSec),
      priorFailureReasonClass: classifyPriorFailure(row),
      lastErrorClass: row.last_error_class ?? null,
      sourceType: row.source_type ?? "legacy",
      alertType: row.alert_type ?? null,
      priority: row.priority ?? null,
      attempts: row.attempts ?? 0,
      ageSec: createdAt != null ? Math.max(0, nowSec - createdAt) : null,
      expiresAt,
      dedupeKeyPresent: Boolean(row.dedupe_key),
    });
  }
}

function logExpiredPendingDeadLetterBypass(rows: readonly ExpiredPendingRow[]): void {
  logTelegramEvent({
    level: "error",
    message: "expired pending Telegram alerts removed without dead-letter copy after dead-letter write failure",
    action: "cleanup-expired-pending-dead-letter-bypass",
    module: "telegram-pending-cleanup",
    reason: "ttl_expired",
    rowCount: rows.length,
    affectedChatCount: new Set(rows.map((row) => row.chat_id)).size,
    dedupeKeyCount: rows.filter((row) => row.dedupe_key).length,
  });
}

export async function countPendingAlertsForAdmin(
  db: D1Database,
  filter: PendingAlertAdminFilter,
): Promise<number> {
  const query = pendingAlertFilterClause(filter);
  const row = await db
    .prepare(`SELECT COUNT(*) AS count FROM telegram_pending_alerts WHERE ${query.whereSql}`)
    .bind(...query.binds)
    .first<{ count: number | string | null }>();
  const count = Number(row?.count ?? 0);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

export async function clearPendingAlertsForAdmin(
  db: D1Database,
  filter: PendingAlertAdminFilter,
  nowSec: number,
): Promise<number> {
  let deleted = 0;

  for (;;) {
    const query = pendingAlertFilterClause(filter);

    const selected = await db
      .prepare(
        `SELECT ${PENDING_ALERT_DEAD_LETTER_COLUMN_SQL}
           FROM telegram_pending_alerts
          WHERE ${query.whereSql}
          ORDER BY id ASC
          LIMIT ?`,
      )
      .bind(...query.binds, PENDING_DELETE_CHUNK_SIZE)
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
            ORDER BY id ASC
            LIMIT ?`,
        )
        .bind(chatId, cursorId, PENDING_DELETE_CHUNK_SIZE)
        .all<DeadLetterPendingRow>();
      const rows = selected.results ?? [];
      if (rows.length === 0) break;

      cursorId = rows[rows.length - 1]?.id ?? cursorId;
      const rowsToDelete = rows.filter((row) => !excluded.has(row.id));
      if (rowsToDelete.length > 0) {
        const deadLettered = await deadLetterTerminalPendingRows(db, rowsToDelete, nowSec, "blocked_disabled");
        if (!deadLettered) {
          throw new Error("Failed to dead-letter disabled-chat pending alerts");
        }
        const deletedRows = await deletePendingAlertsByIds(db, rowsToDelete.map((row) => row.id));
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
  } catch (error) {
    logTelegramEvent({
      level: "warn",
      message: `Failed to clear pending alerts for disabled chat: ${toErrorMessage(error)}`,
      chatId,
      action: "clear-disabled-chat-pending",
      module: "telegram-pending-cleanup",
      reason: "blocked_disabled",
      rowCount: deleted,
    });
    return { deleted, failed: true };
  }
}

export async function cleanupExpiredPendingAlerts(
  db: D1Database,
  nowSec: number,
): Promise<number> {
  const expiredRows = await db
    .prepare(
      `SELECT ${PENDING_ALERT_DEAD_LETTER_COLUMN_SQL}, expires_at
         FROM telegram_pending_alerts
        WHERE COALESCE(expires_at, created_at + ?) <= ?
        ORDER BY id ASC
        LIMIT ?`,
    )
    .bind(PENDING_TTL_SEC, nowSec, EXPIRED_PENDING_CLEANUP_BATCH_LIMIT)
    .all<ExpiredPendingRow>();

  const rows = expiredRows.results ?? [];
  if (rows.length > 0) {
    const deadLettered = await deadLetterTerminalPendingRows(db, rows, nowSec, "ttl_expired");
    if (!deadLettered) {
      logExpiredPendingDeadLetterBypass(rows);
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
    logExpiredPendingCleanupRows(rows, nowSec);
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
    return rows.length;
  }

  return 0;
}
