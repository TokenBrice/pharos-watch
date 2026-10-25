/**
 * Public site identity: the one authority for the site name in JSON-LD and
 * `og:site_name`, and for the Open Graph / X card attribution every page emits.
 * `buildPageMetadata()` replaces the root layout's `openGraph`/`twitter`
 * objects, so both read these values instead of repeating literals.
 *
 * The `| Pharos` title suffix and the visible wordmark intentionally stay
 * "Pharos"; the structured site name disambiguates from other "Pharos" crypto
 * entities (plan decision D2, minimal variant).
 */
export const SITE_NAME = "Pharos Watch";
export const SITE_ALTERNATE_NAMES = ["Pharos", "pharos.watch"] as const;

export const SITE_OPEN_GRAPH_IDENTITY = {
  siteName: SITE_NAME,
  locale: "en_US",
} as const;

export const SITE_TWITTER_IDENTITY = {
  site: "@PharosWatch",
  creator: "@TokenBrice",
} as const;
