import type {
  ApiKeyCreateRequest,
  ApiKeyPlan,
  ApiKeySummary,
  ApiKeyTier,
  ApiKeyTrafficClass,
  ApiKeyUpdateRequest,
} from "@pharos/contracts/api-keys";
import {
  API_KEY_MAX_MONTHLY_REQUEST_QUOTA,
  API_KEY_PLAN_VALUES,
  API_KEY_TIER_VALUES,
} from "@pharos/contracts/api-keys";
import {
  API_KEY_COMMERCIAL_MONTHLY_REQUEST_QUOTA,
  API_KEY_COMMERCIAL_RATE_LIMIT_PER_MINUTE,
  API_KEY_DEPENDENCY_RETRY_AFTER_SEC,
  API_KEY_FREE_PARTNER_MONTHLY_REQUEST_QUOTA,
  API_KEY_INSTITUTIONAL_MONTHLY_REQUEST_QUOTA,
  CIRCUIT_OPEN_THRESHOLD,
  DONOR_API_KEY_MONTHLY_REQUEST_QUOTA,
  API_KEY_DEFAULT_EXPIRY_SEC,
  API_KEY_DEFAULT_RATE_LIMIT_PER_MINUTE,
  API_KEY_MAX_RATE_LIMIT_PER_MINUTE,
  API_KEY_MIN_RATE_LIMIT_PER_MINUTE,
} from "@shared/lib/ops-limits";
import { errorResponse } from "./api-response";
import { bytesToHex } from "./hash";
import { bytesToBase64Url } from "@shared/lib/base64url";
import { IsolateLocalState } from "./isolate-local-state";
import type { MinimalD1Database } from "./minimal-d1";
import type { CacheRetentionPolicy } from "./db-cache";
import { D1_INT32_MAX } from "./d1-constants";

const API_KEY_PREFIX_BYTES = 8;
const API_KEY_SECRET_BYTES = 24;
const API_KEY_TOKEN_PREFIX = "ph_live";
export const API_KEY_TOKEN_PATTERN = /^ph_live_([0-9a-f]{16})_([A-Za-z0-9_-]{32})$/;
const API_KEY_NAME_MAX_LENGTH = 80;
const API_KEY_OWNER_EMAIL_MAX_LENGTH = 200;
export const API_KEY_TRAFFIC_CLASS_DEFAULT: ApiKeyTrafficClass = "external";
export const API_KEY_AUTH_CACHE_TTL_MS = 5_000;
export const API_KEY_AUTH_CACHE_MAX_ENTRIES = 2_048;
const API_KEY_AUTH_CACHE_POLICY = {
  storage: "isolate-memory",
  schemaId: "api-key-auth-row:v1",
  ttlSec: API_KEY_AUTH_CACHE_TTL_MS / 1_000,
  stale: "reject",
  invalid: "delete",
} satisfies CacheRetentionPolicy;
export const API_KEY_USAGE_UPDATE_WINDOW_SEC = 120;
export const API_KEY_USAGE_UPDATE_CACHE_MAX_ENTRIES = 4_096;
export const API_KEY_LOCAL_RATE_LIMIT_MAX_ENTRIES = 4_096;
/** Refresh interval for the isolate-local month-to-date usage memo. */
export const API_KEY_MONTHLY_USAGE_MEMO_TTL_SEC = 300;
/** A failed usage read is memoized so the fail-open window does not re-query D1. */
export const API_KEY_MONTHLY_USAGE_READ_FAILURE_TTL_SEC = 60;

/** UTC calendar month start (epoch seconds) containing nowSec. */
export function utcMonthStartSec(nowSec: number): number {
  const date = new Date(nowSec * 1000);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000;
}
export const API_KEY_RATE_LIMIT_PRUNE_WINDOW_MULTIPLIER = 10;
export {
  API_KEY_DEFAULT_EXPIRY_SEC,
  API_KEY_DEFAULT_RATE_LIMIT_PER_MINUTE,
};

export type ApiKeyDb = MinimalD1Database;

export interface ApiKeyRow {
  id: number;
  key_prefix: string;
  secret_hash: string;
  name: string;
  owner_email: string | null;
  tier: string;
  plan: string | null;
  traffic_class: ApiKeyTrafficClass;
  rate_limit_per_minute: number;
  monthly_request_quota: number | null;
  is_active: number;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  last_used_route: string | null;
  pepper_version?: number;
}

