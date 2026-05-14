import { recordTelegramUsageEvent } from "../../lib/telegram-usage-analytics";
import { buildMiniAppOnlyKeyboard } from "../telegram-webhook-messages";
import { clearAlertSnooze } from "../telegram-webhook-store";
import type { WebhookCommandHandler } from "./context";

export const handleUnsnooze: WebhookCommandHandler = async (ctx) => {
  await clearAlertSnooze(ctx.db, ctx.chatId, ctx.username);
  await recordTelegramUsageEvent(ctx.db, {
    eventType: "snooze_change",
    actionDetail: "unsnooze",
    outcome: "cleared",
  });
  if (ctx.chatType === "private") {
    await ctx.replyToChatWithMarkup("Alert snooze cleared.", {
      replyMarkup: buildMiniAppOnlyKeyboard("Open in app", "snooze"),
    });
    return;
  }
  await ctx.replyToChat("Alert snooze cleared.");
};
