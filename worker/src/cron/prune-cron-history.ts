import type { CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";
import { SECONDS } from "../lib/time-constants";
import { runWithOverloadRetry } from "../lib/cron-lease";

// Kept in sync with the retention window previously enforced inline inside
// runScheduledSlotWithFence (14 days).  Consolidated here so the daily
// housekeeping pass is the single place that prunes cron observability rows.
const SLOT_EXECUTION_RETENTION_SEC = 14 * 24 * 60 * 60;

export async function runPruneCronHistory(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  throwIfAborted(signal);
  const now = Math.floor(Date.now() / 1000);

  const cronRunsResult = await runWithOverloadRetry(() =>
    db
      .prepare("DELETE FROM cron_runs WHERE started_at < ?")
      .bind(now - SECONDS.ONE_WEEK)
      .run(),
  );
  throwIfAborted(signal);
  const cronRunsDeleted = cronRunsResult.meta?.changes ?? 0;

  const slotResult = await runWithOverloadRetry(() =>
    db
      .prepare("DELETE FROM cron_slot_executions WHERE slot_started_at < ?")
      .bind(now - SLOT_EXECUTION_RETENTION_SEC)
      .run(),
  );
  throwIfAborted(signal);
  const slotExecutionsDeleted = slotResult.meta?.changes ?? 0;

  return {
    status: "ok",
    itemCount: cronRunsDeleted + slotExecutionsDeleted,
    metadata: JSON.stringify({
      cronRunsDeleted,
      slotExecutionsDeleted,
      cutoffCronRunsSec: now - SECONDS.ONE_WEEK,
      cutoffSlotExecutionsSec: now - SLOT_EXECUTION_RETENTION_SEC,
    }),
  };
}