export type ApiKeyPublicRow = Omit<ApiKeyRow, "secret_hash">;

interface CachedApiKeyEntry {
  freshUntilMs: number;
  row: ApiKeyRow;
}

interface IsolateLocalApiKeyRateLimitEntry {
  bucketStart: number;
  count: number;
}

interface ApiKeyMonthlyUsageMemoEntry {
  monthStartSec: number;
  usage: number;
  refreshedAtSec: number;
}

interface ApiKeyRateLimitDependencyCircuitState {
  consecutiveFailures: number;
  openUntilMs: number;
}

export interface ParsedApiKeyToken {
  prefix: string;
  secret: string;
  token: string;
}

export interface AuthenticatedApiKey {
  id: number;
  keyPrefix: string;
  name: string;
  ownerEmail: string | null;
  tier: string;
  plan: ApiKeyPlan | null;
  trafficClass: ApiKeyTrafficClass;
  rateLimitPerMinute: number;
  monthlyRequestQuota: number | null;
  isActive: boolean;
  expiresAt: number | null;
}

export type ApiKeyAuthenticationResult =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "unavailable" }
  | { kind: "valid"; key: AuthenticatedApiKey };

type ApiKeyAuditAction = "created" | "updated" | "deactivated" | "rotated";
export type ApiKeyAuditActor = "admin" | "self-serve" | "donor-claim";

const API_KEY_PUBLIC_PROJECTION = `
       id,
       key_prefix,
       name,
       owner_email,
       tier,
       plan,
       traffic_class,
       rate_limit_per_minute,
       monthly_request_quota,
       is_active,
       expires_at,
       created_at,
       updated_at,
       last_used_at,
       last_used_route`;

const API_KEY_PRIVATE_PROJECTION = `
       id,
       key_prefix,
       secret_hash,
       name,
       owner_email,
       tier,
       plan,
       traffic_class,
       rate_limit_per_minute,
       monthly_request_quota,
       is_active,
       expires_at,
       created_at,
       updated_at,
       last_used_at,
       last_used_route`;

function buildApiKeySelectQuery(projection: string, whereClause?: string): string {
  return `SELECT${projection}
     FROM api_keys${whereClause ? `
     ${whereClause}` : ""}`;
}

export function buildPublicApiKeySelectQuery(whereClause?: string): string {
  return buildApiKeySelectQuery(API_KEY_PUBLIC_PROJECTION, whereClause);
}

function buildPrivateApiKeySelectQuery(whereClause?: string): string {
  return buildApiKeySelectQuery(API_KEY_PRIVATE_PROJECTION, whereClause);
}

function buildPrivateApiKeySelectQueryWithPepper(whereClause?: string): string {
  return buildApiKeySelectQuery(
    `${API_KEY_PRIVATE_PROJECTION},
       pepper_version`,
    whereClause,
  );
}

export function buildPublicApiKeyReturningClause(): string {
  return `RETURNING${API_KEY_PUBLIC_PROJECTION}`;
}

const _ak = new IsolateLocalState(() => ({
  apiKeyCache: new Map<string, CachedApiKeyEntry>(),
  apiKeyLastUsageUpdateById: new Map<number, number>(),
  apiKeyFallbackRateLimitById: new Map<number, IsolateLocalApiKeyRateLimitEntry>(),
  apiKeyOverQuotaById: new Map<number, IsolateLocalApiKeyRateLimitEntry>(),
  apiKeyMonthlyUsageById: new Map<number, ApiKeyMonthlyUsageMemoEntry>(),
  apiKeyMonthlyUsageReadFailureById: new Map<number, number>(),
  apiKeyLookupBlockedBySubject: new Map<string, number>(),
  apiKeyRateLimitDependencyCircuit: {
    consecutiveFailures: 0,
    openUntilMs: 0,
  } as ApiKeyRateLimitDependencyCircuitState,
  lastApiKeyRateLimitPruneBucket: null as number | null,
  lastApiKeyFallbackRateLimitPruneBucket: null as number | null,
}));

