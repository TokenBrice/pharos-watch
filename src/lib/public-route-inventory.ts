import { getMechanismExplainerPath } from "@shared/lib/classification";
import { METHODOLOGY_CHANGELOG_SITEMAP_PATHS } from "@shared/lib/methodology-versions/registry";
import { METHODOLOGY_ARCHIVE_PATHS } from "@shared/lib/methodology-versions/archives";
import { PUBLIC_DOCS } from "@shared/lib/public-docs";
import { CLIENT_TRACKED_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/stablecoin-taxonomy";
import { BLOG_POSTS } from "@/data/blog";
import { CASE_STUDY_EVENT_WINDOWS } from "@/lib/case-study-client-index";
import { getIndexableChainIds } from "@/lib/chain-indexing";
import { STATIC_COMPARISON_PAGES } from "@/lib/compare-pages";
import { INDEXABLE_DEPEG_EVENT_ENTRIES } from "@/lib/depeg-event-page-data";
import { INDEXABLE_DIGEST_ENTRIES } from "@/lib/digest-registry";
import { PEG_HUB_PEGS, PEG_HUB_SLUGS } from "@/lib/peg-landing";
import { ALL_STABLECOIN_TAXONOMY_PAGES } from "@/lib/stablecoin-taxonomy";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { CHANGELOG_MONTH_ARCHIVES } from "@/lib/changelog-history";

export type PublicRouteKind =
  | "primary"
  | "reference"
  | "methodology"
  | "stablecoin"
  | "chain"
  | "taxonomy"
  | "mechanism"
  | "case-study"
  | "blog"
  | "comparison"
  | "digest"
  | "depeg-event"
  | "docs";

export interface PublicRouteInventoryEntry {
  href: string;
  kind: PublicRouteKind;
}

/** The website's Access document, not an HTTP API endpoint. */
export const API_ACCESS_PAGE_PATH = "/api/";

export const PUBLIC_PRIMARY_ROUTES = [
  ["/", "hourly", 1.0],
  ["/coverage/", "weekly", 0.6],
  ["/alt-pegs/", "daily", 0.7],
  ["/freezewatch/", "daily", 0.85],
  ["/depeg/", "daily", 0.8],
  ["/cemetery/", "monthly", 0.7],
  ["/compare/", "weekly", 0.7],
  ["/liquidity/", "daily", 0.8],
  ["/upcoming/", "daily", 0.6],
  ["/digest/", "daily", 0.6],
  ["/safety-scores/", "daily", 0.8],
  ["/safety-scores/map/", "daily", 0.6],
  ["/stability-index/", "daily", 0.8],
  ["/dependency-map/", "daily", 0.7],
  ["/yield/", "daily", 0.7],
  ["/screener/", "daily", 0.7],
  ["/funding/", "weekly", 0.5],
  ["/status/", "daily", 0.4],
  ["/flows/", "daily", 0.7],
  ["/compliance/", "weekly", 0.6],
  ["/pharoswatchbot/", "weekly", 0.7],
  ["/methodology/", "monthly", 0.6],
] as const;

export const PUBLIC_REFERENCE_ROUTES = [
  ["/changelog/", "weekly", 0.5],
  ["/blog/", "weekly", 0.6],
  ["/about/", "monthly", 0.5],
  ["/depeg/archive/", "monthly", 0.5],
  [API_ACCESS_PAGE_PATH, "monthly", 0.5],
  ["/api/reference/", "monthly", 0.5],
  ["/stablecoins/", "weekly", 0.7],
  ["/stablecoins/backing/", "weekly", 0.6],
  ["/stablecoins/governance/", "weekly", 0.6],
  ["/stablecoins/infrastructure/", "weekly", 0.6],
  ["/privacy/", "yearly", 0.3],
  ["/docs/", "monthly", 0.6],
] as const;

export const PUBLIC_ROUTE_FAMILY_PATHS = {
  chains: getIndexableChainIds().map((chainId) => `/chains/${chainId}/`),
  pegHubs: PEG_HUB_PEGS.map((peg) => `/stablecoins/${PEG_HUB_SLUGS[peg]}/`),
  taxonomies: ALL_STABLECOIN_TAXONOMY_PAGES.map((page) => page.href),
  mechanisms: MECHANISM_ARCHETYPE_VALUES.map(getMechanismExplainerPath),
  blogPosts: BLOG_POSTS.map((post) => `/blog/${post.slug}/`),
};

function entries(kind: PublicRouteKind, hrefs: readonly string[]): PublicRouteInventoryEntry[] {
  return hrefs.map((href) => ({ href, kind }));
}

const PUBLIC_ROUTE_CANDIDATES: readonly PublicRouteInventoryEntry[] = [
  ...entries("primary", PUBLIC_PRIMARY_ROUTES.map(([href]) => href)),
  ...entries("reference", PUBLIC_REFERENCE_ROUTES.map(([href]) => href)),
  ...entries("methodology", METHODOLOGY_CHANGELOG_SITEMAP_PATHS),
  ...entries("methodology", METHODOLOGY_ARCHIVE_PATHS),
  ...entries("reference", CHANGELOG_MONTH_ARCHIVES.map((archive) => archive.path)),
  ...entries("stablecoin", CLIENT_TRACKED_STABLECOINS.map((coin) => buildStablecoinUrl(coin.id))),
  ...entries("chain", PUBLIC_ROUTE_FAMILY_PATHS.chains),
  ...entries("chain", ["/chains/"]),
  ...entries("taxonomy", PUBLIC_ROUTE_FAMILY_PATHS.pegHubs),
  ...entries("taxonomy", PUBLIC_ROUTE_FAMILY_PATHS.taxonomies),
  ...entries("mechanism", [
    "/learn/mechanisms/",
    ...PUBLIC_ROUTE_FAMILY_PATHS.mechanisms,
  ]),
  ...entries("case-study", [
    "/learn/case-studies/",
    ...CASE_STUDY_EVENT_WINDOWS.map((study) => `/learn/case-studies/${study.slug}/`),
  ]),
  ...entries("blog", PUBLIC_ROUTE_FAMILY_PATHS.blogPosts),
  ...entries("comparison", STATIC_COMPARISON_PAGES.map((page) => page.href)),
  ...entries("digest", INDEXABLE_DIGEST_ENTRIES.map((digest) => `/digest/${digest.date}/`)),
  ...entries("depeg-event", INDEXABLE_DEPEG_EVENT_ENTRIES.map((event) => `/depeg/${event.slug}/`)),
  ...entries("docs", PUBLIC_DOCS.map((doc) => `/docs/${doc.slug}/`)),
];

const PUBLIC_ROUTE_INVENTORY: readonly PublicRouteInventoryEntry[] = Array.from(
  new Map(PUBLIC_ROUTE_CANDIDATES.map((route) => [route.href, route])).values(),
);

export const PUBLIC_ROUTE_PATHS: readonly string[] = PUBLIC_ROUTE_INVENTORY.map((route) => route.href);
