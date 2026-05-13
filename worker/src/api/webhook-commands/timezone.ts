import { escapeHtml } from "../../lib/telegram";
import { recordTelegramUsageEvent } from "../../lib/telegram-usage-analytics";
import { isValidIanaTimezone } from "../../cron/telegram-quiet-hours";
import {
  loadSubscriberByChat,
  setSubscriberTimezone,
} from "../telegram-webhook-store";
import type { WebhookCommandHandler } from "./context";

/**
 * Subset of IANA zones surfaced as a fallback inline keyboard when `/timezone`
 * is invoked without an argument. Kept short so the message fits one screen
 * and so we can verify each zone is recognized by the runtime ICU tables at
 * the call site rather than relying on user typing.
 */
const TIMEZONE_QUICK_PICK_ZONES = [
  "UTC",
  "Europe/London",
  "Europe/Paris",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Australia/Sydney",
] as const;

function buildTimezoneKeyboard(): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  // Two zones per row keeps the callback labels readable on narrow Telegram
  // clients and well under the 64-byte callback_data limit.
  for (let i = 0; i < TIMEZONE_QUICK_PICK_ZONES.length; i += 2) {
    const row = TIMEZONE_QUICK_PICK_ZONES.slice(i, i + 2).map((zone) => ({
      text: zone,
      callback_data: `tz:${zone}`,
    }));
    rows.push(row);
  }
  return { inline_keyboard: rows };
}

function formatTimezoneStatusLine(currentTimezone: string | null | undefined): string {
  const current = currentTimezone ?? "UTC (default)";
  return `Current timezone: ${current}.`;
}

export const handleTimezone: WebhookCommandHandler = async (ctx, args) => {
  const { db, chatId, username } = ctx;
  const trimmed = args.trim();

  if (!trimmed) {
    const subscriber = await loadSubscriberByChat(db, chatId);
    const message = [
      formatTimezoneStatusLine(subscriber?.timezone ?? null),
      "",
      "Pick a common zone below, or send <code>/timezone &lt;IANA-zone&gt;</code> (e.g. <code>/timezone Europe/Paris</code>).",
      "Quiet hours from /mute are interpreted in this zone (NULL = UTC).",
    ].join("\n");
    await ctx.replyToChatWithMarkup(message, { replyMarkup: buildTimezoneKeyboard() });
    return;
  }

  // Accept a single token. Reject obviously malformed input before the more
  // expensive ICU probe; keeps log noise down for spammy input.
  if (/\s/.test(trimmed) || trimmed.length > 64) {
    await ctx.replyToChat(
      escapeHtml(
        "Usage: /timezone <IANA-zone>, e.g. /timezone Europe/Paris. Use /timezone with no argument to pick from common zones.",
      ),
    );
    return;
  }

  if (!isValidIanaTimezone(trimmed)) {
    await ctx.replyToChat(
      escapeHtml(
        `Unknown timezone "${trimmed}". Use an IANA zone like Europe/Paris or America/New_York, or send /timezone with no argument to pick from common zones.`,
      ),
    );
    return;
  }

  await setSubscriberTimezone(db, chatId, username, trimmed);
  await recordTelegramUsageEvent(db, {
    eventType: "timezone_change",
    actionDetail: "iana",
    outcome: "set",
  });
  await ctx.replyToChat(
    escapeHtml(
      `Timezone set to ${trimmed}. Quiet hours from /mute will now be interpreted in this zone.`,
    ),
  );
};
