/**
 * Shared constants, types, and callback-policy / parsing authority for the
 * group `/settings` inline-keyboard surface.
 *
 * Both channel ingress (`telegram-webhook-ingress-policy.ts`) and group
 * callback admin checks (`callbacks/settings.ts`) consume this single
 * authority so read vs. write classification and validation never drift.
 */

import type { SubscriberRow } from "./telegram-webhook-shared";
import {
  TELEGRAM_ALERT_PERSISTENCE,
  isDewsBandCode,
  isSafetyModeCode,
  type TelegramPresetAlertType,
} from "@shared/lib/telegram-alert-families";
import {
  TELEGRAM_LIVE_ALERT_TYPES,
  isDepegStepValue,
  type TelegramLiveAlertType,
} from "@shared/types/status/telegram";
import { TELEGRAM_PRESET_LABEL_BY_ID, type TelegramPresetId } from "../common/presets";
import { isSubscribableCoin } from "../store/subscription-eligibility";

/** The chat-wide toggles are the live alert families, in order (launch is retired). */
export const GLOBAL_ALERT_TYPES = TELEGRAM_LIVE_ALERT_TYPES;
export type GlobalAlertType = TelegramLiveAlertType;

/** Two-column direct coin pagination size in Group `/settings`. */
export const SETTINGS_COINS_PAGE_SIZE = 8;

/** Upper page clamp for `settings:*:<page>` callbacks (keeps callback_data <= 64 bytes). */
export const SETTINGS_MAX_PAGE = 999;

export const SETTINGS_READ_SUBACTIONS = new Set(["home", "g", "o", "p", "pu"] as const);
export const SETTINGS_WRITE_SUBACTIONS = new Set(["c", "pf", "pc", "gt", "sc", "q", "sn"] as const);

export type SettingsPresetFamilyCode = "d" | "p" | "s";

export const SETTINGS_PRESET_FAMILY_BY_CODE: Readonly<Record<SettingsPresetFamilyCode, TelegramPresetAlertType>> = {
  d: "dews",
  p: "depeg",
  s: "safety",
};

export const SETTINGS_PRESET_CODE_BY_FAMILY: Readonly<Record<TelegramPresetAlertType, SettingsPresetFamilyCode>> = {
  dews: "d",
  depeg: "p",
  safety: "s",
};

export type SettingsSnoozeAction = "4h" | "24h" | "off" | "pause";

const SETTINGS_SNOOZE_ACTIONS = new Set<string>(["4h", "24h", "off", "pause"]);

const PLAIN_COIN_SETTING_CODES = new Set<string>([
  TELEGRAM_ALERT_PERSISTENCE.reserve.settingCode,
  TELEGRAM_ALERT_PERSISTENCE.freeze.settingCode,
]);

export function isGlobalAlertType(value: string): value is GlobalAlertType {
  return (GLOBAL_ALERT_TYPES as readonly string[]).includes(value);
}

export function isTelegramPresetId(value: string | undefined): value is TelegramPresetId {
  return typeof value === "string" && TELEGRAM_PRESET_LABEL_BY_ID.has(value as TelegramPresetId);
}

export function subscriberHasGlobal(subscriber: SubscriberRow | null, type: GlobalAlertType): boolean {
  if (!subscriber) return false;
  return Boolean(subscriber[TELEGRAM_ALERT_PERSISTENCE[type].globalColumn]);
}

/**
 * Single policy authority for read vs. write classification of `settings:*`
 * callbacks. Unknown sub-actions fail closed as mutating.
 */
export function isSettingsWriteSubAction(subAction: string): boolean {
  return !SETTINGS_READ_SUBACTIONS.has(subAction as "home" | "g" | "o" | "p" | "pu");
}

/** Validate and clamp a page segment to `0..SETTINGS_MAX_PAGE`. */
export function parseSettingsPage(raw: string | undefined): number | null {
  if (raw === undefined) return 0;
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return Math.min(SETTINGS_MAX_PAGE, parsed);
}

