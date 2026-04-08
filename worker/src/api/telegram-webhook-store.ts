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

export async function persistPendingDisambiguation(
  db: D1Database,
  input: {
    chatId: string;
    actionType: PendingActionType;
    actionPayload: Record<string, unknown>;
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
         quiet_hours_end_utc
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
  const now = unixNow();
  await db
    .prepare(`
      INSERT INTO telegram_subscribers (
        chat_id,
        username,
        alert_dews,
        alert_depeg,
        alert_safety,
        alert_launch,
        global_alert_dews,
        global_alert_depeg,
        global_alert_safety,
        global_alert_launch,
        created_at,
        last_active_at
      )
      VALUES (?, ?, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        username = COALESCE(excluded.username, telegram_subscribers.username),
        global_alert_dews = MAX(telegram_subscribers.global_alert_dews, excluded.global_alert_dews),
        global_alert_depeg = MAX(telegram_subscribers.global_alert_depeg, excluded.global_alert_depeg),
        global_alert_safety = MAX(telegram_subscribers.global_alert_safety, excluded.global_alert_safety),
        global_alert_launch = MAX(telegram_subscribers.global_alert_launch, excluded.global_alert_launch),
        last_active_at = excluded.last_active_at
    `)
    .bind(
      chatId,
      username,
      alertTypes.has("dews") ? 1 : 0,
      alertTypes.has("depeg") ? 1 : 0,
      alertTypes.has("safety") ? 1 : 0,
      alertTypes.has("launch") ? 1 : 0,
      now,
      now,
    )
    .run();
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

  const statements: D1PreparedStatement[] = [];
  if (options?.clearPending) {
    statements.push(
      db.prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = ?").bind(chatId),
    );
  }

  statements.push(
    db.prepare(`
      INSERT INTO telegram_subscribers (
        chat_id,
        username,
        alert_dews,
        alert_depeg,
        alert_safety,
        alert_launch,
        global_alert_dews,
        global_alert_depeg,
        global_alert_safety,
        global_alert_launch,
        created_at,
        last_active_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        username = COALESCE(excluded.username, telegram_subscribers.username),
        alert_dews = MAX(telegram_subscribers.alert_dews, excluded.alert_dews),
        alert_depeg = MAX(telegram_subscribers.alert_depeg, excluded.alert_depeg),
        alert_safety = MAX(telegram_subscribers.alert_safety, excluded.alert_safety),
        alert_launch = MAX(telegram_subscribers.alert_launch, excluded.alert_launch),
        last_active_at = excluded.last_active_at
    `).bind(
      chatId,
      username,
      alertDews,
      alertDepeg,
      alertSafety,
      alertLaunch,
      now,
      now,
    ),
  );

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

  await db.batch(statements);
}

export async function applySettingToSubscriptions(
  db: D1Database,
  chatId: string,
  username: string | null,
  coins: ResolvedCoin[],
  command: ParsedSetCommand,
): Promise<void> {
  const now = unixNow();
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO telegram_subscribers (
        chat_id,
        username,
        alert_dews,
        alert_depeg,
        alert_safety,
        global_alert_dews,
        global_alert_depeg,
        global_alert_safety,
        created_at,
        last_active_at
      )
      VALUES (?, ?, 0, 0, 0, 0, 0, 0, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        username = COALESCE(excluded.username, telegram_subscribers.username),
        last_active_at = excluded.last_active_at
    `).bind(chatId, username, now, now),
  ];

  const enableGlobalTypes = new Set<string>();
  if (command.setting === "dews" && command.enabled) enableGlobalTypes.add("dews");
  if (command.setting === "depeg" && command.enabled) enableGlobalTypes.add("depeg");
  if (command.setting === "depeg-step") enableGlobalTypes.add("depeg");
  if (command.setting === "safety" && command.enabled) enableGlobalTypes.add("safety");

  if (enableGlobalTypes.size > 0) {
    statements.push(
      db.prepare(
        `UPDATE telegram_subscribers
            SET alert_dews = MAX(alert_dews, ?),
                alert_depeg = MAX(alert_depeg, ?),
                alert_safety = MAX(alert_safety, ?)
          WHERE chat_id = ?`,
      ).bind(
        enableGlobalTypes.has("dews") ? 1 : 0,
        enableGlobalTypes.has("depeg") ? 1 : 0,
        enableGlobalTypes.has("safety") ? 1 : 0,
        chatId,
      ),
    );
  }

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

  await db.batch(statements);
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
  const now = unixNow();
  const current = await loadSubscriberByChat(db, chatId);
  const next = {
    dews: current?.global_alert_dews ?? 0,
    depeg: current?.global_alert_depeg ?? 0,
    safety: current?.global_alert_safety ?? 0,
  };

  switch (command.setting) {
    case "dews":
      next.dews = command.enabled ? 1 : 0;
      break;
    case "depeg":
      next.depeg = command.enabled ? 1 : 0;
      break;
    case "safety":
      next.safety = command.enabled ? 1 : 0;
      break;
    case "depeg-step":
      throw new Error("Global depeg-step is not supported");
  }

  await db
    .prepare(`
      INSERT INTO telegram_subscribers (
        chat_id,
        username,
        alert_dews,
        alert_depeg,
        alert_safety,
        global_alert_dews,
        global_alert_depeg,
        global_alert_safety,
        created_at,
        last_active_at
      )
      VALUES (?, ?, 0, 0, 0, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        username = COALESCE(excluded.username, telegram_subscribers.username),
        global_alert_dews = excluded.global_alert_dews,
        global_alert_depeg = excluded.global_alert_depeg,
        global_alert_safety = excluded.global_alert_safety,
        last_active_at = excluded.last_active_at
    `)
    .bind(chatId, username, next.dews, next.depeg, next.safety, now, now)
    .run();
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
      `SELECT stablecoin_id, alert_dews, alert_depeg, alert_safety, dews_min_band, safety_mode, depeg_worsening_bps_step
         FROM telegram_subscriptions
        WHERE chat_id = ?
          AND stablecoin_id IN (${placeholders})
        ORDER BY stablecoin_id`,
    )
    .bind(chatId, ...uniqueIds)
    .all<SubscriptionRow>();
  return result.results ?? [];
}
