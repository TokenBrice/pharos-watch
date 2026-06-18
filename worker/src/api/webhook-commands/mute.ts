import { escapeHtml } from "../../lib/telegram";
import { recordTelegramUsageEvent } from "../../lib/telegram-usage-analytics";
import {
  buildMiniAppOnlyKeyboard,
  formatQuietHours,
} from "../telegram-webhook-messages";
import { parseQuietHours } from "../telegram-webhook-parsing";
import { loadSubscriberByChat, unixNow, upsertSubscriberRow } from "../telegram-webhook-store";
import { replyWithOptionalMiniApp, type WebhookCommandHandler } from "./context";

export const handleMute: WebhookCommandHandler = async (ctx, args) => {
  const { db, chatId, username } = ctx;
  const parsed = parseQuietHours(args);
  if ("error" in parsed) {
    await ctx.replyToChat(escapeHtml(parsed.error));
    return;
  }
  const subscriber = await loadSubscriberByChat(db, chatId);
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
    `Quiet hours enabled: ${formatQuietHours(parsed.startHourUtc, parsed.endHourUtc, subscriber?.timezone ?? null)}.\n` +
      "Messages will still arrive, but Telegram notifications will be silenced in that window.",
  );
  await replyWithOptionalMiniApp(
    ctx,
    message,
    buildMiniAppOnlyKeyboard("Open in app", "quiet-hours"),
  );
};
