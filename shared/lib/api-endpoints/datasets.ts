/**
 * Public dataset mirror metadata (idea 11.7).
 *
 * The 11.7 / 12.6 fused substrate emits one canonical 90-day rolling dated
 * artifact per topic into the static export under:
 *
 *   /datasets/<topic>/<YYYY-MM-DD>.{csv,json,ndjson}
 *
 * The stable `/datasets/<topic>/latest.*` URLs are Cloudflare Pages 200
 * rewrites to the current dated files. The generator also emits the matching
 * committed static frontend import module under `src/lib/datasets/`. CORS + Cache-Control
 * rules live in `public/_headers`.
 */

/** Stable, externally-referenced topic identifiers. Never break once shipped. */
export const PUBLIC_DATASET_TOPICS = [
  "top-stablecoins",
  "depeg-history",
  "scores-latest",
  "peg-mechanism-distribution",
] as const;

export type PublicDatasetTopic = (typeof PUBLIC_DATASET_TOPICS)[number];
