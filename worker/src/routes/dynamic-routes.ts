import {
  DYNAMIC_ENDPOINT_DESCRIPTORS,
  getDynamicEndpointDescriptorByKey,
  matchDynamicAdminEndpoint,
  type DynamicAdminEndpointMatch,
  type EndpointMethod,
} from "@shared/lib/api-endpoints";
import { errorResponse } from "../lib/api-response";
import {
  defineDynamicRoute,
  type DynamicRouteDefinition,
  type FullRouteContext,
  type RouteDependency,
  type RouteMatch,
} from "./shared";

/** Decode a raw URI segment and resolve it to a canonical stablecoin id.
 * Returns `{ canonicalId }` on success or a ready `Response` on failure. */
async function decodeAndResolveStablecoinId(
  raw: string,
  malformedMessage: string,
): Promise<{ canonicalId: string } | Response> {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return errorResponse(400, malformedMessage);
  }
  const { resolveOrReject } = await import("../lib/api-params");
  return resolveOrReject(id);
}

async function resolveDynamicStablecoinRoute(
  match: RegExpMatchArray,
  handler: (canonicalId: string) => Promise<Response>,
): Promise<Response> {
  const resolved = await decodeAndResolveStablecoinId(match[1], "Malformed URI");
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
    resolveDynamicStablecoinRoute(match, async (canonicalId) => {
      const { handleStablecoinSummary } = await import("../api/stablecoin-summary");
      return handleStablecoinSummary(routeCtx.db, canonicalId);
    }),
  ),
  defineDynamicRouteFromDescriptor("stablecoin-reserves", (routeCtx, match) =>
    resolveDynamicStablecoinRoute(match, async (canonicalId) => {
      const { handleStablecoinReserves } = await import("../api/stablecoin-reserves");
      return handleStablecoinReserves(routeCtx.db, canonicalId);
    }),
  ),
  defineDynamicRouteFromDescriptor("stablecoin-detail", (routeCtx, match) =>
    resolveDynamicStablecoinRoute(match, async (canonicalId) => {
      const { handleStablecoinDetail } = await import("../api/stablecoin-detail");
      return handleStablecoinDetail(routeCtx.db, canonicalId, routeCtx.execCtx, routeCtx.coingeckoApiKey);
    }),
  ),
  defineDynamicRouteFromDescriptor("og-image", async (routeCtx) => {
    const { handleOg } = await import("../api/og");
    return handleOg(routeCtx.db, routeCtx.url.pathname, routeCtx.request.method).then(
      (response) => response ?? errorResponse(404, "Unknown OG route"),
    );
  }),
  defineDynamicRouteFromDescriptor("snapshot-day", async (routeCtx, match) => {
    const { handleSnapshotDay } = await import("../api/snapshot");
    return handleSnapshotDay(routeCtx.db, match[1]);
  }),
  defineDynamicRouteFromDescriptor("snapshot-coin", async (routeCtx, match) => {
    // Resolve alias ids so /api/snapshot/<date>/stablecoin/<alias> 404s
    // consistently with sibling /api/stablecoin/<id> endpoints rather
    // than misattributing the snapshot row to the wrong canonical id.
    const resolved = await decodeAndResolveStablecoinId(match[2], "Malformed stablecoin id");
    if (resolved instanceof Response) {
      return Promise.resolve(resolved);
    }
    const { handleSnapshotCoin } = await import("../api/snapshot");
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
  "api-key-update": defineDynamicAdminRouteBinding("api-key-update", async (routeCtx, dynamicAdminEndpoint) => {
    const { handleApiKeyUpdateRoute } = await import("../api/api-keys");
    return handleApiKeyUpdateRoute({ ...routeCtx, apiKeyId: dynamicAdminEndpoint.apiKeyId });
  }),
  "api-key-deactivate": defineDynamicAdminRouteBinding("api-key-deactivate", async (routeCtx, dynamicAdminEndpoint) => {
    const { handleApiKeyDeactivateRoute } = await import("../api/api-keys");
    return handleApiKeyDeactivateRoute({ ...routeCtx, apiKeyId: dynamicAdminEndpoint.apiKeyId });
  }),
  "api-key-rotate": defineDynamicAdminRouteBinding("api-key-rotate", async (routeCtx, dynamicAdminEndpoint) => {
    const { handleApiKeyRotateRoute } = await import("../api/api-keys");
    return handleApiKeyRotateRoute({ ...routeCtx, apiKeyId: dynamicAdminEndpoint.apiKeyId });
  }),
  "api-key-request-reject": defineDynamicAdminRouteBinding(
    "api-key-request-reject",
    async (routeCtx, dynamicAdminEndpoint) => {
      const { handleApiKeyRequestRejectRoute } = await import("../api/api-key-requests");
      return handleApiKeyRequestRejectRoute({ ...routeCtx, requestId: dynamicAdminEndpoint.requestId });
    },
  ),
  "api-key-request-release-claim": defineDynamicAdminRouteBinding(
    "api-key-request-release-claim",
    async (routeCtx, dynamicAdminEndpoint) => {
      const { handleApiKeyRequestReleaseClaimRoute } = await import("../api/api-key-requests");
      return handleApiKeyRequestReleaseClaimRoute({ ...routeCtx, requestId: dynamicAdminEndpoint.requestId });
    },
  ),
  "admin-telegram-chat": defineDynamicAdminRouteBinding(
    "admin-telegram-chat",
    async (routeCtx, dynamicAdminEndpoint) => {
      const { handleAdminTelegramChat } = await import("../api/admin-telegram-chat");
      return handleAdminTelegramChat(routeCtx.db, dynamicAdminEndpoint.chatId, routeCtx.trustedAdmin, routeCtx.request);
    },
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
