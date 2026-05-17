import { BLACKLIST_RECENT_WINDOW_SEC } from "@shared/lib/status-thresholds";
import { isBlacklistAmountGapStatus } from "@shared/lib/blacklist";

export interface BlacklistGapMetrics {
  totalEvents: number;
  missingAmounts: number;
  recentMissingAmounts: number;
  recentWindowSec: number;
  missingRatio: number;
  unrecoverableMissingAmounts: number;
  oldestRecoverableAgeSec: number | null;
  neverAttemptedCount: number;
  repeatedFailureCount: number;
  statusDistribution: Record<string, number>;
  sourceDistribution: Record<string, number>;
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
  const [row, statusRows, sourceRows] = await Promise.all([
    db
      .prepare(
        `/* blacklist-gap-aggregate */
         SELECT
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
           ) as repeated_failures,
           SUM(
             CASE
               WHEN amount_status = 'permanently_unavailable'
               THEN 1
               ELSE 0
             END
           ) as unrecoverable
         FROM blacklist_events
         WHERE event_type IN ('blacklist', 'destroy')
           AND suppression_reason IS NULL`,
      )
      .bind(now - recentWindowSec, now)
      .first<{
        total: number;
        missing: number | null;
        missing_recent: number | null;
        oldest_gap_age_sec: number | null;
        never_attempted: number | null;
        repeated_failures: number | null;
        unrecoverable: number | null;
      }>(),
    db
      .prepare(
        `/* blacklist-gap-status-distribution */
         SELECT amount_status, COUNT(*) AS n
         FROM blacklist_events
         WHERE event_type IN ('blacklist', 'destroy')
           AND suppression_reason IS NULL
         GROUP BY amount_status`,
      )
      .all<{ amount_status: string | null; n: number }>(),
    db
      .prepare(
        `/* blacklist-gap-source-distribution */
         SELECT amount_source, COUNT(*) AS n
         FROM blacklist_events
         WHERE event_type IN ('blacklist', 'destroy')
           AND suppression_reason IS NULL
         GROUP BY amount_source`,
      )
      .all<{ amount_source: string | null; n: number }>(),
  ]);

  const totalEvents = row?.total ?? 0;
  const missingAmounts = row?.missing ?? 0;
  const recentMissingAmounts = row?.missing_recent ?? 0;
  const statusDistribution = Object.fromEntries(
    (statusRows.results ?? []).map((statusRow) => [statusRow.amount_status ?? "unknown", statusRow.n]),
  );
  const sourceDistribution = Object.fromEntries(
    (sourceRows.results ?? []).map((sourceRow) => [sourceRow.amount_source ?? "unknown", sourceRow.n]),
  );

  return {
    totalEvents,
    missingAmounts,
    recentMissingAmounts,
    recentWindowSec,
    missingRatio: totalEvents > 0 ? missingAmounts / totalEvents : 0,
    unrecoverableMissingAmounts: row?.unrecoverable ?? 0,
    oldestRecoverableAgeSec: row?.oldest_gap_age_sec ?? null,
    neverAttemptedCount: row?.never_attempted ?? 0,
    repeatedFailureCount: row?.repeated_failures ?? 0,
    statusDistribution,
    sourceDistribution,
  };
}
