import type { CronResult } from "../lib/cron-logger";
import { createCronResult } from "../lib/cron-result";
import { throwIfAborted } from "../lib/abort";

/**
 * `mint_burn_events` normally turns over through the critical producer's
 * bounded retention pass after rows are valued, aggregated, and projected to
 * Tape. Count the current retained events independently of prior watchdog runs.
 * ~2.3M rows is the proxy for the agreed ~5 GB revisit point; crossing it
 * reports degraded before D1 approaches its cap.
 */
export const MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD = 2_300_000;

export async function runMintBurnGrowthWatchdog(
  db: D1Database,
  signal?: AbortSignal,
): Promise<CronResult> {
  throwIfAborted(signal);
  const row = await db
    .prepare("SELECT COUNT(*) AS rowCount FROM mint_burn_events")
    .first<{ rowCount: number }>();
  throwIfAborted(signal);
  if (!row || !Number.isSafeInteger(row.rowCount) || row.rowCount < 0) {
    throw new Error("Mint/burn growth watchdog row count unavailable");
  }
  const rowCount = row.rowCount;

  if (rowCount < MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD) {
    return createCronResult({
      itemCount: rowCount,
      metadata: { rowCount, thresholdRows: MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD },
    });
  }

  return createCronResult({
    status: "degraded",
    itemCount: rowCount,
    metadata: { rowCount, thresholdRows: MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD },
  });
}
