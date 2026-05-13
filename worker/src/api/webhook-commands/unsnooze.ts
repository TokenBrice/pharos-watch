import { recordTelegramUsageEvent } from "../../lib/telegram-usage-analytics";
import { clearAlertSnooze } from "../telegram-webhook-store";
import type { WebhookCommandHandler } from "./context";

export const handleUnsnooze: WebhookCommandHandler = async (ctx) => {
  await clearAlertSnooze(ctx.db, ctx.chatId, ctx.username);
  await recordTelegramUsageEvent(ctx.db, {
    eventType: "snooze_change",
    actionDetail: "unsnooze",
    outcome: "cleared",
  });
  await ctx.replyToChat("Alert snooze cleared.");
};
