import type { TelegramAlertType } from "@shared/types/status";
import { D1_BATCH_SIZE } from "../../lib/constants";
import { executeAtomicBatch, prepareMultiRowInsertStatements } from "../../lib/db";
import { TELEGRAM_ALERT_TTL_SEC } from "../../lib/telegram/constants";
import {
  assertTelegramPlanMaterializationFitsD1Batch,
  serializeTelegramTargetPlan,
  TELEGRAM_TARGET_PLAN_MAX_CHUNKS,
  TELEGRAM_TARGET_PLAN_MAX_ITEMS,
  type SerializedTelegramTargetPlan,
} from "../telegram-alert-target-plan-contract";
import { strictestAlertTtlSec, type RoutedSubscriberAlert } from "../dispatch-telegram-routing";
import { markTelegramTargetPlanDegraded } from "./source-state";
import {
  TELEGRAM_TARGET_PLAN_CLAIM_TTL_SEC,
  TELEGRAM_TARGET_PLAN_HORIZON_PAGE_SIZE,
  classifyTelegramPlanningOutcome,
  type TelegramPlanningDecision,
  type TelegramPlanningOutcome,
  type TelegramTargetPlanningClaim,
} from "./types";

interface TargetPlanPageRow {
  page_index: number;
  first_chat_id: string;
  last_chat_id: string;
  expected_plan_count: number;
  expected_target_count: number;
  status: string;
}

function jobIdFor(sourceEventId: string, alertType: TelegramAlertType): string {
  return `telegram:${sourceEventId}:${alertType}`;
}

function severityFor(alertType: TelegramAlertType): "risk" | "info" {
  return alertType === "launch" ? "info" : "risk";
}

async function serializePlanningDecision(
  claim: TelegramTargetPlanningClaim,
  decision: TelegramPlanningDecision,
): Promise<{ outcome: TelegramPlanningOutcome; plans: SerializedTelegramTargetPlan[] }> {
  const outcome = classifyTelegramPlanningOutcome({
    initiallyEligible: decision.subscriber.initiallyEligible,
    currentEligible: decision.currentEligible,
    generationChanged: decision.subscriber.preferenceGeneration !== decision.currentPreferenceGeneration,
  });
  if (outcome !== "target_planned") return { outcome, plans: [] };
  if (decision.routed.length === 0) {
    throw new Error("Eligible Telegram planning decision has no rendered target plan");
  }
  const plans = await Promise.all(
    decision.routed.map((routed) => {
      if (
        routed.chatId !== decision.subscriber.chatId ||
        routed.sourceEventId !== claim.sourceEventId ||
        routed.preferenceGeneration !== decision.currentPreferenceGeneration
      ) {
        throw new Error("Telegram routed plan does not match its captured subscriber decision");
      }
      return serializeTelegramTargetPlan(routed, resolveTelegramTargetExpiresAt(claim, decision, routed));
    }),
  );
  return { outcome, plans };
}

export function resolveTelegramTargetExpiresAt(
  claim: Pick<TelegramTargetPlanningClaim, "detectedAt">,
  decision: Pick<TelegramPlanningDecision, "targetExpiresAt">,
  routed: Pick<RoutedSubscriberAlert, "alertType" | "alertTypes">,
): number {
  return decision.targetExpiresAt ?? claim.detectedAt + strictestAlertTtlSec(routed.alertTypes ?? [routed.alertType]);
}

