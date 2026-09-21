import { join } from "node:path";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { StablecoinSourceEntry } from "./stablecoin-catalog-sources.ts";

// Kept out of `sitemap-source-paths.mts`: that module is loaded by the deploy
// classifier under bare `node`, where the `@shared/*` alias does not resolve.

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