/** Validate per-coin setting code/value pairs before any mutation is planned. */
export function normalizeCoinSetting(setting: string, value: string): { setting: string; value: string } | null {
  if (setting === TELEGRAM_ALERT_PERSISTENCE.dews.settingCode) {
    return value === "0" || isDewsBandCode(value) ? { setting, value } : null;
  }
  if (setting === TELEGRAM_ALERT_PERSISTENCE.safety.settingCode) {
    return value === "0" || isSafetyModeCode(value) ? { setting, value } : null;
  }
  if (setting === TELEGRAM_ALERT_PERSISTENCE.depeg.settingCode) {
    return value === "0" || value === "a" || isDepegStepValue(Number(value)) ? { setting, value } : null;
  }
  return PLAIN_COIN_SETTING_CODES.has(setting) && (value === "0" || value === "1")
    ? { setting, value }
    : null;
}

export type ParsedSettingsCallback =
  | { kind: "home"; page: number; mutates: false }
  | { kind: "global"; mutates: false }
  | { kind: "open_coin"; coinId: string; page: number; mutates: false }
  | { kind: "open_preset"; presetId: TelegramPresetId; page: number; mutates: false }
  | { kind: "preset_unfollow_prompt"; presetId: TelegramPresetId; page: number; mutates: false }
  | { kind: "preset_unfollow_confirm"; presetId: TelegramPresetId; page: number; mutates: true }
  | {
      kind: "preset_family";
      presetId: TelegramPresetId;
      family: TelegramPresetAlertType;
      enabled: boolean;
      page: number;
      mutates: true;
    }
  | {
      kind: "coin_setting";
      coinId: string;
      setting: string;
      value: string;
      page: number;
      mutates: true;
    }
  | { kind: "global_toggle"; alertType: GlobalAlertType; next: 0 | 1 | null; mutates: true }
  | { kind: "quiet_hours"; enabled: boolean; mutates: true }
  | { kind: "snooze_clear"; mutates: true }
  | { kind: "snooze"; action: SettingsSnoozeAction; mutates: true }
  | { kind: "retired_launch"; mutates: false }
  | { kind: "invalid"; toast: string; mutates: false };

/**
 * Parse and validate `settings:*` callback parts before any admin check or D1
 * work runs. Supports both the compact v2 grammar and every legacy callback
 * emitted in older chats.
 */
