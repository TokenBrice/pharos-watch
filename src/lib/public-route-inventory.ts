import { getMechanismExplainerPath } from "@shared/lib/classification";
import { METHODOLOGY_CHANGELOG_SITEMAP_PATHS } from "@shared/lib/methodology-versions/registry";
import { METHODOLOGY_ARCHIVE_PATHS } from "@shared/lib/methodology-versions/archives";
import { PUBLIC_DOCS } from "@shared/lib/public-docs";
import { CLIENT_TRACKED_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
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

export const PUBLIC_PRIMARY_ROUTE_PATHS = [
  "/", "/coverage/", "/alt-pegs/", "/freezewatch/", "/depeg/", "/cemetery/",
  "/compare/", "/liquidity/", "/upcoming/", "/digest/", "/safety-scores/", "/safety-scores/map/",
  "/stability-index/",
  "/dependency-map/", "/yield/", "/screener/", "/funding/", "/status/", "/flows/",
  "/compliance/", "/pharoswatchbot/", "/methodology/",
] as const;

/** The website's Access document, not an HTTP API endpoint. */
export const API_ACCESS_PAGE_PATH = "/api/";

export const PUBLIC_REFERENCE_ROUTE_PATHS = [
  "/changelog/", "/blog/", "/about/", "/depeg/archive/",
  API_ACCESS_PAGE_PATH, "/api/reference/", "/stablecoins/", "/stablecoins/backing/",
  "/stablecoins/governance/", "/stablecoins/infrastructure/", "/privacy/", "/docs/",
] as const;

function entries(kind: PublicRouteKind, hrefs: readonly string[]): PublicRouteInventoryEntry[] {
  return hrefs.map((href) => ({ href, kind }));
}

const PUBLIC_ROUTE_CANDIDATES: readonly PublicRouteInventoryEntry[] = [
  ...entries("primary", PUBLIC_PRIMARY_ROUTE_PATHS),
  ...entries("reference", PUBLIC_REFERENCE_ROUTE_PATHS),
  ...entries("methodology", METHODOLOGY_CHANGELOG_SITEMAP_PATHS),
  ...entries("methodology", METHODOLOGY_ARCHIVE_PATHS),
  ...entries("reference", CHANGELOG_MONTH_ARCHIVES.map((archive) => archive.path)),
  ...entries("stablecoin", CLIENT_TRACKED_STABLECOINS.map((coin) => buildStablecoinUrl(coin.id))),
  ...entries("chain", getIndexableChainIds().map((chainId) => `/chains/${chainId}/`)),
  ...entries("chain", ["/chains/"]),
  ...entries("taxonomy", PEG_HUB_PEGS.map((peg) => `/stablecoins/${PEG_HUB_SLUGS[peg]}/`)),
  ...entries("taxonomy", ALL_STABLECOIN_TAXONOMY_PAGES.map((page) => page.href)),
  ...entries("mechanism", [
    "/learn/mechanisms/",
    ...MECHANISM_ARCHETYPE_VALUES.map(getMechanismExplainerPath),
  ]),
  ...entries("case-study", [
    "/learn/case-studies/",
    ...CASE_STUDY_EVENT_WINDOWS.map((study) => `/learn/case-studies/${study.slug}/`),
  ]),
  ...entries("blog", BLOG_POSTS.map((post) => `/blog/${post.slug}/`)),
  ...entries("comparison", STATIC_COMPARISON_PAGES.map((page) => page.href)),
  ...entries("digest", INDEXABLE_DIGEST_ENTRIES.map((digest) => `/digest/${digest.date}/`)),
  ...entries("depeg-event", INDEXABLE_DEPEG_EVENT_ENTRIES.map((event) => `/depeg/${event.slug}/`)),
  ...entries("docs", PUBLIC_DOCS.map((doc) => `/docs/${doc.slug}/`)),
];

const PUBLIC_ROUTE_INVENTORY: readonly PublicRouteInventoryEntry[] = Array.from(
  new Map(PUBLIC_ROUTE_CANDIDATES.map((route) => [route.href, route])).values(),
);

export const PUBLIC_ROUTE_PATHS: readonly string[] = PUBLIC_ROUTE_INVENTORY.map((route) => route.href);
