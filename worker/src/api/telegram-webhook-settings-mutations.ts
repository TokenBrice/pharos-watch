/**
 * D1 mutation helpers for the /settings inline-keyboard surface (P1-U7).
 * Kept separate from the render/dispatch code so each surface stays narrow.
 */

import {
  DEFAULT_QUIET_END_HOUR,
  DEFAULT_QUIET_START_HOUR,
  DEWS_BAND_CODES,
  SAFETY_MODE_CODES,
  isDepegStep,
  isDewsBandCode,
  isSafetyModeCode,
  type DewsBandValue,
  type GlobalAlertType,
  type SafetyModeValue,
} from "./telegram-webhook-settings-shared";
import {
  loadSubscriberByChat,
  unixNow,
  upsertSubscriberRow,
} from "./telegram-webhook-store";
import type { SubscriberRow } from "./telegram-webhook-shared";

export async function toggleGlobalAlert(
  db: D1Database,
  chatId: string,
  username: string | null,
  type: GlobalAlertType,
): Promise<void> {
  const subscriber = await loadSubscriberByChat(db, chatId);
  const next: 0 | 1 = subscriberHasGlobal(subscriber, type) ? 0 : 1;
  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: unixNow(),
    globalAlertOverrides: { [type]: next },
  });
}

export async function setQuietHours(
  db: D1Database,
  chatId: string,
  username: string | null,
  enabled: boolean,
): Promise<void> {
  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: unixNow(),
    quietHours: enabled
      ? { enabled: true, startHourUtc: DEFAULT_QUIET_START_HOUR, endHourUtc: DEFAULT_QUIET_END_HOUR }
      : { enabled: false },
  });
}

export async function clearSnoozeViaSettings(
  db: D1Database,
  chatId: string,
  username: string | null,
): Promise<void> {
  const now = unixNow();
  await db
    .prepare(
      `INSERT INTO telegram_subscribers (
         chat_id, username,
         alert_dews, alert_depeg, alert_safety, alert_launch,
         global_alert_dews, global_alert_depeg, global_alert_safety, global_alert_launch,
         quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc,
         alert_snooze_until_ts,
         created_at, last_active_at
       )
       VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         username = COALESCE(excluded.username, telegram_subscribers.username),
         alert_snooze_until_ts = NULL,
         last_active_at = excluded.last_active_at`,
    )
    .bind(chatId, username, now, now)
    .run();
}

/**
 * Apply a per-coin setting change. Returns a short user-facing description
 * string on success, or null if the setting/value pair is unrecognized.
 */
export async function applyCoinSetting(
  db: D1Database,
  chatId: string,
  username: string | null,
  coinId: string,
  setting: string,
  value: string,
): Promise<string | null> {
  if (setting === "db") return applyDewsSetting(db, chatId, username, coinId, value);
  if (setting === "sm") return applySafetySetting(db, chatId, username, coinId, value);
  if (setting === "ds") return applyDepegSetting(db, chatId, username, coinId, value);
  if (setting === "lc") return applyLaunchSetting(db, chatId, username, coinId, value);
  return null;
}

async function applyDewsSetting(
  db: D1Database,
  chatId: string,
  username: string | null,
  coinId: string,
  value: string,
): Promise<string | null> {
  if (value === "0") {
    await applyDews(db, chatId, username, coinId, { enabled: false, minBand: null });
    return "DEWS off.";
  }
  if (!isDewsBandCode(value)) return null;
  const band = DEWS_BAND_CODES[value];
  await applyDews(db, chatId, username, coinId, { enabled: true, minBand: band });
  return `DEWS >= ${band}.`;
}

async function applySafetySetting(
  db: D1Database,
  chatId: string,
  username: string | null,
  coinId: string,
  value: string,
): Promise<string | null> {
  if (value === "0") {
    await applySafety(db, chatId, username, coinId, { enabled: false, mode: null });
    return "Safety off.";
  }
  if (!isSafetyModeCode(value)) return null;
  const mode = SAFETY_MODE_CODES[value];
  await applySafety(db, chatId, username, coinId, { enabled: true, mode });
  return `Safety ${mode}.`;
}

