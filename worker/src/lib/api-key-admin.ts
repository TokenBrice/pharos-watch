import type {
  ApiKeyCreateResponse,
  ApiKeyListResponse,
  ApiKeyMutationResponse,
  ApiKeyRotateResponse,
  ApiKeyTier,
} from "@shared/types";
import {
  API_KEY_DEFAULT_EXPIRY_SEC,
  API_KEY_DEFAULT_RATE_LIMIT_PER_MINUTE,
  API_KEY_TRAFFIC_CLASS_DEFAULT,
  buildApiKeyMaterial,
  buildPublicApiKeyReturningClause,
  buildPublicApiKeySelectQuery,
  clearApiKeyCache,
  getApiKeyRuntimeState,
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
import { errorResponse } from "./api-response";

function apiKeyPostWriteReadbackFailure(action: "create" | "activate" | "update" | "deactivate" | "rotate"): Response {
  const recovery =
    action === "rotate"
      ? "Inspect the key prefix in inventory. If it changed, the prior token is revoked and the replacement token is unavailable; start a new rotation intent to issue another token."
      : "Inspect API-key inventory before starting a new intent; the requested write may already have completed.";
  return new Response(
    JSON.stringify({
      error: "api_key_post_write_readback_failed",
      message: `API key ${action} may have completed, but the authoritative readback failed.`,
      recovery,
    }),
    {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        "X-Execution-Certainty": "unknown",
      },
    },
  );
}

export async function listApiKeys(db: ApiKeyDb, nowSec = getNowSec()): Promise<ApiKeyListResponse> {
  const rows = await db
    .prepare(
      `${buildPublicApiKeySelectQuery()}
     ORDER BY created_at DESC, id DESC`,
    )
    .all<ApiKeyPublicRow>();

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

  const expiresAt = parsed.expiresAt === undefined ? nowSec + API_KEY_DEFAULT_EXPIRY_SEC : parsed.expiresAt;
  const created = await createTrustedApiKey(
    db,
    effectivePepper,
    {
      name: parsed.name,
      ownerEmail: parsed.ownerEmail ?? null,
      tier: parsed.tier ?? "standard",
      rateLimitPerMinute: parsed.rateLimitPerMinute ?? API_KEY_DEFAULT_RATE_LIMIT_PER_MINUTE,
      expiresAt: expiresAt ?? null,
    },
    nowSec,
    {
      actor: "admin",
      action: "created",
      detail: { name: parsed.name, tier: parsed.tier ?? "standard" },
    },
  );
  return created;
}

export interface TrustedApiKeyCreateInput {
  name: string;
  ownerEmail: string | null;
  tier: ApiKeyTier;
  rateLimitPerMinute: number;
  expiresAt: number | null;
  isActive?: boolean;
}

export interface TrustedApiKeyAuditInput {
  actor: "admin" | "self-serve";
  action: "created";
  detail?: Record<string, unknown>;
}

export async function createTrustedApiKey(
  db: ApiKeyDb,
  pepper: string,
  input: TrustedApiKeyCreateInput,
  nowSec = getNowSec(),
  audit: TrustedApiKeyAuditInput | null = null,
): Promise<ApiKeyCreateResponse | Response> {
  const material = await buildApiKeyMaterial(pepper);
  const createdRow = await db
    .prepare(
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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ${buildPublicApiKeyReturningClause()}`,
    )
    .bind(
      material.keyPrefix,
      material.secretHash,
      input.name,
      input.ownerEmail,
      input.tier,
      // Attribution label only; the real request lane is derived per request in
      // handlers/http/gates.ts, so issuance always writes the external default.
      API_KEY_TRAFFIC_CLASS_DEFAULT,
      input.rateLimitPerMinute,
      input.isActive === false ? 0 : 1,
      input.expiresAt,
      nowSec,
      nowSec,
    )
    .first<ApiKeyPublicRow>();

  if (!createdRow) {
    return apiKeyPostWriteReadbackFailure("create");
  }

  clearApiKeyCache(material.keyPrefix);
  if (audit) {
    await recordApiKeyAudit(db, createdRow.id, audit.action, audit.detail, nowSec, audit.actor);
  }
  return {
    key: mapRowToSummary(createdRow),
    token: material.token,
  };
}

export async function activateTrustedApiKey(
  db: ApiKeyDb,
  id: number,
  keyPrefix: string,
  nowSec = getNowSec(),
): Promise<ApiKeyMutationResponse | Response> {
  const result = await db
    .prepare("UPDATE api_keys SET is_active = 1, updated_at = ? WHERE id = ? AND is_active = 0")
    .bind(nowSec, id)
    .run();
  if ((result.meta?.changes ?? 0) === 0) {
    return errorResponse(409, "API key could not be activated");
  }

  clearApiKeyCache(keyPrefix);
  getApiKeyRuntimeState().apiKeyLastUsageUpdateById.delete(id);
  const updated = await selectPublicApiKeyById(db, id);
  if (!updated) {
    return apiKeyPostWriteReadbackFailure("activate");
  }
  return { key: mapRowToSummary(updated) };
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

  await db
    .prepare(
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
      Object.prototype.hasOwnProperty.call(parsed, "ownerEmail") ? (parsed.ownerEmail ?? null) : existing.owner_email,
      parsed.tier ?? existing.tier,
      existing.traffic_class,
      parsed.rateLimitPerMinute ?? existing.rate_limit_per_minute,
      parsed.isActive == null ? existing.is_active : parsed.isActive ? 1 : 0,
      Object.prototype.hasOwnProperty.call(parsed, "expiresAt") ? (parsed.expiresAt ?? null) : existing.expires_at,
      nowSec,
      id,
    )
    .run();

  clearApiKeyCache(existing.key_prefix);
  getApiKeyRuntimeState().apiKeyLastUsageUpdateById.delete(id);
  await recordApiKeyAudit(db, id, "updated", parsed as Record<string, unknown>, nowSec);
  const updated = await selectPublicApiKeyById(db, id);
  if (!updated) {
    return apiKeyPostWriteReadbackFailure("update");
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

  await db.prepare("UPDATE api_keys SET is_active = 0, updated_at = ? WHERE id = ?").bind(nowSec, id).run();

  clearApiKeyCache(existing.key_prefix);
  getApiKeyRuntimeState().apiKeyLastUsageUpdateById.delete(id);
  await recordApiKeyAudit(db, id, "deactivated", undefined, nowSec);
  const updated = await selectPublicApiKeyById(db, id);
  if (!updated) {
    return apiKeyPostWriteReadbackFailure("deactivate");
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
  await db
    .prepare(
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
    return apiKeyPostWriteReadbackFailure("rotate");
  }

  return {
    key: mapRowToSummary(updated),
    token: material.token,
  };
}
