import { isSiteDataAllowedPath as isEndpointSiteDataAllowedPath } from "./api-endpoints";
import {
  OPS_UI_ORIGIN,
  SITE_ORIGIN,
  isPagesAppHostname,
  resolveOrigin,
} from "./runtime-origins";

export const SITE_DATA_PATH_PREFIX = "/_site-data";
export const SITE_DATA_ALLOWED_METHOD = "GET";
export const SITE_DATA_ALLOWED_METHODS = [SITE_DATA_ALLOWED_METHOD] as const;
export const SITE_DATA_PROXY_SECRET_HEADER = "X-Pharos-Site-Proxy-Secret";

export interface SiteDataUiOriginEnv {
  SITE_ORIGIN?: string;
  OPS_UI_ORIGIN?: string;
}

function splitPathSuffix(path: string): { pathname: string; suffix: string } {
  const suffixIndex = path.search(/[?#]/);
  if (suffixIndex === -1) {
    return { pathname: path, suffix: "" };
  }

  return {
    pathname: path.slice(0, suffixIndex),
    suffix: path.slice(suffixIndex),
  };
}

export function isSiteDataAllowedMethod(method: string | null | undefined): boolean {
  return (method ?? SITE_DATA_ALLOWED_METHOD).trim().toUpperCase() === SITE_DATA_ALLOWED_METHOD;
}

export function isSiteDataAllowedApiPath(apiPath: string): boolean {
  const { pathname } = splitPathSuffix(apiPath);
  return isEndpointSiteDataAllowedPath(pathname);
}

export function toSiteDataPath(apiPath: string): string {
  const { pathname, suffix } = splitPathSuffix(apiPath);
  if (!pathname.startsWith("/api/")) {
    throw new Error(`Site-data mapping requires an /api/* path: ${apiPath}`);
  }
  return `${SITE_DATA_PATH_PREFIX}${pathname.slice("/api".length)}${suffix}`;
}

export function resolveSiteDataProxyPath(
  apiPath: string,
  method: string | null | undefined = SITE_DATA_ALLOWED_METHOD,
): string | null {
  if (!isSiteDataAllowedMethod(method) || !isSiteDataAllowedApiPath(apiPath)) {
    return null;
  }

  return toSiteDataPath(apiPath);
}

export function resolveSiteDataUpstreamPath(
  pathname: string,
  method: string | null | undefined = SITE_DATA_ALLOWED_METHOD,
): string | null {
  if (!isSiteDataAllowedMethod(method)) {
    return null;
  }

  const { pathname: siteDataPathname, suffix } = splitPathSuffix(pathname);
  if (!siteDataPathname.startsWith(SITE_DATA_PATH_PREFIX)) {
    return null;
  }

  const remainder = siteDataPathname.slice(SITE_DATA_PATH_PREFIX.length);
  if (!remainder.startsWith("/")) {
    return null;
  }

  const upstreamPath = `/api${remainder}`;
  return isSiteDataAllowedApiPath(upstreamPath) ? `${upstreamPath}${suffix}` : null;
}

export function isSiteDataPath(
  pathname: string,
  method: string | null | undefined = SITE_DATA_ALLOWED_METHOD,
): boolean {
  return resolveSiteDataUpstreamPath(pathname, method) != null;
}

export function resolveSiteDataAllowedUiHostnames(env: SiteDataUiOriginEnv = {}): Set<string> {
  return new Set([
    new URL(resolveOrigin(env.SITE_ORIGIN, SITE_ORIGIN)).hostname,
    new URL(resolveOrigin(env.OPS_UI_ORIGIN, OPS_UI_ORIGIN)).hostname,
  ]);
}

export function isSiteDataAllowedUiHostname(
  hostname: string,
  env: SiteDataUiOriginEnv = {},
): boolean {
  return resolveSiteDataAllowedUiHostnames(env).has(hostname) || isPagesAppHostname(hostname);
}

export function hostnameOfSiteDataCallerHeader(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "null") return null;
  try {
    return new URL(trimmed).hostname;
  } catch {
    return null;
  }
}
