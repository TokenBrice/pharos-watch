import { throwIfAborted } from "../lib/abort";
import { sweepStaleScheduledSlotExecutions } from "../lib/scheduled-slot-fence";
import type { CronResult } from "../lib/cron-logger";
import { createCronResult } from "../lib/cron-result";

export async function runCronSlotSweeper(
  db: D1Database,
  signal?: AbortSignal,
  reconcilerWorkerVersion?: string | null,
): Promise<CronResult> {
  throwIfAborted(signal);
  const nowSec = Math.floor(Date.now() / 1000);
  const summary = await sweepStaleScheduledSlotExecutions(db, { nowSec, signal, reconcilerWorkerVersion });
  throwIfAborted(signal);

  return createCronResult({
    status: summary.slotsReconciled > 0 ? "degraded" : "ok",
    itemCount: summary.slotsReconciled,
    metadata: { ...summary },
  });
}
