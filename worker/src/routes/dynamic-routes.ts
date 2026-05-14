import {
  getDynamicEndpointDescriptorByKey,
  matchDynamicAdminEndpoint,
  type DynamicAdminEndpointMatch,
} from "@shared/lib/api-endpoints";
import { handleStablecoinDetail } from "../api/stablecoin-detail";
import { handleStablecoinSummary } from "../api/stablecoin-summary";
import { handleStablecoinReserves } from "../api/stablecoin-reserves";
import { handleOg } from "../api/og";
import { handleDiscoveryCandidateDismiss } from "../api/admin-actions";
import { handleApiKeyDeactivateRoute, handleApiKeyRotateRoute, handleApiKeyUpdateRoute } from "../api/api-keys";
import { handleApiKeyRequestRejectRoute, handleApiKeyRequestReleaseClaimRoute } from "../api/api-key-requests";
import { handleAdminTelegramChat } from "../api/admin-telegram-chat";
import { errorResponse, resolveOrReject } from "../lib/api-utils";
import {
  defineDynamicRoute,
  type DynamicRouteDefinition,
  type FullRouteContext,
  type RouteDependency,
  type RouteMatch,
} from "./shared";

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

type DynamicEndpointDescriptorKey = Parameters<typeof getDynamicEndpointDescriptorByKey>[0];
type DynamicAdminEndpointKey = DynamicAdminEndpointMatch["key"];
type ExpandedDynamicAdminEndpointMatch<T extends DynamicAdminEndpointMatch = DynamicAdminEndpointMatch> =
  T extends { key: infer Key }
    ? Key extends DynamicAdminEndpointKey
      ? Omit<T, "key"> & { key: Key }
      : never
    : never;
type DynamicAdminEndpointFor<Key extends DynamicAdminEndpointKey> =
  Extract<ExpandedDynamicAdminEndpointMatch, { key: Key }>;
type DynamicAdminRouteBinding<Key extends DynamicAdminEndpointKey> = {
  dependencies: readonly RouteDependency[];
  handle: (routeCtx: FullRouteContext, dynamicAdminEndpoint: DynamicAdminEndpointFor<Key>) => Promise<Response>;
};
type DynamicAdminRouteBindingMap = {
  [Key in DynamicAdminEndpointKey]: DynamicAdminRouteBinding<Key>;
};

function requireDynamicEndpointDescriptor(key: DynamicEndpointDescriptorKey) {
  const descriptor = getDynamicEndpointDescriptorByKey(key);
  if (!descriptor) {
    throw new Error(`Dynamic endpoint descriptor "${key}" must be declared in shared/lib/api-endpoints/dynamic.ts`);
  }
  return descriptor;
}

function defineDynamicRouteFromDescriptor(
  key: DynamicEndpointDescriptorKey,
  handle: DynamicRouteDefinition["handle"],
): DynamicRouteDefinition {
  const descriptor = requireDynamicEndpointDescriptor(key);
  return defineDynamicRoute(descriptor.pattern, descriptor.routeDependencies, handle);
}

const DYNAMIC_ROUTE_DEFINITIONS = [
  defineDynamicRouteFromDescriptor(
    "stablecoin-summary",
    (routeCtx, match) => resolveDynamicStablecoinRoute(
      match,
      (canonicalId) => handleStablecoinSummary(routeCtx.db, canonicalId),
    ),
  ),
  defineDynamicRouteFromDescriptor(
    "stablecoin-reserves",
    (routeCtx, match) => resolveDynamicStablecoinRoute(
      match,
      (canonicalId) => handleStablecoinReserves(routeCtx.db, canonicalId),
    ),
  ),
  defineDynamicRouteFromDescriptor(
    "stablecoin-detail",
    (routeCtx, match) => resolveDynamicStablecoinRoute(
      match,
      (canonicalId) => handleStablecoinDetail(routeCtx.db, canonicalId, routeCtx.execCtx, routeCtx.coingeckoApiKey),
    ),
  ),
  defineDynamicRouteFromDescriptor(
    "og-image",
    (routeCtx) => handleOg(routeCtx.db, routeCtx.url.pathname).then((response) => response ?? errorResponse(404, "Unknown OG route")),
  ),
] as const satisfies readonly DynamicRouteDefinition[];

