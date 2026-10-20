import type { TelegramAlertType } from "@shared/types/status";
import { D1_BATCH_SIZE } from "../../../lib/constants";
import { executeAtomicBatch } from "../../../lib/db";
import { TELEGRAM_ALERT_TTL_SEC } from "../../../telegram/common/constants";
import {
  assertTelegramPlanMaterializationFitsD1Batch,
  parseTelegramTargetPlan,
  serializeTelegramTargetPlan,
  TELEGRAM_TARGET_PLAN_MAX_CHUNKS,
  TELEGRAM_TARGET_PLAN_MAX_ITEMS,
  type SerializedTelegramTargetPlan,
} from "./telegram-alert-target-plan-contract";
import { strictestAlertTtlSec, type RoutedSubscriberAlert } from "../dispatch/dispatch-telegram-routing";
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
  created_at: number;
  attempt_count: number;
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
  if (decision.routed.length !== 1) {
    throw new Error("Eligible Telegram planning decision requires one consolidated target plan");
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
      return serializeTelegramTargetPlan(routed, resolveTelegramTargetExpiresAt(claim, routed));
    }),
  );
  return { outcome, plans };
}

export function resolveTelegramTargetExpiresAt(
  claim: Pick<TelegramTargetPlanningClaim, "detectedAt">,
  routed: Pick<RoutedSubscriberAlert, "alertType" | "alertTypes">,
): number {
  return claim.detectedAt + strictestAlertTtlSec(routed.alertTypes ?? [routed.alertType]);
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

const pendingMemberFenceSql = `SELECT 1 FROM telegram_alert_planning_subscribers member
  JOIN telegram_subscribers live ON live.chat_id = member.chat_id
  JOIN telegram_alert_source_events source ON source.source_event_id = member.source_event_id
 WHERE member.source_event_id = ? AND member.plan_generation = ? AND member.chat_id = ?
   AND member.planning_outcome = 'pending' AND live.preference_generation = ?
   AND source.target_plan_generation = member.plan_generation AND source.target_plan_owner = ?
   AND source.target_plan_state IN ('planning', 'materializing')
   AND source.expires_at > ? AND source.target_plan_claim_expires_at > ?`;

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
  const memberFenceBinds = [
    claim.sourceEventId, claim.generation, decision.subscriber.chatId,
    decision.currentPreferenceGeneration, claim.owner, nowSec, nowSec,
  ];
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
         ) SELECT ?, ?, ?, ?, ?, ?, ?, 1, 'materialized', ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (${pendingMemberFenceSql})
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
        ...memberFenceBinds,
      ),
    db.prepare(
      `INSERT OR IGNORE INTO telegram_alert_job_targets (
         job_id, target_key, chat_id, chunk_index, alert_type, status,
         pending_dedupe_key, created_at, source_event_id, plan_generation,
         plan_key, plan_ordinal, target_ordinal, target_schema_version,
         message_html, disable_notification, alert_scope_json,
         preference_generation, markup_policy_json, target_expires_at
       ) SELECT ?, json_extract(message.value, '$.targetKey'), plan.chat_id,
           json_extract(message.value, '$.chunkIndex'), plan.alert_type, 'planned',
           json_extract(message.value, '$.targetKey'), ?, plan.source_event_id, plan.plan_generation,
           plan.plan_key, plan.plan_ordinal, json_extract(message.value, '$.chunkIndex'), 1,
           json_extract(message.value, '$.html'), json_extract(plan.plan_payload_json, '$.disableNotification'),
           json_extract(plan.plan_payload_json, '$.alertScopeJson'), plan.preference_generation,
           json_extract(message.value, '$.markupPolicyJson'),
           json_extract(plan.plan_payload_json, '$.targetExpiresAt')
         FROM telegram_alert_target_plans plan, json_each(plan.plan_payload_json, '$.messages') message
        WHERE plan.source_event_id = ? AND plan.plan_generation = ? AND plan.plan_key = ?
          AND plan.chat_id = ? AND plan.plan_payload_digest = ?
          AND EXISTS (${pendingMemberFenceSql})`,
    ).bind(jobId, nowSec, claim.sourceEventId, claim.generation, plan.planKey,
      plan.payload.chatId, plan.payloadDigest, ...memberFenceBinds),
    db.prepare(
      `INSERT OR IGNORE INTO telegram_alert_target_plan_items (
         source_event_id, plan_generation, plan_key, item_key, created_at
       ) SELECT plan.source_event_id, plan.plan_generation, plan.plan_key, item.value, ?
         FROM telegram_alert_target_plans plan, json_each(plan.plan_payload_json, '$.itemKeys') item
        WHERE plan.source_event_id = ? AND plan.plan_generation = ? AND plan.plan_key = ?
          AND plan.chat_id = ? AND plan.plan_payload_digest = ?
          AND EXISTS (${pendingMemberFenceSql})`,
    ).bind(nowSec, claim.sourceEventId, claim.generation, plan.planKey,
      plan.payload.chatId, plan.payloadDigest, ...memberFenceBinds),
    db
      .prepare(
        `UPDATE telegram_alert_planning_subscribers
            SET planning_outcome = 'target_planned',
                planned_preference_generation = ?,
                planned_at = ?
          WHERE source_event_id = ?
            AND plan_generation = ?
            AND chat_id = ?
            AND planning_outcome = 'pending'
            AND EXISTS (${pendingMemberFenceSql})
            AND EXISTS (
              SELECT 1 FROM telegram_alert_target_plans plan
               WHERE plan.source_event_id = telegram_alert_planning_subscribers.source_event_id
                 AND plan.plan_generation = telegram_alert_planning_subscribers.plan_generation
                 AND plan.chat_id = telegram_alert_planning_subscribers.chat_id
                 AND plan.plan_key = ? AND plan.plan_payload_digest = ?
            )`,
      )
      .bind(
        decision.currentPreferenceGeneration,
        nowSec,
        claim.sourceEventId,
        claim.generation,
        decision.subscriber.chatId,
        ...memberFenceBinds,
        plan.planKey,
        plan.payloadDigest,
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
    decision: TelegramPlanningDecision;
  }[],
  nowSec: number,
): Promise<void> {
  let batchStatements: D1PreparedStatement[] = [];
  let batchPlans: SerializedTelegramTargetPlan[] = [];
  let batchUnits: Array<{ endIndex: number; plans: readonly SerializedTelegramTargetPlan[]; decision: TelegramPlanningDecision }> = [];
  const flush = async () => {
    const results = await executeAtomicBatch(db, batchStatements, { returnResults: true });
    const unadmitted = new Map<string, TelegramPlanningDecision>();
    for (const unit of batchUnits) {
      // The last statement finalizes the member in the same atomic plan unit.
      // A successful write can never later be excused as admission contention.
      if (results[unit.endIndex]?.meta?.changes === 0) {
        for (const plan of unit.plans) unadmitted.set(plan.planKey, unit.decision);
      }
    }
    await verifyMaterializedTargetPlans(db, claim, pageIndex, batchPlans, nowSec, unadmitted);
    batchStatements = [];
    batchPlans = [];
    batchUnits = [];
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
    batchUnits.push({ endIndex: batchStatements.length - 1, plans: unit.plans, decision: unit.decision });
  }
  if (batchStatements.length > 0) await flush();
}

