import { withErrorHandler, jsonResponse } from "../lib/api-utils";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { TelegramPulse } from "@shared/types/status";

/**
 * Lightweight public endpoint returning vanity metrics for the /telegram landing page.
 * No admin auth required. Safe subset of the full TelegramBotStats.
 */
export const handleTelegramPulse = withErrorHandler(
  "telegram-pulse",
  async (db: D1Database): Promise<Response> => {
    const [aggregate, topRows] = await Promise.all([
      db
        .prepare(
          `SELECT
             SUM(
               CASE
                 WHEN s.global_alert_dews = 1
                   OR s.global_alert_depeg = 1
                   OR s.global_alert_safety = 1
                   OR COALESCE(sub.active_sub_count, 0) > 0
                 THEN 1 ELSE 0
               END
             ) AS active_watchers,
             SUM(COALESCE(sub.sub_count, 0)) AS coin_subscriptions
           FROM telegram_subscribers s
           LEFT JOIN (
             SELECT chat_id,
                    COUNT(*) AS sub_count,
                    SUM(CASE WHEN alert_dews = 1 OR alert_depeg = 1 OR alert_safety = 1 THEN 1 ELSE 0 END) AS active_sub_count
               FROM telegram_subscriptions
              GROUP BY chat_id
           ) sub ON sub.chat_id = s.chat_id`,
        )
        .first<{ active_watchers: number | null; coin_subscriptions: number | null }>(),
      db
        .prepare(
          `SELECT stablecoin_id
             FROM telegram_subscriptions
            GROUP BY stablecoin_id
            ORDER BY COUNT(*) DESC, stablecoin_id ASC
            LIMIT 5`,
        )
        .all<{ stablecoin_id: string }>(),
    ]);

    const pulse: TelegramPulse = {
      activeWatchers: Number(aggregate?.active_watchers ?? 0),
      coinSubscriptions: Number(aggregate?.coin_subscriptions ?? 0),
      topCoins: (topRows.results ?? []).map(
        (row) => TRACKED_META_BY_ID.get(row.stablecoin_id)?.symbol ?? row.stablecoin_id,
      ),
    };

    return jsonResponse(pulse, { "Cache-Control": "public, max-age=300, s-maxage=300" });
  },
);
