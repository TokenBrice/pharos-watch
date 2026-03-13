/** Canonical safety scoring methodology version (no "v" prefix). */
export const SAFETY_SCORE_VERSION = "5.7";

/** Display-ready safety scoring methodology version (with "v" prefix). */
export const SAFETY_SCORE_VERSION_LABEL = `v${SAFETY_SCORE_VERSION}`;

/** Public changelog route for Safety Scores methodology version history. */
export const SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH = "/methodology/scoring-changelog/";

/** Ordered scoring changelog versions used for the longform navigation rail. */
export const SAFETY_SCORE_CHANGELOG_NAV_VERSIONS = [
  SAFETY_SCORE_VERSION_LABEL,
  "v5.6",
  "v5.5",
  "v5.4",
  "v5.3",
  "v5.2",
  "v5.1",
  "v5.0",
  "v4.1",
  "v4.0",
  "v3.3",
  "v3.2",
  "v3.0",
  "v2.0",
  "v1.0",
] as const;
