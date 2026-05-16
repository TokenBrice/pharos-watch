/**
 * Public dataset mirror path constants and helpers (idea 11.7).
 *
 * The 11.7 / 12.6 fused substrate emits one canonical 90-day rolling mirror
 * per topic into the static export under:
 *
 *   /datasets/<topic>/latest.{csv,json,ndjson}
 *   /datasets/<topic>/<YYYY-MM-DD>.{csv,json,ndjson}
 *
 * Files are produced by `scripts/maintenance/generate-public-datasets.ts`
 * during prebuild. CORS + Cache-Control rules live in `public/_headers`.
 */
import { SITE_ORIGIN } from "../runtime-origins";

/** Stable, externally-referenced topic identifiers. Never break once shipped. */
export const PUBLIC_DATASET_TOPICS = [
  "top-stablecoins",
  "depeg-history",
  "scores-latest",
  "peg-mechanism-distribution",
] as const;

export type PublicDatasetTopic = (typeof PUBLIC_DATASET_TOPICS)[number];

export const PUBLIC_DATASET_VARIANTS = ["csv", "json", "ndjson"] as const;
export type PublicDatasetVariant = (typeof PUBLIC_DATASET_VARIANTS)[number];

/** Build a `/datasets/<topic>/<latest|date>.<ext>` path. */
export function pathPublicDataset(
  topic: PublicDatasetTopic,
  variant: PublicDatasetVariant,
  date: string | "latest" = "latest",
): string {
  return `/datasets/${topic}/${date}.${variant}`;
}

/** Build the absolute URL for a `/datasets/<topic>/<latest|date>.<ext>` mirror. */
export function urlPublicDataset(
  topic: PublicDatasetTopic,
  variant: PublicDatasetVariant,
  date: string | "latest" = "latest",
): string {
  return `${SITE_ORIGIN}${pathPublicDataset(topic, variant, date)}`;
}

/** Short human description per topic (for dataset previews / future index page). */
export const PUBLIC_DATASET_DESCRIPTIONS: Record<PublicDatasetTopic, string> = {
  "top-stablecoins":
    "All tracked stablecoins with circulating supply, peg, mechanism, and chain breakdown, sorted by circulating USD desc.",
  "depeg-history":
    "Confirmed depeg events from the last 90 days with direction, peak deviation, start/end timestamps, and provenance.",
  "scores-latest":
    "Latest PegScore, DEWS, LiquidityScore, and Safety grade per coin (camelCase shape, methodology version stamped).",
  "peg-mechanism-distribution":
    "Aggregate count of tracked coins grouped by mechanism archetype, peg reference, and jurisdiction.",
};
