import { getRouteCapabilities } from "@/lib/route-capabilities";

// Text-first routes keep the same chrome, but defer optional live tape work and
// do not mount analytics-only shortcut/toast/route-progress plumbing.
export function isEditorialPath(pathname: string | null): boolean {
  return getRouteCapabilities(pathname).editorial;
}
