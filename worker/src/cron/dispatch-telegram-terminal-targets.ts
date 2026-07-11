import { loadTerminalTelegramAlertTargetKeys } from "./telegram-alert-target-status";
import { reconcileUnknownFreshTelegramAlertTargets } from "./telegram-alert-target-effects";
import { buildDedupeKey } from "./telegram-pending";
import type { RoutedSubscriberAlert } from "./dispatch-telegram-routing";

function targetKeysForSubscriber(subscriber: RoutedSubscriberAlert): string[] {
  return subscriber.chunks.map((chunk, chunkIndex) => buildDedupeKey({
    chatId: subscriber.chatId,
    html: chunk,
    canonicalHtml: subscriber.canonicalHtml,
    disableNotification: subscriber.disableNotification,
    chunkIndex,
    alertType: subscriber.alertType,
  }));
}

export async function pruneAlreadyTerminalSubscribers(
  db: D1Database,
  subscriberQueue: RoutedSubscriberAlert[],
): Promise<Set<string>> {
  await reconcileUnknownFreshTelegramAlertTargets(db, Math.floor(Date.now() / 1000));
  const targetKeys = subscriberQueue.flatMap(targetKeysForSubscriber);
  if (targetKeys.length === 0) return new Set();
  const terminalKeys = await loadTerminalTelegramAlertTargetKeys(db, targetKeys);
  if (terminalKeys.size === 0) return terminalKeys;
  const filteredQueue = subscriberQueue.filter((subscriber) => {
    const keys = targetKeysForSubscriber(subscriber);
    return keys.length === 0 || !keys.every((key) => terminalKeys.has(key));
  });
  subscriberQueue.splice(0, subscriberQueue.length, ...filteredQueue);
  return terminalKeys;
}