function prepareNonTargetOutcomeStatement(
  db: D1Database,
  claim: TelegramTargetPlanningClaim,
  decision: TelegramPlanningDecision,
  outcome: Exclude<TelegramPlanningOutcome, "target_planned">,
  nowSec: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE telegram_alert_planning_subscribers
          SET planning_outcome = ?,
              planned_preference_generation = ?,
              planned_at = ?
        WHERE source_event_id = ?
          AND plan_generation = ?
          AND chat_id = ?
          AND planning_outcome = 'pending'`,
    )
    .bind(
      outcome,
      decision.currentPreferenceGeneration,
      nowSec,
      claim.sourceEventId,
      claim.generation,
      decision.subscriber.chatId,
    );
}

function prepareOneTargetPlanStatements(args: {
  db: D1Database;
  claim: TelegramTargetPlanningClaim;
  decision: TelegramPlanningDecision;
  plan: SerializedTelegramTargetPlan;
  pageIndex: number;
  planOrdinal: number;
  nowSec: number;
}): D1PreparedStatement[] {
  const { db, claim, decision, plan, pageIndex, planOrdinal, nowSec } = args;
  if (
    plan.payload.messages.length > TELEGRAM_TARGET_PLAN_MAX_CHUNKS ||
    plan.payload.itemKeys.length > TELEGRAM_TARGET_PLAN_MAX_ITEMS
  ) {
    throw new Error("Telegram target plan exceeded the bounded materialization contract");
  }
  const jobId = jobIdFor(claim.sourceEventId, plan.payload.alertType);
  const jobExpiresAt = claim.detectedAt + TELEGRAM_ALERT_TTL_SEC[plan.payload.alertType];
  const metadata = JSON.stringify({
    rolloutStage: "authoritative-target-plan",
    sourceEventId: claim.sourceEventId,
    planGeneration: claim.generation,
  });
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO telegram_alert_jobs (
           job_id, alert_type, source_event_id, severity, created_at, expires_at,
           status, target_count, sent_count, enqueued_count, failed_count, metadata
         ) VALUES (?, ?, ?, ?, ?, ?, 'discovered', 0, 0, 0, 0, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           expires_at = MAX(telegram_alert_jobs.expires_at, excluded.expires_at)`,
      )
      .bind(
        jobId,
        plan.payload.alertType,
        claim.sourceEventId,
        severityFor(plan.payload.alertType),
        claim.detectedAt,
        jobExpiresAt,
        metadata,
      ),
    db
      .prepare(
        `INSERT INTO telegram_alert_target_plans (
           source_event_id, plan_generation, plan_key, page_index, plan_ordinal,
           chat_id, alert_type, schema_version, status, preference_generation,
           estimated_chunks, plan_payload_json, plan_payload_digest,
           expected_target_count, materialized_target_count,
           created_at, updated_at, materialized_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'materialized', ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_event_id, plan_generation, plan_key) DO NOTHING`,
      )
      .bind(
        claim.sourceEventId,
        claim.generation,
        plan.planKey,
        pageIndex,
        planOrdinal,
        plan.payload.chatId,
        plan.payload.alertType,
        plan.payload.preferenceGeneration,
        plan.payload.messages.length,
        plan.payloadJson,
        plan.payloadDigest,
        plan.payload.messages.length,
        plan.payload.messages.length,
        nowSec,
        nowSec,
        nowSec,
      ),
    ...prepareMultiRowInsertStatements(
      db,
      `INSERT OR IGNORE INTO telegram_alert_job_targets (
         job_id, target_key, chat_id, chunk_index, alert_type, status,
         pending_dedupe_key, created_at, source_event_id, plan_generation,
         plan_key, plan_ordinal, target_ordinal, target_schema_version,
         message_html, disable_notification, alert_scope_json,
         preference_generation, markup_policy_json, target_expires_at
       )`,
      plan.payload.messages.map((message) => [
        jobId,
        message.targetKey,
        plan.payload.chatId,
        message.chunkIndex,
        plan.payload.alertType,
        "planned",
        message.targetKey,
        nowSec,
        claim.sourceEventId,
        claim.generation,
        plan.planKey,
        planOrdinal,
        message.chunkIndex,
        1,
        message.html,
        plan.payload.disableNotification ? 1 : 0,
        plan.payload.alertScopeJson,
        plan.payload.preferenceGeneration,
        message.markupPolicyJson,
        plan.payload.targetExpiresAt,
      ]),
    ),
    ...prepareMultiRowInsertStatements(
      db,
      `INSERT OR IGNORE INTO telegram_alert_target_plan_items (
         source_event_id, plan_generation, plan_key, item_key, created_at
       )`,
      plan.payload.itemKeys.map((itemKey) => [claim.sourceEventId, claim.generation, plan.planKey, itemKey, nowSec]),
    ),
    db
      .prepare(
        `UPDATE telegram_alert_planning_subscribers
            SET planning_outcome = 'target_planned',
                planned_preference_generation = ?,
                planned_at = ?
          WHERE source_event_id = ?
            AND plan_generation = ?
            AND chat_id = ?
            AND planning_outcome IN ('pending', 'target_planned')`,
      )
      .bind(
        decision.currentPreferenceGeneration,
        nowSec,
        claim.sourceEventId,
        claim.generation,
        decision.subscriber.chatId,
      ),
  ];
  if (statements.length > D1_BATCH_SIZE) {
    throw new Error(`Telegram target plan unit exceeds the D1 batch limit (${statements.length})`);
  }
  return statements;
}

