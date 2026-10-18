/**
 * Shared deviation severity color mapping.
 *
 * Hex values match --severity-*-hex CSS custom properties in semantic.css.
 * Tailwind classes live in `PEG_DEVIATION_TONE_CLASSES`; the cut-offs
 * (healthy < 50 bps < mild < 200 < moderate < 500 <= severe) and level labels
 * are `PEG_DEVIATION_LEVEL_MIN_BPS` / `getPegDeviationLevel` in classification.
 */

import { isQuietDeviationsEnabled } from "@/lib/feature-flags";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import {
  getPegDeviationLevel,
  PEG_DEVIATION_TONE_CLASSES,
  QUALITY_TIER_3_CLASSES,
} from "@shared/lib/classification";

/** Severity border class with accent opacity — suitable for outlined badges. */
export function deviationBorderClass(absBps: number): string {
  return PEG_DEVIATION_TONE_CLASSES[getPegDeviationLevel(absBps)].border;
}

export function deviationColorClass(absBps: number): string {
  const level = getPegDeviationLevel(absBps);
  if (level === "healthy" && isQuietDeviationsEnabled()) return "text-muted-foreground";
  return PEG_DEVIATION_TONE_CLASSES[level].text;
}

export function deviationBgClass(absBps: number): string {
  return PEG_DEVIATION_TONE_CLASSES[getPegDeviationLevel(absBps)].bar;
}

/** Severity icon name (Lucide component name) for a given deviation in basis points */
export type SeverityIcon = "CircleCheck" | "TriangleAlert" | "OctagonAlert" | "CircleX";

export function deviationIconName(absBps: number): SeverityIcon {
  const level = getPegDeviationLevel(absBps);
  if (level === "healthy") return "CircleCheck";
  if (level === "mild") return "TriangleAlert";
  if (level === "moderate") return "OctagonAlert";
  return "CircleX";
}

// ---------------------------------------------------------------------------
// Score tier system (used by liquidity, bluechip, peg components)
// ---------------------------------------------------------------------------

type ScoreTier = "green" | "blue" | "amber" | "red";

export const TIER_TEXT: Record<ScoreTier, string> = {
  green: SEVERITY_TONE_CLASS.ok.text,
  blue: SEVERITY_TONE_CLASS.info.text,
  amber: SEVERITY_TONE_CLASS.watch.text,
  red: SEVERITY_TONE_CLASS.alert.text,
};

/**
 * Outlined-pill twin of `TIER_TEXT`, for score tiers rendered through
 * `ScorePill` rather than as bare tinted text. Composed from
 * `SEVERITY_TONE_CLASS` instead of respelling the hues — this engine picks a
 * tier, the token module owns what the tier looks like.
 */
export const TIER_PILL: Record<ScoreTier, string> = {
  green: SEVERITY_TONE_CLASS.ok.pill,
  blue: SEVERITY_TONE_CLASS.info.pill,
  amber: SEVERITY_TONE_CLASS.watch.pill,
  red: SEVERITY_TONE_CLASS.alert.pill,
};

interface ScoreColorThreshold {
  min: number;
  className: string;
}

export function scoreToColorClass(
  score: number | null | undefined,
  thresholds: readonly ScoreColorThreshold[],
  fallbackClass = "text-muted-foreground",
): string {
  if (score == null) return fallbackClass;
  for (const threshold of thresholds) {
    if (score >= threshold.min) return threshold.className;
  }
  return fallbackClass;
}
export const SCORE_TIER_CUTOFFS = {
  red: 0,
  amber: 40,
  blue: 60,
  green: 80,
} as const;

const SCORE_TEXT_THRESHOLDS = [
  { min: SCORE_TIER_CUTOFFS.green, className: TIER_TEXT.green },
  { min: SCORE_TIER_CUTOFFS.blue, className: TIER_TEXT.blue },
  { min: SCORE_TIER_CUTOFFS.amber, className: TIER_TEXT.amber },
  { min: Number.NEGATIVE_INFINITY, className: TIER_TEXT.red },
] as const;

const PEG_SCORE_THRESHOLDS = [
  { min: 90, className: QUALITY_TIER_3_CLASSES.good.text },
  { min: 70, className: QUALITY_TIER_3_CLASSES.watch.text },
  { min: Number.NEGATIVE_INFINITY, className: QUALITY_TIER_3_CLASSES.bad.text },
] as const;

const DURABILITY_TEXT_THRESHOLDS = [
  { min: 70, className: QUALITY_TIER_3_CLASSES.good.text },
  { min: 40, className: QUALITY_TIER_3_CLASSES.watch.text },
  { min: Number.NEGATIVE_INFINITY, className: QUALITY_TIER_3_CLASSES.bad.text },
] as const;

/** Map a 0-100 liquidity/durability score to a tier */
export function getScoreTier(score: number): ScoreTier {
  if (score >= SCORE_TIER_CUTOFFS.green) return "green";
  if (score >= SCORE_TIER_CUTOFFS.blue) return "blue";
  if (score >= SCORE_TIER_CUTOFFS.amber) return "amber";
  return "red";
}

/** Map a 0-100 liquidity/durability score to a Tailwind text color class */
export function getScoreColor(score: number): string {
  return scoreToColorClass(score, SCORE_TEXT_THRESHOLDS);
}

/** Map a peg score (0-100, null) to a Tailwind text color class */
export function pegScoreColor(score: number | null): string {
  return scoreToColorClass(score, PEG_SCORE_THRESHOLDS);
}

// ---------------------------------------------------------------------------
// Durability score color helpers (70/40 thresholds — intentionally different
// from the generic 80/60/40 score tier thresholds above)
// ---------------------------------------------------------------------------

/** Map a 0-100 durability score to a Tailwind text color class */
export function getDurabilityColor(score: number): string {
  return scoreToColorClass(score, DURABILITY_TEXT_THRESHOLDS);
}

/** Map a 0-100 durability score to a Tailwind background color class */
export function getDurabilityBgColor(score: number): string {
  if (score >= 70) return SEVERITY_TONE_CLASS.ok.bar;
  if (score >= 40) return SEVERITY_TONE_CLASS.watch.bar;
  return SEVERITY_TONE_CLASS.alert.bar;
}

/** Semantic color class for ratio-based quality (green/amber/red). */
export function ratioQualityColor(ratio: number, highThreshold = 0.8, midThreshold = 0.5): string {
  if (ratio >= highThreshold) return SEVERITY_TONE_CLASS.ok.text;
  if (ratio >= midThreshold) return SEVERITY_TONE_CLASS.watch.text;
  return SEVERITY_TONE_CLASS.alert.text;
}
