import { matchDynamicAdminEndpoint, type DynamicAdminEndpointMatch } from "@shared/lib/api-endpoints";
import { handleStablecoinDetail } from "../api/stablecoin-detail";
import { handleStablecoinSummary } from "../api/stablecoin-summary";
import { handleStablecoinReserves } from "../api/stablecoin-reserves";
import { handleOg } from "../api/og";
import { handleDiscoveryCandidateDismiss } from "../api/admin-actions";
import { handleApiKeyDeactivate, handleApiKeyRotate, handleApiKeyUpdate } from "../api/api-keys";
import { errorResponse, resolveOrReject } from "../lib/api-utils";
import { defineDynamicRoute, type DynamicRouteDefinition, type RouteDependency, type RouteMatch } from "./shared";

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

const DYNAMIC_ROUTE_DEFINITIONS = [
  defineDynamicRoute(
    /^\/api\/stablecoin-summary\/(.+)$/,
    [],
    (routeCtx, match) => resolveDynamicStablecoinRoute(
      match,
      (canonicalId) => handleStablecoinSummary(routeCtx.db, canonicalId),
    ),
  ),
  defineDynamicRoute(
    /^\/api\/stablecoin-reserves\/(.+)$/,
    [],
    (routeCtx, match) => resolveDynamicStablecoinRoute(
      match,
      (canonicalId) => handleStablecoinReserves(routeCtx.db, canonicalId),
    ),
  ),
  defineDynamicRoute(
    /^\/api\/stablecoin\/(.+)$/,
    ["coingeckoApiKey"],
    (routeCtx, match) => resolveDynamicStablecoinRoute(
      match,
      (canonicalId) => handleStablecoinDetail(routeCtx.db, canonicalId, routeCtx.execCtx, routeCtx.coingeckoApiKey),
    ),
  ),
  defineDynamicRoute(
    /^\/api\/og\/.+$/,
    [],
    (routeCtx) => handleOg(routeCtx.db, routeCtx.url.pathname).then((response) => response ?? errorResponse(404, "Unknown OG route")),
  ),
] as const satisfies readonly DynamicRouteDefinition[];

const DYNAMIC_ADMIN_ROUTE_DEPENDENCIES = {
  "discovery-candidate-dismiss": [],
  "api-key-update": ["apiKeyHashPepper"],
  "api-key-deactivate": [],
  "api-key-rotate": ["apiKeyHashPepper"],
} as const satisfies Record<DynamicAdminEndpointMatch["key"], readonly RouteDependency[]>;

export function getDynamicRouteMatch(path: string): RouteMatch | null {
  const dynamicAdminEndpoint = matchDynamicAdminEndpoint(path);
  if (dynamicAdminEndpoint?.key === "discovery-candidate-dismiss") {
    return {
      dependencies: DYNAMIC_ADMIN_ROUTE_DEPENDENCIES[dynamicAdminEndpoint.key],
      handle: (routeCtx) => handleDiscoveryCandidateDismiss(routeCtx, dynamicAdminEndpoint.candidateId),
    };
  }
  if (dynamicAdminEndpoint?.key === "api-key-update") {
    return {
      dependencies: DYNAMIC_ADMIN_ROUTE_DEPENDENCIES[dynamicAdminEndpoint.key],
      handle: (routeCtx) => handleApiKeyUpdate(routeCtx.db, dynamicAdminEndpoint.apiKeyId, routeCtx.trustedAdmin, routeCtx.request),
    };
  }
  if (dynamicAdminEndpoint?.key === "api-key-deactivate") {
    return {
      dependencies: DYNAMIC_ADMIN_ROUTE_DEPENDENCIES[dynamicAdminEndpoint.key],
      handle: (routeCtx) => handleApiKeyDeactivate(routeCtx.db, dynamicAdminEndpoint.apiKeyId, routeCtx.trustedAdmin, routeCtx.request),
    };
  }
  if (dynamicAdminEndpoint?.key === "api-key-rotate") {
    return {
      dependencies: DYNAMIC_ADMIN_ROUTE_DEPENDENCIES[dynamicAdminEndpoint.key],
      handle: (routeCtx) => handleApiKeyRotate(
        routeCtx.db,
        dynamicAdminEndpoint.apiKeyId,
        routeCtx.trustedAdmin,
        routeCtx.request,
        routeCtx.apiKeyHashPepper,
      ),
    };
  }

  for (const definition of DYNAMIC_ROUTE_DEFINITIONS) {
    const match = path.match(definition.pattern);
    if (match) {
      return {
        dependencies: definition.dependencies,
        handle: (routeCtx) => definition.handle(routeCtx, match),
      };
    }
  }

  return null;
}
