import { answerCallbackQuery, editMessage, escapeHtml } from "../../lib/telegram";
import { logTelegramEvent } from "../../lib/telegram-log";
import { recordTelegramUsageEvent } from "../../lib/telegram-usage-analytics";
import { isValidIanaTimezone } from "../../cron/telegram-quiet-hours";
import { setSubscriberTimezone } from "../telegram-webhook-store";
import { isGroupChatType } from "../telegram-webhook-auth";
import {
  callbackChatType,
  callbackUsername,
  hasExactParts,
  requireAdminForMutatingCallback,
  type CallbackHandler,
} from "./_shared";

export const handleTimezoneCallback: CallbackHandler = async ({ db, botToken, cb, chatId, parsed }) => {
  // Zone strings never legitimately contain `:` (IANA names use `/`), but use
  // a slice instead of split to stay forgiving if Telegram ever introduces
  // multi-segment callback payloads.
  const zone = parsed.parts[1] ?? "";
  if (!hasExactParts(parsed.parts, 2) || !isValidIanaTimezone(zone)) {
    await answerCallbackQuery(cb.id, botToken, { text: "Unknown timezone." });
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
    ))
  ) {
    return;
  }
  try {
    await setSubscriberTimezone(db, chatId, callbackUsername(cb), zone);
    await recordTelegramUsageEvent(db, {
      eventType: "timezone_change",
      actionDetail: "quick_pick",
      outcome: "set",
    });
  } catch (err) {
    logTelegramEvent({
      message: "timezone write failed",
      action: "tz",
    });
    await answerCallbackQuery(cb.id, botToken, {
      text: "Could not save timezone. Please try again.",
    });
    return;
  }
  const messageId = cb.message?.message_id;
  if (messageId != null) {
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
  await answerCallbackQuery(cb.id, botToken, { text: `Timezone set to ${zone}.` });
};
