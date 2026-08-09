import { throwIfAborted } from "../lib/abort";
import { sweepStaleScheduledSlotExecutions } from "../lib/scheduled-slot-fence";
import type { CronResult } from "../lib/cron-logger";

export async function runCronSlotSweeper(
  db: D1Database,
  signal?: AbortSignal,
): Promise<CronResult> {
  throwIfAborted(signal);
  const nowSec = Math.floor(Date.now() / 1000);
  const summary = await sweepStaleScheduledSlotExecutions(db, { nowSec, signal });
  throwIfAborted(signal);

  return {
    status: summary.slotsReconciled > 0 ? "degraded" : "ok",
    itemCount: summary.slotsReconciled,
    metadata: JSON.stringify(summary),
  };
}
