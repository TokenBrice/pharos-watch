/**
 * Stable methodology deep-links for inline `(method)` badges next to scored
 * values. Anchors are verified against the IDs in
 * `src/lib/methodology-content.ts`. Metrics without a
 * dedicated section anchor to the closest parent (e.g. report-card / bluechip /
 * redemption-backstop all live within Safety Scores).
 */
export type MetricKey =
  | "safety-score"
  | "dews"
  | "peg-score"
  | "psi"
  | "liquidity-score"
  | "chain-health"
  | "bluechip"
  | "redemption-backstop"
  | "report-card";

export const METHODOLOGY_METRIC_SECTION_IDS = {
  safety: "safety-scores-methodology",
  pegDews: "pegscore-dews-methodology",
  stability: "stability-index-methodology",
  liquidity: "liquidity-methodology",
  chainHealth: "chain-health-score",
} as const;

const ANCHORS: Record<MetricKey, keyof typeof METHODOLOGY_METRIC_SECTION_IDS> = {
  "safety-score": "safety",
  dews: "pegDews",
  "peg-score": "pegDews",
  psi: "stability",
  "liquidity-score": "liquidity",
  "chain-health": "chainHealth",
  bluechip: "safety",
  "redemption-backstop": "safety",
  "report-card": "safety",
};

export function methodologyAnchorFor(metric: MetricKey): string {
  return `/methodology/#${METHODOLOGY_METRIC_SECTION_IDS[ANCHORS[metric]]}`;
}
