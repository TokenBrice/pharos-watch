import { isSiteDataAllowedUiHostname, resolveSiteDataProxyPath } from "@shared/lib/site-data-lane";
import { resolvePublicApiBase } from "@shared/lib/runtime-origins";

export function resolveApiBase(
  hostname?: string | null,
  envBase: string | undefined = process.env.NEXT_PUBLIC_API_BASE,
): string {
  return resolvePublicApiBase(hostname, envBase);
}

function getBrowserHostname(): string | null {
  return typeof window !== "undefined" ? window.location.hostname : null;
}

export const API_BASE = resolveApiBase(getBrowserHostname());

export function buildApiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

function resolveSiteDataRequestPath(
  path: string,
  method: string | null | undefined,
  hostname?: string | null,
  envBase: string | undefined = process.env.NEXT_PUBLIC_API_BASE,
  forceSiteDataProxy: string | undefined = process.env.NEXT_PUBLIC_FORCE_SITE_DATA_PROXY,
): string | null {
  if ((envBase ?? "").trim()) {
    return null;
  }
  const forceProxy = (forceSiteDataProxy ?? "").trim().toLowerCase() === "true";
  if (!forceProxy && (!hostname || !isSiteDataAllowedUiHostname(hostname))) {
    return null;
  }
  return resolveSiteDataProxyPath(path, method);
}

function resolveRequestMethod(init?: Pick<RequestInit, "method"> | string | null): string | undefined {
  return typeof init === "string" ? init : init?.method;
}

export function buildRequestUrl(path: string, init?: Pick<RequestInit, "method"> | string | null): string {
  if (path.startsWith("/api/admin/")) {
    return path;
  }
  const siteDataPath = resolveSiteDataRequestPath(path, resolveRequestMethod(init), getBrowserHostname());
  if (siteDataPath) {
    return siteDataPath;
  }
  return buildApiUrl(path);
}
