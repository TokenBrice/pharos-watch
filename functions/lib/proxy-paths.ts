import { resolveWildcardProxyPath } from "./upstream-proxy";

export const OPS_ADMIN_PROXY_PREFIX = "/api/";
export const SITE_DATA_PROXY_PREFIX = "/_site-data/";

interface WildcardProxyParams {
  path?: string | string[];
}

export function resolveOpsAdminUpstreamPath(params: WildcardProxyParams): string | null {
  return resolveWildcardProxyPath(params.path, OPS_ADMIN_PROXY_PREFIX);
}

export function resolveSiteDataRequestedPath(params: WildcardProxyParams): string | null {
  return resolveWildcardProxyPath(params.path, SITE_DATA_PROXY_PREFIX);
}
