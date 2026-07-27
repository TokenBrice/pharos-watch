import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

/**
 * V9 is activated under its existing policy identity, `candidate-v2`.
 *
 * This entry is rendered separately from the numeric V8 history because the
 * active runtime identity deliberately has no numeric release version. It must
 * not be registered through `createMethodologyVersion()` or replace the V8
 * version constant while the compatibility publisher remains scheduled.
 */
export const SAFETY_SCORE_V9_ACTIVATION: MethodologyChangelogEntry = {
  version: "candidate-v2",
  title: "Safety Score V9 becomes the active model",
  date: "2026-07-27",
  effectiveAt: 1785129044,
  summary:
    "Pharos activates the identity-bound V9 model with three risk pillars, explicit evidence responsibility, structural ceilings, and fail-closed publication health.",
  impact: [
    "Active model-aware consumers select V9 without recomputing or falling back to V8",
    "Backing, Exit, and Economic Control replace the five V8 dimensions for native V9 output",
    "Transient producer failures hold the last accepted V9 snapshot and expose held status instead of publishing infrastructure-attributed score movement",
    "The V8.17 methodology remains documented for the compatibility endpoint and rollback observation window",
  ],
  commits: [],
  reconstructed: false,
};
