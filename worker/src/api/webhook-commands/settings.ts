import { handleSettingsCommand } from "../telegram-webhook-settings";
import type { WebhookCommandHandler } from "./context";

export const handleSettings: WebhookCommandHandler = async (ctx, args) => {
  await handleSettingsCommand(ctx.db, ctx.botToken, ctx.chatId, ctx.username, args, {
    includeMiniAppButton: ctx.chatType === "private",
    beforeIrreversibleEffect: ctx.beforeIrreversibleEffect,
  });
};
