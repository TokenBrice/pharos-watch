import type { CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";
import { SECONDS } from "../lib/time-constants";
import { runWithOverloadRetry } from "../lib/cron-lease";
import { createCronResult } from "../lib/cron-result";
import { pruneWorkerJobAttempts } from "../lib/job-ledger";
import { pruneRepairTasks } from "../lib/repair-tasks";
import { WORKER_CANARY_RUN_RETENTION_SEC, pruneWorkerCanaryRuns } from "../lib/canary-checks";

// Kept in sync with the retention window previously enforced inline inside
// runScheduledSlotWithFence (14 days).  Consolidated here so the daily
// housekeeping pass is the single place that prunes cron observability rows.
const SLOT_EXECUTION_RETENTION_SEC = 14 * SECONDS.ONE_DAY;
const BLOCK_TIMESTAMP_CACHE_RETENTION_SEC = 14 * SECONDS.ONE_DAY;
const SELECTOR_SNAPSHOT_DAILY_QUOTA_RETENTION_SEC = 2 * SECONDS.ONE_DAY;

function toUtcDateString(timestampSec: number): string {
  return new Date(timestampSec * 1000).toISOString().slice(0, 10);
}

export async function runPruneCronHistory(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  throwIfAborted(signal);
  const now = Math.floor(Date.now() / 1000);
  const selectorSnapshotDailyQuotaCutoffDate = toUtcDateString(now - SELECTOR_SNAPSHOT_DAILY_QUOTA_RETENTION_SEC);

  const cronRunsResult = await runWithOverloadRetry(() =>
    db
      .prepare("DELETE FROM cron_runs WHERE started_at < ?")
      .bind(now - SECONDS.ONE_WEEK)
      .run(),
    3,
    signal,
  );
  throwIfAborted(signal);
  const cronRunsDeleted = cronRunsResult.meta?.changes ?? 0;

  const jobAttemptsDeleted = await pruneWorkerJobAttempts(db, now - SECONDS.ONE_WEEK, signal);
  throwIfAborted(signal);
  const repairTasksDeleted = await pruneRepairTasks(db, now - SECONDS.ONE_WEEK, signal);
  throwIfAborted(signal);
  const canaryRunsDeleted = await pruneWorkerCanaryRuns(db, now - WORKER_CANARY_RUN_RETENTION_SEC, signal);
  throwIfAborted(signal);

  const selectorSnapshotDailyQuotaResult = await runWithOverloadRetry(() =>
    db
      .prepare("DELETE FROM selector_snapshot_daily_quota WHERE quota_date < ?")
      .bind(selectorSnapshotDailyQuotaCutoffDate)
      .run(),
    3,
    signal,
  );
  throwIfAborted(signal);
  const selectorSnapshotDailyQuotaDeleted = selectorSnapshotDailyQuotaResult.meta?.changes ?? 0;

  const blockTimestampCacheResult = await runWithOverloadRetry(() =>
    db
      .prepare("DELETE FROM block_timestamp_cache WHERE updated_at < ?")
      .bind(now - BLOCK_TIMESTAMP_CACHE_RETENTION_SEC)
      .run(),
    3,
    signal,
  );
  throwIfAborted(signal);
  const blockTimestampCacheDeleted = blockTimestampCacheResult.meta?.changes ?? 0;

  const slotResult = await runWithOverloadRetry(() =>
    db
      .prepare("DELETE FROM cron_slot_executions WHERE slot_started_at < ?")
      .bind(now - SLOT_EXECUTION_RETENTION_SEC)
      .run(),
    3,
    signal,
  );
  throwIfAborted(signal);
  const slotExecutionsDeleted = slotResult.meta?.changes ?? 0;

  return createCronResult({
    status: "ok",
    itemCount:
      cronRunsDeleted +
      jobAttemptsDeleted +
      repairTasksDeleted +
      canaryRunsDeleted +
      selectorSnapshotDailyQuotaDeleted +
      blockTimestampCacheDeleted +
      slotExecutionsDeleted,
    metadata: {
      cronRunsDeleted,
      jobAttemptsDeleted,
      repairTasksDeleted,
      canaryRunsDeleted,
      selectorSnapshotDailyQuotaDeleted,
      blockTimestampCacheDeleted,
      slotExecutionsDeleted,
      cutoffCronRunsSec: now - SECONDS.ONE_WEEK,
      cutoffJobAttemptsSec: now - SECONDS.ONE_WEEK,
      cutoffRepairTasksSec: now - SECONDS.ONE_WEEK,
      cutoffCanaryRunsSec: now - WORKER_CANARY_RUN_RETENTION_SEC,
      cutoffSelectorSnapshotDailyQuotaDate: selectorSnapshotDailyQuotaCutoffDate,
      cutoffBlockTimestampCacheSec: now - BLOCK_TIMESTAMP_CACHE_RETENTION_SEC,
      cutoffSlotExecutionsSec: now - SLOT_EXECUTION_RETENTION_SEC,
    },
  });
}
