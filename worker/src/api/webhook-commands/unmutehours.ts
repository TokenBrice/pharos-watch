import { unixNow, upsertSubscriberRow } from "../telegram-webhook-store";
import type { WebhookCommandHandler } from "./context";

export const handleUnmuteHours: WebhookCommandHandler = async (ctx) => {
  const { db, chatId, username } = ctx;
  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: unixNow(),
    quietHours: { enabled: false },
  });
  await ctx.replyToChat("Quiet hours disabled.");
};
