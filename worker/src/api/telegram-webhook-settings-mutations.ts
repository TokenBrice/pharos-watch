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
  subscriberHasGlobal,
  type DewsBandValue,
  type GlobalAlertType,
  type SafetyModeValue,
} from "./telegram-webhook-settings-shared";
import { batchExecute } from "../lib/db";
import { assertSubscribableCoin } from "../lib/telegram-subscription-eligibility";
import {
  buildDepegStepUpsert,
  buildDepegUpsert,
  buildDewsUpsert,
  buildLaunchUpsert,
  buildReserveUpsert,
  buildSafetyUpsert,
  loadSubscriberByChat,
  prepareUpsertSubscriberRow,
  unixNow,
  upsertSubscriberRow,
  type BuiltSubscriptionUpsert,
} from "./telegram-webhook-store";

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
  const prepared = prepareCoinSettingStatements(db, chatId, username, coinId, setting, value);
  if (prepared.description == null) return null;
  await batchExecute(db, prepared.statements);
  return prepared.description;
}

export function prepareCoinSettingStatements(
  db: D1Database,
  chatId: string,
  username: string | null,
  coinId: string,
  setting: string,
  value: string,
): { description: string | null; statements: D1PreparedStatement[] } {
  assertSubscribableCoin(coinId);
  if (setting === "db") return prepareDewsSetting(db, chatId, username, coinId, value);
  if (setting === "sm") return prepareSafetySetting(db, chatId, username, coinId, value);
  if (setting === "ds") return prepareDepegSetting(db, chatId, username, coinId, value);
  if (setting === "lc") return prepareLaunchSetting(db, chatId, username, coinId, value);
  if (setting === "rs") return prepareReserveSetting(db, chatId, username, coinId, value);
  return { description: null, statements: [] };
}

function prepareDewsSetting(
  db: D1Database,
  chatId: string,
  username: string | null,
  coinId: string,
  value: string,
): { description: string | null; statements: D1PreparedStatement[] } {
  if (value === "0") {
    return {
      description: "DEWS off.",
      statements: prepareDews(db, chatId, username, coinId, { enabled: false, minBand: null }),
    };
  }
  if (!isDewsBandCode(value)) return { description: null, statements: [] };
  const band = DEWS_BAND_CODES[value];
  return {
    description: `DEWS >= ${band}.`,
    statements: prepareDews(db, chatId, username, coinId, { enabled: true, minBand: band }),
  };
}

function prepareSafetySetting(
  db: D1Database,
  chatId: string,
  username: string | null,
  coinId: string,
  value: string,
): { description: string | null; statements: D1PreparedStatement[] } {
  if (value === "0") {
    return {
      description: "Safety off.",
      statements: prepareSafety(db, chatId, username, coinId, { enabled: false, mode: null }),
    };
  }
  if (!isSafetyModeCode(value)) return { description: null, statements: [] };
  const mode = SAFETY_MODE_CODES[value];
  return {
    description: `Safety ${mode}.`,
    statements: prepareSafety(db, chatId, username, coinId, { enabled: true, mode }),
  };
}

function prepareDepegSetting(
  db: D1Database,
  chatId: string,
  username: string | null,
  coinId: string,
  value: string,
): { description: string | null; statements: D1PreparedStatement[] } {
  if (value === "0") {
    return {
      description: "Depeg off.",
      statements: prepareDepeg(db, chatId, username, coinId, false),
    };
  }
  const step = Number(value);
  if (!isDepegStep(step)) return { description: null, statements: [] };
  return {
    description: `Depeg +${step}bps.`,
    statements: prepareDepegStep(db, chatId, username, coinId, step),
  };
}

/** Shared body for the three simple boolean alert prepare* functions (tg-3[mutations]). */
function prepareBooleanSetting(
  label: string,
  prepareFn: () => D1PreparedStatement[],
  value: string,
): { description: string | null; statements: D1PreparedStatement[] } {
  if (value !== "0" && value !== "1") return { description: null, statements: [] };
  const enabled = value === "1";
  return {
    description: enabled ? `${label} on.` : `${label} off.`,
    statements: prepareFn(),
  };
}

