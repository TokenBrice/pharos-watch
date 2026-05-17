import { answerCallbackQuery } from "../../lib/telegram";
import { sendAuditedTelegramReply } from "../telegram-webhook-replies";
import { HELP_MESSAGE } from "../telegram-webhook-shared";
import { hasExactParts, type CallbackHandler } from "./_shared";

export const handleHelpCallback: CallbackHandler = async ({ db, botToken, cb, chatId, parsed }) => {
  if (parsed.arg !== "commands" || !hasExactParts(parsed.parts, 2)) {
    await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
    return;
  }
  await sendAuditedTelegramReply(db, chatId, HELP_MESSAGE, botToken, {
    actionDetail: "callback_help",
  });
  await answerCallbackQuery(cb.id, botToken, { text: "Command reference sent." });
};
