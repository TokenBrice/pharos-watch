import type { CronResult } from "../lib/cron-logger";
import type { CappedDeleteResult } from "./shared/capped-delete";
import { throwIfAborted } from "../lib/abort";
import { SECONDS } from "../lib/time-constants";
import { runWithOverloadRetry } from "../lib/d1-overload-retry";
import { createCronResult } from "../lib/cron-result";
import { pruneRepairTasks } from "../lib/repair-tasks";
import { WORKER_CANARY_RUN_RETENTION_SEC, pruneWorkerCanaryRuns } from "../lib/canary-prune";
import { pruneLiveReserveRecoveryCheckpoints } from "../lib/scheduled-recovery-prune";
import { pruneOldApiKeyRequestRateLimits } from "../lib/api-key-request-rate-limit-prune";
import { pruneProducerHistory } from "../lib/producer-history";
import { REQUEST_ATTRIBUTION_RETENTION_DAYS } from "@shared/lib/request-attribution";
import { deleteCapped } from "./shared/capped-delete";
import { RETENTION_DELETE_BATCH_LIMIT, RETENTION_DELETE_RUN_LIMIT } from "../lib/bounded-prune";
import { SAFETY_SCORE_PUBLICATION_JOURNAL_RETENTION_SEC } from "../lib/safety-score-v9/publication-journal";
import { SAFETY_SCORE_CAPTURE_ARCHIVE_RETENTION_SEC } from "@shared/lib/safety-score-capture-archive";

// Kept in sync with the retention window previously enforced inline inside
// runScheduledSlotWithFence (14 days).  Consolidated here so the daily
// housekeeping pass is the single place that prunes cron observability rows.
const SLOT_EXECUTION_RETENTION_SEC = 14 * SECONDS.ONE_DAY;
const BLOCK_TIMESTAMP_CACHE_RETENTION_SEC = 14 * SECONDS.ONE_DAY;
const SELECTOR_SNAPSHOT_DAILY_QUOTA_RETENTION_SEC = 2 * SECONDS.ONE_DAY;
const REQUEST_TELEMETRY_RETENTION_SEC = REQUEST_ATTRIBUTION_RETENTION_DAYS * SECONDS.ONE_DAY;
const SELF_SERVE_RATE_LIMIT_RETENTION_SEC = 2 * SECONDS.ONE_DAY;
/** Oldest `cron_runs.started_at` the daily housekeeping pass keeps; offline diagnostics import this bound. */
export const CRON_RUNS_RETENTION_SEC = SECONDS.ONE_WEEK;

function toUtcDateString(timestampSec: number): string {
  return new Date(timestampSec * 1000).toISOString().slice(0, 10);
}

interface SimpleRetentionPolicy {
  sql: string;
  cutoff: number | string;
}

/**
 * Every policy routed here carries the canonical bounded shape
 * `WHERE <clock> < ? AND rowid IN (SELECT rowid FROM <table>
 *  WHERE <clock> < ? ORDER BY <clock> ASC LIMIT ?)`, so the cutoff binds twice
 * and the batch limit last. Same cutoff, same rows, oldest-first.
 */
