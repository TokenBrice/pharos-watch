import { isSiteDataAllowedPath } from "./api-endpoints";

export const SITE_DATA_PATH_PREFIX = "/_site-data";

export function toSiteDataPath(apiPath: string): string {
  if (!apiPath.startsWith("/api/")) {
    throw new Error(`Site-data mapping requires an /api/* path: ${apiPath}`);
  }
  return `${SITE_DATA_PATH_PREFIX}${apiPath.slice("/api".length)}`;
}

export function resolveSiteDataUpstreamPath(pathname: string): string | null {
  if (!pathname.startsWith(SITE_DATA_PATH_PREFIX)) {
    return null;
  }

  const remainder = pathname.slice(SITE_DATA_PATH_PREFIX.length);
  if (!remainder.startsWith("/")) {
    return null;
  }

  const upstreamPath = `/api${remainder}`;
  return isSiteDataAllowedPath(upstreamPath) ? upstreamPath : null;
}

export function isSiteDataPath(pathname: string): boolean {
  return resolveSiteDataUpstreamPath(pathname) != null;
}
