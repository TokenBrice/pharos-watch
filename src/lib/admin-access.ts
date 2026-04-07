import { OPS_UI_HOSTNAME } from "@shared/lib/runtime-origins";

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