export function getApiKeyRuntimeSnapshotForTests() {
  const state = _ak.state;
  return {
    ...state,
    apiKeyCache: new Map([...state.apiKeyCache].map(([key, value]) => [key, { ...value, row: { ...value.row } }])),
    apiKeyLastUsageUpdateById: new Map(state.apiKeyLastUsageUpdateById),
    apiKeyFallbackRateLimitById: new Map([...state.apiKeyFallbackRateLimitById].map(([key, value]) => [key, { ...value }])),
    apiKeyOverQuotaById: new Map([...state.apiKeyOverQuotaById].map(([key, value]) => [key, { ...value }])),
    apiKeyMonthlyUsageById: new Map([...state.apiKeyMonthlyUsageById].map(([key, value]) => [key, { ...value }])),
    apiKeyMonthlyUsageReadFailureById: new Map(state.apiKeyMonthlyUsageReadFailureById),
    apiKeyLookupBlockedBySubject: new Map(state.apiKeyLookupBlockedBySubject),
    apiKeyRateLimitDependencyCircuit: { ...state.apiKeyRateLimitDependencyCircuit },
  };
}

export function seedApiKeyRuntimeStateForTests(input: Partial<ReturnType<typeof getApiKeyRuntimeSnapshotForTests>>): void {
  Object.assign(_ak.state, input);
  Object.assign(_ak.state, getApiKeyRuntimeSnapshotForTests());
}

// LRU eviction: Map iterates in insertion order, so the first key is the
// least-recently inserted (oldest). The cache hit path re-inserts entries via
// delete+set to promote them to newest, which makes "oldest" mean
// least-recently-used. Do not change that hit path without revisiting this.
function pruneOldestMapEntries<K, V>(map: Map<K, V>, maxEntries: number): void {
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

function pruneExpiredApiKeyCache(nowMs: number): void {
  const cache = _ak.state.apiKeyCache;
  for (const [keyPrefix, cached] of cache) {
    if (cached.freshUntilMs <= nowMs) {
      cache.delete(keyPrefix);
    }
  }
}

export function resetApiKeyStateForTests(): void {
  _ak.reset();
}

export function isApiKeyLookupBlocked(subject: string): boolean {
  const blocked = _ak.state.apiKeyLookupBlockedBySubject;
  const bucket = blocked.get(subject);
  if (bucket === Math.floor(getNowSec() / 60)) return true;
  blocked.delete(subject);
  return false;
}

export function blockApiKeyLookup(subject: string): void {
  const blocked = _ak.state.apiKeyLookupBlockedBySubject;
  blocked.delete(subject);
  blocked.set(subject, Math.floor(getNowSec() / 60));
  pruneOldestMapEntries(blocked, API_KEY_LOCAL_RATE_LIMIT_MAX_ENTRIES);
}

export function isApiKeyOverQuota(apiKeyId: number, limit: number, bucketStart: number): boolean {
  const memo = _ak.state.apiKeyOverQuotaById.get(apiKeyId);
  return memo?.bucketStart === bucketStart && memo.count > limit;
}

export function memoizeApiKeyOverQuota(apiKeyId: number, bucketStart: number, count: number): void {
  const memo = _ak.state.apiKeyOverQuotaById;
  memo.delete(apiKeyId);
  memo.set(apiKeyId, { bucketStart, count });
  pruneOldestMapEntries(memo, API_KEY_LOCAL_RATE_LIMIT_MAX_ENTRIES);
}

/**
 * Month-to-date usage memo behind the monthly request quota. Fresh only for
 * the same UTC month and within the TTL; the slow path refreshes it, the
 * cache-hit fast path only reads it.
 */
export function getCachedApiKeyMonthlyUsage(
  apiKeyId: number,
  monthStartSec: number,
  nowSec: number,
): number | null {
  const memo = _ak.state.apiKeyMonthlyUsageById.get(apiKeyId);
  if (!memo || memo.monthStartSec !== monthStartSec || nowSec - memo.refreshedAtSec >= API_KEY_MONTHLY_USAGE_MEMO_TTL_SEC) {
    return null;
  }
  return memo.usage;
}

export function memoizeApiKeyMonthlyUsage(
  apiKeyId: number,
  monthStartSec: number,
  usage: number,
  nowSec: number,
): void {
  const memo = _ak.state.apiKeyMonthlyUsageById;
  memo.delete(apiKeyId);
  memo.set(apiKeyId, { monthStartSec, usage, refreshedAtSec: nowSec });
  pruneOldestMapEntries(memo, API_KEY_LOCAL_RATE_LIMIT_MAX_ENTRIES);
}

/** True while a failed usage read is memoized: fail open without re-querying. */
export function isApiKeyMonthlyUsageReadBlocked(apiKeyId: number, nowSec: number): boolean {
  const blockedUntilSec = _ak.state.apiKeyMonthlyUsageReadFailureById.get(apiKeyId);
  if (blockedUntilSec === undefined) return false;
  if (nowSec < blockedUntilSec) return true;
  _ak.state.apiKeyMonthlyUsageReadFailureById.delete(apiKeyId);
  return false;
}

export function memoizeApiKeyMonthlyUsageReadFailure(apiKeyId: number, blockedUntilSec: number): void {
  const memo = _ak.state.apiKeyMonthlyUsageReadFailureById;
  memo.delete(apiKeyId);
  memo.set(apiKeyId, blockedUntilSec);
  pruneOldestMapEntries(memo, API_KEY_LOCAL_RATE_LIMIT_MAX_ENTRIES);
}

export function getNowSec(nowSec?: number): number {
  return nowSec ?? Math.floor(Date.now() / 1000);
}

function normalizeOptionalString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, maxLength);
}

