import { resolveWildcardProxyPath } from "./upstream-proxy";
import { SITE_DATA_PATH_PREFIX } from "@shared/lib/site-data-lane";

export const OPS_ADMIN_PROXY_PREFIX = "/api/";
export const SITE_DATA_PROXY_PREFIX = `${SITE_DATA_PATH_PREFIX}/`;

interface WildcardProxyParams {
  path?: string | string[];
}

export function resolveOpsAdminUpstreamPath(params: WildcardProxyParams): string | null {
  return resolveWildcardProxyPath(params.path, OPS_ADMIN_PROXY_PREFIX);
}

export function resolveSiteDataRequestedPath(params: WildcardProxyParams): string | null {
  return resolveWildcardProxyPath(params.path, SITE_DATA_PROXY_PREFIX);
}
