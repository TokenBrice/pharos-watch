import { BLACKLIST_RECENT_WINDOW_SEC } from "@shared/lib/status-thresholds";

export interface BlacklistGapMetrics {
  totalEvents: number;
  missingAmounts: number;
  recentMissingAmounts: number;
  recentWindowSec: number;
  missingRatio: number;
}

export async function queryBlacklistGapMetrics(
  db: D1Database,
  now: number,
  recentWindowSec = BLACKLIST_RECENT_WINDOW_SEC,
): Promise<BlacklistGapMetrics> {
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(
           CASE
             WHEN amount IS NULL
               AND NOT (chain_id = 'tron' AND event_type IN ('blacklist', 'unblacklist'))
             THEN 1
             ELSE 0
           END
         ) as missing,
         SUM(
           CASE
             WHEN amount IS NULL
               AND NOT (chain_id = 'tron' AND event_type IN ('blacklist', 'unblacklist'))
               AND timestamp >= ?
             THEN 1
             ELSE 0
           END
         ) as missing_recent
       FROM blacklist_events`,
    )
    .bind(now - recentWindowSec)
    .first<{ total: number; missing: number | null; missing_recent: number | null }>();

  const totalEvents = row?.total ?? 0;
  const missingAmounts = row?.missing ?? 0;
  const recentMissingAmounts = row?.missing_recent ?? 0;

  return {
    totalEvents,
    missingAmounts,
    recentMissingAmounts,
    recentWindowSec,
    missingRatio: totalEvents > 0 ? missingAmounts / totalEvents : 0,
  };
}
