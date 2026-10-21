import { executeAtomicBatch } from "../../lib/db";
import type { PresetSubscriptionRow } from "../webhook/telegram-webhook-shared";
import {
  preparePreferenceGenerationBump,
  unixNow,
  prepareTelegramFirstFollowStatements,
} from "./subscribers";
import {
  prepareRemoveSubscriptionStatements,
  prepareSubscriberAndSubscriptionStatements,
} from "./subscriptions";
import {
  appendTelegramOperationStatements,
  type TelegramOperationBatchOptions,
} from "../delivery/operation-batch";

export interface SubscribeIntentInput {
  chatId: string;
  username: string | null;
  directStablecoinIds: readonly string[];
  presetIds?: readonly string[];
  alertTypes: Set<string>;
  depegWorseningBpsStep?: 100 | 250 | 500 | null;
  operationStatements?: D1PreparedStatement[];
}

export interface UnsubscribeIntentInput {
  chatId: string;
  directStablecoinIds: readonly string[];
  presetIds?: readonly string[];
  operationStatements?: D1PreparedStatement[];
}

function preparePresetSubscriptionStatements(
  db: D1Database,
  chatId: string,
  presetIds: readonly string[],
  alertTypes: Set<string>,
  options?: { depegWorseningBpsStep?: 100 | 250 | 500 | null; operationStatements?: D1PreparedStatement[] },
): D1PreparedStatement[] {
  const uniquePresetIds = Array.from(new Set(presetIds));
  if (uniquePresetIds.length === 0) return [];
  const now = unixNow();
  return uniquePresetIds.map((presetId) => {
    const depegStepUpdate =
      options?.depegWorseningBpsStep === undefined
        ? "depeg_worsening_bps_step = telegram_preset_subscriptions.depeg_worsening_bps_step"
        : "depeg_worsening_bps_step = excluded.depeg_worsening_bps_step";
    return db.prepare(`
      INSERT INTO telegram_preset_subscriptions (
        chat_id,
        preset_id,
        alert_dews,
        alert_depeg,
        alert_safety,
        depeg_worsening_bps_step,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, preset_id) DO UPDATE SET
        alert_dews = MAX(telegram_preset_subscriptions.alert_dews, excluded.alert_dews),
        alert_depeg = MAX(telegram_preset_subscriptions.alert_depeg, excluded.alert_depeg),
        alert_safety = MAX(telegram_preset_subscriptions.alert_safety, excluded.alert_safety),
        ${depegStepUpdate},
        updated_at = excluded.updated_at
    `).bind(
      chatId,
      presetId,
      alertTypes.has("dews") ? 1 : 0,
      alertTypes.has("depeg") || options?.depegWorseningBpsStep !== undefined ? 1 : 0,
      alertTypes.has("safety") ? 1 : 0,
      options?.depegWorseningBpsStep ?? null,
      now,
      now,
    );
  });
}

export function prepareSubscriberAndPresetStatements(
  db: D1Database,
  chatId: string,
  username: string | null,
  presetIds: readonly string[],
  directStablecoinIds: string[],
  alertTypes: Set<string>,
  options?: { depegWorseningBpsStep?: 100 | 250 | 500 | null },
): D1PreparedStatement[] {
  return [
    ...(presetIds.length > 0 && (options?.depegWorseningBpsStep !== undefined || ["dews", "depeg", "safety"].some((type) => alertTypes.has(type)))
      ? prepareTelegramFirstFollowStatements(db, { chatId, username, nowSec: unixNow(), feature: "preset" })
      : []),
    ...prepareSubscriberAndSubscriptionStatements(db, chatId, username, alertTypes, directStablecoinIds, options),
    ...preparePresetSubscriptionStatements(db, chatId, presetIds, alertTypes, options),
  ];
}

