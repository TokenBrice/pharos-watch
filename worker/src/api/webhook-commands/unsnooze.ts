import { recordTelegramUsageEvent } from "../../lib/telegram-usage-analytics";
import { buildMiniAppOnlyKeyboard } from "../telegram-webhook-messages";
import { clearAlertSnooze } from "../telegram-webhook-store";
import { replyWithOptionalMiniApp, type WebhookCommandHandler } from "./context";

export const handleUnsnooze: WebhookCommandHandler = async (ctx) => {
  await clearAlertSnooze(ctx.db, ctx.chatId, ctx.username);
  await recordTelegramUsageEvent(ctx.db, {
    eventType: "snooze_change",
    actionDetail: "unsnooze",
    outcome: "cleared",
  });
  await replyWithOptionalMiniApp(
    ctx,
    "Alert snooze cleared.",
    buildMiniAppOnlyKeyboard("Open in app", "snooze"),
  );
};
