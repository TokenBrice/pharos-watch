import { rethrowIfAborted, throwIfAborted } from "../lib/abort";
import type { CronResult } from "../lib/cron-logger";
import { createCronResult } from "../lib/cron-result";
import { runWithOverloadRetry } from "../lib/d1-overload-retry";
import { toErrorMessage } from "@shared/lib/error-utils";
import { type CappedDeleteResult, deleteCapped } from "./shared/capped-delete";
import {
  TELEGRAM_PROCESSED_UPDATE_PRUNE_LIMIT,
  countTelegramProcessedUpdateBacklog,
  pruneTelegramProcessedUpdates,
  type TelegramProcessedUpdateBacklog,
} from "../lib/telegram/processed-updates";
import { reconcileExpiredTelegramAlertJobTargets } from "./telegram-alert-target-status";
import { pruneTelegramRecapTargets } from "../lib/telegram/recap-store";
import {
  TELEGRAM_ADOPTION_SESSION_CACHE_PREFIX,
  TELEGRAM_ADOPTION_SESSION_TTL_SEC,
} from "../lib/telegram/adoption-analytics";

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

const SOURCE_EVENT_CHILD_TABLES = [
  "telegram_alert_target_plan_items",
  "telegram_alert_target_plans",
  "telegram_alert_target_plan_pages",
  "telegram_alert_planning_subscribers",
  "telegram_alert_target_expiry_progress",
  "telegram_alert_source_resolution_targets",
  "telegram_alert_source_resolution_memberships",
  "telegram_alert_source_resolution_pages",
  "telegram_alert_job_target_items",
  "telegram_alert_job_targets",
  "telegram_alert_jobs",
  "telegram_freeze_alert_targets",
  "telegram_freeze_alert_events",
] as const;

const AUTHORITATIVE_TARGET_REPLAY_ELIGIBILITY_SQL = `AND target.final_delivery_state IN ('accepted', 'failed', 'cancelled', 'expired')
AND target.effect_state NOT IN ('claimed', 'sending', 'execution_unknown')
AND NOT EXISTS (
  SELECT 1 FROM telegram_pending_alerts pending
   WHERE pending.dedupe_key = target.pending_dedupe_key
     AND pending.delivery_state IN ('pending', 'sending', 'execution_unknown')
)`;

function indentSqlFragment(sql: string, spaces: number): string {
  const indent = " ".repeat(spaces);
  return sql.split("\n").map((line) => `${indent}${line}`).join("\n");
}

function buildSourceEventChildAbsenceSql(includeQueueEvidence = false): string {
  const tables: readonly string[] = includeQueueEvidence
    ? [
        ...SOURCE_EVENT_CHILD_TABLES.slice(0, -2),
        "telegram_pending_alerts",
        "telegram_alert_dead_letters",
        ...SOURCE_EVENT_CHILD_TABLES.slice(-2),
      ]
    : SOURCE_EVENT_CHILD_TABLES;
  return tables
    .map((table) => `AND NOT EXISTS (SELECT 1 FROM ${table} child WHERE child.source_event_id = source.source_event_id)`)
    .join("\n");
}

const SOURCE_EVENT_CHILD_ABSENCE_SQL = buildSourceEventChildAbsenceSql();

type OrphanJobStatuses = readonly ["sent", "expired"] | readonly ["discovered", "queued"];

