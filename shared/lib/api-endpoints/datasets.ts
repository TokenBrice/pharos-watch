/**
 * Public dataset mirror metadata (idea 11.7).
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

/** Stable, externally-referenced topic identifiers. Never break once shipped. */
export const PUBLIC_DATASET_TOPICS = [
  "top-stablecoins",
  "depeg-history",
  "scores-latest",
  "peg-mechanism-distribution",
] as const;

export type PublicDatasetTopic = (typeof PUBLIC_DATASET_TOPICS)[number];
