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
import { RetentionGroupError, runRetentionPolicies, type CappedDeleteResult } from "./shared/capped-delete";

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
  let results: Partial<Record<keyof typeof policies, CappedDeleteResult>>;
  let failure: RetentionGroupError | undefined;
  try {
    results = await runRetentionPolicies(db, policies, now, signal);
  } catch (error) {
    // Aborts and unattributed failures propagate verbatim, as before the group envelope.
    if (signal?.aborted || !(error instanceof RetentionGroupError)) throw error;
    failure = error;
    results = error.completedResults;
  }
  const deleted = (key: keyof typeof policies) => results[key]?.pruned ?? null;
  const truncated = (key: keyof typeof policies) => results[key]?.cappedAtLimit ?? null;
  const requests = results.selfServeRequestRateLimits, issuance = results.selfServeIssuanceRateLimits;
  const selfServeRateLimitsDeleted = requests && issuance ? requests.pruned + issuance.pruned : null;
  const selfServeRateLimitsTruncated = requests && issuance ? requests.cappedAtLimit || issuance.cappedAtLimit : null;
  const cutoff = (key: keyof typeof policies) => now - policies[key].windowSec;
  const selectorSnapshotDailyQuotaCutoffDate = new Date(cutoff("selectorSnapshotDailyQuota") * 1000).toISOString().slice(0, 10);

  const result = {
    itemCount: Object.values(results).reduce((total, result) => total + result.pruned, 0),
    metadata: {
      cronRunsDeleted: deleted("cronRuns"),
      producerHistoryDeleted: deleted("producerHistory"),
      safetyScoreJournalDeleted: deleted("safetyScoreJournal"),
      safetyScoreAttemptsDeleted: deleted("safetyScoreAttempts"),
      safetyScoreJournalCappedAtLimit: truncated("safetyScoreJournal"),
      safetyScoreAttemptsCappedAtLimit: truncated("safetyScoreAttempts"),
      cutoffSafetyScoreJournalSec: cutoff("safetyScoreJournal"),
      safetyScoreCaptureArchiveDeleted: deleted("safetyScoreCaptureArchive"),
      safetyScoreCaptureArchiveCappedAtLimit: truncated("safetyScoreCaptureArchive"),
      cutoffSafetyScoreCaptureArchiveSec: now - SAFETY_SCORE_CAPTURE_ARCHIVE_RETENTION_SEC,
      repairTasksDeleted: deleted("repairTasks"),
      canaryRunsDeleted: deleted("canaryRuns"),
      recoveryCheckpointsDeleted: deleted("recoveryCheckpoints"),
      selfServeRateLimitsDeleted,
      retentionTruncated: {
        ...Object.fromEntries((Object.keys(policies) as (keyof typeof policies)[]).map((key) => [key, truncated(key)])),
        selfServeRateLimits: selfServeRateLimitsTruncated,
      },
      selectorSnapshotDailyQuotaDeleted: deleted("selectorSnapshotDailyQuota"),
      blockTimestampCacheDeleted: deleted("blockTimestampCache"),
      slotExecutionsDeleted: deleted("slotExecutions"),
      apiRequestConsumerStatsDeleted: deleted("apiRequestConsumerStats"),
      siteDataRequestStatsDeleted: deleted("siteDataRequestStats"),
      apiKeyRequestStatsDeleted: deleted("apiKeyRequestStats"),
      apiRequestSourceSamplesDeleted: deleted("apiRequestSourceSamples"),
      siteDataRequestSamplesDeleted: deleted("siteDataRequestSamples"),
      requestTelemetryCappedAtLimit: {
        apiRequestConsumerStats: truncated("apiRequestConsumerStats"),
        siteDataRequestStats: truncated("siteDataRequestStats"),
        apiKeyRequestStats: truncated("apiKeyRequestStats"),
        apiRequestSourceSamples: truncated("apiRequestSourceSamples"),
        siteDataRequestSamples: truncated("siteDataRequestSamples"),
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
  };
  return failure ? createCronResult({
    ...result,
    status: Object.keys(results).length > 0 ? "degraded" : "error",
    error: failure.message,
    metadata: { ...result.metadata, reason: "retention-group-failed", failedRetentionGroup: failure.failedRetentionGroup },
  }) : createCronResult({ ...result, status: "ok" });
}
