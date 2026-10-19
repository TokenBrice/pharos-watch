import { cronHistoryRetentionPolicies } from "@shared/lib/retention-policy";
import { SAFETY_SCORE_CAPTURE_ARCHIVE_RETENTION_SEC } from "@shared/lib/safety-score-capture-archive";
import type { CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";
import { createCronResult } from "../lib/cron-result";
import {
  RETENTION_DELETE_BATCH_LIMIT, RETENTION_DELETE_RUN_LIMIT,
  RETENTION_SMALL_DELETE_BATCH_LIMIT, RETENTION_SMALL_DELETE_RUN_LIMIT,
} from "../lib/bounded-prune";
import { SAFETY_SCORE_PUBLICATION_JOURNAL_RETENTION_SEC } from "../lib/safety-score-v9/publication-journal";
import { runRetentionPolicies } from "./shared/capped-delete";

export async function runPruneCronHistory(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  throwIfAborted(signal);
  const now = Math.floor(Date.now() / 1000);
  const policies = cronHistoryRetentionPolicies(
    {
      batchLimit: RETENTION_DELETE_BATCH_LIMIT, runLimit: RETENTION_DELETE_RUN_LIMIT,
      smallBatchLimit: RETENTION_SMALL_DELETE_BATCH_LIMIT, smallRunLimit: RETENTION_SMALL_DELETE_RUN_LIMIT,
    },
    { safetyScoreJournalSec: SAFETY_SCORE_PUBLICATION_JOURNAL_RETENTION_SEC },
  );
  const results = await runRetentionPolicies(db, policies, now, signal);
  const {
    cronRuns, producerHistory, repairTasks, canaryRuns, recoveryCheckpoints,
    selectorSnapshotDailyQuota, blockTimestampCache, slotExecutions,
    apiRequestConsumerStats, siteDataRequestStats, apiKeyRequestStats,
    apiRequestSourceSamples, siteDataRequestSamples,
    safetyScoreJournal, safetyScoreAttempts, safetyScoreCaptureArchive,
  } = results;
  const selfServeRateLimitsDeleted = results.selfServeRequestRateLimits.pruned + results.selfServeIssuanceRateLimits.pruned;
  const selfServeRateLimitsTruncated = results.selfServeRequestRateLimits.cappedAtLimit || results.selfServeIssuanceRateLimits.cappedAtLimit;
  const cutoff = (key: string) => now - policies[key].windowSec;
  const selectorSnapshotDailyQuotaCutoffDate = new Date(cutoff("selectorSnapshotDailyQuota") * 1000).toISOString().slice(0, 10);

  return createCronResult({
    status: "ok",
    itemCount: Object.values(results).reduce((total, result) => total + result.pruned, 0),
    metadata: {
      cronRunsDeleted: cronRuns.pruned,
      producerHistoryDeleted: producerHistory.pruned,
      safetyScoreJournalDeleted: safetyScoreJournal.pruned,
      safetyScoreAttemptsDeleted: safetyScoreAttempts.pruned,
      safetyScoreJournalCappedAtLimit: safetyScoreJournal.cappedAtLimit,
      safetyScoreAttemptsCappedAtLimit: safetyScoreAttempts.cappedAtLimit,
      cutoffSafetyScoreJournalSec: cutoff("safetyScoreJournal"),
      safetyScoreCaptureArchiveDeleted: safetyScoreCaptureArchive.pruned,
      safetyScoreCaptureArchiveCappedAtLimit: safetyScoreCaptureArchive.cappedAtLimit,
      cutoffSafetyScoreCaptureArchiveSec: now - SAFETY_SCORE_CAPTURE_ARCHIVE_RETENTION_SEC,
      repairTasksDeleted: repairTasks.pruned,
      canaryRunsDeleted: canaryRuns.pruned,
      recoveryCheckpointsDeleted: recoveryCheckpoints.pruned,
      selfServeRateLimitsDeleted,
      retentionTruncated: {
        ...Object.fromEntries(Object.entries(results).map(([key, result]) => [key, result.cappedAtLimit])),
        selfServeRateLimits: selfServeRateLimitsTruncated,
      },
      selectorSnapshotDailyQuotaDeleted: selectorSnapshotDailyQuota.pruned,
      blockTimestampCacheDeleted: blockTimestampCache.pruned,
      slotExecutionsDeleted: slotExecutions.pruned,
      apiRequestConsumerStatsDeleted: apiRequestConsumerStats.pruned,
      siteDataRequestStatsDeleted: siteDataRequestStats.pruned,
      apiKeyRequestStatsDeleted: apiKeyRequestStats.pruned,
      apiRequestSourceSamplesDeleted: apiRequestSourceSamples.pruned,
      siteDataRequestSamplesDeleted: siteDataRequestSamples.pruned,
      requestTelemetryCappedAtLimit: {
        apiRequestConsumerStats: apiRequestConsumerStats.cappedAtLimit,
        siteDataRequestStats: siteDataRequestStats.cappedAtLimit,
        apiKeyRequestStats: apiKeyRequestStats.cappedAtLimit,
        apiRequestSourceSamples: apiRequestSourceSamples.cappedAtLimit,
        siteDataRequestSamples: siteDataRequestSamples.cappedAtLimit,
      },
      cutoffCronRunsSec: cutoff("cronRuns"),
      cutoffRepairTasksSec: cutoff("repairTasks"),
      cutoffCanaryRunsSec: cutoff("canaryRuns"),
      cutoffRecoveryCheckpointsSec: cutoff("recoveryCheckpoints"),
      cutoffSelfServeRateLimitsSec: cutoff("selfServeRequestRateLimits"),
      cutoffSelectorSnapshotDailyQuotaDate: selectorSnapshotDailyQuotaCutoffDate,
      cutoffBlockTimestampCacheSec: cutoff("blockTimestampCache"),
      cutoffSlotExecutionsSec: cutoff("slotExecutions"),
      cutoffRequestTelemetrySec: cutoff("apiRequestConsumerStats"),
    },
  });
}
