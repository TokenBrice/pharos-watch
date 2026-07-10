import { formatElapsedSeconds } from "@shared/lib/format";
import {
  API_KEY_DEFAULT_RATE_LIMIT_PER_MINUTE,
  API_KEY_MAX_RATE_LIMIT_PER_MINUTE,
  API_KEY_MIN_RATE_LIMIT_PER_MINUTE,
} from "@shared/lib/ops-limits";
import { THIRTY_DAYS_SECONDS, WEEK_SECONDS } from "@shared/lib/time-constants";
import type { ApiKeySummary, ApiKeyTrafficClass } from "@shared/types";

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

export type ApiKeyInventoryStatus = "expired" | "expiring-soon" | "inactive" | "non-expiring" | "active";
export type ApiKeyInventoryStatusFilter = "all" | "attention" | ApiKeyInventoryStatus;
export type ApiKeyInventorySortField = "expiry" | "last-use" | "rate-limit" | "name" | "status";
export type ApiKeyInventorySortDirection = "asc" | "desc";
export type ApiKeyInventoryExpiryPreset = "any" | "expired" | "next-7-days" | "next-30-days" | "after-30-days";

export interface ApiKeyExpiryWindowFilter {
  expiresFrom?: number | null;
  expiresThrough?: number | null;
  includeNonExpiring?: boolean;
}

export interface ApiKeyInventoryFilters {
  search?: string;
  status?: ApiKeyInventoryStatusFilter;
  expiryWindow?: ApiKeyExpiryWindowFilter | null;
  owner?: string | null;
  tier?: string;
  trafficClass?: ApiKeyTrafficClass;
}

export interface ApiKeyInventorySort {
  field: ApiKeyInventorySortField;
  direction: ApiKeyInventorySortDirection;
}

export interface ApiKeyInventoryQuery extends ApiKeyInventoryFilters {
  sort?: ApiKeyInventorySort;
  page?: number;
  pageSize?: number;
}

export interface ApiKeyInventoryPage {
  keys: ApiKeySummary[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  firstItemNumber: number;
  lastItemNumber: number;
  pageWasCorrected: boolean;
  pageSizeWasCorrected: boolean;
}

export interface ApiKeyInventoryView extends ApiKeyInventoryPage {
  totalInventoryItems: number;
}

const API_KEY_DEFAULT_RATE_LIMIT_INPUT = String(API_KEY_DEFAULT_RATE_LIMIT_PER_MINUTE);
const API_KEY_EXPIRING_SOON_WINDOW_SEC = WEEK_SECONDS;

export const API_KEY_INVENTORY_MIN_PAGE_SIZE = 1;
export const API_KEY_INVENTORY_DEFAULT_PAGE_SIZE = 25;
export const API_KEY_INVENTORY_MAX_PAGE_SIZE = 100;
export const DEFAULT_API_KEY_INVENTORY_STATUS_FILTER: ApiKeyInventoryStatusFilter = "attention";

export const API_KEY_INVENTORY_STATUS_PRIORITY: readonly ApiKeyInventoryStatus[] = [
  "expired",
  "expiring-soon",
  "inactive",
  "non-expiring",
  "active",
];

const API_KEY_INVENTORY_STATUS_RANK: Record<ApiKeyInventoryStatus, number> = {
  expired: 0,
  "expiring-soon": 1,
  inactive: 2,
  "non-expiring": 3,
  active: 4,
};

export const DEFAULT_API_KEY_INVENTORY_SORT: ApiKeyInventorySort = {
  field: "status",
  direction: "asc",
};

export const DEFAULT_API_KEY_INVENTORY_QUERY: ApiKeyInventoryQuery = {
  status: DEFAULT_API_KEY_INVENTORY_STATUS_FILTER,
  sort: DEFAULT_API_KEY_INVENTORY_SORT,
  page: 1,
  pageSize: API_KEY_INVENTORY_DEFAULT_PAGE_SIZE,
};

export function buildApiKeyExpiryWindow(
  preset: ApiKeyInventoryExpiryPreset,
  nowSeconds: number,
): ApiKeyExpiryWindowFilter | null {
  switch (preset) {
    case "expired":
      return { expiresThrough: nowSeconds };
    case "next-7-days":
      return { expiresFrom: nowSeconds, expiresThrough: nowSeconds + WEEK_SECONDS };
    case "next-30-days":
      return { expiresFrom: nowSeconds, expiresThrough: nowSeconds + THIRTY_DAYS_SECONDS };
    case "after-30-days":
      return { expiresFrom: nowSeconds + THIRTY_DAYS_SECONDS };
    case "any":
      return null;
  }
}

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

export function getApiKeyInventoryStatus(key: ApiKeySummary, nowSeconds: number): ApiKeyInventoryStatus {
  if (!key.isActive) {
    return "inactive";
  }
  if (key.expiresAt != null && key.expiresAt <= nowSeconds) {
    return "expired";
  }
  if (isApiKeyExpiringSoon(key, nowSeconds)) {
    return "expiring-soon";
  }
  if (key.expiresAt == null) {
    return "non-expiring";
  }
  return "active";
}

export function isApiKeyInAttentionQueue(key: ApiKeySummary, nowSeconds: number): boolean {
  return getApiKeyInventoryStatus(key, nowSeconds) !== "active";
}

function normalizeInventoryText(value: string): string {
  return value.trim().toLowerCase();
}

export function searchApiKeys(keys: readonly ApiKeySummary[], search: string): ApiKeySummary[] {
  const terms = normalizeInventoryText(search).split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return [...keys];
  }

