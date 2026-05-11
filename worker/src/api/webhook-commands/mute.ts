import { escapeHtml } from "../../lib/telegram";
import { formatQuietHours } from "../telegram-webhook-messages";
import { parseQuietHours } from "../telegram-webhook-parsing";
import { unixNow, upsertSubscriberRow } from "../telegram-webhook-store";
import type { WebhookCommandHandler } from "./context";

export const handleMute: WebhookCommandHandler = async (ctx, args) => {
  const { db, chatId, username } = ctx;
  const parsed = parseQuietHours(args);
  if ("error" in parsed) {
    await ctx.replyToChat(escapeHtml(parsed.error));
    return;
  }
  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: unixNow(),
    quietHours: {
      enabled: true,
      startHourUtc: parsed.startHourUtc,
      endHourUtc: parsed.endHourUtc,
    },
  });
  await ctx.replyToChat(
    escapeHtml(
      `Quiet hours enabled: ${formatQuietHours(parsed.startHourUtc, parsed.endHourUtc)}.\n` +
        "Messages will still arrive, but Telegram notifications will be silenced in that window.",
    ),
  );
};
