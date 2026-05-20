import sitemapDates from "@/generated/sitemap-dates.json";

const ISO_DATE_REGEX = /^(\d{4}-\d{2}-\d{2})/;
const DYNAMIC_ROUTE_FALLBACKS: Array<{ prefix: string; fallbackPath: string }> = [
  { prefix: "/stablecoin/", fallbackPath: "/stablecoins/" },
  { prefix: "/depeg/", fallbackPath: "/depeg/" },
];

function normalizePath(path: string): string {
  if (!path.startsWith("/")) return path;
  return path.endsWith("/") ? path : `${path}/`;
}

function dateOnly(stamp: string | undefined): string | null {
  const match = stamp?.match(ISO_DATE_REGEX);
  return match ? match[1] : null;
}

function urlToCitationPath(url: string): string {
  try {
    const parsed = new URL(url);
    return normalizePath(parsed.pathname);
  } catch {
    return normalizePath(url);
  }
}

export function getCitationAccessedDateForPath(
  path: string,
  fallbackPaths: readonly string[] = [],
): string {
  const normalized = normalizePath(path);
  const dates = sitemapDates as Record<string, string>;
  const direct = dateOnly(dates[normalized]);
  if (direct) return direct;

  for (const fallbackPath of fallbackPaths) {
    const fallback = dateOnly(dates[normalizePath(fallbackPath)]);
    if (fallback) return fallback;
  }

  for (const dynamicFallback of DYNAMIC_ROUTE_FALLBACKS) {
    if (normalized.startsWith(dynamicFallback.prefix)) {
      const fallback = dateOnly(dates[dynamicFallback.fallbackPath]);
      if (fallback) return fallback;
    }
  }

  const latest = Object.values(dates)
    .map((stamp) => dateOnly(stamp))
    .filter((stamp): stamp is string => stamp !== null)
    .sort()
    .at(-1);
  if (latest) return latest;

  throw new Error("No deterministic citation accessed date found in sitemap-dates.json");
}

export function getCitationAccessedDateForUrl(
  url: string,
  fallbackPaths: readonly string[] = [],
): string {
  return getCitationAccessedDateForPath(urlToCitationPath(url), fallbackPaths);
}
