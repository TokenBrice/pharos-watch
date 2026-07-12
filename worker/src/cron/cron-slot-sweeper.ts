import { sendAlert } from "../lib/alerts";
import { throwIfAborted } from "../lib/abort";
import { sweepStaleScheduledSlotExecutions, type ScheduledSlotSweepSummary } from "../lib/cron-lease";
import type { CronResult } from "../lib/cron-logger";
import { getCache, setCache } from "../lib/db-cache";

const SLOT_SWEEPER_ALERT_CACHE_KEY = "cron-slot-sweeper:alert:scheduled-slot-abandoned:direct:v1";
const SLOT_SWEEPER_ALERT_COOLDOWN_SEC = 15 * 60;

function summarizeAbandonedSlots(summary: ScheduledSlotSweepSummary): string {
  return summary.abandonedSlots
    .slice(0, 12)
    .map((slot) => {
      const jobs =
        slot.abandonedJobs.length > 0 ? slot.abandonedJobs.map((job) => job.job).join(", ") : "no expired child leases";
      return `- ${slot.slotKey}@${slot.slotStartedAt}: ${jobs}`;
    })
    .join("\n");
}

async function shouldSendAlert(db: D1Database, nowSec: number): Promise<boolean> {
  const marker = await getCache(db, SLOT_SWEEPER_ALERT_CACHE_KEY);
  if (!marker) return true;
  return nowSec - marker.updatedAt >= SLOT_SWEEPER_ALERT_COOLDOWN_SEC;
}

async function markAlertAttempted(db: D1Database, nowSec: number, summary: ScheduledSlotSweepSummary): Promise<void> {
  await setCache(
    db,
    SLOT_SWEEPER_ALERT_CACHE_KEY,
    JSON.stringify({
      lastAlertedAt: nowSec,
      slotsReconciled: summary.slotsReconciled,
      syntheticCronRuns: summary.syntheticCronRuns,
    }),
  );
}

export async function runCronSlotSweeper(
  db: D1Database,
  alertWebhookUrl: string | null,
  signal?: AbortSignal,
): Promise<CronResult> {
  throwIfAborted(signal);
  const nowSec = Math.floor(Date.now() / 1000);
  const summary = await sweepStaleScheduledSlotExecutions(db, { nowSec, signal });
  throwIfAborted(signal);

  let alertDelivered = false;
  let alertSuppressed = false;
  if (summary.slotsReconciled > 0) {
    if (alertWebhookUrl && (await shouldSendAlert(db, nowSec))) {
      alertDelivered = await sendAlert(
        alertWebhookUrl,
        "Cron slot abandoned",
        [
          `Reconciled ${summary.slotsReconciled} stale scheduled slot(s) at ${new Date(nowSec * 1000).toISOString()}.`,
          `Synthetic child cron_runs inserted: ${summary.syntheticCronRuns}.`,
          summarizeAbandonedSlots(summary),
        ]
          .filter(Boolean)
          .join("\n"),
      );
      if (alertDelivered) {
        await markAlertAttempted(db, nowSec, summary);
      }
    } else {
      alertSuppressed = true;
    }
  }

  return {
    status: summary.slotsReconciled > 0 ? "degraded" : "ok",
    itemCount: summary.slotsReconciled,
    metadata: JSON.stringify({
      ...summary,
      alertDelivered,
      alertSuppressed,
    }),
  };
}
