import type { ResolvedCoin } from "../lib/telegram-alerts";
import type {
  ParsedSetCommand,
  PendingActionType,
  SubscriberRow,
  SubscriptionRow,
} from "./telegram-webhook-shared";
import { DISAMBIGUATION_TTL_SEC } from "./telegram-webhook-shared";
import { dedupeCoins } from "./telegram-webhook-parsing";

export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

export interface UpsertSubscriberInput {
  chatId: string;
  username: string | null;
  nowSec: number;
  perCoinAlertBumps?: { dews?: 0 | 1; depeg?: 0 | 1; safety?: 0 | 1; launch?: 0 | 1 };
  globalAlertBumps?: { dews?: 0 | 1; depeg?: 0 | 1; safety?: 0 | 1; launch?: 0 | 1 };
  globalAlertOverrides?: { dews?: 0 | 1; depeg?: 0 | 1; safety?: 0 | 1; launch?: 0 | 1 };
  quietHours?:
    | { enabled: true; startHourUtc: number; endHourUtc: number }
    | { enabled: false };
}

const ALERT_KEYS = ["dews", "depeg", "safety", "launch"] as const;
type AlertKey = (typeof ALERT_KEYS)[number];

/**
 * Upserts a telegram_subscribers row. Any field left undefined preserves
 * existing values on conflict and defaults to 0/NULL on initial insert.
 *
 * - `perCoinAlertBumps` / `globalAlertBumps` use MAX(...) so per-coin actions
 *   never downgrade a flag.
 * - `globalAlertOverrides` replaces the value (used by `/set all ... off`).
 * - `quietHours` replaces unconditionally.
 */
export async function upsertSubscriberRow(
  db: D1Database,
  input: UpsertSubscriberInput,
): Promise<void> {
  if (input.globalAlertBumps && input.globalAlertOverrides) {
    // SQLite applies the UPDATE SET clauses left-to-right, so combining both
    // would silently let the override win for any shared column. Forbid it so
    // future callers cannot accidentally rely on evaluation order.
    throw new Error(
      "upsertSubscriberRow: globalAlertBumps and globalAlertOverrides cannot be combined",
    );
  }

  const quietStart = input.quietHours?.enabled ? input.quietHours.startHourUtc : null;
  const quietEnd = input.quietHours?.enabled ? input.quietHours.endHourUtc : null;
  const quietEnabled = input.quietHours?.enabled ? 1 : 0;

  const updates: string[] = [
    "username = COALESCE(excluded.username, telegram_subscribers.username)",
    "last_active_at = excluded.last_active_at",
  ];

  const perCoinRow = [0, 0, 0, 0];
  if (input.perCoinAlertBumps) {
    for (let i = 0; i < ALERT_KEYS.length; i += 1) {
      const key = ALERT_KEYS[i];
      const value = input.perCoinAlertBumps[key];
      if (value != null) {
        updates.push(
          `alert_${key} = MAX(telegram_subscribers.alert_${key}, excluded.alert_${key})`,
        );
        perCoinRow[i] = value;
      }
    }
  }

  const globalRow = [0, 0, 0, 0];
  if (input.globalAlertBumps) {
    for (let i = 0; i < ALERT_KEYS.length; i += 1) {
      const key = ALERT_KEYS[i];
      const value = input.globalAlertBumps[key];
      if (value != null) {
        updates.push(
          `global_alert_${key} = MAX(telegram_subscribers.global_alert_${key}, excluded.global_alert_${key})`,
        );
        globalRow[i] = value;
      }
    }
  }
  if (input.globalAlertOverrides) {
    for (let i = 0; i < ALERT_KEYS.length; i += 1) {
      const key: AlertKey = ALERT_KEYS[i];
      const value = input.globalAlertOverrides[key];
      if (value != null) {
        updates.push(`global_alert_${key} = excluded.global_alert_${key}`);
        globalRow[i] = value;
      }
    }
  }

  if (input.quietHours != null) {
    updates.push(
      "quiet_hours_enabled = excluded.quiet_hours_enabled",
      "quiet_hours_start_utc = excluded.quiet_hours_start_utc",
      "quiet_hours_end_utc = excluded.quiet_hours_end_utc",
    );
  }

  await db
    .prepare(`
      INSERT INTO telegram_subscribers (
        chat_id, username,
        alert_dews, alert_depeg, alert_safety, alert_launch,
        global_alert_dews, global_alert_depeg, global_alert_safety, global_alert_launch,
        quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc,
        created_at, last_active_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET ${updates.join(", ")}
    `)
    .bind(
      input.chatId,
      input.username,
      perCoinRow[0],
      perCoinRow[1],
      perCoinRow[2],
      perCoinRow[3],
      globalRow[0],
      globalRow[1],
      globalRow[2],
      globalRow[3],
      quietEnabled,
      quietStart,
      quietEnd,
      input.nowSec,
      input.nowSec,
    )
    .run();
}

