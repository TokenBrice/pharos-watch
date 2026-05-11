import { jsonResponse } from "../lib/api-utils";
import { runAdminRoute } from "../lib/route-wrappers";

interface SubscriberRow {
  chat_id: string;
  username: string | null;
  alert_dews: number;
  alert_depeg: number;
  alert_safety: number;
  alert_launch: number;
  global_alert_dews: number;
  global_alert_depeg: number;
  global_alert_safety: number;
  global_alert_launch: number;
  global_depeg_worsening_bps_step: number | null;
  quiet_hours_enabled: number;
  quiet_hours_start_utc: number | null;
  quiet_hours_end_utc: number | null;
  alert_snooze_until_ts: number | null;
  created_at: number;
  last_active_at: number;
}

interface SubscriptionRow {
  stablecoin_id: string;
  alert_dews: number;
  alert_depeg: number;
  alert_safety: number;
  alert_launch: number;
  dews_min_band: string | null;
  safety_mode: string | null;
  depeg_worsening_bps_step: number | null;
}

interface PresetRow {
  preset_id: string;
  alert_dews: number;
  alert_depeg: number;
  alert_safety: number;
  depeg_worsening_bps_step: number | null;
  created_at: number;
  updated_at: number;
}

interface PendingDisambiguationRow {
  alert_types: string;
  resolved_ids: string;
  ambiguous_ticker: string;
  candidates: string;
  remaining_tickers: string;
  expires_at: number;
  action_type: string;
  action_payload: string;
  initiator_user_id: string | null;
}

interface PendingAlertsAggregateRow {
  count: number | null;
  oldest_created_at: number | null;
  newest_created_at: number | null;
  last_error_class: string | null;
  earliest_not_before_at: number | null;
}

export function handleAdminTelegramChat(
  db: D1Database,
  chatId: string,
  trustedAdmin: boolean,
  request: Request,
): Promise<Response> {
  return runAdminRoute(
    {
      endpoint: "route-admin-telegram-chat",
      request,
      trustedAdmin,
    },
    async () => {
      const subscriber = await db
        .prepare(
          `SELECT chat_id, username, alert_dews, alert_depeg, alert_safety, alert_launch,
                  global_alert_dews, global_alert_depeg, global_alert_safety, global_alert_launch,
                  global_depeg_worsening_bps_step,
                  quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc,
                  alert_snooze_until_ts, created_at, last_active_at
             FROM telegram_subscribers
             WHERE chat_id = ?`,
        )
        .bind(chatId)
        .first<SubscriberRow>();

      if (!subscriber) {
        return jsonResponse({ error: "Not found", chatId }, { status: 404, noStore: true });
      }

      const subscriptionsResult = await db
        .prepare(
          `SELECT stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch,
                  dews_min_band, safety_mode, depeg_worsening_bps_step
             FROM telegram_subscriptions
             WHERE chat_id = ?
             ORDER BY stablecoin_id`,
        )
        .bind(chatId)
        .all<SubscriptionRow>();

      const presetsResult = await db
        .prepare(
          `SELECT preset_id, alert_dews, alert_depeg, alert_safety, depeg_worsening_bps_step,
                  created_at, updated_at
             FROM telegram_preset_subscriptions
             WHERE chat_id = ?
             ORDER BY preset_id`,
        )
        .bind(chatId)
        .all<PresetRow>();

      const pendingDisambiguation = await db
        .prepare(
          `SELECT alert_types, resolved_ids, ambiguous_ticker, candidates, remaining_tickers,
                  expires_at, action_type, action_payload, initiator_user_id
             FROM telegram_pending_disambiguation
             WHERE chat_id = ?`,
        )
        .bind(chatId)
        .first<PendingDisambiguationRow>();

      const pendingAlertsAggregate = await db
        .prepare(
          `SELECT COUNT(*) AS count,
                  MIN(created_at) AS oldest_created_at,
                  MAX(created_at) AS newest_created_at,
                  MIN(not_before_at) AS earliest_not_before_at
             FROM telegram_pending_alerts
             WHERE chat_id = ?`,
        )
        .bind(chatId)
        .first<PendingAlertsAggregateRow>();

      const recentRetryError = await db
        .prepare(
          `SELECT last_error_class
             FROM telegram_pending_alerts
             WHERE chat_id = ? AND last_error_class IS NOT NULL
             ORDER BY COALESCE(updated_at, created_at) DESC
             LIMIT 1`,
        )
        .bind(chatId)
        .first<{ last_error_class: string | null }>();

      const now = Math.floor(Date.now() / 1000);
      const snoozeActive =
        typeof subscriber.alert_snooze_until_ts === "number"
        && subscriber.alert_snooze_until_ts > now;
      const quietHoursEnabled = subscriber.quiet_hours_enabled === 1;

      const body = {
        chatId,
        subscriber: {
          chatId: subscriber.chat_id,
          username: subscriber.username,
          createdAt: subscriber.created_at,
          lastActiveAt: subscriber.last_active_at,
          globalAlerts: {
            dews: subscriber.global_alert_dews,
            depeg: subscriber.global_alert_depeg,
            safety: subscriber.global_alert_safety,
            launch: subscriber.global_alert_launch,
            depegWorseningBpsStep: subscriber.global_depeg_worsening_bps_step,
          },
          perCoinAlertFlags: {
            dews: subscriber.alert_dews,
            depeg: subscriber.alert_depeg,
            safety: subscriber.alert_safety,
            launch: subscriber.alert_launch,
          },
          quietHours: {
            enabled: quietHoursEnabled,
            startHourUtc: subscriber.quiet_hours_start_utc,
            endHourUtc: subscriber.quiet_hours_end_utc,
          },
          snooze: {
            active: snoozeActive,
            untilTs: subscriber.alert_snooze_until_ts,
          },
        },
        subscriptions: subscriptionsResult.results ?? [],
        presets: presetsResult.results ?? [],
        pendingDisambiguation: pendingDisambiguation
          ? {
              alertTypes: pendingDisambiguation.alert_types,
              resolvedIds: pendingDisambiguation.resolved_ids,
              ambiguousTicker: pendingDisambiguation.ambiguous_ticker,
              candidates: pendingDisambiguation.candidates,
              remainingTickers: pendingDisambiguation.remaining_tickers,
              expiresAt: pendingDisambiguation.expires_at,
              actionType: pendingDisambiguation.action_type,
              actionPayload: pendingDisambiguation.action_payload,
              initiatorUserId: pendingDisambiguation.initiator_user_id,
            }
          : null,
        pendingAlerts: {
          count: pendingAlertsAggregate?.count ?? 0,
          oldestCreatedAt: pendingAlertsAggregate?.oldest_created_at ?? null,
          newestCreatedAt: pendingAlertsAggregate?.newest_created_at ?? null,
          earliestNotBeforeAt: pendingAlertsAggregate?.earliest_not_before_at ?? null,
          recentRetryErrorClass: recentRetryError?.last_error_class ?? null,
        },
      };

      return jsonResponse(body, { noStore: true });
    },
  );
}
