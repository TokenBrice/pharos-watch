import { getActiveChainIds } from "@shared/lib/chains";
import { getMechanismExplainerPath } from "@shared/lib/classification";
import { METHODOLOGY_CHANGELOG_SITEMAP_PATHS } from "@shared/lib/methodology-versions/registry";
import { PUBLIC_DOCS } from "@shared/lib/public-docs";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import { BLOG_POSTS } from "@/data/blog";
import { CASE_STUDY_EVENT_WINDOWS } from "@/lib/case-study-client-index";
import { STATIC_COMPARISON_PAGES } from "@/lib/compare-pages";
import { DEPEG_EVENT_ENTRIES } from "@/lib/depeg-event-page-data";
import { DIGEST_ENTRIES } from "@/lib/digest-registry";
import { ACTIVE_PEGS, PEG_SLUGS } from "@/lib/peg-landing";
import { ALL_STABLECOIN_TAXONOMY_PAGES } from "@/lib/stablecoin-taxonomy";
import { buildStablecoinUrl } from "@shared/lib/urls";

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
  "/", "/coverage/", "/alt-pegs/", "/start/", "/freezewatch/", "/depeg/", "/cemetery/",
  "/compare/", "/liquidity/", "/upcoming/", "/digest/", "/safety-scores/", "/safety-scores/map/",
  "/stability-index/",
  "/dependency-map/", "/yield/", "/screener/", "/funding/", "/status/", "/flows/", "/timeline/",
  "/compliance/", "/pharoswatchbot/", "/methodology/",
] as const;

export const PUBLIC_REFERENCE_ROUTE_PATHS = [
  "/changelog/", "/blog/", "/about/", "/about/api/", "/about/bluechip/", "/depeg/archive/", "/learn/",
  "/learn/glossary/", "/sitemap-tree/", "/api/", "/stablecoins/", "/stablecoins/backing/",
  "/stablecoins/governance/", "/stablecoins/infrastructure/", "/privacy/", "/docs/",
] as const;

function entries(kind: PublicRouteKind, hrefs: readonly string[]): PublicRouteInventoryEntry[] {
  return hrefs.map((href) => ({ href, kind }));
}

const PUBLIC_ROUTE_CANDIDATES: readonly PublicRouteInventoryEntry[] = [
  ...entries("primary", PUBLIC_PRIMARY_ROUTE_PATHS),
  ...entries("reference", PUBLIC_REFERENCE_ROUTE_PATHS),
  ...entries("methodology", METHODOLOGY_CHANGELOG_SITEMAP_PATHS),
  ...entries("stablecoin", TRACKED_STABLECOINS.map((coin) => buildStablecoinUrl(coin.id))),
  ...entries("chain", getActiveChainIds().map((chainId) => `/chains/${chainId}/`)),
  ...entries("chain", ["/chains/"]),
  ...entries("taxonomy", ACTIVE_PEGS.map((peg) => `/stablecoins/${PEG_SLUGS[peg]}/`)),
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
  ...entries("digest", DIGEST_ENTRIES.map((digest) => `/digest/${digest.date}/`)),
  ...entries("depeg-event", DEPEG_EVENT_ENTRIES.map((event) => `/depeg/${event.slug}/`)),
  ...entries("docs", PUBLIC_DOCS.map((doc) => `/docs/${doc.slug}/`)),
];

export const PUBLIC_ROUTE_INVENTORY: readonly PublicRouteInventoryEntry[] = Array.from(
  new Map(PUBLIC_ROUTE_CANDIDATES.map((route) => [route.href, route])).values(),
);

export const PUBLIC_ROUTE_PATHS: readonly string[] = PUBLIC_ROUTE_INVENTORY.map((route) => route.href);
