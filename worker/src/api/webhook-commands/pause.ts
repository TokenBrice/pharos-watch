import { escapeHtml } from "../../lib/telegram";
import { PAUSE_SENTINEL_TS, SNOOZE_SECONDS } from "../../lib/telegram-constants";
import { recordTelegramUsageEvent } from "../../lib/telegram-usage-analytics";
import { buildMiniAppOnlyKeyboard } from "../telegram-webhook-messages";
import {
  clearAlertSnooze,
  setSubscriberSnooze,
  unixNow,
} from "../telegram-webhook-store";
import { replyWithOptionalMiniApp, type WebhookCommandHandler } from "./context";

type SnoozeDurationToken = keyof typeof SNOOZE_SECONDS;

function isSnoozeDurationToken(token: string): token is SnoozeDurationToken {
  return token in SNOOZE_SECONDS;
}

const RESUME_TOKENS = new Set(["off", "resume"]);

/**
 * `/pause` — durable, reversible "pause all alerts" layered on the existing
 * chat-level snooze column (`alert_snooze_until_ts`), so the dispatcher's snooze
 * filter enforces it with no routing change.
 *
 * - No arg ⇒ write the far-future {@link PAUSE_SENTINEL_TS} (indefinite pause).
 * - `off` | `resume` ⇒ clear the snooze (resume delivery).
 * - A supported duration token (`1h` | `4h` | `24h`) ⇒ ordinary timed snooze,
 *   NOT the sentinel.
 *
 * Group invocations are admin-gated upstream like `/mute`
 * (`GROUP_ADMIN_GATED_COMMANDS` in `telegram-webhook.ts`).
 */
export const handlePause: WebhookCommandHandler = async (ctx, args) => {
  const { db, chatId, username } = ctx;
  const token = args.trim().toLowerCase();

  if (token.length === 0) {
    await setSubscriberSnooze(db, chatId, username, PAUSE_SENTINEL_TS);
    await recordTelegramUsageEvent(db, {
      eventType: "snooze_change",
      actionDetail: "pause",
      outcome: "enabled",
    });
    await replyWithOptionalMiniApp(
      ctx,
      escapeHtml(
        "All alerts paused indefinitely. Send /pause off (or /unsnooze) to resume.",
      ),
      buildMiniAppOnlyKeyboard("Open in app", "snooze"),
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
      buildMiniAppOnlyKeyboard("Open in app", "snooze"),
    );
    return;
  }

  if (isSnoozeDurationToken(token)) {
    await setSubscriberSnooze(db, chatId, username, unixNow() + SNOOZE_SECONDS[token]);
    await recordTelegramUsageEvent(db, {
      eventType: "snooze_change",
      actionDetail: "pause",
      outcome: "set",
    });
    await replyWithOptionalMiniApp(
      ctx,
      escapeHtml(`Alerts paused for ${token}. Send /pause off to resume sooner.`),
      buildMiniAppOnlyKeyboard("Open in app", "snooze"),
    );
    return;
  }

  await ctx.replyToChat(
    escapeHtml(
      "Usage: /pause (pause indefinitely), /pause off (resume), or /pause 1h|4h|24h (timed).",
    ),
  );
};
