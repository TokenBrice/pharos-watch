import {
  TELEGRAM_TARGET_PLAN_CLAIM_TTL_SEC,
  type TelegramTargetPlanningClaim,
} from "./types";
import { reconcileTelegramAlertJobCounters } from "../telegram-alert-job-target-outcomes";

interface TargetPlanningSourceRow {
  source_event_id: string;
  target_plan_state: TelegramTargetPlanningClaim["state"] | "unstarted" | "expired";
  target_plan_generation: number;
  target_plan_owner: string | null;
  detected_at: number;
  expires_at: number;
  subscriber_horizon_at: number | null;
  subscriber_high_water_chat_id: string | null;
  subscriber_cursor_chat_id: string | null;
  planning_cursor_chat_id: string | null;
}

function createTargetPlanOwner(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!cryptoObj?.randomUUID) {
    throw new Error("Web Crypto randomUUID is required for Telegram target planning");
  }
  return `target-plan-${cryptoObj.randomUUID()}`;
}

function mapPlanningClaim(row: TargetPlanningSourceRow, owner: string): TelegramTargetPlanningClaim {
  if (row.subscriber_horizon_at == null) {
    throw new Error("Telegram target planning claim is missing its subscriber horizon");
  }
  if (row.target_plan_state === "unstarted" || row.target_plan_state === "expired") {
    throw new Error(`Telegram target planning cannot claim source in ${row.target_plan_state}`);
  }
  return {
    sourceEventId: row.source_event_id,
    owner,
    generation: Number(row.target_plan_generation),
    state: row.target_plan_state,
    detectedAt: Number(row.detected_at),
    expiresAt: Number(row.expires_at),
    horizonAt: Number(row.subscriber_horizon_at),
    highWaterChatId: row.subscriber_high_water_chat_id,
    subscriberCursorChatId: row.subscriber_cursor_chat_id,
    planningCursorChatId: row.planning_cursor_chat_id,
  };
}

/** Claim or resume one source. The first claim freezes the subscriber horizon and bumps generation. */
export async function claimTelegramTargetPlanning(
  db: D1Database,
  sourceEventId: string,
  nowSec: number,
  owner = createTargetPlanOwner(),
): Promise<TelegramTargetPlanningClaim | null> {
  const existing = await db
    .prepare(
      `SELECT status, expires_at, target_plan_state, target_plan_generation
         FROM telegram_alert_source_events
        WHERE source_event_id = ?`,
    )
    .bind(sourceEventId)
    .first<{
      status: string;
      expires_at: number;
      target_plan_state: string;
      target_plan_generation: number;
    }>();
  if (!existing) return null;
  if (Number(existing.expires_at) <= nowSec) {
    await expireTelegramTargetPlanSource(
      db,
      sourceEventId,
      Number(existing.target_plan_generation),
      nowSec,
      "target_plan_source_expired",
    );
    return null;
  }
  if (existing.status === "baseline_committed" && existing.target_plan_state === "unstarted") {
    await db
      .prepare(
        `UPDATE telegram_alert_source_events
            SET target_plan_state = 'degraded',
                last_error_class = 'legacy_baseline_committed_without_manifest',
                last_attempt_at = ?
          WHERE source_event_id = ?
            AND status = 'baseline_committed'
            AND target_plan_state = 'unstarted'`,
      )
      .bind(nowSec, sourceEventId)
      .run();
    return null;
  }
  const claimExpiresAt = nowSec + TELEGRAM_TARGET_PLAN_CLAIM_TTL_SEC;
  await db
    .prepare(
      `UPDATE telegram_alert_source_events
          SET target_plan_generation = CASE
                WHEN target_plan_state = 'unstarted' THEN target_plan_generation + 1
                ELSE target_plan_generation
              END,
              target_plan_state = CASE
                WHEN target_plan_state = 'unstarted' THEN 'capturing'
                ELSE target_plan_state
              END,
              target_plan_owner = ?,
              target_plan_claim_expires_at = ?,
              target_plan_started_at = COALESCE(target_plan_started_at, ?),
              subscriber_horizon_at = COALESCE(subscriber_horizon_at, detected_at),
              subscriber_high_water_chat_id = CASE
                WHEN subscriber_horizon_at IS NULL THEN (
                  SELECT MAX(chat_id)
                    FROM telegram_subscribers
                   WHERE created_at <= telegram_alert_source_events.detected_at
                )
                ELSE subscriber_high_water_chat_id
              END
        WHERE source_event_id = ?
          AND (
            status IN ('resolving', 'planned')
            OR (status = 'baseline_committed' AND target_plan_state <> 'unstarted')
          )
          AND expires_at > ?
          AND target_plan_state <> 'expired'
          AND (
            target_plan_owner IS NULL
            OR target_plan_owner = ?
            OR target_plan_claim_expires_at IS NULL
            OR target_plan_claim_expires_at <= ?
          )`,
    )
    .bind(owner, claimExpiresAt, nowSec, sourceEventId, nowSec, owner, nowSec)
    .run();
  const row = await db
    .prepare(
      `SELECT source_event_id, target_plan_state, target_plan_generation,
              target_plan_owner, detected_at, expires_at, subscriber_horizon_at,
              subscriber_high_water_chat_id, subscriber_cursor_chat_id,
              planning_cursor_chat_id
         FROM telegram_alert_source_events
        WHERE source_event_id = ?`,
    )
    .bind(sourceEventId)
    .first<TargetPlanningSourceRow>();
  if (!row || row.target_plan_owner !== owner) return null;
  return mapPlanningClaim(row, owner);
}

