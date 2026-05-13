import { escapeHtml } from "../../lib/telegram";
import { loadTelegramChatHealthDiagnostics } from "../../lib/telegram-usage-analytics";
import { isQuietHoursActive } from "../../cron/telegram-quiet-hours";
import {
  formatQuietHours,
  describeGlobalAlertSettings,
} from "../telegram-webhook-messages";
import {
  loadPresetSubscriptions,
  loadSubscriberByChat,
  unixNow,
} from "../telegram-webhook-store";
import type { WebhookCommandHandler } from "./context";

interface PendingAlertCountRow {
  pending_count: number | string | null;
}

interface RecentPendingFailureRow {
  last_error_class: string | null;
}

interface ExplicitActiveCountRow {
  active_count: number | string | null;
}

function coerceCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function formatAge(ts: number | null, nowSec: number): string {
  if (ts == null) return "Not recorded yet";
  const age = Math.max(0, nowSec - ts);
  if (age < 90) return "just now";
  if (age < 90 * 60) return `${Math.round(age / 60)} min ago`;
  if (age < 48 * 3600) return `${Math.round(age / 3600)} h ago`;
  return `${Math.round(age / 86400)} d ago`;
}

function formatSnooze(untilTs: number | null | undefined, nowSec: number): string {
  if (untilTs == null || untilTs <= nowSec) return "Off";
  const remaining = untilTs - nowSec;
  if (remaining < 90 * 60) return `Active for ${Math.round(remaining / 60)} min`;
  if (remaining < 48 * 3600) return `Active for ${Math.round(remaining / 3600)} h`;
  return `Active for ${Math.round(remaining / 86400)} d`;
}

function formatQuietHoursStatus(
  enabled: number | null | undefined,
  start: number | null | undefined,
  end: number | null | undefined,
  nowSec: number,
): string {
  if (!enabled || start == null || end == null) return "Off";
  const base = formatQuietHours(start, end);
  return isQuietHoursActive(nowSec, true, start, end) ? `${base} (active now)` : base;
}

async function loadPendingAlertCount(db: D1Database, chatId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS pending_count FROM telegram_pending_alerts WHERE chat_id = ?")
    .bind(chatId)
    .first<PendingAlertCountRow>();
  return coerceCount(row?.pending_count);
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
  ] = await Promise.all([
    loadSubscriberByChat(db, chatId),
    loadPresetSubscriptions(db, chatId),
    loadExplicitActiveFollowCount(db, chatId),
    loadPendingAlertCount(db, chatId),
    loadRecentPendingFailureClass(db, chatId),
    loadTelegramChatHealthDiagnostics(db, chatId),
  ]);

  const lastSuccessfulDelivery =
    deliveryDiagnostics?.lastSuccessfulDeliveryAt
    ?? deliveryDiagnostics?.lastSuccessfulReplyAt
    ?? null;
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
    `Last successful delivery: ${formatAge(lastSuccessfulDelivery, nowSec)}`,
    `Queued alerts for this chat: ${pendingAlerts}`,
    `Recent failure class: ${recentFailure}`,
    `Quiet hours: ${formatQuietHoursStatus(
      subscriber?.quiet_hours_enabled,
      subscriber?.quiet_hours_start_utc,
      subscriber?.quiet_hours_end_utc,
      nowSec,
    )}`,
    `Snooze: ${formatSnooze(subscriber?.alert_snooze_until_ts, nowSec)}`,
    `Alert readiness: ${readiness}`,
    "",
    "Use /list for full settings or /settings for inline controls.",
  ];

  await ctx.replyToChat(escapeHtml(lines.join("\n")));
};
