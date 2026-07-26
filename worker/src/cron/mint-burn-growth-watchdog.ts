import type { CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";

/**
 * `mint_burn_events` normally turns over through the critical producer's
 * bounded retention pass after rows are valued, aggregated, and projected to
 * Tape. This daily count remains a fail-safe for a cleanup that is no longer
 * converging: ~2.3M rows is the existing proxy for the agreed ~5 GB revisit
 * point. Crossing it reports degraded so operators investigate retention,
 * protected repair debt, or unexpected producer growth before D1 approaches
 * its cap.
 * D1 disallows PRAGMA page_count, hence the row-count proxy.
 */
export const MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD = 2_300_000;
export async function runMintBurnGrowthWatchdog(
  db: D1Database,
  signal?: AbortSignal,
): Promise<CronResult> {
  throwIfAborted(signal);
  const row = await db.prepare("SELECT COUNT(*) AS row_count FROM mint_burn_events").first<{ row_count: number }>();
  throwIfAborted(signal);
  const rowCount = row?.row_count ?? 0;

  if (rowCount < MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD) {
    return {
      itemCount: rowCount,
      metadata: JSON.stringify({ rowCount, thresholdRows: MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD }),
    };
  }

  return {
    status: "degraded",
    itemCount: rowCount,
    metadata: JSON.stringify({
      rowCount,
      thresholdRows: MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD,
    }),
  };
}
