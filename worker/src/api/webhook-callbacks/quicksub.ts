import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { recordTelegramUsageEvent } from "../../lib/telegram/usage-analytics";
import { logTelegramEvent } from "../../lib/telegram/log";
import { upsertSubscriberAndSubscriptions } from "../telegram-webhook-store";
import { sendAuditedTelegramReply } from "../telegram-webhook-replies";
import { buildMiniAppOnlyKeyboard } from "../telegram-webhook-messages";
import { isGroupChatType } from "../telegram-webhook-auth";
import { createTelegramWebhookIntent } from "../telegram-webhook-effect-fence";
import {
  callbackChatType,
  hasExactParts,
  isSubscribableStablecoinId,
  requireAdminForMutatingCallback,
  type CallbackHandler,
} from "./_shared";

export const handleQuickSubCallback: CallbackHandler = async ({
  db, botToken, cb, chatId, parsed, answerCallback, beforeIrreversibleEffect,
  planIntent, prepareMutationAppliedStatement, confirmAtomicMutationApplied, wasMutationApplied,
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
      beforeIrreversibleEffect,
    ))
  ) {
    return;
  }
  const meta = TRACKED_META_BY_ID.get(arg);
  try {
    await planIntent?.(createTelegramWebhookIntent("callback:quicksub", {
      coinId: arg,
      alertTypes: ["depeg", "dews"],
    }, "required"));
    if (!wasMutationApplied) {
      const operationStatements = prepareMutationAppliedStatement
        ? [prepareMutationAppliedStatement()]
        : undefined;
      await upsertSubscriberAndSubscriptions(
        db,
        chatId,
        isGroup ? null : cb.from?.username ?? null,
        new Set(["dews", "depeg"]),
        [arg],
        { operationStatements },
      );
      if (operationStatements) confirmAtomicMutationApplied?.();
    }
    await recordTelegramUsageEvent(db, {
      eventType: "subscribe",
      actionDetail: "quicksub",
      outcome: "success",
    });
  } catch (err) {
    logTelegramEvent({
      message: "quicksub write failed",
      action: "quicksub",
    });
    throw err;
  }
  try {
    if (chatType === "private") {
      await beforeIrreversibleEffect("quicksub-reply");
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
