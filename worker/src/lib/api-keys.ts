import type {
  ApiKeyCreateRequest,
  ApiKeyCreateResponse,
  ApiKeyListResponse,
  ApiKeyMutationResponse,
  ApiKeyRotateResponse,
  ApiKeySummary,
  ApiKeyTrafficClass,
  ApiKeyUpdateRequest,
} from "@shared/types";
import { errorResponse } from "./api-utils";
import { timingSafeCompare } from "./auth";

const API_KEY_PREFIX_BYTES = 8;
const API_KEY_SECRET_BYTES = 24;
const API_KEY_TOKEN_PREFIX = "ph_live";
const API_KEY_TOKEN_PATTERN = /^ph_live_([0-9a-f]{16})_([A-Za-z0-9_-]{32})$/;
const API_KEY_DEFAULT_RATE_LIMIT_PER_MINUTE = 120;
const API_KEY_MIN_RATE_LIMIT_PER_MINUTE = 1;
const API_KEY_MAX_RATE_LIMIT_PER_MINUTE = 10_000;
const API_KEY_NAME_MAX_LENGTH = 80;
const API_KEY_OWNER_EMAIL_MAX_LENGTH = 200;
const API_KEY_TIER_MAX_LENGTH = 40;
const API_KEY_TRAFFIC_CLASS_DEFAULT: ApiKeyTrafficClass = "external";
const API_KEY_DEFAULT_EXPIRY_SEC = 90 * 24 * 60 * 60;
const API_KEY_CACHE_TTL_MS = 5_000;
const API_KEY_USAGE_UPDATE_WINDOW_SEC = 120;
const API_KEY_RATE_LIMIT_PRUNE_WINDOW_MULTIPLIER = 10;

interface StatementRunResult {
  meta?: { changes?: number };
}

interface StatementResult<T> {
  results?: T[];
}

interface ApiKeyStatement {
  bind(...values: unknown[]): ApiKeyStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<StatementResult<T>>;
  run(): Promise<StatementRunResult>;
}

interface ApiKeyDb {
  prepare(query: string): ApiKeyStatement;
}

interface ApiKeyRow {
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
}

type ApiKeyPublicRow = Omit<ApiKeyRow, "secret_hash">;