export async function expireTelegramTargetPlanSource(
  db: D1Database,
  sourceEventId: string,
  generation: number,
  nowSec: number,
  reason = "target_plan_source_expired",
  rowBudget = 90,
): Promise<{
  processed: number;
  complete: boolean;
  remaining: { subscribers: number; pages: number; plans: number; targets: number };
}> {
  const boundedBudget = Math.max(1, Math.min(90, Math.floor(rowBudget)));
  const boundedReason = reason.slice(0, 80);
  await db
    .prepare(
      `UPDATE telegram_alert_source_events
          SET target_plan_state = 'expired',
              target_plan_owner = NULL,
              target_plan_claim_expires_at = NULL,
              last_error_class = ?,
              last_attempt_at = ?
        WHERE source_event_id = ?
          AND target_plan_generation = ?
          AND target_plan_state <> 'expired'`,
    )
    .bind(boundedReason, nowSec, sourceEventId, generation)
    .run();
  await db
    .prepare(
      `INSERT INTO telegram_alert_target_expiry_progress (
         source_event_id, plan_generation, state, started_at, updated_at
       ) VALUES (?, ?, 'running', ?, ?)
       ON CONFLICT(source_event_id, plan_generation) DO UPDATE SET updated_at = excluded.updated_at`,
    )
    .bind(sourceEventId, generation, nowSec, nowSec)
    .run();

  let remainingBudget = boundedBudget;
  const targetResult = await db
    .prepare(
      `UPDATE telegram_alert_job_targets
          SET status = 'expired', final_delivery_state = 'expired',
              final_delivery_at = COALESCE(final_delivery_at, ?),
              final_delivery_error = COALESCE(final_delivery_error, ?),
              error_class = COALESCE(error_class, ?)
        WHERE rowid IN (
          SELECT rowid FROM telegram_alert_job_targets
           WHERE source_event_id = ? AND plan_generation = ? AND status = 'planned'
           ORDER BY plan_ordinal, target_ordinal, target_key LIMIT ?
        )`,
    )
    .bind(nowSec, boundedReason, boundedReason, sourceEventId, generation, remainingBudget)
    .run();
  const processedTargets = Number(targetResult.meta?.changes ?? 0);
  remainingBudget -= processedTargets;

  const subscriberResult = remainingBudget > 0
    ? await db
      .prepare(
        `UPDATE telegram_alert_planning_subscribers
            SET planning_outcome = 'expired', planned_at = ?
          WHERE rowid IN (
            SELECT rowid FROM telegram_alert_planning_subscribers
             WHERE source_event_id = ? AND plan_generation = ? AND planning_outcome = 'pending'
             ORDER BY chat_id LIMIT ?
          )`,
      )
      .bind(nowSec, sourceEventId, generation, remainingBudget)
      .run()
    : null;
  const processedSubscribers = Number(subscriberResult?.meta?.changes ?? 0);
  remainingBudget -= processedSubscribers;

  const pageResult = remainingBudget > 0
    ? await db
      .prepare(
        `UPDATE telegram_alert_target_plan_pages
            SET status = 'expired', updated_at = ?, completed_at = COALESCE(completed_at, ?),
                last_error_class = COALESCE(last_error_class, 'target_plan_source_expired')
          WHERE rowid IN (
            SELECT rowid FROM telegram_alert_target_plan_pages
             WHERE source_event_id = ? AND plan_generation = ?
               AND status IN ('pending', 'materializing')
             ORDER BY page_index LIMIT ?
          )`,
      )
      .bind(nowSec, nowSec, sourceEventId, generation, remainingBudget)
      .run()
    : null;
  const processedPages = Number(pageResult?.meta?.changes ?? 0);
  remainingBudget -= processedPages;

  const planResult = remainingBudget > 0
    ? await db
      .prepare(
        `UPDATE telegram_alert_target_plans
            SET status = 'expired', updated_at = ?
          WHERE rowid IN (
            SELECT rowid FROM telegram_alert_target_plans
             WHERE source_event_id = ? AND plan_generation = ? AND status <> 'expired'
             ORDER BY plan_ordinal LIMIT ?
          )`,
      )
      .bind(nowSec, sourceEventId, generation, remainingBudget)
      .run()
    : null;
  const processedPlans = Number(planResult?.meta?.changes ?? 0);
  const remainingRow = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM telegram_alert_planning_subscribers
           WHERE source_event_id = ? AND plan_generation = ? AND planning_outcome = 'pending') AS subscribers,
         (SELECT COUNT(*) FROM telegram_alert_target_plan_pages
           WHERE source_event_id = ? AND plan_generation = ?
             AND status IN ('pending', 'materializing')) AS pages,
         (SELECT COUNT(*) FROM telegram_alert_target_plans
           WHERE source_event_id = ? AND plan_generation = ? AND status <> 'expired') AS plans,
         (SELECT COUNT(*) FROM telegram_alert_job_targets
           WHERE source_event_id = ? AND plan_generation = ? AND status = 'planned') AS targets`,
    )
    .bind(
      sourceEventId,
      generation,
      sourceEventId,
      generation,
      sourceEventId,
      generation,
      sourceEventId,
      generation,
    )
    .first<{ subscribers: number; pages: number; plans: number; targets: number }>();
  const remaining = {
    subscribers: Number(remainingRow?.subscribers ?? 0),
    pages: Number(remainingRow?.pages ?? 0),
    plans: Number(remainingRow?.plans ?? 0),
    targets: Number(remainingRow?.targets ?? 0),
  };
  const complete = Object.values(remaining).every((count) => count === 0);
  await db
    .prepare(
      `UPDATE telegram_alert_target_expiry_progress
          SET state = CASE WHEN ? = 1 THEN 'complete' ELSE 'running' END,
              processed_subscribers = processed_subscribers + ?,
              processed_pages = processed_pages + ?,
              processed_plans = processed_plans + ?,
              processed_targets = processed_targets + ?,
              remaining_subscribers = ?, remaining_pages = ?,
              remaining_plans = ?, remaining_targets = ?,
              updated_at = ?, completed_at = CASE WHEN ? = 1 THEN ? ELSE NULL END
        WHERE source_event_id = ? AND plan_generation = ?`,
    )
    .bind(
      complete ? 1 : 0,
      processedSubscribers,
      processedPages,
      processedPlans,
      processedTargets,
      remaining.subscribers,
      remaining.pages,
      remaining.plans,
      remaining.targets,
      nowSec,
      complete ? 1 : 0,
      nowSec,
      sourceEventId,
      generation,
    )
    .run();
  const jobs = await db
    .prepare("SELECT job_id FROM telegram_alert_jobs WHERE source_event_id = ?")
    .bind(sourceEventId)
    .all<{ job_id: string }>();
  await reconcileTelegramAlertJobCounters(db, (jobs.results ?? []).map((row) => row.job_id), nowSec);
  return {
    processed: processedTargets + processedSubscribers + processedPages + processedPlans,
    complete,
    remaining,
  };
}

export async function markTelegramTargetPlanDegraded(
  db: D1Database,
  claim: Pick<TelegramTargetPlanningClaim, "sourceEventId" | "generation">,
  errorClass: string,
  nowSec: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE telegram_alert_source_events
          SET target_plan_state = 'degraded',
              target_plan_claim_expires_at = NULL,
              last_error_class = ?,
              last_attempt_at = ?
        WHERE source_event_id = ?
          AND target_plan_generation = ?`,
    )
    .bind(errorClass.slice(0, 80), nowSec, claim.sourceEventId, claim.generation)
    .run();
}

