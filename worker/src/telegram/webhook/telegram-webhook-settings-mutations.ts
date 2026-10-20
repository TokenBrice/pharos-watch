/**
 * D1 mutation helpers for the /settings inline-keyboard surface (P1-U7).
 * Kept separate from the render/dispatch code so each surface stays narrow.
 */

import {
  DEFAULT_QUIET_END_HOUR,
  DEFAULT_QUIET_START_HOUR,
  subscriberHasGlobal,
  type GlobalAlertType,
} from "./telegram-webhook-settings-shared";
import { executeAtomicBatch } from "../../lib/db";
import { assertSubscribableCoin } from "../store/subscription-eligibility";
import {
  loadSubscriberByChat,
  unixNow,
  upsertSubscriberRow,
  type PlainAlertType,
} from "../store/telegram-webhook-store";
import type { TelegramOperationBatchOptions } from "../delivery/operation-batch";
import { prepareSettingToSubscriptions } from "../store/subscriptions";
import type { ParsedSetCommand } from "./telegram-webhook-shared";
import type { TelegramFollowOptions } from "../store/subscribers";
import {
  TELEGRAM_ALERT_FAMILY_SHORT_LABELS,
  TELEGRAM_ALERT_PERSISTENCE,
  DEWS_BAND_CODES,
  SAFETY_MODE_CODES,
  isDewsBandCode,
  isSafetyModeCode,
} from "@shared/lib/telegram-alert-families";
import { isDepegStepValue } from "@shared/types/status/telegram";

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
      ? { enabled: true, startHourUtc: DEFAULT_QUIET_START_HOUR, endHourUtc: DEFAULT_QUIET_END_HOUR, preserveSavedWindow: true }
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

/** Validate callback semantics before any required mutation intent is planned. */
export function normalizeCoinSetting(setting: string, value: string): { setting: string; value: string } | null {
  if (setting === TELEGRAM_ALERT_PERSISTENCE.dews.settingCode) {
    return value === "0" || isDewsBandCode(value) ? { setting, value } : null;
  }
  if (setting === TELEGRAM_ALERT_PERSISTENCE.safety.settingCode) {
    return value === "0" || isSafetyModeCode(value) ? { setting, value } : null;
  }
  if (setting === TELEGRAM_ALERT_PERSISTENCE.depeg.settingCode) {
    return value === "0" || isDepegStepValue(Number(value)) ? { setting, value } : null;
  }
  return Object.prototype.hasOwnProperty.call(PLAIN_ALERT_TYPE_BY_SETTING_CODE, setting) && (value === "0" || value === "1")
    ? { setting, value }
    : null;
}

export function prepareCoinSettingStatements(
  db: D1Database,
  chatId: string,
  username: string | null,
  coinId: string,
  setting: string,
  value: string,
  options: TelegramFollowOptions = {},
): { description: string | null; statements: D1PreparedStatement[] } {
  assertSubscribableCoin(coinId);
  if (!normalizeCoinSetting(setting, value)) return { description: null, statements: [] };
  let command: ParsedSetCommand;
  let description: string;
  const ticker = coinId;
  if (setting === TELEGRAM_ALERT_PERSISTENCE.dews.settingCode) {
    const minBand = isDewsBandCode(value) ? DEWS_BAND_CODES[value] : null;
    command = { ticker, setting: "dews", enabled: value !== "0", minBand };
    description = value === "0" ? "DEWS off." : `DEWS >= ${minBand}.`;
  } else if (setting === TELEGRAM_ALERT_PERSISTENCE.safety.settingCode) {
    const mode = isSafetyModeCode(value) ? SAFETY_MODE_CODES[value] : null;
    command = { ticker, setting: "safety", enabled: value !== "0", mode };
    description = value === "0" ? "Safety off." : `Safety ${mode}.`;
  } else if (setting === TELEGRAM_ALERT_PERSISTENCE.depeg.settingCode) {
    const step = Number(value);
    if (value !== "0" && !isDepegStepValue(step)) return { description: null, statements: [] };
    command = isDepegStepValue(step)
      ? { ticker, setting: "depeg-step", enabled: true, step }
      : { ticker, setting: "depeg", enabled: false };
    description = value === "0" ? "Depeg off." : `Depeg +${step}bps.`;
  } else {
    const alertType = PLAIN_ALERT_TYPE_BY_SETTING_CODE[setting]!;
    const enabled = value === "1";
    command = { ticker, setting: alertType, enabled };
    description = `${PLAIN_SETTING_LABELS[alertType]} ${enabled ? "on" : "off"}.`;
  }
  return {
    description,
    statements: prepareSettingToSubscriptions(db, chatId, username, [{ id: coinId }], command, options),
  };
}