function normalizeRequiredName(value: unknown): string | Response {
  const normalized = normalizeOptionalString(value, API_KEY_NAME_MAX_LENGTH);
  return normalized ?? errorResponse(400, "API key name is required");
}

function normalizeTier(value: unknown): ApiKeyTier | Response {
  const trimmed = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!trimmed) {
    return "standard";
  }
  if ((API_KEY_TIER_VALUES as readonly string[]).includes(trimmed)) {
    return trimmed as ApiKeyTier;
  }
  return errorResponse(400, `tier must be one of: ${API_KEY_TIER_VALUES.join(", ")}`);
}

function normalizeStoredApiKeyPlan(value: string | null | undefined): ApiKeyPlan | null {
  if (typeof value !== "string") {
    return null;
  }
  return (API_KEY_PLAN_VALUES as readonly string[]).includes(value) ? (value as ApiKeyPlan) : null;
}

function normalizePlanInput(value: unknown): ApiKeyPlan | null | undefined | Response {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return errorResponse(400, `plan must be one of: ${API_KEY_PLAN_VALUES.join(", ")}, or null`);
  }
  const trimmed = value.trim().toLowerCase();
  if ((API_KEY_PLAN_VALUES as readonly string[]).includes(trimmed)) {
    return trimmed as ApiKeyPlan;
  }
  return errorResponse(400, `plan must be one of: ${API_KEY_PLAN_VALUES.join(", ")}, or null`);
}

function normalizeRateLimit(value: unknown): number | Response {
  if (value == null || value === "") {
    return API_KEY_DEFAULT_RATE_LIMIT_PER_MINUTE;
  }
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      return errorResponse(
        400,
        `rateLimitPerMinute must be an integer between ${API_KEY_MIN_RATE_LIMIT_PER_MINUTE} and ${API_KEY_MAX_RATE_LIMIT_PER_MINUTE}`,
      );
    }
    parsed = Number.parseInt(trimmed, 10);
  } else {
    return errorResponse(
      400,
      `rateLimitPerMinute must be an integer between ${API_KEY_MIN_RATE_LIMIT_PER_MINUTE} and ${API_KEY_MAX_RATE_LIMIT_PER_MINUTE}`,
    );
  }

  if (!Number.isInteger(parsed) || !Number.isFinite(parsed) || parsed < API_KEY_MIN_RATE_LIMIT_PER_MINUTE || parsed > API_KEY_MAX_RATE_LIMIT_PER_MINUTE) {
    return errorResponse(
      400,
      `rateLimitPerMinute must be an integer between ${API_KEY_MIN_RATE_LIMIT_PER_MINUTE} and ${API_KEY_MAX_RATE_LIMIT_PER_MINUTE}`,
    );
  }
  return parsed;
}

