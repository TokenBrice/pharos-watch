import type { TelegramAlertType } from "@shared/types/status";
import { executeAtomicBatch } from "../../lib/db";
import { PENDING_TTL_SEC } from "../../lib/telegram-constants";
import { parseTelegramTargetPlan } from "../telegram-alert-target-plan-contract";
import { reconcileTelegramAlertJobCounters } from "../telegram-alert-job-target-outcomes";
import {
  buildPendingAlertUpsertSql,
  pendingPrioritySql,
} from "../telegram-pending/upsert-sql";
import { markTelegramTargetPlanDegraded } from "./source-state";
import {
  TELEGRAM_TARGET_PLAN_CLAIM_TTL_SEC,
  TELEGRAM_TARGET_PLAN_ENQUEUE_PAGE_SIZE,
  type TelegramTargetPlanningClaim,
} from "./types";

interface PersistedPlanRow {
  source_event_id: string;
  plan_generation: number;
  plan_key: string;
  plan_ordinal: number;
  plan_payload_json: string;
  plan_payload_digest: string;
}

export interface ReadyTargetRow extends PersistedPlanRow {
  job_id: string;
  target_key: string;
  target_ordinal: number;
  chat_id: string;
  chunk_index: number;
  alert_type: TelegramAlertType;
  message_html: string;
  disable_notification: number;
  alert_scope_json: string;
  preference_generation: number;
  markup_policy_json: string;
  target_expires_at: number;
}

interface TargetHandoffStateRow {
  status: string;
  final_delivery_state: string | null;
  cancellation_reason: string | null;
}

const PRIOR_TERMINAL_DEDUPE_REASONS = [
  "duplicate_prior_delivery",
  "duplicate_prior_execution_unknown",
] as const;

async function suppressPriorTerminalDedupeCollisions(
  db: D1Database,
  sourceEventId: string,
  generation: number,
  nowSec: number,
  targetKeys: readonly string[],
): Promise<number> {
  if (targetKeys.length === 0) return 0;
  const result = await db
    .prepare(
      `UPDATE telegram_alert_job_targets
          SET status = 'expired',
              cancelled_at = COALESCE(cancelled_at, ?),
              cancellation_reason = COALESCE(
                cancellation_reason,
                CASE (
                  SELECT pending.delivery_state
                    FROM telegram_pending_alerts pending
                   WHERE pending.dedupe_key = telegram_alert_job_targets.pending_dedupe_key
                     AND pending.source_event_id IS NOT telegram_alert_job_targets.source_event_id
                     AND pending.chat_id = telegram_alert_job_targets.chat_id
                     AND pending.message_html = telegram_alert_job_targets.message_html
                     AND COALESCE(pending.chunk_index, 0) = telegram_alert_job_targets.chunk_index
                     AND COALESCE(pending.alert_type, '') = telegram_alert_job_targets.alert_type
                     AND COALESCE(pending.markup_policy_json, '') = telegram_alert_job_targets.markup_policy_json
                     AND pending.delivery_state IN ('sent', 'execution_unknown')
                   LIMIT 1
                )
                  WHEN 'sent' THEN 'duplicate_prior_delivery'
                  ELSE 'duplicate_prior_execution_unknown'
                END
              ),
              final_delivery_state = 'cancelled',
              final_delivery_at = COALESCE(final_delivery_at, ?),
              final_delivery_error = COALESCE(
                final_delivery_error,
                CASE (
                  SELECT pending.delivery_state
                    FROM telegram_pending_alerts pending
                   WHERE pending.dedupe_key = telegram_alert_job_targets.pending_dedupe_key
                     AND pending.source_event_id IS NOT telegram_alert_job_targets.source_event_id
                     AND pending.chat_id = telegram_alert_job_targets.chat_id
                     AND pending.message_html = telegram_alert_job_targets.message_html
                     AND COALESCE(pending.chunk_index, 0) = telegram_alert_job_targets.chunk_index
                     AND COALESCE(pending.alert_type, '') = telegram_alert_job_targets.alert_type
                     AND COALESCE(pending.markup_policy_json, '') = telegram_alert_job_targets.markup_policy_json
                     AND pending.delivery_state IN ('sent', 'execution_unknown')
                   LIMIT 1
                )
                  WHEN 'sent' THEN 'duplicate_prior_delivery'
                  ELSE 'duplicate_prior_execution_unknown'
                END
              ),
              error_class = COALESCE(
                error_class,
                CASE (
                  SELECT pending.delivery_state
                    FROM telegram_pending_alerts pending
                   WHERE pending.dedupe_key = telegram_alert_job_targets.pending_dedupe_key
                     AND pending.source_event_id IS NOT telegram_alert_job_targets.source_event_id
                     AND pending.chat_id = telegram_alert_job_targets.chat_id
                     AND pending.message_html = telegram_alert_job_targets.message_html
                     AND COALESCE(pending.chunk_index, 0) = telegram_alert_job_targets.chunk_index
                     AND COALESCE(pending.alert_type, '') = telegram_alert_job_targets.alert_type
                     AND COALESCE(pending.markup_policy_json, '') = telegram_alert_job_targets.markup_policy_json
                     AND pending.delivery_state IN ('sent', 'execution_unknown')
                   LIMIT 1
                )
                  WHEN 'sent' THEN 'duplicate_prior_delivery'
                  ELSE 'duplicate_prior_execution_unknown'
                END
              )
        WHERE source_event_id = ? AND plan_generation = ? AND status = 'planned'
          AND target_key IN (SELECT value FROM json_each(?))
          AND final_delivery_state IS NULL
          AND EXISTS (
            SELECT 1 FROM telegram_pending_alerts pending
             WHERE pending.dedupe_key = telegram_alert_job_targets.pending_dedupe_key
               AND pending.source_event_id IS NOT telegram_alert_job_targets.source_event_id
               AND pending.chat_id = telegram_alert_job_targets.chat_id
               AND pending.message_html = telegram_alert_job_targets.message_html
               AND COALESCE(pending.chunk_index, 0) = telegram_alert_job_targets.chunk_index
               AND COALESCE(pending.alert_type, '') = telegram_alert_job_targets.alert_type
               AND COALESCE(pending.markup_policy_json, '') = telegram_alert_job_targets.markup_policy_json
               AND pending.delivery_state IN ('sent', 'execution_unknown')
          )`,
    )
    .bind(nowSec, nowSec, sourceEventId, generation, JSON.stringify(targetKeys))
    .run();
  return Number(result.meta?.changes ?? 0);
}

