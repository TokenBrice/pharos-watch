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
 * The last material change to the main content every profile renders (the
 * static profile body, quick answers, pre-launch dossier). Bump it only for
 * such a change, mirroring `DEPEG_COLLISION_CONTENT_REVISED_AT_SECONDS`;
 * ordinary edits to shared detail-page sources must not move all ~490
 * profile `lastmod`s at once, or crawlers learn to ignore them. Set for the
 * 2026-10-25 SEO batch (quick answers, related links, launch answers).
 */
export const STABLECOIN_DETAIL_CONTENT_REVISED_AT = "2026-10-25T00:00:00.000Z";

/**
 * Per-coin detail-page dates. A coin profile is as fresh as the newest commit
 * to its base coin file or any of its domain sidecars (a reserves, compliance
 * or risk-review edit moves that profile's `lastmod` only), floored by the
 * explicit shared-content revision date. Pre-launch milestones live in the
 * coin file, so a new milestone already moves its profile; a milestone dated
 * after its commit never becomes a future `lastmod`.
 */
export function collectStablecoinDetailDates(
  entries: ReadonlyArray<Pick<StablecoinSourceEntry, "file" | "id" | "sidecarFiles">>,
  modifiedAt: (absolutePath: string) => string,
  contentRevisedAt: string,
  rootDir: string,
): Record<string, string> {
  const dates: Record<string, string> = {};
  for (const entry of entries) {
    const sources = [entry.file, ...(entry.sidecarFiles ?? [])];
    dates[buildStablecoinUrl(entry.id)] = latestIso(
      ...sources.map((file) => modifiedAt(join(rootDir, file))),
      contentRevisedAt,
    );
  }
  return dates;
}
