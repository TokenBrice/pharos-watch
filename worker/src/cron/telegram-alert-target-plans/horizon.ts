import { D1_BATCH_SIZE } from "../../lib/constants";
import {
  buildInClause,
  executeAtomicBatch,
  prepareMultiRowInsertStatements,
} from "../../lib/db";
import {
  TELEGRAM_TARGET_PLAN_CLAIM_TTL_SEC,
  TELEGRAM_TARGET_PLAN_HORIZON_PAGE_SIZE,
  type TelegramPlanningSubscriber,
  type TelegramTargetPlanningClaim,
} from "./types";

interface SubscriberHorizonRow {
  chat_id: string;
  preference_generation: number;
  last_active_at: number;
}

export async function captureTelegramPlanningSubscriberPage(
  db: D1Database,
  claim: TelegramTargetPlanningClaim,
  nowSec: number,
  resolveInitialEligibility: (
    subscribers: readonly Omit<TelegramPlanningSubscriber, "initiallyEligible">[],
  ) => Promise<ReadonlyMap<string, { eligible: boolean; observedPreferenceGeneration: number }>>,
): Promise<{ captured: TelegramPlanningSubscriber[]; complete: boolean }> {
  if (claim.state !== "capturing") return { captured: [], complete: true };
  const rows = claim.highWaterChatId == null
    ? []
    : (await db
      .prepare(
        `SELECT chat_id, preference_generation, last_active_at
           FROM telegram_subscribers
          WHERE created_at <= ?
            AND chat_id <= ?
            AND (? IS NULL OR chat_id > ?)
          ORDER BY chat_id
          LIMIT ?`,
      )
      .bind(
        claim.horizonAt,
        claim.highWaterChatId,
        claim.subscriberCursorChatId,
        claim.subscriberCursorChatId,
        TELEGRAM_TARGET_PLAN_HORIZON_PAGE_SIZE,
      )
      .all<SubscriberHorizonRow>()).results ?? [];

  const capturedWithoutEligibility = rows.map((row) => ({
    chatId: row.chat_id,
    preferenceGeneration: Math.max(0, Math.floor(row.preference_generation ?? 0)),
    lastActiveAt: Number(row.last_active_at),
  }));
  const initialEligibility = rows.length > 0
    ? await resolveInitialEligibility(capturedWithoutEligibility)
    : new Map<string, { eligible: boolean; observedPreferenceGeneration: number }>();
  for (const subscriber of capturedWithoutEligibility) {
    const observed = initialEligibility.get(subscriber.chatId);
    if (!observed) {
      throw new Error("Telegram subscriber horizon is missing capture-time eligibility");
    }
    if (observed.observedPreferenceGeneration !== subscriber.preferenceGeneration) {
      throw new Error("Telegram subscriber preference changed before capture-time eligibility was recorded");
    }
  }
  if (capturedWithoutEligibility.length > 0) {
    const inClause = buildInClause(capturedWithoutEligibility.map((subscriber) => subscriber.chatId));
    const generationRows = await db
      .prepare(
        `SELECT chat_id, preference_generation
           FROM telegram_subscribers
          WHERE chat_id IN (${inClause.sql})`,
      )
      .bind(...inClause.binds)
      .all<{ chat_id: string; preference_generation: number }>();
    const currentGenerationByChat = new Map(
      (generationRows.results ?? []).map((row) => [row.chat_id, Number(row.preference_generation)]),
    );
    if (capturedWithoutEligibility.some((subscriber) =>
      currentGenerationByChat.get(subscriber.chatId) !== subscriber.preferenceGeneration)) {
      throw new Error("Telegram subscriber preference changed while its horizon snapshot was captured");
    }
  }
  const lastChatId = rows.length > 0 ? rows[rows.length - 1].chat_id : claim.subscriberCursorChatId;
  const complete = rows.length < TELEGRAM_TARGET_PLAN_HORIZON_PAGE_SIZE;
  const statements = prepareMultiRowInsertStatements(
    db,
    `INSERT OR IGNORE INTO telegram_alert_planning_subscribers (
       source_event_id, plan_generation, chat_id, preference_generation,
       last_active_at, captured_at, initially_eligible
     )`,
    rows.map((row) => [
      claim.sourceEventId,
      claim.generation,
      row.chat_id,
      Math.max(0, Math.floor(row.preference_generation ?? 0)),
      row.last_active_at,
      nowSec,
      initialEligibility.get(row.chat_id)?.eligible ? 1 : 0,
    ]),
  );
  statements.push(db
    .prepare(
      `UPDATE telegram_alert_source_events
          SET subscriber_cursor_chat_id = ?,
              target_plan_state = CASE WHEN ? = 1 THEN 'planning' ELSE 'capturing' END,
              target_plan_owner = ?,
              target_plan_claim_expires_at = ?
        WHERE source_event_id = ?
          AND target_plan_generation = ?
          AND target_plan_state = 'capturing'
          AND target_plan_owner = ?
          AND subscriber_cursor_chat_id IS ?`,
    )
    .bind(
      lastChatId,
      complete ? 1 : 0,
      claim.owner,
      nowSec + TELEGRAM_TARGET_PLAN_CLAIM_TTL_SEC,
      claim.sourceEventId,
      claim.generation,
      claim.owner,
      claim.subscriberCursorChatId,
    ));
  await executeAtomicBatch(db, statements);
  return {
    captured: capturedWithoutEligibility.map((row) => ({
      ...row,
      initiallyEligible: initialEligibility.get(row.chatId)?.eligible ?? null,
    })),
    complete,
  };
}