/** @internal Exposed so the pending-upsert SQL pin test can read the emitted statements. */
export function buildSetBasedPendingHandoffStatements(
  db: D1Database,
  sourceEventId: string,
  generation: number,
  nowSec: number,
  targetKeys: readonly string[],
): D1PreparedStatement[] {
  const targetKeysJson = JSON.stringify(targetKeys);
  return [
    db
      .prepare(
        buildPendingAlertUpsertSql(
          `SELECT target.chat_id, target.message_html, target.disable_notification,
                ?, NULL, NULL, NULL, ?, target.pending_dedupe_key,
                target.chunk_index, ${pendingPrioritySql("target.alert_type")}, 'risk_alert',
                target.alert_type, target.target_expires_at, target.source_event_id,
                target.alert_scope_json, target.preference_generation,
                target.markup_policy_json
           FROM telegram_alert_job_targets target
          WHERE target.source_event_id = ? AND target.plan_generation = ?
            AND target.status = 'planned'
            AND target.target_key IN (SELECT value FROM json_each(?))`,
        ),
      )
      .bind(nowSec, nowSec, sourceEventId, generation, targetKeysJson),
    db
      .prepare(
        `UPDATE telegram_pending_alerts AS pending
            SET not_before_at = CASE
              WHEN pending.not_before_at IS NULL THEN (
                SELECT MAX(existing.not_before_at)
                  FROM telegram_pending_alerts existing
                 WHERE existing.chat_id = pending.chat_id
                   AND existing.id <> pending.id
                   AND existing.delivery_state = 'pending'
                   AND COALESCE(existing.expires_at, existing.created_at + ?) > ?
                   AND existing.not_before_at > ?
              )
              ELSE MAX(pending.not_before_at, COALESCE((
                SELECT MAX(existing.not_before_at)
                  FROM telegram_pending_alerts existing
                 WHERE existing.chat_id = pending.chat_id
                   AND existing.id <> pending.id
                   AND existing.delivery_state = 'pending'
                   AND COALESCE(existing.expires_at, existing.created_at + ?) > ?
                   AND existing.not_before_at > ?
              ), pending.not_before_at))
            END
          WHERE pending.source_event_id = ?
            AND pending.dedupe_key IN (SELECT value FROM json_each(?))
            AND pending.delivery_state = 'pending'`,
      )
      .bind(
        PENDING_TTL_SEC,
        nowSec,
        nowSec,
        PENDING_TTL_SEC,
        nowSec,
        nowSec,
        sourceEventId,
        targetKeysJson,
      ),
    db
      .prepare(
        `UPDATE telegram_alert_job_targets
            SET status = 'queued', enqueued_at = COALESCE(enqueued_at, ?)
          WHERE source_event_id = ? AND plan_generation = ? AND status = 'planned'
            AND target_key IN (SELECT value FROM json_each(?))
            AND EXISTS (
              SELECT 1 FROM telegram_pending_alerts pending
               WHERE pending.dedupe_key = telegram_alert_job_targets.pending_dedupe_key
                 AND pending.source_event_id = telegram_alert_job_targets.source_event_id
                 AND pending.preference_generation = telegram_alert_job_targets.preference_generation
            )`,
      )
      .bind(nowSec, sourceEventId, generation, targetKeysJson),
  ];
}

