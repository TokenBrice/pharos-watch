import { formatElapsedSeconds } from "@shared/lib/format";
import {
  API_KEY_DEFAULT_RATE_LIMIT_PER_MINUTE,
  API_KEY_MAX_RATE_LIMIT_PER_MINUTE,
  API_KEY_MIN_RATE_LIMIT_PER_MINUTE,
} from "@shared/lib/ops-limits";
import { WEEK_SECONDS } from "@shared/lib/time-constants";
import type { ApiKeySummary, ApiKeyTrafficClass } from "@shared/types";
import { formatEpochSecondsLocale } from "./api-key-format";

export interface EditableKeyState {
  name: string;
  ownerEmail: string;
  tier: string;
  trafficClass: ApiKeyTrafficClass;
  rateLimitPerMinute: string;
  expiryMode: "custom" | "non-expiring";
  expiresAtInput: string;
}

export type CreateExpiryMode = "default" | "custom" | "non-expiring";

export interface CreateKeyState {
  name: string;
  ownerEmail: string;
  tier: string;
  trafficClass: ApiKeyTrafficClass;
  rateLimitPerMinute: string;
  expiryMode: CreateExpiryMode;
  expiresAtInput: string;
}

export interface ApiKeySummaryItem {
  label: string;
  value: string;
  detail: string;
}

const API_KEY_DEFAULT_RATE_LIMIT_INPUT = String(API_KEY_DEFAULT_RATE_LIMIT_PER_MINUTE);
const API_KEY_EXPIRING_SOON_WINDOW_SEC = WEEK_SECONDS;

export const DEFAULT_CREATE_KEY_STATE: CreateKeyState = {
  name: "",
  ownerEmail: "",
  tier: "standard",
  trafficClass: "external",
  rateLimitPerMinute: API_KEY_DEFAULT_RATE_LIMIT_INPUT,
  expiryMode: "default",
  expiresAtInput: "",
};

export function buildEditableKeyState(key: ApiKeySummary): EditableKeyState {
  return {
    name: key.name,
    ownerEmail: key.ownerEmail ?? "",
    tier: key.tier,
    trafficClass: key.trafficClass,
    rateLimitPerMinute: String(key.rateLimitPerMinute),
    expiryMode: key.expiresAt == null ? "non-expiring" : "custom",
    expiresAtInput: key.expiresAt == null ? "" : formatDateTimeLocalValue(key.expiresAt),
  };
}

export function buildApiKeyInventorySummary(keys: readonly ApiKeySummary[], nowSeconds: number): ApiKeySummaryItem[] {
  let active = 0;
  let expiringSoon = 0;
  let expired = 0;
  let nonExpiring = 0;

  for (const key of keys) {
    if (key.isActive) active += 1;
    if (isApiKeyExpiringSoon(key, nowSeconds)) expiringSoon += 1;
    if (key.expiresAt != null && key.expiresAt <= nowSeconds) expired += 1;
    if (key.expiresAt == null) nonExpiring += 1;
  }

  return [
    { label: "Total keys", value: String(keys.length), detail: `${active} active / ${keys.length - active} inactive` },
    { label: "Expiring soon", value: String(expiringSoon), detail: "active keys inside 7 days" },
    { label: "Expired", value: String(expired), detail: "needs rotation or deactivation" },
    { label: "Non-expiring", value: String(nonExpiring), detail: "explicit exceptions" },
  ];
}

function padTwo(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDateTimeLocalValue(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  return `${date.getFullYear()}-${padTwo(date.getMonth() + 1)}-${padTwo(date.getDate())}T${padTwo(date.getHours())}:${padTwo(date.getMinutes())}`;
}

function parseDateTimeLocalValue(value: string): number | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute] = match;
  const epochMs = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    0,
    0,
  ).getTime();
  return Number.isFinite(epochMs) ? Math.floor(epochMs / 1000) : null;
}

function parseRateLimitInput(value: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error("Rate limit must be a whole number");
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < API_KEY_MIN_RATE_LIMIT_PER_MINUTE
    || parsed > API_KEY_MAX_RATE_LIMIT_PER_MINUTE
  ) {
    throw new Error(
      `Rate limit must be between ${API_KEY_MIN_RATE_LIMIT_PER_MINUTE} and ${API_KEY_MAX_RATE_LIMIT_PER_MINUTE}`,
    );
  }
  return parsed;
}

export function isApiKeyExpiringSoon(key: ApiKeySummary, nowSeconds: number): boolean {
  return key.isActive
    && key.expiresAt != null
    && key.expiresAt > nowSeconds
    && key.expiresAt - nowSeconds <= API_KEY_EXPIRING_SOON_WINDOW_SEC;
}

export function formatExpirySummary(key: ApiKeySummary, nowSeconds: number): string {
  if (key.expiresAt == null) {
    return "Non-expiring exception";
  }
  const absolute = formatEpochSecondsLocale(key.expiresAt);
  if (key.expiresAt <= nowSeconds) {
    return `Expired ${formatElapsedSeconds(nowSeconds - key.expiresAt)} ago at ${absolute}`;
  }
  return `Expires ${absolute} (${formatElapsedSeconds(key.expiresAt - nowSeconds)} remaining)`;
}

export function buildCreateApiKeyPayload(state: CreateKeyState): Record<string, unknown> {
  const createPayload: Record<string, unknown> = {
    name: state.name,
    ownerEmail: state.ownerEmail || null,
    tier: state.tier,
    trafficClass: state.trafficClass,
    rateLimitPerMinute: parseRateLimitInput(state.rateLimitPerMinute),
  };

  if (state.expiryMode === "custom") {
    const parsedExpiry = parseDateTimeLocalValue(state.expiresAtInput);
    if (parsedExpiry == null) {
      throw new Error("Custom expiry requires a valid date and time");
    }
    createPayload.expiresAt = parsedExpiry;
  } else if (state.expiryMode === "non-expiring") {
    createPayload.expiresAt = null;
  }

  return createPayload;
}

export function buildUpdateApiKeyPayload(draft: EditableKeyState): Record<string, unknown> {
  const expiresAt = draft.expiryMode === "custom"
    ? parseDateTimeLocalValue(draft.expiresAtInput)
    : null;
  if (draft.expiryMode === "custom" && expiresAt == null) {
    throw new Error("Custom expiry requires a valid date and time");
  }

  return {
    name: draft.name,
    ownerEmail: draft.ownerEmail || null,
    tier: draft.tier,
    trafficClass: draft.trafficClass,
    rateLimitPerMinute: parseRateLimitInput(draft.rateLimitPerMinute),
    expiresAt,
  };
}

export function requirePlaintextToken<T extends { token?: unknown }>(response: T, action: "created" | "rotated"): string {
  if (typeof response.token === "string" && response.token.trim().length > 0) {
    return response.token;
  }
  throw new Error(`The key was ${action}, but the plaintext token was not returned. Rotate the key before using it.`);
}
