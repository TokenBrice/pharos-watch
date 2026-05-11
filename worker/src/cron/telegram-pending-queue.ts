import { sendToChat, type BatchMessage, type TelegramSendErrorClass } from "../lib/telegram";
import { batchExecute } from "../lib/db";
import { SNOOZE_REPLY_MARKUP } from "../lib/telegram-alerts";

// ---------- Constants ----------

export const PENDING_TTL_SEC = 3600; // 1 hour — stale alerts are worse than no alert
export const SEND_BATCH_SIZE = 4; // Parallel sends per batch (leave Workers connection headroom)

// ---------- Types ----------

export interface PendingAlertRow {
  id: number;
  chat_id: string;
  message_html: string;
  disable_notification: number;
  created_at: number;
  attempts: number;
  not_before_at: number | null;
  alert_snooze_until_ts: number | null;
  quiet_hours_enabled: number | null;
  quiet_hours_start_utc: number | null;
  quiet_hours_end_utc: number | null;
}

export interface PendingDrainResult {
  attempted: number;
  sent: number;
  blocked: number;
  blockedCleanupFailed: number;
  retryQueued: number;
  dropped: number;
  deferred: number;
  rateLimited: boolean;
  retryAfterSec: number | null;
  notBeforeAt: number | null;
}

export interface PendingEnqueueOptions {
  notBeforeAt?: number | null;
  lastErrorClass?: TelegramSendErrorClass | null;
  retryAfterSec?: number | null;
}

const DEFAULT_RETRY_DELAY_SEC = 60;

function emptyDrainResult(): PendingDrainResult {
  return {
    attempted: 0,
    sent: 0,
    blocked: 0,
    blockedCleanupFailed: 0,
    retryQueued: 0,
    dropped: 0,
    deferred: 0,
    rateLimited: false,
    retryAfterSec: null,
    notBeforeAt: null,
  };
}

function isQuietHoursActive(
  nowSec: number,
  quietHoursEnabled: boolean,
  quietHoursStartUtc: number | null,
  quietHoursEndUtc: number | null,
): boolean {
  if (!quietHoursEnabled || quietHoursStartUtc == null || quietHoursEndUtc == null) return false;
  if (
    quietHoursStartUtc < 0 ||
    quietHoursStartUtc > 23 ||
    quietHoursEndUtc < 0 ||
    quietHoursEndUtc > 23 ||
    quietHoursStartUtc === quietHoursEndUtc
  ) {
    return false;
  }

  const hourUtc = Math.floor((nowSec % 86_400) / 3600);
  if (quietHoursStartUtc < quietHoursEndUtc) {
    return hourUtc >= quietHoursStartUtc && hourUtc < quietHoursEndUtc;
  }
  return hourUtc >= quietHoursStartUtc || hourUtc < quietHoursEndUtc;
}

function isPendingRowSnoozed(row: PendingAlertRow, nowSec: number): boolean {
  return row.alert_snooze_until_ts != null && row.alert_snooze_until_ts > nowSec;
}

function shouldSilencePendingRow(row: PendingAlertRow, nowSec: number): boolean {
  return row.disable_notification === 1 || isQuietHoursActive(
    nowSec,
    Boolean(row.quiet_hours_enabled),
    row.quiet_hours_start_utc,
    row.quiet_hours_end_utc,
  );
}

function retryDelaySec(retryAfterSec: number | null): number {
  return retryAfterSec != null && retryAfterSec > 0 ? retryAfterSec : DEFAULT_RETRY_DELAY_SEC;
}