export async function expireTelegramAuthoritativeTargets(
  db: D1Database,
  sourceEventId: string,
  generation: number,
  nowSec: number,
  limit = 90,
): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(90, Math.floor(limit)));
  const result = await db
    .prepare(
      `UPDATE telegram_alert_job_targets
          SET status = 'expired',
              final_delivery_state = 'expired',
              final_delivery_at = COALESCE(final_delivery_at, ?),
              final_delivery_error = COALESCE(final_delivery_error, 'target_expired_before_enqueue'),
              error_class = COALESCE(error_class, 'target_expired_before_enqueue')
        WHERE rowid IN (
          SELECT rowid FROM telegram_alert_job_targets
           WHERE source_event_id = ? AND plan_generation = ?
             AND status = 'planned' AND target_expires_at <= ?
           ORDER BY plan_ordinal, target_ordinal, target_key
           LIMIT ?
        )`,
    )
    .bind(nowSec, sourceEventId, generation, nowSec, boundedLimit)
    .run();
  const expired = Number(result.meta?.changes ?? 0);
  if (expired > 0) {
    const jobs = await db
      .prepare("SELECT job_id FROM telegram_alert_jobs WHERE source_event_id = ?")
      .bind(sourceEventId)
      .all<{ job_id: string }>();
    await reconcileTelegramAlertJobCounters(db, (jobs.results ?? []).map((row) => row.job_id), nowSec);
  }
  return expired;
}

