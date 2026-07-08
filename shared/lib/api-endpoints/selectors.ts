import type {
  EndpointDefinition,
  EndpointDependency,
  EndpointKey,
  EndpointMethod,
  EndpointProbeGroup,
  EndpointPublicApiAccess,
  EndpointSiteDataAccess,
} from "./definitions";
import { ENDPOINT_DEFINITIONS } from "./definitions";
import type { DynamicEndpointDescriptorKey } from "./dynamic";
import { DYNAMIC_ENDPOINT_DESCRIPTORS } from "./dynamic";

export type EndpointMetadataScope = "static" | "dynamic";

export interface StaticEndpointRouteDefinition {
  scope: "static";
  endpoint: EndpointDefinition;
}

export interface DynamicEndpointRouteDefinition {
  scope: "dynamic";
  key: DynamicEndpointDescriptorKey;
  pattern: RegExp;
  methods: readonly EndpointMethod[];
  dependencies: readonly EndpointDependency[];
}

export interface StaticEndpointAccessPolicy {
  scope: "static";
  key: string;
  path: string;
  methods: readonly EndpointMethod[];
  adminRequired: boolean;
  publicApiAccess: EndpointPublicApiAccess;
  siteDataAccess: EndpointSiteDataAccess;
}

export interface DynamicEndpointAccessPolicy {
  scope: "dynamic";
  key: DynamicEndpointDescriptorKey;
  pattern: RegExp;
  routePath: string | null;
  methods: readonly EndpointMethod[];
  adminRequired: boolean;
  publicApiAccess: EndpointPublicApiAccess;
  siteDataAccess: EndpointSiteDataAccess;
}

export interface StaticEndpointCachePolicy {
  scope: "static";
  key: string;
  path: string;
  cacheBypass: boolean;
}

export interface StaticPublicApiEndpointDefinition extends StaticEndpointAccessPolicy {
  cacheBypass: boolean;
  strictContract: boolean;
}

export type PublicApiEndpointDefinition = StaticPublicApiEndpointDefinition | DynamicEndpointAccessPolicy;

export interface EndpointDefinitionProbe {
  source: "endpoint-definition";
  key: string;
  definitionPath: string;
  path: string;
  group: EndpointProbeGroup;
  probeSemanticKind?: EndpointDefinition["probeSemanticKind"];
}

export interface StaticEndpointDependencyHydrationPolicy {
  scope: "static";
  key: string;
  path: string;
  dependencies: readonly EndpointDependency[];
}

export interface DynamicEndpointDependencyHydrationPolicy {
  scope: "dynamic";
  key: DynamicEndpointDescriptorKey;
  pattern: RegExp;
  routePath: string | null;
  dependencies: readonly EndpointDependency[];
}

export type EndpointDependencyHydrationPolicy =
  | StaticEndpointDependencyHydrationPolicy
  | DynamicEndpointDependencyHydrationPolicy;

export function isStaticEndpointPath(path: string): boolean {
  return !path.includes(":") && !path.includes("*");
}

function isStaticEndpointDefinition(endpoint: Pick<EndpointDefinition, "path">): boolean {
  return isStaticEndpointPath(endpoint.path);
}

export const STATIC_ENDPOINT_ROUTE_DEFINITIONS: readonly EndpointDefinition[] =
  ENDPOINT_DEFINITIONS.filter(isStaticEndpointDefinition);

export const DYNAMIC_ENDPOINT_ROUTE_DEFINITIONS: readonly DynamicEndpointRouteDefinition[] =
  DYNAMIC_ENDPOINT_DESCRIPTORS.map((descriptor) => ({
    scope: "dynamic",
    key: descriptor.key,
    pattern: descriptor.pattern,
    methods: descriptor.methods,
    dependencies: descriptor.routeDependencies,
  }));

export const STATIC_ENDPOINT_ACCESS_POLICIES: readonly StaticEndpointAccessPolicy[] =
  STATIC_ENDPOINT_ROUTE_DEFINITIONS.map((endpoint) => ({
    scope: "static",
    key: endpoint.key,
    path: endpoint.path,
    methods: endpoint.methods,
    adminRequired: endpoint.adminRequired,
    publicApiAccess: endpoint.publicApiAccess,
    siteDataAccess: endpoint.siteDataAccess,
  }));