export async function persistTelegramInitialEligibility(
  db: D1Database,
  claim: TelegramTargetPlanningClaim,
  eligibilityByChat: ReadonlyMap<string, boolean>,
): Promise<void> {
  if (eligibilityByChat.size === 0) return;
  const statements = [...eligibilityByChat].map(([chatId, eligible]) => db
    .prepare(
      `UPDATE telegram_alert_planning_subscribers
          SET initially_eligible = COALESCE(initially_eligible, ?)
        WHERE source_event_id = ?
          AND plan_generation = ?
          AND chat_id = ?
          AND planning_outcome = 'pending'`,
    )
    .bind(eligible ? 1 : 0, claim.sourceEventId, claim.generation, chatId));
  for (let offset = 0; offset < statements.length; offset += D1_BATCH_SIZE) {
    await executeAtomicBatch(db, statements.slice(offset, offset + D1_BATCH_SIZE));
  }
}

export async function loadTelegramPlanningSubscriberPage(
  db: D1Database,
  claim: TelegramTargetPlanningClaim,
  limit = TELEGRAM_TARGET_PLAN_HORIZON_PAGE_SIZE,
  range?: { firstChatId: string; lastChatId: string },
): Promise<TelegramPlanningSubscriber[]> {
  const boundedLimit = Math.max(1, Math.min(TELEGRAM_TARGET_PLAN_HORIZON_PAGE_SIZE, Math.floor(limit)));
  const rows = await db
    .prepare(
      `SELECT chat_id, preference_generation, last_active_at, initially_eligible
         FROM telegram_alert_planning_subscribers
        WHERE source_event_id = ?
          AND plan_generation = ?
          AND planning_outcome = 'pending'
          AND (? IS NULL OR chat_id >= ?)
          AND (? IS NULL OR chat_id <= ?)
        ORDER BY chat_id
        LIMIT ?`,
    )
    .bind(
      claim.sourceEventId,
      claim.generation,
      range?.firstChatId ?? null,
      range?.firstChatId ?? null,
      range?.lastChatId ?? null,
      range?.lastChatId ?? null,
      boundedLimit,
    )
    .all<{
      chat_id: string;
      preference_generation: number;
      last_active_at: number;
      initially_eligible: number | null;
    }>();
  return (rows.results ?? []).map((row) => ({
    chatId: row.chat_id,
    preferenceGeneration: Number(row.preference_generation),
    lastActiveAt: Number(row.last_active_at),
    initiallyEligible: row.initially_eligible == null ? null : row.initially_eligible === 1,
  }));
}
