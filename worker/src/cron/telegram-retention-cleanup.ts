import { throwIfAborted } from "../lib/abort";
import type { CronResult } from "../lib/cron-logger";
import { createCronResult } from "../lib/cron-result";
import { runWithOverloadRetry } from "../lib/cron-lease";
import {
  TELEGRAM_PROCESSED_UPDATE_PRUNE_LIMIT,
  countTelegramProcessedUpdateBacklog,
  pruneTelegramProcessedUpdates,
  type TelegramProcessedUpdateBacklog,
} from "../api/telegram-webhook-store";
import { reconcileExpiredTelegramAlertJobTargets } from "./telegram-alert-target-status";

const DAY_SEC = 24 * 60 * 60;
const ALERT_AUDIT_RETENTION_SEC = 90 * DAY_SEC;
const USAGE_DAILY_RETENTION_SEC = 400 * DAY_SEC;
const CHAT_DIAGNOSTICS_RETENTION_SEC = 90 * DAY_SEC;
const SHORT_LIVED_CHAT_CACHE_RETENTION_SEC = 7 * DAY_SEC;
const RE_ENGAGEMENT_WARNING_CACHE_RETENTION_SEC = 30 * DAY_SEC;
const RETENTION_DELETE_BATCH_LIMIT = 10_000;
export const TELEGRAM_PROCESSED_UPDATE_PRUNE_BATCH_LIMIT = 1_000;
const TELEGRAM_PROCESSED_UPDATE_PRUNE_TIME_BUDGET_MS = 2_000;

interface TelegramRetentionCleanupOptions {
  monotonicNow?: () => number;
  processedUpdateTimeBudgetMs?: number;
}

interface ProcessedUpdateDeleteResult extends CappedDeleteResult {
  batches: number;
  remainingBacklog: TelegramProcessedUpdateBacklog;
  timeBudgetExhausted: boolean;
  timeBudgetMs: number;
}

async function pruneTelegramProcessedUpdatesCapped(
  db: D1Database,
  nowSec: number,
  signal?: AbortSignal,
  options: TelegramRetentionCleanupOptions = {},
): Promise<ProcessedUpdateDeleteResult> {
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const timeBudgetMs = options.processedUpdateTimeBudgetMs ?? TELEGRAM_PROCESSED_UPDATE_PRUNE_TIME_BUDGET_MS;
  if (!Number.isFinite(timeBudgetMs) || timeBudgetMs <= 0) {
    throw new RangeError("Telegram processed-update prune time budget must be positive.");
  }

  const startedAt = monotonicNow();
  let pruned = 0;
  let batches = 0;
  let timeBudgetExhausted = false;

  while (pruned < TELEGRAM_PROCESSED_UPDATE_PRUNE_LIMIT) {
    throwIfAborted(signal);
    if (monotonicNow() - startedAt >= timeBudgetMs) {
      timeBudgetExhausted = true;
      break;
    }

    const limit = Math.min(
      TELEGRAM_PROCESSED_UPDATE_PRUNE_BATCH_LIMIT,
      TELEGRAM_PROCESSED_UPDATE_PRUNE_LIMIT - pruned,
    );
    const batchPruned = await pruneTelegramProcessedUpdates(db, { nowSec, limit, signal });
    batches += 1;
    pruned += batchPruned;
    if (batchPruned < limit) break;
  }

  throwIfAborted(signal);
  const remainingBacklog = await countTelegramProcessedUpdateBacklog(db, { nowSec, signal });

  return {
    pruned,
    cappedAtLimit: pruned >= TELEGRAM_PROCESSED_UPDATE_PRUNE_LIMIT,
    batches,
    remainingBacklog,
    timeBudgetExhausted,
    timeBudgetMs,
  };
}

export interface CappedDeleteResult {
  pruned: number;
  cappedAtLimit: boolean;
}

async function deleteOlderThanCapped(
  db: D1Database,
  sql: string,
  cutoff: number | string,
  signal?: AbortSignal,
): Promise<CappedDeleteResult> {
  const result = await runWithOverloadRetry(
    () => db.prepare(sql).bind(cutoff, cutoff, RETENTION_DELETE_BATCH_LIMIT).run(),
    3,
    signal,
  );
  const pruned = Number(result.meta?.changes ?? 0);
  return {
    pruned,
    cappedAtLimit: pruned >= RETENTION_DELETE_BATCH_LIMIT,
  };
}

async function deleteCachePrefixOlderThanCapped(
  db: D1Database,
  prefix: string,
  cutoff: number,
  signal?: AbortSignal,
): Promise<CappedDeleteResult> {
  const result = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `DELETE FROM cache
            WHERE key IN (
              SELECT key
                FROM cache
               WHERE key LIKE ?
                 AND updated_at < ?
               ORDER BY updated_at ASC, key ASC
               LIMIT ?
            )`,
        )
        .bind(`${prefix}%`, cutoff, RETENTION_DELETE_BATCH_LIMIT)
        .run(),
    3,
    signal,
  );
  const pruned = Number(result.meta?.changes ?? 0);
  return {
    pruned,
    cappedAtLimit: pruned >= RETENTION_DELETE_BATCH_LIMIT,
  };
}

