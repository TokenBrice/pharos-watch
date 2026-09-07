import type { CronResult } from "../lib/cron-logger";
import { createCronResult } from "../lib/cron-result";
import { throwIfAborted } from "../lib/abort";

/**
 * `mint_burn_events` normally turns over through the critical producer's
 * bounded retention pass after rows are valued, aggregated, and projected to
 * Tape. The latest completed watchdog result is the O(1) proxy for the
 * current row count: ~2.3M rows is the existing proxy for the agreed ~5 GB
 * revisit point. Crossing it reports degraded so operators investigate
 * retention, protected repair debt, or unexpected producer growth before D1
 * approaches its cap.
 */
export const MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD = 2_300_000;

export async function runMintBurnGrowthWatchdog(
  db: D1Database,
  signal?: AbortSignal,
): Promise<CronResult> {
  throwIfAborted(signal);
  const row = await db
    .prepare(
      `SELECT item_count, metadata
       FROM cron_runs
       WHERE job = ? AND status IN ('ok', 'degraded')
       ORDER BY started_at DESC
       LIMIT 1`,
    )
    .bind("mint-burn-growth-watchdog")
    .first<{ item_count: number | null; metadata: string | null }>();
  throwIfAborted(signal);
  let rowCount = 0;
  if (typeof row?.item_count === "number") {
    rowCount = row.item_count;
  } else if (row?.metadata) {
    try {
      const metadata = JSON.parse(row.metadata) as { rowCount?: unknown };
      if (typeof metadata.rowCount === "number") rowCount = metadata.rowCount;
    } catch {
      // Treat malformed historical metadata as an empty count.
    }
  }

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
