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
