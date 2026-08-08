/**
 * Shared Selector version stamp.
 *
 * Bump when weights, exclusion rules, or deterministic engine behavior change.
 */
export const SELECTOR_VERSION = "selector-v2.0";

/** Engine versions that produced persisted snapshot contracts still accepted for replay. */
export const SELECTOR_SNAPSHOT_SUPPORTED_ENGINE_VERSIONS = [
  "selector-v1.0",
  "selector-v1.2",
  "selector-v1.3",
  "selector-v1.5",
  "selector-v1.6",
  "selector-v1.7",
  "selector-v1.8",
  "selector-v1.9",
  "selector-v1.91",
  "selector-v1.92",
  SELECTOR_VERSION,
] as const;
