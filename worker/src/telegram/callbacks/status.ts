import { WORKER_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { isGroupChatType } from "../webhook/telegram-webhook-auth";
import { sendAuditedTelegramReply } from "../webhook/telegram-webhook-replies";
import { buildCoinStatusKeyboard, buildStatusMessage } from "../webhook/telegram-webhook-messages";
import { loadCoinDirectFollowState, loadStatusForCoin } from "../webhook/telegram-webhook-status";
import { callbackChatType, runReadOnlyCoinCallback, type CallbackHandler } from "./_shared";

/** `status:<id>` (and the retired `why:`/`coverage:` buttons) send the coin's status card. */
export const handleStatusCallback: CallbackHandler = async ({ db, botToken, cb, chatId, parsed, answerCallback }) => {
  const chatType = callbackChatType(cb);
  await runReadOnlyCoinCallback({
    botToken,
    cb,
    parsed,
    ackText: "Status sent.",
    answerCallback,
    send: async (id, isPrivateChat) => {
      const symbol = TRACKED_META_BY_ID.get(id)?.symbol ?? id;
      const [status, directFollow] = await Promise.all([
        loadStatusForCoin(db, id),
        loadCoinDirectFollowState(db, chatId, id),
      ]);
      const replyMarkup = buildCoinStatusKeyboard(id, symbol, {
        includeMiniAppButton: isPrivateChat,
        isGroup: isGroupChatType(chatType),
        alreadyFollowed: directFollow.available && directFollow.followed,
      });
      await sendAuditedTelegramReply(db, chatId, buildStatusMessage(symbol, status), botToken, {
        ...(replyMarkup ? { replyMarkup } : {}),
        actionDetail: "callback_status",
      });
    },
  });
};
