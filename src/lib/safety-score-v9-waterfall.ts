import type {
  SafetyScoreV9CurrentCard,
  SafetyScoreV9PreBreakdownCard,
} from "@shared/types/safety-score-v9-public";

/**
 * The published score is the end of a chain the card only hinted at in a trace
 * line: pillar quality, then a measured peg-performance multiplier, then
 * common-mode deployment exposure, then any binding cap.
 *
 * The peg step is the one worth showing — 107 of 335 assets carry a multiplier
 * below 1, and on the worst of them it moves the headline by 20 points. A
 * reader comparing the pillar bars to the headline cannot otherwise reconcile
 * the two.
 */

export type ScoreWaterfallKind = "base" | "multiply" | "subtract" | "cap" | "published";

export interface ScoreWaterfallStep {
  key: string;
  label: string;
  kind: ScoreWaterfallKind;
  /** Rendered operator, e.g. `x0.609` or `-2.5`. Null on the endpoints. */
  operator: string | null;
  /** Running score after this step. */
  value: number;
  detail: string | null;
}

type WaterfallCard = SafetyScoreV9CurrentCard | SafetyScoreV9PreBreakdownCard;

const PEG_EPSILON = 0.005;
const POINT_EPSILON = 0.05;

export function buildScoreWaterfall(card: WaterfallCard): ScoreWaterfallStep[] {
  const { stages } = card.scoreTrace;
  const quality = stages.aggregatedQualityScore;
  const published = stages.publishedScore;
  if (quality === null || published === null) return [];

  const steps: ScoreWaterfallStep[] = [
    {
      key: "quality",
      label: "Pillar quality",
      kind: "base",
      operator: null,
      value: quality,
      detail: "Weighted mean of the Backing, Exit, and Control pillars.",
    },
  ];

  const pegMultiplier = stages.pegMultiplier;
  if (
    pegMultiplier !== null
    && Math.abs(pegMultiplier - 1) >= PEG_EPSILON
    && stages.baseAssetScore !== null
  ) {
    steps.push({
      key: "peg",
      label: "Peg performance",
      kind: "multiply",
      operator: `x${pegMultiplier.toFixed(3)}`,
      value: stages.baseAssetScore,
      detail: "Measured historical peg behaviour discounts the structural score.",
    });
  }

  const deploymentPoints = stages.deploymentAdjustmentPoints;
  if (
    deploymentPoints !== null
    && deploymentPoints >= POINT_EPSILON
    && stages.deploymentAdjustedScore !== null
  ) {
    steps.push({
      key: "deployment",
      label: "Common-mode exposure",
      kind: "subtract",
      operator: `-${deploymentPoints.toFixed(1)}`,
      value: stages.deploymentAdjustedScore,
      detail: "Deployments that share a chain or bridge and can fail together.",
    });
  }

  const cap = card.bindingCap;
  const preCap = stages.preCapScore;
  if (cap && preCap !== null && preCap - published >= POINT_EPSILON) {
    steps.push({
      key: "cap",
      // Not "Binding cap": `CapSection` owns that heading directly beneath, and
      // two identical labels in one card read as a duplicated row.
      label: "Cap applied",
      kind: "cap",
      operator: `max ${cap.limit.toFixed(0)}`,
      value: published,
      // `CapSection` renders directly beneath and owns the cap prose; repeating
      // the reason here would print the same sentence twice.
      detail: null,
    });
  }

  // A single stage that never moved the number explains nothing the headline
  // does not already say.
  if (steps.length === 1) return [];

  // A binding cap already lands on the published number, so appending a second
  // row would print the same value twice. Otherwise close on the anchor row.
  const last = steps[steps.length - 1];
  if (last && Math.abs(last.value - published) < POINT_EPSILON) {
    steps[steps.length - 1] = { ...last, kind: "published" };
    return steps;
  }

  steps.push({
    key: "published",
    label: "Published score",
    kind: "published",
    operator: null,
    value: published,
    detail: null,
  });
  return steps;
}
