import { isTelegramAlertType, type TelegramAlertType } from "@shared/types/status";
import { isRecord } from "@shared/lib/type-guards";
import type { ConsolidatedAlerts } from "./telegram-alerts-formatting";
import type { LinkPreviewOptions } from "./telegram";

export const MAX_PENDING_ALERT_SCOPE_ITEMS = 1_024;
export const MAX_PENDING_ALERT_SCOPE_JSON_CHARS = 65_536;
export const MAX_PENDING_MARKUP_POLICY_JSON_CHARS = 16_384;
export const MAX_PENDING_SOURCE_EVENT_ID_CHARS = 200;

const STABLECOIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

export interface PendingAlertScopeItem {
  stablecoinId: string;
  family: TelegramAlertType;
}

export interface PendingMarkupPolicyV1 {
  version: 1;
  disableWebPagePreview: boolean;
  replyMarkup: Record<string, unknown> | null;
  linkPreviewOptions: LinkPreviewOptions | null;
}

export type ParsedPendingJson<T> =
  | { kind: "ok"; value: T }
  | { kind: "legacy" }
  | { kind: "invalid"; reason: string };

function scopeKey(item: PendingAlertScopeItem): string {
  return `${item.family}\0${item.stablecoinId}`;
}

export function normalizePendingAlertScope(
  items: readonly PendingAlertScopeItem[],
): PendingAlertScopeItem[] {
  const unique = new Map<string, PendingAlertScopeItem>();
  for (const item of items) {
    if (!STABLECOIN_ID_PATTERN.test(item.stablecoinId) || !isTelegramAlertType(item.family)) {
      throw new Error("Telegram pending alert scope contains an invalid item");
    }
    unique.set(scopeKey(item), { stablecoinId: item.stablecoinId, family: item.family });
  }
  const normalized = [...unique.values()].sort((a, b) =>
    a.family.localeCompare(b.family) || a.stablecoinId.localeCompare(b.stablecoinId));
  if (normalized.length === 0 || normalized.length > MAX_PENDING_ALERT_SCOPE_ITEMS) {
    throw new Error(`Telegram pending alert scope size is outside 1-${MAX_PENDING_ALERT_SCOPE_ITEMS}`);
  }
  return normalized;
}

export function serializePendingAlertScope(items: readonly PendingAlertScopeItem[]): string {
  const serialized = JSON.stringify(normalizePendingAlertScope(items));
  if (serialized.length > MAX_PENDING_ALERT_SCOPE_JSON_CHARS) {
    throw new Error("Telegram pending alert scope exceeds the persisted JSON limit");
  }
  return serialized;
}

