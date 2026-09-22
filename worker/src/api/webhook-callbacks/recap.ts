import {
  TELEGRAM_RECAP_PUBLIC_ROLLOUT_POLICY,
  isTelegramRecapAvailableToChat,
} from "@shared/lib/telegram-recap-rollout";
import { classifyTelegramLogError, logTelegramEvent } from "../../lib/telegram/log";
import { recordTelegramUsageEvent } from "../../lib/telegram/usage-analytics";
import {
  applyRecapPreference,
  getTelegramRecapPreference,
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
  const nowSec = unixNow();
  let operationStatements: D1PreparedStatement[] | undefined;
  try {
    const result = await applyRecapPreference(db, {
      chatId,
      subscriber,
      enabled,
      deliveryHourLocal,
      nowSec,
      mutationAlreadyApplied: wasMutationApplied,
    }, async ({ nextDueAt }) => {
      await planIntent?.(createTelegramWebhookIntent("callback:recap", {
        enabled,
        deliveryHourLocal,
        nextDueAt,
      }, "required"));
      operationStatements = prepareMutationAppliedStatement
        ? [prepareMutationAppliedStatement()]
        : undefined;
      return { operationStatements };
    });
    if (result.kind === "timezone-required") {
      await answerCallback({ text: "Set a timezone first with /timezone." });
      return;
    }
    if (result.kind === "schedule-failed") {
      await answerCallback({ text: "Could not schedule this timezone." });
      return;
    }
    if (result.kind === "stale") {
      await answerCallback({ text: "Could not save the daily recap. Please try again." });
      return;
    }
    if (!wasMutationApplied) {
      if (operationStatements) confirmAtomicMutationApplied?.();
      else await markMutationApplied();
    }
  } catch (err) {
    logTelegramEvent({
      message: "recap callback write failed",
      action: "recap",
      errorClass: classifyTelegramLogError(err),
    });
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
