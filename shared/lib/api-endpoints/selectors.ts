import type {
  EndpointDefinition,
  EndpointDependency,
  EndpointKey,
  EndpointProbeGroup,
} from "./definitions";
import { ENDPOINT_DEFINITIONS } from "./definitions";

interface EndpointDefinitionProbe {
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

export function isStaticEndpointPath(path: string): boolean {
  return !path.includes(":") && !path.includes("*");
}

function isStaticEndpointDefinition(endpoint: Pick<EndpointDefinition, "path">): boolean {
  return isStaticEndpointPath(endpoint.path);
}

export const STATIC_ENDPOINT_ROUTE_DEFINITIONS: readonly EndpointDefinition[] =
  ENDPOINT_DEFINITIONS.filter(isStaticEndpointDefinition);

const ENDPOINT_DEFINITION_PROBES: readonly EndpointDefinitionProbe[] = ENDPOINT_DEFINITIONS.flatMap(
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

const STATIC_ENDPOINT_DEPENDENCIES_BY_KEY = new Map<string, readonly EndpointDependency[]>(
  STATIC_ENDPOINT_DEPENDENCY_HYDRATION_POLICIES.map((policy) => [policy.key, policy.dependencies]),
);

export function getStaticEndpointDependenciesByKey(key: EndpointKey | string): readonly EndpointDependency[] | undefined {
  return STATIC_ENDPOINT_DEPENDENCIES_BY_KEY.get(key);
}

export function getProbePaths(group: EndpointProbeGroup): string[] {
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
