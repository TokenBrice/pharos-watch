import type { MethodologyChangelogRegistryKey } from "../../shared/lib/methodology-versions/registry";
import { METHODOLOGY_LANES, type PublicMethodologyLane } from "../../shared/lib/methodology-versions/metadata.mts";

const SOURCE_ROOTS = {
  app: { path: "src/app", recursive: true },
  caseStudies: { path: "src/lib/case-studies", recursive: true },
  chainIndexing: { path: "src/lib/chain-indexing.ts", recursive: false },
  pegContent: { path: "src/lib/peg-hub-content.ts", recursive: false },
  pegLanding: { path: "src/lib/peg-landing.ts", recursive: false },
  pegTaxonomy: { path: "src/lib/peg-taxonomy.ts", recursive: false },
  taxonomyUrls: { path: "src/lib/stablecoin-taxonomy-urls.ts", recursive: false },
  taxonomy: { path: "src/lib/stablecoin-taxonomy.ts", recursive: false },
  blog: { path: "src/data/blog", recursive: true },
  editorialSchema: { path: "shared/types/editorial-content.ts", recursive: false },
  coins: { path: "shared/data/stablecoins/coins", recursive: true },
  domains: { path: "shared/data/stablecoins/domains", recursive: true },
  methodology: { path: "shared/data/methodology-changelogs", recursive: true },
} as const;

export const CASE_STUDY_DETAIL_SHARED_SOURCES = [
  `${SOURCE_ROOTS.app.path}/learn/case-studies/[slug]/page.tsx`,
  `${SOURCE_ROOTS.app.path}/learn/case-studies/case-study-body.tsx`,
  `${SOURCE_ROOTS.app.path}/learn/case-studies/case-study-chart.tsx`,
  `${SOURCE_ROOTS.app.path}/learn/case-studies/case-study-json-ld.tsx`,
  `${SOURCE_ROOTS.app.path}/learn/case-studies/case-study-page-shell.tsx`,
  `${SOURCE_ROOTS.app.path}/learn/case-studies/case-study-timeline.tsx`,
  SOURCE_ROOTS.editorialSchema.path,
];
export const BLOG_DETAIL_SHARED_SOURCES = [
  // Per-post dates must not move with the post registry or a site-wide
  // metadata module: only the renderer every article body shares.
  `${SOURCE_ROOTS.app.path}/blog/[slug]/page.tsx`,
];
export const METHODOLOGY_CHANGELOG_SHARED_SOURCES = [
  // This route owns the shared display config as well as dynamic route metadata.
  `${SOURCE_ROOTS.app.path}/methodology/[slug]/page.tsx`,
];
export const METHODOLOGY_CHANGELOG_ENTRY_SOURCES = Object.fromEntries(
  METHODOLOGY_LANES
    .filter((lane): lane is PublicMethodologyLane => lane.sitemapOrder !== null)
    .sort((a, b) => a.sitemapOrder - b.sitemapOrder)
    .map((lane) => [lane.key, lane.changelogDirectory]),
) as Record<MethodologyChangelogRegistryKey, string>;
export const SCORING_CHANGELOG_CONTENT_SOURCES = [
  `${SOURCE_ROOTS.app.path}/methodology/changelog-content/scoring`,
];
export const CHAIN_PROFILE_SOURCES = [
  `${SOURCE_ROOTS.app.path}/chains/[chain]`,
  `${SOURCE_ROOTS.app.path}/chains/static-chain-content.ts`,
];
export const PEG_HUB_SOURCES = [
  `${SOURCE_ROOTS.app.path}/stablecoins/[peg]`,
  SOURCE_ROOTS.pegContent.path,
  SOURCE_ROOTS.pegLanding.path,
  SOURCE_ROOTS.pegTaxonomy.path,
];
export const TAXONOMY_SOURCES = [
  `${SOURCE_ROOTS.app.path}/stablecoins/taxonomy-page.tsx`,
  SOURCE_ROOTS.taxonomyUrls.path,
  SOURCE_ROOTS.taxonomy.path,
];

export const GIT_DATE_SCAN_PATHS = Object.values(SOURCE_ROOTS).map((source) => source.path);

export const SITEMAP_COMMIT_DERIVED_SOURCE_PATHS: string[] = [
  ...Object.values(SOURCE_ROOTS).map((source) => source.recursive ? `${source.path}/**` : source.path),
  // Profile-wide revisions are explicit, rather than commit-derived.
  "scripts/lib/sitemap-detail-dates.ts",
];
