import { sendAuditedTelegramReply } from "../telegram-webhook-replies";
import { HELP_MESSAGE } from "../telegram-webhook-shared";
import { hasExactParts, type CallbackHandler } from "./_shared";

export const handleHelpCallback: CallbackHandler = async ({
  db, botToken, chatId, parsed, answerCallback, beforeIrreversibleEffect,
}) => {
  if (parsed.arg !== "commands" || !hasExactParts(parsed.parts, 2)) {
    await answerCallback({ text: "Action not recognized." });
    return;
  }
  await beforeIrreversibleEffect("callback-help-reply");
  await sendAuditedTelegramReply(db, chatId, HELP_MESSAGE, botToken, {
    actionDetail: "callback_help",
  });
  await answerCallback({ text: "Command reference sent." });
};
