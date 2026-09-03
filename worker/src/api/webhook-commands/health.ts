import { escapeHtml } from "../../lib/telegram";
import { isPausedSentinel } from "../../lib/telegram/constants";
import { formatTelegramAge } from "../../lib/telegram/format-age";
import { coerceCount, loadTelegramChatHealthDiagnostics } from "../../lib/telegram/usage-analytics";
import { isQuietHoursActive } from "../../lib/telegram/quiet-hours";
import {
  buildMiniAppOnlyKeyboard,
  formatQuietHours,
  describeGlobalAlertSettings,
} from "../telegram-webhook-messages";
import {
  loadPresetSubscriptions,
  loadSubscriberByChat,
  unixNow,
} from "../telegram-webhook-store";
import type { WebhookCommandHandler } from "./context";
import {
  loadTelegramPendingAlertCount,
  loadTelegramRecapState,
} from "../telegram-store/chat-state";

interface RecentPendingFailureRow {
  last_error_class: string | null;
}

interface ExplicitActiveCountRow {
  active_count: number | string | null;
}

function formatAge(ts: number | null, nowSec: number): string {
  return formatTelegramAge(ts, nowSec, {
    invalidFallback: "Not recorded yet",
    suffix: "ago",
    nowLabel: "just now",
    unitStyle: "short",
  });
}

function formatSnooze(untilTs: number | null | undefined, nowSec: number): string {
  if (untilTs == null || untilTs <= nowSec) return "Off";
  if (isPausedSentinel(untilTs)) return "Paused (indefinite)";
  const remaining = untilTs - nowSec;
  if (remaining < 90 * 60) return `Active for ${Math.round(remaining / 60)} min`;
  if (remaining < 48 * 3600) return `Active for ${Math.round(remaining / 3600)} h`;
  return `Active for ${Math.round(remaining / 86400)} d`;
}

function formatQuietHoursStatus(
  enabled: number | null | undefined,
  start: number | null | undefined,
  end: number | null | undefined,
  timezone: string | null | undefined,
  nowSec: number,
): string {
  if (!enabled || start == null || end == null) return "Off";
  const base = formatQuietHours(start, end, timezone ?? null);
  return isQuietHoursActive(nowSec, true, start, end, timezone ?? null) ? `${base} (active now)` : base;
}

async function loadRecentPendingFailureClass(
  db: D1Database,
  chatId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT last_error_class
         FROM telegram_pending_alerts
        WHERE chat_id = ?
          AND last_error_class IS NOT NULL
          AND last_error_class <> ''
        ORDER BY COALESCE(updated_at, created_at) DESC
        LIMIT 1`,
    )
    .bind(chatId)
    .first<RecentPendingFailureRow>();
  return row?.last_error_class ?? null;
}

async function loadExplicitActiveFollowCount(
  db: D1Database,
  chatId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS active_count
         FROM telegram_subscriptions
        WHERE chat_id = ?
          AND (
            alert_dews = 1
            OR alert_depeg = 1
            OR alert_safety = 1
            OR alert_launch = 1
            OR alert_reserve = 1
            OR alert_freeze = 1
          )`,
    )
    .bind(chatId)
    .first<ExplicitActiveCountRow>();
  return coerceCount(row?.active_count);
}

export const handleHealth: WebhookCommandHandler = async (ctx) => {
  const { db, chatId } = ctx;
  const nowSec = unixNow();
  const [
    subscriber,
    presetSubscriptions,
    explicitActiveFollows,
    pendingAlerts,
    recentPendingFailure,
    deliveryDiagnostics,
    recap,
  ] = await Promise.all([
    loadSubscriberByChat(db, chatId),
    loadPresetSubscriptions(db, chatId),
    loadExplicitActiveFollowCount(db, chatId),
    loadTelegramPendingAlertCount(db, chatId),
    loadRecentPendingFailureClass(db, chatId),
    loadTelegramChatHealthDiagnostics(db, chatId),
    loadTelegramRecapState(db, chatId),
  ]);

  const recentFailure =
    deliveryDiagnostics?.recentFailureClass
    ?? recentPendingFailure
    ?? "None";
  const activePresetCount = presetSubscriptions.filter(
    (preset) => preset.alert_dews || preset.alert_depeg || preset.alert_safety,
  ).length;
  const readiness = [
    `${explicitActiveFollows} explicit coin follow${explicitActiveFollows === 1 ? "" : "s"}`,
    `${activePresetCount} dynamic preset${activePresetCount === 1 ? "" : "s"}`,
    `global: ${describeGlobalAlertSettings(subscriber)}`,
  ].join("; ");

  const lines = [
    "Bot Health",
    `Last successful alert delivery: ${formatAge(deliveryDiagnostics?.lastSuccessfulDeliveryAt ?? null, nowSec)}`,
    `Last successful command reply: ${formatAge(deliveryDiagnostics?.lastSuccessfulReplyAt ?? null, nowSec)}`,
    `Queued alerts for this chat: ${pendingAlerts}`,
    `Recent failure class: ${recentFailure}`,
    `Quiet hours: ${formatQuietHoursStatus(
      subscriber?.quiet_hours_enabled,
      subscriber?.quiet_hours_start_utc,
      subscriber?.quiet_hours_end_utc,
      subscriber?.timezone,
      nowSec,
    )}`,
    `Snooze: ${formatSnooze(subscriber?.alert_snooze_until_ts, nowSec)}`,
    `Alert readiness: ${readiness}`,
    `Daily recap: ${recap?.enabled === 1 ? "On" : "Off"}`,
    `Recap next due: ${recap?.next_due_at == null ? "Not scheduled" : new Date(recap.next_due_at * 1000).toISOString()}`,
    `Recap last local date: ${recap?.last_delivered_local_date ?? "Not recorded yet"}`,
    `Recap last outcome: ${recap?.last_outcome ?? "Not recorded yet"}`,
    "",
    "Use /list for full settings or /settings for inline controls.",
  ];

  const message = escapeHtml(lines.join("\n"));
  if (ctx.chatType === "private") {
    await ctx.replyToChatWithMarkup(message, {
      replyMarkup: buildMiniAppOnlyKeyboard("Open in app", "health"),
    });
    return;
  }
  await ctx.replyToChat(message);
};
