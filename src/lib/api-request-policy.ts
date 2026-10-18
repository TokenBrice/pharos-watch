import { PHAROS_WEB_ACCEPT_MARKER } from "@shared/lib/request-source-marker";

export const PUBLIC_API_ACCEPT = `application/json, ${PHAROS_WEB_ACCEPT_MARKER}`;

export function withPublicApiAcceptMarker(path: string, init?: RequestInit): RequestInit | undefined {
  if (typeof window === "undefined") return init;
  if (!path.startsWith("/api/") || path.startsWith("/api/admin/")) return init;

  const headers = new Headers(init?.headers);
  const accept = headers.get("Accept");
  if (!accept) {
    headers.set("Accept", PUBLIC_API_ACCEPT);
  } else if (!accept.toLowerCase().includes(PHAROS_WEB_ACCEPT_MARKER)) {
    headers.set("Accept", `${accept}, ${PHAROS_WEB_ACCEPT_MARKER}`);
  }
  return { ...init, headers };
}