function buildOrphanJobDeleteSql(statuses: OrphanJobStatuses): string {
  const terminal = statuses[0] === "sent";
  const reportName = terminal ? "legacy-terminal-jobs-retention" : "stale-unresolved-jobs-retention";
  return `/* pharos:telegram:${reportName} */
       DELETE FROM telegram_alert_jobs
        WHERE created_at < ?
          AND job_id IN (
            SELECT job.job_id
              FROM telegram_alert_jobs job
             WHERE job.created_at < ?
               AND job.status IN (${statuses.map((status) => `'${status}'`).join(", ")})
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
      )`;
}

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
      buildOrphanJobDeleteSql(["sent", "expired"]),
      terminalCutoff,
      { signal, totalLimit: highGrowthDeleteLimit },
    );
    result.legacyTerminalJobsPruned = legacyTerminalJobs.pruned;
    result.cappedAtLimit ||= legacyTerminalJobs.cappedAtLimit;
    throwIfAborted(signal);

    const staleUnresolvedJobs = await deleteOlderThanCapped(
      db,
      buildOrphanJobDeleteSql(["discovered", "queued"]),
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
${indentSqlFragment(buildSourceEventChildAbsenceSql(true), 21)}
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

// SAFETY: These closed `as const` tuples are the only source of interpolated SQL
// identifiers/fragments below, so builder callers cannot provide arbitrary SQL.
const SIMPLE_RETENTION_TABLES = ["telegram_alert_job_target_items", "telegram_alert_job_targets", "telegram_alert_jobs", "telegram_alert_source_resolution_targets", "telegram_alert_source_resolution_memberships", "telegram_alert_source_resolution_pages", "telegram_freeze_alert_targets", "telegram_freeze_alert_events", "telegram_usage_daily", "telegram_watcher_lifecycle_daily", "telegram_adoption_daily", "telegram_adoption_retention_daily", "telegram_adoption_ingress_quota", "telegram_adoption_client_quota", "telegram_chat_delivery_diagnostics"] as const;
const SIMPLE_RETENTION_COLUMNS = ["created_at", "detected_at", "day", "measurement_day", "updated_at"] as const;
const SOURCE_CHILD_RETENTION_TABLES = ["telegram_alert_target_plan_items", "telegram_alert_target_plan_pages", "telegram_alert_planning_subscribers", "telegram_alert_target_expiry_progress", "telegram_alert_source_resolution_targets", "telegram_alert_source_resolution_memberships", "telegram_alert_source_resolution_pages"] as const;
const SOURCE_CHILD_RETENTION_PREDICATES = ["child.state = 'complete'"] as const;

type TelegramRetentionDeleteOptions = {
  name: string;
  cutoff: number | string;
  totalLimit?: number;
  countsTowardRunBudget?: boolean;
  report?: TelegramRetentionReportDescriptor;
};

function makeSimpleRetentionDeleteStep(
  {
    name, table, timestampColumn, cutoff, totalLimit, countsTowardRunBudget, report,
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
    sql: `DELETE FROM ${table} WHERE ${timestampColumn} < ? AND rowid IN (SELECT rowid FROM ${table} WHERE ${timestampColumn} < ? ORDER BY ${timestampColumn} ASC, rowid ASC LIMIT ?)`,
    cutoff,
    cutoffBindCount: 2,
    totalLimit,
    countsTowardRunBudget,
    report,
  };
}

function makeSourceChildRetentionDeleteStep(
  {
    name, table, cutoff, childPredicate, totalLimit, countsTowardRunBudget, report,
  }: TelegramRetentionDeleteOptions & {
    table: (typeof SOURCE_CHILD_RETENTION_TABLES)[number];
    childPredicate?: (typeof SOURCE_CHILD_RETENTION_PREDICATES)[number];
  },
): TelegramRetentionDeleteStep {
  if (!SOURCE_CHILD_RETENTION_TABLES.includes(table)) throw new Error(`Unsupported Telegram retention table: ${table}`);
  if (childPredicate && !SOURCE_CHILD_RETENTION_PREDICATES.includes(childPredicate)) {
    throw new Error(`Unsupported Telegram retention child predicate: ${childPredicate}`);
  }
  return {
    name,
    sql: `DELETE FROM ${table}
      WHERE rowid IN (
        SELECT child.rowid
          FROM telegram_alert_source_events source
          JOIN ${table} child
            ON child.source_event_id = source.source_event_id
         WHERE source.completed_at < ?
           AND source.status IN ('complete', 'expired')${childPredicate ? `\n           AND ${childPredicate}` : ""}
         ORDER BY source.completed_at ASC, source.source_event_id ASC, child.rowid ASC
         LIMIT ?
      )`,
    cutoff,
    cutoffBindCount: 1,
    totalLimit,
    countsTowardRunBudget,
    report,
  };
}

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
    makeSourceChildRetentionDeleteStep({
      name: "targetPlanItems", table: "telegram_alert_target_plan_items", cutoff: workflowCutoff,
      totalLimit: HIGH_VOLUME_RETENTION_DELETE_LIMIT, countsTowardRunBudget: true,
    }),
    makeSourceChildRetentionDeleteStep({
      name: "targetPlanPages", table: "telegram_alert_target_plan_pages", cutoff: workflowCutoff,
    }),
    makeSourceChildRetentionDeleteStep({
      name: "planningSubscribers", table: "telegram_alert_planning_subscribers", cutoff: workflowCutoff,
      totalLimit: HIGH_VOLUME_RETENTION_DELETE_LIMIT, countsTowardRunBudget: true,
    }),
    makeSourceChildRetentionDeleteStep({
      name: "targetExpiryProgress", table: "telegram_alert_target_expiry_progress", cutoff: workflowCutoff,
      childPredicate: "child.state = 'complete'",
    }),
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
${indentSqlFragment(AUTHORITATIVE_TARGET_REPLAY_ELIGIBILITY_SQL, 11)}
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
${indentSqlFragment(AUTHORITATIVE_TARGET_REPLAY_ELIGIBILITY_SQL, 11)}
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
    makeSourceChildRetentionDeleteStep({
      name: "replaySourceResolutionTargets", table: "telegram_alert_source_resolution_targets", cutoff: replayCutoff,
      report: { flat: false, capped: false, group: "sourceResolutionTargets" },
    }),
    makeSourceChildRetentionDeleteStep({
      name: "replaySourceResolutionMemberships", table: "telegram_alert_source_resolution_memberships", cutoff: replayCutoff,
      report: { flat: false, capped: false, group: "sourceResolutionMemberships" },
    }),
    makeSourceChildRetentionDeleteStep({
      name: "replaySourceResolutionPages", table: "telegram_alert_source_resolution_pages", cutoff: replayCutoff,
      report: { flat: false, capped: false, group: "sourceResolutionPages" },
    }),
    {
      name: "replaySourceEvents",
      sql: `DELETE FROM telegram_alert_source_events
      WHERE completed_at < ?
        AND rowid IN (
          SELECT source.rowid
            FROM telegram_alert_source_events source
           WHERE source.completed_at < ?
             AND source.status IN ('complete', 'expired')
${indentSqlFragment(SOURCE_EVENT_CHILD_ABSENCE_SQL, 13)}
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
    makeSimpleRetentionDeleteStep({ name: "auditJobTargetItems", table: "telegram_alert_job_target_items", timestampColumn: "created_at", cutoff: alertAuditCutoff, totalLimit: HIGH_VOLUME_RETENTION_DELETE_LIMIT, countsTowardRunBudget: true, report: { flat: false, capped: false, group: "jobTargetItems" } }),
    makeSimpleRetentionDeleteStep({ name: "auditJobTargets", table: "telegram_alert_job_targets", timestampColumn: "created_at", cutoff: alertAuditCutoff, totalLimit: HIGH_VOLUME_RETENTION_DELETE_LIMIT, countsTowardRunBudget: true, report: { flat: false, capped: false, group: "jobTargets" } }),
    makeSimpleRetentionDeleteStep({ name: "auditJobs", table: "telegram_alert_jobs", timestampColumn: "created_at", cutoff: alertAuditCutoff, report: { flat: false, capped: false, group: "jobs" } }),
    makeSimpleRetentionDeleteStep({ name: "auditSourceResolutionTargets", table: "telegram_alert_source_resolution_targets", timestampColumn: "created_at", cutoff: alertAuditCutoff, report: { flat: false, capped: false, group: "sourceResolutionTargets" } }),
    makeSimpleRetentionDeleteStep({ name: "auditSourceResolutionMemberships", table: "telegram_alert_source_resolution_memberships", timestampColumn: "created_at", cutoff: alertAuditCutoff, report: { flat: false, capped: false, group: "sourceResolutionMemberships" } }),
    makeSimpleRetentionDeleteStep({ name: "auditSourceResolutionPages", table: "telegram_alert_source_resolution_pages", timestampColumn: "created_at", cutoff: alertAuditCutoff, report: { flat: false, capped: false, group: "sourceResolutionPages" } }),
    makeSimpleRetentionDeleteStep({ name: "freezeTargets", table: "telegram_freeze_alert_targets", timestampColumn: "created_at", cutoff: alertAuditCutoff }),
    makeSimpleRetentionDeleteStep({ name: "freezeEvents", table: "telegram_freeze_alert_events", timestampColumn: "detected_at", cutoff: alertAuditCutoff }),
    {
      name: "auditSourceEvents",
      sql: `DELETE FROM telegram_alert_source_events
      WHERE detected_at < ?
        AND rowid IN (
          SELECT source.rowid
            FROM telegram_alert_source_events source
           WHERE source.detected_at < ?
             AND source.status IN ('complete', 'expired')
${indentSqlFragment(SOURCE_EVENT_CHILD_ABSENCE_SQL, 13)}
           ORDER BY source.detected_at ASC, source.rowid ASC
           LIMIT ?
        )`,
      cutoff: alertAuditCutoff,
      cutoffBindCount: 2,
      report: { flat: false, capped: false, group: "sourceEvents" },
    },
    makeSimpleRetentionDeleteStep({ name: "usageDaily", table: "telegram_usage_daily", timestampColumn: "day", cutoff: cutoffDayString }),
    makeSimpleRetentionDeleteStep({ name: "watcherLifecycle", table: "telegram_watcher_lifecycle_daily", timestampColumn: "day", cutoff: cutoffDayString }),
    makeSimpleRetentionDeleteStep({ name: "adoptionDaily", table: "telegram_adoption_daily", timestampColumn: "day", cutoff: cutoffDayString }),
    makeSimpleRetentionDeleteStep({ name: "adoptionRetention", table: "telegram_adoption_retention_daily", timestampColumn: "measurement_day", cutoff: cutoffDayString }),
    makeSimpleRetentionDeleteStep({ name: "adoptionIngressQuota", table: "telegram_adoption_ingress_quota", timestampColumn: "updated_at", cutoff: nowSec - 2 * DAY_SEC }),
    makeSimpleRetentionDeleteStep({ name: "adoptionClientQuota", table: "telegram_adoption_client_quota", timestampColumn: "updated_at", cutoff: nowSec - 2 * DAY_SEC }),
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