function hashDedupePart(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function buildDedupeKey(message: BatchMessage): string {
  return `${message.chatId}:${message.chunkIndex ?? 0}:${hashDedupePart(message.html)}`;
}

// ---------- Subscriber Lifecycle ----------

export async function disableBlockedSubscriber(db: D1Database, chatId: string): Promise<boolean> {
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE telegram_subscribers
              SET alert_dews=0,
                  alert_depeg=0,
                  alert_safety=0,
                  alert_launch=0,
                  global_alert_dews=0,
                  global_alert_depeg=0,
                  global_alert_safety=0,
                  global_alert_launch=0,
                  global_depeg_worsening_bps_step=NULL
            WHERE chat_id=?`,
        )
        .bind(chatId),
      db
        .prepare(
          `UPDATE telegram_subscriptions
              SET alert_dews=0,
                  alert_depeg=0,
                  alert_safety=0,
                  alert_launch=0
            WHERE chat_id=?`,
        )
        .bind(chatId),
    ]);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[telegram-pending-queue] Failed to disable blocked subscriber ${chatId}: ${message}`);
    return false;
  }
}

// ---------- Pending Queue Operations ----------

export async function drainPendingQueue(
  db: D1Database,
  botToken: string,
  limit: number,
  signal?: AbortSignal,
): Promise<PendingDrainResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - PENDING_TTL_SEC;
  const rows = await db
    .prepare(
      `SELECT p.id, p.chat_id, p.message_html, p.disable_notification, p.created_at, p.attempts,
              p.not_before_at, u.alert_snooze_until_ts, u.quiet_hours_enabled,
              u.quiet_hours_start_utc, u.quiet_hours_end_utc
         FROM telegram_pending_alerts p
         LEFT JOIN telegram_subscribers u ON u.chat_id = p.chat_id
        WHERE p.created_at >= ?
          AND (p.not_before_at IS NULL OR p.not_before_at <= ?)
        ORDER BY COALESCE(p.not_before_at, p.created_at) ASC, p.created_at ASC
        LIMIT ?`,
    )
    .bind(cutoff, nowSec, limit)
    .all<PendingAlertRow>();

  const pending = rows.results ?? [];
  if (pending.length === 0) {
    return emptyDrainResult();
  }

  let attempted = 0;
  let sent = 0;
  let blocked = 0;
  let blockedCleanupFailed = 0;
  let retryQueued = 0;
  let dropped = 0;
  let deferred = 0;
  const idsToDelete: number[] = [];
  const retryUpdates: Array<{ id: number; retryAfterSec: number | null; errorClass: TelegramSendErrorClass | null }> = [];
  const deferUpdates: Array<{ id: number; notBeforeAt: number }> = [];
  let rateLimited = false;
  let rateLimitRetryAfterSec: number | null = null;
  let rateLimitNotBeforeAt: number | null = null;

  for (let i = 0; i < pending.length; i += SEND_BATCH_SIZE) {
    if (signal?.aborted || rateLimited) break;
    const batch = pending.slice(i, i + SEND_BATCH_SIZE).filter((row) => {
      if (!isPendingRowSnoozed(row, nowSec)) return true;
      deferred++;
      deferUpdates.push({ id: row.id, notBeforeAt: Math.max(row.alert_snooze_until_ts ?? 0, nowSec + DEFAULT_RETRY_DELAY_SEC) });
      return false;
    });
    if (batch.length === 0) continue;
    const results = await Promise.all(
      batch.map(async (row) => {
        const result = await sendToChat(row.chat_id, row.message_html, botToken, {
          disableWebPagePreview: true,
          disableNotification: shouldSilencePendingRow(row, nowSec),
          replyMarkup: SNOOZE_REPLY_MARKUP,
          signal,
        });
        return { id: row.id, chatId: row.chat_id, attempts: row.attempts, ...result };
      }),
    );

    for (const result of results) {
      attempted++;
      if (result.ok) {
        sent++;
        idsToDelete.push(result.id);
      } else if (result.blocked) {
        blocked++;
        idsToDelete.push(result.id);
        if (!(await disableBlockedSubscriber(db, result.chatId))) {
          blockedCleanupFailed++;
        }
      } else if (result.retryable && result.attempts < 5) {
        retryQueued++;
        retryUpdates.push({ id: result.id, retryAfterSec: result.retryAfterSec, errorClass: result.errorClass });
        if (result.errorClass === "rate_limit") {
          rateLimited = true;
          rateLimitRetryAfterSec = result.retryAfterSec;
          rateLimitNotBeforeAt = nowSec + retryDelaySec(result.retryAfterSec);
        }
      } else {
        dropped++;
        idsToDelete.push(result.id);
      }
    }
  }

  if (idsToDelete.length > 0) {
    const placeholders = idsToDelete.map(() => "?").join(",");
    await db
      .prepare(`DELETE FROM telegram_pending_alerts WHERE id IN (${placeholders})`)
      .bind(...idsToDelete)
      .run();
  }

  if (deferUpdates.length > 0) {
    await batchExecute(db, deferUpdates.map((update) =>
      db
        .prepare("UPDATE telegram_pending_alerts SET not_before_at = ?, updated_at = ? WHERE id = ?")
        .bind(update.notBeforeAt, nowSec, update.id),
    ));
  }

  if (retryUpdates.length > 0) {
    await batchExecute(db, retryUpdates.map((update) => {
      const notBeforeAt = nowSec + retryDelaySec(update.retryAfterSec);
      return db
        .prepare(
          `UPDATE telegram_pending_alerts
              SET attempts = attempts + 1,
                  not_before_at = ?,
                  last_error_class = ?,
                  retry_after_sec = ?,
                  updated_at = ?
            WHERE id = ?`,
        )
        .bind(notBeforeAt, update.errorClass, update.retryAfterSec, nowSec, update.id);
    }));
  }

  return {
    attempted,
    sent,
    blocked,
    blockedCleanupFailed,
    retryQueued,
    dropped,
    deferred,
    rateLimited,
    retryAfterSec: rateLimitRetryAfterSec,
    notBeforeAt: rateLimitNotBeforeAt,
  };
}

