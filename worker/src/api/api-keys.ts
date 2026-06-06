import { API_PATHS } from "@shared/lib/api-endpoints";
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
import { makeAdminRoute, type AdminRouteContext } from "../lib/route-wrappers";

interface ApiKeysRouteContext extends AdminRouteContext {
  apiKeyHashPepper?: string;
}

interface ApiKeyByIdRouteContext extends ApiKeysRouteContext {
  apiKeyId: number;
}

function fallbackAdminRequest(path: string): Request {
  return new Request(`https://ops-api.pharos.watch${path}`);
}

export const handleApiKeysRoute = makeAdminRoute<ApiKeysRouteContext>(
  "api-keys",
  async ({ db, request, apiKeyHashPepper }) => {
    if (request.method === "POST") {
      const body = await parseOptionalRequestJsonObject(request);
      if (body instanceof Response) {
        return body;
      }
      const created = await createApiKey(db, apiKeyHashPepper, body);
      if (created instanceof Response) {
        return created;
      }
      return jsonResponse(created, { status: 201, noStore: true });
    }

    const response = await listApiKeys(db);
    return jsonResponse(response, { noStore: true });
  },
);

export function handleApiKeys(
  db: D1Database,
  trustedAdmin = false,
  request: Request = fallbackAdminRequest(API_PATHS.apiKeys()),
  apiKeyHashPepper?: string,
): Promise<Response> {
  return handleApiKeysRoute({ db, trustedAdmin, request, apiKeyHashPepper });
}

export const handleApiKeyUpdateRoute = makeAdminRoute<ApiKeyByIdRouteContext>(
  "api-key-update",
  async ({ db, request, apiKeyId }) => {
    const body = await parseOptionalRequestJsonObject(request);
    if (body instanceof Response) {
      return body;
    }
    const updated = await updateApiKey(db, apiKeyId, body);
    if (updated instanceof Response) {
      return updated;
    }
    return jsonResponse(updated, { noStore: true });
  },
);

export function handleApiKeyUpdate(
  db: D1Database,
  id: number,
  trustedAdmin = false,
  request: Request = fallbackAdminRequest(`/api/api-keys/${id}/update`),
): Promise<Response> {
  return handleApiKeyUpdateRoute({ db, apiKeyId: id, trustedAdmin, request });
}

export const handleApiKeyDeactivateRoute = makeAdminRoute<ApiKeyByIdRouteContext>(
  "api-key-deactivate",
  async ({ db, apiKeyId }) => {
    const result = await deactivateApiKey(db, apiKeyId);
    if (result instanceof Response) {
      return result;
    }
    return jsonResponse(result, { noStore: true });
  },
);

export const handleApiKeyRotateRoute = makeAdminRoute<ApiKeyByIdRouteContext>(
  "api-key-rotate",
  async ({ db, apiKeyId, apiKeyHashPepper }) => {
    const result = await rotateApiKey(db, apiKeyHashPepper, apiKeyId);
    if (result instanceof Response) {
      return result;
    }
    return jsonResponse(result, { noStore: true });
  },
);

export function handleApiKeyRotate(
  db: D1Database,
  id: number,
  trustedAdmin = false,
  request: Request = fallbackAdminRequest(`/api/api-keys/${id}/rotate`),
  apiKeyHashPepper?: string,
): Promise<Response> {
  return handleApiKeyRotateRoute({ db, apiKeyId: id, trustedAdmin, request, apiKeyHashPepper });
}
