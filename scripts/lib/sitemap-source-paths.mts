/**
 * Source paths whose commit history determines per-route sitemap `lastmod`
 * values. `scripts/maintenance/generate-sitemap-dates.ts` scans these, and
 * `scripts/lib/automation-registry.mjs` registers them as the artifact's
 * declared sources so CI selects the generator when they change.
 */
export const SITEMAP_COMMIT_DERIVED_SOURCE_PATHS: string[] = [
  "shared/data/stablecoins/coins/**",
  "shared/data/stablecoins/domains/**",
  "src/app/**",
  "src/lib/case-studies/**",
  "src/lib/chain-indexing.ts",
  "src/lib/peg-hub-content.ts",
  "src/lib/peg-landing.ts",
  "src/lib/peg-taxonomy.ts",
  "src/lib/stablecoin-taxonomy-urls.ts",
  "src/lib/stablecoin-taxonomy.ts",
  "src/data/blog/**",
  // Case-study schema: a shared Article dependency of every case-study page.
  "shared/types/editorial-content.ts",
  // Profile-wide content changes move every profile through the explicit
  // STABLECOIN_DETAIL_CONTENT_REVISED_AT constant, not commit dates.
  "scripts/lib/sitemap-detail-dates.ts",
];
