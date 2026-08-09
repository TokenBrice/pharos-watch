import type {
  ApiKeyCreateRequest,
  ApiKeySummary,
  ApiKeyTier,
  ApiKeyTrafficClass,
  ApiKeyUpdateRequest,
} from "@shared/types";
import { API_KEY_TIER_VALUES } from "@shared/types";
import {
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

const API_KEY_PREFIX_BYTES = 8;
const API_KEY_SECRET_BYTES = 24;
const API_KEY_TOKEN_PREFIX = "ph_live";
export const API_KEY_TOKEN_PATTERN = /^ph_live_([0-9a-f]{16})_([A-Za-z0-9_-]{32})$/;
const API_KEY_NAME_MAX_LENGTH = 80;
const API_KEY_OWNER_EMAIL_MAX_LENGTH = 200;
export const API_KEY_TRAFFIC_CLASS_DEFAULT: ApiKeyTrafficClass = "external";
export const API_KEY_AUTH_CACHE_TTL_MS = 5_000;
export const API_KEY_AUTH_CACHE_MAX_ENTRIES = 2_048;
export const API_KEY_USAGE_UPDATE_WINDOW_SEC = 120;
export const API_KEY_USAGE_UPDATE_CACHE_MAX_ENTRIES = 4_096;
export const API_KEY_LOCAL_RATE_LIMIT_MAX_ENTRIES = 4_096;
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
  traffic_class: ApiKeyTrafficClass;
  rate_limit_per_minute: number;
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
  trafficClass: ApiKeyTrafficClass;
  rateLimitPerMinute: number;
  isActive: boolean;
  expiresAt: number | null;
}

export type ApiKeyAuthenticationResult =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "unavailable" }
  | { kind: "valid"; key: AuthenticatedApiKey };

type ApiKeyAuditAction = "created" | "updated" | "deactivated" | "rotated";
type ApiKeyAuditActor = "admin" | "self-serve";

const API_KEY_PUBLIC_PROJECTION = `
       id,
       key_prefix,
       name,
       owner_email,
       tier,
       traffic_class,
       rate_limit_per_minute,
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
       traffic_class,
       rate_limit_per_minute,
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
  apiKeyRateLimitDependencyCircuit: {
    consecutiveFailures: 0,
    openUntilMs: 0,
  } as ApiKeyRateLimitDependencyCircuitState,
  lastApiKeyRateLimitPruneBucket: null as number | null,
  lastApiKeyFallbackRateLimitPruneBucket: null as number | null,
}));

export function getApiKeyRuntimeState() {
  return _ak.state;
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
  const cache = getApiKeyRuntimeState().apiKeyCache;
  for (const [keyPrefix, cached] of cache) {
    if (cached.freshUntilMs <= nowMs) {
      cache.delete(keyPrefix);
    }
  }
}

// Caps a Map at maxEntries by evicting oldest-first (LRU; see
// pruneOldestMapEntries). Callers (e.g. api-key-rate-limit.ts) must use
// delete+set on access to keep the LRU ordering meaningful.
export function capApiKeyMapEntries<K, V>(map: Map<K, V>, maxEntries: number): void {
  pruneOldestMapEntries(map, maxEntries);
}

export function resetApiKeyStateForTests(): void {
  _ak.reset();
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
    return Number.parseInt(trimmed, 10);
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

function maskApiKeyToken(keyPrefix: string): string {
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
    trafficClass: row.traffic_class,
    rateLimitPerMinute: row.rate_limit_per_minute,
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
    trafficClass: row.traffic_class,
    rateLimitPerMinute: row.rate_limit_per_minute,
    isActive: row.is_active === 1,
    expiresAt: row.expires_at,
  };
}

export function clearApiKeyCache(keyPrefix: string): void {
  getApiKeyRuntimeState().apiKeyCache.delete(keyPrefix);
}

export function getCachedApiKeyByPrefix(
  keyPrefix: string,
  options: { nowMs?: number } = {},
): ApiKeyRow | null {
  const nowMs = options.nowMs ?? Date.now();
  const cache = getApiKeyRuntimeState().apiKeyCache;
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
    const state = getApiKeyRuntimeState();
    pruneExpiredApiKeyCache(nowMs);
    state.apiKeyCache.delete(keyPrefix);
    state.apiKeyCache.set(keyPrefix, {
      freshUntilMs: nowMs + API_KEY_AUTH_CACHE_TTL_MS,
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

  const expiresAt = normalizeOptionalExpiresAt(body.expiresAt, "expiresAt");
  if (expiresAt instanceof Response) {
    return expiresAt;
  }

  return {
    name,
    ownerEmail: normalizeOwnerEmail(body.ownerEmail),
    tier,
    rateLimitPerMinute,
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

  if ("rateLimitPerMinute" in body) {
    const normalized = normalizeRateLimit(body.rateLimitPerMinute);
    if (normalized instanceof Response) {
      return normalized;
    }
    next.rateLimitPerMinute = normalized;
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
