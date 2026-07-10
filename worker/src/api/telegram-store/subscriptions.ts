import {
  batchExecute,
  chunkArray,
  D1_MAX_BOUND_PARAMETERS,
  D1_SAFE_IN_CLAUSE_BIND_LIMIT,
} from "../../lib/db";
import type { ResolvedCoin } from "../../lib/telegram-alerts";
import type {
  ParsedSetCommand,
  SubscriptionRow,
} from "../telegram-webhook-shared";
import {
  prepareUpsertSubscriberRow,
  unixNow,
  upsertSubscriberRow,
  type UpsertSubscriberInput,
} from "./subscribers";

export type DewsMinBandValue = "ALERT" | "WARNING" | "DANGER" | null;
export type SafetyModeValue = "all" | "downgrade-only" | "upgrade-only" | null;
export type DepegWorseningStepValue = 100 | 250 | 500 | null;

export interface BuiltSubscriptionUpsert {
  sql: string;
  binds: unknown[];
}

const SUBSCRIPTION_FOLLOW_BIND_COUNT = 13;
const SUBSCRIPTION_FOLLOWS_PER_STATEMENT = Math.floor(
  D1_MAX_BOUND_PARAMETERS / SUBSCRIPTION_FOLLOW_BIND_COUNT,
);
const SUBSCRIPTION_STATEMENT_COMPACTION_THRESHOLD = 50;

function bindSubscriptionUpsert(db: D1Database, upsert: BuiltSubscriptionUpsert): D1PreparedStatement {
  return db.prepare(upsert.sql).bind(...upsert.binds);
}

export function buildDewsUpsert(
  chatId: string,
  stablecoinId: string,
  enabled: boolean,
  minBand: DewsMinBandValue,
): BuiltSubscriptionUpsert {
  return {
    sql: `
      INSERT INTO telegram_subscriptions (
        chat_id, stablecoin_id, alert_dews, alert_dews_override, alert_depeg, alert_safety, dews_min_band
      )
      VALUES (?, ?, ?, 1, 0, 0, ?)
      ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
        alert_dews = excluded.alert_dews,
        alert_dews_override = 1,
        dews_min_band = excluded.dews_min_band
    `,
    binds: [chatId, stablecoinId, enabled ? 1 : 0, minBand],
  };
}

export function buildSafetyUpsert(
  chatId: string,
  stablecoinId: string,
  enabled: boolean,
  mode: SafetyModeValue,
): BuiltSubscriptionUpsert {
  return {
    sql: `
      INSERT INTO telegram_subscriptions (
        chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_safety_override, safety_mode
      )
      VALUES (?, ?, 0, 0, ?, 1, ?)
      ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
        alert_safety = excluded.alert_safety,
        alert_safety_override = 1,
        safety_mode = excluded.safety_mode
    `,
    binds: [chatId, stablecoinId, enabled ? 1 : 0, mode],
  };
}

export function buildDepegUpsert(
  chatId: string,
  stablecoinId: string,
  enabled: boolean,
): BuiltSubscriptionUpsert {
  return {
    sql: `
      INSERT INTO telegram_subscriptions (
        chat_id, stablecoin_id, alert_dews, alert_depeg, alert_depeg_override, alert_safety, depeg_worsening_bps_step
      )
      VALUES (?, ?, 0, ?, 1, 0, NULL)
      ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
        alert_depeg = excluded.alert_depeg,
        alert_depeg_override = 1,
        depeg_worsening_bps_step = CASE WHEN excluded.alert_depeg = 0 THEN NULL ELSE telegram_subscriptions.depeg_worsening_bps_step END
    `,
    binds: [chatId, stablecoinId, enabled ? 1 : 0],
  };
}

export function buildDepegStepUpsert(
  chatId: string,
  stablecoinId: string,
  step: DepegWorseningStepValue,
): BuiltSubscriptionUpsert {
  return {
    sql: `
      INSERT INTO telegram_subscriptions (
        chat_id, stablecoin_id, alert_dews, alert_depeg, alert_depeg_override, alert_safety, depeg_worsening_bps_step
      )
      VALUES (?, ?, 0, 1, 1, 0, ?)
      ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
        alert_depeg = 1,
        alert_depeg_override = 1,
        depeg_worsening_bps_step = excluded.depeg_worsening_bps_step
    `,
    binds: [chatId, stablecoinId, step],
  };
}

