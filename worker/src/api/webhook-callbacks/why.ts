import { formatWhyPayload } from "@shared/lib/telegram-mini-app-payloads";
import { sendAuditedTelegramReply } from "../telegram-webhook-replies";
import { buildWhyMessage } from "../telegram-webhook-insights";
import { buildStatusDiscoveryKeyboard } from "../telegram-webhook-messages";
import { runReadOnlyCoinCallback, type CallbackHandler } from "./_shared";

export const handleWhyCallback: CallbackHandler = async ({ db, botToken, cb, chatId, parsed }) => {
  await runReadOnlyCoinCallback({
    botToken,
    cb,
    parsed,
    ackText: "Why sent.",
    send: async (id, isPrivateChat) => {
      const message = await buildWhyMessage(db, id);
      await sendAuditedTelegramReply(db, chatId, message, botToken, {
        replyMarkup: buildStatusDiscoveryKeyboard(id, {
          includeMiniAppButton: isPrivateChat,
          miniAppPayload: formatWhyPayload(id),
        }),
        actionDetail: "callback_why",
      });
    },
  });
};
