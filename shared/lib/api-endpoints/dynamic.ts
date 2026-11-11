import {
  getEndpointDefinitionByKey,
  type EndpointDependency,
  type EndpointKey,
  type EndpointMethod,
  type EndpointPublicApiAccess,
  type EndpointSiteDataAccess,
} from "./definitions";
import { DYNAMIC_API_PATHS } from "./paths";
export type DynamicEndpointDescriptorKey =
  | "stablecoin-summary"
  | "stablecoin-reserves"
  | "stablecoin-detail"
  | "stablecoin-live-summary"
  | "og-image"
  | "snapshot-day"
  | "snapshot-coin"
  | "api-key-update"
  | "api-key-deactivate"
  | "api-key-rotate";

export interface DynamicEndpointDescriptor {
  key: DynamicEndpointDescriptorKey;
  pattern: RegExp;
  methods: readonly EndpointMethod[];
  publicApiAccess: EndpointPublicApiAccess;
  siteDataAccess: EndpointSiteDataAccess;
  adminRequired: boolean;
  /** Mirrors the owning definition: the handler consumes no query string. */
  cacheKeyIgnoresQuery?: boolean;
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
    cacheKeyIgnoresQuery: definition.cacheKeyIgnoresQuery,
    routeDependencies: definition.routeDependencies ?? [],
    requestAttribution: { routeKey: definition.key, routePath: definition.path },
  };
}

export const DYNAMIC_ENDPOINT_DESCRIPTORS = [
  publicDynamic({ key: "stablecoin-summary", pattern: DYNAMIC_API_PATHS.stablecoinSummary.pattern }),
  publicDynamic({ key: "stablecoin-reserves", pattern: DYNAMIC_API_PATHS.stablecoinReserves.pattern }),
  publicDynamic({ key: "stablecoin-detail", pattern: DYNAMIC_API_PATHS.stablecoinDetail.pattern }),
  publicDynamic({ key: "stablecoin-live-summary", pattern: DYNAMIC_API_PATHS.stablecoinLiveSummary.pattern }),
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
  publicDynamic({ key: "snapshot-day", pattern: DYNAMIC_API_PATHS.snapshotDay.pattern }),
  publicDynamic({ key: "snapshot-coin", pattern: DYNAMIC_API_PATHS.snapshotCoin.pattern }),
  adminDynamicPost({
    key: "api-key-update",
    pattern: DYNAMIC_API_PATHS.apiKeyUpdate.pattern,
    routeDependencies: ["apiKeyHashPepper"],
  }),
  adminDynamicPost({
    key: "api-key-deactivate",
    pattern: DYNAMIC_API_PATHS.apiKeyDeactivate.pattern,
    routeDependencies: [],
  }),
  adminDynamicPost({
    key: "api-key-rotate",
    pattern: DYNAMIC_API_PATHS.apiKeyRotate.pattern,
    routeDependencies: ["apiKeyHashPepper"],
  }),
] as const satisfies readonly DynamicEndpointDescriptor[];

export function findDynamicEndpointDescriptor(path: string): DynamicEndpointDescriptor | null {
  return DYNAMIC_ENDPOINT_DESCRIPTORS.find((descriptor) => descriptor.pattern.test(path)) ?? null;
}

export function getDynamicEndpointDescriptorByKey(key: DynamicEndpointDescriptorKey): DynamicEndpointDescriptor | null {
  return DYNAMIC_ENDPOINT_DESCRIPTORS.find((descriptor) => descriptor.key === key) ?? null;
}
