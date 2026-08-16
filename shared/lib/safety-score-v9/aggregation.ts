import type { V9QualityPillar } from "../../types/safety-score-v9";

export type V9AggregationPillars = Readonly<Record<V9QualityPillar, number>>;
export type V9AggregationWeights = Readonly<Record<V9QualityPillar, number>>;

export interface V9WeakestPathAggregationTrace {
  method: "smooth-bounded-headroom" | "generalized-mean";
  score: number;
  weightedQuality: number;
  weakestPillar: V9QualityPillar;
  weakestScore: number;
}

export type V9AggregationStrategy = (
  pillars: V9AggregationPillars,
  weights: V9AggregationWeights,
  policyHeadroom: number,
) => V9WeakestPathAggregationTrace;

const PILLARS: readonly V9QualityPillar[] = ["backing", "exit", "control"];
const SCORE_MIN = 0;
const SCORE_MAX = 100;
const WEIGHT_TOLERANCE = 0.000001;

function assertAggregationInputs(pillars: V9AggregationPillars, weights: V9AggregationWeights): void {
  const weightTotal = PILLARS.reduce((sum, pillar) => sum + weights[pillar], 0);
  if (Math.abs(weightTotal - 1) > WEIGHT_TOLERANCE) {
    throw new Error(`Safety Score v9 aggregation weights must sum to 1; received ${weightTotal}`);
  }
  for (const pillar of PILLARS) {
    if (!Number.isFinite(pillars[pillar]) || pillars[pillar] < SCORE_MIN || pillars[pillar] > SCORE_MAX) {
      throw new Error(`Safety Score v9 ${pillar} pillar must be between 0 and 100`);
    }
    if (!Number.isFinite(weights[pillar]) || weights[pillar] <= 0) {
      throw new Error(`Safety Score v9 ${pillar} weight must be positive`);
    }
  }
}

function aggregationContext(
  pillars: V9AggregationPillars,
  weights: V9AggregationWeights,
): Omit<V9WeakestPathAggregationTrace, "method" | "score"> {
  assertAggregationInputs(pillars, weights);
  const weightedQuality = PILLARS.reduce((sum, pillar) => sum + pillars[pillar] * weights[pillar], 0);
  const weakestPillar = PILLARS.reduce((weakest, pillar) =>
    pillars[pillar] < pillars[weakest] ? pillar : weakest,
  );
  return {
    weightedQuality,
    weakestPillar,
    weakestScore: pillars[weakestPillar],
  };
}

/**
 * Converts the old `weakest + fixed headroom` ceiling into a smooth score.
 * The result is monotonic, stays between the weakest pillar and the ordinary
 * weighted mean, and approaches (but never creates) a flat headroom cliff.
 */
export function aggregateV9SmoothBoundedHeadroom(
  pillars: V9AggregationPillars,
  weights: V9AggregationWeights,
  headroom: number,
): V9WeakestPathAggregationTrace {
  if (!Number.isFinite(headroom) || headroom <= 0) {
    throw new Error("Safety Score v9 smooth aggregation headroom must be positive");
  }
  const context = aggregationContext(pillars, weights);
  const distanceFromWeakest = context.weightedQuality - context.weakestScore;
  const score = context.weakestScore + headroom * Math.tanh(distanceFromWeakest / headroom);
  return {
    method: "smooth-bounded-headroom",
    score,
    ...context,
  };
}

/**
 * Counterfactual soft-min candidate. Negative exponents increasingly weight
 * weak pillars without introducing a hard minimum or cap boundary.
 */
export function aggregateV9GeneralizedMean(
  pillars: V9AggregationPillars,
  weights: V9AggregationWeights,
  exponent: number,
): V9WeakestPathAggregationTrace {
  if (!Number.isFinite(exponent) || exponent >= 0) {
    throw new Error("Safety Score v9 generalized-mean exponent must be negative");
  }
  const context = aggregationContext(pillars, weights);
  const hasZero = PILLARS.some((pillar) => pillars[pillar] === 0);
  const score = hasZero
    ? 0
    : PILLARS.reduce((sum, pillar) => sum + weights[pillar] * pillars[pillar] ** exponent, 0) **
      (1 / exponent);
  return {
    method: "generalized-mean",
    score,
    ...context,
  };
}
