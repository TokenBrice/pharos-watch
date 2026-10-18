import { API_PAGE_ANCHORS } from "@shared/lib/public-api-contract";

export type ApiDocument = "access" | "reference";

/** Return the canonical document for a legacy cross-panel fragment, preserving its encoding. */
export function getApiDocumentRedirect(active: ApiDocument, hash: string, hasTarget: (id: string) => boolean): string | null {
  let id: string;
  try {
    id = decodeURIComponent(hash.replace(/^#/, ""));
  } catch {
    return null;
  }
  if (!id || hasTarget(id)) return null;
  if (active === "access") return `/api/reference/${hash}`;
  if (id === "access" || Object.values(API_PAGE_ANCHORS).some((anchor) => anchor === id)) return `/api/${hash}`;
  return null;
}
