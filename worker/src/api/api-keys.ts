import { WEEK_SECONDS } from "@shared/lib/time-constants";
import type { ApiKeySummary } from "@shared/types";
import {
  createApiKey,
  deactivateApiKey,
  listApiKeys,
  rotateApiKey,
  updateApiKey,
} from "../lib/api-keys";
import { jsonResponse } from "../lib/api-response";
import { parseOptionalRequestJsonObject } from "../lib/api-json-body";
import { runIdempotentAdminAction } from "../lib/idempotency";
import { parseJsonObject } from "../lib/json-parse";
import { makeAdminRoute, type AdminRouteContext } from "../lib/route-wrappers";

interface ApiKeysRouteContext extends AdminRouteContext {
  apiKeyHashPepper?: string;
}

interface ApiKeyByIdRouteContext extends ApiKeysRouteContext {
  apiKeyId: number;
}

function redactOneTimeTokenForReplay(responseBody: string, responseStatus: number): string {
  if (responseStatus < 200 || responseStatus >= 300) {
    return JSON.stringify({
      error: "API key lifecycle action failed",
      httpStatus: responseStatus,
      sensitiveResponseRedacted: true,
    });
  }
  try {
    const parsed = parseJsonObject<{ key?: unknown }>(responseBody);
    if (!parsed?.key || typeof parsed.key !== "object") {
      return JSON.stringify({
        tokenUnavailableOnReplay: true,
        recovery: "The response identity was unavailable. Inspect API-key inventory before rotating the affected key.",
      });
    }
    const key = parsed.key as Record<string, unknown>;
    const safeKey = Object.fromEntries(
      [
        "id",
        "keyPrefix",
        "maskedToken",
        "name",
        "ownerEmail",
        "tier",
        "trafficClass",
        "rateLimitPerMinute",
        "isActive",
        "expiresAt",
        "createdAt",
        "updatedAt",
        "lastUsedAt",
        "lastUsedRoute",
      ].filter((field) => Object.prototype.hasOwnProperty.call(key, field)).map((field) => [field, key[field]]),
    );
    return JSON.stringify({
      key: safeKey,
      tokenUnavailableOnReplay: true,
      recovery: "The one-time plaintext token is not persisted. Rotate the identified API key to issue a new token.",
    });
  } catch {
    return JSON.stringify({
      tokenUnavailableOnReplay: true,
      recovery: "The one-time plaintext token is not persisted. Inspect API-key inventory before rotating the affected key.",
    });
  }
}

const SENSITIVE_TOKEN_REPLAY = { sensitiveReplayBody: redactOneTimeTokenForReplay } as const;


const AUDIT_ANOMALY_ACTIONS = ["rotated", "deactivated"] as const;

function isApiKeyExpiringSoon(key: ApiKeySummary, nowSeconds: number): boolean {
  return key.isActive
    && key.expiresAt != null
    && key.expiresAt > nowSeconds
    && key.expiresAt - nowSeconds <= WEEK_SECONDS;
}

export const handleCredentialLifecycleSummaryRoute = makeAdminRoute<ApiKeysRouteContext>(
  "credential-lifecycle-summary",
  async ({ db }) => {
    const inventory = await listApiKeys(db);
    const nowSeconds = inventory.generatedAt;

    let active = 0;
    let expiringSoon = 0;
    let expired = 0;
    let nonExpiring = 0;

    for (const key of inventory.keys) {
      if (key.isActive) active += 1;
      if (isApiKeyExpiringSoon(key, nowSeconds)) expiringSoon += 1;
      if (key.expiresAt != null && key.expiresAt <= nowSeconds) expired += 1;
      if (key.expiresAt == null) nonExpiring += 1;
    }

    const anomalyResult = await db.prepare(
      `SELECT COUNT(*) AS count
       FROM api_key_audit_log
       WHERE action IN (?, ?)
         AND created_at >= ?`,
    )
      .bind(...AUDIT_ANOMALY_ACTIONS, nowSeconds - WEEK_SECONDS)
      .first<{ count: number | null }>();

    return jsonResponse({
      generatedAt: nowSeconds,
      totalKeys: inventory.keys.length,
      active,
      expiringSoon,
      expired,
      nonExpiring,
      auditAnomalies7d: anomalyResult?.count ?? null,
    }, { noStore: true });
  },
);

export const handleApiKeysRoute = makeAdminRoute<ApiKeysRouteContext>(
  "api-keys",
  async ({ db, request, apiKeyHashPepper }) => {
    if (request.method === "POST") {
      return runIdempotentAdminAction(db, "api-key-create", request, async () => {
        const body = await parseOptionalRequestJsonObject(request);
        if (body instanceof Response) {
          return body;
        }
        const created = await createApiKey(db, apiKeyHashPepper, body);
        if (created instanceof Response) {
          return created;
        }
        return jsonResponse(created, { status: 201, noStore: true });
      }, SENSITIVE_TOKEN_REPLAY);
    }

    const response = await listApiKeys(db);
    return jsonResponse(response, { noStore: true });
  },
);

export const handleApiKeyUpdateRoute = makeAdminRoute<ApiKeyByIdRouteContext>(
  "api-key-update",
  async ({ db, request, apiKeyId }) => {
    return runIdempotentAdminAction(db, "api-key-update", request, async () => {
      const body = await parseOptionalRequestJsonObject(request);
      if (body instanceof Response) {
        return body;
      }
      const updated = await updateApiKey(db, apiKeyId, body);
      if (updated instanceof Response) {
        return updated;
      }
      return jsonResponse(updated, { noStore: true });
    });
  },
);

export const handleApiKeyDeactivateRoute = makeAdminRoute<ApiKeyByIdRouteContext>(
  "api-key-deactivate",
  async ({ db, request, apiKeyId }) =>
    runIdempotentAdminAction(db, "api-key-deactivate", request, async () => {
      const result = await deactivateApiKey(db, apiKeyId);
      if (result instanceof Response) {
        return result;
      }
      return jsonResponse(result, { noStore: true });
    }),
);

export const handleApiKeyRotateRoute = makeAdminRoute<ApiKeyByIdRouteContext>(
  "api-key-rotate",
  async ({ db, request, apiKeyId, apiKeyHashPepper }) =>
    runIdempotentAdminAction(db, "api-key-rotate", request, async () => {
      const result = await rotateApiKey(db, apiKeyHashPepper, apiKeyId);
      if (result instanceof Response) {
        return result;
      }
      return jsonResponse(result, { noStore: true });
    }, SENSITIVE_TOKEN_REPLAY),
);
