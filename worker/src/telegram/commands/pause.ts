import { escapeHtml, type InlineKeyboardButton } from "../delivery/telegram";
import { PAUSE_SENTINEL_TS, isPausedSentinel } from "@shared/lib/telegram-delivery-policy";
import { SNOOZE_SECONDS } from "../common/constants";
import { recordTelegramUsageEvent } from "../store/usage-analytics";
import {
  buildManageAlertsKeyboard,
  cmdForChat,
  formatSnoozeDuration,
} from "../webhook/telegram-webhook-messages";
import { clearAlertSnooze, setSubscriberSnooze } from "../store/snooze";
import { loadSubscriberByChat, unixNow } from "../store/subscribers";
import { replyWithOptionalMiniApp, type WebhookCommandHandler } from "./context";

type SnoozeDurationToken = keyof typeof SNOOZE_SECONDS;

function isSnoozeDurationToken(token: string): token is SnoozeDurationToken {
  return token in SNOOZE_SECONDS;
}

const RESUME_TOKENS = new Set(["off", "resume"]);

function buildPausedReplyMarkup(chatType: string): { inline_keyboard: InlineKeyboardButton[][] } {
  const rows: InlineKeyboardButton[][] = [[{ text: "Resume alerts", callback_data: "snooze:off" }]];
  if (chatType === "private") {
    rows.push(buildManageAlertsKeyboard("snooze").inline_keyboard[0]!);
  }
  return { inline_keyboard: rows };
}

function buildAlreadyPausedReplyMarkup(chatType: string): { inline_keyboard: InlineKeyboardButton[][] } {
  const rows: InlineKeyboardButton[][] = [
    [{ text: "Resume alerts", callback_data: "snooze:off" }],
    [
      { text: "4h", callback_data: "snooze:4h" },
      { text: "24h", callback_data: "snooze:24h" },
      { text: "Indefinitely", callback_data: "snooze:pause" },
    ],
  ];
  if (chatType === "private") {
    rows.push(buildManageAlertsKeyboard("snooze").inline_keyboard[0]!);
  }
  return { inline_keyboard: rows };
}

/**
 * `/pause` — durable, reversible "pause all alerts" layered on the existing
 * chat-level snooze column (`alert_snooze_until_ts`), so the dispatcher's snooze
 * filter enforces it with no routing change.
 *
 * - No arg when active ⇒ write {@link PAUSE_SENTINEL_TS} (indefinite pause) + `[Resume alerts]`.
 * - No arg when already paused ⇒ do NOT overwrite; show current state + `[Resume alerts]`
 *   and duration buttons `[4h]` `[24h]` `[Indefinitely]`.
 * - `off` | `resume` ⇒ clear the snooze (resume delivery).
 * - A supported duration token (`1h` | `4h` | `24h`) ⇒ ordinary timed snooze,
 *   NOT the sentinel.
 *
 * Group invocations are admin-gated upstream (ingress command policy).
 * `/unsnooze` is a legacy alias for `/pause off`.
 */
export const handlePause: WebhookCommandHandler = async (ctx, args) => {
  const { db, chatId, username } = ctx;
  const token = args.trim().toLowerCase();
  const pauseCmd = cmdForChat("pause", ctx.chatType);
  const nowSec = ctx.operationNowSec ?? unixNow();

  if (token.length === 0) {
    const subscriber = await loadSubscriberByChat(db, chatId);
    const existingUntil = subscriber?.alert_snooze_until_ts ?? null;
    if (existingUntil != null && existingUntil > nowSec) {
      const statusText = isPausedSentinel(existingUntil)
        ? "All alerts are already paused until you resume."
        : `All alerts are already paused for ${formatSnoozeDuration(existingUntil - nowSec)} more.`;
      await ctx.replyToChatWithMarkup(escapeHtml(statusText), {
        replyMarkup: buildAlreadyPausedReplyMarkup(ctx.chatType),
      });
      return;
    }

    await setSubscriberSnooze(db, chatId, username, PAUSE_SENTINEL_TS);
    await recordTelegramUsageEvent(db, {
      eventType: "snooze_change",
      actionDetail: "pause",
      outcome: "enabled",
    });
    await ctx.replyToChatWithMarkup(
      escapeHtml(`All alerts paused until you resume. Send ${pauseCmd} off to resume.`),
      { replyMarkup: buildPausedReplyMarkup(ctx.chatType) },
    );
    return;
  }

  if (RESUME_TOKENS.has(token)) {
    await clearAlertSnooze(db, chatId, username);
    await recordTelegramUsageEvent(db, {
      eventType: "snooze_change",
      actionDetail: "pause",
      outcome: "cleared",
    });
    await replyWithOptionalMiniApp(
      ctx,
      escapeHtml("Alerts resumed."),
      buildManageAlertsKeyboard("snooze"),
    );
    return;
  }

  if (isSnoozeDurationToken(token)) {
    const snoozeUntil = nowSec + SNOOZE_SECONDS[token];
    await setSubscriberSnooze(db, chatId, username, snoozeUntil);
    await recordTelegramUsageEvent(db, {
      eventType: "snooze_change",
      actionDetail: "pause",
      outcome: "set",
    });
    await ctx.replyToChatWithMarkup(
      escapeHtml(`Alerts paused for ${token}. Send ${pauseCmd} off to resume sooner.`),
      { replyMarkup: buildPausedReplyMarkup(ctx.chatType) },
    );
    return;
  }

  await ctx.replyToChat(
    escapeHtml(
      `Send ${pauseCmd} to hold all alerts, ${pauseCmd} 1h, 4h or 24h for a set time, or ${pauseCmd} off to resume.`,
    ),
  );
};
