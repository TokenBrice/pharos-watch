import type { DexLiquidityData } from "../../types/market";
import { LIQUIDITY_SCORE_WEIGHTS } from "../liquidity-score-weights";
import { QUALITY_TIER_3_CLASSES } from "./peg-severity";

const ORGANIC_FRACTION_MIN = 0.7;
const MIXED_FRACTION_MIN = 0.3;
const ESTABLISHED_POOL_MATURITY_DAYS = 365;
const LIQUIDITY_VERDICT_STRENGTH_MIN = 70;
const LIQUIDITY_VERDICT_DRAG_MAX = 60;

export function getPoolOrganicFractionTier(
  fraction: number,
  maturityDays = 0,
): { label: "Organic" | "Mixed" | "Established" | "Incentivized"; badgeClass: string; summaryColor: string } {
  if (fraction >= ORGANIC_FRACTION_MIN) {
    return {
      label: "Organic",
      badgeClass: QUALITY_TIER_3_CLASSES.good.badgeSoft,
      summaryColor: QUALITY_TIER_3_CLASSES.good.text,
    };
  }
  if (fraction >= MIXED_FRACTION_MIN || maturityDays >= ESTABLISHED_POOL_MATURITY_DAYS) {
    return {
      label: maturityDays >= ESTABLISHED_POOL_MATURITY_DAYS && fraction < MIXED_FRACTION_MIN ? "Established" : "Mixed",
      badgeClass: QUALITY_TIER_3_CLASSES.watch.badgeSoft,
      summaryColor: QUALITY_TIER_3_CLASSES.watch.text,
    };
  }
  return {
    label: "Incentivized",
    badgeClass: QUALITY_TIER_3_CLASSES.bad.badgeSoft,
    summaryColor: QUALITY_TIER_3_CLASSES.bad.text,
  };
}

export function getAggregateOrganicFractionTier(
  fraction: number,
): { label: "Organic" | "Mixed" | "Established" | "Incentivized"; badgeClass: string; summaryColor: string } {
  if (fraction >= ORGANIC_FRACTION_MIN) {
    return {
      label: "Organic",
      badgeClass: QUALITY_TIER_3_CLASSES.good.badgeSoft,
      summaryColor: QUALITY_TIER_3_CLASSES.good.text,
    };
  }
  if (fraction >= MIXED_FRACTION_MIN) {
    return {
      label: "Mixed",
      badgeClass: QUALITY_TIER_3_CLASSES.watch.badgeSoft,
      summaryColor: QUALITY_TIER_3_CLASSES.watch.text,
    };
  }
  return {
    label: "Incentivized",
    badgeClass: QUALITY_TIER_3_CLASSES.bad.badgeSoft,
    summaryColor: QUALITY_TIER_3_CLASSES.bad.text,
  };
}

/**
 * One-line verdict derived from the published score components — a template
 * over data, never authored per coin: the strongest components "carry" the
 * score and the weakest is named the drag (below 60) or the softest spot.
 * Replaces the methodology disclaimer as the module's opening line; the
 * disclaimer lives verbatim in the liquidityScore methodology hint.
 */
export function buildLiquidityVerdictLine(components: DexLiquidityData["scoreComponents"]): string | null {
  if (!components) return null;
  const entries = LIQUIDITY_SCORE_WEIGHTS.map((weight) => {
    const value = components[weight.key];
    return { label: weight.label, value: value == null ? Number.NaN : Math.round(value) };
  });
  // A DEC-19 NR activity component leaves no complete composite to explain.
  if (entries.some((entry) => !Number.isFinite(entry.value))) return null;

  const sorted = [...entries].sort((a, b) => b.value - a.value);
  const strengths = sorted.filter((entry) => entry.value >= LIQUIDITY_VERDICT_STRENGTH_MIN).slice(0, 2);
  const weakest = sorted[sorted.length - 1]!;

  const strengthClause =
    strengths.length === 2
      ? `${strengths[0]!.label} ${strengths[0]!.value} and ${strengths[1]!.label.toLowerCase()} ${strengths[1]!.value} carry the score`
      : strengths.length === 1
        ? `${strengths[0]!.label} ${strengths[0]!.value} carries the score`
        : "No component clears 70";
  const weakClause =
    weakest.value < LIQUIDITY_VERDICT_DRAG_MAX
      ? `${weakest.label.toLowerCase()} ${weakest.value} is the drag`
      : `${weakest.label.toLowerCase()} ${weakest.value} is the softest`;

  return `${strengthClause}; ${weakClause}.`;
}
