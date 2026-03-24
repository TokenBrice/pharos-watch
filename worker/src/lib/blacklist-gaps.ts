import { BLACKLIST_RECENT_WINDOW_SEC } from "@shared/lib/status-thresholds";
import { isBlacklistAmountGapStatus } from "@shared/lib/blacklist";

export interface BlacklistGapMetrics {
  totalEvents: number;
  missingAmounts: number;
  recentMissingAmounts: number;
  recentWindowSec: number;
  missingRatio: number;
  oldestRecoverableAgeSec: number | null;
  neverAttemptedCount: number;
  repeatedFailureCount: number;
}

export async function queryBlacklistGapMetrics(
  db: D1Database,
  now: number,
  recentWindowSec = BLACKLIST_RECENT_WINDOW_SEC,
): Promise<BlacklistGapMetrics> {
  const gapStatuses = [
    "recoverable_pending",
    "provider_failed",
    "ambiguous",
  ].filter((status) => isBlacklistAmountGapStatus(status as Parameters<typeof isBlacklistAmountGapStatus>[0]));
  const gapStatusSql = gapStatuses.map((status) => `'${status}'`).join(", ");
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(
           CASE
             WHEN amount_status IN (${gapStatusSql})
             THEN 1
             ELSE 0
           END
         ) as missing,
         SUM(
           CASE
             WHEN amount_status IN (${gapStatusSql})
               AND timestamp >= ?
             THEN 1
             ELSE 0
           END
         ) as missing_recent,
         MAX(
           CASE
             WHEN amount_status IN (${gapStatusSql})
             THEN ? - timestamp
             ELSE NULL
           END
         ) as oldest_gap_age_sec,
         SUM(
           CASE
             WHEN amount_status IN (${gapStatusSql})
               AND COALESCE(amount_attempt_count, 0) = 0
             THEN 1
             ELSE 0
           END
         ) as never_attempted,
         SUM(
           CASE
             WHEN amount_status IN ('provider_failed', 'ambiguous')
               AND COALESCE(amount_attempt_count, 0) >= 3
             THEN 1
             ELSE 0
           END
         ) as repeated_failures
       FROM blacklist_events`,
    )
    .bind(now - recentWindowSec, now)
    .first<{
      total: number;
      missing: number | null;
      missing_recent: number | null;
      oldest_gap_age_sec: number | null;
      never_attempted: number | null;
      repeated_failures: number | null;
    }>();

  const totalEvents = row?.total ?? 0;
  const missingAmounts = row?.missing ?? 0;
  const recentMissingAmounts = row?.missing_recent ?? 0;

  return {
    totalEvents,
    missingAmounts,
    recentMissingAmounts,
    recentWindowSec,
    missingRatio: totalEvents > 0 ? missingAmounts / totalEvents : 0,
    oldestRecoverableAgeSec: row?.oldest_gap_age_sec ?? null,
    neverAttemptedCount: row?.never_attempted ?? 0,
    repeatedFailureCount: row?.repeated_failures ?? 0,
  };
}
