import { HELP_MESSAGE } from "../telegram-webhook-shared";
import type { WebhookCommandHandler } from "./context";

export const handleHelp: WebhookCommandHandler = async (ctx) => {
  await ctx.replyToChat(HELP_MESSAGE);
};