function prepareLaunchSetting(
  db: D1Database,
  chatId: string,
  username: string | null,
  coinId: string,
  value: string,
): { description: string | null; statements: D1PreparedStatement[] } {
  const enabled = value === "1";
  return prepareBooleanSetting("Launch", () => prepareBoolAlert(db, chatId, username, coinId, enabled, "launch", buildLaunchUpsert), value);
}

function prepareReserveSetting(
  db: D1Database,
  chatId: string,
  username: string | null,
  coinId: string,
  value: string,
): { description: string | null; statements: D1PreparedStatement[] } {
  const enabled = value === "1";
  return prepareBooleanSetting("Reserve", () => prepareBoolAlert(db, chatId, username, coinId, enabled, "reserve", buildReserveUpsert), value);
}

/** Shared body for the three simple boolean alert prepare* helpers (tg-2[mutations]). */
function prepareBoolAlert(
  db: D1Database,
  chatId: string,
  username: string | null,
  coinId: string,
  enabled: boolean,
  bumpKey: "reserve" | "depeg" | "launch",
  buildUpsert: (chatId: string, coinId: string, enabled: boolean) => BuiltSubscriptionUpsert,
): D1PreparedStatement[] {
  const now = unixNow();
  return [
    prepareUpsertSubscriberRow(db, {
      chatId,
      username,
      nowSec: now,
      perCoinAlertBumps: enabled ? { [bumpKey]: 1 } : undefined,
    }),
    prepareSubscriptionUpsert(db, buildUpsert(chatId, coinId, enabled)),
  ];
}

function prepareDews(
  db: D1Database,
  chatId: string,
  username: string | null,
  coinId: string,
  payload: { enabled: false; minBand: null } | { enabled: true; minBand: DewsBandValue },
): D1PreparedStatement[] {
  const now = unixNow();
  return [
    prepareUpsertSubscriberRow(db, {
      chatId,
      username,
      nowSec: now,
      perCoinAlertBumps: payload.enabled ? { dews: 1 } : undefined,
    }),
    prepareSubscriptionUpsert(db, buildDewsUpsert(chatId, coinId, payload.enabled, payload.minBand)),
  ];
}

function prepareSafety(
  db: D1Database,
  chatId: string,
  username: string | null,
  coinId: string,
  payload: { enabled: false; mode: null } | { enabled: true; mode: SafetyModeValue },
): D1PreparedStatement[] {
  const now = unixNow();
  return [
    prepareUpsertSubscriberRow(db, {
      chatId,
      username,
      nowSec: now,
      perCoinAlertBumps: payload.enabled ? { safety: 1 } : undefined,
    }),
    prepareSubscriptionUpsert(db, buildSafetyUpsert(chatId, coinId, payload.enabled, payload.mode)),
  ];
}

function prepareDepeg(
  db: D1Database,
  chatId: string,
  username: string | null,
  coinId: string,
  enabled: boolean,
): D1PreparedStatement[] {
  return prepareBoolAlert(db, chatId, username, coinId, enabled, "depeg", buildDepegUpsert);
}

function prepareDepegStep(
  db: D1Database,
  chatId: string,
  username: string | null,
  coinId: string,
  step: 100 | 250 | 500 | null,
): D1PreparedStatement[] {
  const now = unixNow();
  const statements = [
    prepareUpsertSubscriberRow(db, {
      chatId,
      username,
      nowSec: now,
      perCoinAlertBumps: { depeg: 1 },
    }),
  ];
  statements.push(prepareSubscriptionUpsert(db, buildDepegStepUpsert(chatId, coinId, step)));
  return statements;
}

function prepareSubscriptionUpsert(
  db: D1Database,
  upsert: BuiltSubscriptionUpsert,
): D1PreparedStatement {
  return db.prepare(upsert.sql).bind(...upsert.binds);
}