async function executeTargetPlanStatementUnits(
  db: D1Database,
  claim: TelegramTargetPlanningClaim,
  pageIndex: number,
  units: readonly {
    statements: readonly D1PreparedStatement[];
    plans: readonly SerializedTelegramTargetPlan[];
  }[],
  nowSec: number,
): Promise<void> {
  let batchStatements: D1PreparedStatement[] = [];
  let batchPlans: SerializedTelegramTargetPlan[] = [];
  const flush = async () => {
    await executeAtomicBatch(db, batchStatements);
    await verifyMaterializedTargetPlans(db, claim, pageIndex, batchPlans, nowSec);
    batchStatements = [];
    batchPlans = [];
  };
  for (const unit of units) {
    if (unit.statements.length > D1_BATCH_SIZE) {
      throw new Error(`Telegram target plan unit exceeds the D1 batch limit (${unit.statements.length})`);
    }
    if (
      batchStatements.length > 0 &&
      batchStatements.length + unit.statements.length > D1_BATCH_SIZE
    ) {
      await flush();
    }
    batchStatements.push(...unit.statements);
    batchPlans.push(...unit.plans);
  }
  if (batchStatements.length > 0) await flush();
}

async function verifyMaterializedTargetPlans(
  db: D1Database,
  claim: TelegramTargetPlanningClaim,
  pageIndex: number,
  plans: readonly SerializedTelegramTargetPlan[],
  nowSec: number,
): Promise<void> {
  if (plans.length === 0) return;
  const rows = await db
    .prepare(
      `SELECT plan.plan_key,
              (SELECT COUNT(*) FROM telegram_alert_job_targets target
                WHERE target.source_event_id = plan.source_event_id
                  AND target.plan_generation = plan.plan_generation
                  AND target.plan_key = plan.plan_key) AS targets,
              (SELECT COUNT(*) FROM telegram_alert_target_plan_items item
                WHERE item.source_event_id = plan.source_event_id
                  AND item.plan_generation = plan.plan_generation
                  AND item.plan_key = plan.plan_key) AS items
         FROM telegram_alert_target_plans plan
        WHERE plan.source_event_id = ? AND plan.plan_generation = ? AND plan.page_index = ?`,
    )
    .bind(claim.sourceEventId, claim.generation, pageIndex)
    .all<{ plan_key: string; targets: number; items: number }>();
  const countsByPlan = new Map((rows.results ?? []).map((row) => [row.plan_key, row]));
  for (const plan of plans) {
    const counts = countsByPlan.get(plan.planKey);
    if (
      Number(counts?.targets ?? -1) !== plan.payload.messages.length ||
      Number(counts?.items ?? -1) !== plan.payload.itemKeys.length
    ) {
      await markTelegramTargetPlanDegraded(db, claim, "target_plan_count_mismatch", nowSec);
      throw new Error("Telegram target plan materialization did not reconcile");
    }
  }
}

