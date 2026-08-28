import type { CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";
import { SECONDS } from "../lib/time-constants";
import { runWithOverloadRetry } from "../lib/d1-overload-retry";
import { createCronResult } from "../lib/cron-result";
import { pruneRepairTasks } from "../lib/repair-tasks";
import { WORKER_CANARY_RUN_RETENTION_SEC, pruneWorkerCanaryRuns } from "../lib/canary-checks";
import { pruneScheduledRecoveryCheckpoints } from "../lib/scheduled-recovery-checkpoint";
import { pruneProducerHistory } from "../lib/producer-history";

// Kept in sync with the retention window previously enforced inline inside
// runScheduledSlotWithFence (14 days).  Consolidated here so the daily
// housekeeping pass is the single place that prunes cron observability rows.
const SLOT_EXECUTION_RETENTION_SEC = 14 * SECONDS.ONE_DAY;
const BLOCK_TIMESTAMP_CACHE_RETENTION_SEC = 14 * SECONDS.ONE_DAY;
const SELECTOR_SNAPSHOT_DAILY_QUOTA_RETENTION_SEC = 2 * SECONDS.ONE_DAY;

function toUtcDateString(timestampSec: number): string {
  return new Date(timestampSec * 1000).toISOString().slice(0, 10);
}

interface SimpleRetentionPolicy {
  sql: string;
  cutoff: number | string;
}

async function runSimpleRetentionPass(
  db: D1Database,
  policy: SimpleRetentionPolicy,
  signal?: AbortSignal,
): Promise<number> {
  const result = await runWithOverloadRetry(
    () => db.prepare(policy.sql).bind(policy.cutoff).run(),
    3,
    signal,
  );
  throwIfAborted(signal);
  return result.meta?.changes ?? 0;
}

export async function runPruneCronHistory(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  throwIfAborted(signal);
  const now = Math.floor(Date.now() / 1000);
  const selectorSnapshotDailyQuotaCutoffDate = toUtcDateString(now - SELECTOR_SNAPSHOT_DAILY_QUOTA_RETENTION_SEC);
  const simpleRetentionPolicies = {
    cronRuns: {
      sql: "DELETE FROM cron_runs WHERE started_at < ?",
      cutoff: now - SECONDS.ONE_WEEK,
    },
    selectorSnapshotDailyQuota: {
      sql: "DELETE FROM selector_snapshot_daily_quota WHERE quota_date < ?",
      cutoff: selectorSnapshotDailyQuotaCutoffDate,
    },
    blockTimestampCache: {
      sql: "DELETE FROM block_timestamp_cache WHERE updated_at < ?",
      cutoff: now - BLOCK_TIMESTAMP_CACHE_RETENTION_SEC,
    },
    slotExecutions: {
      sql: "DELETE FROM cron_slot_executions WHERE slot_started_at < ?",
      cutoff: now - SLOT_EXECUTION_RETENTION_SEC,
    },
  } as const;

  const cronRunsDeleted = await runSimpleRetentionPass(db, simpleRetentionPolicies.cronRuns, signal);

  const producerHistoryDeleted = await pruneProducerHistory(db, now, signal);
  throwIfAborted(signal);
  const repairTasksDeleted = await pruneRepairTasks(db, now - SECONDS.ONE_WEEK, signal);
  throwIfAborted(signal);
  const canaryRunsDeleted = await pruneWorkerCanaryRuns(db, now - WORKER_CANARY_RUN_RETENTION_SEC, signal);
  throwIfAborted(signal);
  const recoveryCheckpointsDeleted = await pruneScheduledRecoveryCheckpoints(
    db,
    now - SLOT_EXECUTION_RETENTION_SEC,
    signal,
  );
  throwIfAborted(signal);

  const selectorSnapshotDailyQuotaDeleted = await runSimpleRetentionPass(
    db,
    simpleRetentionPolicies.selectorSnapshotDailyQuota,
    signal,
  );
  const blockTimestampCacheDeleted = await runSimpleRetentionPass(
    db,
    simpleRetentionPolicies.blockTimestampCache,
    signal,
  );
  const slotExecutionsDeleted = await runSimpleRetentionPass(
    db,
    simpleRetentionPolicies.slotExecutions,
    signal,
  );

  return createCronResult({
    status: "ok",
    itemCount:
      cronRunsDeleted +
      producerHistoryDeleted +
      repairTasksDeleted +
      canaryRunsDeleted +
      recoveryCheckpointsDeleted +
      selectorSnapshotDailyQuotaDeleted +
      blockTimestampCacheDeleted +
      slotExecutionsDeleted,
    metadata: {
      cronRunsDeleted,
      producerHistoryDeleted,
      repairTasksDeleted,
      canaryRunsDeleted,
      recoveryCheckpointsDeleted,
      selectorSnapshotDailyQuotaDeleted,
      blockTimestampCacheDeleted,
      slotExecutionsDeleted,
      cutoffCronRunsSec: now - SECONDS.ONE_WEEK,
      cutoffRepairTasksSec: now - SECONDS.ONE_WEEK,
      cutoffCanaryRunsSec: now - WORKER_CANARY_RUN_RETENTION_SEC,
      cutoffRecoveryCheckpointsSec: now - SLOT_EXECUTION_RETENTION_SEC,
      cutoffSelectorSnapshotDailyQuotaDate: selectorSnapshotDailyQuotaCutoffDate,
      cutoffBlockTimestampCacheSec: now - BLOCK_TIMESTAMP_CACHE_RETENTION_SEC,
      cutoffSlotExecutionsSec: now - SLOT_EXECUTION_RETENTION_SEC,
    },
  });
}
