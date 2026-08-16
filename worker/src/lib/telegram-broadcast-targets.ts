const GLOBAL_ALERT_COLUMN_BY_TYPE = {
  dews: "global_alert_dews",
  depeg: "global_alert_depeg",
  safety: "global_alert_safety",
  launch: "global_alert_launch",
  reserve: "global_alert_reserve",
  freeze: "global_alert_freeze",
} as const;

export type TelegramBroadcastScope = "all" | "deliverable-watchers" | "global-subscribers";

export async function loadBroadcastTargetChatIds(
  db: D1Database,
  scope: TelegramBroadcastScope,
): Promise<string[]> {
  const globalPredicate = Object.values(GLOBAL_ALERT_COLUMN_BY_TYPE)
    .map((column) => `s.${column} = 1`)
    .join(" OR ");
  const globalSubscriberPredicate = Object.values(GLOBAL_ALERT_COLUMN_BY_TYPE)
    .map((column) => `${column} = 1`)
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
               SELECT 1 FROM telegram_subscriptions ts
                WHERE ts.chat_id = s.chat_id
                  AND (
                    ts.alert_dews = 1
                    OR ts.alert_depeg = 1
                    OR ts.alert_safety = 1
                    OR ts.alert_launch = 1
                    OR ts.alert_reserve = 1
                    OR ts.alert_freeze = 1
                  )
             )
             OR EXISTS (
               SELECT 1 FROM telegram_preset_subscriptions ps
                WHERE ps.chat_id = s.chat_id
                  AND (ps.alert_dews = 1 OR ps.alert_depeg = 1 OR ps.alert_safety = 1)
             )
          ORDER BY s.chat_id`
      : `SELECT chat_id FROM telegram_subscribers ORDER BY chat_id`;
  const rows = await db.prepare(sql).all<{ chat_id: string }>();
  return (rows.results ?? []).map((row) => row.chat_id);
}

export { GLOBAL_ALERT_COLUMN_BY_TYPE };