export function pruneTelegramMiniAppMutationBurstCache(
  db: D1Database,
  cutoff: number,
  signal?: AbortSignal,
): Promise<CappedDeleteResult> {
  return deleteCachePrefixOlderThanCapped(
    db,
    "telegram:mini-app-mutation-burst:",
    cutoff,
    signal,
  );
}

export async function runTelegramRetentionCleanup(
  db: D1Database,
  signal?: AbortSignal,
  options: TelegramRetentionCleanupOptions = {},
): Promise<CronResult> {
  throwIfAborted(signal);
  const nowSec = Math.floor(Date.now() / 1000);
  const expiredTargetsReconciled = await reconcileExpiredTelegramAlertJobTargets(db, nowSec, signal);
  throwIfAborted(signal);

  const processedUpdates = await pruneTelegramProcessedUpdatesCapped(db, nowSec, signal, options);
  throwIfAborted(signal);

  const deadLetters = await deleteOlderThanCapped(
    db,
    "DELETE FROM telegram_alert_dead_letters WHERE expired_at < ? AND id IN (SELECT id FROM telegram_alert_dead_letters WHERE expired_at < ? ORDER BY expired_at ASC, id ASC LIMIT ?)",
    nowSec - ALERT_AUDIT_RETENTION_SEC,
    signal,
  );
  throwIfAborted(signal);

  const jobTargets = await deleteOlderThanCapped(
    db,
    "DELETE FROM telegram_alert_job_targets WHERE created_at < ? AND rowid IN (SELECT rowid FROM telegram_alert_job_targets WHERE created_at < ? ORDER BY created_at ASC, rowid ASC LIMIT ?)",
    nowSec - ALERT_AUDIT_RETENTION_SEC,
    signal,
  );
  throwIfAborted(signal);

  const jobs = await deleteOlderThanCapped(
    db,
    "DELETE FROM telegram_alert_jobs WHERE created_at < ? AND rowid IN (SELECT rowid FROM telegram_alert_jobs WHERE created_at < ? ORDER BY created_at ASC, rowid ASC LIMIT ?)",
    nowSec - ALERT_AUDIT_RETENTION_SEC,
    signal,
  );
  throwIfAborted(signal);

  // `day` is TEXT (YYYY-MM-DD) in telegram_usage_daily and
  // telegram_watcher_lifecycle_daily; an integer cutoff would never match. Bind
  // the cutoff as a YYYY-MM-DD string so the comparison is text-vs-text.
  const cutoffDayString = new Date((nowSec - USAGE_DAILY_RETENTION_SEC) * 1000).toISOString().slice(0, 10);

  const usageDaily = await deleteOlderThanCapped(
    db,
    "DELETE FROM telegram_usage_daily WHERE day < ? AND rowid IN (SELECT rowid FROM telegram_usage_daily WHERE day < ? ORDER BY day ASC, rowid ASC LIMIT ?)",
    cutoffDayString,
    signal,
  );
  throwIfAborted(signal);

  const watcherLifecycle = await deleteOlderThanCapped(
    db,
    "DELETE FROM telegram_watcher_lifecycle_daily WHERE day < ? AND rowid IN (SELECT rowid FROM telegram_watcher_lifecycle_daily WHERE day < ? ORDER BY day ASC, rowid ASC LIMIT ?)",
    cutoffDayString,
    signal,
  );
  throwIfAborted(signal);

  const diagnostics = await deleteOlderThanCapped(
    db,
    "DELETE FROM telegram_chat_delivery_diagnostics WHERE updated_at < ? AND rowid IN (SELECT rowid FROM telegram_chat_delivery_diagnostics WHERE updated_at < ? ORDER BY updated_at ASC, rowid ASC LIMIT ?)",
    nowSec - CHAT_DIAGNOSTICS_RETENTION_SEC,
    signal,
  );
  throwIfAborted(signal);

  const commandCooldownCache = await deleteCachePrefixOlderThanCapped(
    db,
    "telegram:command-cooldown:",
    nowSec - SHORT_LIVED_CHAT_CACHE_RETENTION_SEC,
    signal,
  );
  throwIfAborted(signal);

  const miniAppMutationBurstCache = await pruneTelegramMiniAppMutationBurstCache(
    db,
    nowSec - SHORT_LIVED_CHAT_CACHE_RETENTION_SEC,
    signal,
  );
  throwIfAborted(signal);

  const commandFloodCache = await deleteCachePrefixOlderThanCapped(
    db,
    "telegram:command-flood:",
    nowSec - SHORT_LIVED_CHAT_CACHE_RETENTION_SEC,
    signal,
  );
  throwIfAborted(signal);

  const chatMemberCache = await deleteCachePrefixOlderThanCapped(
    db,
    "telegram:chat-member:",
    nowSec - SHORT_LIVED_CHAT_CACHE_RETENTION_SEC,
    signal,
  );
  throwIfAborted(signal);

  const chatAdminsCache = await deleteCachePrefixOlderThanCapped(
    db,
    "telegram:chat-admins:",
    nowSec - SHORT_LIVED_CHAT_CACHE_RETENTION_SEC,
    signal,
  );
  throwIfAborted(signal);

  const groupWelcomeCache = await deleteCachePrefixOlderThanCapped(
    db,
    "telegram:group-welcome:",
    nowSec - SHORT_LIVED_CHAT_CACHE_RETENTION_SEC,
    signal,
  );
  throwIfAborted(signal);

  const reEngagementWarningCache = await deleteCachePrefixOlderThanCapped(
    db,
    "telegram:re-engagement-warned:",
    nowSec - RE_ENGAGEMENT_WARNING_CACHE_RETENTION_SEC,
    signal,
  );

  const totalPruned =
    processedUpdates.pruned +
    deadLetters.pruned +
    jobTargets.pruned +
    jobs.pruned +
    usageDaily.pruned +
    watcherLifecycle.pruned +
    diagnostics.pruned +
    commandCooldownCache.pruned +
    miniAppMutationBurstCache.pruned +
    commandFloodCache.pruned +
    chatMemberCache.pruned +
    chatAdminsCache.pruned +
    groupWelcomeCache.pruned +
    reEngagementWarningCache.pruned;

  return createCronResult({
    status: "ok",
    itemCount: totalPruned,
    metadata: {
      processedUpdatesPruned: processedUpdates.pruned,
      deadLettersPruned: deadLetters.pruned,
      jobTargetsPruned: jobTargets.pruned,
      jobsPruned: jobs.pruned,
      usageDailyPruned: usageDaily.pruned,
      watcherLifecyclePruned: watcherLifecycle.pruned,
      diagnosticsPruned: diagnostics.pruned,
      commandCooldownCachePruned: commandCooldownCache.pruned,
      miniAppMutationBurstCachePruned: miniAppMutationBurstCache.pruned,
      commandFloodCachePruned: commandFloodCache.pruned,
      chatMemberCachePruned: chatMemberCache.pruned,
      chatAdminsCachePruned: chatAdminsCache.pruned,
      groupWelcomeCachePruned: groupWelcomeCache.pruned,
      reEngagementWarningCachePruned: reEngagementWarningCache.pruned,
      expiredTargetsReconciled,
      runBudgetTruncated: processedUpdates.remainingBacklog.count > 0,
      deleteBatchLimit: RETENTION_DELETE_BATCH_LIMIT,
      processedUpdatePruneBudget: {
        rowLimit: TELEGRAM_PROCESSED_UPDATE_PRUNE_LIMIT,
        batchLimit: TELEGRAM_PROCESSED_UPDATE_PRUNE_BATCH_LIMIT,
        timeBudgetMs: processedUpdates.timeBudgetMs,
        batches: processedUpdates.batches,
        timeBudgetExhausted: processedUpdates.timeBudgetExhausted,
      },
      processedUpdatesRemainingBacklog: {
        count: processedUpdates.remainingBacklog.count,
        exact: processedUpdates.remainingBacklog.exact,
        probeLimit: processedUpdates.remainingBacklog.probeLimit,
      },
      cappedAtLimit: {
        processedUpdates: processedUpdates.cappedAtLimit,
        deadLetters: deadLetters.cappedAtLimit,
        jobTargets: jobTargets.cappedAtLimit,
        jobs: jobs.cappedAtLimit,
        usageDaily: usageDaily.cappedAtLimit,
        watcherLifecycle: watcherLifecycle.cappedAtLimit,
        diagnostics: diagnostics.cappedAtLimit,
        commandCooldownCache: commandCooldownCache.cappedAtLimit,
        miniAppMutationBurstCache: miniAppMutationBurstCache.cappedAtLimit,
        commandFloodCache: commandFloodCache.cappedAtLimit,
        chatMemberCache: chatMemberCache.cappedAtLimit,
        chatAdminsCache: chatAdminsCache.cappedAtLimit,
        groupWelcomeCache: groupWelcomeCache.cappedAtLimit,
        reEngagementWarningCache: reEngagementWarningCache.cappedAtLimit,
      },
      retentionDays: {
        alertAudit: ALERT_AUDIT_RETENTION_SEC / DAY_SEC,
        usageDaily: USAGE_DAILY_RETENTION_SEC / DAY_SEC,
        watcherLifecycle: USAGE_DAILY_RETENTION_SEC / DAY_SEC,
        chatDiagnostics: CHAT_DIAGNOSTICS_RETENTION_SEC / DAY_SEC,
        shortLivedChatCache: SHORT_LIVED_CHAT_CACHE_RETENTION_SEC / DAY_SEC,
        reEngagementWarningCache: RE_ENGAGEMENT_WARNING_CACHE_RETENTION_SEC / DAY_SEC,
        processedUpdates: 7,
      },
    },
  });
}
