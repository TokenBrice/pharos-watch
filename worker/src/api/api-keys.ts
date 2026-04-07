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
import { runAdminRoute } from "../lib/route-wrappers";

export function handleApiKeys(
  db: D1Database,
  trustedAdmin: boolean = false,
  request?: Request,
  apiKeyHashPepper?: string,
): Promise<Response> {
  return runAdminRoute(
    {
      endpoint: "api-keys",
      request,
      trustedAdmin,
    },
    async () => {
      if (request?.method === "POST") {
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
}

export function handleApiKeyUpdate(
  db: D1Database,
  id: number,
  trustedAdmin: boolean = false,
  request?: Request,
): Promise<Response> {
  return runAdminRoute(
    {
      endpoint: "api-key-update",
      request,
      trustedAdmin,
    },
    async () => {
      const body = await parseOptionalRequestJsonObject(request);
      if (body instanceof Response) {
        return body;
      }
      const updated = await updateApiKey(db, id, body);
      if (updated instanceof Response) {
        return updated;
      }
      return jsonResponse(updated, { noStore: true });
    },
  );
}

export function handleApiKeyDeactivate(
  db: D1Database,
  id: number,
  trustedAdmin: boolean = false,
  request?: Request,
): Promise<Response> {
  return runAdminRoute(
    {
      endpoint: "api-key-deactivate",
      request,
      trustedAdmin,
    },
    async () => {
      const result = await deactivateApiKey(db, id);
      if (result instanceof Response) {
        return result;
      }
      return jsonResponse(result, { noStore: true });
    },
  );
}

export function handleApiKeyRotate(
  db: D1Database,
  id: number,
  trustedAdmin: boolean = false,
  request?: Request,
  apiKeyHashPepper?: string,
): Promise<Response> {
  return runAdminRoute(
    {
      endpoint: "api-key-rotate",
      request,
      trustedAdmin,
    },
    async () => {
      const result = await rotateApiKey(db, apiKeyHashPepper, id);
      if (result instanceof Response) {
        return result;
      }
      return jsonResponse(result, { noStore: true });
    },
  );
}