export async function persistPendingDisambiguation(
  db: D1Database,
  input: {
    chatId: string;
    actionType: PendingActionType;
    actionPayload: object;
    resolvedCoins: ResolvedCoin[];
    ambiguousTicker: string;
    candidates: ResolvedCoin[];
    remainingTickers: string[];
    alertTypes?: Set<string>;
  },
): Promise<void> {
  await db
    .prepare(`
      INSERT INTO telegram_pending_disambiguation (
        chat_id,
        action_type,
        action_payload,
        alert_types,
        resolved_ids,
        ambiguous_ticker,
        candidates,
        remaining_tickers,
        expires_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        action_type = excluded.action_type,
        action_payload = excluded.action_payload,
        alert_types = excluded.alert_types,
        resolved_ids = excluded.resolved_ids,
        ambiguous_ticker = excluded.ambiguous_ticker,
        candidates = excluded.candidates,
        remaining_tickers = excluded.remaining_tickers,
        expires_at = excluded.expires_at
    `)
    .bind(
      input.chatId,
      input.actionType,
      JSON.stringify(input.actionPayload),
      JSON.stringify(Array.from(input.alertTypes ?? [])),
      JSON.stringify(dedupeCoins(input.resolvedCoins).map((coin) => coin.id)),
      input.ambiguousTicker,
      JSON.stringify(input.candidates),
      JSON.stringify(input.remainingTickers),
      unixNow() + DISAMBIGUATION_TTL_SEC,
    )
    .run();
}

export async function loadSubscriberByChat(
  db: D1Database,
  chatId: string,
): Promise<SubscriberRow | null> {
  return db
    .prepare(
      `SELECT
         alert_dews,
         alert_depeg,
         alert_safety,
         alert_launch,
         global_alert_dews,
         global_alert_depeg,
         global_alert_safety,
         global_alert_launch,
         quiet_hours_enabled,
         quiet_hours_start_utc,
         quiet_hours_end_utc,
         alert_snooze_until_ts
       FROM telegram_subscribers
      WHERE chat_id = ?`,
    )
    .bind(chatId)
    .first<SubscriberRow>();
}

export async function upsertGlobalAlertTypes(
  db: D1Database,
  chatId: string,
  username: string | null,
  alertTypes: Set<string>,
): Promise<void> {
  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: unixNow(),
    globalAlertBumps: {
      dews: alertTypes.has("dews") ? 1 : 0,
      depeg: alertTypes.has("depeg") ? 1 : 0,
      safety: alertTypes.has("safety") ? 1 : 0,
      launch: alertTypes.has("launch") ? 1 : 0,
    },
  });
}