async function runCappedRetentionPass(
  db: D1Database,
  policy: SimpleRetentionPolicy,
  signal?: AbortSignal,
): Promise<CappedDeleteResult> {
  return deleteCapped(
    db,
    policy.sql,
    (limit) => [policy.cutoff, policy.cutoff, limit],
    RETENTION_DELETE_BATCH_LIMIT,
    RETENTION_DELETE_RUN_LIMIT,
    signal,
  );
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
  const requestTelemetryCutoff = now - REQUEST_TELEMETRY_RETENTION_SEC;
  const simpleRetentionPolicies = {
    cronRuns: {
      sql: "DELETE FROM cron_runs WHERE started_at < ? AND rowid IN (SELECT rowid FROM cron_runs WHERE started_at < ? ORDER BY started_at ASC LIMIT ?)",
      cutoff: now - CRON_RUNS_RETENTION_SEC,
    },
    selectorSnapshotDailyQuota: {
      sql: "DELETE FROM selector_snapshot_daily_quota WHERE quota_date < ?",
      cutoff: selectorSnapshotDailyQuotaCutoffDate,
    },
    blockTimestampCache: {
      sql: "DELETE FROM block_timestamp_cache WHERE updated_at < ? AND rowid IN (SELECT rowid FROM block_timestamp_cache WHERE updated_at < ? ORDER BY updated_at ASC LIMIT ?)",
      cutoff: now - BLOCK_TIMESTAMP_CACHE_RETENTION_SEC,
    },
    slotExecutions: {
      sql: "DELETE FROM cron_slot_executions WHERE slot_started_at < ? AND rowid IN (SELECT rowid FROM cron_slot_executions WHERE slot_started_at < ? ORDER BY slot_started_at ASC LIMIT ?)",
      cutoff: now - SLOT_EXECUTION_RETENTION_SEC,
    },
    apiRequestConsumerStats: {
      sql: "DELETE FROM api_request_consumer_stats WHERE bucket_start < ? AND rowid IN (SELECT rowid FROM api_request_consumer_stats WHERE bucket_start < ? ORDER BY bucket_start ASC LIMIT ?)",
      cutoff: requestTelemetryCutoff,
    },
    siteDataRequestStats: {
      sql: "DELETE FROM site_data_request_stats WHERE bucket_start < ? AND rowid IN (SELECT rowid FROM site_data_request_stats WHERE bucket_start < ? ORDER BY bucket_start ASC LIMIT ?)",
      cutoff: requestTelemetryCutoff,
    },
    apiKeyRequestStats: {
      sql: "DELETE FROM api_key_request_stats WHERE bucket_start < ? AND rowid IN (SELECT rowid FROM api_key_request_stats WHERE bucket_start < ? ORDER BY bucket_start ASC LIMIT ?)",
      cutoff: requestTelemetryCutoff,
    },
    safetyScoreJournal: {
      sql: "DELETE FROM safety_score_publication_journal WHERE published_at < ? AND rowid IN (SELECT rowid FROM safety_score_publication_journal WHERE published_at < ? ORDER BY published_at ASC LIMIT ?)",
      cutoff: now - SAFETY_SCORE_PUBLICATION_JOURNAL_RETENTION_SEC,
    },
    safetyScoreAttempts: {
      sql: "DELETE FROM safety_score_publication_attempts WHERE attempted_at < ? AND rowid IN (SELECT rowid FROM safety_score_publication_attempts WHERE attempted_at < ? ORDER BY attempted_at ASC LIMIT ?)",
      cutoff: now - SAFETY_SCORE_PUBLICATION_JOURNAL_RETENTION_SEC,
    },
    safetyScoreCaptureArchive: {
      sql: "DELETE FROM safety_score_capture_archive WHERE published_at < ? AND rowid IN (SELECT rowid FROM safety_score_capture_archive WHERE published_at < ? ORDER BY published_at ASC, generation_id ASC LIMIT ?)",
      cutoff: now - SAFETY_SCORE_CAPTURE_ARCHIVE_RETENTION_SEC,
    },
  } as const;

  const cronRuns = await runCappedRetentionPass(db, simpleRetentionPolicies.cronRuns, signal);

  const producerHistory = await pruneProducerHistory(db, now, signal);
  throwIfAborted(signal);
  const repairTasks = await pruneRepairTasks(db, now - SECONDS.ONE_WEEK, signal);
  throwIfAborted(signal);
  const canaryRuns = await pruneWorkerCanaryRuns(db, now - WORKER_CANARY_RUN_RETENTION_SEC, signal);
  throwIfAborted(signal);
  const recoveryCheckpoints = await pruneLiveReserveRecoveryCheckpoints(
    db,
    now - SLOT_EXECUTION_RETENTION_SEC,
    signal,
  );
  throwIfAborted(signal);
  const selfServeRateLimits = await pruneOldApiKeyRequestRateLimits(
    db,
    now - SELF_SERVE_RATE_LIMIT_RETENTION_SEC,
    5_000,
    100_000,
    signal,
  );
  throwIfAborted(signal);

  const selectorSnapshotDailyQuotaDeleted = await runSimpleRetentionPass(
    db,
    simpleRetentionPolicies.selectorSnapshotDailyQuota,
    signal,
  );
  const blockTimestampCache = await runCappedRetentionPass(
    db,
    simpleRetentionPolicies.blockTimestampCache,
    signal,
  );
  const slotExecutions = await runCappedRetentionPass(
    db,
    simpleRetentionPolicies.slotExecutions,
    signal,
  );
  const apiRequestConsumerStats = await runCappedRetentionPass(
    db,
    simpleRetentionPolicies.apiRequestConsumerStats,
    signal,
  );
  const siteDataRequestStats = await runCappedRetentionPass(
    db,
    simpleRetentionPolicies.siteDataRequestStats,
    signal,
  );
  const apiKeyRequestStats = await runCappedRetentionPass(
    db,
    simpleRetentionPolicies.apiKeyRequestStats,
    signal,
  );
  const safetyScoreJournal = await runCappedRetentionPass(db, simpleRetentionPolicies.safetyScoreJournal, signal);
  const safetyScoreAttempts = await runCappedRetentionPass(db, simpleRetentionPolicies.safetyScoreAttempts, signal);
  const safetyScoreCaptureArchive = await runCappedRetentionPass(db, simpleRetentionPolicies.safetyScoreCaptureArchive, signal);

  return createCronResult({
    status: "ok",
    itemCount:
      cronRuns.pruned +
      producerHistory.pruned +
      repairTasks.deleted +
      canaryRuns.deleted +
      recoveryCheckpoints.deleted +
      selfServeRateLimits.deleted +
      selectorSnapshotDailyQuotaDeleted +
      blockTimestampCache.pruned +
      slotExecutions.pruned +
      apiRequestConsumerStats.pruned +
      siteDataRequestStats.pruned +
      apiKeyRequestStats.pruned +
      safetyScoreJournal.pruned +
      safetyScoreAttempts.pruned +
      safetyScoreCaptureArchive.pruned,
    metadata: {
      cronRunsDeleted: cronRuns.pruned,
      producerHistoryDeleted: producerHistory.pruned,
      safetyScoreJournalDeleted: safetyScoreJournal.pruned,
      safetyScoreAttemptsDeleted: safetyScoreAttempts.pruned,
      safetyScoreJournalCappedAtLimit: safetyScoreJournal.cappedAtLimit,
      safetyScoreAttemptsCappedAtLimit: safetyScoreAttempts.cappedAtLimit,
      cutoffSafetyScoreJournalSec: now - SAFETY_SCORE_PUBLICATION_JOURNAL_RETENTION_SEC,
      safetyScoreCaptureArchiveDeleted: safetyScoreCaptureArchive.pruned,
      safetyScoreCaptureArchiveCappedAtLimit: safetyScoreCaptureArchive.cappedAtLimit,
      cutoffSafetyScoreCaptureArchiveSec: now - SAFETY_SCORE_CAPTURE_ARCHIVE_RETENTION_SEC,
      repairTasksDeleted: repairTasks.deleted,
      canaryRunsDeleted: canaryRuns.deleted,
      recoveryCheckpointsDeleted: recoveryCheckpoints.deleted,
      selfServeRateLimitsDeleted: selfServeRateLimits.deleted,
      retentionTruncated: {
        cronRuns: cronRuns.cappedAtLimit,
        blockTimestampCache: blockTimestampCache.cappedAtLimit,
        slotExecutions: slotExecutions.cappedAtLimit,
        producerHistory: producerHistory.cappedAtLimit,
        repairTasks: repairTasks.truncated,
        canaryRuns: canaryRuns.truncated,
        recoveryCheckpoints: recoveryCheckpoints.truncated,
        selfServeRateLimits: selfServeRateLimits.truncated,
      },
      selectorSnapshotDailyQuotaDeleted,
      blockTimestampCacheDeleted: blockTimestampCache.pruned,
      slotExecutionsDeleted: slotExecutions.pruned,
      apiRequestConsumerStatsDeleted: apiRequestConsumerStats.pruned,
      siteDataRequestStatsDeleted: siteDataRequestStats.pruned,
      apiKeyRequestStatsDeleted: apiKeyRequestStats.pruned,
      requestTelemetryCappedAtLimit: {
        apiRequestConsumerStats: apiRequestConsumerStats.cappedAtLimit,
        siteDataRequestStats: siteDataRequestStats.cappedAtLimit,
        apiKeyRequestStats: apiKeyRequestStats.cappedAtLimit,
      },
      cutoffCronRunsSec: now - CRON_RUNS_RETENTION_SEC,
      cutoffRepairTasksSec: now - SECONDS.ONE_WEEK,
      cutoffCanaryRunsSec: now - WORKER_CANARY_RUN_RETENTION_SEC,
      cutoffRecoveryCheckpointsSec: now - SLOT_EXECUTION_RETENTION_SEC,
      cutoffSelfServeRateLimitsSec: now - SELF_SERVE_RATE_LIMIT_RETENTION_SEC,
      cutoffSelectorSnapshotDailyQuotaDate: selectorSnapshotDailyQuotaCutoffDate,
      cutoffBlockTimestampCacheSec: now - BLOCK_TIMESTAMP_CACHE_RETENTION_SEC,
      cutoffSlotExecutionsSec: now - SLOT_EXECUTION_RETENTION_SEC,
      cutoffRequestTelemetrySec: requestTelemetryCutoff,
    },
  });
}