async function verifyMaterializedTargetPlans(
  db: D1Database,
  claim: TelegramTargetPlanningClaim,
  pageIndex: number,
  expectedPlans: readonly SerializedTelegramTargetPlan[] | undefined,
  nowSec: number,
  unadmitted?: ReadonlyMap<string, TelegramPlanningDecision>,
): Promise<SerializedTelegramTargetPlan[]> {
  if (expectedPlans?.length === 0) return [];
  const expectedKeysJson = expectedPlans ? JSON.stringify(expectedPlans.map((plan) => plan.planKey)) : null;
  const rows = await db.prepare(
    `SELECT plan.*,
       (SELECT COUNT(*) FROM telegram_alert_job_targets target
         WHERE target.source_event_id = plan.source_event_id
           AND target.plan_generation = plan.plan_generation AND target.plan_key = plan.plan_key) AS targets,
       (SELECT COUNT(*) FROM telegram_alert_target_plan_items item
         WHERE item.source_event_id = plan.source_event_id
           AND item.plan_generation = plan.plan_generation AND item.plan_key = plan.plan_key) AS items,
       ${retainedPlanMismatchSql} AS mismatch
     FROM telegram_alert_target_plans plan
     WHERE source_event_id = ? AND plan_generation = ? AND page_index = ?
       AND (? IS NULL OR plan_key IN (SELECT value FROM json_each(?)))
     ORDER BY plan_ordinal`,
  ).bind(claim.sourceEventId, claim.generation, pageIndex,
    expectedKeysJson, expectedKeysJson)
    .all<{
      plan_key: string; plan_payload_json: string; plan_payload_digest: string;
      expected_target_count: number; materialized_target_count: number; chat_id: string;
      alert_type: string; preference_generation: number; status: string; schema_version: number;
      targets: number; items: number; mismatch: number;
    }>();
  const plans: SerializedTelegramTargetPlan[] = [];
  const expectedByKey = new Map(expectedPlans?.map((plan) => [plan.planKey, plan]));
  for (const row of rows.results ?? []) {
    const parsed = await parseTelegramTargetPlan(row.plan_payload_json, row.plan_payload_digest);
    const expected = expectedByKey.get(row.plan_key);
    if (parsed.kind !== "ok" ||
      row.status !== "materialized" || row.schema_version !== 1 ||
      (expected && (row.plan_payload_json !== expected.payloadJson || row.plan_payload_digest !== expected.payloadDigest)) ||
        row.plan_key !== `${parsed.value.chatId}:${parsed.value.alertType}:${row.plan_payload_digest.slice(0, 32)}` ||
        row.chat_id !== parsed.value.chatId || row.alert_type !== parsed.value.alertType ||
        row.preference_generation !== parsed.value.preferenceGeneration ||
        parsed.value.sourceEventId !== claim.sourceEventId ||
        row.expected_target_count !== parsed.value.messages.length ||
        row.materialized_target_count !== parsed.value.messages.length ||
        row.targets !== parsed.value.messages.length || row.items !== parsed.value.itemKeys.length ||
        row.mismatch !== 0) {
      await markTelegramTargetPlanDegraded(db, claim, "target_plan_manifest_mismatch", nowSec);
      throw new Error("Telegram target plan retained payload and rows did not reconcile");
    }
    plans.push({
      planKey: row.plan_key, payload: parsed.value,
      payloadJson: row.plan_payload_json, payloadDigest: row.plan_payload_digest,
    });
    expectedByKey.delete(row.plan_key);
  }
  if (expectedByKey.size > 0) {
    const missing = [...expectedByKey.values()].map((plan) => {
      const decision = unadmitted?.get(plan.planKey);
      return {
        planKey: plan.planKey,
        subscriber: decision?.subscriber,
        currentPreferenceGeneration: decision?.currentPreferenceGeneration,
      };
    });
    // Only intact pending members with a proven no-op unit and changed live
    // generation can wait for the next bounded planning pass. Erased members,
    // partial retained artifacts and unexplained missing plans still fail closed.
    const misses = await db.prepare(
      `SELECT COUNT(*) AS count FROM json_each(?) expected
        JOIN telegram_alert_planning_subscribers member
          ON member.source_event_id = ? AND member.plan_generation = ?
         AND member.chat_id = json_extract(expected.value, '$.subscriber.chatId')
        JOIN telegram_subscribers live ON live.chat_id = member.chat_id
        JOIN telegram_alert_source_events source ON source.source_event_id = member.source_event_id
       WHERE member.planning_outcome = 'pending'
         AND member.planned_preference_generation IS NULL AND member.planned_at IS NULL
         AND member.preference_generation = json_extract(expected.value, '$.subscriber.preferenceGeneration')
         AND member.last_active_at = json_extract(expected.value, '$.subscriber.lastActiveAt')
         AND member.initially_eligible = 1
         AND live.preference_generation > json_extract(expected.value, '$.currentPreferenceGeneration')
         AND source.target_plan_generation = member.plan_generation AND source.target_plan_owner = ?
         AND source.target_plan_state IN ('planning', 'materializing')
         AND source.expires_at > ? AND source.target_plan_claim_expires_at > ?
         AND NOT EXISTS (
           SELECT 1 FROM telegram_alert_target_plans plan
            WHERE plan.source_event_id = member.source_event_id AND plan.plan_generation = member.plan_generation
              AND plan.chat_id = member.chat_id)
         AND NOT EXISTS (
           SELECT 1 FROM telegram_alert_job_targets target
            WHERE target.source_event_id = member.source_event_id AND target.plan_generation = member.plan_generation
              AND target.chat_id = member.chat_id)
         AND NOT EXISTS (
           SELECT 1 FROM telegram_alert_target_plan_items item
            WHERE item.source_event_id = member.source_event_id AND item.plan_generation = member.plan_generation
              AND item.plan_key = json_extract(expected.value, '$.planKey'))`,
    ).bind(JSON.stringify(missing), claim.sourceEventId, claim.generation, claim.owner, nowSec, nowSec)
      .first<{ count: number }>();
    if (misses?.count !== expectedByKey.size) {
      await markTelegramTargetPlanDegraded(db, claim, "target_plan_count_mismatch", nowSec);
      throw new Error("Telegram target plan materialization did not reconcile");
    }
  }
  return plans;
}

