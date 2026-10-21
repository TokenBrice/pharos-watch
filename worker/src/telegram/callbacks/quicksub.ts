import { WORKER_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { recordTelegramUsageEvent } from "../store/usage-analytics";
import { classifyTelegramLogError, logTelegramEvent } from "../common/log";
import { upsertSubscriberAndSubscriptions } from "../store/subscriptions";
import { sendAuditedTelegramReply } from "../webhook/telegram-webhook-replies";
import { buildMiniAppOnlyKeyboard } from "../webhook/telegram-webhook-messages";
import { isGroupChatType } from "../webhook/telegram-webhook-auth";
import {
  callbackChatType,
  hasExactParts,
  isSubscribableStablecoinId,
  requireAdminForMutatingCallback,
  type CallbackHandler,
} from "./_shared";

export const handleQuickSubCallback: CallbackHandler = async ({
  db, botToken, cb, chatId, parsed, answerCallback,
}) => {
  const { arg, parts } = parsed;
  if (!hasExactParts(parts, 2) || !isSubscribableStablecoinId(arg)) {
    await answerCallback({ text: "Action not recognized." });
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
      action: "quicksub",
      errorClass: classifyTelegramLogError(err),
    });
    throw err;
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
    await answerCallback({
      text: `Subscribed to DEWS + depeg for ${meta?.symbol ?? arg}.`,
    });
  }
};
