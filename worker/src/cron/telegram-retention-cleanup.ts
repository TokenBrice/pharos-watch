import { rethrowIfAborted, throwIfAborted } from "../lib/abort";
import type { CronResult } from "../lib/cron-logger";
import { createCronResult } from "../lib/cron-result";
import { runWithOverloadRetry } from "../lib/cron-lease";
import { toErrorMessage } from "../lib/error-utils";
import {
  TELEGRAM_PROCESSED_UPDATE_PRUNE_LIMIT,
  countTelegramProcessedUpdateBacklog,
  pruneTelegramProcessedUpdates,
  type TelegramProcessedUpdateBacklog,
} from "../api/telegram-webhook-store";
import { reconcileExpiredTelegramAlertJobTargets } from "./telegram-alert-target-status";
import { pruneTelegramRecapTargets } from "./telegram-recap-store";
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

export interface CappedDeleteResult {
  pruned: number;
  cappedAtLimit: boolean;
}

async function deleteOlderThanCapped(
  db: D1Database,
  sql: string,
  cutoff: number | string,
  signal?: AbortSignal,
  totalLimit = RETENTION_DELETE_BATCH_LIMIT,
): Promise<CappedDeleteResult> {
  let pruned = 0;
  while (pruned < totalLimit) {
    throwIfAborted(signal);
    const batchLimit = Math.min(RETENTION_DELETE_BATCH_LIMIT, totalLimit - pruned);
    const result = await runWithOverloadRetry(() => db.prepare(sql).bind(cutoff, cutoff, batchLimit).run(), 3, signal);
    const batchPruned = Number(result.meta?.changes ?? 0);
    pruned += batchPruned;
    if (batchPruned < batchLimit) break;
  }
  return {
    pruned,
    cappedAtLimit: pruned >= totalLimit,
  };
}

