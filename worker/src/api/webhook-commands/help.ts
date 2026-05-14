import { HELP_MESSAGE } from "../telegram-webhook-shared";
import { buildMiniAppOnlyKeyboard } from "../telegram-webhook-messages";
import type { WebhookCommandHandler } from "./context";

export const handleHelp: WebhookCommandHandler = async (ctx) => {
  if (ctx.chatType === "private") {
    await ctx.replyToChatWithMarkup(HELP_MESSAGE, {
      replyMarkup: buildMiniAppOnlyKeyboard("Open control panel", "settings"),
    });
    return;
  }
  await ctx.replyToChat(HELP_MESSAGE);
};
