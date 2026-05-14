import { escapeHtml } from "../../lib/telegram";
import { recordTelegramUsageEvent } from "../../lib/telegram-usage-analytics";
import {
  buildMiniAppOnlyKeyboard,
  formatQuietHours,
} from "../telegram-webhook-messages";
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
  await recordTelegramUsageEvent(db, {
    eventType: "quiet_hours_change",
    actionDetail: "mute",
    outcome: "enabled",
  });
  const message = escapeHtml(
    `Quiet hours enabled: ${formatQuietHours(parsed.startHourUtc, parsed.endHourUtc)}.\n` +
      "Messages will still arrive, but Telegram notifications will be silenced in that window.",
  );
  if (ctx.chatType === "private") {
    await ctx.replyToChatWithMarkup(message, {
      replyMarkup: buildMiniAppOnlyKeyboard("Tweak in app", "quiet-hours"),
    });
    return;
  }
  await ctx.replyToChat(message);
};
