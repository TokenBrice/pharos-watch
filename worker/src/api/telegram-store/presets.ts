import { batchExecute } from "../../lib/db";
import type { PresetSubscriptionRow } from "../telegram-webhook-shared";
import { unixNow } from "./subscribers";
import { prepareSubscriberAndSubscriptionStatements } from "./subscriptions";

function preparePresetSubscriptionStatements(
  db: D1Database,
  chatId: string,
  presetIds: readonly string[],
  alertTypes: Set<string>,
  options?: { depegWorseningBpsStep?: 100 | 250 | 500 | null },
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

export async function upsertPresetSubscriptions(
  db: D1Database,
  chatId: string,
  presetIds: readonly string[],
  alertTypes: Set<string>,
  options?: { depegWorseningBpsStep?: 100 | 250 | 500 | null },
): Promise<void> {
  const statements = preparePresetSubscriptionStatements(db, chatId, presetIds, alertTypes, options);
  if (statements.length === 0) return;
  await batchExecute(db, statements);
}

export function prepareSubscriberAndPresetStatements(
  db: D1Database,
  chatId: string,
  username: string | null,
  presetIds: readonly string[],
  stablecoinIds: string[],
  alertTypes: Set<string>,
  options?: { clearPending?: boolean; depegWorseningBpsStep?: 100 | 250 | 500 | null },
): D1PreparedStatement[] {
  return [
    ...prepareSubscriberAndSubscriptionStatements(db, chatId, username, alertTypes, stablecoinIds, options),
    ...preparePresetSubscriptionStatements(db, chatId, presetIds, alertTypes, options),
  ];
}

export function prepareRemovePresetSubscriptionStatements(
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

export async function removePresetSubscriptions(
  db: D1Database,
  chatId: string,
  presetIds: readonly string[],
): Promise<void> {
  const statements = prepareRemovePresetSubscriptionStatements(db, chatId, presetIds);
  if (statements.length === 0) return;
  await statements[0].run();
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