export function buildLaunchUpsert(
  chatId: string,
  stablecoinId: string,
  enabled: boolean,
): BuiltSubscriptionUpsert {
  return {
    sql: `
      INSERT INTO telegram_subscriptions (
        chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch, alert_launch_override
      )
      VALUES (?, ?, 0, 0, 0, ?, 1)
      ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
        alert_launch = excluded.alert_launch,
        alert_launch_override = 1
    `,
    binds: [chatId, stablecoinId, enabled ? 1 : 0],
  };
}

export function buildReserveUpsert(
  chatId: string,
  stablecoinId: string,
  enabled: boolean,
): BuiltSubscriptionUpsert {
  return {
    sql: `
      INSERT INTO telegram_subscriptions (
        chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_reserve, alert_reserve_override
      )
      VALUES (?, ?, 0, 0, 0, ?, 1)
      ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
        alert_reserve = excluded.alert_reserve,
        alert_reserve_override = 1
    `,
    binds: [chatId, stablecoinId, enabled ? 1 : 0],
  };
}

export async function loadSubscriptionRowsByChat(
  db: D1Database,
  chatId: string,
): Promise<SubscriptionRow[]> {
  const result = await db
    .prepare(
      `SELECT stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch, alert_reserve, dews_min_band, safety_mode, depeg_worsening_bps_step, alert_snooze_until_ts
         FROM telegram_subscriptions
        WHERE chat_id = ?
        ORDER BY stablecoin_id`,
    )
    .bind(chatId)
    .all<SubscriptionRow>();
  return result.results ?? [];
}

export function prepareSubscriberAndSubscriptionStatements(
  db: D1Database,
  chatId: string,
  username: string | null,
  alertTypes: Set<string>,
  stablecoinIds: string[],
  options?: { clearPending?: boolean; depegWorseningBpsStep?: 100 | 250 | 500 | null },
): D1PreparedStatement[] {
  const now = unixNow();
  const alertDews = alertTypes.has("dews") ? 1 : 0;
  const alertDepeg = alertTypes.has("depeg") || options?.depegWorseningBpsStep !== undefined ? 1 : 0;
  const alertSafety = alertTypes.has("safety") ? 1 : 0;
  const alertLaunch = alertTypes.has("launch") ? 1 : 0;
  const alertReserve = alertTypes.has("reserve") ? 1 : 0;
  const uniqueStablecoinIds = Array.from(new Set(stablecoinIds));

  const statements: D1PreparedStatement[] = [
    prepareUpsertSubscriberRow(db, {
      chatId,
      username,
      nowSec: now,
      perCoinAlertBumps: {
        dews: alertDews,
        depeg: alertDepeg,
        safety: alertSafety,
        launch: alertLaunch,
        reserve: alertReserve,
      },
    }),
  ];
  if (options?.clearPending) {
    statements.push(
      db.prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = ?").bind(chatId),
    );
  }
  const depegStepUpdate =
    options?.depegWorseningBpsStep === undefined
      ? "depeg_worsening_bps_step = telegram_subscriptions.depeg_worsening_bps_step"
      : "depeg_worsening_bps_step = excluded.depeg_worsening_bps_step";
  // Compact only large bulk-confirm payloads so every tracked-coin intent fits
  // inside one 100-statement atomic D1 batch.
  const stablecoinIdChunks = uniqueStablecoinIds.length > SUBSCRIPTION_STATEMENT_COMPACTION_THRESHOLD
    ? chunkArray(uniqueStablecoinIds, SUBSCRIPTION_FOLLOWS_PER_STATEMENT)
    : uniqueStablecoinIds.map((stablecoinId) => [stablecoinId]);
  for (const stablecoinIdChunk of stablecoinIdChunks) {
    const binds = stablecoinIdChunk.flatMap((stablecoinId) => [
      chatId,
      stablecoinId,
      alertDews,
      alertDepeg,
      alertSafety,
      alertLaunch,
      alertReserve,
      alertDews,
      alertDepeg,
      alertSafety,
      alertLaunch,
      alertReserve,
      options?.depegWorseningBpsStep ?? null,
    ]);
    const values = stablecoinIdChunk
      .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .join(", ");
    statements.push(
      db.prepare(`
        INSERT INTO telegram_subscriptions (
          chat_id,
          stablecoin_id,
          alert_dews,
          alert_depeg,
          alert_safety,
          alert_launch,
          alert_reserve,
          alert_dews_override,
          alert_depeg_override,
          alert_safety_override,
          alert_launch_override,
          alert_reserve_override,
          depeg_worsening_bps_step
        )
        VALUES ${values}
        ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
          alert_dews = MAX(telegram_subscriptions.alert_dews, excluded.alert_dews),
          alert_depeg = MAX(telegram_subscriptions.alert_depeg, excluded.alert_depeg),
          alert_safety = MAX(telegram_subscriptions.alert_safety, excluded.alert_safety),
          alert_launch = MAX(telegram_subscriptions.alert_launch, excluded.alert_launch),
          alert_reserve = MAX(telegram_subscriptions.alert_reserve, excluded.alert_reserve),
          alert_dews_override = MAX(telegram_subscriptions.alert_dews_override, excluded.alert_dews_override),
          alert_depeg_override = MAX(telegram_subscriptions.alert_depeg_override, excluded.alert_depeg_override),
          alert_safety_override = MAX(telegram_subscriptions.alert_safety_override, excluded.alert_safety_override),
          alert_launch_override = MAX(telegram_subscriptions.alert_launch_override, excluded.alert_launch_override),
          alert_reserve_override = MAX(telegram_subscriptions.alert_reserve_override, excluded.alert_reserve_override),
          ${depegStepUpdate}
      `).bind(...binds),
    );
  }
  return statements;
}