  return keys.filter((key) => {
    const searchableText = normalizeInventoryText(
      [key.name, key.ownerEmail ?? "", key.keyPrefix, key.maskedToken, key.tier, key.lastUsedRoute ?? ""].join(" "),
    );
    return terms.every((term) => searchableText.includes(term));
  });
}

function matchesApiKeyStatus(key: ApiKeySummary, status: ApiKeyInventoryStatusFilter, nowSeconds: number): boolean {
  if (status === "all") {
    return true;
  }
  if (status === "attention") {
    return isApiKeyInAttentionQueue(key, nowSeconds);
  }
  return getApiKeyInventoryStatus(key, nowSeconds) === status;
}

function matchesApiKeyExpiryWindow(key: ApiKeySummary, window: ApiKeyExpiryWindowFilter): boolean {
  if (key.expiresAt == null) {
    return window.includeNonExpiring === true;
  }
  if (window.expiresFrom != null && key.expiresAt < window.expiresFrom) {
    return false;
  }
  if (window.expiresThrough != null && key.expiresAt > window.expiresThrough) {
    return false;
  }
  return true;
}

function matchesNormalizedValue(value: string | null, filter: string): boolean {
  return value != null && normalizeInventoryText(value) === normalizeInventoryText(filter);
}

export function filterApiKeys(
  keys: readonly ApiKeySummary[],
  filters: ApiKeyInventoryFilters,
  nowSeconds: number,
): ApiKeySummary[] {
  return searchApiKeys(keys, filters.search ?? "").filter((key) => {
    if (!matchesApiKeyStatus(key, filters.status ?? "all", nowSeconds)) {
      return false;
    }
    if (filters.expiryWindow != null && !matchesApiKeyExpiryWindow(key, filters.expiryWindow)) {
      return false;
    }
    if (filters.owner !== undefined) {
      if (filters.owner === null ? key.ownerEmail !== null : !matchesNormalizedValue(key.ownerEmail, filters.owner)) {
        return false;
      }
    }
    if (filters.tier !== undefined && !matchesNormalizedValue(key.tier, filters.tier)) {
      return false;
    }
    if (filters.trafficClass !== undefined && key.trafficClass !== filters.trafficClass) {
      return false;
    }
    return true;
  });
}

function compareNumbers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareText(left: string, right: string): number {
  const normalizedLeft = normalizeInventoryText(left);
  const normalizedRight = normalizeInventoryText(right);
  return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0;
}

function compareNullableNumbers(
  left: number | null,
  right: number | null,
  direction: ApiKeyInventorySortDirection,
): number {
  if (left == null) return right == null ? 0 : 1;
  if (right == null) return -1;
  const result = compareNumbers(left, right);
  return direction === "asc" ? result : -result;
}

