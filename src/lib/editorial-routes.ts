// Text-first routes keep the same chrome, but defer optional live tape work and
// do not mount analytics-only shortcut/toast/route-progress plumbing.
const EDITORIAL_ROUTE_ROOTS = [
  "/privacy",
  "/about",
  "/docs",
  "/blog",
  "/methodology",
  "/learn",
  "/changelog",
  "/legal",
] as const;

export function isEditorialPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return EDITORIAL_ROUTE_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}
