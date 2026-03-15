import { sendToChat } from "../lib/telegram";

// ---------- Constants ----------

export const PENDING_TTL_SEC = 3600; // 1 hour — stale alerts are worse than no alert
export const SEND_BATCH_SIZE = 5; // Parallel sends per batch (stay under Workers 6-conn limit)

// ---------- Types ----------

export interface PendingAlertRow {
  id: number;
  chat_id: string;
  message_html: string;
  disable_notification: number;
  created_at: number;
  attempts: number;
}

export interface PendingDrainResult {
  attempted: number;
  sent: number;
  blocked: number;
  retryQueued: number;
  dropped: number;
}

// ---------- Subscriber Lifecycle ----------

export async function disableBlockedSubscriber(db: D1Database, chatId: string): Promise<void> {
  await db
    .batch([
      db
        .prepare(
          `UPDATE telegram_subscribers
              SET alert_dews=0,
                  alert_depeg=0,
                  alert_safety=0,
                  global_alert_dews=0,
                  global_alert_depeg=0,
                  global_alert_safety=0
            WHERE chat_id=?`,
        )
        .bind(chatId),
      db
        .prepare(
          `UPDATE telegram_subscriptions
              SET alert_dews=0,
                  alert_depeg=0,
                  alert_safety=0
            WHERE chat_id=?`,
        )
        .bind(chatId),
    ])
    .catch(() => {});
}

// ---------- Pending Queue Operations ----------

export async function drainPendingQueue(
  db: D1Database,
  botToken: string,
  limit: number,
  signal?: AbortSignal,
): Promise<PendingDrainResult> {
  const rows = await db
    .prepare(
      `SELECT id, chat_id, message_html, disable_notification, created_at, attempts
         FROM telegram_pending_alerts
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .bind(limit)
    .all<PendingAlertRow>();

  const pending = rows.results ?? [];
  if (pending.length === 0) {
    return { attempted: 0, sent: 0, blocked: 0, retryQueued: 0, dropped: 0 };
  }

  let attempted = 0;
  let sent = 0;
  let blocked = 0;
  let retryQueued = 0;
  let dropped = 0;
  const idsToDelete: number[] = [];
  const idsToRetry: number[] = [];

  for (let i = 0; i < pending.length; i += SEND_BATCH_SIZE) {
    if (signal?.aborted) break;
    const batch = pending.slice(i, i + SEND_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (row) => {
        const result = await sendToChat(row.chat_id, row.message_html, botToken, {
          disableWebPagePreview: true,
          disableNotification: row.disable_notification === 1,
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
        await disableBlockedSubscriber(db, result.chatId);
      } else if (result.retryable && result.attempts < 2) {
        retryQueued++;
        idsToRetry.push(result.id);
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

  if (idsToRetry.length > 0) {
    const placeholders = idsToRetry.map(() => "?").join(",");
    await db
      .prepare(`UPDATE telegram_pending_alerts SET attempts = attempts + 1 WHERE id IN (${placeholders})`)
      .bind(...idsToRetry)
      .run();
  }

  return { attempted, sent, blocked, retryQueued, dropped };
}

export async function enqueuePendingAlerts(
  db: D1Database,
  messages: Array<{ chatId: string; html: string; disableNotification: boolean }>,
  nowSec: number,
): Promise<void> {
  if (messages.length === 0) return;

  const stmts = messages.map((msg) =>
    db
      .prepare(
        `INSERT INTO telegram_pending_alerts (chat_id, message_html, disable_notification, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(msg.chatId, msg.html, msg.disableNotification ? 1 : 0, nowSec),
  );
  await db.batch(stmts);
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
