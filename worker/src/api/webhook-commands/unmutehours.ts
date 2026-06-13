import { recordTelegramUsageEvent } from "../../lib/telegram-usage-analytics";
import { buildMiniAppOnlyKeyboard } from "../telegram-webhook-messages";
import { unixNow, upsertSubscriberRow } from "../telegram-webhook-store";
import { replyWithOptionalMiniApp, type WebhookCommandHandler } from "./context";

export const handleUnmuteHours: WebhookCommandHandler = async (ctx) => {
  const { db, chatId, username } = ctx;
  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: unixNow(),
    quietHours: { enabled: false },
  });
  await recordTelegramUsageEvent(db, {
    eventType: "quiet_hours_change",
    actionDetail: "unmutehours",
    outcome: "disabled",
  });
  await replyWithOptionalMiniApp(
    ctx,
    "Quiet hours disabled.",
    buildMiniAppOnlyKeyboard("Open in app", "quiet-hours"),
  );
};
