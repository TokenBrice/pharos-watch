/**
 * Route label registry for the sitewide chrome breadcrumb (W6-A / I1).
 *
 * Used to auto-generate breadcrumb crumbs from `pathname` segments. Static
 * routes resolve via navigation metadata plus the `ROUTE_LABEL_OVERRIDES`
 * map; dynamic segments are resolved
 * by per-prefix functions in `DYNAMIC_SEGMENT_RESOLVERS`.
 */
import { NAV_ITEMS } from "@/lib/nav-config";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";

/**
 * Canonical labels for every public top-level route visible in navigation.
 * Keys are slash-prefixed, trailing-slash-stripped.
 */
const NAV_ROUTE_LABELS: Record<string, string> = Object.fromEntries(
  NAV_ITEMS
    .filter((item) => !item.external && item.href.startsWith("/"))
    .map((item) => [normalizeRoutePath(item.href), item.label]),
);

/**
 * Hidden/static subroutes and legacy aliases that are not part of NAV_ITEMS.
 */
const ROUTE_LABEL_OVERRIDES: Record<string, string> = {
  "/about/style": "Style Guide",
  "/about/principles": "Principles",
  "/about/bluechip": "Bluechip",
  "/about/editorial": "Editorial",
  "/about/api": "API",
  "/learn": "Learn",
  "/learn/glossary": "Glossary",
  "/stablecoin": "Stablecoin",
  "/stablecoins": "Stablecoins",
  "/blacklist": "Blacklist",
  "/privacy": "Privacy",
};

export const ROUTE_LABELS: Record<string, string> = {
  ...NAV_ROUTE_LABELS,
  ...ROUTE_LABEL_OVERRIDES,
};

/**
 * Normalize a path for lookup: keep leading slash, drop trailing slash,
 * lowercase. Returns "/" unchanged.
 */
export function normalizeRoutePath(path: string): string {
  if (!path || path === "/") return "/";
  const lower = path.toLowerCase();
  if (lower.length > 1 && lower.endsWith("/")) {
    return lower.slice(0, -1);
  }
  return lower;
}

/** Title-case a kebab/snake/space slug for fallback labels. */
function titleCaseSlug(slug: string): string {
  if (!slug) return slug;
  return slug
    .replace(/[-_]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((word) => (word.length === 0 ? word : word[0].toUpperCase() + word.slice(1)))
    .join(" ");
}

/**
 * Per-prefix resolvers for dynamic segments. Each function receives the
 * raw segment and returns a human label. When `null` is returned the
 * caller should fall back to title-casing the slug.
 */
const DYNAMIC_SEGMENT_RESOLVERS: Record<string, (segment: string) => string | null> = {
  "/stablecoin": (segment) => {
    const meta = CLIENT_TRACKED_META_BY_ID.get(segment);
    return meta?.symbol ?? meta?.name ?? null;
  },
};

/**
 * Returns the label for a fully-qualified path. Returns `null` when the
 * path is not registered and no dynamic resolver matches; callers should
 * fall back to title-casing the final segment when appropriate.
 */
export function routeLabelFor(path: string): string | null {
  const normalized = normalizeRoutePath(path);
  if (normalized === "/") return ROUTE_LABELS["/"] ?? null;
  if (ROUTE_LABELS[normalized]) return ROUTE_LABELS[normalized];

  // Try one level up + dynamic resolver. e.g. "/stablecoin/usdc-circle"
  // → resolver for "/stablecoin" with segment "usdc-circle".
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) return null;
  const parent = normalized.slice(0, lastSlash);
  const segment = normalized.slice(lastSlash + 1);
  const resolver = DYNAMIC_SEGMENT_RESOLVERS[parent];
  if (resolver) {
    const resolved = resolver(segment);
    if (resolved) return resolved;
  }
  // Fallback for unknown dynamic segments inside a known parent: title-case.
  if (ROUTE_LABELS[parent]) {
    return titleCaseSlug(segment);
  }
  return null;
}

export interface RouteBreadcrumbItem {
  /** Display label. */
  label: string;
  /** Absolute path. Last item is the current page and renders without href. */
  href: string;
}

/**
 * Build an ordered list of breadcrumb items from `pathname`. Always starts
 * with `Dashboard → /`. Trailing item is the current page (no link).
 * Returns an empty array for the homepage.
 */
export function buildRouteBreadcrumb(pathname: string): RouteBreadcrumbItem[] {
  const normalized = normalizeRoutePath(pathname);
  if (normalized === "/" || normalized === "") return [];

  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return [];

  const items: RouteBreadcrumbItem[] = [{ label: "Dashboard", href: "/" }];
  let cursor = "";
  for (let i = 0; i < segments.length; i += 1) {
    cursor += `/${segments[i]}`;
    const label = routeLabelFor(cursor) ?? titleCaseSlug(segments[i]);
    items.push({ label, href: `${cursor}/` });
  }
  return items;
}
