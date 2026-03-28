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
  type RouteDependency,
  type FullRouteContext,
  getStaticRouteDefinition,
} from "./route-registry";

function addAdminGetNoStoreHeader(path: string, request: Request | undefined, response: Response): Response {
  if (request?.method !== "GET") return response;
  const endpoint = getEndpointDefinition(path);
  if (!endpoint?.adminRequired) return response;
  if (response.headers.get("Cache-Control") === "no-store") return response;
  response.headers.set("Cache-Control", "no-store");
  return response;
}

interface DynamicRouteDefinition {
  pattern: RegExp;
  dependencies?: readonly RouteDependency[];
  handle: (routeCtx: FullRouteContext, match: RegExpMatchArray) => Promise<Response>;
}

const DYNAMIC_ROUTE_DEFINITIONS: readonly DynamicRouteDefinition[] = [
  {
    pattern: /^\/api\/stablecoin-summary\/(.+)$/,
    handle: (routeCtx, match) => resolveDynamicStablecoinRoute(
      match,
      (canonicalId) => handleStablecoinSummary(routeCtx.db, canonicalId),
    ),
  },
  {
    pattern: /^\/api\/stablecoin-reserves\/(.+)$/,
    handle: (routeCtx, match) => resolveDynamicStablecoinRoute(
      match,
      (canonicalId) => handleStablecoinReserves(routeCtx.db, canonicalId),
    ),
  },
  {
    pattern: /^\/api\/stablecoin\/(.+)$/,
    dependencies: ["coingeckoApiKey"],
    handle: (routeCtx, match) => resolveDynamicStablecoinRoute(
      match,
      (canonicalId) => handleStablecoinDetail(routeCtx.db, canonicalId, routeCtx.execCtx, routeCtx.coingeckoApiKey),
    ),
  },
  {
    pattern: /^\/api\/discovery-candidates\/(\d+)\/dismiss$/,
    handle: async (routeCtx, match) => {
      const candidateId = parseInt(match[1], 10);
      if (!Number.isFinite(candidateId) || candidateId <= 0) {
        return Promise.resolve(errorResponse(400, "Invalid candidate ID"));
      }
      return withAdmin(routeCtx.request, () => handleDismissCandidate(routeCtx.db, candidateId), routeCtx.trustedAdmin);
    },
  },
  {
    pattern: /^\/api\/og\/.+$/,
    handle: (routeCtx) => handleOg(routeCtx.db, routeCtx.url.pathname).then((r) => r ?? errorResponse(404, "Unknown OG route")),
  },
];

function resolveDynamicStablecoinRoute(
  match: RegExpMatchArray,
  handler: (canonicalId: string) => Promise<Response>,
): Promise<Response> {
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
  return handler(resolved.canonicalId);
}

function resolveDynamicRoute(
  routeCtx: FullRouteContext,
): { definition: DynamicRouteDefinition; match: RegExpMatchArray } | null {
  for (const definition of DYNAMIC_ROUTE_DEFINITIONS) {
    const match = routeCtx.url.pathname.match(definition.pattern);
    if (match) {
      return { definition, match };
    }
  }
  return null;
}

export function getRouteDependencies(url: URL): readonly RouteDependency[] | null {
  const path = url.pathname;
  const staticRoute = getStaticRouteDefinition(path);
  if (staticRoute) {
    return staticRoute.endpoint.routeDependencies ?? [];
  }

  for (const definition of DYNAMIC_ROUTE_DEFINITIONS) {
    if (definition.pattern.test(path)) {
      return definition.dependencies ?? [];
    }
  }

  return null;
}

export function route(routeCtx: FullRouteContext): Promise<Response> | null {
  const path = routeCtx.url.pathname;
  const methodValidation = validateEndpointMethod(routeCtx.url, routeCtx.request.method);
  if (methodValidation) {
    const resp = errorResponse(405, methodValidation.message);
    resp.headers.set("Allow", methodValidation.allowedMethods.join(", "));
    return Promise.resolve(resp);
  }

  const staticRoute = getStaticRouteDefinition(path);
  if (staticRoute) {
    return staticRoute.handler(routeCtx)
      .then((response) => addAdminGetNoStoreHeader(staticRoute.endpoint.path, routeCtx.request, response));
  }

  const dynamicRoute = resolveDynamicRoute(routeCtx);
  if (dynamicRoute) {
    return dynamicRoute.definition.handle(routeCtx, dynamicRoute.match);
  }

  return null;
}

export { ROUTER_STATIC_PATHS } from "./route-registry";
