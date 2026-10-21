import { throwIfAborted } from "../../../lib/abort";
import type { CronResult } from "../../../lib/cron-logger";
import { createCronResult } from "../../../lib/cron-result";
import { type CappedDeleteResult, type CappedPruneStatement, deleteCapped, deleteCappedGroup } from "../../shared/capped-delete";
import { RETENTION_DELETE_BATCH_LIMIT, RETENTION_DELETE_RUN_LIMIT } from "../../../lib/bounded-prune";
import { TELEGRAM_RETENTION_WINDOWS } from "@shared/lib/retention-policy";
import {
  TELEGRAM_PROCESSED_UPDATE_PRUNE_LIMIT,
  countTelegramProcessedUpdateBacklog,
  pruneTelegramProcessedUpdates,
  type TelegramProcessedUpdateBacklog,
} from "../../../telegram/store/processed-updates";

const DAY_SEC = 24 * 60 * 60;
const {
  alertAudit: ALERT_AUDIT_RETENTION_SEC,
  usageDaily: USAGE_DAILY_RETENTION_SEC,
  chatDiagnostics: CHAT_DIAGNOSTICS_RETENTION_SEC,
  shortLivedChatCache: SHORT_LIVED_CHAT_CACHE_RETENTION_SEC,
  reEngagementWarningCache: RE_ENGAGEMENT_WARNING_CACHE_RETENTION_SEC,
} = TELEGRAM_RETENTION_WINDOWS;
const MINI_APP_MUTATION_BURST_CACHE_PREFIX = "telegram:mini-app-mutation-burst:";
const HIGH_VOLUME_RETENTION_DELETE_LIMIT = RETENTION_DELETE_RUN_LIMIT;
export const TELEGRAM_PROCESSED_UPDATE_PRUNE_BATCH_LIMIT = 1_000;
const TELEGRAM_PROCESSED_UPDATE_PRUNE_TIME_BUDGET_MS = 2_000;

const RETENTION_DAYS = {
  alertAudit: ALERT_AUDIT_RETENTION_SEC / DAY_SEC,
  usageDaily: USAGE_DAILY_RETENTION_SEC / DAY_SEC,
  watcherLifecycle: USAGE_DAILY_RETENTION_SEC / DAY_SEC,
  chatDiagnostics: CHAT_DIAGNOSTICS_RETENTION_SEC / DAY_SEC,
  shortLivedChatCache: SHORT_LIVED_CHAT_CACHE_RETENTION_SEC / DAY_SEC,
  reEngagementWarningCache: RE_ENGAGEMENT_WARNING_CACHE_RETENTION_SEC / DAY_SEC,
  processedUpdates: 7,
} as const;

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

    const limit = Math.min(TELEGRAM_PROCESSED_UPDATE_PRUNE_BATCH_LIMIT, TELEGRAM_PROCESSED_UPDATE_PRUNE_LIMIT - pruned);
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

export type { CappedDeleteResult };

function deleteCachePrefixOlderThanCapped(
  db: D1Database,
  prefix: string,
  cutoff: number,
  signal?: AbortSignal,
): Promise<CappedDeleteResult> {
  return deleteCapped(
    db,
    `DELETE FROM cache
            WHERE key IN (
              SELECT key
                FROM cache
               WHERE key LIKE ?
                 AND updated_at < ?
               ORDER BY updated_at ASC, key ASC
               LIMIT ?
            )`,
    (limit) => [`${prefix}%`, cutoff, limit],
    RETENTION_DELETE_BATCH_LIMIT,
    RETENTION_DELETE_BATCH_LIMIT,
    signal,
  );
}

export function pruneTelegramMiniAppMutationBurstCache(
  db: D1Database,
  cutoff: number,
  signal?: AbortSignal,
): Promise<CappedDeleteResult> {
  return deleteCachePrefixOlderThanCapped(db, MINI_APP_MUTATION_BURST_CACHE_PREFIX, cutoff, signal);
}

/**
 * One homogeneous capped-delete retention step. `countsTowardRunBudget` marks
 * the high-volume families whose cap truncates the whole retention run.
 */
type TelegramRetentionDeleteStep =
  | {
      name: string;
      sql: string;
      cutoff: number | string;
      totalLimit?: number;
      countsTowardRunBudget?: boolean;
    }
  | {
      name: string;
      cachePrefix: string;
      cutoff: number;
    };

