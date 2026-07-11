import { API_PATHS } from "@shared/lib/api-endpoints";
import {
  handleApiKeyRotateRoute,
  handleApiKeyUpdateRoute,
  handleApiKeysRoute,
  handleCredentialLifecycleSummaryRoute,
} from "../api-keys";

// Request-synthesis adapters used only by api-keys.test.ts to call the route
// handlers with a default admin Request. Production routing wires the *Route
// exports directly (routes/ops-routes.ts, routes/dynamic-routes.ts), so these
// adapters and the ops-api host literal stay out of the production source.
function fallbackAdminRequest(path: string): Request {
  return new Request(`https://ops-api.pharos.watch${path}`);
}

export function handleApiKeys(
  db: D1Database,
  trustedAdmin = false,
  request: Request = fallbackAdminRequest(API_PATHS.apiKeys()),
  apiKeyHashPepper?: string,
): Promise<Response> {
  return handleApiKeysRoute({ db, trustedAdmin, request, apiKeyHashPepper });
}

export function handleApiKeyUpdate(
  db: D1Database,
  id: number,
  trustedAdmin = false,
  request: Request = fallbackAdminRequest(API_PATHS.apiKeyUpdate(id)),
): Promise<Response> {
  return handleApiKeyUpdateRoute({ db, apiKeyId: id, trustedAdmin, request });
}

export function handleApiKeyRotate(
  db: D1Database,
  id: number,
  trustedAdmin = false,
  request: Request = fallbackAdminRequest(API_PATHS.apiKeyRotate(id)),
  apiKeyHashPepper?: string,
): Promise<Response> {
  return handleApiKeyRotateRoute({ db, apiKeyId: id, trustedAdmin, request, apiKeyHashPepper });
}

export function handleCredentialLifecycleSummary(
  db: D1Database,
  trustedAdmin = false,
  request: Request = fallbackAdminRequest(API_PATHS.credentialLifecycleSummary()),
): Promise<Response> {
  return handleCredentialLifecycleSummaryRoute({ db, trustedAdmin, request });
}
