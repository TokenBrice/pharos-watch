export interface AdminAccess {
  mode: "ops-proxy";
}

const OPS_UI_HOST = "ops.pharos.watch";

export function isOpsUiHost(
  hostname: string | null = typeof window !== "undefined" ? window.location.hostname : null,
): boolean {
  return hostname === OPS_UI_HOST;
}

export function buildAdminApiPath(path: string, adminAccess: AdminAccess): string {
  if (adminAccess.mode !== "ops-proxy") {
    return path;
  }
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

export function getAdminQueryScope(): "ops-proxy" {
  return "ops-proxy";
}