// SAFETY: These closed `as const` tuples are the only source of interpolated SQL
// identifiers below, so builder callers cannot provide arbitrary SQL.
const SIMPLE_RETENTION_TABLES = ["telegram_usage_daily", "telegram_watcher_lifecycle_daily", "telegram_chat_delivery_diagnostics"] as const;
const SIMPLE_RETENTION_COLUMNS = ["day", "updated_at"] as const;

type TelegramRetentionDeleteOptions = {
  name: string;
  cutoff: number | string;
  totalLimit?: number;
  countsTowardRunBudget?: boolean;
};

function makeSimpleRetentionDeleteStep(
  {
    name, table, timestampColumn, cutoff, totalLimit, countsTowardRunBudget,
  }: TelegramRetentionDeleteOptions & {
    table: (typeof SIMPLE_RETENTION_TABLES)[number];
    timestampColumn: (typeof SIMPLE_RETENTION_COLUMNS)[number];
  },
): TelegramRetentionDeleteStep {
  if (!SIMPLE_RETENTION_TABLES.includes(table)) throw new Error(`Unsupported Telegram retention table: ${table}`);
  if (!SIMPLE_RETENTION_COLUMNS.includes(timestampColumn)) {
    throw new Error(`Unsupported Telegram retention timestamp column: ${timestampColumn}`);
  }
  return {
    name,
    // SAFETY: table and timestampColumn pass the closed tuple allowlists above; cutoff/limit are bound.
    sql: `DELETE FROM ${table} WHERE ${timestampColumn} < ? AND rowid IN (SELECT rowid FROM ${table} WHERE ${timestampColumn} < ? ORDER BY ${timestampColumn} ASC, rowid ASC LIMIT ?)`,
    cutoff,
    totalLimit,
    countsTowardRunBudget,
  };
}

function telegramRetentionStatement(step: TelegramRetentionDeleteStep): CappedPruneStatement {
  if ("cachePrefix" in step) {
    return {
      sql: `DELETE FROM cache WHERE key IN (
        SELECT key FROM cache WHERE key LIKE ? AND updated_at < ?
        ORDER BY updated_at ASC, key ASC LIMIT ?
      )`,
      bindsForLimit: (limit) => [`${step.cachePrefix}%`, step.cutoff, limit],
      batchLimit: RETENTION_DELETE_BATCH_LIMIT,
      runLimit: RETENTION_DELETE_BATCH_LIMIT,
    };
  }
  return {
    sql: step.sql,
    bindsForLimit: (limit) => [step.cutoff, step.cutoff, limit],
    batchLimit: RETENTION_DELETE_BATCH_LIMIT,
    runLimit: step.totalLimit ?? RETENTION_DELETE_BATCH_LIMIT,
  };
}

