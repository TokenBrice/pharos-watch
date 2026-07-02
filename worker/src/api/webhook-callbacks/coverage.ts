import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { formatCoveragePayload } from "@shared/lib/telegram-mini-app-payloads";
import { sendAuditedTelegramReply } from "../telegram-webhook-replies";
import { buildCoverageMessage } from "../telegram-webhook-insights";
import { buildStatusDiscoveryKeyboard } from "../telegram-webhook-messages";
import { loadStatusForCoin } from "../telegram-webhook-status";
import { runReadOnlyCoinCallback, type CallbackHandler } from "./_shared";

export const handleCoverageCallback: CallbackHandler = async ({ db, botToken, cb, chatId, parsed }) => {
  await runReadOnlyCoinCallback({
    botToken,
    cb,
    parsed,
    ackText: "Coverage sent.",
    send: async (id, isPrivateChat) => {
      const status = await loadStatusForCoin(db, id);
      const symbol = TRACKED_META_BY_ID.get(id)?.symbol ?? id;
      await sendAuditedTelegramReply(db, chatId, buildCoverageMessage(symbol, status), botToken, {
        replyMarkup: buildStatusDiscoveryKeyboard(id, {
          includeMiniAppButton: isPrivateChat,
          miniAppPayload: formatCoveragePayload(id),
        }),
        actionDetail: "callback_coverage",
      });
    },
  });
};