interface CachedApiKeyEntry {
  cacheExpiresAt: number;
  row: ApiKeyRow | null;
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

const apiKeyCache = new Map<string, CachedApiKeyEntry>();
const apiKeyLastUsageUpdateById = new Map<number, number>();
let lastApiKeyRateLimitPruneBucket: number | null = null;
let pendingApiKeyPrune: Promise<void> | null = null;

export function resetApiKeyStateForTests(): void {
  apiKeyCache.clear();
  apiKeyLastUsageUpdateById.clear();
  lastApiKeyRateLimitPruneBucket = null;
  pendingApiKeyPrune = null;
}

function getNowSec(nowSec?: number): number {
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

function normalizeTier(value: unknown): string {
  return normalizeOptionalString(value, API_KEY_TIER_MAX_LENGTH) ?? "standard";
}

function normalizeTrafficClass(value: unknown): ApiKeyTrafficClass | Response {
  const trimmed = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!trimmed) {
    return API_KEY_TRAFFIC_CLASS_DEFAULT;
  }
  if (trimmed === "external" || trimmed === "site") {
    return trimmed;
  }
  return errorResponse(400, "trafficClass must be either site or external");
}

function normalizeRateLimit(value: unknown): number | Response {
  if (value == null || value === "") {
    return API_KEY_DEFAULT_RATE_LIMIT_PER_MINUTE;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < API_KEY_MIN_RATE_LIMIT_PER_MINUTE || parsed > API_KEY_MAX_RATE_LIMIT_PER_MINUTE) {
    return errorResponse(
      400,
      `rateLimitPerMinute must be between ${API_KEY_MIN_RATE_LIMIT_PER_MINUTE} and ${API_KEY_MAX_RATE_LIMIT_PER_MINUTE}`,
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

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function parseApiKeyToken(token: string | null | undefined): ParsedApiKeyToken | null {
  const trimmed = token?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(API_KEY_TOKEN_PATTERN);
  if (!match) {
    return null;
  }

  return {
    token: trimmed,
    prefix: match[1] ?? "",
    secret: match[2] ?? "",
  };
}

async function hmacSha256Hex(secret: string, input: string): Promise<string> {
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

async function buildApiKeyMaterial(pepper: string): Promise<{
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

function mapRowToSummary(row: ApiKeyPublicRow): ApiKeySummary {
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

function mapRowToAuthenticatedKey(row: ApiKeyRow): AuthenticatedApiKey {
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

function clearApiKeyCache(keyPrefix: string): void {
  apiKeyCache.delete(keyPrefix);
}

async function lookupApiKeyByPrefix(db: ApiKeyDb, keyPrefix: string): Promise<ApiKeyRow | null> {
  const now = Date.now();
  const cached = apiKeyCache.get(keyPrefix);
  if (cached && cached.cacheExpiresAt > now) {
    return cached.row;
  }

  const row = await db.prepare(
    `SELECT
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
       last_used_route
     FROM api_keys
     WHERE key_prefix = ?`,
  )
    .bind(keyPrefix)
    .first<ApiKeyRow>();

  apiKeyCache.set(keyPrefix, {
    cacheExpiresAt: now + API_KEY_CACHE_TTL_MS,
    row,
  });
  return row;
}

export async function authenticateApiKey(
  db: ApiKeyDb,
  apiKeyHeader: string | null,
  pepper: string | undefined,
  nowSec = getNowSec(),
): Promise<ApiKeyAuthenticationResult> {
  const parsed = parseApiKeyToken(apiKeyHeader);
  if (!parsed) {
    return apiKeyHeader?.trim() ? { kind: "invalid" } : { kind: "missing" };
  }

  const effectivePepper = pepper?.trim();
  if (!effectivePepper) {
    return { kind: "unavailable" };
  }

  const row = await lookupApiKeyByPrefix(db, parsed.prefix);
  if (!row || row.is_active !== 1) {
    return { kind: "invalid" };
  }
  if (row.expires_at != null && row.expires_at <= nowSec) {
    return { kind: "invalid" };
  }

  const expectedHash = await hmacSha256Hex(effectivePepper, parsed.secret);
  if (!(await timingSafeCompare(expectedHash, row.secret_hash))) {
    return { kind: "invalid" };
  }

  return {
    kind: "valid",
    key: mapRowToAuthenticatedKey(row),
  };
}

export async function checkApiKeyRateLimit(
  db: ApiKeyDb,
  apiKeyId: number,
  limit: number,
  nowSec = getNowSec(),
): Promise<Response | null> {
  const bucketStart = nowSec - (nowSec % 60);
  const row = await db.prepare(
    `INSERT INTO api_key_rate_limit (api_key_id, bucket_start, count, last_seen_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(api_key_id, bucket_start)
     DO UPDATE SET count = count + 1, last_seen_at = excluded.last_seen_at
     RETURNING count`,
  )
    .bind(apiKeyId, bucketStart, nowSec)
    .first<{ count: number | null }>();

  if (lastApiKeyRateLimitPruneBucket !== bucketStart) {
    lastApiKeyRateLimitPruneBucket = bucketStart;
    pendingApiKeyPrune = db.prepare("DELETE FROM api_key_rate_limit WHERE bucket_start < ?")
      .bind(bucketStart - (60 * API_KEY_RATE_LIMIT_PRUNE_WINDOW_MULTIPLIER))
      .run()
      .then(() => {})
      .catch((error) => {
        console.warn("[api-keys] rate-limit prune failed:", error);
      })
      .finally(() => {
        if (pendingApiKeyPrune) {
          pendingApiKeyPrune = null;
        }
      });
  }

  if ((row?.count ?? 0) > limit) {
    const response = new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(Math.max(1, bucketStart + 60 - nowSec)),
      },
    });
    return response;
  }

  return null;
}

export async function recordApiKeyUsage(
  db: ApiKeyDb,
  key: AuthenticatedApiKey,
  routePath: string,
  nowSec = getNowSec(),
): Promise<void> {
  const lastUpdatedAt = apiKeyLastUsageUpdateById.get(key.id) ?? 0;
  if (nowSec - lastUpdatedAt < API_KEY_USAGE_UPDATE_WINDOW_SEC) {
    return;
  }

  apiKeyLastUsageUpdateById.set(key.id, nowSec);
  await db.prepare(
    "UPDATE api_keys SET last_used_at = ?, last_used_route = ? WHERE id = ?",
  )
    .bind(nowSec, routePath, key.id)
    .run();
}

function normalizeCreateInput(body: Record<string, unknown>): ApiKeyCreateRequest | Response {
  const name = normalizeRequiredName(body.name);
  if (name instanceof Response) {
    return name;
  }

  const rateLimitPerMinute = normalizeRateLimit(body.rateLimitPerMinute);
  if (rateLimitPerMinute instanceof Response) {
    return rateLimitPerMinute;
  }

  const trafficClass = normalizeTrafficClass(body.trafficClass);
  if (trafficClass instanceof Response) {
    return trafficClass;
  }

  const expiresAt = normalizeOptionalExpiresAt(body.expiresAt, "expiresAt");
  if (expiresAt instanceof Response) {
    return expiresAt;
  }

  return {
    name,
    ownerEmail: normalizeOwnerEmail(body.ownerEmail),
    tier: normalizeTier(body.tier),
    trafficClass,
    rateLimitPerMinute,
    expiresAt,
  };
}

function normalizeUpdateInput(body: Record<string, unknown>): ApiKeyUpdateRequest | Response {
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
    next.tier = normalizeTier(body.tier);
  }

  if ("trafficClass" in body) {
    const normalized = normalizeTrafficClass(body.trafficClass);
    if (normalized instanceof Response) {
      return normalized;
    }
    next.trafficClass = normalized;
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

async function selectApiKeyById(db: ApiKeyDb, id: number): Promise<ApiKeyRow | null> {
  return db.prepare(
    `SELECT
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
       last_used_route
     FROM api_keys
     WHERE id = ?`,
  )
    .bind(id)
    .first<ApiKeyRow>();
}

async function selectPublicApiKeyById(db: ApiKeyDb, id: number): Promise<ApiKeyPublicRow | null> {
  return db.prepare(
    `SELECT
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
       last_used_route
     FROM api_keys
     WHERE id = ?`,
  )
    .bind(id)
    .first<ApiKeyPublicRow>();
}

function requireApiKeyPepper(pepper: string | undefined): string | Response {
  const effectivePepper = pepper?.trim();
  return effectivePepper ? effectivePepper : errorResponse(500, "API key hashing is not configured");
}

export async function listApiKeys(db: ApiKeyDb, nowSec = getNowSec()): Promise<ApiKeyListResponse> {
  const rows = await db.prepare(
    `SELECT
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
       last_used_route
     FROM api_keys
     ORDER BY created_at DESC, id DESC`,
  ).all<ApiKeyPublicRow>();

  return {
    generatedAt: nowSec,
    keys: (rows.results ?? []).map(mapRowToSummary),
  };
}

export async function createApiKey(
  db: ApiKeyDb,
  pepper: string | undefined,
  body: Record<string, unknown>,
  nowSec = getNowSec(),
): Promise<ApiKeyCreateResponse | Response> {
  const effectivePepper = requireApiKeyPepper(pepper);
  if (effectivePepper instanceof Response) {
    return effectivePepper;
  }

  const parsed = normalizeCreateInput(body);
  if (parsed instanceof Response) {
    return parsed;
  }

  const material = await buildApiKeyMaterial(effectivePepper);
  const expiresAt = parsed.expiresAt === undefined
    ? nowSec + API_KEY_DEFAULT_EXPIRY_SEC
    : parsed.expiresAt;
  const createdRow = await db.prepare(
    `INSERT INTO api_keys (
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
       updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     RETURNING
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
       last_used_route`,
  )
    .bind(
      material.keyPrefix,
      material.secretHash,
      parsed.name,
      parsed.ownerEmail ?? null,
      parsed.tier ?? "standard",
      parsed.trafficClass ?? API_KEY_TRAFFIC_CLASS_DEFAULT,
      parsed.rateLimitPerMinute ?? API_KEY_DEFAULT_RATE_LIMIT_PER_MINUTE,
      expiresAt ?? null,
      nowSec,
      nowSec,
    )
    .first<ApiKeyPublicRow>();

  if (!createdRow) {
    return errorResponse(500, "Failed to create API key");
  }

  clearApiKeyCache(material.keyPrefix);
  return {
    key: mapRowToSummary(createdRow),
    token: material.token,
  };
}

export async function updateApiKey(
  db: ApiKeyDb,
  id: number,
  body: Record<string, unknown>,
  nowSec = getNowSec(),
): Promise<ApiKeyMutationResponse | Response> {
  const existing = await selectApiKeyById(db, id);
  if (!existing) {
    return errorResponse(404, "API key not found");
  }

  const parsed = normalizeUpdateInput(body);
  if (parsed instanceof Response) {
    return parsed;
  }

  await db.prepare(
    `UPDATE api_keys
     SET
      name = ?,
      owner_email = ?,
      tier = ?,
      traffic_class = ?,
      rate_limit_per_minute = ?,
      is_active = ?,
      expires_at = ?,
      updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      parsed.name ?? existing.name,
      Object.prototype.hasOwnProperty.call(parsed, "ownerEmail") ? parsed.ownerEmail ?? null : existing.owner_email,
      parsed.tier ?? existing.tier,
      parsed.trafficClass ?? existing.traffic_class,
      parsed.rateLimitPerMinute ?? existing.rate_limit_per_minute,
      parsed.isActive == null ? existing.is_active : parsed.isActive ? 1 : 0,
      Object.prototype.hasOwnProperty.call(parsed, "expiresAt") ? parsed.expiresAt ?? null : existing.expires_at,
      nowSec,
      id,
    )
    .run();

  clearApiKeyCache(existing.key_prefix);
  apiKeyLastUsageUpdateById.delete(id);
  const updated = await selectPublicApiKeyById(db, id);
  if (!updated) {
    return errorResponse(500, "Failed to update API key");
  }

  return { key: mapRowToSummary(updated) };
}

export async function deactivateApiKey(
  db: ApiKeyDb,
  id: number,
  nowSec = getNowSec(),
): Promise<ApiKeyMutationResponse | Response> {
  const existing = await selectApiKeyById(db, id);
  if (!existing) {
    return errorResponse(404, "API key not found");
  }

  await db.prepare(
    "UPDATE api_keys SET is_active = 0, updated_at = ? WHERE id = ?",
  )
    .bind(nowSec, id)
    .run();

  clearApiKeyCache(existing.key_prefix);
  apiKeyLastUsageUpdateById.delete(id);
  const updated = await selectPublicApiKeyById(db, id);
  if (!updated) {
    return errorResponse(500, "Failed to deactivate API key");
  }

  return { key: mapRowToSummary(updated) };
}

export async function rotateApiKey(
  db: ApiKeyDb,
  pepper: string | undefined,
  id: number,
  nowSec = getNowSec(),
): Promise<ApiKeyRotateResponse | Response> {
  const effectivePepper = requireApiKeyPepper(pepper);
  if (effectivePepper instanceof Response) {
    return effectivePepper;
  }

  const existing = await selectApiKeyById(db, id);
  if (!existing) {
    return errorResponse(404, "API key not found");
  }

  const material = await buildApiKeyMaterial(effectivePepper);
  await db.prepare(
    `UPDATE api_keys
     SET
       key_prefix = ?,
       secret_hash = ?,
       last_used_at = NULL,
       last_used_route = NULL,
       updated_at = ?
     WHERE id = ?`,
  )
    .bind(material.keyPrefix, material.secretHash, nowSec, id)
    .run();

  clearApiKeyCache(existing.key_prefix);
  clearApiKeyCache(material.keyPrefix);
  apiKeyLastUsageUpdateById.delete(id);
  const updated = await selectPublicApiKeyById(db, id);
  if (!updated) {
    return errorResponse(500, "Failed to rotate API key");
  }

  return {
    key: mapRowToSummary(updated),
    token: material.token,
  };
}
