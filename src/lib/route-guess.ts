import { NAV_ITEMS } from "@/lib/nav-config";

export interface RouteSuggestion {
  href: string;
  label: string;
  distance: number;
}

/** Curated registry of recoverable top-level routes. */
const KNOWN_ROUTES: { href: string; label: string }[] = [
  { href: "/", label: "Dashboard" },
  { href: "/stablecoins/usd/", label: "Stablecoins · USD" },
  { href: "/stablecoins/eur/", label: "Stablecoins · EUR" },
  { href: "/digest/", label: "Daily Digest" },
  { href: "/depeg/", label: "Depeg" },
  { href: "/timeline/", label: "Timeline" },
  { href: "/changelog/", label: "Changelog" },
  { href: "/screener/", label: "Screener" },
  { href: "/compare/", label: "Compare" },
  { href: "/methodology/", label: "Methodology" },
  { href: "/cemetery/", label: "Cemetery" },
  { href: "/about/", label: "About" },
  { href: "/api/", label: "API Access" },
  ...NAV_ITEMS
    .filter((item) => !item.external)
    .map((item) => ({ href: item.href, label: item.label })),
];

/** Canonical aliases — common legacy paths the user might still type. */
const ALIASES: { match: RegExp; href: string; label: string }[] = [
  { match: /^\/peg[-_]?tracker\/?$/i, href: "/depeg/", label: "Depeg" },
  { match: /^\/tape\/?$/i, href: "/timeline/", label: "Timeline" },
  { match: /^\/news\/?$/i, href: "/digest/", label: "Daily Digest" },
  { match: /^\/dashboard\/?$/i, href: "/", label: "Dashboard" },
];

function normalize(path: string): string {
  return path
    .toLowerCase()
    .replace(/^\/+|\/+$/g, "")
    .replace(/[_]/g, "-");
}

/** Classic iterative Levenshtein distance. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const prev = new Array(b.length + 1);
  const next = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    next[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      next[j] = Math.min(
        next[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = next[j];
  }
  return prev[b.length];
}

/**
 * Suggest canonical routes the user may have meant.
 *
 * - Exact alias matches short-circuit with distance 0.
 * - Otherwise, Levenshtein distance on normalized paths,
 *   filtered to within max(2, ceil(len/4)) edits.
 */
export function guessRoute(failedPath: string, limit = 3): RouteSuggestion[] {
  if (!failedPath || failedPath === "/") return [];

  for (const alias of ALIASES) {
    if (alias.match.test(failedPath)) {
      return [{ href: alias.href, label: alias.label, distance: 0 }];
    }
  }

  const needle = normalize(failedPath);
  if (!needle) return [];

  const tolerance = Math.max(2, Math.ceil(needle.length / 4));

  // Dedupe by href, keep the best distance per route.
  const best = new Map<string, RouteSuggestion>();
  for (const route of KNOWN_ROUTES) {
    const candidate = normalize(route.href);
    if (!candidate) continue;
    const distance = levenshtein(needle, candidate);
    if (distance > tolerance) continue;
    const existing = best.get(route.href);
    if (!existing || distance < existing.distance) {
      best.set(route.href, { href: route.href, label: route.label, distance });
    }
  }

  return Array.from(best.values())
    .sort((a, b) => a.distance - b.distance || a.href.localeCompare(b.href))
    .slice(0, limit);
}
