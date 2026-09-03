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
import { executeAtomicBatch } from "../lib/db";
import { assertSubscribableCoin } from "../lib/telegram/subscription-eligibility";
import {
  buildDepegStepUpsert,
  buildDepegUpsert,
  buildDewsUpsert,
  buildPlainAlertUpsert,
  buildSafetyUpsert,
  loadSubscriberByChat,
  prepareUpsertSubscriberRow,
  unixNow,
  upsertSubscriberRow,
  type BuiltSubscriptionUpsert,
  type PlainAlertType,
} from "./telegram-webhook-store";
import type { TelegramOperationBatchOptions } from "../lib/telegram/operation-batch";
import {
  TELEGRAM_ALERT_FAMILY_SHORT_LABELS,
  TELEGRAM_ALERT_PERSISTENCE,
} from "@shared/lib/telegram-alert-families";
import type { TelegramAlertType } from "@shared/types/status";

export async function toggleGlobalAlert(
  db: D1Database,
  chatId: string,
  username: string | null,
  type: GlobalAlertType,
  options: TelegramOperationBatchOptions & { next?: 0 | 1 } = {},
): Promise<void> {
  const subscriber = await loadSubscriberByChat(db, chatId);
  const next: 0 | 1 = options.next ?? (subscriberHasGlobal(subscriber, type) ? 0 : 1);
  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: unixNow(),
    globalAlertOverrides: { [type]: next },
  }, options);
}

export async function setQuietHours(
  db: D1Database,
  chatId: string,
  username: string | null,
  enabled: boolean,
  options: TelegramOperationBatchOptions = {},
): Promise<void> {
  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: unixNow(),
    quietHours: enabled
      ? { enabled: true, startHourUtc: DEFAULT_QUIET_START_HOUR, endHourUtc: DEFAULT_QUIET_END_HOUR }
      : { enabled: false },
  }, options);
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
  options: TelegramOperationBatchOptions = {},
): Promise<string | null> {
  const prepared = prepareCoinSettingStatements(db, chatId, username, coinId, setting, value);
  if (prepared.description == null) return null;
  await executeAtomicBatch(db, [...prepared.statements, ...(options.operationStatements ?? [])]);
  return prepared.description;
}

type CoinSettingPreparer = (
  db: D1Database,
  chatId: string,
  username: string | null,
  coinId: string,
  value: string,
) => { description: string | null; statements: D1PreparedStatement[] };

/** Families whose `/settings` value needs a bespoke parser (band/mode/step). */
const TUNED_SETTING_PREPARERS: Record<string, CoinSettingPreparer | undefined> = {
  [TELEGRAM_ALERT_PERSISTENCE.dews.settingCode]: (...args) => prepareDewsSetting(...args),
  [TELEGRAM_ALERT_PERSISTENCE.safety.settingCode]: (...args) => prepareSafetySetting(...args),
  [TELEGRAM_ALERT_PERSISTENCE.depeg.settingCode]: (...args) => prepareDepegSetting(...args),
};

/** Plain on/off families, addressed by their registry setting code. */
const PLAIN_ALERT_TYPE_BY_SETTING_CODE: Record<string, PlainAlertType | undefined> = {
  [TELEGRAM_ALERT_PERSISTENCE.launch.settingCode]: "launch",
  [TELEGRAM_ALERT_PERSISTENCE.reserve.settingCode]: "reserve",
  [TELEGRAM_ALERT_PERSISTENCE.freeze.settingCode]: "freeze",
};

/** `/settings` says "Freeze alerts", not the bare family short label. */
const PLAIN_SETTING_LABELS: Record<PlainAlertType, string> = {
  launch: TELEGRAM_ALERT_FAMILY_SHORT_LABELS.launch,
  reserve: TELEGRAM_ALERT_FAMILY_SHORT_LABELS.reserve,
  freeze: `${TELEGRAM_ALERT_FAMILY_SHORT_LABELS.freeze} alerts`,
};

export function prepareCoinSettingStatements(
  db: D1Database,
  chatId: string,
  username: string | null,
  coinId: string,
  setting: string,
  value: string,
): { description: string | null; statements: D1PreparedStatement[] } {
  assertSubscribableCoin(coinId);
  const tuned = TUNED_SETTING_PREPARERS[setting];
  if (tuned) return tuned(db, chatId, username, coinId, value);
  const plainAlertType = PLAIN_ALERT_TYPE_BY_SETTING_CODE[setting];
  if (plainAlertType) {
    return preparePlainAlertSetting(db, chatId, username, coinId, plainAlertType, value);
  }
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

/** One body for every plain on/off family, addressed from the registry. */
function preparePlainAlertSetting(
  db: D1Database,
  chatId: string,
  username: string | null,
  coinId: string,
  alertType: PlainAlertType,
  value: string,
): { description: string | null; statements: D1PreparedStatement[] } {
  if (value !== "0" && value !== "1") return { description: null, statements: [] };
  const enabled = value === "1";
  const label = PLAIN_SETTING_LABELS[alertType];
  return {
    description: enabled ? `${label} on.` : `${label} off.`,
    statements: prepareBoolAlert(
      db,
      chatId,
      username,
      coinId,
      enabled,
      alertType,
      (chat, coin, on) => buildPlainAlertUpsert(alertType, chat, coin, on),
    ),
  };
}

/** Shared body for the simple boolean alert prepare* helpers (tg-2[mutations]). */
function prepareBoolAlert(
  db: D1Database,
  chatId: string,
  username: string | null,
  coinId: string,
  enabled: boolean,
  bumpKey: TelegramAlertType,
  buildUpsert: (chatId: string, coinId: string, enabled: boolean) => BuiltSubscriptionUpsert,
): D1PreparedStatement[] {
  const now = unixNow();
  return [
    prepareUpsertSubscriberRow(db, {
      chatId,
      username,
      nowSec: now,
      perCoinAlertBumps: enabled ? { [bumpKey]: 1 } : undefined,
      bumpPreferenceGeneration: true,
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
      bumpPreferenceGeneration: true,
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
      bumpPreferenceGeneration: true,
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
      bumpPreferenceGeneration: true,
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