export async function finalizeTelegramTargetPlanning(
  db: D1Database,
  claim: TelegramTargetPlanningClaim,
  nowSec: number,
): Promise<{ planCount: number; targetCount: number }> {
  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM telegram_alert_planning_subscribers
           WHERE source_event_id = ? AND plan_generation = ?
             AND planning_outcome = 'pending') AS pending_subscribers,
         (SELECT COUNT(*) FROM telegram_alert_target_plan_pages
           WHERE source_event_id = ? AND plan_generation = ?
             AND status <> 'complete') AS pending_pages,
         (SELECT COUNT(*) FROM telegram_alert_target_plans
           WHERE source_event_id = ? AND plan_generation = ?
             AND status = 'materialized') AS plans,
         (SELECT COALESCE(SUM(expected_target_count), 0) FROM telegram_alert_target_plans
           WHERE source_event_id = ? AND plan_generation = ?) AS expected_targets,
         (SELECT COUNT(*) FROM telegram_alert_job_targets
           WHERE source_event_id = ? AND plan_generation = ?) AS targets`,
    )
    .bind(
      claim.sourceEventId,
      claim.generation,
      claim.sourceEventId,
      claim.generation,
      claim.sourceEventId,
      claim.generation,
      claim.sourceEventId,
      claim.generation,
      claim.sourceEventId,
      claim.generation,
    )
    .first<{
      pending_subscribers: number;
      pending_pages: number;
      plans: number;
      expected_targets: number;
      targets: number;
    }>();
  const pendingSubscribers = Number(counts?.pending_subscribers ?? -1);
  const pendingPages = Number(counts?.pending_pages ?? -1);
  const plans = Number(counts?.plans ?? -1);
  const expectedTargets = Number(counts?.expected_targets ?? -1);
  const targets = Number(counts?.targets ?? -1);
  if (pendingSubscribers !== 0 || pendingPages !== 0 || expectedTargets !== targets) {
    await markTelegramTargetPlanDegraded(db, claim, "target_plan_final_reconcile_failed", nowSec);
    throw new Error("Telegram target plan cannot become ready before exact reconciliation");
  }
  const result = await db
    .prepare(
      `UPDATE telegram_alert_source_events
          SET target_plan_state = 'ready', target_plan_count = ?,
              target_materialized_count = ?, target_plan_completed_at = ?,
              target_plan_claim_expires_at = ?
        WHERE source_event_id = ? AND target_plan_generation = ?
          AND target_plan_owner = ?
          AND target_plan_state IN ('planning', 'materializing')`,
    )
    .bind(
      plans,
      targets,
      nowSec,
      nowSec + TELEGRAM_TARGET_PLAN_CLAIM_TTL_SEC,
      claim.sourceEventId,
      claim.generation,
      claim.owner,
    )
    .run();
  if (Number(result.meta?.changes ?? 0) !== 1) {
    throw new Error("Telegram target plan ready CAS was not confirmed");
  }
  return { planCount: plans, targetCount: targets };
}

export async function openTelegramTargetPlanDelivery(
  db: D1Database,
  claim: TelegramTargetPlanningClaim,
  nowSec: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE telegram_alert_source_events
          SET target_plan_state = 'delivery_open', target_delivery_opened_at = ?,
              target_plan_claim_expires_at = NULL
        WHERE source_event_id = ? AND target_plan_generation = ?
          AND target_plan_owner = ? AND target_plan_state = 'ready'
          AND target_plan_count = (
            SELECT COUNT(*) FROM telegram_alert_target_plans plan
             WHERE plan.source_event_id = telegram_alert_source_events.source_event_id
               AND plan.plan_generation = telegram_alert_source_events.target_plan_generation
               AND plan.status = 'materialized'
          )
          AND target_materialized_count = (
            SELECT COUNT(*) FROM telegram_alert_job_targets target
             WHERE target.source_event_id = telegram_alert_source_events.source_event_id
               AND target.plan_generation = telegram_alert_source_events.target_plan_generation
          )`,
    )
    .bind(nowSec, claim.sourceEventId, claim.generation, claim.owner)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

function readyTargetMatchesPlan(
  row: ReadyTargetRow,
  plan: Awaited<ReturnType<typeof parseTelegramTargetPlan>>,
): boolean {
  if (plan.kind !== "ok") return false;
  const message = plan.value.messages.find((candidate) => candidate.targetKey === row.target_key);
  if (!message) return false;
  return (
    plan.value.sourceEventId === row.source_event_id &&
    plan.value.chatId === row.chat_id &&
    plan.value.alertType === row.alert_type &&
    plan.value.preferenceGeneration === Number(row.preference_generation) &&
    message.chunkIndex === Number(row.chunk_index) &&
    message.chunkIndex === Number(row.target_ordinal) &&
    message.html === row.message_html &&
    plan.value.disableNotification === (row.disable_notification === 1) &&
    plan.value.alertScopeJson === row.alert_scope_json &&
    message.markupPolicyJson === row.markup_policy_json &&
    plan.value.targetExpiresAt === Number(row.target_expires_at)
  );
}

