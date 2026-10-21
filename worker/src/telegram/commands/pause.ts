import { escapeHtml } from "../delivery/telegram";
import { PAUSE_SENTINEL_TS } from "@shared/lib/telegram-delivery-policy";
import { SNOOZE_SECONDS } from "../common/constants";
import { recordTelegramUsageEvent } from "../store/usage-analytics";
import { buildManageAlertsKeyboard } from "../webhook/telegram-webhook-messages";
import { clearAlertSnooze, setSubscriberSnooze } from "../store/snooze";
import { unixNow } from "../store/subscribers";
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
 * Group invocations are admin-gated upstream (ingress command policy).
 * `/unsnooze` is a legacy alias for `/pause off`.
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
        "All alerts paused until you resume. Send /pause off to resume.",
      ),
      buildManageAlertsKeyboard("snooze"),
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
    const snoozeUntil = (ctx.operationNowSec ?? unixNow()) + SNOOZE_SECONDS[token];
    await setSubscriberSnooze(db, chatId, username, snoozeUntil);
    await recordTelegramUsageEvent(db, {
      eventType: "snooze_change",
      actionDetail: "pause",
      outcome: "set",
    });
    await replyWithOptionalMiniApp(
      ctx,
      escapeHtml(`Alerts paused for ${token}. Send /pause off to resume sooner.`),
      buildManageAlertsKeyboard("snooze"),
    );
    return;
  }

  await ctx.replyToChat(
    escapeHtml(
      "Send /pause to hold all alerts, /pause 1h, 4h or 24h for a set time, or /pause off to resume.",
    ),
  );
};
