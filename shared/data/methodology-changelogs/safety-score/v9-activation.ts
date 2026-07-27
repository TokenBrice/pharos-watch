import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

/**
 * V9 is activated under methodology `9.0`.
 *
 * This entry is rendered separately from the numeric V8 history and does not
 * replace the retained V8 compatibility version constant while that publisher
 * remains scheduled.
 */
export const SAFETY_SCORE_V9_ACTIVATION: MethodologyChangelogEntry = {
  version: "9.0",
  title: "Safety Score V9 becomes the active model",
  date: "2026-07-27",
  effectiveAt: 1785129044,
  summary:
    "Pharos activates the identity-bound V9 model with three risk pillars, explicit evidence responsibility, structural ceilings, and fail-closed publication health.",
  impact: [
    "Active model-aware consumers select V9 without recomputing or falling back to V8",
    "Backing, Exit, and Economic Control replace the five V8 dimensions for native V9 output",
    "Transient producer failures hold the last accepted V9 snapshot and expose held status instead of publishing infrastructure-attributed score movement",
    "Capability-free immutable protocol contracts resolve to immutable governance access posture instead of being mistaken for concentrated administrators",
    "The V8.17 methodology remains documented for the compatibility endpoint and rollback observation window",
  ],
  commits: [],
  reconstructed: false,
};
