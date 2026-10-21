import { WORKER_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { sendAuditedTelegramReply } from "../webhook/telegram-webhook-replies";
import { buildCoinStatusKeyboard, buildStatusMessage } from "../webhook/telegram-webhook-messages";
import { loadStatusForCoin } from "../webhook/telegram-webhook-status";
import { runReadOnlyCoinCallback, type CallbackHandler } from "./_shared";

/** `status:<id>` (and the retired `why:`/`coverage:` buttons) send the coin's status card. */
export const handleStatusCallback: CallbackHandler = async ({ db, botToken, cb, chatId, parsed, answerCallback }) => {
  await runReadOnlyCoinCallback({
    botToken,
    cb,
    parsed,
    ackText: "Status sent.",
    answerCallback,
    send: async (id, isPrivateChat) => {
      const symbol = TRACKED_META_BY_ID.get(id)?.symbol ?? id;
      const status = await loadStatusForCoin(db, id);
      const replyMarkup = buildCoinStatusKeyboard(id, symbol, { includeMiniAppButton: isPrivateChat });
      await sendAuditedTelegramReply(db, chatId, buildStatusMessage(symbol, status), botToken, {
        ...(replyMarkup ? { replyMarkup } : {}),
        actionDetail: "callback_status",
      });
    },
  });
};