export async function enqueuePendingAlerts(
  db: D1Database,
  messages: BatchMessage[],
  nowSec: number,
  options: PendingEnqueueOptions = {},
): Promise<void> {
  if (messages.length === 0) return;

  const staleCutoff = nowSec - PENDING_TTL_SEC;
  const stmts = messages.map((msg) =>
    db
      .prepare(
        `INSERT INTO telegram_pending_alerts (
           chat_id, message_html, disable_notification, created_at, not_before_at,
           last_error_class, retry_after_sec, updated_at, dedupe_key, chunk_index
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(dedupe_key) DO UPDATE SET
           message_html = excluded.message_html,
           disable_notification = excluded.disable_notification,
           created_at = CASE
             WHEN telegram_pending_alerts.created_at < ? THEN excluded.created_at
             ELSE telegram_pending_alerts.created_at
           END,
           attempts = CASE
             WHEN telegram_pending_alerts.created_at < ? THEN 0
             ELSE telegram_pending_alerts.attempts
           END,
           not_before_at = CASE
             WHEN excluded.not_before_at IS NULL THEN telegram_pending_alerts.not_before_at
             WHEN telegram_pending_alerts.not_before_at IS NULL THEN excluded.not_before_at
             ELSE MAX(telegram_pending_alerts.not_before_at, excluded.not_before_at)
           END,
           last_error_class = COALESCE(excluded.last_error_class, telegram_pending_alerts.last_error_class),
           retry_after_sec = COALESCE(excluded.retry_after_sec, telegram_pending_alerts.retry_after_sec),
           updated_at = excluded.updated_at,
           chunk_index = excluded.chunk_index`,
      )
      .bind(
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
        staleCutoff,
        staleCutoff,
      ),
  );
  await batchExecute(db, stmts);
}

export async function cleanupExpiredPendingAlerts(
  db: D1Database,
  nowSec: number,
): Promise<number> {
  const cutoff = nowSec - PENDING_TTL_SEC;
  const result = await db
    .prepare("DELETE FROM telegram_pending_alerts WHERE created_at < ?")
    .bind(cutoff)
    .run();
  return result.meta?.changes ?? 0;
}