export const DYNAMIC_ENDPOINT_ACCESS_POLICIES: readonly DynamicEndpointAccessPolicy[] =
  DYNAMIC_ENDPOINT_DESCRIPTORS.map((descriptor) => ({
    scope: "dynamic",
    key: descriptor.key,
    pattern: descriptor.pattern,
    routePath: descriptor.requestAttribution?.routePath ?? null,
    methods: descriptor.methods,
    adminRequired: descriptor.adminRequired,
    publicApiAccess: descriptor.publicApiAccess,
    siteDataAccess: descriptor.siteDataAccess,
  }));

export const STATIC_ENDPOINT_CACHE_POLICIES: readonly StaticEndpointCachePolicy[] =
  STATIC_ENDPOINT_ROUTE_DEFINITIONS.map((endpoint) => ({
    scope: "static",
    key: endpoint.key,
    path: endpoint.path,
    cacheBypass: endpoint.cacheBypass,
  }));

export const PUBLIC_API_ENDPOINT_DEFINITIONS: readonly PublicApiEndpointDefinition[] = [
  ...STATIC_ENDPOINT_ROUTE_DEFINITIONS
    .filter((endpoint) => !endpoint.adminRequired && endpoint.path.startsWith("/api/"))
    .map((endpoint): StaticPublicApiEndpointDefinition => ({
      scope: "static",
      key: endpoint.key,
      path: endpoint.path,
      methods: endpoint.methods,
      adminRequired: endpoint.adminRequired,
      publicApiAccess: endpoint.publicApiAccess,
      siteDataAccess: endpoint.siteDataAccess,
      cacheBypass: endpoint.cacheBypass,
      strictContract: endpoint.strictContract ?? false,
    })),
  ...DYNAMIC_ENDPOINT_ACCESS_POLICIES.filter((policy) => !policy.adminRequired),
];

export const ENDPOINT_DEFINITION_PROBES: readonly EndpointDefinitionProbe[] = ENDPOINT_DEFINITIONS.flatMap(
  (endpoint) => {
    if (!endpoint.probeGroup) return [];
    return [
      {
        source: "endpoint-definition",
        key: endpoint.key,
        definitionPath: endpoint.path,
        path: endpoint.probePath ?? endpoint.path,
        group: endpoint.probeGroup,
        ...(endpoint.probeSemanticKind ? { probeSemanticKind: endpoint.probeSemanticKind } : {}),
      },
    ];
  },
);

export const STATIC_ENDPOINT_DEPENDENCY_HYDRATION_POLICIES: readonly StaticEndpointDependencyHydrationPolicy[] =
  STATIC_ENDPOINT_ROUTE_DEFINITIONS.map((endpoint) => ({
    scope: "static",
    key: endpoint.key,
    path: endpoint.path,
    dependencies: endpoint.routeDependencies ?? [],
  }));

export const DYNAMIC_ENDPOINT_DEPENDENCY_HYDRATION_POLICIES: readonly DynamicEndpointDependencyHydrationPolicy[] =
  DYNAMIC_ENDPOINT_DESCRIPTORS.map((descriptor) => ({
    scope: "dynamic",
    key: descriptor.key,
    pattern: descriptor.pattern,
    routePath: descriptor.requestAttribution?.routePath ?? null,
    dependencies: descriptor.routeDependencies,
  }));

export const ENDPOINT_DEPENDENCY_HYDRATION_POLICIES: readonly EndpointDependencyHydrationPolicy[] = [
  ...STATIC_ENDPOINT_DEPENDENCY_HYDRATION_POLICIES,
  ...DYNAMIC_ENDPOINT_DEPENDENCY_HYDRATION_POLICIES,
];

const STATIC_ENDPOINT_DEPENDENCIES_BY_KEY = new Map<string, readonly EndpointDependency[]>(
  STATIC_ENDPOINT_DEPENDENCY_HYDRATION_POLICIES.map((policy) => [policy.key, policy.dependencies]),
);

export function getStaticEndpointDependenciesByKey(key: EndpointKey | string): readonly EndpointDependency[] | undefined {
  return STATIC_ENDPOINT_DEPENDENCIES_BY_KEY.get(key);
}

export function getEndpointProbePaths(group: EndpointProbeGroup): string[] {
  return ENDPOINT_DEFINITION_PROBES.filter((probe) => probe.group === group).map((probe) => probe.path);
}

export function getEndpointProbeDescriptors(
  group: EndpointProbeGroup,
): { path: string; probeSemanticKind?: EndpointDefinition["probeSemanticKind"] }[] {
  return ENDPOINT_DEFINITION_PROBES.filter((probe) => probe.group === group).map((probe) => ({
    path: probe.path,
    probeSemanticKind: probe.probeSemanticKind,
  }));
}