export async function materializeTelegramTargetPlanPage(
  db: D1Database,
  claim: TelegramTargetPlanningClaim,
  pageIndex: number,
  decisions: readonly TelegramPlanningDecision[],
  nowSec: number,
): Promise<{ planCount: number; targetCount: number; outcomes: Record<TelegramPlanningOutcome, number> }> {
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
    throw new Error("Telegram target plan page index is invalid");
  }
  if (decisions.length === 0 || decisions.length > TELEGRAM_TARGET_PLAN_HORIZON_PAGE_SIZE) {
    throw new Error("Telegram target plan page size is invalid");
  }
  assertTelegramPlanMaterializationFitsD1Batch();
  const serialized = await Promise.all(decisions.map((decision) => serializePlanningDecision(claim, decision)));
  const planCount = serialized.reduce((sum, entry) => sum + entry.plans.length, 0);
  const targetCount = serialized.reduce(
    (sum, entry) => sum + entry.plans.reduce((inner, plan) => inner + plan.payload.messages.length, 0),
    0,
  );
  const firstChatId = decisions[0].subscriber.chatId;
  const lastChatId = decisions[decisions.length - 1].subscriber.chatId;
  await db
    .prepare(
      `INSERT INTO telegram_alert_target_plan_pages (
         source_event_id, plan_generation, page_index, first_chat_id, last_chat_id,
         status, expected_plan_count, expected_target_count, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'materializing', ?, ?, ?, ?)
       ON CONFLICT(source_event_id, plan_generation, page_index) DO UPDATE SET
         status = CASE
           WHEN telegram_alert_target_plan_pages.status = 'complete' THEN 'complete'
           ELSE 'materializing'
         END,
         updated_at = excluded.updated_at,
         attempt_count = telegram_alert_target_plan_pages.attempt_count + 1`,
    )
    .bind(
      claim.sourceEventId,
      claim.generation,
      pageIndex,
      firstChatId,
      lastChatId,
      planCount,
      targetCount,
      nowSec,
      nowSec,
    )
    .run();
  const persistedPage = await db
    .prepare(
      `SELECT page_index, first_chat_id, last_chat_id, expected_plan_count,
              expected_target_count, status
         FROM telegram_alert_target_plan_pages
        WHERE source_event_id = ? AND plan_generation = ? AND page_index = ?`,
    )
    .bind(claim.sourceEventId, claim.generation, pageIndex)
    .first<TargetPlanPageRow>();
  if (!persistedPage || !persistedPage.first_chat_id || !persistedPage.last_chat_id) {
    throw new Error("Telegram target plan page header was not persisted");
  }

  const ordinalRow = await db
    .prepare(
      `SELECT MAX(plan_ordinal) AS maximum
         FROM telegram_alert_target_plans
        WHERE source_event_id = ? AND plan_generation = ? AND page_index = ?`,
    )
    .bind(claim.sourceEventId, claim.generation, pageIndex)
    .first<{ maximum: number | null }>();
  let nextPlanOrdinal = ordinalRow?.maximum == null ? pageIndex * 10_000 : Number(ordinalRow.maximum) + 1;
  const statementUnits: Array<{
    statements: D1PreparedStatement[];
    plans: SerializedTelegramTargetPlan[];
  }> = [];
  for (const [decisionIndex, decision] of decisions.entries()) {
    const entry = serialized[decisionIndex];
    if (entry.outcome !== "target_planned") {
      statementUnits.push({
        statements: [prepareNonTargetOutcomeStatement(db, claim, decision, entry.outcome, nowSec)],
        plans: [],
      });
      continue;
    }
    for (const plan of entry.plans) {
      const planOrdinal = nextPlanOrdinal;
      nextPlanOrdinal += 1;
      statementUnits.push({
        statements: prepareOneTargetPlanStatements({
          db,
          claim,
          decision,
          plan,
          pageIndex,
          planOrdinal,
          nowSec,
        }),
        plans: [plan],
      });
    }
  }
  await executeTargetPlanStatementUnits(db, claim, pageIndex, statementUnits, nowSec);

  const reconciled = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM telegram_alert_target_plans
           WHERE source_event_id = ? AND plan_generation = ? AND page_index = ?) AS plans,
         (SELECT COUNT(*) FROM telegram_alert_job_targets
           WHERE source_event_id = ? AND plan_generation = ?
             AND plan_key IN (
               SELECT plan_key FROM telegram_alert_target_plans
                WHERE source_event_id = ? AND plan_generation = ? AND page_index = ?
             )) AS targets`,
    )
    .bind(
      claim.sourceEventId,
      claim.generation,
      pageIndex,
      claim.sourceEventId,
      claim.generation,
      claim.sourceEventId,
      claim.generation,
      pageIndex,
    )
    .first<{ plans: number; targets: number }>();
  const actualPlans = Number(reconciled?.plans ?? -1);
  const actualTargets = Number(reconciled?.targets ?? -1);
  const pendingRow = await db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM telegram_alert_planning_subscribers
        WHERE source_event_id = ? AND plan_generation = ?
          AND chat_id >= ? AND chat_id <= ? AND planning_outcome = 'pending'`,
    )
    .bind(claim.sourceEventId, claim.generation, persistedPage.first_chat_id, persistedPage.last_chat_id)
    .first<{ count: number }>();
  const pendingSubscribers = Number(pendingRow?.count ?? -1);
  if (
    actualPlans > Number(persistedPage.expected_plan_count) ||
    actualTargets > Number(persistedPage.expected_target_count) ||
    (pendingSubscribers === 0 &&
      (actualPlans !== Number(persistedPage.expected_plan_count) ||
        actualTargets !== Number(persistedPage.expected_target_count)))
  ) {
    await markTelegramTargetPlanDegraded(db, claim, "target_page_count_mismatch", nowSec);
    throw new Error("Telegram target plan page did not reconcile");
  }
  if (pendingSubscribers > 0) {
    const outcomes: Record<TelegramPlanningOutcome, number> = {
      target_planned: 0,
      no_matching_scope: 0,
      preference_changed_ineligible: 0,
      eligible_after_event: 0,
      snapshot_missing: 0,
    };
    for (const entry of serialized) outcomes[entry.outcome] += 1;
    return { planCount: actualPlans, targetCount: actualTargets, outcomes };
  }
  const completedChanges = await executeAtomicBatch(db, [
    db
      .prepare(
        `UPDATE telegram_alert_target_plan_pages
            SET status = 'complete', materialized_plan_count = ?,
                materialized_target_count = ?, updated_at = ?, completed_at = ?
          WHERE source_event_id = ? AND plan_generation = ? AND page_index = ?
            AND expected_plan_count = ? AND expected_target_count = ?
            AND EXISTS (
              SELECT 1 FROM telegram_alert_source_events source
               WHERE source.source_event_id = telegram_alert_target_plan_pages.source_event_id
                 AND source.target_plan_generation = telegram_alert_target_plan_pages.plan_generation
                 AND source.target_plan_owner = ?
                 AND source.target_plan_state IN ('planning', 'materializing')
            )`,
      )
      .bind(
        actualPlans,
        actualTargets,
        nowSec,
        nowSec,
        claim.sourceEventId,
        claim.generation,
        pageIndex,
        persistedPage.expected_plan_count,
        persistedPage.expected_target_count,
        claim.owner,
      ),
    db
      .prepare(
        `UPDATE telegram_alert_source_events
            SET planning_cursor_chat_id = ?, target_plan_state = 'planning',
                target_plan_owner = ?, target_plan_claim_expires_at = ?
          WHERE source_event_id = ? AND target_plan_generation = ?
            AND target_plan_owner = ?
            AND target_plan_state IN ('planning', 'materializing')
            AND EXISTS (
              SELECT 1 FROM telegram_alert_target_plan_pages page
               WHERE page.source_event_id = telegram_alert_source_events.source_event_id
                 AND page.plan_generation = telegram_alert_source_events.target_plan_generation
                 AND page.page_index = ? AND page.status = 'complete'
            )`,
      )
      .bind(
        lastChatId,
        claim.owner,
        nowSec + TELEGRAM_TARGET_PLAN_CLAIM_TTL_SEC,
        claim.sourceEventId,
        claim.generation,
        claim.owner,
        pageIndex,
      ),
  ]);
  if (completedChanges !== 2) {
    throw new Error(`Telegram target page completion CAS was not confirmed (${completedChanges}/2)`);
  }

  const outcomes: Record<TelegramPlanningOutcome, number> = {
    target_planned: 0,
    no_matching_scope: 0,
    preference_changed_ineligible: 0,
    eligible_after_event: 0,
    snapshot_missing: 0,
  };
  for (const entry of serialized) outcomes[entry.outcome] += 1;
  return { planCount: actualPlans, targetCount: actualTargets, outcomes };
}

