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

const ANCHORS: Record<MetricKey, string> = {
  "safety-score": "/methodology/#safety-scores-methodology",
  dews: "/methodology/#pegscore-dews-methodology",
  "peg-score": "/methodology/#pegscore-dews-methodology",
  psi: "/methodology/#stability-index-methodology",
  "liquidity-score": "/methodology/#liquidity-methodology",
  "chain-health": "/methodology/#chain-health-score",
  bluechip: "/methodology/#safety-scores-methodology",
  "redemption-backstop": "/methodology/#safety-scores-methodology",
  "report-card": "/methodology/#safety-scores-methodology",
};

export function methodologyAnchorFor(metric: MetricKey): string {
  return ANCHORS[metric];
}
