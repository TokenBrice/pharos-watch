import {
  DYNAMIC_ENDPOINT_DESCRIPTORS,
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
type DynamicAdminEndpointFor<Key extends DynamicAdminEndpointKey> = Extract<
  ExpandedDynamicAdminEndpointMatch,
  { key: Key }
>;
type DynamicAdminRouteBinding = {
  dependencies: readonly RouteDependency[];
  methods: readonly EndpointMethod[];
  handle: (routeCtx: FullRouteContext, dynamicAdminEndpoint: DynamicAdminEndpointMatch) => Promise<Response>;
};
type DynamicAdminRouteBindingMap = {
  [Key in DynamicAdminEndpointKey]: DynamicAdminRouteBinding;
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
  defineDynamicRouteFromDescriptor("stablecoin-summary", (routeCtx, match) =>
    resolveDynamicStablecoinRoute(match, (canonicalId) => handleStablecoinSummary(routeCtx.db, canonicalId)),
  ),
  defineDynamicRouteFromDescriptor("stablecoin-reserves", (routeCtx, match) =>
    resolveDynamicStablecoinRoute(match, (canonicalId) => handleStablecoinReserves(routeCtx.db, canonicalId)),
  ),
  defineDynamicRouteFromDescriptor("stablecoin-detail", (routeCtx, match) =>
    resolveDynamicStablecoinRoute(match, (canonicalId) =>
      handleStablecoinDetail(routeCtx.db, canonicalId, routeCtx.execCtx, routeCtx.coingeckoApiKey),
    ),
  ),
  defineDynamicRouteFromDescriptor("og-image", (routeCtx) =>
    handleOg(routeCtx.db, routeCtx.url.pathname).then((response) => response ?? errorResponse(404, "Unknown OG route")),
  ),
  defineDynamicRouteFromDescriptor("snapshot-day", (routeCtx, match) => handleSnapshotDay(routeCtx.db, match[1])),
  defineDynamicRouteFromDescriptor("snapshot-coin", (routeCtx, match) => {
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
  }),
] as const satisfies readonly DynamicRouteDefinition[];

function defineDynamicAdminRouteBinding<Key extends DynamicAdminEndpointKey>(
  key: Key,
  handle: (routeCtx: FullRouteContext, dynamicAdminEndpoint: DynamicAdminEndpointFor<Key>) => Promise<Response>,
): DynamicAdminRouteBinding {
  const descriptor = requireDynamicEndpointDescriptor(key);
  return {
    dependencies: descriptor.routeDependencies,
    methods: descriptor.methods,
    handle: (routeCtx, dynamicAdminEndpoint) => {
      if (dynamicAdminEndpoint.key !== key) {
        throw new Error(`Dynamic admin route binding "${key}" received endpoint "${dynamicAdminEndpoint.key}"`);
      }
      return handle(routeCtx, dynamicAdminEndpoint as DynamicAdminEndpointFor<Key>);
    },
  };
}

const DYNAMIC_ADMIN_ROUTE_BINDINGS = {
  "discovery-candidate-dismiss": defineDynamicAdminRouteBinding(
    "discovery-candidate-dismiss",
    (routeCtx, dynamicAdminEndpoint) => handleDiscoveryCandidateDismiss(routeCtx, dynamicAdminEndpoint.candidateId),
  ),
  "api-key-update": defineDynamicAdminRouteBinding("api-key-update", (routeCtx, dynamicAdminEndpoint) =>
    handleApiKeyUpdateRoute({ ...routeCtx, apiKeyId: dynamicAdminEndpoint.apiKeyId }),
  ),
  "api-key-deactivate": defineDynamicAdminRouteBinding("api-key-deactivate", (routeCtx, dynamicAdminEndpoint) =>
    handleApiKeyDeactivateRoute({ ...routeCtx, apiKeyId: dynamicAdminEndpoint.apiKeyId }),
  ),
  "api-key-rotate": defineDynamicAdminRouteBinding("api-key-rotate", (routeCtx, dynamicAdminEndpoint) =>
    handleApiKeyRotateRoute({ ...routeCtx, apiKeyId: dynamicAdminEndpoint.apiKeyId }),
  ),
  "api-key-request-reject": defineDynamicAdminRouteBinding("api-key-request-reject", (routeCtx, dynamicAdminEndpoint) =>
    handleApiKeyRequestRejectRoute({ ...routeCtx, requestId: dynamicAdminEndpoint.requestId }),
  ),
  "api-key-request-release-claim": defineDynamicAdminRouteBinding(
    "api-key-request-release-claim",
    (routeCtx, dynamicAdminEndpoint) =>
      handleApiKeyRequestReleaseClaimRoute({ ...routeCtx, requestId: dynamicAdminEndpoint.requestId }),
  ),
  "admin-telegram-chat": defineDynamicAdminRouteBinding("admin-telegram-chat", (routeCtx, dynamicAdminEndpoint) =>
    handleAdminTelegramChat(routeCtx.db, dynamicAdminEndpoint.chatId, routeCtx.trustedAdmin, routeCtx.request),
  ),
} satisfies DynamicAdminRouteBindingMap;

export const DYNAMIC_ADMIN_ROUTE_HANDLER_KEYS = Object.freeze(
  Object.keys(DYNAMIC_ADMIN_ROUTE_BINDINGS) as DynamicAdminEndpointKey[],
);

function assertDynamicAdminRouteBindings(): void {
  const descriptorKeys = DYNAMIC_ENDPOINT_DESCRIPTORS.filter((descriptor) => descriptor.adminRequired)
    .map((descriptor) => descriptor.key)
    .sort();
  const bindingKeys = [...DYNAMIC_ADMIN_ROUTE_HANDLER_KEYS].sort();
  if (descriptorKeys.length !== bindingKeys.length || descriptorKeys.some((key, index) => key !== bindingKeys[index])) {
    throw new Error(
      `Dynamic admin route bindings must match shared descriptors. descriptors=${descriptorKeys.join(",")} bindings=${bindingKeys.join(",")}`,
    );
  }
}

assertDynamicAdminRouteBindings();

function bindMatchedDynamicAdminRoute(dynamicAdminEndpoint: DynamicAdminEndpointMatch): RouteMatch {
  const binding = DYNAMIC_ADMIN_ROUTE_BINDINGS[dynamicAdminEndpoint.key];
  return {
    dependencies: binding.dependencies,
    methods: binding.methods,
    handle: (routeCtx) => binding.handle(routeCtx, dynamicAdminEndpoint),
  };
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