/** Merge Mini App presence flags against the transaction's row, never a prior read. */
export function prepareSubscriberAndPresetPatchStatements(
  db: D1Database,
  chatId: string,
  username: string | null,
  presetId: string,
  alertTypes: Partial<Record<"dews" | "depeg" | "safety", boolean>>,
  depegWorseningBpsStep: 100 | 250 | 500 | null | undefined,
): D1PreparedStatement[] {
  const now = unixNow();
  const merged = `WITH patch AS (
    SELECT
      CASE WHEN ? THEN ? ELSE COALESCE(p.alert_dews, 0) END AS dews,
      CASE WHEN ? THEN ? WHEN ? IS NOT NULL THEN 1 ELSE COALESCE(p.alert_depeg, 0) END AS depeg,
      CASE WHEN ? THEN ? ELSE COALESCE(p.alert_safety, 0) END AS safety,
      CASE WHEN ? THEN ? ELSE p.depeg_worsening_bps_step END AS step
    FROM (SELECT 1) LEFT JOIN telegram_preset_subscriptions p
      ON p.chat_id = ? AND p.preset_id = ?
  ), admitted AS (
    SELECT dews, depeg, safety, CASE WHEN depeg = 1 THEN step ELSE NULL END AS step
    FROM patch WHERE dews = 1 OR depeg = 1 OR safety = 1
  )`;
  const binds = [
    alertTypes.dews !== undefined ? 1 : 0, alertTypes.dews ? 1 : 0,
    alertTypes.depeg !== undefined ? 1 : 0, alertTypes.depeg ? 1 : 0, depegWorseningBpsStep ?? null,
    alertTypes.safety !== undefined ? 1 : 0, alertTypes.safety ? 1 : 0,
    depegWorseningBpsStep !== undefined ? 1 : 0, depegWorseningBpsStep ?? null,
    chatId, presetId,
  ];
  // Every statement sees the same preset until the final write. Invalid
  // last-family removals therefore change neither domain nor first-follow state.
  return [
    db.prepare(`${merged}
      INSERT OR IGNORE INTO telegram_subscribers (chat_id, username, created_at, last_active_at)
      SELECT ?, ?, ?, ? FROM admitted
    `).bind(...binds, chatId, username, now, now),
    ...prepareTelegramFirstFollowStatements(db, {
      chatId, username, nowSec: now, feature: "preset",
      ensureSubscriber: false,
      guard: { sql: `EXISTS (${merged} SELECT 1 FROM admitted)`, binds },
    }),
    db.prepare(`${merged}
      UPDATE telegram_subscribers SET
        username = COALESCE(?, username), last_active_at = ?,
        preference_generation = preference_generation + 1,
        alert_dews = MAX(alert_dews, (SELECT dews FROM admitted)),
        alert_depeg = MAX(alert_depeg, (SELECT depeg FROM admitted)),
        alert_safety = MAX(alert_safety, (SELECT safety FROM admitted))
      WHERE chat_id = ? AND EXISTS (SELECT 1 FROM admitted)
    `).bind(...binds, username, now, chatId),
    db.prepare(`${merged}
      INSERT INTO telegram_preset_subscriptions (
        chat_id, preset_id, alert_dews, alert_depeg, alert_safety,
        depeg_worsening_bps_step, created_at, updated_at
      ) SELECT ?, ?, dews, depeg, safety, step, ?, ? FROM admitted WHERE true
      ON CONFLICT(chat_id, preset_id) DO UPDATE SET
        alert_dews = excluded.alert_dews, alert_depeg = excluded.alert_depeg,
        alert_safety = excluded.alert_safety, depeg_worsening_bps_step = excluded.depeg_worsening_bps_step,
        updated_at = excluded.updated_at
    `).bind(...binds, chatId, presetId, now, now),
  ];
}

function prepareSubscribeIntentStatements(
  db: D1Database,
  input: SubscribeIntentInput,
): D1PreparedStatement[] {
  return prepareSubscriberAndPresetStatements(
    db,
    input.chatId,
    input.username,
    input.presetIds ?? [],
    [...input.directStablecoinIds],
    input.alertTypes,
    { depegWorseningBpsStep: input.depegWorseningBpsStep },
  );
}

export async function applySubscribeIntent(
  db: D1Database,
  input: SubscribeIntentInput,
): Promise<void> {
  await executeAtomicBatch(
    db,
    appendTelegramOperationStatements(prepareSubscribeIntentStatements(db, input), input),
  );
}

function prepareRemovePresetSubscriptionStatements(
  db: D1Database,
  chatId: string,
  presetIds: readonly string[],
): D1PreparedStatement[] {
  const uniquePresetIds = Array.from(new Set(presetIds));
  if (uniquePresetIds.length === 0) return [];
  const placeholders = uniquePresetIds.map(() => "?").join(", ");
  return [
    db.prepare(`DELETE FROM telegram_preset_subscriptions WHERE chat_id = ? AND preset_id IN (${placeholders})`)
      .bind(chatId, ...uniquePresetIds),
  ];
}

function prepareUnsubscribeIntentStatements(
  db: D1Database,
  input: UnsubscribeIntentInput,
): D1PreparedStatement[] {
  const directStablecoinIds = Array.from(new Set(input.directStablecoinIds));
  const presetIds = Array.from(new Set(input.presetIds ?? []));
  if (directStablecoinIds.length === 0 && presetIds.length === 0) return [];

  return [
    ...prepareRemoveSubscriptionStatements(db, input.chatId, directStablecoinIds, { touchSubscriber: false }),
    ...prepareRemovePresetSubscriptionStatements(db, input.chatId, presetIds),
    preparePreferenceGenerationBump(db, input.chatId),
  ];
}

export async function applyUnsubscribeIntent(
  db: D1Database,
  input: UnsubscribeIntentInput,
): Promise<void> {
  await executeAtomicBatch(
    db,
    appendTelegramOperationStatements(prepareUnsubscribeIntentStatements(db, input), input),
  );
}

export async function removePresetSubscriptions(
  db: D1Database,
  chatId: string,
  presetIds: readonly string[],
  options: TelegramOperationBatchOptions = {},
): Promise<void> {
  const statements = prepareRemovePresetSubscriptionStatements(db, chatId, presetIds);
  const domainStatements = statements.length === 0
    ? []
    : [...statements, preparePreferenceGenerationBump(db, chatId)];
  const atomicStatements = appendTelegramOperationStatements(domainStatements, options);
  if (atomicStatements.length === 0) return;
  await executeAtomicBatch(db, atomicStatements);
}

export async function loadPresetSubscriptions(
  db: D1Database,
  chatId: string,
): Promise<PresetSubscriptionRow[]> {
  const result = await db
    .prepare(
      `SELECT preset_id, alert_dews, alert_depeg, alert_safety, depeg_worsening_bps_step
         FROM telegram_preset_subscriptions
        WHERE chat_id = ?
        ORDER BY preset_id`,
    )
    .bind(chatId)
    .all<PresetSubscriptionRow>();
  return result.results ?? [];
}
