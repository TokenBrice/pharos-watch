import { OPS_UI_HOSTNAME } from "@shared/lib/runtime-origins";

const ADMIN_QUERY_SCOPE = "ops-proxy";
export type AdminAccess = typeof ADMIN_QUERY_SCOPE;

export function isOpsUiHost(
  hostname: string | null = typeof window !== "undefined" ? window.location.hostname : null,
): boolean {
  return hostname === OPS_UI_HOSTNAME;
}

export function buildAdminApiPath(path: string): string {
  if (!path.startsWith("/api/")) {
    throw new Error(`Admin API path must start with /api/: ${path}`);
  }
  return `/api/admin${path.slice("/api".length)}`;
}

export function buildAdminFetchInit(
  init?: RequestInit,
): RequestInit {
  const headers = new Headers(init?.headers);
  return {
    ...init,
    headers,
  };
}

export function getAdminQueryScope(): AdminAccess {
  return ADMIN_QUERY_SCOPE;
}
