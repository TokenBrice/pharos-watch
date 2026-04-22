import type {
  DynamicAdminEndpointMatch,
  EndpointDefinition,
  EndpointMethodValidationError,
  EndpointProbeGroup,
  EndpointPublicApiAccess,
  EndpointSiteDataAccess,
} from "./definitions";
import { findDynamicEndpointDescriptor, getDynamicEndpointDescriptorByKey } from "./dynamic";
import { ENDPOINT_DEFINITIONS, getEndpointDefinition } from "./definitions";

type EndpointMethod = "GET" | "POST";

const GET_ONLY_METHODS = ["GET"] as const satisfies readonly EndpointMethod[];
const POST_ONLY_METHODS = ["POST"] as const satisfies readonly EndpointMethod[];
const GET_AND_POST_METHODS = ["GET", "POST"] as const satisfies readonly EndpointMethod[];
const AUDIT_DEPEG_HISTORY_PATH = "/api/audit-depeg-history";
const BACKFILL_DEWS_PATH = "/api/backfill-dews";

export function getPublicApiAccess(path: string): EndpointPublicApiAccess | null {
  const endpoint = getEndpointDefinition(path);
  if (endpoint) {
    return endpoint.publicApiAccess;
  }
  const dynamicDescriptor = getResolvedDynamicEndpointDescriptor(path);
  if (dynamicDescriptor) {
    return dynamicDescriptor.publicApiAccess;
  }
  return null;
}

export function isProtectedPublicApiPath(path: string): boolean {
  return getPublicApiAccess(path) === "protected";
}

export function getSiteDataAccess(path: string): EndpointSiteDataAccess | null {
  const endpoint = getEndpointDefinition(path);
  if (endpoint) {
    return endpoint.siteDataAccess;
  }
  const dynamicDescriptor = getResolvedDynamicEndpointDescriptor(path);
  if (dynamicDescriptor) {
    return dynamicDescriptor.siteDataAccess;
  }
  return null;
}

export function isSiteDataAllowedPath(path: string): boolean {
  return getSiteDataAccess(path) === "allowed";
}

export function matchDynamicAdminEndpoint(path: string): DynamicAdminEndpointMatch | null {
  const dynamicDescriptor = findDynamicEndpointDescriptor(path);
  if (!dynamicDescriptor?.adminRequired) {
    return null;
  }

  const match = path.match(dynamicDescriptor.pattern);
  if (!match) {
    return null;
  }

  if (dynamicDescriptor.key === "discovery-candidate-dismiss") {
    const candidateId = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isFinite(candidateId) || candidateId <= 0) {
      return null;
    }
    return {
      key: "discovery-candidate-dismiss",
      path,
      candidateId,
      methods: dynamicDescriptor.methods,
    };
  }

  const apiKeyId = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(apiKeyId) || apiKeyId <= 0) {
    return null;
  }
  if (
    dynamicDescriptor.key !== "api-key-update"
    && dynamicDescriptor.key !== "api-key-deactivate"
    && dynamicDescriptor.key !== "api-key-rotate"
  ) {
    return null;
  }
  return {
    key: dynamicDescriptor.key,
    path,
    apiKeyId,
    methods: dynamicDescriptor.methods,
  };
}

export function isAdminPath(path: string): boolean {
  return Boolean(getEndpointDefinition(path)?.adminRequired || matchDynamicAdminEndpoint(path));
}

export function isMutatingAdminGetAllowed(url: URL): boolean {
  if (url.pathname === AUDIT_DEPEG_HISTORY_PATH) {
    return url.searchParams.get("dry-run") === "true";
  }
  if (url.pathname === BACKFILL_DEWS_PATH) {
    return !url.searchParams.has("repair") || url.searchParams.get("dry-run") === "true";
  }
  return false;
}

function getAllowedEndpointMethods(url: URL): readonly EndpointMethod[] | null {
  const definition = getEndpointDefinition(url.pathname);
  if (definition) {
    if (definition.mutatingAdmin && definition.methods.includes("GET") && !isMutatingAdminGetAllowed(url)) {
      return POST_ONLY_METHODS;
    }
    return definition.methods;
  }

  const dynamicDescriptor = getResolvedDynamicEndpointDescriptor(url.pathname);
  if (dynamicDescriptor) {
    return dynamicDescriptor.methods;
  }

  return null;
}

function getResolvedDynamicEndpointDescriptor(path: string) {
  const dynamicDescriptor = findDynamicEndpointDescriptor(path);
  if (!dynamicDescriptor) {
    return null;
  }
  if (!dynamicDescriptor.adminRequired) {
    return dynamicDescriptor;
  }
  const dynamicAdminEndpoint = matchDynamicAdminEndpoint(path);
  return dynamicAdminEndpoint
    ? getDynamicEndpointDescriptorByKey(dynamicAdminEndpoint.key)
    : null;
}

export function validateEndpointMethod(url: URL, method: string): EndpointMethodValidationError | null {
  if (method !== "GET" && method !== "POST") {
    return { message: "Method not allowed", allowedMethods: GET_AND_POST_METHODS };
  }

  const allowedMethods = getAllowedEndpointMethods(url);
  if (!allowedMethods) {
    if (method === "POST") {
      return { message: "Method not allowed", allowedMethods: GET_ONLY_METHODS };
    }
    return null;
  }

  if (allowedMethods.includes(method as EndpointMethod)) {
    return null;
  }

  const postOnly = method === "GET" && allowedMethods.length === 1 && allowedMethods[0] === "POST";
  return {
    message: postOnly ? "Method not allowed. Use POST for this endpoint." : "Method not allowed",
    allowedMethods,
  };
}

export function getProbePaths(group: EndpointProbeGroup): string[] {
  return ENDPOINT_DEFINITIONS.filter((endpoint: EndpointDefinition) => endpoint.probeGroup === group).map(
    (endpoint: EndpointDefinition) => endpoint.probePath ?? endpoint.path,
  );
}
