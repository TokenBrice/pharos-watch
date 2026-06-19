import { API_PATHS, getPublicApiAccess, isAdminLikePath, isCacheBypassPath } from "@shared/lib/api-endpoints";
import { OPS_API_HOSTNAME, SITE_API_HOSTNAME } from "@shared/lib/runtime-origins";

export function isCacheableGetRequest(request: Request, url: URL): boolean {
  return request.method === "GET" && !isCacheBypassPath(url.pathname);
}

export function isProtectedPublicApiCacheableGetRequest(request: Request, url: URL): boolean {
  return isCacheableGetRequest(request, url)
    && url.pathname.startsWith("/api/")
    && url.pathname !== API_PATHS.telegramWebhook()
    && url.hostname !== OPS_API_HOSTNAME
    && url.hostname !== SITE_API_HOSTNAME
    && getPublicApiAccess(url.pathname) !== "exempt"
    && !isAdminLikePath(url.pathname);
}
