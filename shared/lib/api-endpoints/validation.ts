import type {
  DynamicAdminEndpointMatch,
  EndpointDefinition,
  EndpointMethod,
  EndpointMethodValidationError,
  EndpointProbeGroup,
  EndpointPublicApiAccess,
  EndpointSiteDataAccess,
} from "./definitions";
import { findDynamicEndpointDescriptor } from "./dynamic";
import { ENDPOINT_DEFINITIONS, getEndpointDefinition } from "./definitions";
import { API_PATHS } from "./paths";
import { getEndpointProbePaths } from "./selectors";

const GET_ONLY_METHODS = ["GET"] as const satisfies readonly EndpointMethod[];
const POST_ONLY_METHODS = ["POST"] as const satisfies readonly EndpointMethod[];
const GET_AND_POST_METHODS = ["GET", "POST"] as const satisfies readonly EndpointMethod[];
const AUDIT_DEPEG_HISTORY_PATH = API_PATHS.auditDepegHistoryBase();
const BACKFILL_DEWS_PATH = API_PATHS.backfillDews();
const ADMIN_DYNAMIC_PATH_ROOTS = [
  "/api/api-key-requests-admin",
  "/api/api-keys",
] as const;
const ADMIN_STATIC_PATH_ROOTS = ENDPOINT_DEFINITIONS
  .filter((endpoint) => endpoint.adminRequired)
  .map((endpoint) => endpoint.path);

function isPathOrChild(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

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

  if (
    dynamicDescriptor.key === "api-key-request-reject"
    || dynamicDescriptor.key === "api-key-request-release-claim"
  ) {
    let requestId: string;
    try {
      requestId = decodeURIComponent(match[1] ?? "");
    } catch {
      return null;
    }
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) {
      return null;
    }
    return {
      key: dynamicDescriptor.key,
      path,
      requestId,
      methods: dynamicDescriptor.methods,
    };
  }

  const apiKeyId = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isSafeInteger(apiKeyId) || apiKeyId <= 0) {
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

export function isAdminLikePath(path: string): boolean {
  if (isAdminPath(path)) return true;
  if (ADMIN_DYNAMIC_PATH_ROOTS.some((root) => isPathOrChild(path, root))) return true;
  return ADMIN_STATIC_PATH_ROOTS.some((root) => isPathOrChild(path, root));
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

export function getEndpointAllowedMethods(
  url: URL,
  endpoint: Pick<EndpointDefinition, "methods" | "mutatingAdmin">,
): readonly EndpointMethod[] {
  if (endpoint.mutatingAdmin && endpoint.methods.includes("GET") && !isMutatingAdminGetAllowed(url)) {
    return POST_ONLY_METHODS;
  }
  return endpoint.methods;
}

function getAllowedEndpointMethods(url: URL): readonly EndpointMethod[] | null {
  const definition = getEndpointDefinition(url.pathname);
  if (definition) {
    return getEndpointAllowedMethods(url, definition);
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
  return dynamicAdminEndpoint ? dynamicDescriptor : null;
}

export function validateAllowedEndpointMethods(
  method: string,
  allowedMethods: readonly EndpointMethod[],
): EndpointMethodValidationError | null {
  if (method !== "GET" && method !== "HEAD" && method !== "POST") {
    return { message: "Method not allowed", allowedMethods: GET_AND_POST_METHODS };
  }

  if (allowedMethods.includes(method as EndpointMethod)) {
    return null;
  }

  const postOnly =
    (method === "GET" || method === "HEAD") && allowedMethods.length === 1 && allowedMethods[0] === "POST";
  return {
    message: postOnly ? "Method not allowed. Use POST for this endpoint." : "Method not allowed",
    allowedMethods,
  };
}

export function validateEndpointMethod(url: URL, method: string): EndpointMethodValidationError | null {
  const allowedMethods = getAllowedEndpointMethods(url);
  return validateAllowedEndpointMethods(method, allowedMethods ?? GET_ONLY_METHODS);
}

export function getProbePaths(group: EndpointProbeGroup): string[] {
  return getEndpointProbePaths(group);
}