export async function upsertSubscriberAndSubscriptions(
  db: D1Database,
  chatId: string,
  username: string | null,
  alertTypes: Set<string>,
  stablecoinIds: string[],
  options?: { clearPending?: boolean; depegWorseningBpsStep?: 100 | 250 | 500 | null },
): Promise<void> {
  const statements = prepareSubscriberAndSubscriptionStatements(
    db,
    chatId,
    username,
    alertTypes,
    stablecoinIds,
    options,
  );
  if (statements.length > 0) await batchExecute(db, statements);
}

export async function applySettingToSubscriptions(
  db: D1Database,
  chatId: string,
  username: string | null,
  coins: ResolvedCoin[],
  command: ParsedSetCommand,
): Promise<void> {
  const now = unixNow();
  const perCoinAlertBumps: UpsertSubscriberInput["perCoinAlertBumps"] = {};
  if (command.setting === "dews" && command.enabled) perCoinAlertBumps.dews = 1;
  if (command.setting === "depeg" && command.enabled) perCoinAlertBumps.depeg = 1;
  if (command.setting === "depeg-step") perCoinAlertBumps.depeg = 1;
  if (command.setting === "safety" && command.enabled) perCoinAlertBumps.safety = 1;
  if (command.setting === "launch" && command.enabled) perCoinAlertBumps.launch = 1;
  if (command.setting === "reserve" && command.enabled) perCoinAlertBumps.reserve = 1;

  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: now,
    perCoinAlertBumps,
  });

  const statements: D1PreparedStatement[] = [];

  for (const coin of coins) {
    switch (command.setting) {
      case "dews":
        statements.push(bindSubscriptionUpsert(
          db,
          buildDewsUpsert(chatId, coin.id, command.enabled, command.minBand),
        ));
        break;
      case "safety":
        statements.push(bindSubscriptionUpsert(
          db,
          buildSafetyUpsert(chatId, coin.id, command.enabled, command.mode),
        ));
        break;
      case "launch":
        statements.push(bindSubscriptionUpsert(
          db,
          buildLaunchUpsert(chatId, coin.id, command.enabled),
        ));
        break;
      case "reserve":
        statements.push(bindSubscriptionUpsert(
          db,
          buildReserveUpsert(chatId, coin.id, command.enabled),
        ));
        break;
      case "depeg":
        statements.push(bindSubscriptionUpsert(
          db,
          buildDepegUpsert(chatId, coin.id, command.enabled),
        ));
        break;
      case "depeg-step":
        statements.push(bindSubscriptionUpsert(
          db,
          buildDepegStepUpsert(chatId, coin.id, command.step),
        ));
        break;
    }
  }

  if (statements.length > 0) await batchExecute(db, statements);
}

