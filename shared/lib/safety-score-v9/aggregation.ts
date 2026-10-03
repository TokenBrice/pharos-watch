import type { V9QualityPillar } from "../../types/safety-score-v9";

export type V9AggregationPillars = Readonly<Record<V9QualityPillar, number | null>>;
export type V9AggregationWeights = Readonly<Record<V9QualityPillar, number>>;

export interface V9WeakestPathAggregationTrace {
  method: "smooth-bounded-headroom";
  score: number;
  weightedQuality: number;
  weakestPillar: V9QualityPillar;
  weakestScore: number;
  includedPillars: readonly V9QualityPillar[];
  excludedPillars: readonly V9QualityPillar[];
  effectiveScoringWeights: V9AggregationWeights;
  supportCeiling: number;
}

export type V9AggregationStrategy = (
  pillars: V9AggregationPillars,
  weights: V9AggregationWeights,
  policyHeadroom: number,
  includedPillars?: readonly V9QualityPillar[],
) => V9WeakestPathAggregationTrace | null;

const PILLARS: readonly V9QualityPillar[] = ["backing", "exit", "control"];
const WEIGHT_TOLERANCE = 0.000001;

/** Original policy weights are renormalized over the explicitly included set. */
export function aggregateV9SmoothBoundedHeadroom(
  pillars: V9AggregationPillars,
  weights: V9AggregationWeights,
  headroom: number,
  includedPillars: readonly V9QualityPillar[] = PILLARS,
): V9WeakestPathAggregationTrace | null {
  if (!Number.isFinite(headroom) || headroom <= 0) {
    throw new Error("Safety Score v9 smooth aggregation headroom must be positive");
  }
  const weightTotal = PILLARS.reduce((sum, pillar) => sum + weights[pillar], 0);
  if (Math.abs(weightTotal - 1) > WEIGHT_TOLERANCE || !Number.isFinite(weightTotal)) {
    throw new Error(`Safety Score v9 aggregation weights must sum to 1; received ${weightTotal}`);
  }
  for (const pillar of PILLARS) {
    if (!Number.isFinite(weights[pillar]) || weights[pillar] <= 0) {
      throw new Error(`Safety Score v9 ${pillar} weight must be positive`);
    }
  }
  if (new Set(includedPillars).size !== includedPillars.length ||
      includedPillars.some((pillar) => !PILLARS.includes(pillar))) {
    throw new Error("Safety Score v9 aggregation requires a unique included pillar set");
  }
  const included = PILLARS.filter((pillar) => includedPillars.includes(pillar));
  for (const pillar of included) {
    const score = pillars[pillar];
    if (score === null || !Number.isFinite(score) || score < 0 || score > 100) {
      throw new Error(`Safety Score v9 included ${pillar} pillar must be between 0 and 100`);
    }
  }
  if (included.length < 2) return null;
  const includedWeight = included.reduce((sum, pillar) => sum + weights[pillar], 0);
  const effectiveScoringWeights = { backing: 0, exit: 0, control: 0 };
  let weightedQuality = 0;
  let weakestPillar = included[0]!;
  for (const pillar of included) {
    const weight = weights[pillar] / includedWeight;
    effectiveScoringWeights[pillar] = weight;
    weightedQuality += pillars[pillar]! * weight;
    if (pillars[pillar]! < pillars[weakestPillar]!) weakestPillar = pillar;
  }
  const weakestScore = pillars[weakestPillar]!;
  return {
    method: "smooth-bounded-headroom",
    score: weakestScore + headroom * Math.tanh((weightedQuality - weakestScore) / headroom),
    weightedQuality,
    weakestPillar,
    weakestScore,
    includedPillars: included,
    excludedPillars: PILLARS.filter((pillar) => !included.includes(pillar)),
    effectiveScoringWeights,
    supportCeiling: weightedQuality,
  };
}