/** Re-enter handoff only for the terminal-dedupe collision repaired by delivery.ts. */
export async function reopenTelegramTargetPlanDeliveryAfterIdentityCollision(
  db: D1Database,
  claim: Pick<TelegramTargetPlanningClaim, "sourceEventId" | "generation" | "owner">,
  nowSec: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE telegram_alert_source_events
          SET target_plan_state = 'delivery_open', last_attempt_at = ?
        WHERE source_event_id = ?
          AND target_plan_generation = ?
          AND target_plan_owner = ?
          AND target_plan_state = 'degraded'
          AND last_error_class = 'pending_identity_collision'
          AND target_delivery_opened_at IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM telegram_alert_job_targets target
             WHERE target.source_event_id = telegram_alert_source_events.source_event_id
               AND target.plan_generation = telegram_alert_source_events.target_plan_generation
               AND target.status = 'planned'
          )`,
    )
    .bind(nowSec, claim.sourceEventId, claim.generation, claim.owner)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

/** Release only this generation's live owner after a bounded, successful handoff. */
export async function releaseTelegramTargetPlanningClaim(
  db: D1Database,
  claim: Pick<TelegramTargetPlanningClaim, "sourceEventId" | "generation" | "owner" | "state">,
): Promise<boolean> {
  if (!(["capturing", "planning", "materializing", "ready"] as const).includes(
    claim.state as "capturing" | "planning" | "materializing" | "ready",
  )) {
    return false;
  }
  const result = await db
    .prepare(
      `UPDATE telegram_alert_source_events
          SET target_plan_owner = NULL,
              target_plan_claim_expires_at = NULL
        WHERE source_event_id = ?
          AND target_plan_generation = ?
          AND target_plan_owner = ?
          AND target_plan_state = ?`,
    )
    .bind(claim.sourceEventId, claim.generation, claim.owner, claim.state)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}