function normalizeMonthlyRequestQuota(
  value: unknown,
  fieldName: "monthlyRequestQuota",
): number | null | undefined | Response {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      return errorResponse(
        400,
        `${fieldName} must be a positive integer up to ${API_KEY_MAX_MONTHLY_REQUEST_QUOTA} or null`,
      );
    }
    parsed = Number.parseInt(trimmed, 10);
  } else {
    return errorResponse(
      400,
      `${fieldName} must be a positive integer up to ${API_KEY_MAX_MONTHLY_REQUEST_QUOTA} or null`,
    );
  }

  if (!Number.isInteger(parsed) || !Number.isFinite(parsed) || parsed < 1 || parsed > API_KEY_MAX_MONTHLY_REQUEST_QUOTA) {
    return errorResponse(
      400,
      `${fieldName} must be a positive integer up to ${API_KEY_MAX_MONTHLY_REQUEST_QUOTA} or null`,
    );
  }
  return parsed;
}

function normalizeOwnerEmail(value: unknown): string | null {
  const normalized = normalizeOptionalString(value, API_KEY_OWNER_EMAIL_MAX_LENGTH);
  return normalized ? normalized.toLowerCase() : null;
}

function normalizeOptionalExpiresAt(
  value: unknown,
  fieldName: "expiresAt",
): number | null | undefined | Response {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isFinite(value)) {
      return errorResponse(400, `${fieldName} must be an integer Unix timestamp or null`);
    }
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return errorResponse(400, `${fieldName} must be an integer Unix timestamp or null`);
    }
    if (!/^-?\d+$/.test(trimmed)) {
      return errorResponse(400, `${fieldName} must be an integer Unix timestamp or null`);
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed)) {
      return errorResponse(400, `${fieldName} must be an integer Unix timestamp or null`);
    }
    return parsed;
  }
  return errorResponse(400, `${fieldName} must be an integer Unix timestamp or null`);
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export async function hmacSha256Hex(secret: string, input: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(input));
  return bytesToHex(new Uint8Array(signature));
}

export async function buildApiKeyMaterial(pepper: string): Promise<{
  keyPrefix: string;
  secretHash: string;
  token: string;
}> {
  const keyPrefix = bytesToHex(randomBytes(API_KEY_PREFIX_BYTES));
  const secret = bytesToBase64Url(randomBytes(API_KEY_SECRET_BYTES));
  return {
    keyPrefix,
    secretHash: await hmacSha256Hex(pepper, secret),
    token: `${API_KEY_TOKEN_PREFIX}_${keyPrefix}_${secret}`,
  };
}

export function maskApiKeyToken(keyPrefix: string): string {
  return `${API_KEY_TOKEN_PREFIX}_${keyPrefix}_********`;
}

export function mapRowToSummary(row: ApiKeyPublicRow): ApiKeySummary {
  return {
    id: row.id,
    keyPrefix: row.key_prefix,
    maskedToken: maskApiKeyToken(row.key_prefix),
    name: row.name,
    ownerEmail: row.owner_email,
    tier: row.tier,
    plan: normalizeStoredApiKeyPlan(row.plan),
    trafficClass: row.traffic_class,
    rateLimitPerMinute: row.rate_limit_per_minute,
    monthlyRequestQuota: row.monthly_request_quota,
    isActive: row.is_active === 1,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    lastUsedRoute: row.last_used_route,
  };
}

export function mapRowToAuthenticatedKey(row: ApiKeyRow): AuthenticatedApiKey {
  return {
    id: row.id,
    keyPrefix: row.key_prefix,
    name: row.name,
    ownerEmail: row.owner_email,
    tier: row.tier,
    plan: normalizeStoredApiKeyPlan(row.plan),
    trafficClass: row.traffic_class,
    rateLimitPerMinute: row.rate_limit_per_minute,
    monthlyRequestQuota: row.monthly_request_quota,
    isActive: row.is_active === 1,
    expiresAt: row.expires_at,
  };
}

const API_KEY_PLAN_MONTHLY_REQUEST_QUOTA: Record<ApiKeyPlan, number> = {
  free_partner: API_KEY_FREE_PARTNER_MONTHLY_REQUEST_QUOTA,
  commercial: API_KEY_COMMERCIAL_MONTHLY_REQUEST_QUOTA,
  institutional: API_KEY_INSTITUTIONAL_MONTHLY_REQUEST_QUOTA,
};

