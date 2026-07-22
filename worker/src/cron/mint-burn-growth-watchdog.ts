import type { CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";

/**
 * `mint_burn_events` is append-only by product decision: it is the immutable
 * on-chain event log behind /flows history and Telegram flow alerts, and no
 * retention pruning is applied. This watchdog enforces the agreed growth
 * budget instead — at ~1.43M rows the database sat at 3.09 GB of the 10 GB D1
 * cap, so ~2.3M rows extrapolates to the agreed ~5 GB revisit point. Crossing
 * the threshold reports degraded so the append-only decision gets actively
 * revisited instead of silently drifting toward the cap.
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