export function parseSettingsCallback(parts: readonly string[]): ParsedSettingsCallback {
  if (parts[0] !== "settings" || parts.length < 2) {
    return { kind: "invalid", toast: "Action not recognized.", mutates: false };
  }
  const subAction = parts[1] ?? "";

  if (subAction === "home") {
    if (parts.length !== 2 && parts.length !== 3) {
      return { kind: "invalid", toast: "Action not recognized.", mutates: false };
    }
    const page = parseSettingsPage(parts[2]);
    return page == null
      ? { kind: "invalid", toast: "Action not recognized.", mutates: false }
      : { kind: "home", page, mutates: false };
  }

  if (subAction === "g") {
    return parts.length === 2
      ? { kind: "global", mutates: false }
      : { kind: "invalid", toast: "Action not recognized.", mutates: false };
  }

  if (subAction === "o") {
    if (parts.length !== 3 && parts.length !== 4) {
      return { kind: "invalid", toast: "Action not recognized.", mutates: false };
    }
    const coinId = parts[2] ?? "";
    const page = parseSettingsPage(parts[3]);
    if (page == null) return { kind: "invalid", toast: "Action not recognized.", mutates: false };
    if (!isSubscribableCoin(coinId)) {
      return { kind: "invalid", toast: "Unknown coin.", mutates: false };
    }
    return { kind: "open_coin", coinId, page, mutates: false };
  }

  if (subAction === "p" || subAction === "pu" || subAction === "pc") {
    if (parts.length !== 3 && parts.length !== 4) {
      return { kind: "invalid", toast: "Action not recognized.", mutates: false };
    }
    const presetId = parts[2];
    const page = parseSettingsPage(parts[3]);
    if (!isTelegramPresetId(presetId) || page == null) {
      return { kind: "invalid", toast: "Action not recognized.", mutates: false };
    }
    if (subAction === "p") return { kind: "open_preset", presetId, page, mutates: false };
    if (subAction === "pu") return { kind: "preset_unfollow_prompt", presetId, page, mutates: false };
    return { kind: "preset_unfollow_confirm", presetId, page, mutates: true };
  }

  if (subAction === "pf") {
    if (parts.length !== 5 && parts.length !== 6) {
      return { kind: "invalid", toast: "Action not recognized.", mutates: false };
    }
    const presetId = parts[2];
    const familyCode = parts[3] ?? "";
    const value = parts[4] ?? "";
    const page = parseSettingsPage(parts[5]);
    const family = Object.prototype.hasOwnProperty.call(SETTINGS_PRESET_FAMILY_BY_CODE, familyCode)
      ? SETTINGS_PRESET_FAMILY_BY_CODE[familyCode as SettingsPresetFamilyCode]
      : null;
    if (!isTelegramPresetId(presetId) || !family || (value !== "0" && value !== "1") || page == null) {
      return { kind: "invalid", toast: "Action not recognized.", mutates: false };
    }
    return { kind: "preset_family", presetId, family, enabled: value === "1", page, mutates: true };
  }

  if (subAction === "c") {
    if (parts.length !== 5 && parts.length !== 6) {
      return { kind: "invalid", toast: "Action not recognized.", mutates: false };
    }
    const coinId = parts[2] ?? "";
    const settingCode = parts[3] ?? "";
    const settingValue = parts[4] ?? "";
    if (settingCode === TELEGRAM_ALERT_PERSISTENCE.launch.settingCode) {
      return { kind: "retired_launch", mutates: false };
    }
    const page = parseSettingsPage(parts[5]);
    const normalized = normalizeCoinSetting(settingCode, settingValue);
    if (!isSubscribableCoin(coinId) || !normalized || page == null) {
      return { kind: "invalid", toast: "Unknown setting.", mutates: false };
    }
    return {
      kind: "coin_setting",
      coinId,
      setting: normalized.setting,
      value: normalized.value,
      page,
      mutates: true,
    };
  }

  if (subAction === "gt") {
    if (parts.length !== 3 && parts.length !== 4) {
      return { kind: "invalid", toast: "Action not recognized.", mutates: false };
    }
    const alertType = parts[2] ?? "";
    if (alertType === "launch") {
      return { kind: "retired_launch", mutates: false };
    }
    if (!isGlobalAlertType(alertType)) {
      return { kind: "invalid", toast: "Unknown alert type.", mutates: false };
    }
    if (parts.length === 3) {
      // Legacy bare `settings:gt:<type>` button refreshes without toggling.
      return { kind: "global_toggle", alertType, next: null, mutates: true };
    }
    const nextCode = parts[3];
    if (nextCode !== "0" && nextCode !== "1") {
      return { kind: "invalid", toast: "Action not recognized.", mutates: false };
    }
    return { kind: "global_toggle", alertType, next: nextCode === "1" ? 1 : 0, mutates: true };
  }

  if (subAction === "q") {
    if (parts.length !== 3 || (parts[2] !== "0" && parts[2] !== "1")) {
      return { kind: "invalid", toast: "Action not recognized.", mutates: false };
    }
    return { kind: "quiet_hours", enabled: parts[2] === "1", mutates: true };
  }

  if (subAction === "sc") {
    return parts.length === 2
      ? { kind: "snooze_clear", mutates: true }
      : { kind: "invalid", toast: "Action not recognized.", mutates: false };
  }

  if (subAction === "sn") {
    const action = parts[2] ?? "";
    if (parts.length !== 3 || !SETTINGS_SNOOZE_ACTIONS.has(action)) {
      return { kind: "invalid", toast: "Action not recognized.", mutates: false };
    }
    return { kind: "snooze", action: action as SettingsSnoozeAction, mutates: true };
  }

  return { kind: "invalid", toast: "Action not recognized.", mutates: false };
}
