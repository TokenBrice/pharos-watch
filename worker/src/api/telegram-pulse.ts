import { withErrorHandler, jsonResponse } from "../lib/api-utils";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { TelegramPulse } from "@shared/types/status";

const TELEGRAM_PULSE_CACHE_SECONDS = 300;

const ACTIVE_WATCHER_SQL_CONDITION = `s.global_alert_dews = 1
  OR s.global_alert_depeg = 1
  OR s.global_alert_safety = 1
  OR s.global_alert_launch = 1
  OR COALESCE(sub.active_sub_count, 0) > 0`;

const ACTIVE_SUBSCRIPTION_COUNTS_SQL = `SELECT chat_id,
        SUM(
          CASE
            WHEN alert_dews = 1
              OR alert_depeg = 1
              OR alert_safety = 1
              OR alert_launch = 1
            THEN 1 ELSE 0
          END
        ) AS active_sub_count
   FROM telegram_subscriptions
  GROUP BY chat_id`;

function coerceCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Lightweight public endpoint returning vanity metrics for the PharosWatchBot landing page.
 * No admin auth required. Safe subset of the full TelegramBotStats.
 */
export const handleTelegramPulse = withErrorHandler(
  "telegram-pulse",
  async (db: D1Database): Promise<Response> => {
    const nowSec = Math.floor(Date.now() / 1000);
    const [aggregate, topRows, historyRows, pendingDeliveries] = await Promise.all([
      db
        .prepare(
          `SELECT
             SUM(
               CASE
                 WHEN s.global_alert_dews = 1
                   OR s.global_alert_depeg = 1
                   OR s.global_alert_safety = 1
                   OR s.global_alert_launch = 1
                   OR COALESCE(sub.active_sub_count, 0) > 0
                 THEN 1 ELSE 0
               END
             ) AS active_watchers,
             SUM(COALESCE(sub.active_sub_count, 0)) AS coin_subscriptions,
             SUM(CASE WHEN COALESCE(sub.dews_enabled, 0) = 1 OR s.global_alert_dews = 1 THEN 1 ELSE 0 END) AS dews_chats,
             SUM(CASE WHEN COALESCE(sub.depeg_enabled, 0) = 1 OR s.global_alert_depeg = 1 THEN 1 ELSE 0 END) AS depeg_chats,
             SUM(CASE WHEN COALESCE(sub.safety_enabled, 0) = 1 OR s.global_alert_safety = 1 THEN 1 ELSE 0 END) AS safety_chats,
             SUM(CASE WHEN COALESCE(sub.launch_enabled, 0) = 1 OR s.global_alert_launch = 1 THEN 1 ELSE 0 END) AS launch_chats,
             SUM(
               CASE
                 WHEN (COALESCE(sub.dews_enabled, 0) = 1 OR s.global_alert_dews = 1)
                   AND (COALESCE(sub.depeg_enabled, 0) = 1 OR s.global_alert_depeg = 1)
                   AND (COALESCE(sub.safety_enabled, 0) = 1 OR s.global_alert_safety = 1)
                   AND (COALESCE(sub.launch_enabled, 0) = 1 OR s.global_alert_launch = 1)
                 THEN 1 ELSE 0
               END
             ) AS all_types_chats,
             SUM(CASE WHEN COALESCE(s.quiet_hours_enabled, 0) = 1 THEN 1 ELSE 0 END) AS quiet_hours_enabled_chats
           FROM telegram_subscribers s
           LEFT JOIN (
             SELECT chat_id,
                    SUM(
                      CASE
                        WHEN alert_dews = 1
                          OR alert_depeg = 1
                          OR alert_safety = 1
                          OR alert_launch = 1
                        THEN 1 ELSE 0
                      END
                    ) AS active_sub_count,
                    MAX(CASE WHEN alert_dews = 1 THEN 1 ELSE 0 END) AS dews_enabled,
                    MAX(CASE WHEN alert_depeg = 1 THEN 1 ELSE 0 END) AS depeg_enabled,
                    MAX(CASE WHEN alert_safety = 1 THEN 1 ELSE 0 END) AS safety_enabled,
                    MAX(CASE WHEN alert_launch = 1 THEN 1 ELSE 0 END) AS launch_enabled
               FROM telegram_subscriptions
              GROUP BY chat_id
           ) sub ON sub.chat_id = s.chat_id`,
        )
        .first<{
          active_watchers: number | string | null;
          coin_subscriptions: number | string | null;
          dews_chats: number | string | null;
          depeg_chats: number | string | null;
          safety_chats: number | string | null;
          launch_chats: number | string | null;
          all_types_chats: number | string | null;
          quiet_hours_enabled_chats: number | string | null;
        }>(),
      db
        .prepare(
          `SELECT stablecoin_id
             FROM telegram_subscriptions
            WHERE alert_dews = 1
               OR alert_depeg = 1
               OR alert_safety = 1
               OR alert_launch = 1
            GROUP BY stablecoin_id
            ORDER BY COUNT(*) DESC, stablecoin_id ASC
            LIMIT 5`,
        )
        .all<{ stablecoin_id: string }>(),
      db
        .prepare(
          `SELECT
             date(s.created_at, 'unixepoch') AS day,
             strftime('%s', date(s.created_at, 'unixepoch')) AS day_ts,
             COUNT(*) AS new_watchers
           FROM telegram_subscribers s
           LEFT JOIN (
             ${ACTIVE_SUBSCRIPTION_COUNTS_SQL}
           ) sub ON sub.chat_id = s.chat_id
           WHERE ${ACTIVE_WATCHER_SQL_CONDITION}
           GROUP BY day
           ORDER BY day ASC`,
        )
        .all<{ day: string | null; day_ts: string | number | null; new_watchers: number | null }>(),
      db
        .prepare("SELECT COUNT(*) AS pending_count FROM telegram_pending_alerts")
        .first<{ pending_count: number | string | null }>(),
    ]);

    let cumulativeWatchers = 0;
    const watcherHistory = (historyRows.results ?? [])
      .map((row) => {
        const newWatchers = Math.max(0, Number(row.new_watchers ?? 0));
        cumulativeWatchers += newWatchers;
        return {
          date: row.day ?? "",
          timestamp: Number(row.day_ts ?? 0) * 1000,
          newWatchers,
          activeWatchers: cumulativeWatchers,
        };
      })
      .filter((point) => point.date && Number.isFinite(point.timestamp) && point.timestamp > 0);

    const pulse: TelegramPulse = {
      activeWatchers: coerceCount(aggregate?.active_watchers),
      coinSubscriptions: coerceCount(aggregate?.coin_subscriptions),
      topCoins: (topRows.results ?? []).map(
        (row) => TRACKED_META_BY_ID.get(row.stablecoin_id)?.symbol ?? row.stablecoin_id,
      ),
      watcherHistory,
      alertTypeChats: {
        dews: coerceCount(aggregate?.dews_chats),
        depeg: coerceCount(aggregate?.depeg_chats),
        safety: coerceCount(aggregate?.safety_chats),
        launch: coerceCount(aggregate?.launch_chats),
        allTypes: coerceCount(aggregate?.all_types_chats),
      },
      quietHoursEnabledChats: coerceCount(aggregate?.quiet_hours_enabled_chats),
      pendingDeliveries: coerceCount(pendingDeliveries?.pending_count),
      updatedAt: nowSec,
      updatedEverySeconds: TELEGRAM_PULSE_CACHE_SECONDS,
    };

    return jsonResponse(pulse, {
      "Cache-Control": `public, max-age=${TELEGRAM_PULSE_CACHE_SECONDS}, s-maxage=${TELEGRAM_PULSE_CACHE_SECONDS}`,
    });
  },
);
