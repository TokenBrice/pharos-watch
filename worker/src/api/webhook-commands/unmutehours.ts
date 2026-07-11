import { recordTelegramUsageEvent } from "../../lib/telegram-usage-analytics";
import { buildMiniAppOnlyKeyboard } from "../telegram-webhook-messages";
import { unixNow, upsertSubscriberRow } from "../telegram-webhook-store";
import {
  confirmCommandMutation,
  prepareCommandMutation,
  replyWithOptionalMiniApp,
  type WebhookCommandHandler,
} from "./context";

export const handleUnmuteHours: WebhookCommandHandler = async (ctx) => {
  const { db, chatId, username } = ctx;
  const operation = await prepareCommandMutation(ctx, "unmutehours", { enabled: false });
  if (!ctx.wasMutationApplied) {
    await upsertSubscriberRow(db, {
      chatId,
      username,
      nowSec: ctx.operationNowSec ?? unixNow(),
      quietHours: { enabled: false },
    }, operation);
    confirmCommandMutation(ctx, operation);
  }
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