async function applyDepegSetting(
  db: D1Database,
  chatId: string,
  username: string | null,
  coinId: string,
  value: string,
): Promise<string | null> {
  if (value === "0") {
    await applyDepegStep(db, chatId, username, coinId, null);
    return "Depeg off.";
  }
  const step = Number(value);
  if (!isDepegStep(step)) return null;
  await applyDepegStep(db, chatId, username, coinId, step);
  return `Depeg +${step}bps.`;
}

async function applyLaunchSetting(
  db: D1Database,
  chatId: string,
  username: string | null,
  coinId: string,
  value: string,
): Promise<string | null> {
  if (value !== "0" && value !== "1") return null;
  const enabled = value === "1";
  await applyLaunch(db, chatId, username, coinId, enabled);
  return enabled ? "Launch on." : "Launch off.";
}

async function applyDews(
  db: D1Database,
  chatId: string,
  username: string | null,
  coinId: string,
  payload: { enabled: false; minBand: null } | { enabled: true; minBand: DewsBandValue },
): Promise<void> {
  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: unixNow(),
    perCoinAlertBumps: payload.enabled ? { dews: 1 } : undefined,
  });
  await db
    .prepare(`
      INSERT INTO telegram_subscriptions (
        chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, dews_min_band
      )
      VALUES (?, ?, ?, 0, 0, ?)
      ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
        alert_dews = excluded.alert_dews,
        dews_min_band = excluded.dews_min_band
    `)
    .bind(chatId, coinId, payload.enabled ? 1 : 0, payload.minBand)
    .run();
}

async function applySafety(
  db: D1Database,
  chatId: string,
  username: string | null,
  coinId: string,
  payload: { enabled: false; mode: null } | { enabled: true; mode: SafetyModeValue },
): Promise<void> {
  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: unixNow(),
    perCoinAlertBumps: payload.enabled ? { safety: 1 } : undefined,
  });
  await db
    .prepare(`
      INSERT INTO telegram_subscriptions (
        chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, safety_mode
      )
      VALUES (?, ?, 0, 0, ?, ?)
      ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
        alert_safety = excluded.alert_safety,
        safety_mode = excluded.safety_mode
    `)
    .bind(chatId, coinId, payload.enabled ? 1 : 0, payload.mode)
    .run();
}

async function applyDepegStep(
  db: D1Database,
  chatId: string,
  username: string | null,
  coinId: string,
  step: 100 | 250 | 500 | null,
): Promise<void> {
  const enabled = step != null;
  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: unixNow(),
    perCoinAlertBumps: enabled ? { depeg: 1 } : undefined,
  });
  if (enabled) {
    await db
      .prepare(`
        INSERT INTO telegram_subscriptions (
          chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, depeg_worsening_bps_step
        )
        VALUES (?, ?, 0, 1, 0, ?)
        ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
          alert_depeg = 1,
          depeg_worsening_bps_step = excluded.depeg_worsening_bps_step
      `)
      .bind(chatId, coinId, step)
      .run();
    return;
  }
  await db
    .prepare(`
      INSERT INTO telegram_subscriptions (
        chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, depeg_worsening_bps_step
      )
      VALUES (?, ?, 0, 0, 0, NULL)
      ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
        alert_depeg = 0,
        depeg_worsening_bps_step = NULL
    `)
    .bind(chatId, coinId)
    .run();
}

async function applyLaunch(
  db: D1Database,
  chatId: string,
  username: string | null,
  coinId: string,
  enabled: boolean,
): Promise<void> {
  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: unixNow(),
    perCoinAlertBumps: enabled ? { launch: 1 } : undefined,
  });
  await db
    .prepare(`
      INSERT INTO telegram_subscriptions (
        chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch
      )
      VALUES (?, ?, 0, 0, 0, ?)
      ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
        alert_launch = excluded.alert_launch
    `)
    .bind(chatId, coinId, enabled ? 1 : 0)
    .run();
}

function subscriberHasGlobal(subscriber: SubscriberRow | null, type: GlobalAlertType): boolean {
  if (!subscriber) return false;
  if (type === "dews") return Boolean(subscriber.global_alert_dews);
  if (type === "depeg") return Boolean(subscriber.global_alert_depeg);
  if (type === "safety") return Boolean(subscriber.global_alert_safety);
  return Boolean(subscriber.global_alert_launch);
}
