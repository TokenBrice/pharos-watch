/**
 * D1 mutation helpers for the /settings inline-keyboard surface (P1-U7).
 * Kept separate from the render/dispatch code so each surface stays narrow.
 */

import {
  normalizeCoinSetting,
  subscriberHasGlobal,
  type GlobalAlertType,
  type SettingsSnoozeAction,
} from "./telegram-webhook-settings-shared";
import {
  DEFAULT_QUIET_END_HOUR,
  DEFAULT_QUIET_START_HOUR,
} from "@shared/lib/telegram-mini-app-contract";
import { PAUSE_SENTINEL_TS } from "@shared/lib/telegram-delivery-policy";
import { executeAtomicBatch } from "../../lib/db";
import { SNOOZE_SECONDS } from "../common/constants";
import { assertSubscribableCoin } from "../store/subscription-eligibility";
import { loadSubscriberByChat, unixNow, upsertSubscriberRow } from "../store/subscribers";
import { clearAlertSnooze, setSubscriberSnooze } from "../store/snooze";
import { prepareSubscriberAndPresetPatchStatements } from "../store/presets";
import { type PlainAlertType, prepareSettingToSubscriptions } from "../store/subscriptions";
import type { TelegramOperationBatchOptions } from "../delivery/operation-batch";
import type { ParsedSetCommand } from "./telegram-webhook-shared";
import {
  TELEGRAM_ALERT_FAMILY_SHORT_LABELS,
  TELEGRAM_ALERT_PERSISTENCE,
  DEWS_BAND_CODES,
  SAFETY_MODE_CODES,
  isDewsBandCode,
  isSafetyModeCode,
  type TelegramPresetAlertType,
} from "@shared/lib/telegram-alert-families";
import { isDepegStepValue } from "@shared/types/status/telegram";
import { formatDepegStepPercent, formatDewsCompactBand } from "./telegram-webhook-messages";
import type { TelegramPresetId } from "../common/presets";

export { normalizeCoinSetting };

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

export async function applySettingsSnooze(
  db: D1Database,
  chatId: string,
  username: string | null,
  action: SettingsSnoozeAction,
): Promise<string> {
  if (action === "off") {
    await clearAlertSnooze(db, chatId, username, {});
    return "Alerts resumed.";
  }
  if (action === "pause") {
    await setSubscriberSnooze(db, chatId, username, PAUSE_SENTINEL_TS, {});
    return "All alerts paused until you resume.";
  }
  const untilSec = unixNow() + SNOOZE_SECONDS[action];
  await setSubscriberSnooze(db, chatId, username, untilSec, {});
  return `All alerts paused for ${action}.`;
}

/**
 * Toggle one preset alert family via the store's atomic patch builder.
 * Refuses turning off the last remaining enabled family (matching Mini App
 * lock semantics).
 */
export async function updatePresetFamilySetting(
  db: D1Database,
  chatId: string,
  username: string | null,
  presetId: TelegramPresetId,
  family: TelegramPresetAlertType,
  enabled: boolean,
): Promise<"applied" | "last-family-locked"> {
  const statements = prepareSubscriberAndPresetPatchStatements(
    db,
    chatId,
    username,
    presetId,
    { [family]: enabled },
    undefined,
  );
  const results = await executeAtomicBatch(db, statements, { returnResults: true });
  const presetWriteChanges = Number(results[results.length - 1]?.meta?.changes ?? 0);
  return presetWriteChanges > 0 ? "applied" : "last-family-locked";
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

const PLAIN_ALERT_TYPE_BY_SETTING_CODE: Record<string, Exclude<PlainAlertType, "launch"> | undefined> = {
  [TELEGRAM_ALERT_PERSISTENCE.reserve.settingCode]: "reserve",
  [TELEGRAM_ALERT_PERSISTENCE.freeze.settingCode]: "freeze",
};

/** `/settings` says "Freeze alerts", not the bare family short label. */
const PLAIN_SETTING_LABELS: Record<Exclude<PlainAlertType, "launch">, string> = {
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
  expectedPreferenceGeneration?: number,
): { description: string | null; statements: D1PreparedStatement[] } {
  assertSubscribableCoin(coinId);
  if (!normalizeCoinSetting(setting, value)) return { description: null, statements: [] };
  let command: ParsedSetCommand;
  let description: string;
  const ticker = coinId;
  if (setting === TELEGRAM_ALERT_PERSISTENCE.dews.settingCode) {
    const minBand = isDewsBandCode(value) ? DEWS_BAND_CODES[value] : null;
    command = { ticker, setting: "dews", enabled: value !== "0", minBand };
    description = value === "0" ? "DEWS off." : `DEWS ${formatDewsCompactBand(minBand ?? "ALERT")}.`;
  } else if (setting === TELEGRAM_ALERT_PERSISTENCE.safety.settingCode) {
    const mode = isSafetyModeCode(value) ? SAFETY_MODE_CODES[value] : null;
    command = { ticker, setting: "safety", enabled: value !== "0", mode };
    description = value === "0" ? "Safety off." : mode === "all" ? "Safety on." : `Safety ${mode}.`;
  } else if (setting === TELEGRAM_ALERT_PERSISTENCE.depeg.settingCode) {
    if (value === "a") {
      // Uses the existing `depeg-step` store builder with `step: null` so
      // `alert_depeg = 1` AND any prior numeric step is cleared atomically.
      command = { ticker, setting: "depeg-step", enabled: true, step: null };
      description = "Depeg on (any).";
    } else if (value === "0") {
      command = { ticker, setting: "depeg", enabled: false };
      description = "Depeg off.";
    } else {
      const step = Number(value);
      if (!isDepegStepValue(step)) return { description: null, statements: [] };
      command = { ticker, setting: "depeg-step", enabled: true, step };
      description = `Depeg ${formatDepegStepPercent(step)} step.`;
    }
  } else {
    const alertType = PLAIN_ALERT_TYPE_BY_SETTING_CODE[setting]!;
    const enabled = value === "1";
    command = { ticker, setting: alertType, enabled };
    description = `${PLAIN_SETTING_LABELS[alertType]} ${enabled ? "on" : "off"}.`;
  }
  return {
    description,
    statements: prepareSettingToSubscriptions(db, chatId, username, [{ id: coinId }], command, expectedPreferenceGeneration),
  };
}
