import { clearAlertSnooze } from "../telegram-webhook-store";
import type { WebhookCommandHandler } from "./context";

export const handleUnsnooze: WebhookCommandHandler = async (ctx) => {
  await clearAlertSnooze(ctx.db, ctx.chatId, ctx.username);
  await ctx.replyToChat("Alert snooze cleared.");
};