/**
 * Explicit plan entitlement authority for one key. Only `tier === "standard"`
 * keys with a valid stored `plan` resolve to a plan; `plan === null`, unknown
 * stored values, and non-standard tiers always return `null` (fail closed, no
 * rate-limit inference for entitlements).
 */
export function resolveApiKeyPlan(key: {
  tier: string;
  plan?: string | null;
}): ApiKeyPlan | null {
  if (key.tier !== "standard") {
    return null;
  }
  return normalizeStoredApiKeyPlan(key.plan);
}

/**
 * Effective monthly request quota for one key: first-party (`trafficClass:
 * "site"`) keys are unlimited; else explicit per-key override; else donor
 * quota; else explicit plan default; else legacy rate-based default when
 * `plan` is NULL so pre-0320 standard keys keep unchanged monthly quotas.
 */
export function resolveApiKeyMonthlyRequestQuota(key: {
  trafficClass: ApiKeyTrafficClass;
  tier: string;
  plan?: ApiKeyPlan | string | null;
  monthlyRequestQuota: number | null;
  rateLimitPerMinute: number;
}): number | null {
  if (key.trafficClass === "site") {
    return null;
  }
  if (key.monthlyRequestQuota != null) {
    return key.monthlyRequestQuota;
  }
  if (key.tier === "donor") {
    return DONOR_API_KEY_MONTHLY_REQUEST_QUOTA;
  }
  const explicitPlan = resolveApiKeyPlan(key);
  if (explicitPlan != null) {
    return API_KEY_PLAN_MONTHLY_REQUEST_QUOTA[explicitPlan];
  }
  if (key.rateLimitPerMinute >= API_KEY_COMMERCIAL_RATE_LIMIT_PER_MINUTE) {
    return API_KEY_COMMERCIAL_MONTHLY_REQUEST_QUOTA;
  }
  return API_KEY_FREE_PARTNER_MONTHLY_REQUEST_QUOTA;
}

export function clearApiKeyCache(keyPrefix: string): void {
  _ak.state.apiKeyCache.delete(keyPrefix);
}

export function getCachedApiKeyByPrefix(
  keyPrefix: string,
  options: { nowMs?: number } = {},
): ApiKeyRow | null {
  const nowMs = options.nowMs ?? Date.now();
  const cache = _ak.state.apiKeyCache;
  const cached = cache.get(keyPrefix);
  if (!cached) {
    return null;
  }
  // LRU promotion: re-insert on every hit so the entry moves to the newest
  // Map position; pruneOldestMapEntries evicts the first (oldest) entry. Do not
  // simplify away the delete+set or the cache degrades to FIFO.
  if (cached.freshUntilMs > nowMs) {
    cache.delete(keyPrefix);
    cache.set(keyPrefix, cached);
    return cached.row;
  }
  if (cached.freshUntilMs <= nowMs) {
    cache.delete(keyPrefix);
  }
  return null;
}

export async function lookupApiKeyByPrefix(db: ApiKeyDb, keyPrefix: string): Promise<ApiKeyRow | null> {
  const nowMs = Date.now();
  const row = await db.prepare(buildPrivateApiKeySelectQueryWithPepper("WHERE key_prefix = ?"))
    .bind(keyPrefix)
    .first<ApiKeyRow>();

  if (row) {
    const state = _ak.state;
    pruneExpiredApiKeyCache(nowMs);
    state.apiKeyCache.delete(keyPrefix);
    state.apiKeyCache.set(keyPrefix, {
      freshUntilMs: nowMs + API_KEY_AUTH_CACHE_POLICY.ttlSec * 1_000,
      row,
    });
    pruneOldestMapEntries(state.apiKeyCache, API_KEY_AUTH_CACHE_MAX_ENTRIES);
  }
  return row;
}

