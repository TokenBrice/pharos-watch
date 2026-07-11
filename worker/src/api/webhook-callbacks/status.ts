import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { sendAuditedTelegramReply } from "../telegram-webhook-replies";
import { loadStatusForCoin } from "../telegram-webhook-status";
import {
  buildStatusDiscoveryKeyboard,
  buildStatusMessage,
} from "../telegram-webhook-messages";
import { runReadOnlyCoinCallback, type CallbackHandler } from "./_shared";

export const handleStatusCallback: CallbackHandler = async ({
  db, botToken, cb, chatId, parsed, answerCallback, beforeIrreversibleEffect, planIntent,
}) => {
  await runReadOnlyCoinCallback({
    botToken,
    cb,
    parsed,
    ackText: "Status sent.",
    answerCallback,
    planIntent,
    intentKind: "callback:status",
    send: async (id, isPrivateChat) => {
      const status = await loadStatusForCoin(db, id);
      const symbol = TRACKED_META_BY_ID.get(id)?.symbol ?? id;
      await beforeIrreversibleEffect("callback-status-reply");
      await sendAuditedTelegramReply(db, chatId, buildStatusMessage(symbol, status), botToken, {
        replyMarkup: buildStatusDiscoveryKeyboard(id, { includeMiniAppButton: isPrivateChat }),
        actionDetail: "callback_status",
      });
    },
  });
};