export function parsePendingAlertScope(value: string | null): ParsedPendingJson<PendingAlertScopeItem[]> {
  if (value == null) return { kind: "legacy" };
  if (value.length === 0 || value.length > MAX_PENDING_ALERT_SCOPE_JSON_CHARS) {
    return { kind: "invalid", reason: "preference_scope_size_invalid" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { kind: "invalid", reason: "preference_scope_json_invalid" };
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_PENDING_ALERT_SCOPE_ITEMS) {
    return { kind: "invalid", reason: "preference_scope_shape_invalid" };
  }
  const items: PendingAlertScopeItem[] = [];
  for (const item of parsed) {
    if (
      !isRecord(item) ||
      typeof item.stablecoinId !== "string" ||
      !STABLECOIN_ID_PATTERN.test(item.stablecoinId) ||
      !isTelegramAlertType(item.family)
    ) {
      return { kind: "invalid", reason: "preference_scope_item_invalid" };
    }
    items.push({ stablecoinId: item.stablecoinId, family: item.family });
  }
  try {
    return { kind: "ok", value: normalizePendingAlertScope(items) };
  } catch {
    return { kind: "invalid", reason: "preference_scope_item_invalid" };
  }
}

function collectScopeItems(
  events: readonly { stablecoinId: string }[],
  family: TelegramAlertType,
  target: PendingAlertScopeItem[],
): void {
  for (const event of events) target.push({ stablecoinId: event.stablecoinId, family });
}

export function buildPendingAlertScope(alerts: ConsolidatedAlerts): PendingAlertScopeItem[] {
  const items: PendingAlertScopeItem[] = [];
  collectScopeItems(alerts.dews, "dews", items);
  collectScopeItems(alerts.depegTriggered, "depeg", items);
  collectScopeItems(alerts.depegResolved, "depeg", items);
  collectScopeItems(alerts.depegWorsening, "depeg", items);
  collectScopeItems(alerts.safety, "safety", items);
  collectScopeItems(alerts.launch, "launch", items);
  collectScopeItems(alerts.reserve, "reserve", items);
  if (alerts.burst?.stablecoinIds && isTelegramAlertType(alerts.burst.dominantFamily)) {
    for (const stablecoinId of alerts.burst.stablecoinIds) {
      items.push({ stablecoinId, family: alerts.burst.dominantFamily });
    }
  }
  return normalizePendingAlertScope(items);
}

function isStringWithin(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isValidInlineKeyboardMarkup(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !Array.isArray(value.inline_keyboard)) return false;
  return value.inline_keyboard.length > 0 && value.inline_keyboard.length <= 20 &&
    value.inline_keyboard.every((row) =>
      Array.isArray(row) && row.length > 0 && row.length <= 8 && row.every((button) => {
        if (!isRecord(button) || !isStringWithin(button.text, 128)) return false;
        const callbackDataValid = isStringWithin(button.callback_data, 64);
        const webAppValid = isRecord(button.web_app) && isStringWithin(button.web_app.url, 2_048);
        return callbackDataValid !== webAppValid;
      }));
}

function normalizeLinkPreviewOptions(value: unknown): LinkPreviewOptions | null | undefined {
  if (value == null) return null;
  if (!isRecord(value)) return undefined;
  const allowedKeys = new Set([
    "is_disabled",
    "url",
    "prefer_small_media",
    "prefer_large_media",
    "show_above_text",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return undefined;
  if (value.url != null && !isStringWithin(value.url, 2_048)) return undefined;
  for (const key of ["is_disabled", "prefer_small_media", "prefer_large_media", "show_above_text"] as const) {
    if (value[key] != null && typeof value[key] !== "boolean") return undefined;
  }
  if (value.prefer_small_media === true && value.prefer_large_media === true) return undefined;
  return value as LinkPreviewOptions;
}

export function serializePendingMarkupPolicy(input: {
  replyMarkup?: unknown;
  linkPreviewOptions?: LinkPreviewOptions;
}): string {
  const replyMarkup = input.replyMarkup == null ? null : input.replyMarkup;
  if (replyMarkup != null && !isValidInlineKeyboardMarkup(replyMarkup)) {
    throw new Error("Telegram pending reply markup is invalid");
  }
  const linkPreviewOptions = normalizeLinkPreviewOptions(input.linkPreviewOptions);
  if (linkPreviewOptions === undefined) {
    throw new Error("Telegram pending link preview options are invalid");
  }
  const policy: PendingMarkupPolicyV1 = {
    version: 1,
    disableWebPagePreview: true,
    replyMarkup,
    linkPreviewOptions,
  };
  const serialized = JSON.stringify(policy);
  if (serialized.length > MAX_PENDING_MARKUP_POLICY_JSON_CHARS) {
    throw new Error("Telegram pending markup policy exceeds the persisted JSON limit");
  }
  return serialized;
}

export function parsePendingMarkupPolicy(value: string | null): ParsedPendingJson<PendingMarkupPolicyV1> {
  if (value == null) return { kind: "legacy" };
  if (value.length === 0 || value.length > MAX_PENDING_MARKUP_POLICY_JSON_CHARS) {
    return { kind: "invalid", reason: "preference_markup_size_invalid" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { kind: "invalid", reason: "preference_markup_json_invalid" };
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.disableWebPagePreview !== "boolean" ||
    !(parsed.replyMarkup == null || isValidInlineKeyboardMarkup(parsed.replyMarkup))
  ) {
    return { kind: "invalid", reason: "preference_markup_shape_invalid" };
  }
  const linkPreviewOptions = normalizeLinkPreviewOptions(parsed.linkPreviewOptions);
  if (linkPreviewOptions === undefined) {
    return { kind: "invalid", reason: "preference_markup_shape_invalid" };
  }
  return {
    kind: "ok",
    value: {
      version: 1,
      disableWebPagePreview: parsed.disableWebPagePreview,
      replyMarkup: parsed.replyMarkup == null ? null : parsed.replyMarkup,
      linkPreviewOptions,
    },
  };
}

export function isValidPendingSourceEventId(value: string): boolean {
  return value.length > 0 &&
    value.length <= MAX_PENDING_SOURCE_EVENT_ID_CHARS &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value);
}
