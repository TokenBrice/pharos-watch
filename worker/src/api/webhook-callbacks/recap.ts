import { nextIanaLocalHourDueAt } from "@shared/lib/iana-local-time";
import {
  TELEGRAM_RECAP_PUBLIC_ROLLOUT_POLICY,
  isTelegramRecapAvailableToChat,
} from "@shared/lib/telegram-recap-rollout";
import { recordTelegramUsageEvent } from "../../lib/telegram/usage-analytics";
import {
  getTelegramRecapPreference,
  setTelegramRecapPreference,
} from "../../lib/telegram/recap-store";
import { loadSubscriberByChat, unixNow } from "../telegram-webhook-store";
import { createTelegramWebhookIntent } from "../telegram-webhook-effect-fence";
import {
  callbackActorUserId,
  callbackChatType,
  type CallbackHandler,
} from "./_shared";

function parseRecapCallback(parts: readonly string[]): { enabled: boolean; hour: number | null } | null {
  if (parts.length === 2 && parts[0] === "recap" && parts[1] === "on") return { enabled: true, hour: null };
  if (parts.length === 2 && parts[0] === "recap" && parts[1] === "off") return { enabled: false, hour: null };
  if (parts.length === 3 && parts[0] === "recap" && parts[1] === "h" && /^(?:[0-9]|1[0-9]|2[0-3])$/.test(parts[2] ?? "")) {
    return { enabled: true, hour: Number(parts[2]) };
  }
  return null;
}

export const handleRecapCallback: CallbackHandler = async ({
  db, cb, chatId, recapRollout, parsed, answerCallback, planIntent, prepareMutationAppliedStatement,
  confirmAtomicMutationApplied, markMutationApplied, storedIntent, wasMutationApplied,
}) => {
  if (!isTelegramRecapAvailableToChat(recapRollout ?? TELEGRAM_RECAP_PUBLIC_ROLLOUT_POLICY, chatId)) {
    await answerCallback({ text: "Daily recaps are not available for this chat." });
    return;
  }
  if (callbackChatType(cb) !== "private" || callbackActorUserId(cb) !== chatId) {
    await answerCallback({ text: "Daily recap settings are private-chat only." });
    return;
  }
  const requested = parseRecapCallback(parsed.parts);
  if (!requested) {
    await answerCallback({ text: "Action not recognized." });
    return;
  }
  const [subscriber, preference] = await Promise.all([
    loadSubscriberByChat(db, chatId),
    getTelegramRecapPreference(db, chatId),
  ]);
  const enabled = storedIntent?.kind === "callback:recap"
    ? storedIntent.payload.enabled === true
    : requested.hour == null ? requested.enabled : preference?.enabled ?? false;
  const deliveryHourLocal = storedIntent?.kind === "callback:recap"
    ? Number(storedIntent.payload.deliveryHourLocal)
    : requested.hour ?? preference?.deliveryHourLocal ?? 9;
  if (!Number.isInteger(deliveryHourLocal) || deliveryHourLocal < 0 || deliveryHourLocal > 23) {
    await answerCallback({ text: "Action not recognized." });
    return;
  }
  if (subscriber == null) {
    await answerCallback({ text: "Start the bot before configuring recaps." });
    return;
  }
  // Keep timezone and generation from one row snapshot so a concurrent
  // preference write cannot publish an obsolete local-time schedule.
  const timezone = subscriber.timezone ?? null;
  const expectedPreferenceGeneration = Number(subscriber.preference_generation ?? 0);
  if (enabled && timezone == null) {
    await answerCallback({ text: "Set a timezone first with /timezone." });
    return;
  }
  const nowSec = unixNow();
  const nextDueMs = enabled && timezone != null
    ? nextIanaLocalHourDueAt(nowSec * 1000, timezone, deliveryHourLocal)
    : null;
  if (enabled && nextDueMs == null) {
    await answerCallback({ text: "Could not schedule this timezone." });
    return;
  }
  try {
    await planIntent?.(createTelegramWebhookIntent("callback:recap", {
      enabled,
      deliveryHourLocal,
      nextDueAt: nextDueMs == null ? null : Math.floor(nextDueMs / 1000),
    }, "required"));
    if (!wasMutationApplied) {
      const operationStatements = prepareMutationAppliedStatement
        ? [prepareMutationAppliedStatement()]
        : undefined;
      const applied = await setTelegramRecapPreference(db, {
        chatId,
        enabled,
        deliveryHourLocal,
        nextDueAt: nextDueMs == null ? null : Math.floor(nextDueMs / 1000),
        nowSec,
        expectedPreferenceGeneration,
      }, { operationStatements });
      if (!applied) throw new Error("recap preference mutation did not apply");
      if (operationStatements) confirmAtomicMutationApplied?.();
      else await markMutationApplied();
    }
  } catch {
    await answerCallback({ text: "Could not save the daily recap. Please try again." });
    return;
  }
  await recordTelegramUsageEvent(db, {
    eventType: "recap_change",
    actionDetail: requested.hour == null ? enabled ? "enabled" : "disabled" : "hour",
    outcome: requested.hour == null ? enabled ? "on" : "off" : "set",
  });
  await answerCallback({
    text: enabled
      ? `Daily recap set for ${String(deliveryHourLocal).padStart(2, "0")}:00.`
      : "Daily recap turned off.",
  });
};
