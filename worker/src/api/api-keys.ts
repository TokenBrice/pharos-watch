import { withAdmin } from "../lib/auth";
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
  withErrorHandler,
} from "../lib/api-utils";

function jsonResponseWithStatus(body: unknown, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(headers ?? {}),
    },
  });
}

export const handleApiKeys = withErrorHandler(
  "api-keys",
  async (
    db: D1Database,
    trustedAdmin: boolean = false,
    request?: Request,
    apiKeyHashPepper?: string,
  ): Promise<Response> => {
    return withAdmin(request, async () => {
      if (request?.method === "POST") {
        const body = await parseOptionalRequestJsonObject(request);
        if (body instanceof Response) {
          return body;
        }
        const created = await createApiKey(db, apiKeyHashPepper, body);
        if (created instanceof Response) {
          return created;
        }
        return jsonResponseWithStatus(created, 201, { "Cache-Control": "no-store" });
      }

      const response = await listApiKeys(db);
      return jsonResponse(response, { "Cache-Control": "no-store" });
    }, trustedAdmin);
  },
);

export const handleApiKeyUpdate = withErrorHandler(
  "api-key-update",
  async (db: D1Database, id: number, trustedAdmin: boolean = false, request?: Request): Promise<Response> => {
    return withAdmin(request, async () => {
      const body = await parseOptionalRequestJsonObject(request);
      if (body instanceof Response) {
        return body;
      }
      const updated = await updateApiKey(db, id, body);
      if (updated instanceof Response) {
        return updated;
      }
      return jsonResponse(updated, { "Cache-Control": "no-store" });
    }, trustedAdmin);
  },
);

export const handleApiKeyDeactivate = withErrorHandler(
  "api-key-deactivate",
  async (db: D1Database, id: number, trustedAdmin: boolean = false, request?: Request): Promise<Response> => {
    return withAdmin(request, async () => {
      const result = await deactivateApiKey(db, id);
      if (result instanceof Response) {
        return result;
      }
      return jsonResponse(result, { "Cache-Control": "no-store" });
    }, trustedAdmin);
  },
);

export const handleApiKeyRotate = withErrorHandler(
  "api-key-rotate",
  async (
    db: D1Database,
    id: number,
    trustedAdmin: boolean = false,
    request?: Request,
    apiKeyHashPepper?: string,
  ): Promise<Response> => {
    return withAdmin(request, async () => {
      const result = await rotateApiKey(db, apiKeyHashPepper, id);
      if (result instanceof Response) {
        return result;
      }
      return jsonResponse(result, { "Cache-Control": "no-store" });
    }, trustedAdmin);
  },
);