async function deleteSourceChildrenOlderThanCapped(
  db: D1Database,
  sql: string,
  cutoff: number,
  signal?: AbortSignal,
  totalLimit = RETENTION_DELETE_BATCH_LIMIT,
): Promise<CappedDeleteResult> {
  let pruned = 0;
  while (pruned < totalLimit) {
    throwIfAborted(signal);
    const batchLimit = Math.min(RETENTION_DELETE_BATCH_LIMIT, totalLimit - pruned);
    const result = await runWithOverloadRetry(() => db.prepare(sql).bind(cutoff, batchLimit).run(), 3, signal);
    const batchPruned = Number(result.meta?.changes ?? 0);
    pruned += batchPruned;
    if (batchPruned < batchLimit) break;
  }
  return {
    pruned,
    cappedAtLimit: pruned >= totalLimit,
  };
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
    const legacyTargetItems = await deleteSourceChildrenOlderThanCapped(
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
      signal,
      highGrowthDeleteLimit,
    );
    result.legacyTargetItemsPruned = legacyTargetItems.pruned;
    result.cappedAtLimit ||= legacyTargetItems.cappedAtLimit;
    throwIfAborted(signal);

    const legacyTargets = await deleteSourceChildrenOlderThanCapped(
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
      signal,
      highGrowthDeleteLimit,
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
      signal,
      highGrowthDeleteLimit,
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
      signal,
      highGrowthDeleteLimit,
    );
    result.staleUnresolvedJobsPruned = staleUnresolvedJobs.pruned;
    result.cappedAtLimit ||= staleUnresolvedJobs.cappedAtLimit;
    throwIfAborted(signal);

    let staleUnresolvedSourcesPruned = 0;
    while (staleUnresolvedSourcesPruned < highGrowthDeleteLimit) {
      throwIfAborted(signal);
      const batchLimit = Math.min(
        RETENTION_DELETE_BATCH_LIMIT,
        highGrowthDeleteLimit - staleUnresolvedSourcesPruned,
      );
      const deleted = await runWithOverloadRetry(
        () => db
          .prepare(
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
          )
          .bind(unresolvedCutoff, unresolvedCutoff, nowSec, batchLimit)
          .run(),
        3,
        signal,
      );
      const batchPruned = Number(deleted.meta?.changes ?? 0);
      staleUnresolvedSourcesPruned += batchPruned;
      if (batchPruned < batchLimit) break;
    }
    result.staleUnresolvedSourcesPruned = staleUnresolvedSourcesPruned;
    result.cappedAtLimit ||= staleUnresolvedSourcesPruned >= highGrowthDeleteLimit;
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
  return deleteCachePrefixOlderThanCapped(db, "telegram:mini-app-mutation-burst:", cutoff, signal);
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
  const targetPlanItems = await deleteSourceChildrenOlderThanCapped(
    db,
    `DELETE FROM telegram_alert_target_plan_items
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
    workflowCutoff,
    signal,
    HIGH_VOLUME_RETENTION_DELETE_LIMIT,
  );
  throwIfAborted(signal);

  const targetPlanPages = await deleteSourceChildrenOlderThanCapped(
    db,
    `DELETE FROM telegram_alert_target_plan_pages
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
    workflowCutoff,
    signal,
  );
  throwIfAborted(signal);

  const planningSubscribers = await deleteSourceChildrenOlderThanCapped(
    db,
    `DELETE FROM telegram_alert_planning_subscribers
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
    workflowCutoff,
    signal,
    HIGH_VOLUME_RETENTION_DELETE_LIMIT,
  );
  throwIfAborted(signal);

  const targetExpiryProgress = await deleteSourceChildrenOlderThanCapped(
    db,
    `DELETE FROM telegram_alert_target_expiry_progress
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
    workflowCutoff,
    signal,
  );
  throwIfAborted(signal);

  const replayJobTargetItems = await deleteSourceChildrenOlderThanCapped(
    db,
    `DELETE FROM telegram_alert_job_target_items
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
    replayCutoff,
    signal,
    HIGH_VOLUME_RETENTION_DELETE_LIMIT,
  );
  throwIfAborted(signal);

  const replayJobTargets = await deleteSourceChildrenOlderThanCapped(
    db,
    `DELETE FROM telegram_alert_job_targets
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
    replayCutoff,
    signal,
    HIGH_VOLUME_RETENTION_DELETE_LIMIT,
  );
  throwIfAborted(signal);

  const targetPlans = await deleteSourceChildrenOlderThanCapped(
    db,
    `DELETE FROM telegram_alert_target_plans
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
    replayCutoff,
    signal,
    HIGH_VOLUME_RETENTION_DELETE_LIMIT,
  );
  throwIfAborted(signal);

  const replayJobs = await deleteSourceChildrenOlderThanCapped(
    db,
    `DELETE FROM telegram_alert_jobs
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
    replayCutoff,
    signal,
  );
  throwIfAborted(signal);

  const replaySourceResolutionTargets = await deleteSourceChildrenOlderThanCapped(
    db,
    `DELETE FROM telegram_alert_source_resolution_targets
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
    replayCutoff,
    signal,
  );
  throwIfAborted(signal);

  const replaySourceResolutionMemberships = await deleteSourceChildrenOlderThanCapped(
    db,
    `DELETE FROM telegram_alert_source_resolution_memberships
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
    replayCutoff,
    signal,
  );
  throwIfAborted(signal);

  const replaySourceResolutionPages = await deleteSourceChildrenOlderThanCapped(
    db,
    `DELETE FROM telegram_alert_source_resolution_pages
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
    replayCutoff,
    signal,
  );
  throwIfAborted(signal);

  const replaySourceEvents = await deleteOlderThanCapped(
    db,
    `DELETE FROM telegram_alert_source_events
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
    replayCutoff,
    signal,
  );
  throwIfAborted(signal);

  const deadLetters = await deleteOlderThanCapped(
    db,
    "DELETE FROM telegram_alert_dead_letters WHERE expired_at < ? AND id IN (SELECT id FROM telegram_alert_dead_letters WHERE expired_at < ? ORDER BY expired_at ASC, id ASC LIMIT ?)",
    alertAuditCutoff,
    signal,
  );
  throwIfAborted(signal);

  const auditJobTargetItems = await deleteOlderThanCapped(
    db,
    "DELETE FROM telegram_alert_job_target_items WHERE created_at < ? AND rowid IN (SELECT rowid FROM telegram_alert_job_target_items WHERE created_at < ? ORDER BY created_at ASC, rowid ASC LIMIT ?)",
    alertAuditCutoff,
    signal,
    HIGH_VOLUME_RETENTION_DELETE_LIMIT,
  );
  throwIfAborted(signal);

  const auditJobTargets = await deleteOlderThanCapped(
    db,
    "DELETE FROM telegram_alert_job_targets WHERE created_at < ? AND rowid IN (SELECT rowid FROM telegram_alert_job_targets WHERE created_at < ? ORDER BY created_at ASC, rowid ASC LIMIT ?)",
    alertAuditCutoff,
    signal,
    HIGH_VOLUME_RETENTION_DELETE_LIMIT,
  );
  throwIfAborted(signal);

  const auditJobs = await deleteOlderThanCapped(
    db,
    "DELETE FROM telegram_alert_jobs WHERE created_at < ? AND rowid IN (SELECT rowid FROM telegram_alert_jobs WHERE created_at < ? ORDER BY created_at ASC, rowid ASC LIMIT ?)",
    alertAuditCutoff,
    signal,
  );
  throwIfAborted(signal);

  const auditSourceResolutionTargets = await deleteOlderThanCapped(
    db,
    "DELETE FROM telegram_alert_source_resolution_targets WHERE created_at < ? AND rowid IN (SELECT rowid FROM telegram_alert_source_resolution_targets WHERE created_at < ? ORDER BY created_at ASC, rowid ASC LIMIT ?)",
    alertAuditCutoff,
    signal,
  );
  throwIfAborted(signal);

  const auditSourceResolutionMemberships = await deleteOlderThanCapped(
    db,
    "DELETE FROM telegram_alert_source_resolution_memberships WHERE created_at < ? AND rowid IN (SELECT rowid FROM telegram_alert_source_resolution_memberships WHERE created_at < ? ORDER BY created_at ASC, rowid ASC LIMIT ?)",
    alertAuditCutoff,
    signal,
  );
  throwIfAborted(signal);

  const auditSourceResolutionPages = await deleteOlderThanCapped(
    db,
    "DELETE FROM telegram_alert_source_resolution_pages WHERE created_at < ? AND rowid IN (SELECT rowid FROM telegram_alert_source_resolution_pages WHERE created_at < ? ORDER BY created_at ASC, rowid ASC LIMIT ?)",
    alertAuditCutoff,
    signal,
  );
  throwIfAborted(signal);

  const freezeTargets = await deleteOlderThanCapped(
    db,
    "DELETE FROM telegram_freeze_alert_targets WHERE created_at < ? AND rowid IN (SELECT rowid FROM telegram_freeze_alert_targets WHERE created_at < ? ORDER BY created_at ASC, rowid ASC LIMIT ?)",
    alertAuditCutoff,
    signal,
  );
  throwIfAborted(signal);

  const freezeEvents = await deleteOlderThanCapped(
    db,
    "DELETE FROM telegram_freeze_alert_events WHERE detected_at < ? AND rowid IN (SELECT rowid FROM telegram_freeze_alert_events WHERE detected_at < ? ORDER BY detected_at ASC, rowid ASC LIMIT ?)",
    alertAuditCutoff,
    signal,
  );
  throwIfAborted(signal);

  const auditSourceEvents = await deleteOlderThanCapped(
    db,
    `DELETE FROM telegram_alert_source_events
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
    alertAuditCutoff,
    signal,
  );
  throwIfAborted(signal);

  const jobTargetItems = {
    pruned: replayJobTargetItems.pruned + auditJobTargetItems.pruned,
    cappedAtLimit: replayJobTargetItems.cappedAtLimit || auditJobTargetItems.cappedAtLimit,
  };
  const jobTargets = {
    pruned: replayJobTargets.pruned + auditJobTargets.pruned,
    cappedAtLimit: replayJobTargets.cappedAtLimit || auditJobTargets.cappedAtLimit,
  };
  const jobs = {
    pruned: replayJobs.pruned + auditJobs.pruned,
    cappedAtLimit: replayJobs.cappedAtLimit || auditJobs.cappedAtLimit,
  };
  const sourceResolutionTargets = {
    pruned: replaySourceResolutionTargets.pruned + auditSourceResolutionTargets.pruned,
    cappedAtLimit: replaySourceResolutionTargets.cappedAtLimit || auditSourceResolutionTargets.cappedAtLimit,
  };
  const sourceResolutionMemberships = {
    pruned: replaySourceResolutionMemberships.pruned + auditSourceResolutionMemberships.pruned,
    cappedAtLimit: replaySourceResolutionMemberships.cappedAtLimit || auditSourceResolutionMemberships.cappedAtLimit,
  };
  const sourceResolutionPages = {
    pruned: replaySourceResolutionPages.pruned + auditSourceResolutionPages.pruned,
    cappedAtLimit: replaySourceResolutionPages.cappedAtLimit || auditSourceResolutionPages.cappedAtLimit,
  };
  const sourceEvents = {
    pruned: replaySourceEvents.pruned + auditSourceEvents.pruned,
    cappedAtLimit: replaySourceEvents.cappedAtLimit || auditSourceEvents.cappedAtLimit,
  };

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

  const adoptionDaily = await deleteOlderThanCapped(
    db,
    "DELETE FROM telegram_adoption_daily WHERE day < ? AND rowid IN (SELECT rowid FROM telegram_adoption_daily WHERE day < ? ORDER BY day ASC, rowid ASC LIMIT ?)",
    cutoffDayString,
    signal,
  );
  throwIfAborted(signal);

  const adoptionRetention = await deleteOlderThanCapped(
    db,
    "DELETE FROM telegram_adoption_retention_daily WHERE measurement_day < ? AND rowid IN (SELECT rowid FROM telegram_adoption_retention_daily WHERE measurement_day < ? ORDER BY measurement_day ASC, rowid ASC LIMIT ?)",
    cutoffDayString,
    signal,
  );
  throwIfAborted(signal);

  const adoptionIngressQuota = await deleteOlderThanCapped(
    db,
    "DELETE FROM telegram_adoption_ingress_quota WHERE updated_at < ? AND rowid IN (SELECT rowid FROM telegram_adoption_ingress_quota WHERE updated_at < ? ORDER BY updated_at ASC, rowid ASC LIMIT ?)",
    nowSec - 2 * DAY_SEC,
    signal,
  );
  throwIfAborted(signal);

  const adoptionClientQuota = await deleteOlderThanCapped(
    db,
    "DELETE FROM telegram_adoption_client_quota WHERE updated_at < ? AND rowid IN (SELECT rowid FROM telegram_adoption_client_quota WHERE updated_at < ? ORDER BY updated_at ASC, rowid ASC LIMIT ?)",
    nowSec - 2 * DAY_SEC,
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

  const miniAppAdoptionSessionCache = await deleteCachePrefixOlderThanCapped(
    db,
    TELEGRAM_ADOPTION_SESSION_CACHE_PREFIX,
    nowSec - TELEGRAM_ADOPTION_SESSION_TTL_SEC,
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
    recapTargets.deletedTargets +
    highGrowthRetention.legacyTargetItemsPruned +
    highGrowthRetention.legacyTargetsPruned +
    highGrowthRetention.legacyTerminalJobsPruned +
    highGrowthRetention.staleUnresolvedJobsPruned +
    highGrowthRetention.staleUnresolvedSourcesPruned +
    targetPlanItems.pruned +
    targetPlans.pruned +
    targetPlanPages.pruned +
    planningSubscribers.pruned +
    targetExpiryProgress.pruned +
    deadLetters.pruned +
    jobTargetItems.pruned +
    jobTargets.pruned +
    jobs.pruned +
    sourceResolutionTargets.pruned +
    sourceResolutionMemberships.pruned +
    sourceResolutionPages.pruned +
    sourceEvents.pruned +
    freezeTargets.pruned +
    freezeEvents.pruned +
    usageDaily.pruned +
    watcherLifecycle.pruned +
    adoptionDaily.pruned +
    adoptionRetention.pruned +
    adoptionIngressQuota.pruned +
    adoptionClientQuota.pruned +
    diagnostics.pruned +
    commandCooldownCache.pruned +
    miniAppMutationBurstCache.pruned +
    miniAppAdoptionSessionCache.pruned +
    commandFloodCache.pruned +
    chatMemberCache.pruned +
    chatAdminsCache.pruned +
    groupWelcomeCache.pruned +
    reEngagementWarningCache.pruned;
  const retentionDeleteCapped =
    highGrowthRetention.cappedAtLimit ||
    targetPlanItems.cappedAtLimit ||
    targetPlans.cappedAtLimit ||
    planningSubscribers.cappedAtLimit ||
    jobTargetItems.cappedAtLimit ||
    jobTargets.cappedAtLimit;

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
      targetPlanItemsPruned: targetPlanItems.pruned,
      targetPlansPruned: targetPlans.pruned,
      targetPlanPagesPruned: targetPlanPages.pruned,
      planningSubscribersPruned: planningSubscribers.pruned,
      targetExpiryProgressPruned: targetExpiryProgress.pruned,
      replayJobTargetItemsPruned: replayJobTargetItems.pruned,
      replayJobTargetsPruned: replayJobTargets.pruned,
      replayJobsPruned: replayJobs.pruned,
      replaySourceEventsPruned: replaySourceEvents.pruned,
      deadLettersPruned: deadLetters.pruned,
      jobTargetItemsPruned: jobTargetItems.pruned,
      jobTargetsPruned: jobTargets.pruned,
      jobsPruned: jobs.pruned,
      sourceResolutionTargetsPruned: sourceResolutionTargets.pruned,
      sourceResolutionMembershipsPruned: sourceResolutionMemberships.pruned,
      sourceResolutionPagesPruned: sourceResolutionPages.pruned,
      sourceEventsPruned: sourceEvents.pruned,
      freezeTargetsPruned: freezeTargets.pruned,
      freezeEventsPruned: freezeEvents.pruned,
      usageDailyPruned: usageDaily.pruned,
      watcherLifecyclePruned: watcherLifecycle.pruned,
      adoptionDailyPruned: adoptionDaily.pruned,
      adoptionRetentionPruned: adoptionRetention.pruned,
      adoptionIngressQuotaPruned: adoptionIngressQuota.pruned,
      adoptionClientQuotaPruned: adoptionClientQuota.pruned,
      diagnosticsPruned: diagnostics.pruned,
      commandCooldownCachePruned: commandCooldownCache.pruned,
      miniAppMutationBurstCachePruned: miniAppMutationBurstCache.pruned,
      miniAppAdoptionSessionCachePruned: miniAppAdoptionSessionCache.pruned,
      commandFloodCachePruned: commandFloodCache.pruned,
      chatMemberCachePruned: chatMemberCache.pruned,
      chatAdminsCachePruned: chatAdminsCache.pruned,
      groupWelcomeCachePruned: groupWelcomeCache.pruned,
      reEngagementWarningCachePruned: reEngagementWarningCache.pruned,
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
        targetPlanItems: targetPlanItems.cappedAtLimit,
        targetPlans: targetPlans.cappedAtLimit,
        targetPlanPages: targetPlanPages.cappedAtLimit,
        planningSubscribers: planningSubscribers.cappedAtLimit,
        targetExpiryProgress: targetExpiryProgress.cappedAtLimit,
        deadLetters: deadLetters.cappedAtLimit,
        jobTargetItems: jobTargetItems.cappedAtLimit,
        jobTargets: jobTargets.cappedAtLimit,
        jobs: jobs.cappedAtLimit,
        sourceResolutionTargets: sourceResolutionTargets.cappedAtLimit,
        sourceResolutionMemberships: sourceResolutionMemberships.cappedAtLimit,
        sourceResolutionPages: sourceResolutionPages.cappedAtLimit,
        sourceEvents: sourceEvents.cappedAtLimit,
        freezeTargets: freezeTargets.cappedAtLimit,
        freezeEvents: freezeEvents.cappedAtLimit,
        usageDaily: usageDaily.cappedAtLimit,
        watcherLifecycle: watcherLifecycle.cappedAtLimit,
        adoptionDaily: adoptionDaily.cappedAtLimit,
        adoptionRetention: adoptionRetention.cappedAtLimit,
        adoptionIngressQuota: adoptionIngressQuota.cappedAtLimit,
        adoptionClientQuota: adoptionClientQuota.cappedAtLimit,
        diagnostics: diagnostics.cappedAtLimit,
        commandCooldownCache: commandCooldownCache.cappedAtLimit,
        miniAppMutationBurstCache: miniAppMutationBurstCache.cappedAtLimit,
        miniAppAdoptionSessionCache: miniAppAdoptionSessionCache.cappedAtLimit,
        commandFloodCache: commandFloodCache.cappedAtLimit,
        chatMemberCache: chatMemberCache.cappedAtLimit,
        chatAdminsCache: chatAdminsCache.cappedAtLimit,
        groupWelcomeCache: groupWelcomeCache.cappedAtLimit,
        reEngagementWarningCache: reEngagementWarningCache.cappedAtLimit,
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