export async function upsertSubscriberAndSubscriptions(
  db: D1Database,
  chatId: string,
  username: string | null,
  alertTypes: Set<string>,
  stablecoinIds: string[],
  options?: { clearPending?: boolean },
): Promise<void> {
  const now = unixNow();
  const alertDews = alertTypes.has("dews") ? 1 : 0;
  const alertDepeg = alertTypes.has("depeg") ? 1 : 0;
  const alertSafety = alertTypes.has("safety") ? 1 : 0;
  const alertLaunch = alertTypes.has("launch") ? 1 : 0;
  const uniqueStablecoinIds = Array.from(new Set(stablecoinIds));

  // The subscriber row cannot share a batch with subscriptions because the helper
  // uses a single .run(); run it first, then batch the subscriptions.
  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: now,
    perCoinAlertBumps: {
      dews: alertDews,
      depeg: alertDepeg,
      safety: alertSafety,
      launch: alertLaunch,
    },
  });

  const statements: D1PreparedStatement[] = [];
  if (options?.clearPending) {
    statements.push(
      db.prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = ?").bind(chatId),
    );
  }
  for (const stablecoinId of uniqueStablecoinIds) {
    statements.push(
      db.prepare(`
        INSERT INTO telegram_subscriptions (
          chat_id,
          stablecoin_id,
          alert_dews,
          alert_depeg,
          alert_safety,
          alert_launch
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
          alert_dews = MAX(telegram_subscriptions.alert_dews, excluded.alert_dews),
          alert_depeg = MAX(telegram_subscriptions.alert_depeg, excluded.alert_depeg),
          alert_safety = MAX(telegram_subscriptions.alert_safety, excluded.alert_safety),
          alert_launch = MAX(telegram_subscriptions.alert_launch, excluded.alert_launch)
      `).bind(chatId, stablecoinId, alertDews, alertDepeg, alertSafety, alertLaunch),
    );
  }
  if (statements.length > 0) await db.batch(statements);
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
        statements.push(
          db.prepare(`
            INSERT INTO telegram_subscriptions (
              chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, dews_min_band
            )
            VALUES (?, ?, ?, 0, 0, ?)
            ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
              alert_dews = excluded.alert_dews,
              dews_min_band = excluded.dews_min_band
          `).bind(chatId, coin.id, command.enabled ? 1 : 0, command.minBand),
        );
        break;
      case "safety":
        statements.push(
          db.prepare(`
            INSERT INTO telegram_subscriptions (
              chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, safety_mode
            )
            VALUES (?, ?, 0, 0, ?, ?)
            ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
              alert_safety = excluded.alert_safety,
              safety_mode = excluded.safety_mode
          `).bind(chatId, coin.id, command.enabled ? 1 : 0, command.mode),
        );
        break;
      case "depeg":
        statements.push(
          db.prepare(`
            INSERT INTO telegram_subscriptions (
              chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, depeg_worsening_bps_step
            )
            VALUES (?, ?, 0, ?, 0, NULL)
            ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
              alert_depeg = excluded.alert_depeg,
              depeg_worsening_bps_step = CASE WHEN excluded.alert_depeg = 0 THEN NULL ELSE telegram_subscriptions.depeg_worsening_bps_step END
          `).bind(chatId, coin.id, command.enabled ? 1 : 0),
        );
        break;
      case "depeg-step":
        statements.push(
          db.prepare(`
            INSERT INTO telegram_subscriptions (
              chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, depeg_worsening_bps_step
            )
            VALUES (?, ?, 0, 1, 0, ?)
            ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
              alert_depeg = 1,
              depeg_worsening_bps_step = excluded.depeg_worsening_bps_step
          `).bind(chatId, coin.id, command.step),
        );
        break;
    }
  }

  if (statements.length > 0) await db.batch(statements);
}

export function validateGlobalSetCommand(command: ParsedSetCommand): string | null {
  if (command.setting === "depeg-step") {
    return "Global all-stablecoin alerts do not support depeg-step. Use /set <ticker> depeg-step <value> for per-coin worsening alerts.";
  }
  if (command.setting === "dews" && command.enabled && command.minBand != null) {
    return "Global DEWS alerts only support the default ALERT threshold. Use /subscribe dews all or /set all dews off; WARNING/DANGER remain per-coin.";
  }
  if (command.setting === "safety" && command.enabled && command.mode != null) {
    return "Global safety alerts support all/off only. Upgrade-only and downgrade-only remain per-coin settings.";
  }
  return null;
}

export async function applyGlobalSetting(
  db: D1Database,
  chatId: string,
  username: string | null,
  command: ParsedSetCommand,
): Promise<void> {
  if (command.setting === "depeg-step") {
    throw new Error("Global depeg-step is not supported");
  }
  const override: 0 | 1 = command.enabled ? 1 : 0;

  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: unixNow(),
    globalAlertOverrides: { [command.setting]: override },
  });
}

export async function removeSubscriptions(
  db: D1Database,
  chatId: string,
  stablecoinIds: string[],
): Promise<void> {
  const uniqueIds = Array.from(new Set(stablecoinIds));
  if (uniqueIds.length === 0) return;

  const now = unixNow();
  const placeholders = uniqueIds.map(() => "?").join(", ");
  await db.batch([
    db.prepare(
      `DELETE FROM telegram_subscriptions WHERE chat_id = ? AND stablecoin_id IN (${placeholders})`,
    ).bind(chatId, ...uniqueIds),
    db.prepare("UPDATE telegram_subscribers SET last_active_at = ? WHERE chat_id = ?").bind(now, chatId),
  ]);
}

export async function clearPendingDisambiguation(
  db: D1Database,
  chatId: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = ?")
    .bind(chatId)
    .run();
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
      `SELECT stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch, dews_min_band, safety_mode, depeg_worsening_bps_step
         FROM telegram_subscriptions
        WHERE chat_id = ?
          AND stablecoin_id IN (${placeholders})
        ORDER BY stablecoin_id`,
    )
    .bind(chatId, ...uniqueIds)
    .all<SubscriptionRow>();
  return result.results ?? [];
}
