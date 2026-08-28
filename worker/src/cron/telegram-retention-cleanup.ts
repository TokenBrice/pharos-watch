import { rethrowIfAborted, throwIfAborted } from "../lib/abort";
import type { CronResult } from "../lib/cron-logger";
import { createCronResult } from "../lib/cron-result";
import { runWithOverloadRetry } from "../lib/d1-overload-retry";
import { toErrorMessage } from "../lib/error-utils";
import { type CappedDeleteResult, deleteCapped } from "./shared/capped-delete";
import {
  TELEGRAM_PROCESSED_UPDATE_PRUNE_LIMIT,
  countTelegramProcessedUpdateBacklog,
  pruneTelegramProcessedUpdates,
  type TelegramProcessedUpdateBacklog,
} from "../lib/telegram-processed-updates";
import { reconcileExpiredTelegramAlertJobTargets } from "./telegram-alert-target-status";
import { pruneTelegramRecapTargets } from "../lib/telegram-recap-store";
import {
  TELEGRAM_ADOPTION_SESSION_CACHE_PREFIX,
  TELEGRAM_ADOPTION_SESSION_TTL_SEC,
} from "../lib/telegram-adoption-analytics";

const DAY_SEC = 24 * 60 * 60;
const ALERT_AUDIT_RETENTION_SEC = 90 * DAY_SEC;
const AUTHORITATIVE_WORKFLOW_RETENTION_SEC = DAY_SEC;
const AUTHORITATIVE_REPLAY_RETENTION_SEC = 14 * DAY_SEC;
const STALE_UNRESOLVED_RETENTION_SEC = 30 * DAY_SEC;
const USAGE_DAILY_RETENTION_SEC = 400 * DAY_SEC;
const CHAT_DIAGNOSTICS_RETENTION_SEC = 90 * DAY_SEC;
const SHORT_LIVED_CHAT_CACHE_RETENTION_SEC = 7 * DAY_SEC;
const RE_ENGAGEMENT_WARNING_CACHE_RETENTION_SEC = 30 * DAY_SEC;
const MINI_APP_MUTATION_BURST_CACHE_PREFIX = "telegram:mini-app-mutation-burst:";
const RETENTION_DELETE_BATCH_LIMIT = 10_000;
const HIGH_VOLUME_RETENTION_DELETE_LIMIT = 100_000;
export const TELEGRAM_PROCESSED_UPDATE_PRUNE_BATCH_LIMIT = 1_000;
const TELEGRAM_PROCESSED_UPDATE_PRUNE_TIME_BUDGET_MS = 2_000;

interface TelegramRetentionCleanupOptions {
  monotonicNow?: () => number;
  processedUpdateTimeBudgetMs?: number;
  highGrowthDeleteLimit?: number;
}

interface ProcessedUpdateDeleteResult extends CappedDeleteResult {
  batches: number;
  remainingBacklog: TelegramProcessedUpdateBacklog;
  timeBudgetExhausted: boolean;
  timeBudgetMs: number;
}

