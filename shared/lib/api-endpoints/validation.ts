import type {
  DynamicAdminEndpointMatch,
  EndpointDefinition,
  EndpointMethodValidationError,
  EndpointProbeGroup,
  EndpointPublicApiAccess,
  EndpointSiteDataAccess,
} from "./definitions";
import { ENDPOINT_DEFINITIONS, getEndpointDefinition } from "./definitions";

type EndpointMethod = "GET" | "POST";

const STABLECOIN_DETAIL_PATH_PATTERN = /^\/api\/stablecoin\/[^/]+$/;
const STABLECOIN_SUMMARY_PATH_PATTERN = /^\/api\/stablecoin-summary\/[^/]+$/;
const STABLECOIN_RESERVES_PATH_PATTERN = /^\/api\/stablecoin-reserves\/[^/]+$/;
const OG_IMAGE_PATH_PATTERN = /^\/api\/og\//;
const DISCOVERY_DISMISS_PATH_PATTERN = /^\/api\/discovery-candidates\/(\d+)\/dismiss$/;
const API_KEY_UPDATE_PATH_PATTERN = /^\/api\/api-keys\/(\d+)\/update$/;
const API_KEY_DEACTIVATE_PATH_PATTERN = /^\/api\/api-keys\/(\d+)\/deactivate$/;
const API_KEY_ROTATE_PATH_PATTERN = /^\/api\/api-keys\/(\d+)\/rotate$/;
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
  if (matchDynamicAdminEndpoint(path)) {
    return "exempt";
  }
  if (OG_IMAGE_PATH_PATTERN.test(path)) {
    return "exempt";
  }
  if (
    STABLECOIN_DETAIL_PATH_PATTERN.test(path) ||
    STABLECOIN_SUMMARY_PATH_PATTERN.test(path) ||
    STABLECOIN_RESERVES_PATH_PATTERN.test(path)
  ) {
    return "protected";
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
  if (
    STABLECOIN_DETAIL_PATH_PATTERN.test(path) ||
    STABLECOIN_SUMMARY_PATH_PATTERN.test(path) ||
    STABLECOIN_RESERVES_PATH_PATTERN.test(path)
  ) {
    return "allowed";
  }
  if (
    matchDynamicAdminEndpoint(path) ||
    OG_IMAGE_PATH_PATTERN.test(path)
  ) {
    return "denied";
  }
  return null;
}

export function isSiteDataAllowedPath(path: string): boolean {
  return getSiteDataAccess(path) === "allowed";
}

export function matchDynamicAdminEndpoint(path: string): DynamicAdminEndpointMatch | null {
  const discoveryDismissMatch = path.match(DISCOVERY_DISMISS_PATH_PATTERN);
  if (discoveryDismissMatch) {
    const candidateId = Number.parseInt(discoveryDismissMatch[1] ?? "", 10);
    if (!Number.isFinite(candidateId) || candidateId <= 0) {
      return null;
    }
    return {
      key: "discovery-candidate-dismiss",
      path,
      candidateId,
      methods: POST_ONLY_METHODS,
    };
  }

  const apiKeyPatterns: Array<[RegExp, "api-key-update" | "api-key-deactivate" | "api-key-rotate"]> = [
    [API_KEY_UPDATE_PATH_PATTERN, "api-key-update"],
    [API_KEY_DEACTIVATE_PATH_PATTERN, "api-key-deactivate"],
    [API_KEY_ROTATE_PATH_PATTERN, "api-key-rotate"],
  ];
  for (const [pattern, key] of apiKeyPatterns) {
    const match = path.match(pattern);
    if (!match) continue;
    const apiKeyId = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isFinite(apiKeyId) || apiKeyId <= 0) {
      return null;
    }
    return {
      key,
      path,
      apiKeyId,
      methods: POST_ONLY_METHODS,
    };
  }

  return null;
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

  if (STABLECOIN_DETAIL_PATH_PATTERN.test(url.pathname)) {
    return GET_ONLY_METHODS;
  }
  if (STABLECOIN_SUMMARY_PATH_PATTERN.test(url.pathname)) {
    return GET_ONLY_METHODS;
  }
  const dynamicAdminEndpoint = matchDynamicAdminEndpoint(url.pathname);
  if (dynamicAdminEndpoint) {
    return dynamicAdminEndpoint.methods;
  }
  if (OG_IMAGE_PATH_PATTERN.test(url.pathname)) {
    return GET_ONLY_METHODS;
  }

  return null;
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
