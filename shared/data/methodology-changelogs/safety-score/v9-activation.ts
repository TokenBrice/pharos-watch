import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

/**
 * V9 is activated under methodology `9.0`.
 */
export const SAFETY_SCORE_V9_ACTIVATION: MethodologyChangelogEntry = {
  version: "9.0",
  title: "Safety Score V9 becomes the active model",
  date: "2026-07-27",
  effectiveAt: 1785129044,
  summary:
    "Pharos activates the identity-bound V9 model with three risk pillars, explicit evidence responsibility, structural ceilings, and fail-closed publication health.",
  impact: [
    "All active consumers select V9 without recomputing or falling back to V8",
    "Backing, Exit, and Economic Control replace the five V8 dimensions for native V9 output",
    "Transient producer failures hold the last accepted V9 snapshot and expose held status instead of publishing infrastructure-attributed score movement",
    "Capability-free immutable protocol contracts resolve to immutable governance access posture instead of being mistaken for concentrated administrators",
    "V8.17 remains available only as historical methodology and archived score history",
  ],
  commits: [],
  reconstructed: false,
};

export const SAFETY_SCORE_V9_ROUTE_CAPACITY: MethodologyChangelogEntry = {
  version: "9.01",
  title: "Economically material route capacity",
  date: "2026-07-28",
  effectiveAt: 1785224355,
  summary:
    "Exit routes now need economically material capacity, and sub-1% completion cannot score above 50 even when the absolute-capacity floor is met.",
  impact: [
    "The prior threshold derived from two-decimal trace rounding is replaced by the policy's first positive 1% coverage or $100K absolute-capacity breakpoint",
    "A route below both breakpoints receives a zero route score; a route that reaches $100K but remains below 1% completion is capped at 50",
    "Public Exit breakdowns identify capacity as selected-route-specific and expose executable amount, request, cost bound, horizon, protocol, pool, evidence kind, and evidence time",
    "Issuer redemption remains a separate near-term or eventual horizon and is not inferred from exchange volume, aggregate DEX TVL, or issuer reserves",
  ],
  commits: [],
  reconstructed: false,
};
