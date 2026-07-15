import { recordTelegramAlertTargetStatuses } from "../telegram-alert-target-status";
import {
  PENDING_TTL_SEC,
  TELEGRAM_PENDING_EXECUTION_UNKNOWN_RETENTION_SEC,
} from "../../lib/telegram-constants";
import { logTelegramEvent } from "../../lib/telegram-log";
import {
  deadLetterTerminalPendingRows,
  deletePendingAlertsByIds,
  PENDING_DELETE_CHUNK_SIZE,
} from "./dead-letter";
import type { DeadLetterPendingRow } from "./types";
import {
  recordTelegramJobTargetFinalDelivery,
  type TelegramTargetFinalDeliveryState,
} from "../telegram-alert-job-target-outcomes";
import { projectRecapPendingTerminalOutcome } from "./recap-terminal";
import { buildInClause } from "../../lib/db";

type ExpiredPendingRow = DeadLetterPendingRow & { expires_at?: number | null };
type PendingAlertAdminFilter = { chatId: string } | { olderThanCutoffSec: number };
type PendingAlertFilterClause = {
  whereSql:
    | "chat_id = ? AND delivery_state = 'pending'"
    | "created_at < ? AND delivery_state = 'pending'";
  binds: readonly [string] | readonly [number];
};

export interface DisabledChatPendingCleanupResult {
  deleted: number;
  failed: boolean;
}

export interface ExecutionUnknownAcknowledgementResult {
  acknowledgedIds: number[];
  missingIds: number[];
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

export async function acknowledgeExecutionUnknownPendingAlertsForAdmin(
  db: D1Database,
  pendingIds: readonly number[],
  nowSec: number,
): Promise<ExecutionUnknownAcknowledgementResult> {
  const ids = [...new Set(pendingIds)].sort((a, b) => a - b);
  if (ids.length === 0 || ids.length > 100 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("Telegram execution-unknown acknowledgement ids are invalid");
  }
  const inClause = buildInClause(ids);
  const selected = await db
    .prepare(
      `SELECT ${PENDING_ALERT_DEAD_LETTER_COLUMN_SQL}
         FROM telegram_pending_alerts
        WHERE delivery_state = 'execution_unknown'
          AND id IN (${inClause.sql})
        ORDER BY id ASC`,
    )
    .bind(...inClause.binds)
    .all<DeadLetterPendingRow>();
  const rows = selected.results ?? [];
  const matchedIds = new Set(rows.map((row) => row.id));
  const missingIds = ids.filter((id) => !matchedIds.has(id));
  if (missingIds.length > 0) {
    return { acknowledgedIds: [], missingIds };
  }

  const deleted = await archiveExecutionUnknownPendingRows(db, rows, nowSec);
  if (deleted !== rows.length) {
    throw new Error(`Archived ${deleted} of ${rows.length} Telegram execution-unknown rows`);
  }
  return { acknowledgedIds: rows.map((row) => row.id), missingIds: [] };
}

function pendingAlertFilterClause(filter: PendingAlertAdminFilter): PendingAlertFilterClause {
  if ("chatId" in filter) {
    return { whereSql: "chat_id = ? AND delivery_state = 'pending'", binds: [filter.chatId] };
  }
  return {
    whereSql: "created_at < ? AND delivery_state = 'pending'",
    binds: [filter.olderThanCutoffSec],
  };
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
    await projectTerminalPendingRows(db, rows, "cancelled", nowSec, "manual_clear");

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
              AND delivery_state = 'pending'
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
        await projectTerminalPendingRows(db, rowsToDelete, "failed", nowSec, "blocked_disabled");
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

export async function cleanupExpiredPendingAlerts(
  db: D1Database,
  nowSec: number,
): Promise<number> {
  const expiredRows = await db
    .prepare(
      `SELECT ${PENDING_ALERT_DEAD_LETTER_COLUMN_SQL}, expires_at
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
    const deadLettered = await deadLetterTerminalPendingRows(db, rows, nowSec, "ttl_expired");
    if (!deadLettered) {
      logExpiredPendingDeadLetterBypass(rows);
    }
    // A dead-letter write is diagnostic retention, not the delivery state
    // machine. Expiry still has to reach recap targets before the queue rows
    // are removed when that best-effort copy is unavailable.
    await projectTerminalPendingRows(db, rows, "expired", nowSec, "ttl_expired");
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
