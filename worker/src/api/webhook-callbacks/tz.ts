import { editMessage, escapeHtml } from "../../lib/telegram";
import { logTelegramEvent } from "../../lib/telegram-log";
import { recordTelegramUsageEvent } from "../../lib/telegram-usage-analytics";
import { isValidIanaTimezone } from "../../cron/telegram-quiet-hours";
import { setSubscriberTimezone } from "../telegram-webhook-store";
import { createTelegramWebhookIntent } from "../telegram-webhook-effect-fence";
import { isGroupChatType } from "../telegram-webhook-auth";
import {
  callbackChatType,
  callbackUsername,
  hasExactParts,
  requireAdminForMutatingCallback,
  type CallbackHandler,
} from "./_shared";

export const handleTimezoneCallback: CallbackHandler = async ({
  db, botToken, cb, chatId, parsed, answerCallback, beforeIrreversibleEffect,
  planIntent, prepareMutationAppliedStatement, confirmAtomicMutationApplied,
  storedIntent, wasMutationApplied,
}) => {
  // Zone strings never legitimately contain `:` (IANA names use `/`), but use
  // a slice instead of split to stay forgiving if Telegram ever introduces
  // multi-segment callback payloads.
  const zone = parsed.parts[1] ?? "";
  if (!hasExactParts(parsed.parts, 2) || !isValidIanaTimezone(zone)) {
    await answerCallback({ text: "Unknown timezone." });
    return;
  }
  const isGroup = isGroupChatType(callbackChatType(cb));
  if (
    isGroup &&
    !(await requireAdminForMutatingCallback(
      db,
      botToken,
      cb,
      chatId,
      "Only group admins can change timezone.",
      beforeIrreversibleEffect,
    ))
  ) {
    return;
  }
  try {
    const normalizedZone = storedIntent?.kind === "callback:tz"
      ? String(storedIntent.payload.timezone)
      : zone;
    await planIntent?.(createTelegramWebhookIntent("callback:tz", { timezone: normalizedZone }, "required"));
    if (!wasMutationApplied) {
      const operationStatements = prepareMutationAppliedStatement
        ? [prepareMutationAppliedStatement()]
        : undefined;
      await setSubscriberTimezone(db, chatId, callbackUsername(cb), normalizedZone, { operationStatements });
      if (operationStatements) confirmAtomicMutationApplied?.();
    }
    await recordTelegramUsageEvent(db, {
      eventType: "timezone_change",
      actionDetail: "quick_pick",
      outcome: "set",
    });
  } catch {
    logTelegramEvent({
      message: "timezone write failed",
      action: "tz",
    });
    await answerCallback({
      text: "Could not save timezone. Please try again.",
    });
    return;
  }
  const messageId = cb.message?.message_id;
  if (messageId != null) {
    await beforeIrreversibleEffect("timezone-edit");
    await editMessage(
      chatId,
      messageId,
      [
        `Current timezone: ${escapeHtml(zone)}.`,
        "",
        "Quiet hours from /mute will now be interpreted in this zone.",
      ].join("\n"),
      botToken,
      { disableWebPagePreview: true },
    );
  }
  await answerCallback({ text: `Timezone set to ${zone}.` });
};
