export type AdminAccess =
  | {
      mode: "legacy-key";
      adminKey: string;
      adminSessionRevision: number;
    }
  | {
      mode: "ops-proxy";
    };

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
  adminAccess: AdminAccess,
  init?: RequestInit,
): RequestInit {
  const headers = new Headers(init?.headers);
  if (adminAccess.mode === "legacy-key") {
    headers.set("X-Admin-Key", adminAccess.adminKey);
  }

  return {
    ...init,
    headers,
  };
}

export function getAdminQueryScope(adminAccess: AdminAccess): number | "ops-proxy" {
  return adminAccess.mode === "ops-proxy"
    ? "ops-proxy"
    : adminAccess.adminSessionRevision;
}

export function isAdminAccessEnabled(adminAccess: AdminAccess): boolean {
  return adminAccess.mode === "ops-proxy" || adminAccess.adminKey.length > 0;
}