export async function enqueueTelegramAuthoritativeTargets(
  db: D1Database,
  sourceEventId: string,
  generation: number,
  nowSec: number,
  limit = TELEGRAM_TARGET_PLAN_ENQUEUE_PAGE_SIZE,
): Promise<{
  enqueued: number;
  processed: number;
  remaining: number;
  jobIds: string[];
  duplicateSuppressed: number;
  duplicateSuppressionMs: number;
}> {
  const boundedLimit = Math.max(1, Math.min(TELEGRAM_TARGET_PLAN_ENQUEUE_PAGE_SIZE, Math.floor(limit)));
  const source = await db
    .prepare(
      `SELECT target_plan_state FROM telegram_alert_source_events
        WHERE source_event_id = ? AND target_plan_generation = ?`,
    )
    .bind(sourceEventId, generation)
    .first<{ target_plan_state: string }>();
  if (source?.target_plan_state !== "delivery_open") {
    throw new Error("Telegram target delivery is not open");
  }
  await expireTelegramAuthoritativeTargets(db, sourceEventId, generation, nowSec);
  const rows = await db
    .prepare(
      `SELECT target.job_id, target.target_key, target.target_ordinal,
              target.chat_id, target.chunk_index, target.alert_type,
              target.message_html, target.disable_notification,
              target.alert_scope_json, target.preference_generation,
              target.markup_policy_json, target.target_expires_at,
              plan.source_event_id, plan.plan_generation, plan.plan_key,
              plan.plan_ordinal, plan.plan_payload_json, plan.plan_payload_digest
         FROM telegram_alert_job_targets target
         JOIN telegram_alert_target_plans plan
           ON plan.source_event_id = target.source_event_id
          AND plan.plan_generation = target.plan_generation
          AND plan.plan_key = target.plan_key
        WHERE target.source_event_id = ? AND target.plan_generation = ?
          AND target.status = 'planned' AND target.target_expires_at > ?
        ORDER BY target.plan_ordinal, target.target_ordinal, target.target_key
        LIMIT ?`,
    )
    .bind(sourceEventId, generation, nowSec, boundedLimit)
    .all<ReadyTargetRow>();
  const targets = rows.results ?? [];
  const jobIds = [...new Set(targets.map((row) => row.job_id))];
  await Promise.all(targets.map(async (row) => {
    const parsed = await parseTelegramTargetPlan(row.plan_payload_json, row.plan_payload_digest);
    if (!readyTargetMatchesPlan(row, parsed) || parsed.kind !== "ok") {
      await markTelegramTargetPlanDegraded(
        db,
        { sourceEventId, generation },
        parsed.kind === "invalid" ? parsed.reason : "target_payload_mismatch",
        nowSec,
      );
      throw new Error("Telegram authoritative target failed strict payload validation");
    }
    const messageSpec = parsed.value.messages.find((message) => message.targetKey === row.target_key);
    if (!messageSpec) throw new Error("Telegram target message disappeared after validation");
  }));
  const targetKeys = targets.map((row) => row.target_key);
  const duplicateSuppressionStartedAtMs = Date.now();
  const duplicateSuppressed = await suppressPriorTerminalDedupeCollisions(
    db,
    sourceEventId,
    generation,
    nowSec,
    targetKeys,
  );
  const duplicateSuppressionMs = Math.max(0, Date.now() - duplicateSuppressionStartedAtMs);
  if (targetKeys.length > 0) {
    await executeAtomicBatch(
      db,
      buildSetBasedPendingHandoffStatements(db, sourceEventId, generation, nowSec, targetKeys),
    );
  }
  const confirmedRows = targetKeys.length === 0
    ? []
    : (await db
      .prepare(
        `SELECT target_key, status, final_delivery_state, cancellation_reason
           FROM telegram_alert_job_targets
          WHERE source_event_id = ? AND plan_generation = ?
            AND target_key IN (SELECT value FROM json_each(?))`,
      )
      .bind(sourceEventId, generation, JSON.stringify(targetKeys))
      .all<TargetHandoffStateRow & { target_key: string }>()).results ?? [];
  let enqueued = 0;
  let processed = 0;
  for (const confirmed of confirmedRows) {
    if (confirmed.status === "queued") {
      enqueued += 1;
      processed += 1;
    } else if (
      confirmed.status === "expired" &&
      confirmed.final_delivery_state === "cancelled" &&
      PRIOR_TERMINAL_DEDUPE_REASONS.includes(
        confirmed.cancellation_reason as (typeof PRIOR_TERMINAL_DEDUPE_REASONS)[number],
      )
    ) {
      processed += 1;
    } else {
      await markTelegramTargetPlanDegraded(db, { sourceEventId, generation }, "pending_identity_collision", nowSec);
      throw new Error("Telegram authoritative target pending handoff was not confirmed");
    }
  }
  if (confirmedRows.length !== targets.length || processed !== targets.length) {
    await markTelegramTargetPlanDegraded(db, { sourceEventId, generation }, "pending_identity_collision", nowSec);
    throw new Error("Telegram authoritative target handoff page did not reconcile");
  }
  await reconcileTelegramAlertJobCounters(db, jobIds, nowSec);
  const remainingRow = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM telegram_alert_job_targets
        WHERE source_event_id = ? AND plan_generation = ? AND status = 'planned'`,
    )
    .bind(sourceEventId, generation)
    .first<{ count: number }>();
  return {
    enqueued,
    processed,
    remaining: Number(remainingRow?.count ?? 0),
    jobIds,
    duplicateSuppressed,
    duplicateSuppressionMs,
  };
}
