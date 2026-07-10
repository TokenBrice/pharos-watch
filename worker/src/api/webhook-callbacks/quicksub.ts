import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { answerCallbackQuery } from "../../lib/telegram";
import { recordTelegramUsageEvent } from "../../lib/telegram-usage-analytics";
import { logTelegramEvent } from "../../lib/telegram-log";
import { upsertSubscriberAndSubscriptions } from "../telegram-webhook-store";
import { sendAuditedTelegramReply } from "../telegram-webhook-replies";
import { buildMiniAppOnlyKeyboard } from "../telegram-webhook-messages";
import { isGroupChatType } from "../telegram-webhook-auth";
import {
  callbackChatType,
  hasExactParts,
  isSubscribableStablecoinId,
  requireAdminForMutatingCallback,
  type CallbackHandler,
} from "./_shared";
import { toErrorMessage } from "../../lib/error-utils";

export const handleQuickSubCallback: CallbackHandler = async ({ db, botToken, cb, chatId, parsed }) => {
  const { arg, parts } = parsed;
  if (!hasExactParts(parts, 2) || !isSubscribableStablecoinId(arg)) {
    await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
    return;
  }
  const chatType = callbackChatType(cb);
  const isGroup = isGroupChatType(chatType);
  // Group chats route through the same admin gate as the slash commands so
  // a single member cannot rewrite the chat's subscription state.
  if (
    isGroup &&
    !(await requireAdminForMutatingCallback(
      db,
      botToken,
      cb,
      chatId,
      "Only group admins can subscribe.",
    ))
  ) {
    return;
  }
  const meta = TRACKED_META_BY_ID.get(arg);
  try {
    await upsertSubscriberAndSubscriptions(
      db,
      chatId,
      isGroup ? null : cb.from?.username ?? null,
      new Set(["dews", "depeg"]),
      [arg],
    );
    await recordTelegramUsageEvent(db, {
      eventType: "subscribe",
      actionDetail: "quicksub",
      outcome: "success",
    });
  } catch (err) {
    logTelegramEvent({
      message: "quicksub write failed",
      chatId,
      userId: cb.from?.id ?? null,
      action: "quicksub",
      err: toErrorMessage(err),
    });
    await answerCallbackQuery(cb.id, botToken, {
      text: "Could not save subscription. Please try again.",
    });
    return;
  }
  try {
    if (chatType === "private") {
      await sendAuditedTelegramReply(
        db,
        chatId,
        `Subscribed to DEWS + depeg for ${meta?.symbol ?? arg}.`,
        botToken,
        {
          actionDetail: "callback_quicksub",
          replyMarkup: buildMiniAppOnlyKeyboard("Open in app", `coin_${arg}`),
        },
      );
    }
  } finally {
    await answerCallbackQuery(cb.id, botToken, {
      text: `Subscribed to DEWS + depeg for ${meta?.symbol ?? arg}.`,
    });
  }
};