export async function recordApiKeyAudit(
  db: ApiKeyDb,
  apiKeyId: number,
  action: ApiKeyAuditAction,
  detail?: Record<string, unknown>,
  nowSec = getNowSec(),
  actor: ApiKeyAuditActor = "admin",
): Promise<void> {
  await db.prepare(
    `INSERT INTO api_key_audit_log (api_key_id, action, actor, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(apiKeyId, action, actor, detail ? JSON.stringify(detail) : null, nowSec)
    .run();
}

export function normalizeCreateInput(body: Record<string, unknown>): ApiKeyCreateRequest | Response {
  const name = normalizeRequiredName(body.name);
  if (name instanceof Response) {
    return name;
  }

  const rateLimitPerMinute = normalizeRateLimit(body.rateLimitPerMinute);
  if (rateLimitPerMinute instanceof Response) {
    return rateLimitPerMinute;
  }

  const tier = normalizeTier(body.tier);
  if (tier instanceof Response) {
    return tier;
  }

  const plan = normalizePlanInput(body.plan);
  if (plan instanceof Response) {
    return plan;
  }
  if (plan != null && tier !== "standard") {
    return errorResponse(400, "plan can only be set for standard tier API keys");
  }

  const monthlyRequestQuota = normalizeMonthlyRequestQuota(body.monthlyRequestQuota, "monthlyRequestQuota");
  if (monthlyRequestQuota instanceof Response) {
    return monthlyRequestQuota;
  }

  const expiresAt = normalizeOptionalExpiresAt(body.expiresAt, "expiresAt");
  if (expiresAt instanceof Response) {
    return expiresAt;
  }

  return {
    name,
    ownerEmail: normalizeOwnerEmail(body.ownerEmail),
    tier,
    ...(plan !== undefined ? { plan } : {}),
    rateLimitPerMinute,
    monthlyRequestQuota,
    expiresAt,
  };
}

export function normalizeUpdateInput(body: Record<string, unknown>): ApiKeyUpdateRequest | Response {
  const next: ApiKeyUpdateRequest = {};

  if ("name" in body) {
    const normalized = normalizeOptionalString(body.name, API_KEY_NAME_MAX_LENGTH);
    if (!normalized) {
      return errorResponse(400, "API key name cannot be empty");
    }
    next.name = normalized;
  }

  if ("ownerEmail" in body) {
    next.ownerEmail = normalizeOwnerEmail(body.ownerEmail);
  }

  if ("tier" in body) {
    const normalized = normalizeTier(body.tier);
    if (normalized instanceof Response) {
      return normalized;
    }
    next.tier = normalized;
  }

  if ("plan" in body) {
    const normalized = normalizePlanInput(body.plan);
    if (normalized instanceof Response) {
      return normalized;
    }
    next.plan = normalized ?? null;
  }

  if (next.tier !== undefined && next.tier !== "standard" && next.plan != null) {
    return errorResponse(400, "plan can only be set for standard tier API keys");
  }

  if ("rateLimitPerMinute" in body) {
    const normalized = normalizeRateLimit(body.rateLimitPerMinute);
    if (normalized instanceof Response) {
      return normalized;
    }
    next.rateLimitPerMinute = normalized;
  }

  if ("monthlyRequestQuota" in body) {
    const normalized = normalizeMonthlyRequestQuota(body.monthlyRequestQuota, "monthlyRequestQuota");
    if (normalized instanceof Response) {
      return normalized;
    }
    next.monthlyRequestQuota = normalized ?? null;
  }

  if ("isActive" in body) {
    if (typeof body.isActive !== "boolean") {
      return errorResponse(400, "isActive must be a boolean");
    }
    next.isActive = body.isActive;
  }

  if ("expiresAt" in body) {
    const normalized = normalizeOptionalExpiresAt(body.expiresAt, "expiresAt");
    if (normalized instanceof Response) {
      return normalized;
    }
    next.expiresAt = normalized ?? null;
  }

  if (Object.keys(next).length === 0) {
    return errorResponse(400, "No API key fields were provided");
  }

  return next;
}

export async function selectApiKeyById(db: ApiKeyDb, id: number): Promise<ApiKeyRow | null> {
  return db.prepare(buildPrivateApiKeySelectQuery("WHERE id = ?"))
    .bind(id)
    .first<ApiKeyRow>();
}

export async function selectPublicApiKeyById(db: ApiKeyDb, id: number): Promise<ApiKeyPublicRow | null> {
  return db.prepare(buildPublicApiKeySelectQuery("WHERE id = ?"))
    .bind(id)
    .first<ApiKeyPublicRow>();
}

export function requireApiKeyPepper(pepper: string | undefined): string | Response {
  const effectivePepper = pepper?.trim();
  return effectivePepper ? effectivePepper : errorResponse(500, "API key hashing is not configured");
}

const API_KEY_RATE_LIMIT_CIRCUIT_COOLDOWN_MS = API_KEY_DEPENDENCY_RETRY_AFTER_SEC * 1000;

export interface ApiKeyRateLimitDependencyCircuitSnapshot {
  consecutiveFailures: number;
  openUntilMs: number;
  opened: boolean;
}

export function isApiKeyRateLimitDependencyCircuitOpen(nowMs = Date.now()): boolean {
  return _ak.state.apiKeyRateLimitDependencyCircuit.openUntilMs > nowMs;
}

export function recordApiKeyRateLimitDependencySuccess(): void {
  const circuit = _ak.state.apiKeyRateLimitDependencyCircuit;
  circuit.consecutiveFailures = 0;
  circuit.openUntilMs = 0;
}

export function recordApiKeyRateLimitDependencyFailure(
  nowMs = Date.now(),
): ApiKeyRateLimitDependencyCircuitSnapshot {
  const circuit = _ak.state.apiKeyRateLimitDependencyCircuit;
  if (circuit.openUntilMs > nowMs) {
    return {
      consecutiveFailures: circuit.consecutiveFailures,
      openUntilMs: circuit.openUntilMs,
      opened: true,
    };
  }

  circuit.consecutiveFailures += 1;
  if (circuit.consecutiveFailures >= CIRCUIT_OPEN_THRESHOLD) {
    circuit.openUntilMs = nowMs + API_KEY_RATE_LIMIT_CIRCUIT_COOLDOWN_MS;
  }

  return {
    consecutiveFailures: circuit.consecutiveFailures,
    openUntilMs: circuit.openUntilMs,
    opened: circuit.openUntilMs > nowMs,
  };
}

export function admitIsolateLocalApiKeyQuota(apiKeyId: number, limit: number, bucketStart: number): boolean {
  const state = _ak.state;
  if (state.lastApiKeyFallbackRateLimitPruneBucket !== bucketStart) {
    state.lastApiKeyFallbackRateLimitPruneBucket = bucketStart;
    for (const [keyId, entry] of state.apiKeyFallbackRateLimitById) {
      if (entry.bucketStart !== bucketStart) {
        state.apiKeyFallbackRateLimitById.delete(keyId);
      }
    }
  }
  const existing = state.apiKeyFallbackRateLimitById.get(apiKeyId);

  if (!existing || existing.bucketStart !== bucketStart) {
    state.apiKeyFallbackRateLimitById.delete(apiKeyId);
    state.apiKeyFallbackRateLimitById.set(apiKeyId, {
      bucketStart,
      count: 1,
    });
    pruneOldestMapEntries(state.apiKeyFallbackRateLimitById, API_KEY_LOCAL_RATE_LIMIT_MAX_ENTRIES);
    return true;
  }

  existing.count = Math.min(existing.count + 1, D1_INT32_MAX);
  state.apiKeyFallbackRateLimitById.delete(apiKeyId);
  state.apiKeyFallbackRateLimitById.set(apiKeyId, existing);
  if (existing.count > limit) {
    return false;
  }

  return true;
}

export function claimApiKeyRateLimitPruneBucket(bucketStart: number): boolean {
  const state = _ak.state;
  if (state.lastApiKeyRateLimitPruneBucket === bucketStart) return false;
  state.lastApiKeyRateLimitPruneBucket = bucketStart;
  return true;
}

export function shouldRecordApiKeyUsage(apiKeyId: number, nowSec: number): boolean {
  const lastUpdatedAt = _ak.state.apiKeyLastUsageUpdateById.get(apiKeyId) ?? 0;
  return !(nowSec - lastUpdatedAt < API_KEY_USAGE_UPDATE_WINDOW_SEC);
}

export function markApiKeyUsageRecorded(apiKeyId: number, nowSec: number): void {
  const usage = _ak.state.apiKeyLastUsageUpdateById;
  usage.delete(apiKeyId);
  usage.set(apiKeyId, nowSec);
  pruneOldestMapEntries(usage, API_KEY_USAGE_UPDATE_CACHE_MAX_ENTRIES);
}

export function clearApiKeyUsage(apiKeyId: number): void {
  _ak.state.apiKeyLastUsageUpdateById.delete(apiKeyId);
}
