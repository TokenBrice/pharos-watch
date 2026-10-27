export interface TelegramPendingAlertCountRow {
  pending_count?: number | string | null;
  queued_alerts?: number | string | null;
}


export function prepareTelegramPendingAlertCount(
  db: D1Database,
  chatId: string,
  alias: "pending_count" | "queued_alerts",
): D1PreparedStatement {
  return db
    .prepare(`SELECT COUNT(*) AS ${alias} FROM telegram_deliveries WHERE chat_id = ?
      AND state IN ('pending', 'retry')`)
    .bind(chatId);
}
