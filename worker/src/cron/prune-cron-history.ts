import type { CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";
import { SECONDS } from "../lib/time-constants";
import { runWithOverloadRetry } from "../lib/cron-lease";
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

// Owner rulings for append-only archive tables audited with this prune job.
// They are intentionally absent from the DELETE statements below.
export const ARCHIVE_TABLES_WITHOUT_RETENTION_PRUNE = [
  {
    table: "daily_digest",
    policy: "product archive - keep forever",
    reason: "Digest snapshots, archive pages, recent-copy context, and total-mcap ATH reads depend on historical rows.",
  },
  {
    table: "admin_action_audit",
    policy: "operator audit archive - keep forever",
    reason: "Admin mutation history is the durable audit trail for operator actions.",
  },
  {
    table: "api_key_audit_log",
    policy: "API-key audit archive - keep forever",
    reason: "API key lifecycle events are the durable audit trail for credential issuance and revocation.",
  },
  {
    table: "tape_events",
    policy: "product timeline archive - keep forever",
    reason: "Timeline permalinks, all-time browsing, and downstream review evidence depend on historical events.",
  },
  {
    table: "status_transitions",
    policy: "operational incident archive - keep forever",
    reason: "Public/admin status history queries window reads rather than deleting the incident timeline.",
  },
  {
    table: "depeg_backfill_runs",
    policy: "backfill audit archive - keep forever",
    reason: "Replay manifests preserve repair provenance and incomplete-run evidence for historical depeg repairs.",
  },
] as const;

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
