/**
 * Source paths whose commit history determines per-route sitemap `lastmod`
 * values. `scripts/maintenance/generate-sitemap-dates.ts` scans these, and
 * `scripts/lib/automation-registry.mjs` registers them as the artifact's
 * declared sources so CI selects the generator when they change.
 */
export const SITEMAP_COMMIT_DERIVED_SOURCE_PATHS: string[] = [
  "shared/data/stablecoins/coins/**",
  "src/app/**",
  "src/lib/case-studies/**",
  "src/data/blog/**",
  "src/components/stablecoin-detail/static-seo-content.tsx",
  "src/lib/page-metadata.ts",
  "src/lib/stablecoin-detail-json-ld.ts",
];