export async function runTelegramRetentionCleanup(
  db: D1Database,
  signal?: AbortSignal,
  options: TelegramRetentionCleanupOptions = {},
): Promise<CronResult> {
  throwIfAborted(signal);
  const nowSec = Math.floor(Date.now() / 1000);

  const processedUpdates = await pruneTelegramProcessedUpdatesCapped(db, nowSec, signal, options);
  throwIfAborted(signal);

  const alertAuditCutoff = nowSec - ALERT_AUDIT_RETENTION_SEC;
  // `day` is TEXT (YYYY-MM-DD) in telegram_usage_daily and
  // telegram_watcher_lifecycle_daily; an integer cutoff would never match. Bind
  // the cutoff as a YYYY-MM-DD string so the comparison is text-vs-text.
  const cutoffDayString = new Date((nowSec - USAGE_DAILY_RETENTION_SEC) * 1000).toISOString().slice(0, 10);

  const retentionDeleteSteps = [
    // Terminal delivery rows (done_at is set only on terminal states), then
    // jobs that no longer own any row.
    {
      name: "deliveryV2Rows",
      sql: "DELETE FROM telegram_deliveries WHERE done_at < ? AND id IN (SELECT id FROM telegram_deliveries WHERE done_at < ? ORDER BY done_at ASC, id ASC LIMIT ?)",
      cutoff: alertAuditCutoff,
        totalLimit: HIGH_VOLUME_RETENTION_DELETE_LIMIT,
      countsTowardRunBudget: true,
    },
    {
      name: "deliveryV2Jobs",
      sql: `DELETE FROM telegram_jobs WHERE completed_at < ? AND job_id IN (
        SELECT job.job_id FROM telegram_jobs job
         WHERE job.completed_at < ?
           AND NOT EXISTS (SELECT 1 FROM telegram_deliveries d WHERE d.job_id = job.job_id)
         ORDER BY job.completed_at ASC, job.job_id ASC LIMIT ?)`,
      cutoff: alertAuditCutoff,
      },
    makeSimpleRetentionDeleteStep({ name: "usageDaily", table: "telegram_usage_daily", timestampColumn: "day", cutoff: cutoffDayString }),
    makeSimpleRetentionDeleteStep({ name: "watcherLifecycle", table: "telegram_watcher_lifecycle_daily", timestampColumn: "day", cutoff: cutoffDayString }),
    makeSimpleRetentionDeleteStep({ name: "diagnostics", table: "telegram_chat_delivery_diagnostics", timestampColumn: "updated_at", cutoff: nowSec - CHAT_DIAGNOSTICS_RETENTION_SEC }),
    {
      name: "commandCooldownCache",
      cachePrefix: "telegram:command-cooldown:",
      cutoff: nowSec - SHORT_LIVED_CHAT_CACHE_RETENTION_SEC,
    },
    {
      name: "miniAppMutationBurstCache",
      cachePrefix: MINI_APP_MUTATION_BURST_CACHE_PREFIX,
      cutoff: nowSec - SHORT_LIVED_CHAT_CACHE_RETENTION_SEC,
    },
    {
      name: "commandFloodCache",
      cachePrefix: "telegram:command-flood:",
      cutoff: nowSec - SHORT_LIVED_CHAT_CACHE_RETENTION_SEC,
    },
    {
      name: "chatMemberCache",
      cachePrefix: "telegram:chat-member:",
      cutoff: nowSec - SHORT_LIVED_CHAT_CACHE_RETENTION_SEC,
    },
    {
      name: "chatAdminsCache",
      cachePrefix: "telegram:chat-admins:",
      cutoff: nowSec - SHORT_LIVED_CHAT_CACHE_RETENTION_SEC,
    },
    {
      name: "groupWelcomeCache",
      cachePrefix: "telegram:group-welcome:",
      cutoff: nowSec - SHORT_LIVED_CHAT_CACHE_RETENTION_SEC,
    },
    {
      name: "reEngagementWarningCache",
      cachePrefix: "telegram:re-engagement-warned:",
      cutoff: nowSec - RE_ENGAGEMENT_WARNING_CACHE_RETENTION_SEC,
    },
  ] as const satisfies readonly TelegramRetentionDeleteStep[];

  // Delivery rows drain (possibly over several batches) before the job step
  // runs, so a job is only deleted once it owns no row. The remaining steps are
  // independent and share that second batch.
  const [deliveryRows] = await deleteCappedGroup(db, [telegramRetentionStatement(retentionDeleteSteps[0])], signal);
  const rest = retentionDeleteSteps.slice(1);
  const restResults = await deleteCappedGroup(db, rest.map(telegramRetentionStatement), signal);
  const stepResults: Record<string, CappedDeleteResult> = { [retentionDeleteSteps[0].name]: deliveryRows };
  rest.forEach((step, index) => { stepResults[step.name] = restResults[index]; });

  const totalPruned = processedUpdates.pruned
    + retentionDeleteSteps.reduce((sum, step) => sum + stepResults[step.name].pruned, 0);
  const retentionDeleteCapped = retentionDeleteSteps.some((step) =>
    "countsTowardRunBudget" in step && step.countsTowardRunBudget && stepResults[step.name].cappedAtLimit);
  const cappedAtLimit = Object.fromEntries(Object.entries(stepResults).map(([key, result]) => [key, result.cappedAtLimit]));

  return createCronResult({
    status: "ok",
    itemCount: totalPruned,
    metadata: {
      reason: "retention-completed",
      processedUpdatesPruned: processedUpdates.pruned,
      ...Object.fromEntries(Object.entries(stepResults).map(([key, result]) => [`${key}Pruned`, result.pruned])),
      retentionTruncated: {
        processedUpdates: processedUpdates.cappedAtLimit || processedUpdates.timeBudgetExhausted || processedUpdates.remainingBacklog.count > 0,
        ...cappedAtLimit,
      },
      runBudgetTruncated: processedUpdates.remainingBacklog.count > 0 || retentionDeleteCapped,
      deleteBatchLimit: RETENTION_DELETE_BATCH_LIMIT,
      highVolumeDeleteLimit: HIGH_VOLUME_RETENTION_DELETE_LIMIT,
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
      cappedAtLimit: { processedUpdates: processedUpdates.cappedAtLimit, ...cappedAtLimit },
      retentionDays: RETENTION_DAYS,
    },
  });
}
