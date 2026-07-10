import type { ConsolidatedAlerts } from "../lib/telegram-alerts";
import type { AlertsByChatEntry } from "./dispatch-telegram-routing";

type StablecoinAlert = { stablecoinId: string };

function itemKey(kind: string, event: StablecoinAlert): string {
  return `${kind}:${event.stablecoinId}`;
}

export function listTelegramAlertItemKeys(alerts: ConsolidatedAlerts): string[] {
  const keys = [
    ...alerts.dews.map((event) => itemKey("dews", event)),
    ...alerts.depegTriggered.map((event) => itemKey("depeg-triggered", event)),
    ...alerts.depegResolved.map((event) => itemKey("depeg-resolved", event)),
    ...alerts.depegWorsening.map((event) => itemKey("depeg-worsening", event)),
    ...alerts.safety.map((event) => itemKey("safety", event)),
    ...alerts.launch.map((event) => itemKey("launch", event)),
    ...alerts.reserve.map((event) => itemKey("reserve", event)),
  ];
  if (alerts.burst) keys.push(`burst:${alerts.burst.dominantFamily}`);
  return [...new Set(keys)].sort();
}

function removeHandled<T extends StablecoinAlert>(
  events: readonly T[],
  kind: string,
  handled: ReadonlySet<string>,
): T[] {
  return events.filter((event) => !handled.has(itemKey(kind, event)));
}

function hasAlertItems(alerts: ConsolidatedAlerts): boolean {
  return listTelegramAlertItemKeys(alerts).length > 0;
}

export function removeHandledTelegramAlertItems(
  alertsByChat: Map<string, AlertsByChatEntry>,
  handledByChat: ReadonlyMap<string, ReadonlySet<string>>,
): number {
  let removed = 0;
  for (const [chatId, entry] of alertsByChat) {
    const handled = handledByChat.get(chatId);
    if (!handled || handled.size === 0) continue;
    const before = listTelegramAlertItemKeys(entry.alerts).length;
    entry.alerts = {
      ...entry.alerts,
      dews: removeHandled(entry.alerts.dews, "dews", handled),
      depegTriggered: removeHandled(entry.alerts.depegTriggered, "depeg-triggered", handled),
      depegResolved: removeHandled(entry.alerts.depegResolved, "depeg-resolved", handled),
      depegWorsening: removeHandled(entry.alerts.depegWorsening, "depeg-worsening", handled),
      safety: removeHandled(entry.alerts.safety, "safety", handled),
      launch: removeHandled(entry.alerts.launch, "launch", handled),
      reserve: removeHandled(entry.alerts.reserve, "reserve", handled),
      burst: entry.alerts.burst && handled.has(`burst:${entry.alerts.burst.dominantFamily}`)
        ? undefined
        : entry.alerts.burst,
    };
    const after = listTelegramAlertItemKeys(entry.alerts).length;
    removed += Math.max(0, before - after);
    if (!hasAlertItems(entry.alerts)) alertsByChat.delete(chatId);
  }
  return removed;
}

interface HandledTargetItemRow {
  chat_id: string;
  item_key: string;
}

/**
 * An item is handled only when every chunk in the message group that covered it
 * is terminal. This keeps a partially-sent multi-chunk message reconstructible,
 * while sent, queued, permanently failed, and execution-unknown groups are not
 * blindly replayed during source-resolution recovery.
 */
export async function loadHandledTelegramAlertItemsByChat(
  db: D1Database,
  sourceEventId: string,
): Promise<Map<string, Set<string>>> {
  const rows = await db
    .prepare(
      `SELECT target.chat_id, item.item_key
         FROM telegram_alert_job_target_items item
         JOIN telegram_alert_job_targets target
           ON target.job_id = item.job_id
          AND target.target_key = item.target_key
        WHERE item.source_event_id = ?
        GROUP BY target.job_id, target.chat_id, item.item_key
       HAVING SUM(
         CASE
           WHEN target.status IN ('queued', 'sent', 'failed', 'expired')
             OR target.effect_state IN ('sending', 'complete', 'execution_unknown')
           THEN 0
           ELSE 1
         END
       ) = 0`,
    )
    .bind(sourceEventId)
    .all<HandledTargetItemRow>();

  const handledByChat = new Map<string, Set<string>>();
  for (const row of rows.results ?? []) {
    const existing = handledByChat.get(row.chat_id) ?? new Set<string>();
    existing.add(row.item_key);
    handledByChat.set(row.chat_id, existing);
  }
  return handledByChat;
}
