import { setCache } from "../../lib/db-cache";
import { sendToChat, type TelegramCreds } from "../../lib/telegram";

export interface WatchdogTransitionDelivery<TTransition> {
  stale: TTransition[];
  recovered: TTransition[];
  sent: boolean;
  cooldown: boolean;
}

export async function deliverWatchdogTransitions<TTransition>(params: {
  db: D1Database;
  stale: readonly TTransition[];
  recovered: readonly TTransition[];
  hasCooldownConsumingTransition: boolean;
  alertCacheKey: string;
  lastAlertValue: string | null | undefined;
  cooldownSec: number;
  nowSec: number;
  operatorTelegramCreds: TelegramCreds | null;
  buildAlertText: () => string;
  signal?: AbortSignal;
  cacheSignal?: AbortSignal;
}): Promise<WatchdogTransitionDelivery<TTransition>> {
  const transitions = {
    stale: [...params.stale],
    recovered: [...params.recovered],
    sent: false,
    cooldown: false,
  };
  if (transitions.stale.length === 0 && transitions.recovered.length === 0) {
    return transitions;
  }

  const lastAlertAt = Number(params.lastAlertValue);
  transitions.cooldown = params.hasCooldownConsumingTransition
    && Number.isFinite(lastAlertAt)
    && params.nowSec - lastAlertAt < params.cooldownSec;
  if (transitions.cooldown || !params.operatorTelegramCreds) {
    return transitions;
  }

  const delivery = await sendToChat(
    params.operatorTelegramCreds.chatId,
    params.buildAlertText(),
    params.operatorTelegramCreds.botToken,
    { disableWebPagePreview: true, signal: params.signal },
  );
  transitions.sent = delivery.ok;
  if (delivery.ok && params.hasCooldownConsumingTransition) {
    await setCache(params.db, params.alertCacheKey, String(params.nowSec), params.cacheSignal);
  }
  return transitions;
}
