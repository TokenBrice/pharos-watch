import {
  createApiKey,
  deactivateApiKey,
  listApiKeys,
  rotateApiKey,
  updateApiKey,
} from "../lib/api-keys";
import {
  jsonResponse,
  parseOptionalRequestJsonObject,
} from "../lib/api-utils";
import { runIdempotentAdminAction } from "../lib/idempotency";
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
    const parsed = JSON.parse(responseBody) as { key?: unknown };
    if (!parsed.key || typeof parsed.key !== "object") {
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
