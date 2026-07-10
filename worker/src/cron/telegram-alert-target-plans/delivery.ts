import type { TelegramAlertType } from "@shared/types/status";
import { executeAtomicBatch } from "../../lib/db";
import { PENDING_TTL_SEC } from "../../lib/telegram-constants";
import { buildPendingAlertEnqueueStatement } from "../telegram-pending/enqueue";
import {
  parseTelegramTargetPlan,
  targetPlanMessageToBatchMessage,
} from "../telegram-alert-target-plan-contract";
import { reconcileTelegramAlertJobCounters } from "../telegram-alert-job-target-outcomes";
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

interface ReadyTargetRow extends PersistedPlanRow {
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
): Promise<{ enqueued: number; remaining: number; jobIds: string[] }> {
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
  let enqueued = 0;
  for (const row of targets) {
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
    const message = targetPlanMessageToBatchMessage(parsed.value, messageSpec);
    const guard = {
      sql: `EXISTS (
        SELECT 1 FROM telegram_alert_job_targets target
         WHERE target.job_id = ? AND target.target_key = ?
           AND target.source_event_id = ? AND target.plan_generation = ?
           AND target.status = 'planned'
      )`,
      binds: [row.job_id, row.target_key, sourceEventId, generation],
    };
    await executeAtomicBatch(db, [
      buildPendingAlertEnqueueStatement(
        db,
        message,
        nowSec,
        {
          sourceType: "risk_alert",
          ttlSec: Math.max(1, row.target_expires_at - nowSec),
        },
        guard,
      ),
      db
        .prepare(
          `WITH inserted AS (
             SELECT id, chat_id, dedupe_key, not_before_at
               FROM telegram_pending_alerts
              WHERE dedupe_key = ? AND source_event_id = ?
           ), chat_backoff AS (
             SELECT MAX(existing.not_before_at) AS not_before_at
               FROM inserted
               JOIN telegram_pending_alerts existing
                 ON existing.chat_id = inserted.chat_id
                AND existing.id <> inserted.id
              WHERE existing.delivery_state = 'pending'
                AND COALESCE(existing.expires_at, existing.created_at + ?) > ?
                AND existing.not_before_at IS NOT NULL
                AND existing.not_before_at > ?
           )
           UPDATE telegram_pending_alerts
              SET not_before_at = CASE
                    WHEN (SELECT not_before_at FROM chat_backoff) IS NULL THEN not_before_at
                    WHEN not_before_at IS NULL THEN (SELECT not_before_at FROM chat_backoff)
                    ELSE MAX(not_before_at, (SELECT not_before_at FROM chat_backoff))
                  END
            WHERE dedupe_key = ? AND source_event_id = ?
              AND delivery_state = 'pending'
              AND EXISTS (
                SELECT 1 FROM telegram_alert_job_targets target
                 WHERE target.job_id = ? AND target.target_key = ?
                   AND target.source_event_id = ? AND target.plan_generation = ?
                   AND target.status = 'planned'
              )`,
        )
        .bind(
          row.target_key,
          sourceEventId,
          PENDING_TTL_SEC,
          nowSec,
          nowSec,
          row.target_key,
          sourceEventId,
          row.job_id,
          row.target_key,
          sourceEventId,
          generation,
        ),
      db
        .prepare(
          `UPDATE telegram_alert_job_targets
              SET status = 'queued', enqueued_at = COALESCE(enqueued_at, ?)
            WHERE job_id = ? AND target_key = ? AND source_event_id = ?
              AND plan_generation = ? AND status = 'planned'
              AND EXISTS (
                SELECT 1 FROM telegram_pending_alerts pending
                 WHERE pending.dedupe_key = telegram_alert_job_targets.pending_dedupe_key
                   AND pending.source_event_id = telegram_alert_job_targets.source_event_id
                   AND pending.preference_generation = telegram_alert_job_targets.preference_generation
              )`,
        )
        .bind(nowSec, row.job_id, row.target_key, sourceEventId, generation),
    ]);
    const confirmed = await db
      .prepare("SELECT status FROM telegram_alert_job_targets WHERE job_id = ? AND target_key = ?")
      .bind(row.job_id, row.target_key)
      .first<{ status: string }>();
    if (confirmed?.status !== "queued") {
      await markTelegramTargetPlanDegraded(db, { sourceEventId, generation }, "pending_identity_collision", nowSec);
      throw new Error("Telegram authoritative target pending handoff was not confirmed");
    }
    enqueued += 1;
  }
  await reconcileTelegramAlertJobCounters(db, jobIds, nowSec);
  const remainingRow = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM telegram_alert_job_targets
        WHERE source_event_id = ? AND plan_generation = ? AND status = 'planned'`,
    )
    .bind(sourceEventId, generation)
    .first<{ count: number }>();
  return { enqueued, remaining: Number(remainingRow?.count ?? 0), jobIds };
}
