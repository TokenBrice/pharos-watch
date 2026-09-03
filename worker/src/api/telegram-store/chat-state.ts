import { coerceCount } from "../../lib/telegram/usage-analytics";

export interface TelegramPendingAlertCountRow {
  pending_count?: number | string | null;
  queued_alerts?: number | string | null;
}

export interface TelegramRecapStateRow {
  enabled: number | null;
  delivery_hour_local: number | null;
  next_due_at: number | null;
  last_window_end_at: number | null;
  last_delivered_local_date: string | null;
  last_outcome: string | null;
}

export function prepareTelegramPendingAlertCount(
  db: D1Database,
  chatId: string,
  alias: "pending_count" | "queued_alerts",
): D1PreparedStatement {
  return db
    .prepare(`SELECT COUNT(*) AS ${alias} FROM telegram_pending_alerts WHERE chat_id = ?`)
    .bind(chatId);
}

export async function loadTelegramPendingAlertCount(
  db: D1Database,
  chatId: string,
): Promise<number> {
  const row = await prepareTelegramPendingAlertCount(db, chatId, "pending_count")
    .first<TelegramPendingAlertCountRow>();
  return coerceCount(row?.pending_count);
}

export function prepareTelegramRecapState(
  db: D1Database,
  chatId: string,
): D1PreparedStatement {
  return db.prepare(`
    SELECT p.enabled, p.delivery_hour_local, p.next_due_at,
           p.last_window_end_at, p.last_delivered_local_date,
           (SELECT target.status
              FROM telegram_recap_targets target
             WHERE target.chat_id = p.chat_id
             ORDER BY target.created_at DESC, target.recap_key DESC
             LIMIT 1) AS last_outcome
      FROM telegram_recap_preferences p
     WHERE p.chat_id = ? AND p.chat_kind = 'private'
  `).bind(chatId);
}

export function loadTelegramRecapState(
  db: D1Database,
  chatId: string,
): Promise<TelegramRecapStateRow | null> {
  return prepareTelegramRecapState(db, chatId).first<TelegramRecapStateRow>();
}
