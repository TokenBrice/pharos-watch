import { join } from "node:path";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { StablecoinSourceEntry } from "./stablecoin-catalog-sources.ts";

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
  "src/data/blog/**",
  "src/components/stablecoin-detail/static-seo-content.tsx",
  "src/lib/page-metadata.ts",
  "src/lib/stablecoin-detail-json-ld.ts",
];

export function latestIso(...dates: string[]): string {
  return dates.reduce((latest, candidate) => {
    return new Date(candidate).getTime() > new Date(latest).getTime() ? candidate : latest;
  });
}

/**
 * Per-coin detail-page dates. A coin profile is as fresh as the newest commit
 * to its base coin file, any of its domain sidecars, or the shared
 * detail-page sources — a reserves, compliance or risk-review edit moves that
 * profile's `lastmod`, not only a base-file or shared-source edit.
 */
export function collectStablecoinDetailDates(
  entries: ReadonlyArray<Pick<StablecoinSourceEntry, "file" | "id" | "sidecarFiles">>,
  modifiedAt: (absolutePath: string) => string,
  sharedLastModified: string,
  rootDir: string,
): Record<string, string> {
  const dates: Record<string, string> = {};
  for (const entry of entries) {
    const sources = [entry.file, ...(entry.sidecarFiles ?? [])];
    dates[buildStablecoinUrl(entry.id)] = latestIso(
      ...sources.map((file) => modifiedAt(join(rootDir, file))),
      sharedLastModified,
    );
  }
  return dates;
}
