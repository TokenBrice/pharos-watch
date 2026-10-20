import { coerceCount } from "./usage-analytics";
import { PENDING_DELIVERY_STATES } from "../common/constants";

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
    .prepare(`SELECT COUNT(*) AS ${alias} FROM telegram_pending_alerts WHERE chat_id = ?
      AND delivery_state IN (${PENDING_DELIVERY_STATES.map(() => "?").join(", ")})`)
    .bind(chatId, ...PENDING_DELIVERY_STATES);
}

export async function loadTelegramPendingAlertCount(
  db: D1Database,
  chatId: string,
): Promise<number> {
  const row = await prepareTelegramPendingAlertCount(db, chatId, "pending_count")
    .first<TelegramPendingAlertCountRow>();
  return coerceCount(row?.pending_count);
}