export function validateGlobalSetCommand(command: ParsedSetCommand): string | null {
  if (command.setting === "dews" && command.enabled && command.minBand != null) {
    return "Global DEWS alerts only support the default ALERT threshold. Use /subscribe dews all or /set all dews off; WARNING/DANGER remain per-coin.";
  }
  if (command.setting === "safety" && command.enabled && command.mode != null) {
    return "Global safety alerts support all/off only. Upgrade-only and downgrade-only remain per-coin settings.";
  }
  return null;
}

export async function setGlobalDepegWorseningStep(
  db: D1Database,
  chatId: string,
  username: string | null,
  step: 100 | 250 | 500 | null,
): Promise<void> {
  const now = unixNow();
  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: now,
    globalAlertBumps: { depeg: 1 },
  });
  await db
    .prepare(
      `UPDATE telegram_subscribers
          SET global_depeg_worsening_bps_step = ?,
              last_active_at = ?
        WHERE chat_id = ?`,
    )
    .bind(step, now, chatId)
    .run();
}

export async function applyGlobalSetting(
  db: D1Database,
  chatId: string,
  username: string | null,
  command: ParsedSetCommand,
): Promise<void> {
  if (command.setting === "depeg-step") {
    await setGlobalDepegWorseningStep(db, chatId, username, command.step);
    return;
  }
  const override: 0 | 1 = command.enabled ? 1 : 0;

  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: unixNow(),
    globalAlertOverrides: { [command.setting]: override },
  });
}

export function prepareRemoveSubscriptionStatements(
  db: D1Database,
  chatId: string,
  stablecoinIds: string[],
  options: { touchSubscriber?: boolean } = {},
): D1PreparedStatement[] {
  const deletes = prepareRemoveSubscriptionRowStatements(db, chatId, stablecoinIds);
  if (deletes.length === 0) return [];
  if (options.touchSubscriber === false) return deletes;
  return [
    ...deletes,
    prepareTouchSubscriberStatement(db, chatId),
  ];
}

function prepareRemoveSubscriptionRowStatements(
  db: D1Database,
  chatId: string,
  stablecoinIds: readonly string[],
): D1PreparedStatement[] {
  const uniqueIds = Array.from(new Set(stablecoinIds));
  if (uniqueIds.length === 0) return [];

  return chunkArray(uniqueIds, D1_SAFE_IN_CLAUSE_BIND_LIMIT - 1).map((idChunk) => {
    const placeholders = idChunk.map(() => "?").join(", ");
    return db.prepare(
      `DELETE FROM telegram_subscriptions WHERE chat_id = ? AND stablecoin_id IN (${placeholders})`,
    ).bind(chatId, ...idChunk);
  });
}

function prepareTouchSubscriberStatement(
  db: D1Database,
  chatId: string,
): D1PreparedStatement {
  return db
    .prepare("UPDATE telegram_subscribers SET last_active_at = ? WHERE chat_id = ?")
    .bind(unixNow(), chatId);
}

export async function removeSubscriptions(
  db: D1Database,
  chatId: string,
  stablecoinIds: string[],
): Promise<void> {
  const statements = prepareRemoveSubscriptionStatements(db, chatId, stablecoinIds);
  if (statements.length === 0) return;
  await db.batch(statements);
}

export async function loadSubscriptionsByIds(
  db: D1Database,
  chatId: string,
  stablecoinIds: string[],
): Promise<SubscriptionRow[]> {
  const uniqueIds = Array.from(new Set(stablecoinIds));
  if (uniqueIds.length === 0) return [];
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch, alert_reserve, dews_min_band, safety_mode, depeg_worsening_bps_step
         FROM telegram_subscriptions
        WHERE chat_id = ?
          AND stablecoin_id IN (${placeholders})
        ORDER BY stablecoin_id`,
    )
    .bind(chatId, ...uniqueIds)
    .all<SubscriptionRow>();
  return result.results ?? [];
}