function defineDynamicAdminRouteBinding<Key extends DynamicAdminEndpointKey>(
  key: Key,
  handle: DynamicAdminRouteBinding<Key>["handle"],
): DynamicAdminRouteBinding<Key> {
  return {
    dependencies: requireDynamicEndpointDescriptor(key).routeDependencies,
    handle,
  };
}

const DYNAMIC_ADMIN_ROUTE_BINDINGS = {
  "discovery-candidate-dismiss": defineDynamicAdminRouteBinding(
    "discovery-candidate-dismiss",
    (routeCtx, dynamicAdminEndpoint) =>
      handleDiscoveryCandidateDismiss(routeCtx, dynamicAdminEndpoint.candidateId),
  ),
  "api-key-update": defineDynamicAdminRouteBinding(
    "api-key-update",
    (routeCtx, dynamicAdminEndpoint) =>
      handleApiKeyUpdateRoute({ ...routeCtx, apiKeyId: dynamicAdminEndpoint.apiKeyId }),
  ),
  "api-key-deactivate": defineDynamicAdminRouteBinding(
    "api-key-deactivate",
    (routeCtx, dynamicAdminEndpoint) =>
      handleApiKeyDeactivateRoute({ ...routeCtx, apiKeyId: dynamicAdminEndpoint.apiKeyId }),
  ),
  "api-key-rotate": defineDynamicAdminRouteBinding(
    "api-key-rotate",
    (routeCtx, dynamicAdminEndpoint) =>
      handleApiKeyRotateRoute({ ...routeCtx, apiKeyId: dynamicAdminEndpoint.apiKeyId }),
  ),
  "api-key-request-reject": defineDynamicAdminRouteBinding(
    "api-key-request-reject",
    (routeCtx, dynamicAdminEndpoint) =>
      handleApiKeyRequestRejectRoute({ ...routeCtx, requestId: dynamicAdminEndpoint.requestId }),
  ),
  "api-key-request-release-claim": defineDynamicAdminRouteBinding(
    "api-key-request-release-claim",
    (routeCtx, dynamicAdminEndpoint) =>
      handleApiKeyRequestReleaseClaimRoute({ ...routeCtx, requestId: dynamicAdminEndpoint.requestId }),
  ),
  "admin-telegram-chat": defineDynamicAdminRouteBinding(
    "admin-telegram-chat",
    (routeCtx, dynamicAdminEndpoint) => handleAdminTelegramChat(
      routeCtx.db,
      dynamicAdminEndpoint.chatId,
      routeCtx.trustedAdmin,
      routeCtx.request,
    ),
  ),
} satisfies DynamicAdminRouteBindingMap;

export const DYNAMIC_ADMIN_ROUTE_HANDLER_KEYS = Object.freeze(
  Object.keys(DYNAMIC_ADMIN_ROUTE_BINDINGS) as DynamicAdminEndpointKey[],
);

function bindDynamicAdminRouteMatch<Key extends DynamicAdminEndpointKey>(
  dynamicAdminEndpoint: DynamicAdminEndpointFor<Key>,
): RouteMatch {
  const binding = DYNAMIC_ADMIN_ROUTE_BINDINGS[dynamicAdminEndpoint.key] as unknown as DynamicAdminRouteBinding<Key>;
  return {
    dependencies: binding.dependencies,
    handle: (routeCtx) => binding.handle(routeCtx, dynamicAdminEndpoint),
  };
}

export function getDynamicRouteMatch(path: string): RouteMatch | null {
  const dynamicAdminEndpoint = matchDynamicAdminEndpoint(path);
  if (dynamicAdminEndpoint) {
    return bindDynamicAdminRouteMatch(dynamicAdminEndpoint);
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