function compareApiKeys(
  left: ApiKeySummary,
  right: ApiKeySummary,
  sort: ApiKeyInventorySort,
  nowSeconds: number,
): number {
  const directionMultiplier = sort.direction === "asc" ? 1 : -1;
  let comparison = 0;

  switch (sort.field) {
    case "expiry":
      comparison = compareNullableNumbers(left.expiresAt, right.expiresAt, sort.direction);
      break;
    case "last-use":
      comparison = compareNullableNumbers(left.lastUsedAt, right.lastUsedAt, sort.direction);
      break;
    case "rate-limit":
      comparison = directionMultiplier * compareNumbers(left.rateLimitPerMinute, right.rateLimitPerMinute);
      break;
    case "name":
      comparison = directionMultiplier * compareText(left.name, right.name);
      break;
    case "status":
      comparison =
        directionMultiplier *
        compareNumbers(
          API_KEY_INVENTORY_STATUS_RANK[getApiKeyInventoryStatus(left, nowSeconds)],
          API_KEY_INVENTORY_STATUS_RANK[getApiKeyInventoryStatus(right, nowSeconds)],
        );
      break;
  }

  return comparison === 0 ? compareNumbers(left.id, right.id) : comparison;
}

export function sortApiKeys(
  keys: readonly ApiKeySummary[],
  sort: ApiKeyInventorySort,
  nowSeconds: number,
): ApiKeySummary[] {
  return [...keys].sort((left, right) => compareApiKeys(left, right, sort, nowSeconds));
}

function normalizePageSize(requestedPageSize: number): number {
  if (!Number.isFinite(requestedPageSize)) {
    return API_KEY_INVENTORY_DEFAULT_PAGE_SIZE;
  }
  return Math.min(
    API_KEY_INVENTORY_MAX_PAGE_SIZE,
    Math.max(API_KEY_INVENTORY_MIN_PAGE_SIZE, Math.floor(requestedPageSize)),
  );
}

function normalizePage(requestedPage: number): number {
  return Number.isFinite(requestedPage) ? Math.max(1, Math.floor(requestedPage)) : 1;
}

export function paginateApiKeys(
  keys: readonly ApiKeySummary[],
  requestedPage = 1,
  requestedPageSize = API_KEY_INVENTORY_DEFAULT_PAGE_SIZE,
): ApiKeyInventoryPage {
  const pageSize = normalizePageSize(requestedPageSize);
  const totalItems = keys.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const normalizedRequestedPage = normalizePage(requestedPage);
  const page = Math.min(normalizedRequestedPage, totalPages);
  const offset = (page - 1) * pageSize;
  const pageKeys = keys.slice(offset, offset + pageSize);

  return {
    keys: pageKeys,
    page,
    pageSize,
    totalItems,
    totalPages,
    firstItemNumber: pageKeys.length === 0 ? 0 : offset + 1,
    lastItemNumber: offset + pageKeys.length,
    pageWasCorrected: page !== requestedPage,
    pageSizeWasCorrected: pageSize !== requestedPageSize,
  };
}

export function buildApiKeyInventoryView(
  keys: readonly ApiKeySummary[],
  nowSeconds: number,
  query: ApiKeyInventoryQuery = DEFAULT_API_KEY_INVENTORY_QUERY,
): ApiKeyInventoryView {
  const {
    sort = DEFAULT_API_KEY_INVENTORY_SORT,
    page = 1,
    pageSize = API_KEY_INVENTORY_DEFAULT_PAGE_SIZE,
    ...filters
  } = query;
  const filteredKeys = filterApiKeys(
    keys,
    { ...filters, status: filters.status ?? DEFAULT_API_KEY_INVENTORY_STATUS_FILTER },
    nowSeconds,
  );
  const sortedKeys = sortApiKeys(filteredKeys, sort, nowSeconds);

  return {
    ...paginateApiKeys(sortedKeys, page, pageSize),
    totalInventoryItems: keys.length,
  };
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
  const absolute = new Date(key.expiresAt * 1000).toLocaleString();
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