// Compare identities and immutable delivery fields, not just equal row counts.
export const retainedPlanMismatchSql = `(
  EXISTS (
    SELECT 1 FROM json_each(plan.plan_payload_json, '$.messages') message
    WHERE NOT EXISTS (
      SELECT 1 FROM telegram_alert_job_targets target
       WHERE target.source_event_id = plan.source_event_id
         AND target.plan_generation = plan.plan_generation AND target.plan_key = plan.plan_key
         AND target.target_key = json_extract(message.value, '$.targetKey')
         AND target.pending_dedupe_key = target.target_key
         AND target.chunk_index = json_extract(message.value, '$.chunkIndex')
         AND target.target_ordinal = target.chunk_index AND target.plan_ordinal = plan.plan_ordinal
         AND target.target_schema_version = 1
         AND target.chat_id = plan.chat_id AND target.alert_type = plan.alert_type
         AND target.message_html = json_extract(message.value, '$.html')
         AND target.markup_policy_json = json_extract(message.value, '$.markupPolicyJson')
         AND target.preference_generation = plan.preference_generation
         AND target.disable_notification = json_extract(plan.plan_payload_json, '$.disableNotification')
         AND target.alert_scope_json = json_extract(plan.plan_payload_json, '$.alertScopeJson')
         AND target.target_expires_at = json_extract(plan.plan_payload_json, '$.targetExpiresAt')
    )
  ) OR EXISTS (
    SELECT 1 FROM json_each(plan.plan_payload_json, '$.itemKeys') expected
     WHERE NOT EXISTS (
       SELECT 1 FROM telegram_alert_target_plan_items item
        WHERE item.source_event_id = plan.source_event_id
          AND item.plan_generation = plan.plan_generation AND item.plan_key = plan.plan_key
          AND item.item_key = expected.value
     )
  )
)`;

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
              expected_target_count, created_at, attempt_count, status
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
    decision: TelegramPlanningDecision;
  }> = [];
  for (const [decisionIndex, decision] of decisions.entries()) {
    const entry = serialized[decisionIndex];
    if (entry.outcome !== "target_planned") {
      statementUnits.push({
        statements: [prepareNonTargetOutcomeStatement(db, claim, decision, entry.outcome, nowSec)],
        plans: [],
        decision,
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
        decision,
      });
    }
  }
  await executeTargetPlanStatementUnits(db, claim, pageIndex, statementUnits, nowSec);

  const sealed = await sealFinalizedTargetPlanPage(db, claim, persistedPage, nowSec, decisions);

  const outcomes: Record<TelegramPlanningOutcome, number> = {
    target_planned: 0,
    no_matching_scope: 0,
    preference_changed_ineligible: 0,
    eligible_after_event: 0,
    snapshot_missing: 0,
  };
  for (const entry of serialized) outcomes[entry.outcome] += 1;
  return { planCount: sealed.planCount, targetCount: sealed.targetCount, outcomes };
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
              expected_target_count, created_at, status
         FROM telegram_alert_target_plan_pages
        WHERE source_event_id = ? AND plan_generation = ? AND status = 'materializing'
        ORDER BY page_index LIMIT 1`,
    )
    .bind(claim.sourceEventId, claim.generation)
    .first<TargetPlanPageRow>();
  if (!page) {
    return { found: false, complete: false, pageIndex: null, firstChatId: null, lastChatId: null };
  }
  const sealed = await sealFinalizedTargetPlanPage(db, claim, page, nowSec);
  return {
    found: true,
    complete: sealed.complete,
    pageIndex: Number(page.page_index),
    firstChatId: page.first_chat_id,
    lastChatId: page.last_chat_id,
  };
}

interface FinalizedMemberRow {
  chat_id: string;
  planning_outcome: string;
  initially_eligible: number | null;
  planned_preference_generation: number | null;
  planned_at: number | null;
}

// The same ordered ledger is read before admission and compared inside the seal CAS.
const pageMemberLedgerSql = `(SELECT json_group_array(json_object(
  'chat_id', chat_id, 'planning_outcome', planning_outcome,
  'initially_eligible', initially_eligible,
  'planned_preference_generation', planned_preference_generation, 'planned_at', planned_at
)) FROM (
  SELECT * FROM telegram_alert_planning_subscribers
   WHERE source_event_id = page.source_event_id AND plan_generation = page.plan_generation
     AND chat_id >= page.first_chat_id AND chat_id <= page.last_chat_id ORDER BY chat_id
))`;
const pagePlanLedgerSql = `(SELECT json_group_array(json_object(
  'plan_key', plan_key, 'plan_payload_digest', plan_payload_digest,
  'chat_id', chat_id, 'preference_generation', preference_generation,
  'expected_target_count', expected_target_count, 'plan_ordinal', plan_ordinal
)) FROM (
  SELECT * FROM telegram_alert_target_plans
   WHERE source_event_id = page.source_event_id AND plan_generation = page.plan_generation
     AND page_index = page.page_index ORDER BY plan_ordinal
))`;

async function sealFinalizedTargetPlanPage(
  db: D1Database,
  claim: TelegramTargetPlanningClaim,
  page: TargetPlanPageRow,
  nowSec: number,
  decisions?: readonly TelegramPlanningDecision[],
): Promise<{ complete: boolean; planCount: number; targetCount: number }> {
  const ledger = await db.prepare(
    `SELECT ${pageMemberLedgerSql} AS members, ${pagePlanLedgerSql} AS plans,
            (SELECT planning_cursor_chat_id FROM telegram_alert_source_events source
              WHERE source.source_event_id = page.source_event_id) AS cursor
       FROM telegram_alert_target_plan_pages page
      WHERE source_event_id = ? AND plan_generation = ? AND page_index = ?`,
  ).bind(claim.sourceEventId, claim.generation, page.page_index)
    .first<{ members: string; plans: string; cursor: string | null }>();
  if (!ledger) throw new Error("Telegram target page ledger is missing");
  const members = JSON.parse(ledger.members) as FinalizedMemberRow[];
  const plans = await verifyMaterializedTargetPlans(db, claim, page.page_index, undefined, nowSec);
  const planCount = plans.length;
  const targetCount = plans.reduce((sum, plan) => sum + plan.payload.messages.length, 0);
  if (members.some((member) => member.planning_outcome === "pending")) {
    return { complete: false, planCount, targetCount };
  }
  const fail = async (reason: string): Promise<never> => {
    await markTelegramTargetPlanDegraded(db, claim, reason, nowSec);
    throw new Error(`Telegram target page retained manifest did not reconcile (${reason})`);
  };
  const plansByChat = new Map<string, SerializedTelegramTargetPlan>();
  for (const plan of plans) {
    if (plansByChat.has(plan.payload.chatId)) return fail("target_page_decision_mismatch");
    plansByChat.set(plan.payload.chatId, plan);
  }
  const finalOutcomes: Record<string, true> = {
    target_planned: true, no_matching_scope: true, preference_changed_ineligible: true,
    eligible_after_event: true,
  };
  for (const member of members) {
    const plan = plansByChat.get(member.chat_id);
    if (finalOutcomes[member.planning_outcome] !== true || member.planned_at == null ||
      member.planned_preference_generation == null || member.initially_eligible == null ||
      (member.planning_outcome === "target_planned"
        ? !plan || plan.payload.preferenceGeneration !== member.planned_preference_generation
        : plan != null)) return fail("target_page_decision_mismatch");
  }
  if (members.filter((member) => member.planning_outcome === "target_planned").length !== planCount) {
    return fail("target_page_decision_mismatch");
  }
  // A fresh full decision set proves this invocation's window. On recovery the
  // old forecast proves membership only for an entirely initially-eligible page:
  // every forecasted member must survive, even if its final decision has no plan.
  // Missing privacy/migration history is never reconstructed from target counts.
  const freshWindow = decisions != null && decisions.length === members.length &&
    decisions.every((decision, index) => decision.subscriber.chatId === members[index].chat_id) &&
    page.attempt_count === 0 && page.created_at === nowSec;
  if (members.length === 0 || members[0].chat_id !== page.first_chat_id ||
    members[members.length - 1].chat_id !== page.last_chat_id ||
    (!freshWindow && (members.length !== page.expected_plan_count ||
      members.some((member) => member.initially_eligible !== 1)))) {
    return fail("target_page_membership_unproven");
  }
  const changed = await executeAtomicBatch(db, [
    db.prepare(
      `UPDATE telegram_alert_target_plan_pages AS page
          SET status = 'complete', expected_plan_count = ?, materialized_plan_count = ?,
              expected_target_count = ?, materialized_target_count = ?, updated_at = ?, completed_at = ?
        WHERE source_event_id = ? AND plan_generation = ? AND page_index = ?
          AND status = 'materializing' AND first_chat_id = ? AND last_chat_id = ?
          AND expected_plan_count = ? AND expected_target_count = ?
          AND ${pageMemberLedgerSql} = ? AND ${pagePlanLedgerSql} = ?
          AND NOT EXISTS (
            SELECT 1 FROM telegram_alert_target_plans plan
             WHERE plan.source_event_id = page.source_event_id AND plan.plan_generation = page.plan_generation
               AND plan.page_index = page.page_index
               AND (plan.materialized_target_count <> plan.expected_target_count
                 OR plan.status <> 'materialized' OR plan.schema_version <> 1
                 OR plan.expected_target_count <> json_array_length(plan.plan_payload_json, '$.messages')
                 OR ${retainedPlanMismatchSql}
                 OR plan.expected_target_count <> (
                   SELECT COUNT(*) FROM telegram_alert_job_targets target
                    WHERE target.source_event_id = plan.source_event_id
                      AND target.plan_generation = plan.plan_generation AND target.plan_key = plan.plan_key)
                 OR json_array_length(plan.plan_payload_json, '$.itemKeys') <> (
                   SELECT COUNT(*) FROM telegram_alert_target_plan_items item
                    WHERE item.source_event_id = plan.source_event_id
                      AND item.plan_generation = plan.plan_generation AND item.plan_key = plan.plan_key))
          )
          AND EXISTS (
            SELECT 1 FROM telegram_alert_source_events source
             WHERE source.source_event_id = page.source_event_id
               AND source.target_plan_generation = page.plan_generation AND source.target_plan_owner = ?
               AND source.expires_at > ? AND source.target_plan_claim_expires_at > ?
               AND source.target_delivery_opened_at IS NULL
               AND source.planning_cursor_chat_id IS ?
               AND (source.target_plan_state IN ('planning', 'materializing') OR
                 (source.target_plan_state = 'degraded' AND source.target_delivery_opened_at IS NULL
                   AND source.last_error_class IN ('target_page_count_mismatch', 'target_page_resume_mismatch')))
          )`,
    ).bind(planCount, planCount, targetCount, targetCount, nowSec, nowSec,
      claim.sourceEventId, claim.generation, page.page_index, page.first_chat_id, page.last_chat_id,
      page.expected_plan_count, page.expected_target_count, ledger.members, ledger.plans,
      claim.owner, nowSec, nowSec, ledger.cursor),
    db.prepare(
      `UPDATE telegram_alert_source_events
          SET planning_cursor_chat_id = ?, target_plan_state = 'planning',
              target_plan_claim_expires_at = ?, last_error_class = NULL
        WHERE source_event_id = ? AND target_plan_generation = ? AND target_plan_owner = ?
          AND planning_cursor_chat_id IS ? AND expires_at > ? AND target_plan_claim_expires_at > ?
          AND target_delivery_opened_at IS NULL
          AND (target_plan_state IN ('planning', 'materializing') OR
            (target_plan_state = 'degraded'
              AND last_error_class IN ('target_page_count_mismatch', 'target_page_resume_mismatch')))
          AND EXISTS (
            SELECT 1 FROM telegram_alert_target_plan_pages page
             WHERE page.source_event_id = telegram_alert_source_events.source_event_id
               AND page.plan_generation = telegram_alert_source_events.target_plan_generation
               AND page.page_index = ? AND page.status = 'complete' AND page.completed_at = ?
          )`,
    ).bind(page.last_chat_id, nowSec + TELEGRAM_TARGET_PLAN_CLAIM_TTL_SEC,
      claim.sourceEventId, claim.generation, claim.owner, ledger.cursor, nowSec, nowSec, page.page_index, nowSec),
  ]);
  if (changed !== 2) throw new Error(`Telegram target page resume CAS was not confirmed (${changed}/2)`);
  return { complete: true, planCount, targetCount };
}
