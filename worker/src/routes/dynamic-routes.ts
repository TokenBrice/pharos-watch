import { matchDynamicAdminEndpoint } from "@shared/lib/api-endpoints";
import { handleStablecoinDetail } from "../api/stablecoin-detail";
import { handleStablecoinSummary } from "../api/stablecoin-summary";
import { handleStablecoinReserves } from "../api/stablecoin-reserves";
import { handleOg } from "../api/og";
import { handleDiscoveryCandidateDismiss } from "../api/admin-actions";
import { handleApiKeyDeactivate, handleApiKeyRotate, handleApiKeyUpdate } from "../api/api-keys";
import { errorResponse, resolveOrReject } from "../lib/api-utils";
import { type DynamicRouteDefinition, type RouteMatch } from "./shared";

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
    pattern: /^\/api\/og\/.+$/,
    handle: (routeCtx) => handleOg(routeCtx.db, routeCtx.url.pathname).then((response) => response ?? errorResponse(404, "Unknown OG route")),
  },
] as const;

export function getDynamicRouteMatch(path: string): RouteMatch | null {
  const dynamicAdminEndpoint = matchDynamicAdminEndpoint(path);
  if (dynamicAdminEndpoint?.key === "discovery-candidate-dismiss") {
    return {
      dependencies: [],
      handle: (routeCtx) => handleDiscoveryCandidateDismiss(routeCtx, dynamicAdminEndpoint.candidateId),
    };
  }
  if (dynamicAdminEndpoint?.key === "api-key-update") {
    return {
      dependencies: ["apiKeyHashPepper"],
      handle: (routeCtx) => handleApiKeyUpdate(routeCtx.db, dynamicAdminEndpoint.apiKeyId, routeCtx.trustedAdmin, routeCtx.request),
    };
  }
  if (dynamicAdminEndpoint?.key === "api-key-deactivate") {
    return {
      dependencies: [],
      handle: (routeCtx) => handleApiKeyDeactivate(routeCtx.db, dynamicAdminEndpoint.apiKeyId, routeCtx.trustedAdmin, routeCtx.request),
    };
  }
  if (dynamicAdminEndpoint?.key === "api-key-rotate") {
    return {
      dependencies: ["apiKeyHashPepper"],
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
        dependencies: definition.dependencies ?? [],
        handle: (routeCtx) => definition.handle(routeCtx, match),
      };
    }
  }

  return null;
}