interface TelegramHighGrowthRetentionResult {
  terminalCutoff: number;
  unresolvedCutoff: number;
  rowLimit: number;
  legacyTargetItemsPruned: number;
  legacyTargetsPruned: number;
  legacyTerminalJobsPruned: number;
  staleUnresolvedJobsPruned: number;
  staleUnresolvedSourcesPruned: number;
  oldestLegacyTargetRemainingAt: number | null;
  oldestLegacyTargetEligibleAt: number | null;
  oldestUnresolvedSourceRemainingAt: number | null;
  cappedAtLimit: boolean;
  durationMs: number;
  error: string | null;
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

interface CappedDeleteOptions {
  signal?: AbortSignal;
  totalLimit?: number;
  /** Cutoff placeholders the statement binds ahead of its LIMIT. */
  cutoffBindCount?: 1 | 2;
}

function deleteOlderThanCapped(
  db: D1Database,
  sql: string,
  cutoff: number | string,
  options: CappedDeleteOptions = {},
): Promise<CappedDeleteResult> {
  const { signal, totalLimit = RETENTION_DELETE_BATCH_LIMIT, cutoffBindCount = 2 } = options;
  return deleteCapped(
    db,
    sql,
    (limit) => (cutoffBindCount === 2 ? [cutoff, cutoff, limit] : [cutoff, limit]),
    RETENTION_DELETE_BATCH_LIMIT,
    totalLimit,
    signal,
  );
}

async function pruneTelegramHighGrowthRetention(
  db: D1Database,
  nowSec: number,
  highGrowthDeleteLimit: number,
  signal?: AbortSignal,
): Promise<TelegramHighGrowthRetentionResult> {
  const startedAtMs = Date.now();
  const terminalCutoff = nowSec - AUTHORITATIVE_REPLAY_RETENTION_SEC;
  const unresolvedCutoff = nowSec - STALE_UNRESOLVED_RETENTION_SEC;
  const result: TelegramHighGrowthRetentionResult = {
    terminalCutoff,
    unresolvedCutoff,
    rowLimit: highGrowthDeleteLimit,
    legacyTargetItemsPruned: 0,
    legacyTargetsPruned: 0,
    legacyTerminalJobsPruned: 0,
    staleUnresolvedJobsPruned: 0,
    staleUnresolvedSourcesPruned: 0,
    oldestLegacyTargetRemainingAt: null,
    oldestLegacyTargetEligibleAt: null,
    oldestUnresolvedSourceRemainingAt: null,
    cappedAtLimit: false,
    durationMs: 0,
    error: null,
  };

  const legacyTerminalTargetPredicate = `
    target.plan_generation IS NULL
    AND target.created_at < ?
    AND target.status IN ('sent', 'failed', 'expired')
    AND (
      target.final_delivery_state IS NULL
      OR target.final_delivery_state IN ('accepted', 'failed', 'cancelled', 'expired')
    )
    AND target.effect_state NOT IN ('claimed', 'sending', 'execution_unknown')
    AND NOT EXISTS (
      SELECT 1 FROM telegram_pending_alerts pending
       WHERE pending.dedupe_key = target.pending_dedupe_key
         AND pending.delivery_state IN ('pending', 'sending', 'execution_unknown')
    )`;
  const legacyDeletableTargetPredicate = `
    ${legacyTerminalTargetPredicate}
    AND NOT EXISTS (
      SELECT 1 FROM telegram_alert_job_target_items item
       WHERE item.job_id = target.job_id
         AND item.target_key = target.target_key
    )`;

  try {
    const legacyTargetItems = await deleteOlderThanCapped(
      db,
      `/* pharos:telegram:legacy-terminal-target-items-retention */
       DELETE FROM telegram_alert_job_target_items
        WHERE rowid IN (
          SELECT item.rowid
            FROM telegram_alert_job_targets target
            JOIN telegram_alert_job_target_items item
              ON item.job_id = target.job_id
             AND item.target_key = target.target_key
           WHERE ${legacyTerminalTargetPredicate}
           ORDER BY target.created_at ASC, target.rowid ASC, item.rowid ASC
           LIMIT ?
        )`,
      terminalCutoff,
      { signal, totalLimit: highGrowthDeleteLimit, cutoffBindCount: 1 },
    );
    result.legacyTargetItemsPruned = legacyTargetItems.pruned;
    result.cappedAtLimit ||= legacyTargetItems.cappedAtLimit;
    throwIfAborted(signal);

    const legacyTargets = await deleteOlderThanCapped(
      db,
      `/* pharos:telegram:legacy-terminal-targets-retention */
       DELETE FROM telegram_alert_job_targets
        WHERE rowid IN (
          SELECT target.rowid
            FROM telegram_alert_job_targets target
           WHERE ${legacyDeletableTargetPredicate}
           ORDER BY target.created_at ASC, target.rowid ASC
           LIMIT ?
        )`,
      terminalCutoff,
      { signal, totalLimit: highGrowthDeleteLimit, cutoffBindCount: 1 },
    );
    result.legacyTargetsPruned = legacyTargets.pruned;
    result.cappedAtLimit ||= legacyTargets.cappedAtLimit;
    throwIfAborted(signal);

    const legacyTerminalJobs = await deleteOlderThanCapped(
      db,
      `/* pharos:telegram:legacy-terminal-jobs-retention */
       DELETE FROM telegram_alert_jobs
        WHERE created_at < ?
          AND job_id IN (
            SELECT job.job_id
              FROM telegram_alert_jobs job
             WHERE job.created_at < ?
               AND job.status IN ('sent', 'expired')
               AND NOT EXISTS (
                 SELECT 1 FROM telegram_alert_job_targets target
                  WHERE target.job_id = job.job_id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM telegram_alert_source_events source
                  WHERE source.source_event_id = job.source_event_id
               )
             ORDER BY job.created_at ASC, job.job_id ASC
             LIMIT ?
      )`,
      terminalCutoff,
      { signal, totalLimit: highGrowthDeleteLimit },
    );
    result.legacyTerminalJobsPruned = legacyTerminalJobs.pruned;
    result.cappedAtLimit ||= legacyTerminalJobs.cappedAtLimit;
    throwIfAborted(signal);

    const staleUnresolvedJobs = await deleteOlderThanCapped(
      db,
      `/* pharos:telegram:stale-unresolved-jobs-retention */
       DELETE FROM telegram_alert_jobs
        WHERE created_at < ?
          AND job_id IN (
            SELECT job.job_id
              FROM telegram_alert_jobs job
             WHERE job.created_at < ?
               AND job.status IN ('discovered', 'queued')
               AND NOT EXISTS (
                 SELECT 1 FROM telegram_alert_job_targets target
                  WHERE target.job_id = job.job_id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM telegram_alert_source_events source
                  WHERE source.source_event_id = job.source_event_id
               )
             ORDER BY job.created_at ASC, job.job_id ASC
             LIMIT ?
      )`,
      unresolvedCutoff,
      { signal, totalLimit: highGrowthDeleteLimit },
    );
    result.staleUnresolvedJobsPruned = staleUnresolvedJobs.pruned;
    result.cappedAtLimit ||= staleUnresolvedJobs.cappedAtLimit;
    throwIfAborted(signal);

    const staleUnresolvedSources = await deleteCapped(
      db,
      `/* pharos:telegram:stale-unresolved-sources-retention */
             DELETE FROM telegram_alert_source_events
              WHERE detected_at < ?
                AND rowid IN (
                  SELECT source.rowid
                    FROM telegram_alert_source_events source
                   WHERE source.detected_at < ?
                     AND source.expires_at < ?
                     AND source.status IN ('resolving', 'planned', 'baseline_committed')
                     AND NOT EXISTS (SELECT 1 FROM telegram_alert_target_plan_items child WHERE child.source_event_id = source.source_event_id)
                     AND NOT EXISTS (SELECT 1 FROM telegram_alert_target_plans child WHERE child.source_event_id = source.source_event_id)
                     AND NOT EXISTS (SELECT 1 FROM telegram_alert_target_plan_pages child WHERE child.source_event_id = source.source_event_id)
                     AND NOT EXISTS (SELECT 1 FROM telegram_alert_planning_subscribers child WHERE child.source_event_id = source.source_event_id)
                     AND NOT EXISTS (SELECT 1 FROM telegram_alert_target_expiry_progress child WHERE child.source_event_id = source.source_event_id)
                     AND NOT EXISTS (SELECT 1 FROM telegram_alert_source_resolution_targets child WHERE child.source_event_id = source.source_event_id)
                     AND NOT EXISTS (SELECT 1 FROM telegram_alert_source_resolution_memberships child WHERE child.source_event_id = source.source_event_id)
                     AND NOT EXISTS (SELECT 1 FROM telegram_alert_source_resolution_pages child WHERE child.source_event_id = source.source_event_id)
                     AND NOT EXISTS (SELECT 1 FROM telegram_alert_job_target_items child WHERE child.source_event_id = source.source_event_id)
                     AND NOT EXISTS (SELECT 1 FROM telegram_alert_job_targets child WHERE child.source_event_id = source.source_event_id)
                     AND NOT EXISTS (SELECT 1 FROM telegram_alert_jobs child WHERE child.source_event_id = source.source_event_id)
                     AND NOT EXISTS (SELECT 1 FROM telegram_pending_alerts child WHERE child.source_event_id = source.source_event_id)
                     AND NOT EXISTS (SELECT 1 FROM telegram_alert_dead_letters child WHERE child.source_event_id = source.source_event_id)
                     AND NOT EXISTS (SELECT 1 FROM telegram_freeze_alert_targets child WHERE child.source_event_id = source.source_event_id)
                     AND NOT EXISTS (SELECT 1 FROM telegram_freeze_alert_events child WHERE child.source_event_id = source.source_event_id)
                   ORDER BY source.detected_at ASC, source.rowid ASC
                   LIMIT ?
                )`,
      (limit) => [unresolvedCutoff, unresolvedCutoff, nowSec, limit],
      RETENTION_DELETE_BATCH_LIMIT,
      highGrowthDeleteLimit,
      signal,
    );
    result.staleUnresolvedSourcesPruned = staleUnresolvedSources.pruned;
    result.cappedAtLimit ||= staleUnresolvedSources.cappedAtLimit;
    throwIfAborted(signal);

    const oldestLegacyTarget = await runWithOverloadRetry(
      () => db
        .prepare(
          `SELECT MIN(created_at) AS oldest_remaining_at
             FROM telegram_alert_job_targets
            WHERE plan_generation IS NULL`,
        )
        .first<{ oldest_remaining_at: number | null }>(),
      3,
      signal,
    );
    result.oldestLegacyTargetRemainingAt = oldestLegacyTarget?.oldest_remaining_at ?? null;

    const oldestEligibleTarget = await runWithOverloadRetry(
      () => db
        .prepare(
          `/* pharos:telegram:legacy-terminal-targets-oldest-eligible */
           SELECT target.created_at AS oldest_eligible_at
             FROM telegram_alert_job_targets target
            WHERE ${legacyTerminalTargetPredicate}
            ORDER BY target.created_at ASC, target.rowid ASC
            LIMIT 1`,
        )
        .bind(terminalCutoff)
        .first<{ oldest_eligible_at: number | null }>(),
      3,
      signal,
    );
    result.oldestLegacyTargetEligibleAt = oldestEligibleTarget?.oldest_eligible_at ?? null;

    const oldestUnresolvedSource = await runWithOverloadRetry(
      () => db
        .prepare(
          `SELECT MIN(detected_at) AS oldest_remaining_at
             FROM telegram_alert_source_events
            WHERE status IN ('resolving', 'planned', 'baseline_committed')`,
        )
        .first<{ oldest_remaining_at: number | null }>(),
      3,
      signal,
    );
    result.oldestUnresolvedSourceRemainingAt = oldestUnresolvedSource?.oldest_remaining_at ?? null;
  } catch (error) {
    rethrowIfAborted(error, signal);
    result.error = toErrorMessage(error).slice(0, 500);
  }

  result.durationMs = Math.max(0, Date.now() - startedAtMs);
  return result;
}

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
interface TelegramRetentionReportDescriptor {
  flat?: false;
  capped?: false;
  group?: string;
}

type TelegramRetentionDeleteStep = (
  | {
      name: string;
      sql: string;
      cutoff: number | string;
      cutoffBindCount: 1 | 2;
      totalLimit?: number;
      countsTowardRunBudget?: boolean;
    }
  | {
      name: string;
      cachePrefix: string;
      cutoff: number;
    }
) & {
  report?: TelegramRetentionReportDescriptor;
};

function runTelegramRetentionDeleteStep(
  db: D1Database,
  step: TelegramRetentionDeleteStep,
  signal?: AbortSignal,
): Promise<CappedDeleteResult> {
  return "cachePrefix" in step
    ? deleteCachePrefixOlderThanCapped(db, step.cachePrefix, step.cutoff, signal)
    : deleteOlderThanCapped(db, step.sql, step.cutoff, {
      signal,
      totalLimit: step.totalLimit,
      cutoffBindCount: step.cutoffBindCount,
    });
}

function buildRetentionStepReport(
  steps: readonly TelegramRetentionDeleteStep[],
  results: Record<string, CappedDeleteResult>,
): {
  pruned: Record<string, number>;
  cappedAtLimit: Record<string, boolean>;
} {
  const report = {
    pruned: {} as Record<string, number>,
    cappedAtLimit: {} as Record<string, boolean>,
  };
  for (const step of steps) {
    const result = results[step.name];
    if (step.report?.flat !== false) report.pruned[`${step.name}Pruned`] = result.pruned;
    if (step.report?.capped !== false) report.cappedAtLimit[step.name] = result.cappedAtLimit;
    if (step.report?.group) {
      const prunedKey = `${step.report.group}Pruned`;
      report.pruned[prunedKey] = (report.pruned[prunedKey] ?? 0) + result.pruned;
      report.cappedAtLimit[step.report.group] =
        (report.cappedAtLimit[step.report.group] ?? false) || result.cappedAtLimit;
    }
  }
  return report;
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

  const recapTargets = await runWithOverloadRetry(
    () => pruneTelegramRecapTargets(db, nowSec, { limit: RETENTION_DELETE_BATCH_LIMIT }),
    3,
    signal,
  );
  throwIfAborted(signal);

  const processedUpdates = await pruneTelegramProcessedUpdatesCapped(db, nowSec, signal, options);
  throwIfAborted(signal);

  const workflowCutoff = nowSec - AUTHORITATIVE_WORKFLOW_RETENTION_SEC;
  const replayCutoff = nowSec - AUTHORITATIVE_REPLAY_RETENTION_SEC;
  const alertAuditCutoff = nowSec - ALERT_AUDIT_RETENTION_SEC;
  const highGrowthDeleteLimit = options.highGrowthDeleteLimit ?? HIGH_VOLUME_RETENTION_DELETE_LIMIT;
  if (!Number.isSafeInteger(highGrowthDeleteLimit) || highGrowthDeleteLimit <= 0) {
    throw new RangeError("Telegram high-growth retention row limit must be a positive safe integer.");
  }
  const highGrowthRetention = await pruneTelegramHighGrowthRetention(
    db,
    nowSec,
    highGrowthDeleteLimit,
    signal,
  );
  throwIfAborted(signal);

  // `day` is TEXT (YYYY-MM-DD) in telegram_usage_daily and
  // telegram_watcher_lifecycle_daily; an integer cutoff would never match. Bind
  // the cutoff as a YYYY-MM-DD string so the comparison is text-vs-text.
  const cutoffDayString = new Date((nowSec - USAGE_DAILY_RETENTION_SEC) * 1000).toISOString().slice(0, 10);

  const retentionDeleteSteps = [
    {
      name: "targetPlanItems",
      sql: `DELETE FROM telegram_alert_target_plan_items
      WHERE rowid IN (
        SELECT child.rowid
          FROM telegram_alert_source_events source
          JOIN telegram_alert_target_plan_items child
            ON child.source_event_id = source.source_event_id
         WHERE source.completed_at < ?
           AND source.status IN ('complete', 'expired')
         ORDER BY source.completed_at ASC, source.source_event_id ASC, child.rowid ASC
         LIMIT ?
      )`,
      cutoff: workflowCutoff,
      cutoffBindCount: 1,
      totalLimit: HIGH_VOLUME_RETENTION_DELETE_LIMIT,
      countsTowardRunBudget: true,
    },
    {
      name: "targetPlanPages",
      sql: `DELETE FROM telegram_alert_target_plan_pages
      WHERE rowid IN (
        SELECT child.rowid
          FROM telegram_alert_source_events source
          JOIN telegram_alert_target_plan_pages child
            ON child.source_event_id = source.source_event_id
         WHERE source.completed_at < ?
           AND source.status IN ('complete', 'expired')
         ORDER BY source.completed_at ASC, source.source_event_id ASC, child.rowid ASC
         LIMIT ?
      )`,
      cutoff: workflowCutoff,
      cutoffBindCount: 1,
    },
    {
      name: "planningSubscribers",
      sql: `DELETE FROM telegram_alert_planning_subscribers
      WHERE rowid IN (
        SELECT child.rowid
          FROM telegram_alert_source_events source
          JOIN telegram_alert_planning_subscribers child
            ON child.source_event_id = source.source_event_id
         WHERE source.completed_at < ?
           AND source.status IN ('complete', 'expired')
         ORDER BY source.completed_at ASC, source.source_event_id ASC, child.rowid ASC
         LIMIT ?
      )`,
      cutoff: workflowCutoff,
      cutoffBindCount: 1,
      totalLimit: HIGH_VOLUME_RETENTION_DELETE_LIMIT,
      countsTowardRunBudget: true,
    },
    {
      name: "targetExpiryProgress",
      sql: `DELETE FROM telegram_alert_target_expiry_progress
      WHERE rowid IN (
        SELECT child.rowid
          FROM telegram_alert_source_events source
          JOIN telegram_alert_target_expiry_progress child
            ON child.source_event_id = source.source_event_id
         WHERE source.completed_at < ?
           AND source.status IN ('complete', 'expired')
           AND child.state = 'complete'
         ORDER BY source.completed_at ASC, source.source_event_id ASC, child.rowid ASC
         LIMIT ?
      )`,
      cutoff: workflowCutoff,
      cutoffBindCount: 1,
    },
    {
      name: "replayJobTargetItems",
      sql: `DELETE FROM telegram_alert_job_target_items
      WHERE rowid IN (
        SELECT item.rowid
          FROM telegram_alert_source_events source
          JOIN telegram_alert_job_targets target
            ON target.source_event_id = source.source_event_id
          JOIN telegram_alert_job_target_items item
            ON item.job_id = target.job_id AND item.target_key = target.target_key
         WHERE source.completed_at < ?
           AND source.status IN ('complete', 'expired')
           AND target.plan_generation IS NOT NULL
           AND target.final_delivery_state IN ('accepted', 'failed', 'cancelled', 'expired')
           AND target.effect_state NOT IN ('claimed', 'sending', 'execution_unknown')
           AND NOT EXISTS (
             SELECT 1 FROM telegram_pending_alerts pending
              WHERE pending.dedupe_key = target.pending_dedupe_key
                AND pending.delivery_state IN ('pending', 'sending', 'execution_unknown')
           )
         ORDER BY source.completed_at ASC, source.source_event_id ASC, item.rowid ASC
         LIMIT ?
      )`,
      cutoff: replayCutoff,
      cutoffBindCount: 1,
      totalLimit: HIGH_VOLUME_RETENTION_DELETE_LIMIT,
      countsTowardRunBudget: true,
      report: { capped: false, group: "jobTargetItems" },
    },
    {
      name: "replayJobTargets",
      sql: `DELETE FROM telegram_alert_job_targets
      WHERE rowid IN (
        SELECT target.rowid
          FROM telegram_alert_source_events source
          JOIN telegram_alert_job_targets target
            ON target.source_event_id = source.source_event_id
         WHERE source.completed_at < ?
           AND source.status IN ('complete', 'expired')
           AND target.plan_generation IS NOT NULL
           AND target.final_delivery_state IN ('accepted', 'failed', 'cancelled', 'expired')
           AND target.effect_state NOT IN ('claimed', 'sending', 'execution_unknown')
           AND NOT EXISTS (
             SELECT 1 FROM telegram_pending_alerts pending
              WHERE pending.dedupe_key = target.pending_dedupe_key
                AND pending.delivery_state IN ('pending', 'sending', 'execution_unknown')
           )
         ORDER BY source.completed_at ASC, source.source_event_id ASC, target.rowid ASC
         LIMIT ?
      )`,
      cutoff: replayCutoff,
      cutoffBindCount: 1,
      totalLimit: HIGH_VOLUME_RETENTION_DELETE_LIMIT,
      countsTowardRunBudget: true,
      report: { capped: false, group: "jobTargets" },
    },
    {
      name: "targetPlans",
      sql: `DELETE FROM telegram_alert_target_plans
      WHERE rowid IN (
        SELECT plan.rowid
          FROM telegram_alert_source_events source
          JOIN telegram_alert_target_plans plan
            ON plan.source_event_id = source.source_event_id
         WHERE source.completed_at < ?
           AND source.status IN ('complete', 'expired')
           AND NOT EXISTS (
             SELECT 1 FROM telegram_alert_job_targets target
              WHERE target.source_event_id = plan.source_event_id
                AND target.plan_generation = plan.plan_generation
                AND target.plan_key = plan.plan_key
           )
         ORDER BY source.completed_at ASC, source.source_event_id ASC, plan.rowid ASC
         LIMIT ?
      )`,
      cutoff: replayCutoff,
      cutoffBindCount: 1,
      totalLimit: HIGH_VOLUME_RETENTION_DELETE_LIMIT,
      countsTowardRunBudget: true,
    },
    {
      name: "replayJobs",
      sql: `DELETE FROM telegram_alert_jobs
      WHERE rowid IN (
        SELECT job.rowid
          FROM telegram_alert_source_events source
          JOIN telegram_alert_jobs job
            ON job.source_event_id = source.source_event_id
         WHERE source.completed_at < ?
           AND source.status IN ('complete', 'expired')
           AND NOT EXISTS (
             SELECT 1 FROM telegram_alert_job_targets target
              WHERE target.job_id = job.job_id
           )
         ORDER BY source.completed_at ASC, source.source_event_id ASC, job.rowid ASC
         LIMIT ?
      )`,
      cutoff: replayCutoff,
      cutoffBindCount: 1,
      report: { capped: false, group: "jobs" },
    },
    {
      name: "replaySourceResolutionTargets",
      sql: `DELETE FROM telegram_alert_source_resolution_targets
      WHERE rowid IN (
        SELECT child.rowid
          FROM telegram_alert_source_events source
          JOIN telegram_alert_source_resolution_targets child
            ON child.source_event_id = source.source_event_id
         WHERE source.completed_at < ?
           AND source.status IN ('complete', 'expired')
         ORDER BY source.completed_at ASC, source.source_event_id ASC, child.rowid ASC
         LIMIT ?
      )`,
      cutoff: replayCutoff,
      cutoffBindCount: 1,
      report: { flat: false, capped: false, group: "sourceResolutionTargets" },
    },
    {
      name: "replaySourceResolutionMemberships",
      sql: `DELETE FROM telegram_alert_source_resolution_memberships
      WHERE rowid IN (
        SELECT child.rowid
          FROM telegram_alert_source_events source
          JOIN telegram_alert_source_resolution_memberships child
            ON child.source_event_id = source.source_event_id
         WHERE source.completed_at < ?
           AND source.status IN ('complete', 'expired')
         ORDER BY source.completed_at ASC, source.source_event_id ASC, child.rowid ASC
         LIMIT ?
      )`,
      cutoff: replayCutoff,
      cutoffBindCount: 1,
      report: { flat: false, capped: false, group: "sourceResolutionMemberships" },
    },
    {
      name: "replaySourceResolutionPages",
      sql: `DELETE FROM telegram_alert_source_resolution_pages
      WHERE rowid IN (
        SELECT child.rowid
          FROM telegram_alert_source_events source
          JOIN telegram_alert_source_resolution_pages child
            ON child.source_event_id = source.source_event_id
         WHERE source.completed_at < ?
           AND source.status IN ('complete', 'expired')
         ORDER BY source.completed_at ASC, source.source_event_id ASC, child.rowid ASC
         LIMIT ?
      )`,
      cutoff: replayCutoff,
      cutoffBindCount: 1,
      report: { flat: false, capped: false, group: "sourceResolutionPages" },
    },
    {
      name: "replaySourceEvents",
      sql: `DELETE FROM telegram_alert_source_events
      WHERE completed_at < ?
        AND rowid IN (
          SELECT source.rowid
            FROM telegram_alert_source_events source
           WHERE source.completed_at < ?
             AND source.status IN ('complete', 'expired')
             AND NOT EXISTS (SELECT 1 FROM telegram_alert_target_plan_items child WHERE child.source_event_id = source.source_event_id)
             AND NOT EXISTS (SELECT 1 FROM telegram_alert_target_plans child WHERE child.source_event_id = source.source_event_id)
             AND NOT EXISTS (SELECT 1 FROM telegram_alert_target_plan_pages child WHERE child.source_event_id = source.source_event_id)
             AND NOT EXISTS (SELECT 1 FROM telegram_alert_planning_subscribers child WHERE child.source_event_id = source.source_event_id)
             AND NOT EXISTS (SELECT 1 FROM telegram_alert_target_expiry_progress child WHERE child.source_event_id = source.source_event_id)
             AND NOT EXISTS (SELECT 1 FROM telegram_alert_source_resolution_targets child WHERE child.source_event_id = source.source_event_id)
             AND NOT EXISTS (SELECT 1 FROM telegram_alert_source_resolution_memberships child WHERE child.source_event_id = source.source_event_id)
             AND NOT EXISTS (SELECT 1 FROM telegram_alert_source_resolution_pages child WHERE child.source_event_id = source.source_event_id)
             AND NOT EXISTS (SELECT 1 FROM telegram_alert_job_target_items child WHERE child.source_event_id = source.source_event_id)
             AND NOT EXISTS (SELECT 1 FROM telegram_alert_job_targets child WHERE child.source_event_id = source.source_event_id)
             AND NOT EXISTS (SELECT 1 FROM telegram_alert_jobs child WHERE child.source_event_id = source.source_event_id)
             AND NOT EXISTS (SELECT 1 FROM telegram_freeze_alert_targets child WHERE child.source_event_id = source.source_event_id)
             AND NOT EXISTS (SELECT 1 FROM telegram_freeze_alert_events child WHERE child.source_event_id = source.source_event_id)
           ORDER BY source.completed_at ASC, source.rowid ASC
           LIMIT ?
        )`,
      cutoff: replayCutoff,
      cutoffBindCount: 2,
      report: { capped: false, group: "sourceEvents" },
    },
    {
      name: "deadLetters",
      sql: "DELETE FROM telegram_alert_dead_letters WHERE expired_at < ? AND id IN (SELECT id FROM telegram_alert_dead_letters WHERE expired_at < ? ORDER BY expired_at ASC, id ASC LIMIT ?)",
      cutoff: alertAuditCutoff,
      cutoffBindCount: 2,
    },
    {
      name: "auditJobTargetItems",
      sql: "DELETE FROM telegram_alert_job_target_items WHERE created_at < ? AND rowid IN (SELECT rowid FROM telegram_alert_job_target_items WHERE created_at < ? ORDER BY created_at ASC, rowid ASC LIMIT ?)",
      cutoff: alertAuditCutoff,
      cutoffBindCount: 2,
      totalLimit: HIGH_VOLUME_RETENTION_DELETE_LIMIT,
      countsTowardRunBudget: true,
      report: { flat: false, capped: false, group: "jobTargetItems" },
    },
    {
      name: "auditJobTargets",
      sql: "DELETE FROM telegram_alert_job_targets WHERE created_at < ? AND rowid IN (SELECT rowid FROM telegram_alert_job_targets WHERE created_at < ? ORDER BY created_at ASC, rowid ASC LIMIT ?)",
      cutoff: alertAuditCutoff,
      cutoffBindCount: 2,
      totalLimit: HIGH_VOLUME_RETENTION_DELETE_LIMIT,
      countsTowardRunBudget: true,
      report: { flat: false, capped: false, group: "jobTargets" },
    },
    {
      name: "auditJobs",
      sql: "DELETE FROM telegram_alert_jobs WHERE created_at < ? AND rowid IN (SELECT rowid FROM telegram_alert_jobs WHERE created_at < ? ORDER BY created_at ASC, rowid ASC LIMIT ?)",
      cutoff: alertAuditCutoff,
      cutoffBindCount: 2,
      report: { flat: false, capped: false, group: "jobs" },
    },
    {
      name: "auditSourceResolutionTargets",
      sql: "DELETE FROM telegram_alert_source_resolution_targets WHERE created_at < ? AND rowid IN (SELECT rowid FROM telegram_alert_source_resolution_targets WHERE created_at < ? ORDER BY created_at ASC, rowid ASC LIMIT ?)",
      cutoff: alertAuditCutoff,
      cutoffBindCount: 2,
      report: { flat: false, capped: false, group: "sourceResolutionTargets" },
    },
    {
      name: "auditSourceResolutionMemberships",
      sql: "DELETE FROM telegram_alert_source_resolution_memberships WHERE created_at < ? AND rowid IN (SELECT rowid FROM telegram_alert_source_resolution_memberships WHERE created_at < ? ORDER BY created_at ASC, rowid ASC LIMIT ?)",
      cutoff: alertAuditCutoff,
      cutoffBindCount: 2,
      report: { flat: false, capped: false, group: "sourceResolutionMemberships" },
    },
    {
      name: "auditSourceResolutionPages",
      sql: "DELETE FROM telegram_alert_source_resolution_pages WHERE created_at < ? AND rowid IN (SELECT rowid FROM telegram_alert_source_resolution_pages WHERE created_at < ? ORDER BY created_at ASC, rowid ASC LIMIT ?)",
      cutoff: alertAuditCutoff,
      cutoffBindCount: 2,
      report: { flat: false, capped: false, group: "sourceResolutionPages" },
    },
    {
      name: "freezeTargets",
      sql: "DELETE FROM telegram_freeze_alert_targets WHERE created_at < ? AND rowid IN (SELECT rowid FROM telegram_freeze_alert_targets WHERE created_at < ? ORDER BY created_at ASC, rowid ASC LIMIT ?)",
      cutoff: alertAuditCutoff,
      cutoffBindCount: 2,
    },
    {
      name: "freezeEvents",
      sql: "DELETE FROM telegram_freeze_alert_events WHERE detected_at < ? AND rowid IN (SELECT rowid FROM telegram_freeze_alert_events WHERE detected_at < ? ORDER BY detected_at ASC, rowid ASC LIMIT ?)",
      cutoff: alertAuditCutoff,
      cutoffBindCount: 2,
    },
    {
      name: "auditSourceEvents",
      sql: `DELETE FROM telegram_alert_source_events
      WHERE detected_at < ?
        AND rowid IN (
          SELECT source.rowid
            FROM telegram_alert_source_events source
           WHERE source.detected_at < ?
             AND source.status IN ('complete', 'expired')
             AND NOT EXISTS (SELECT 1 FROM telegram_alert_target_plan_items child WHERE child.source_event_id = source.source_event_id)
             AND NOT EXISTS (SELECT 1 FROM telegram_alert_target_plans child WHERE child.source_event_id = source.source_event_id)
             AND NOT EXISTS (SELECT 1 FROM telegram_alert_target_plan_pages child WHERE child.source_event_id = source.source_event_id)
             AND NOT EXISTS (SELECT 1 FROM telegram_alert_planning_subscribers child WHERE child.source_event_id = source.source_event_id)
             AND NOT EXISTS (SELECT 1 FROM telegram_alert_target_expiry_progress child WHERE child.source_event_id = source.source_event_id)
             AND NOT EXISTS (SELECT 1 FROM telegram_alert_source_resolution_targets child WHERE child.source_event_id = source.source_event_id)
             AND NOT EXISTS (SELECT 1 FROM telegram_alert_source_resolution_memberships child WHERE child.source_event_id = source.source_event_id)
             AND NOT EXISTS (SELECT 1 FROM telegram_alert_source_resolution_pages child WHERE child.source_event_id = source.source_event_id)
             AND NOT EXISTS (SELECT 1 FROM telegram_alert_job_target_items child WHERE child.source_event_id = source.source_event_id)
             AND NOT EXISTS (SELECT 1 FROM telegram_alert_job_targets child WHERE child.source_event_id = source.source_event_id)
             AND NOT EXISTS (SELECT 1 FROM telegram_alert_jobs child WHERE child.source_event_id = source.source_event_id)
             AND NOT EXISTS (SELECT 1 FROM telegram_freeze_alert_targets child WHERE child.source_event_id = source.source_event_id)
             AND NOT EXISTS (SELECT 1 FROM telegram_freeze_alert_events child WHERE child.source_event_id = source.source_event_id)
           ORDER BY source.detected_at ASC, source.rowid ASC
           LIMIT ?
        )`,
      cutoff: alertAuditCutoff,
      cutoffBindCount: 2,
      report: { flat: false, capped: false, group: "sourceEvents" },
    },
    {
      name: "usageDaily",
      sql: "DELETE FROM telegram_usage_daily WHERE day < ? AND rowid IN (SELECT rowid FROM telegram_usage_daily WHERE day < ? ORDER BY day ASC, rowid ASC LIMIT ?)",
      cutoff: cutoffDayString,
      cutoffBindCount: 2,
    },
    {
      name: "watcherLifecycle",
      sql: "DELETE FROM telegram_watcher_lifecycle_daily WHERE day < ? AND rowid IN (SELECT rowid FROM telegram_watcher_lifecycle_daily WHERE day < ? ORDER BY day ASC, rowid ASC LIMIT ?)",
      cutoff: cutoffDayString,
      cutoffBindCount: 2,
    },
    {
      name: "adoptionDaily",
      sql: "DELETE FROM telegram_adoption_daily WHERE day < ? AND rowid IN (SELECT rowid FROM telegram_adoption_daily WHERE day < ? ORDER BY day ASC, rowid ASC LIMIT ?)",
      cutoff: cutoffDayString,
      cutoffBindCount: 2,
    },
    {
      name: "adoptionRetention",
      sql: "DELETE FROM telegram_adoption_retention_daily WHERE measurement_day < ? AND rowid IN (SELECT rowid FROM telegram_adoption_retention_daily WHERE measurement_day < ? ORDER BY measurement_day ASC, rowid ASC LIMIT ?)",
      cutoff: cutoffDayString,
      cutoffBindCount: 2,
    },
    {
      name: "adoptionIngressQuota",
      sql: "DELETE FROM telegram_adoption_ingress_quota WHERE updated_at < ? AND rowid IN (SELECT rowid FROM telegram_adoption_ingress_quota WHERE updated_at < ? ORDER BY updated_at ASC, rowid ASC LIMIT ?)",
      cutoff: nowSec - 2 * DAY_SEC,
      cutoffBindCount: 2,
    },
    {
      name: "adoptionClientQuota",
      sql: "DELETE FROM telegram_adoption_client_quota WHERE updated_at < ? AND rowid IN (SELECT rowid FROM telegram_adoption_client_quota WHERE updated_at < ? ORDER BY updated_at ASC, rowid ASC LIMIT ?)",
      cutoff: nowSec - 2 * DAY_SEC,
      cutoffBindCount: 2,
    },
    {
      name: "diagnostics",
      sql: "DELETE FROM telegram_chat_delivery_diagnostics WHERE updated_at < ? AND rowid IN (SELECT rowid FROM telegram_chat_delivery_diagnostics WHERE updated_at < ? ORDER BY updated_at ASC, rowid ASC LIMIT ?)",
      cutoff: nowSec - CHAT_DIAGNOSTICS_RETENTION_SEC,
      cutoffBindCount: 2,
    },
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
      name: "miniAppAdoptionSessionCache",
      cachePrefix: TELEGRAM_ADOPTION_SESSION_CACHE_PREFIX,
      cutoff: nowSec - TELEGRAM_ADOPTION_SESSION_TTL_SEC,
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

  const stepResults = {} as Record<(typeof retentionDeleteSteps)[number]["name"], CappedDeleteResult>;
  for (const step of retentionDeleteSteps) {
    throwIfAborted(signal);
    stepResults[step.name] = await runTelegramRetentionDeleteStep(db, step, signal);
  }

  const retentionStepReport = buildRetentionStepReport(retentionDeleteSteps, stepResults);

  const totalPruned =
    processedUpdates.pruned +
    recapTargets.deletedTargets +
    highGrowthRetention.legacyTargetItemsPruned +
    highGrowthRetention.legacyTargetsPruned +
    highGrowthRetention.legacyTerminalJobsPruned +
    highGrowthRetention.staleUnresolvedJobsPruned +
    highGrowthRetention.staleUnresolvedSourcesPruned +
    retentionDeleteSteps.reduce((sum, step) => sum + stepResults[step.name].pruned, 0);
  const retentionDeleteCapped =
    highGrowthRetention.cappedAtLimit ||
    retentionDeleteSteps.some((step) =>
      "countsTowardRunBudget" in step && step.countsTowardRunBudget && stepResults[step.name].cappedAtLimit);

  return createCronResult({
    status: highGrowthRetention.error ? "degraded" : "ok",
    itemCount: totalPruned,
    metadata: {
      processedUpdatesPruned: processedUpdates.pruned,
      recapTargetsPruned: recapTargets.deletedTargets,
      highGrowthRetention: { ...highGrowthRetention },
      legacyTargetItemsPruned: highGrowthRetention.legacyTargetItemsPruned,
      legacyTargetsPruned: highGrowthRetention.legacyTargetsPruned,
      legacyTerminalJobsPruned: highGrowthRetention.legacyTerminalJobsPruned,
      staleUnresolvedJobsPruned: highGrowthRetention.staleUnresolvedJobsPruned,
      staleUnresolvedSourcesPruned: highGrowthRetention.staleUnresolvedSourcesPruned,
      ...retentionStepReport.pruned,
      expiredTargetsReconciled,
      runBudgetTruncated: processedUpdates.remainingBacklog.count > 0 || recapTargets.cappedAtLimit || retentionDeleteCapped,
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
      cappedAtLimit: {
        processedUpdates: processedUpdates.cappedAtLimit,
        recapTargets: recapTargets.cappedAtLimit,
        highGrowthRetention: highGrowthRetention.cappedAtLimit,
        ...retentionStepReport.cappedAtLimit,
      },
      retentionDays: {
        alertAudit: ALERT_AUDIT_RETENTION_SEC / DAY_SEC,
        authoritativeWorkflow: AUTHORITATIVE_WORKFLOW_RETENTION_SEC / DAY_SEC,
        authoritativeReplay: AUTHORITATIVE_REPLAY_RETENTION_SEC / DAY_SEC,
        staleUnresolved: STALE_UNRESOLVED_RETENTION_SEC / DAY_SEC,
        recapTargetsTerminal: 90,
        usageDaily: USAGE_DAILY_RETENTION_SEC / DAY_SEC,
        watcherLifecycle: USAGE_DAILY_RETENTION_SEC / DAY_SEC,
        adoptionDaily: USAGE_DAILY_RETENTION_SEC / DAY_SEC,
        adoptionRetention: USAGE_DAILY_RETENTION_SEC / DAY_SEC,
        adoptionIngressQuota: 2,
        adoptionClientQuota: 2,
        chatDiagnostics: CHAT_DIAGNOSTICS_RETENTION_SEC / DAY_SEC,
        shortLivedChatCache: SHORT_LIVED_CHAT_CACHE_RETENTION_SEC / DAY_SEC,
        miniAppAdoptionSessionCache: TELEGRAM_ADOPTION_SESSION_TTL_SEC / DAY_SEC,
        reEngagementWarningCache: RE_ENGAGEMENT_WARNING_CACHE_RETENTION_SEC / DAY_SEC,
        processedUpdates: 7,
      },
    },
  });
}
