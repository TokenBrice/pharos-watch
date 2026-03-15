import { handleStablecoinDetail } from "./api/stablecoin-detail";
import { handleStablecoinSummary } from "./api/stablecoin-summary";
import { handleStablecoinReserves } from "./api/stablecoin-reserves";
import {
  getEndpointDefinition,
  validateEndpointMethod,
} from "@shared/lib/api-endpoints";

import { resolveOrReject, errorResponse } from "./lib/api-utils";
import { handleOg } from "./api/og";
import { handleDismissCandidate } from "./api/discovery";
import { withAdmin } from "./lib/auth";
import {
  STATIC_ROUTE_HANDLERS,
  type FullRouteContext,
} from "./route-registry";

function addAdminGetNoStoreHeader(path: string, request: Request | undefined, response: Response): Response {
  if (request?.method !== "GET") return response;
  const endpoint = getEndpointDefinition(path);
  if (!endpoint?.adminRequired) return response;
  if (response.headers.get("Cache-Control") === "no-store") return response;
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function matchDynamicRoute(
  path: string,
  pattern: RegExp,
  handler: (db: D1Database, canonicalId: string, execCtx: ExecutionContext) => Promise<Response>,
  db: D1Database,
  execCtx: ExecutionContext,
): Promise<Response> | null {
  const match = path.match(pattern);
  if (!match) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return Promise.resolve(errorResponse(400, "Malformed URI"));
  }
  const resolved = resolveOrReject(id);
  if (resolved instanceof Response) {
    return Promise.resolve(resolved);
  }
  return handler(db, resolved.canonicalId, execCtx);
}

export function route(routeCtx: FullRouteContext): Promise<Response> | null {
  const path = routeCtx.url.pathname;
  const methodValidation = validateEndpointMethod(routeCtx.url, routeCtx.request.method);
  if (methodValidation) {
    const resp = errorResponse(405, methodValidation.message);
    resp.headers.set("Allow", methodValidation.allowedMethods.join(", "));
    return Promise.resolve(resp);
  }

  const staticHandler = STATIC_ROUTE_HANDLERS.get(path);
  if (staticHandler) {
    return staticHandler(routeCtx)
      .then((response) => addAdminGetNoStoreHeader(path, routeCtx.request, response));
  }

  const summaryResult = matchDynamicRoute(
    path,
    /^\/api\/stablecoin-summary\/(.+)$/,
    (db, id) => handleStablecoinSummary(db, id),
    routeCtx.db,
    routeCtx.execCtx,
  );
  if (summaryResult) return summaryResult;

  const reservesResult = matchDynamicRoute(
    path,
    /^\/api\/stablecoin-reserves\/(.+)$/,
    (db, id, _execCtx) => handleStablecoinReserves(db, id),
    routeCtx.db,
    routeCtx.execCtx,
  );
  if (reservesResult) return reservesResult;

  const detailResult = matchDynamicRoute(
    path,
    /^\/api\/stablecoin\/(.+)$/,
    (db, id, execCtx) => handleStablecoinDetail(db, id, execCtx, routeCtx.coingeckoApiKey),
    routeCtx.db,
    routeCtx.execCtx,
  );
  if (detailResult) return detailResult;

  // Discovery candidate dismiss (dynamic :id route with admin auth)
  const dismissMatch = path.match(/^\/api\/discovery-candidates\/(\d+)\/dismiss$/);
  if (dismissMatch && routeCtx.request.method === "POST") {
    const candidateId = parseInt(dismissMatch[1], 10);
    return withAdmin(routeCtx.request, () => handleDismissCandidate(routeCtx.db, candidateId), routeCtx.trustedAdmin);
  }

  // OG image generation (dynamic paths under /api/og/)
  if (path.startsWith("/api/og/")) {
    return handleOg(routeCtx.db, path).then((r) => r ?? errorResponse(404, "Unknown OG route"));
  }

  return null;
}

export { ROUTER_STATIC_PATHS } from "./route-registry";
