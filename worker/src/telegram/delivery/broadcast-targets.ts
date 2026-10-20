import {
  ACTIVE_PRESET_FLAGS_SQL,
  ACTIVE_SUBSCRIPTION_FLAGS_SQL,
  TELEGRAM_ALERT_PERSISTENCE,
} from "@shared/lib/telegram-alert-families";

export type TelegramBroadcastScope = "all" | "deliverable-watchers" | "global-subscribers";

export async function loadBroadcastTargetChatIds(
  db: D1Database,
  scope: TelegramBroadcastScope,
): Promise<string[]> {
  const globalPredicate = Object.values(TELEGRAM_ALERT_PERSISTENCE)
    .map((spec) => `s.${spec.globalColumn} = 1`)
    .join(" OR ");
  const globalSubscriberPredicate = Object.values(TELEGRAM_ALERT_PERSISTENCE)
    .map((spec) => `${spec.globalColumn} = 1`)
    .join(" OR ");

  const sql = scope === "global-subscribers"
    ? `SELECT chat_id FROM telegram_subscribers
        WHERE ${globalSubscriberPredicate}
        ORDER BY chat_id`
    : scope === "deliverable-watchers"
      ? `SELECT s.chat_id
           FROM telegram_subscribers s
          WHERE ${globalPredicate}
             OR EXISTS (
               SELECT 1 FROM telegram_subscriptions
                WHERE chat_id = s.chat_id
                  AND (${ACTIVE_SUBSCRIPTION_FLAGS_SQL})
             )
             OR EXISTS (
               SELECT 1 FROM telegram_preset_subscriptions
                WHERE chat_id = s.chat_id
                  AND (${ACTIVE_PRESET_FLAGS_SQL})
             )
          ORDER BY s.chat_id`
      : `SELECT chat_id FROM telegram_subscribers ORDER BY chat_id`;
  const rows = await db.prepare(sql).all<{ chat_id: string }>();
  return (rows.results ?? []).map((row) => row.chat_id);
}
