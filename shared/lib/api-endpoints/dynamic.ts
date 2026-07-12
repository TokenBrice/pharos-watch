import {
  getEndpointDefinitionByKey,
  type EndpointDependency,
  type EndpointKey,
  type EndpointMethod,
  type EndpointPublicApiAccess,
  type EndpointSiteDataAccess,
} from "./definitions";
export type DynamicEndpointDescriptorKey =
  | "stablecoin-summary"
  | "stablecoin-reserves"
  | "stablecoin-detail"
  | "og-image"
  | "snapshot-day"
  | "snapshot-coin"
  | "discovery-candidate-dismiss"
  | "api-key-update"
  | "api-key-deactivate"
  | "api-key-rotate"
  | "api-key-request-reject"
  | "api-key-request-release-claim"
  | "admin-telegram-chat";

export interface DynamicEndpointDescriptor {
  key: DynamicEndpointDescriptorKey;
  pattern: RegExp;
  methods: readonly EndpointMethod[];
  publicApiAccess: EndpointPublicApiAccess;
  siteDataAccess: EndpointSiteDataAccess;
  adminRequired: boolean;
  routeDependencies: readonly EndpointDependency[];
  requestAttribution: {
    routeKey: string;
    routePath: string;
  } | null;
}

type AdminDynamicInput<Key extends DynamicEndpointDescriptorKey, Methods extends readonly EndpointMethod[]> = {
  key: Key;
  pattern: RegExp;
  methods: Methods;
  routeDependencies: readonly EndpointDependency[];
};

type AdminDynamicDescriptor<T extends AdminDynamicInput<DynamicEndpointDescriptorKey, readonly EndpointMethod[]>> =
  T & {
    readonly publicApiAccess: "exempt";
    readonly siteDataAccess: "denied";
    readonly adminRequired: true;
    readonly requestAttribution: null;
  };

function adminDynamic<const T extends AdminDynamicInput<DynamicEndpointDescriptorKey, readonly EndpointMethod[]>>(
  descriptor: T,
): AdminDynamicDescriptor<T> {
  return {
    ...descriptor,
    publicApiAccess: "exempt",
    siteDataAccess: "denied",
    adminRequired: true,
    requestAttribution: null,
  } as AdminDynamicDescriptor<T>;
}

function adminDynamicPost<
  const T extends Omit<AdminDynamicInput<DynamicEndpointDescriptorKey, readonly ["POST"]>, "methods">,
>(descriptor: T): AdminDynamicDescriptor<T & { readonly methods: readonly ["POST"] }> {
  return adminDynamic({
    ...descriptor,
    methods: ["POST"] as const,
  });
}

function publicDynamic<Key extends DynamicEndpointDescriptorKey & EndpointKey>(
  descriptor: Pick<DynamicEndpointDescriptor, "pattern"> & { key: Key },
): DynamicEndpointDescriptor & { key: Key } {
  const definition = getEndpointDefinitionByKey(descriptor.key);
  if (!definition || definition.adminRequired || !definition.path.includes(":")) {
    throw new Error(`Public dynamic endpoint "${descriptor.key}" must use a non-admin template definition`);
  }
  return {
    ...descriptor,
    methods: definition.methods,
    publicApiAccess: definition.publicApiAccess,
    siteDataAccess: definition.siteDataAccess,
    adminRequired: definition.adminRequired,
    routeDependencies: definition.routeDependencies ?? [],
    requestAttribution: { routeKey: definition.key, routePath: definition.path },
  };
}

export const DYNAMIC_ENDPOINT_DESCRIPTORS = [
  publicDynamic({ key: "stablecoin-summary", pattern: /^\/api\/stablecoin-summary\/([^/]+)$/ }),
  publicDynamic({ key: "stablecoin-reserves", pattern: /^\/api\/stablecoin-reserves\/([^/]+)$/ }),
  publicDynamic({ key: "stablecoin-detail", pattern: /^\/api\/stablecoin\/([^/]+)$/ }),
  {
    key: "og-image",
    pattern: /^\/api\/og\//,
    methods: ["GET"],
    publicApiAccess: "exempt",
    siteDataAccess: "denied",
    adminRequired: false,
    routeDependencies: [],
    requestAttribution: {
      routeKey: "og-image",
      routePath: "/api/og/*",
    },
  },
  publicDynamic({ key: "snapshot-day", pattern: /^\/api\/snapshots\/(\d{4}-\d{2}-\d{2})\.json$/ }),
  publicDynamic({ key: "snapshot-coin", pattern: /^\/api\/snapshot\/(\d{4}-\d{2}-\d{2})\/stablecoin\/([^/]+)$/ }),
  adminDynamicPost({
    key: "discovery-candidate-dismiss",
    pattern: /^\/api\/discovery-candidates\/(\d+)\/dismiss$/,
    routeDependencies: [],
  }),
  adminDynamicPost({
    key: "api-key-update",
    pattern: /^\/api\/api-keys\/(\d+)\/update$/,
    routeDependencies: ["apiKeyHashPepper"],
  }),
  adminDynamicPost({
    key: "api-key-deactivate",
    pattern: /^\/api\/api-keys\/(\d+)\/deactivate$/,
    routeDependencies: [],
  }),
  adminDynamicPost({
    key: "api-key-rotate",
    pattern: /^\/api\/api-keys\/(\d+)\/rotate$/,
    routeDependencies: ["apiKeyHashPepper"],
  }),
  adminDynamicPost({
    key: "api-key-request-reject",
    pattern: /^\/api\/api-key-requests-admin\/([^/]+)\/reject$/,
    routeDependencies: [],
  }),
  adminDynamicPost({
    key: "api-key-request-release-claim",
    pattern: /^\/api\/api-key-requests-admin\/([^/]+)\/release-claim$/,
    routeDependencies: [],
  }),
  adminDynamic({
    key: "admin-telegram-chat",
    pattern: /^\/api\/admin-telegram-chat\/(-?\d+)$/,
    methods: ["GET"] as const,
    routeDependencies: [],
  }),
] as const satisfies readonly DynamicEndpointDescriptor[];

export function findDynamicEndpointDescriptor(path: string): DynamicEndpointDescriptor | null {
  return DYNAMIC_ENDPOINT_DESCRIPTORS.find((descriptor) => descriptor.pattern.test(path)) ?? null;
}

export function getDynamicEndpointDescriptorByKey(key: DynamicEndpointDescriptorKey): DynamicEndpointDescriptor | null {
  return DYNAMIC_ENDPOINT_DESCRIPTORS.find((descriptor) => descriptor.key === key) ?? null;
}
