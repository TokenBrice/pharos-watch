import type {
  ApiKeyCreateResponse,
  ApiKeyListResponse,
  ApiKeyMutationResponse,
  ApiKeyRotateResponse,
} from "@shared/types";
import {
  buildApiKeyMaterial,
  clearApiKeyCache,
  getApiKeyDefaultExpirySec,
  getApiKeyDefaultRateLimitPerMinute,
  getApiKeyRuntimeState,
  getApiKeyTrafficClassDefault,
  getNowSec,
  mapRowToSummary,
  normalizeCreateInput,
  normalizeUpdateInput,
  recordApiKeyAudit,
  requireApiKeyPepper,
  selectApiKeyById,
  selectPublicApiKeyById,
  type ApiKeyDb,
  type ApiKeyPublicRow,
} from "./api-key-core";
import { errorResponse } from "./api-utils";

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
    ? nowSec + getApiKeyDefaultExpirySec()
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
      parsed.trafficClass ?? getApiKeyTrafficClassDefault(),
      parsed.rateLimitPerMinute ?? getApiKeyDefaultRateLimitPerMinute(),
      expiresAt ?? null,
      nowSec,
      nowSec,
    )
    .first<ApiKeyPublicRow>();

  if (!createdRow) {
    return errorResponse(500, "Failed to create API key");
  }

  clearApiKeyCache(material.keyPrefix);
  await recordApiKeyAudit(db, createdRow.id, "created", { name: parsed.name, tier: parsed.tier ?? "standard" }, nowSec);
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
  getApiKeyRuntimeState().apiKeyLastUsageUpdateById.delete(id);
  await recordApiKeyAudit(db, id, "updated", parsed as Record<string, unknown>, nowSec);
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
  getApiKeyRuntimeState().apiKeyLastUsageUpdateById.delete(id);
  await recordApiKeyAudit(db, id, "deactivated", undefined, nowSec);
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
  getApiKeyRuntimeState().apiKeyLastUsageUpdateById.delete(id);
  await recordApiKeyAudit(db, id, "rotated", undefined, nowSec);
  const updated = await selectPublicApiKeyById(db, id);
  if (!updated) {
    return errorResponse(500, "Failed to rotate API key");
  }

  return {
    key: mapRowToSummary(updated),
    token: material.token,
  };
}