/** Recover the crash boundary after all decisions persisted but before the page/source completion CAS. */
export async function reconcileIncompleteTelegramTargetPlanPage(
  db: D1Database,
  claim: TelegramTargetPlanningClaim,
  nowSec: number,
): Promise<{
  found: boolean;
  complete: boolean;
  pageIndex: number | null;
  firstChatId: string | null;
  lastChatId: string | null;
}> {
  const page = await db
    .prepare(
      `SELECT page_index, first_chat_id, last_chat_id, expected_plan_count,
              expected_target_count, status
         FROM telegram_alert_target_plan_pages
        WHERE source_event_id = ? AND plan_generation = ? AND status = 'materializing'
        ORDER BY page_index LIMIT 1`,
    )
    .bind(claim.sourceEventId, claim.generation)
    .first<TargetPlanPageRow>();
  if (!page) {
    return { found: false, complete: false, pageIndex: null, firstChatId: null, lastChatId: null };
  }
  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM telegram_alert_target_plans
           WHERE source_event_id = ? AND plan_generation = ? AND page_index = ?) AS plans,
         (SELECT COUNT(*) FROM telegram_alert_job_targets
           WHERE source_event_id = ? AND plan_generation = ?
             AND plan_key IN (
               SELECT plan_key FROM telegram_alert_target_plans
                WHERE source_event_id = ? AND plan_generation = ? AND page_index = ?
             )) AS targets,
         (SELECT COUNT(*) FROM telegram_alert_planning_subscribers
           WHERE source_event_id = ? AND plan_generation = ?
             AND chat_id >= ? AND chat_id <= ? AND planning_outcome = 'pending') AS pending_subscribers`,
    )
    .bind(
      claim.sourceEventId,
      claim.generation,
      page.page_index,
      claim.sourceEventId,
      claim.generation,
      claim.sourceEventId,
      claim.generation,
      page.page_index,
      claim.sourceEventId,
      claim.generation,
      page.first_chat_id,
      page.last_chat_id,
    )
    .first<{ plans: number; targets: number; pending_subscribers: number }>();
  if (Number(counts?.pending_subscribers ?? -1) > 0) {
    return {
      found: true,
      complete: false,
      pageIndex: Number(page.page_index),
      firstChatId: page.first_chat_id,
      lastChatId: page.last_chat_id,
    };
  }
  if (
    Number(counts?.plans ?? -1) !== Number(page.expected_plan_count) ||
    Number(counts?.targets ?? -1) !== Number(page.expected_target_count)
  ) {
    await markTelegramTargetPlanDegraded(db, claim, "target_page_resume_mismatch", nowSec);
    throw new Error("Telegram target page crash recovery did not reconcile");
  }
  const changed = await executeAtomicBatch(db, [
    db
      .prepare(
        `UPDATE telegram_alert_target_plan_pages
            SET status = 'complete', materialized_plan_count = ?,
                materialized_target_count = ?, updated_at = ?, completed_at = ?
          WHERE source_event_id = ? AND plan_generation = ? AND page_index = ?
            AND status = 'materializing'
            AND EXISTS (
              SELECT 1 FROM telegram_alert_source_events source
               WHERE source.source_event_id = telegram_alert_target_plan_pages.source_event_id
                 AND source.target_plan_generation = telegram_alert_target_plan_pages.plan_generation
                 AND source.target_plan_owner = ?
                 AND source.target_plan_state IN ('planning', 'materializing')
            )`,
      )
      .bind(
        page.expected_plan_count,
        page.expected_target_count,
        nowSec,
        nowSec,
        claim.sourceEventId,
        claim.generation,
        page.page_index,
        claim.owner,
      ),
    db
      .prepare(
        `UPDATE telegram_alert_source_events
            SET planning_cursor_chat_id = ?, target_plan_state = 'planning',
                target_plan_owner = ?, target_plan_claim_expires_at = ?
          WHERE source_event_id = ? AND target_plan_generation = ?
            AND target_plan_owner = ?
            AND target_plan_state IN ('planning', 'materializing')
            AND EXISTS (
              SELECT 1 FROM telegram_alert_target_plan_pages completed_page
               WHERE completed_page.source_event_id = telegram_alert_source_events.source_event_id
                 AND completed_page.plan_generation = telegram_alert_source_events.target_plan_generation
                 AND completed_page.page_index = ? AND completed_page.status = 'complete'
            )`,
      )
      .bind(
        page.last_chat_id,
        claim.owner,
        nowSec + TELEGRAM_TARGET_PLAN_CLAIM_TTL_SEC,
        claim.sourceEventId,
        claim.generation,
        claim.owner,
        page.page_index,
      ),
  ]);
  if (changed !== 2) {
    throw new Error(`Telegram target page resume CAS was not confirmed (${changed}/2)`);
  }
  return {
    found: true,
    complete: true,
    pageIndex: Number(page.page_index),
    firstChatId: page.first_chat_id,
    lastChatId: page.last_chat_id,
  };
}
