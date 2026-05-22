import {
  getDynamicEndpointDescriptorByKey,
  matchDynamicAdminEndpoint,
  type DynamicAdminEndpointMatch,
  type EndpointMethod,
} from "@shared/lib/api-endpoints";
import { handleStablecoinDetail } from "../api/stablecoin-detail";
import { handleStablecoinSummary } from "../api/stablecoin-summary";
import { handleStablecoinReserves } from "../api/stablecoin-reserves";
import { handleSnapshotCoin, handleSnapshotDay } from "../api/snapshot";
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
  T extends DynamicAdminEndpointMatch
    ? T["key"] extends infer Key
      ? Key extends DynamicAdminEndpointKey
        ? Omit<T, "key"> & { key: Key }
        : never
      : never
    : never;
type DynamicAdminEndpointFor<Key extends DynamicAdminEndpointKey> =
  Extract<ExpandedDynamicAdminEndpointMatch, { key: Key }>;
type DynamicAdminRouteBinding<Key extends DynamicAdminEndpointKey> = {
  dependencies: readonly RouteDependency[];
  methods: readonly EndpointMethod[];
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
  return defineDynamicRoute(descriptor.pattern, descriptor.routeDependencies, descriptor.methods, handle);
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
  defineDynamicRouteFromDescriptor(
    "snapshot-day",
    (routeCtx, match) => handleSnapshotDay(routeCtx.db, match[1]),
  ),
  defineDynamicRouteFromDescriptor(
    "snapshot-coin",
    (routeCtx, match) => {
      let stablecoinId: string;
      try {
        stablecoinId = decodeURIComponent(match[2]);
      } catch {
        return Promise.resolve(errorResponse(400, "Malformed stablecoin id"));
      }
      // Resolve alias ids so /api/snapshot/<date>/stablecoin/<alias> 404s
      // consistently with sibling /api/stablecoin/<id> endpoints rather
      // than misattributing the snapshot row to the wrong canonical id.
      const resolved = resolveOrReject(stablecoinId);
      if (resolved instanceof Response) {
        return Promise.resolve(resolved);
      }
      return handleSnapshotCoin(routeCtx.db, match[1], resolved.canonicalId);
    },
  ),
] as const satisfies readonly DynamicRouteDefinition[];

function defineDynamicAdminRouteBinding<Key extends DynamicAdminEndpointKey>(
  key: Key,
  handle: DynamicAdminRouteBinding<Key>["handle"],
): DynamicAdminRouteBinding<Key> {
  const descriptor = requireDynamicEndpointDescriptor(key);
  return {
    dependencies: descriptor.routeDependencies,
    methods: descriptor.methods,
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
  binding: DynamicAdminRouteBinding<Key>,
): RouteMatch {
  return {
    dependencies: binding.dependencies,
    methods: binding.methods,
    handle: (routeCtx) => binding.handle(routeCtx, dynamicAdminEndpoint),
  };
}

function isDynamicAdminEndpoint<Key extends DynamicAdminEndpointKey>(
  dynamicAdminEndpoint: DynamicAdminEndpointMatch,
  key: Key,
): dynamicAdminEndpoint is DynamicAdminEndpointFor<Key> {
  return dynamicAdminEndpoint.key === key;
}

function bindMatchedDynamicAdminRoute(dynamicAdminEndpoint: DynamicAdminEndpointMatch): RouteMatch {
  if (isDynamicAdminEndpoint(dynamicAdminEndpoint, "discovery-candidate-dismiss")) {
    return bindDynamicAdminRouteMatch(
      dynamicAdminEndpoint,
      DYNAMIC_ADMIN_ROUTE_BINDINGS["discovery-candidate-dismiss"],
    );
  }
  if (isDynamicAdminEndpoint(dynamicAdminEndpoint, "api-key-update")) {
    return bindDynamicAdminRouteMatch(dynamicAdminEndpoint, DYNAMIC_ADMIN_ROUTE_BINDINGS["api-key-update"]);
  }
  if (isDynamicAdminEndpoint(dynamicAdminEndpoint, "api-key-deactivate")) {
    return bindDynamicAdminRouteMatch(dynamicAdminEndpoint, DYNAMIC_ADMIN_ROUTE_BINDINGS["api-key-deactivate"]);
  }
  if (isDynamicAdminEndpoint(dynamicAdminEndpoint, "api-key-rotate")) {
    return bindDynamicAdminRouteMatch(dynamicAdminEndpoint, DYNAMIC_ADMIN_ROUTE_BINDINGS["api-key-rotate"]);
  }
  if (isDynamicAdminEndpoint(dynamicAdminEndpoint, "api-key-request-reject")) {
    return bindDynamicAdminRouteMatch(
      dynamicAdminEndpoint,
      DYNAMIC_ADMIN_ROUTE_BINDINGS["api-key-request-reject"],
    );
  }
  if (isDynamicAdminEndpoint(dynamicAdminEndpoint, "api-key-request-release-claim")) {
    return bindDynamicAdminRouteMatch(
      dynamicAdminEndpoint,
      DYNAMIC_ADMIN_ROUTE_BINDINGS["api-key-request-release-claim"],
    );
  }
  if (isDynamicAdminEndpoint(dynamicAdminEndpoint, "admin-telegram-chat")) {
    return bindDynamicAdminRouteMatch(dynamicAdminEndpoint, DYNAMIC_ADMIN_ROUTE_BINDINGS["admin-telegram-chat"]);
  }
  throw new Error(`Unhandled dynamic admin endpoint: ${dynamicAdminEndpoint.key}`);
}

export function getDynamicRouteMatch(path: string): RouteMatch | null {
  const dynamicAdminEndpoint = matchDynamicAdminEndpoint(path);
  if (dynamicAdminEndpoint) {
    return bindMatchedDynamicAdminRoute(dynamicAdminEndpoint);
  }

  for (const definition of DYNAMIC_ROUTE_DEFINITIONS) {
    const match = path.match(definition.pattern);
    if (match) {
      return {
        dependencies: definition.dependencies,
        methods: definition.methods,
        handle: (routeCtx) => definition.handle(routeCtx, match),
      };
    }
  }

  return null;
}
