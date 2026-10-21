import { sendAuditedTelegramReply } from "../webhook/telegram-webhook-replies";
import { helpMessageForChat } from "../commands/help";
import { callbackChatType, hasExactParts, type CallbackHandler } from "./_shared";

export const handleHelpCallback: CallbackHandler = async ({ db, botToken, cb, chatId, parsed, answerCallback }) => {
  if (parsed.arg !== "commands" || !hasExactParts(parsed.parts, 2)) {
    await answerCallback({ text: "Action not recognized." });
    return;
  }
  await sendAuditedTelegramReply(db, chatId, helpMessageForChat(callbackChatType(cb)), botToken, {
    actionDetail: "callback_help",
  });
  await answerCallback({ text: "Help sent." });
};
